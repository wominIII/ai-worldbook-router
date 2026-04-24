import { extension_settings, getContext, renderExtensionTemplateAsync } from '../../../extensions.js';
import {
    eventSource,
    event_types,
    extension_prompt_roles,
    extension_prompt_types,
    saveSettingsDebounced,
    setExtensionPrompt,
} from '../../../../script.js';
import {
    METADATA_KEY,
    convertCharacterBook,
    loadWorldInfo,
    selected_world_info,
    world_info,
} from '../../../world-info.js';
import { getCharaFilename } from '../../../utils.js';

const MODULE_NAME = 'ai_worldbook_router';
const PROMPT_KEY = 'ai_worldbook_router_prompt';
const LOG_PREFIX = '[AI Worldbook Router]';
const MAX_MVU_CHARS = 1600;
const MAX_RECALL_TERMS = 32;
const MAX_ROUTER_CONTEXT_PREVIEW = 360;
const MAX_BURST_ITEMS = 5;
const FETCH_FALLBACK_ENDPOINTS = [
    '/api/backends/chat-completions/generate',
    '/api/backends/text-completions/generate',
    '/api/backends/kobold/generate',
    '/api/novelai/generate',
    '/api/horde/generate-text',
];
const COMMON_QUERY_TERMS = new Set([
    '如果', '有人', '这个', '那个', '这里', '那里', '什么', '怎么', '为何', '为什么', '然后',
    '可以', '是不是', '就是', '不是', '一下', '一下子', '这样', '那样', '会被', '会不会',
    '到底', '真的', '已经', '现在', '之前', '之后', '而且', '因为', '所以', '那个地方',
]);

const defaultSystemPrompt = `你是 SillyTavern 的前置世界书路由器。

你的任务：
只根据最近聊天上下文、最后用户消息、可选状态、以及候选条目的 keys，选择本轮真正相关的世界书条目。

必须遵守：
1. 只输出严格 JSON，不要 Markdown，不要代码块，不要解释。
2. 不要输出分析过程，不要输出 reasoning 字段。
3. 不要返回 id，不要返回标题，只返回命中的 key。
4. 只能返回候选条目中实际存在的 key。
5. 如果没有合适条目，返回 {"selected":[]}。
6. 每个 reason 保持简短。

唯一合法输出格式：
{"selected":[{"key":"命中的 key","reason":"简短原因"}]}`;

const defaultSettings = {
    enabled: false,
    debug: false,
    routerUseSeparateModel: false,
    routerApiUrl: '',
    routerApiKey: '',
    routerModel: '',
    routerModels: [],
    routerStatus: '未连接',
    maxCandidates: 24,
    maxSelected: 5,
    maxChars: 4000,
    scanMessages: 8,
    keywordRecall: true,
    useMvu: false,
    allowConstant: false,
    titleBlocklist: '',
    position: extension_prompt_types.IN_CHAT,
    depth: 4,
    role: extension_prompt_roles.SYSTEM,
    aiResponseLength: 256,
    routerRetries: 1,
    systemPrompt: defaultSystemPrompt,
};

const settings = structuredClone(defaultSettings);
let lastRun = {
    candidates: [],
    selected: [],
    injectedChars: 0,
    injectionText: '',
    source: 'none',
    error: '',
    routerPrompt: '',
    routerRaw: '',
};
let burstCleanupTimer = null;
let routerBusyPromise = null;
let resolveRouterBusy = null;
let isGenerationActive = false;
let pendingCompatSend = false;
let compatFlushScheduled = false;
let suppressCompatReplay = false;
let compatHooksInstalled = false;
let compatHookRetryTimer = null;
let compatGenerateHookTimer = null;
let isCompatRouterRunning = false;
let isRouterSelectionRequest = false;
let fetchFallbackInstalled = false;
let lastRouteCompletedAt = 0;

function beginRouterBusy() {
    if (routerBusyPromise) {
        return () => { };
    }

    routerBusyPromise = new Promise((resolve) => {
        resolveRouterBusy = resolve;
    });

    return () => {
        if (!routerBusyPromise) {
            return;
        }

        const resolve = resolveRouterBusy;
        routerBusyPromise = null;
        resolveRouterBusy = null;
        resolve?.();
        scheduleCompatFlush();
    };
}

async function waitForCompatIdle() {
    if (routerBusyPromise) {
        try {
            await routerBusyPromise;
        } catch {
            // no-op
        }
    }

    if (!isGenerationActive) {
        return;
    }

    await new Promise((resolve) => {
        let settled = false;
        const done = () => {
            if (settled) {
                return;
            }

            settled = true;
            resolve();
        };

        eventSource.once(event_types.GENERATION_ENDED, done);
        eventSource.once(event_types.GENERATION_STOPPED, done);
    });
}

function scheduleCompatFlush() {
    if (compatFlushScheduled || !pendingCompatSend) {
        return;
    }

    compatFlushScheduled = true;
    (async () => {
        try {
            await waitForCompatIdle();
            await new Promise(resolve => setTimeout(resolve, 250));

            if (!pendingCompatSend || routerBusyPromise || isGenerationActive) {
                return;
            }

            const sendButton = document.getElementById('send_but');
            if (!sendButton) {
                return;
            }

            pendingCompatSend = false;
            suppressCompatReplay = true;
            setTimeout(() => {
                try {
                    sendButton.click();
                } finally {
                    setTimeout(() => {
                        suppressCompatReplay = false;
                    }, 180);
                }
            }, 0);
        } finally {
            compatFlushScheduled = false;
            if (pendingCompatSend && !compatFlushScheduled) {
                scheduleCompatFlush();
            }
        }
    })();
}

function queueCompatSend(event) {
    if (!settings.enabled || suppressCompatReplay || !routerBusyPromise) {
        return false;
    }

    pendingCompatSend = true;
    event?.preventDefault?.();
    event?.stopPropagation?.();
    event?.stopImmediatePropagation?.();
    debugLog('Queued competing send until router idle');
    scheduleCompatFlush();
    return true;
}

function handleCompatTextareaKeydown(event) {
    const isEnter = event.key === 'Enter' || event.code === 'Enter' || event.keyCode === 13;
    if (!isEnter || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey || event.isComposing) {
        return;
    }

    queueCompatSend(event);
}

function installCompatSendHooks() {
    try {
        const sendButton = document.getElementById('send_but');
        const textarea = document.getElementById('send_textarea');

        if (sendButton && !sendButton.dataset.aiWbrCompatHook) {
            sendButton.addEventListener('click', queueCompatSend, true);
            sendButton.dataset.aiWbrCompatHook = '1';
        }

        if (textarea && !textarea.dataset.aiWbrCompatHook) {
            textarea.addEventListener('keydown', handleCompatTextareaKeydown, true);
            textarea.dataset.aiWbrCompatHook = '1';
        }

        compatHooksInstalled = !!(sendButton && textarea);
        if (!compatHooksInstalled && !compatHookRetryTimer) {
            compatHookRetryTimer = setTimeout(() => {
                compatHookRetryTimer = null;
                installCompatSendHooks();
            }, 1200);
        }
    } catch (error) {
        console.warn(`${LOG_PREFIX} Failed to install compatibility send hooks`, error);
    }
}

function ensureTavernHelperCompatHook() {
    try {
        const helper = globalThis.TavernHelper;
        const original = helper?.generate;
        if (!helper || typeof original !== 'function' || original.__aiWbrCompatWrapped) {
            return false;
        }

        if (globalThis.original_TavernHelper_generate_ACU?.__aiWbrCompatWrapped) {
            return false;
        }

        const wrapped = async function (...args) {
            if (settings.enabled && !suppressCompatReplay && (routerBusyPromise || isGenerationActive)) {
                debugLog('Waiting for router idle before TavernHelper.generate');
                await waitForCompatIdle();
                await new Promise(resolve => setTimeout(resolve, 250));
            }

            if (settings.enabled && !suppressCompatReplay && !isCompatRouterRunning) {
                const routed = await runTavernHelperRoute(args);
                if (routed) {
                    await new Promise(resolve => setTimeout(resolve, 0));
                }
            }

            return await original.apply(this, args);
        };

        Object.defineProperty(wrapped, '__aiWbrCompatWrapped', {
            value: true,
            configurable: false,
            enumerable: false,
            writable: false,
        });

        helper.generate = wrapped;
        return true;
    } catch (error) {
        console.warn(`${LOG_PREFIX} Failed to install TavernHelper compatibility hook`, error);
        return false;
    }
}

function startCompatGenerateHookPolling() {
    if (compatGenerateHookTimer) {
        return;
    }

    compatGenerateHookTimer = setInterval(() => {
        try {
            ensureTavernHelperCompatHook();
        } catch (error) {
            console.warn(`${LOG_PREFIX} Compatibility polling failed`, error);
        }
    }, 1500);
}

function ensureSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = {};
    }

    // Deprecated: AI routing is now always on when the plugin itself is enabled.
    if (Object.hasOwn(extension_settings[MODULE_NAME], 'useAi')) {
        delete extension_settings[MODULE_NAME].useAi;
    }

    Object.assign(settings, defaultSettings, extension_settings[MODULE_NAME]);
    Object.assign(extension_settings[MODULE_NAME], settings);
}

function saveSetting(key, value) {
    settings[key] = value;
    Object.assign(extension_settings[MODULE_NAME], settings);
    saveSettingsDebounced();
}

function setRouterStatus(text) {
    settings.routerStatus = String(text || '未连接');
    $('#ai_wbr_router_status').text(settings.routerStatus);
    Object.assign(extension_settings[MODULE_NAME], settings);
    saveSettingsDebounced();
}

function getWorldInfoIcon() {
    return $('#WIDrawerIcon');
}

function ensureFxLayer() {
    let layer = $('#ai_wbr_fx_layer');
    if (layer.length) {
        return layer;
    }

    layer = $('<div id="ai_wbr_fx_layer" aria-hidden="true"></div>');
    $('body').append(layer);
    return layer;
}

function clearEntryBurst() {
    clearTimeout(burstCleanupTimer);
    burstCleanupTimer = null;
    $('#ai_wbr_fx_layer .ai-wbr-entry-burst, #ai_wbr_fx_layer .ai-wbr-status-burst').remove();
}

function startWorldInfoAnimation() {
    const icon = getWorldInfoIcon();
    if (!icon.length) {
        return;
    }

    const layer = ensureFxLayer();
    const anchor = $('#WI-SP-button .drawer-toggle').first();
    const anchorRect = (anchor.length ? anchor[0] : icon[0]).getBoundingClientRect();
    const iconRect = icon[0].getBoundingClientRect();
    let underline = layer.children('.ai-wbr-book-underline');
    if (!underline.length) {
        underline = $('<div class="ai-wbr-book-underline"></div>');
        layer.append(underline);
    }

    underline.css({
        left: `${anchorRect.left + (anchorRect.width / 2)}px`,
        top: `${iconRect.bottom - 44}px`,
    });
}

function stopWorldInfoAnimation() {
    const underline = $('#ai_wbr_fx_layer .ai-wbr-book-underline');
    if (!underline.length) {
        return;
    }

    if (underline.hasClass('ai-wbr-book-underline-error')) {
        setTimeout(() => underline.remove(), 980);
        return;
    }

    underline.remove();
}

function flashWorldInfoError() {
    const underline = $('#ai_wbr_fx_layer .ai-wbr-book-underline');
    if (!underline.length) {
        return;
    }

    underline.removeClass('ai-wbr-book-underline-error');
    void underline[0].offsetWidth;
    underline.addClass('ai-wbr-book-underline-error');
    setTimeout(() => {
        underline.removeClass('ai-wbr-book-underline-error');
    }, 980);
}

function playStatusBurst(symbol, variant = 'retry') {
    const icon = getWorldInfoIcon();
    if (!icon.length) {
        return;
    }

    const layer = ensureFxLayer();
    const rect = icon[0].getBoundingClientRect();
    const burst = $('<div class="ai-wbr-status-burst"></div>')
        .addClass(`ai-wbr-status-burst-${variant}`)
        .text(symbol);

    burst.css({
        left: `${rect.left + (rect.width / 2)}px`,
        top: `${rect.top + (rect.height / 2)}px`,
    });

    layer.append(burst);
    setTimeout(() => burst.remove(), 1050);
}

function getEntryBurstLabel(entry) {
    const comment = String(entry?.comment || '')
        .replace(/^=+\s*/u, '')
        .replace(/\s*=+$/u, '')
        .trim();
    if (comment) {
        return truncateText(comment, 22);
    }

    const key = entry?.matchedKeys?.[0] || entry?.keys?.primary?.[0] || entry?.keys?.all?.[0] || String(entry?.uid || '');
    return truncateText(key, 22);
}

function playSelectedEntriesBurst(entries) {
    const icon = getWorldInfoIcon();
    if (!icon.length || !entries.length) {
        return;
    }

    clearEntryBurst();
    const layer = ensureFxLayer();
    const rect = icon[0].getBoundingClientRect();
    const originX = rect.left + (rect.width / 2);
    const originY = rect.top + (rect.height / 2);
    const burstEntries = entries.slice(0, MAX_BURST_ITEMS);

    burstEntries.forEach((entry, index) => {
        const chip = $('<div class="ai-wbr-entry-burst"></div>').text(getEntryBurstLabel(entry));
        const direction = index % 2 === 0 ? -1 : 1;
        const spreadX = direction * (44 + (index * 18));
        const spreadY = 54 + (index * 12);
        const tilt = direction * (10 + (index * 4));
        chip.css({
            left: `${originX}px`,
            top: `${originY}px`,
            '--burst-x': `${spreadX}px`,
            '--burst-y': `${spreadY}px`,
            '--burst-tilt': `${tilt}deg`,
            '--burst-delay': `${index * 70}ms`,
        });
        layer.append(chip);
    });

    burstCleanupTimer = setTimeout(() => {
        clearEntryBurst();
    }, 1900);
}

function normalizeText(value) {
    return String(value ?? '').toLowerCase();
}

function extractActualUserInput(value) {
    const text = String(value ?? '');
    const match = text.match(/<本轮用户输入>\s*([\s\S]*?)\s*<\/本轮用户输入>/i);
    return (match ? match[1] : text).trim();
}

function escapeRegex(value) {
    return String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function clampNumber(value, fallback, min, max) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
        return fallback;
    }

    return Math.min(max, Math.max(min, parsed));
}

function truncateText(value, maxLength) {
    const text = String(value ?? '').trim();
    if (text.length <= maxLength) {
        return text;
    }

    return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

function uniqueStrings(values) {
    return [...new Set(values.filter(Boolean).map(value => String(value)))];
}

function splitIntoSentences(text) {
    return String(text ?? '')
        .split(/(?<=[.!?。！？\n])/u)
        .map(part => part.trim())
        .filter(Boolean);
}

function extractQueryTerms(...texts) {
    const terms = [];

    for (const rawText of texts) {
        const text = String(rawText ?? '').trim();
        if (!text) {
            continue;
        }

        const latinTokens = text
            .replace(/[^\p{L}\p{N}\s_-]+/gu, ' ')
            .split(/\s+/)
            .map(token => token.trim())
            .filter(token => token.length >= 3);
        terms.push(...latinTokens);

        const hanChunks = text.match(/[\p{Script=Han}]{2,}/gu) || [];
        for (const chunk of hanChunks) {
            if (chunk.length <= 4) {
                terms.push(chunk);
                continue;
            }

            for (let size = 4; size >= 2; size -= 1) {
                for (let index = 0; index <= chunk.length - size; index += 1) {
                    terms.push(chunk.slice(index, index + size));
                }
            }
        }
    }

    return uniqueStrings(terms
        .map(normalizeText)
        .filter(term => term.length >= 2)
        .filter(term => !COMMON_QUERY_TERMS.has(term)))
        .slice(0, MAX_RECALL_TERMS);
}

function countTermHits(text, term) {
    if (!text || !term) {
        return 0;
    }

    const matches = text.match(new RegExp(escapeRegex(term), 'gu'));
    return matches?.length ?? 0;
}

function normalizeUrl(value) {
    return String(value ?? '').trim().replace(/\/+$/, '');
}

function parseBlockRules(value) {
    return String(value ?? '')
        .split(/\r?\n/u)
        .map(line => line.trim())
        .filter(Boolean);
}

function matchesBlockRule(text, rule) {
    const source = String(text ?? '');
    const rawRule = String(rule ?? '').trim();
    if (!source || !rawRule) {
        return false;
    }

    const regexMatch = rawRule.match(/^\/(.+)\/([a-z]*)$/iu);
    if (regexMatch) {
        try {
            return new RegExp(regexMatch[1], regexMatch[2]).test(source);
        } catch {
            return false;
        }
    }

    return normalizeText(source).includes(normalizeText(rawRule));
}

function getBlockedTitleRule(entry) {
    const comment = String(entry?.comment || '').trim();
    if (!comment) {
        return '';
    }

    return parseBlockRules(settings.titleBlocklist).find(rule => matchesBlockRule(comment, rule)) || '';
}

function getEntryId(entry, fallback) {
    return entry.uid ?? entry.id ?? entry.displayIndex ?? fallback;
}

function getEntryKeys(entry) {
    const primary = Array.isArray(entry.key) ? entry.key : (Array.isArray(entry.keys) ? entry.keys : []);
    const secondary = Array.isArray(entry.keysecondary)
        ? entry.keysecondary
        : (Array.isArray(entry.secondary_keys) ? entry.secondary_keys : []);
    const triggers = Array.isArray(entry.triggers) ? entry.triggers : [];
    return {
        primary: primary.map(String).filter(Boolean),
        secondary: secondary.map(String).filter(Boolean),
        all: [...primary, ...secondary, ...triggers].map(String).filter(Boolean),
    };
}

function getRecentMessages(chat) {
    return chat
        .filter(message => message && !message.is_system && message.mes)
        .slice(-settings.scanMessages)
        .map(message => ({
            name: message.name || '',
            text: message.is_user ? extractActualUserInput(message.mes) : String(message.mes || ''),
            isUser: !!message.is_user,
        }));
}

function getTavernHelperInput(options) {
    if (!options || typeof options !== 'object') {
        return '';
    }

    const injected = Array.isArray(options.injects)
        ? options.injects.find(entry => entry && typeof entry.content === 'string' && entry.content.trim())?.content
        : '';

    return String(
        injected
        || options.user_input
        || options.prompt
        || options.message
        || ''
    );
}

function buildCompatRecentMessages(context, options) {
    const chat = Array.isArray(context?.chat) ? context.chat : [];
    const recentMessages = getRecentMessages(chat);
    const input = extractActualUserInput(getTavernHelperInput(options));

    if (!input) {
        return recentMessages;
    }

    const last = recentMessages[recentMessages.length - 1];
    if (last?.isUser && last.text.trim() === input) {
        return recentMessages;
    }

    return [
        ...recentMessages,
        {
            name: context?.name1 || 'User',
            text: input,
            isUser: true,
        },
    ].slice(-settings.scanMessages);
}

function shouldRouteTavernHelperGenerate(options) {
    if (!options || typeof options !== 'object') {
        return false;
    }

    if (options._ai_wbr_routed) {
        return false;
    }

    if (options.quiet_prompt || options.quiet || options.automatic_trigger) {
        return false;
    }

    return !!extractActualUserInput(getTavernHelperInput(options));
}

function getFetchUrl(input) {
    if (typeof input === 'string') {
        return input;
    }

    if (input instanceof URL) {
        return input.pathname;
    }

    return String(input?.url || '');
}

function isMainGenerationFetch(input, init) {
    if (isRouterSelectionRequest) {
        return false;
    }

    const url = getFetchUrl(input);
    if (!FETCH_FALLBACK_ENDPOINTS.some(endpoint => url.includes(endpoint))) {
        return false;
    }

    const method = String(init?.method || input?.method || 'GET').toUpperCase();
    return method === 'POST';
}

function contentToText(content) {
    if (typeof content === 'string') {
        return content;
    }

    if (Array.isArray(content)) {
        return content
            .map(part => {
                if (typeof part === 'string') {
                    return part;
                }

                return part?.text || part?.content || '';
            })
            .filter(Boolean)
            .join('\n');
    }

    return content == null ? '' : String(content);
}

function getPayloadBody(init) {
    return typeof init?.body === 'string' ? init.body : '';
}

function buildFetchFallbackMessages(context, payload) {
    if (Array.isArray(payload?.messages) && payload.messages.length) {
        return payload.messages
            .map(message => ({
                name: message.name || message.role || '',
                text: message.role === 'user' ? extractActualUserInput(contentToText(message.content)) : contentToText(message.content),
                isUser: message.role === 'user',
            }))
            .filter(message => message.text)
            .slice(-settings.scanMessages);
    }

    const chat = Array.isArray(context?.chat) ? getRecentMessages(context.chat) : [];
    if (chat.length) {
        return chat;
    }

    if (typeof payload?.prompt === 'string' && payload.prompt.trim()) {
        return [{
            name: context?.name1 || 'User',
            text: extractActualUserInput(payload.prompt),
            isUser: true,
        }];
    }

    return [];
}

function injectIntoGenerationPayload(payload, injection) {
    if (!injection) {
        return false;
    }

    if (Array.isArray(payload.messages)) {
        payload.messages.unshift({
            role: 'system',
            content: injection,
        });
        return true;
    }

    if (typeof payload.prompt === 'string') {
        payload.prompt = `${injection}\n\n${payload.prompt}`;
        return true;
    }

    return false;
}

function installFetchFallbackHook() {
    if (fetchFallbackInstalled || typeof globalThis.fetch !== 'function') {
        return;
    }

    const originalFetch = globalThis.fetch.bind(globalThis);
    const wrappedFetch = async function (input, init = undefined) {
        if (!settings.enabled || !isMainGenerationFetch(input, init)) {
            return originalFetch(input, init);
        }

        const body = getPayloadBody(init);
        if (!body || body.includes('[本轮相关世界书]') || Date.now() - lastRouteCompletedAt < 3000) {
            return originalFetch(input, init);
        }

        let payload;
        try {
            payload = JSON.parse(body);
        } catch {
            return originalFetch(input, init);
        }

        const endRouterBusy = beginRouterBusy();
        clearEntryBurst();
        startWorldInfoAnimation();

        try {
            const context = getContext();
            const recentMessages = buildFetchFallbackMessages(context, payload);
            if (!recentMessages.length) {
                return originalFetch(input, init);
            }

            const result = await routeWorldbookForMessages(context, recentMessages, 'fetch_fallback', {
                type: 'fetch',
                url: getFetchUrl(input),
            });

            if (result.selected.length && !result.source.includes('fallback')) {
                playSelectedEntriesBurst(result.selected);
            }

            if (!injectIntoGenerationPayload(payload, result.injection)) {
                return originalFetch(input, init);
            }

            debugLog('Injected through fetch fallback', {
                url: getFetchUrl(input),
                selected: result.selected.length,
                chars: result.injection.length,
            });

            return originalFetch(input, {
                ...init,
                body: JSON.stringify(payload),
            });
        } catch (error) {
            debugError(error);
            console.error(`${LOG_PREFIX} Fetch fallback failed`, error);
            return originalFetch(input, init);
        } finally {
            stopWorldInfoAnimation();
            endRouterBusy();
        }
    };

    Object.defineProperty(wrappedFetch, '__aiWbrFetchWrapped', {
        value: true,
        configurable: false,
        enumerable: false,
        writable: false,
    });

    globalThis.fetch = wrappedFetch;
    fetchFallbackInstalled = true;
}

function getLastUserMessage(recentMessages) {
    const text = [...recentMessages].reverse().find(message => message.isUser)?.text
        || recentMessages.at(-1)?.text
        || '';
    return extractActualUserInput(text);
}

function summarizeMvuValue(value) {
    if (value === undefined || value === null || value === '') {
        return '';
    }

    if (typeof value === 'string') {
        return truncateText(value, MAX_MVU_CHARS);
    }

    try {
        return truncateText(JSON.stringify(value, null, 2), MAX_MVU_CHARS);
    } catch {
        return truncateText(String(value), MAX_MVU_CHARS);
    }
}

function findNestedStatData(value, depth = 0, seen = new WeakSet()) {
    if (!value || typeof value !== 'object' || depth > 4) {
        return null;
    }

    if (seen.has(value)) {
        return null;
    }
    seen.add(value);

    if (Object.hasOwn(value, 'stat_data')) {
        return value.stat_data;
    }

    for (const child of Object.values(value)) {
        const found = findNestedStatData(child, depth + 1, seen);
        if (found !== null && found !== undefined) {
            return found;
        }
    }

    return null;
}

function readVariableStore(store, keys) {
    if (!store?.get) {
        return '';
    }

    for (const key of keys) {
        try {
            const value = store.get(key);
            const summary = summarizeMvuValue(value);
            if (summary) {
                return summary;
            }
        } catch {
            // Some variable providers throw for missing keys.
        }
    }

    return '';
}

function getMvuSummary(context) {
    if (!settings.useMvu) {
        return '';
    }

    const directMetadata = summarizeMvuValue(context.chatMetadata?.stat_data);
    if (directMetadata) {
        return directMetadata;
    }

    const nestedMetadata = summarizeMvuValue(findNestedStatData(context.chatMetadata));
    if (nestedMetadata) {
        return nestedMetadata;
    }

    const keys = ['stat_data', 'mvu_stat_data', 'tavern_helper_stat_data', 'MVU.stat_data'];
    const localVariable = readVariableStore(context.variables?.local, keys);
    if (localVariable) {
        return localVariable;
    }

    const globalVariable = readVariableStore(context.variables?.global, keys);
    if (globalVariable) {
        return globalVariable;
    }

    for (const value of [
        globalThis.TavernHelper?.stat_data,
        globalThis.TavernHelper?.statData,
        globalThis.MVU?.stat_data,
        globalThis.MVU?.statData,
        globalThis.stat_data,
    ]) {
        const summary = summarizeMvuValue(value);
        if (summary) {
            return summary;
        }
    }

    return '';
}

function normalizeWorldEntry(rawEntry, source, worldName, index) {
    const id = getEntryId(rawEntry, index);
    return {
        ...rawEntry,
        routerId: `${source}:${worldName || 'embedded'}:${id}`,
        uid: id,
        source,
        world: worldName || '',
        comment: String(rawEntry.comment || rawEntry.memo || ''),
        content: String(rawEntry.content || ''),
        constant: !!rawEntry.constant,
        disable: !!rawEntry.disable || rawEntry.enabled === false,
        order: Number(rawEntry.order ?? rawEntry.insertion_order ?? 0),
        keys: getEntryKeys(rawEntry),
    };
}

function worldEntriesFromData(data, source, worldName) {
    if (!data?.entries) {
        return [];
    }

    const entries = Array.isArray(data.entries) ? data.entries : Object.values(data.entries);
    return entries.map((entry, index) => normalizeWorldEntry(entry, source, worldName, index));
}

async function getEmbeddedCharacterEntries(context) {
    const character = context.characters?.[context.characterId];
    const book = character?.data?.character_book;
    if (!book?.entries?.length) {
        return [];
    }

    const converted = convertCharacterBook(book);
    return worldEntriesFromData(converted, 'character_book', book.name || character?.name || 'embedded');
}

async function getLinkedWorldEntries(context) {
    const character = context.characters?.[context.characterId];
    const worldSources = new Map();

    const addWorld = (worldName, source) => {
        if (worldName && !worldSources.has(worldName)) {
            worldSources.set(worldName, source);
        }
    };

    for (const worldName of selected_world_info || []) {
        addWorld(worldName, 'global_world');
    }

    addWorld(context.chatMetadata?.[METADATA_KEY], 'chat_world');
    addWorld(character?.data?.extensions?.world, 'character_world');
    addWorld(context.powerUserSettings?.persona_description_lorebook, 'persona_world');

    try {
        const fileName = context.characterId !== undefined ? getCharaFilename(context.characterId) : '';
        const extraCharLore = world_info.charLore?.find(entry => entry.name === fileName);
        for (const worldName of extraCharLore?.extraBooks || []) {
            addWorld(worldName, 'character_extra_world');
        }
    } catch (error) {
        debugLog('Could not read character extra world bindings', error);
    }

    const allEntries = [];
    for (const [worldName, source] of worldSources.entries()) {
        try {
            const data = await loadWorldInfo(worldName);
            allEntries.push(...worldEntriesFromData(data, source, worldName));
        } catch (error) {
            console.warn(`${LOG_PREFIX} Failed to load world info "${worldName}"`, error);
        }
    }

    return allEntries;
}

async function getWorldbookEntries(context) {
    const [embedded, linked] = await Promise.all([
        getEmbeddedCharacterEntries(context),
        getLinkedWorldEntries(context),
    ]);

    const deduped = [];
    const seen = new Set();
    for (const entry of [...embedded, ...linked]) {
        const key = `${entry.world}:${entry.uid}:${entry.content}`;
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        deduped.push(entry);
    }

    return deduped;
}

function scoreEntry(entry, matchText, lastUserText, recentText) {
    let score = 0;
    const matchedKeys = new Set();
    const matchedSignals = new Set();
    const lowerMatchText = normalizeText(matchText);
    const lowerLastUserText = normalizeText(lastUserText);
    const comment = normalizeText(entry.comment);
    const content = normalizeText(truncateText(entry.content, 2400));
    const haystack = `${comment}\n${content}`;

    for (const key of entry.keys.primary) {
        const normalized = normalizeText(key).trim();
        if (normalized && lowerMatchText.includes(normalized)) {
            score += lowerLastUserText.includes(normalized) ? 14 : 10;
            matchedKeys.add(key);
        }
    }

    for (const key of entry.keys.secondary) {
        const normalized = normalizeText(key).trim();
        if (normalized && lowerMatchText.includes(normalized)) {
            score += lowerLastUserText.includes(normalized) ? 6 : 4;
            matchedKeys.add(key);
        }
    }

    if (comment && lowerLastUserText && comment.includes(lowerLastUserText.slice(0, 16))) {
        score += 2;
    }

    const lastUserTerms = extractQueryTerms(lastUserText);
    const recentTerms = extractQueryTerms(recentText);

    for (const term of lastUserTerms) {
        const hits = countTermHits(haystack, term);
        if (!hits) {
            continue;
        }

        matchedSignals.add(term);
        if (term.length >= 4) {
            score += 6;
        } else if (term.length === 3) {
            score += 4;
        } else {
            score += 2;
        }
    }

    for (const term of recentTerms) {
        if (lastUserTerms.includes(term)) {
            continue;
        }

        const hits = countTermHits(haystack, term);
        if (!hits) {
            continue;
        }

        matchedSignals.add(term);
        score += term.length >= 3 ? 2 : 1;
    }

    if (!matchedKeys.size && matchedSignals.size && lowerLastUserText.includes('魔法') && haystack.includes('魔法')) {
        score += 2;
    }

    if (entry.constant) {
        score -= 3;
    }

    return { score, matchedKeys: [...matchedKeys], matchedSignals: [...matchedSignals] };
}

function recallCandidates(entries, recentMessages, mvuSummary) {
    const lastUserMessage = getLastUserMessage(recentMessages);
    const recentText = recentMessages.map(message => `${message.name}: ${message.text}`).join('\n');
    const matchText = [lastUserMessage, recentText, mvuSummary].filter(Boolean).join('\n\n');

    const candidates = entries
        .filter(entry => entry.content && !entry.disable)
        .filter(entry => settings.allowConstant || !entry.constant)
        .filter(entry => !getBlockedTitleRule(entry))
        .map(entry => {
            const { score, matchedKeys, matchedSignals } = scoreEntry(entry, matchText, lastUserMessage, recentText);
            return { ...entry, score, matchedKeys, matchedSignals };
        });

    return candidates
        .sort((a, b) => {
            const aMatched = a.score > 0 ? 1 : 0;
            const bMatched = b.score > 0 ? 1 : 0;
            return (bMatched - aMatched) || (b.score - a.score) || (b.order - a.order);
        })
        .slice(0, settings.maxCandidates);
}

function buildAiPrompt(recentMessages, mvuSummary, candidates) {
    const lastUserMessage = getLastUserMessage(recentMessages);
    const recentContext = recentMessages
        .map(message => `${message.name || (message.isUser ? 'User' : 'Assistant')}: ${truncateText(message.text, MAX_ROUTER_CONTEXT_PREVIEW)}`)
        .join('\n\n');
    const candidateText = candidates.map(entry => {
        const keys = entry.keys.all.length ? entry.keys.all.join(' / ') : '(无 keys)';
        return `- ${keys}`;
    }).join('\n');

    return `选择最多 ${settings.maxSelected} 条本轮相关世界书。

最后用户消息：
${lastUserMessage || '(空)'}

最近上下文：
${recentContext || '(空)'}

MVU/stat_data：
${mvuSummary || '(未启用或未读取到)'}

候选 keys（每行一条）：
${candidateText || '(无)'}

如果没有合适条目，返回 {"selected":[]}
只输出严格 JSON：{"selected":[{"key":"命中的 key","reason":"选择原因"}]}`;
}

function getSelectionSchema() {
    return {
        name: 'ai_worldbook_router_selection',
        value: {
            type: 'object',
            additionalProperties: false,
            properties: {
                selected: {
                    type: 'array',
                    items: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                            key: { type: 'string' },
                            reason: { type: 'string' },
                        },
                        required: ['key', 'reason'],
                    },
                },
            },
            required: ['selected'],
        },
        strict: true,
    };
}

function normalizeSelectionPayload(payload) {
    const selected = payload?.selected
        ?? payload?.content?.selected
        ?? payload?.message?.content?.selected;

    if (!Array.isArray(selected)) {
        throw new Error('AI selection JSON is missing selected[] or content.selected[]');
    }

    return selected;
}

function getEntrySelectionKeys(entry) {
    return uniqueStrings(entry.keys.all.map(key => String(key).trim()).filter(Boolean));
}

function splitSelectionKey(value) {
    return uniqueStrings(String(value ?? '')
        .split(/[\/|,，、；;\n]+/u)
        .map(part => part.trim())
        .filter(Boolean));
}

function resolveEntryFromSelection(item, byId, byKey, candidates) {
    const id = String(item?.id ?? '').trim();
    if (id) {
        const entryById = byId.get(id);
        if (entryById) {
            return entryById;
        }
    }

    const rawKey = String(item?.key ?? '').trim();
    if (!rawKey) {
        return null;
    }

    const parts = splitSelectionKey(rawKey);
    for (const part of parts) {
        const entryByKey = byKey.get(normalizeText(part));
        if (entryByKey) {
            return entryByKey;
        }
    }

    const normalizedRawKey = normalizeText(rawKey);
    if (!normalizedRawKey) {
        return null;
    }

    for (const candidate of candidates) {
        const candidateKeys = getEntrySelectionKeys(candidate);
        if (candidateKeys.some(key => normalizedRawKey.includes(normalizeText(key)))) {
            return candidate;
        }
    }

    return null;
}

function tryParseSelectionText(rawText) {
    const text = String(rawText || '').trim();
    if (!text) {
        return null;
    }

    const withoutFence = text.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
    const candidates = [withoutFence];
    const firstBrace = withoutFence.indexOf('{');
    const lastBrace = withoutFence.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
        candidates.unshift(withoutFence.slice(firstBrace, lastBrace + 1));
    }

    for (const candidate of uniqueStrings(candidates)) {
        try {
            return normalizeSelectionPayload(JSON.parse(candidate));
        } catch {
            // Keep trying alternative text slices.
        }
    }

    return null;
}

function collectRouterResponseTexts(rawResponse) {
    if (rawResponse === null || rawResponse === undefined) {
        return [];
    }

    if (typeof rawResponse === 'string') {
        return [rawResponse];
    }

    const texts = [];
    const stack = [rawResponse];
    const seen = new WeakSet();

    while (stack.length) {
        const current = stack.pop();
        if (!current || typeof current !== 'object') {
            continue;
        }

        if (seen.has(current)) {
            continue;
        }
        seen.add(current);

        for (const [key, value] of Object.entries(current)) {
            if (typeof value === 'string' && (
                key === 'content'
                || key === 'reasoning_content'
                || key === 'text'
                || key === 'output_text'
            )) {
                texts.push(value);
            } else if (value && typeof value === 'object') {
                stack.push(value);
            }
        }
    }

    return uniqueStrings(texts.map(text => text.trim()).filter(Boolean));
}

function stripReasoningForDisplay(text) {
    return String(text ?? '')
        .replace(/,\s*"reasoning"\s*:\s*"[\s\S]*?"(?=\s*[},])/gu, ', "reasoning":"[filtered]"')
        .replace(/,\s*"reasoning_content"\s*:\s*"[\s\S]*?"(?=\s*[},])/gu, ', "reasoning_content":"[filtered]"')
        .replace(/"reasoning"\s*:\s*"[\s\S]*?"(?=\s*[},])/gu, '"reasoning":"[filtered]"')
        .replace(/"reasoning_content"\s*:\s*"[\s\S]*?"(?=\s*[},])/gu, '"reasoning_content":"[filtered]"');
}

function summarizeRouterResponse(rawResponse) {
    if (rawResponse === null || rawResponse === undefined) {
        return '(empty)';
    }

    if (typeof rawResponse === 'string') {
        return stripReasoningForDisplay(rawResponse);
    }

    try {
        return stripReasoningForDisplay(JSON.stringify(rawResponse, null, 2));
    } catch {
        const texts = collectRouterResponseTexts(rawResponse);
        if (texts.length) {
            return stripReasoningForDisplay(texts.join('\n\n---\n\n'));
        }

        return stripReasoningForDisplay(String(rawResponse));
    }
}

function createSelectionParseError(rawResponse, previewText = '', prompt = '') {
    const error = new Error(`AI selection JSON parse failed. Preview: ${truncateText(previewText, 220) || '(empty)'}`);
    error.routerPrompt = prompt;
    error.routerRaw = summarizeRouterResponse(rawResponse);
    return error;
}

function extractSelectionFromText(rawText, candidates) {
    const text = String(rawText || '');
    if (!text) {
        return [];
    }

    const normalizedText = normalizeText(text);
    const sentences = splitIntoSentences(text);
    const positiveMarkers = [
        'this is it', 'that is the answer', 'that\'s the answer', 'bingo', 'perfect match',
        'exact match', 'exactly', 'direct answer', 'most relevant', 'best match',
        '正是', '就是这个', '答案', '最相关', '完全匹配', '直接回答',
    ];
    const negativeMarkers = [
        'irrelevant', 'not relevant', 'no,', ' no ', 'not the answer', 'indirectly relevant',
        'just a natural event', 'not what happens after', 'not about', '不相关', '不是答案',
        '不是这个', '无关', '只是', '不对',
    ];
    const recovered = [];

    for (const candidate of candidates) {
        const entryKeys = getEntrySelectionKeys(candidate);
        let score = 0;

        for (const key of entryKeys) {
            const normalizedKey = normalizeText(key);
            const keyPattern = new RegExp(`["']?(?:key|keys?)["']?\\s*[:=]\\s*["']?${escapeRegex(key)}["']?`, 'u');
            if (keyPattern.test(text)) {
                score += 8;
            }
            if (normalizedKey && normalizedText.includes(normalizedKey)) {
                score += normalizedKey.length >= 3 ? 4 : 2;
            }
        }

        if (!score) {
            continue;
        }

        for (const sentence of sentences) {
            const normalizedSentence = normalizeText(sentence);
            const mentionsCandidate = entryKeys.some(key => {
                const normalizedKey = normalizeText(key);
                return normalizedKey && normalizedSentence.includes(normalizedKey);
            });
            if (!mentionsCandidate) {
                continue;
            }

            for (const marker of positiveMarkers) {
                if (normalizedSentence.includes(marker)) {
                    score += 6;
                }
            }
            for (const marker of negativeMarkers) {
                if (normalizedSentence.includes(marker)) {
                    score -= 5;
                }
            }
        }

        recovered.push({
            key: entryKeys[0] || '',
            reason: 'Recovered from router response text.',
            recoveryScore: score,
        });
    }

    const positives = recovered
        .filter(item => item.recoveryScore > 0)
        .sort((a, b) => b.recoveryScore - a.recoveryScore);

    if (!positives.length) {
        return [];
    }

    const strongestScore = positives[0].recoveryScore;
    const threshold = Math.max(6, strongestScore - 2);
    return positives
        .filter(item => item.recoveryScore >= threshold)
        .slice(0, 2)
        .map(({ recoveryScore, ...item }) => item);
}

function parseSelectionJson(rawResponse, candidates = [], prompt = '') {
    if (rawResponse && typeof rawResponse === 'object') {
        try {
            return normalizeSelectionPayload(rawResponse);
        } catch {
            // Fall through to text extraction / recovery for provider-specific wrappers.
        }
    }

    const texts = collectRouterResponseTexts(rawResponse);
    for (const text of texts) {
        const parsed = tryParseSelectionText(text);
        if (parsed) {
            return parsed;
        }
    }

    const recovered = extractSelectionFromText(texts.join('\n\n'), candidates);
    if (recovered.length) {
        return recovered;
    }

    throw createSelectionParseError(rawResponse, texts.join(' '), prompt);
}

function getRouterMessages(prompt) {
    return [
        { role: 'system', content: settings.systemPrompt },
        { role: 'user', content: prompt },
    ];
}

function getRouterRequestData(context, prompt) {
    return context.ChatCompletionService.createRequestData({
        stream: false,
        messages: getRouterMessages(prompt),
        model: settings.routerModel,
        chat_completion_source: 'openai',
        max_tokens: Math.max(settings.aiResponseLength, 384),
        temperature: 0,
        reverse_proxy: normalizeUrl(settings.routerApiUrl),
        proxy_password: String(settings.routerApiKey || ''),
        json_schema: getSelectionSchema(),
    });
}

async function selectWithSeparateRouterModel(context, recentMessages, mvuSummary, candidates) {
    const prompt = buildAiPrompt(recentMessages, mvuSummary, candidates);
    const data = getRouterRequestData(context, prompt);
    const result = await context.ChatCompletionService.sendRequest(data, true);
    const parsed = parseSelectionJson(result, candidates, prompt);
    return {
        parsed,
        prompt,
        rawPreview: summarizeRouterResponse(result),
    };
}

async function runSingleAiSelectionAttempt(context, recentMessages, mvuSummary, candidates) {
    let parsed;
    let prompt = '';
    let rawPreview = '';
    if (settings.routerUseSeparateModel && settings.routerApiUrl && settings.routerApiKey && settings.routerModel) {
        const result = await selectWithSeparateRouterModel(context, recentMessages, mvuSummary, candidates);
        parsed = result.parsed;
        prompt = result.prompt;
        rawPreview = result.rawPreview;
    } else {
        prompt = buildAiPrompt(recentMessages, mvuSummary, candidates);
        const raw = await context.generateRaw({
            prompt,
            systemPrompt: settings.systemPrompt,
            responseLength: settings.aiResponseLength,
            trimNames: false,
            jsonSchema: getSelectionSchema(),
        });
        parsed = parseSelectionJson(raw, candidates, prompt);
        rawPreview = summarizeRouterResponse(raw);
    }

    return { parsed, prompt, rawPreview };
}

async function selectWithAi(context, recentMessages, mvuSummary, candidates) {
    if (candidates.length === 0) {
        return {
            selected: [],
            prompt: '',
            rawPreview: '',
        };
    }

    const maxAttempts = Math.max(1, Number(settings.routerRetries || 0) + 1);
    let parsed;
    let prompt = '';
    let rawPreview = '';
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
            const result = await runSingleAiSelectionAttempt(context, recentMessages, mvuSummary, candidates);
            parsed = result.parsed;
            prompt = result.prompt;
            rawPreview = result.rawPreview;
            break;
        } catch (error) {
            lastError = error;
            prompt = error?.routerPrompt || prompt || '';
            rawPreview = error?.routerRaw || rawPreview || error?.message || String(error);
            debugLog(`Router attempt ${attempt}/${maxAttempts} failed`, error);

            if (attempt < maxAttempts) {
                playStatusBurst('🔄', 'retry');
                continue;
            }

            playStatusBurst('×', 'fail');
            flashWorldInfoError();
            throw error;
        }
    }

    if (!parsed) {
        throw lastError || new Error('Router selection failed without parsed result.');
    }

    const byId = new Map();
    const byKey = new Map();
    for (const entry of candidates) {
        byId.set(String(entry.routerId), entry);
        byId.set(String(entry.uid), entry);
        for (const key of getEntrySelectionKeys(entry)) {
            const normalizedKey = normalizeText(key);
            if (normalizedKey && !byKey.has(normalizedKey)) {
                byKey.set(normalizedKey, entry);
            }
        }
    }
    const selected = [];
    const seen = new Set();

    for (const item of parsed) {
        const entry = resolveEntryFromSelection(item, byId, byKey, candidates);
        if (!entry || seen.has(entry.routerId)) {
            continue;
        }

        seen.add(entry.routerId);
        selected.push({
            ...entry,
            reason: truncateText(item.reason || 'AI selected this entry.', 240),
        });

        if (selected.length >= settings.maxSelected) {
            break;
        }
    }

    return {
        selected,
        prompt,
        rawPreview,
    };
}

function selectWithFallback(candidates) {
    return candidates.slice(0, settings.maxSelected).map(entry => ({
        ...entry,
        reason: entry.matchedKeys?.length
            ? `关键词命中：${entry.matchedKeys.join(', ')}`
            : `关键词评分 fallback：${entry.score}`,
    }));
}

function buildInjection(selectedEntries) {
    if (!selectedEntries.length) {
        return '';
    }

    const header = '[本轮相关世界书]\n以下条目由前置路由器按当前用户消息、最近上下文和可选状态筛选，仅用于本轮回复保持设定一致。\n';
    const footer = '\n[/本轮相关世界书]';
    const parts = [header];
    let used = header.length + footer.length;

    for (const entry of selectedEntries) {
        const title = entry.comment || entry.keys.primary[0] || entry.uid;
        const separator = `\n--- ${title} | ${entry.world || entry.source}#${entry.uid} ---\n`;
        const remaining = settings.maxChars - used - separator.length - footer.length;
        if (remaining <= 0) {
            break;
        }

        const content = truncateText(entry.content, remaining);
        parts.push(separator, content, '\n');
        used += separator.length + content.length + 1;
    }

    parts.push(footer);
    return truncateText(parts.join(''), settings.maxChars);
}

function renderDebugPanel() {
    const summary = lastRun.error
        ? `失败：${lastRun.error}`
        : `候选 ${lastRun.candidates.length} 条，选择 ${lastRun.selected.length} 条，注入 ${lastRun.injectedChars} 字符，来源：${lastRun.source}`;
    $('#ai_wbr_last_summary').text(summary);

    const items = lastRun.selected.map(entry => {
        const title = entry.comment || entry.keys?.primary?.[0] || entry.uid;
        const keys = entry.matchedKeys?.length ? ` | keys: ${entry.matchedKeys.join(', ')}` : '';
        return $('<div class="ai-wbr-last-item"></div>')
            .append($('<div></div>').text(`${title} (${entry.world || entry.source}#${entry.uid})`))
            .append($('<small></small>').text(`${entry.reason || ''}${keys}`));
    });

    $('#ai_wbr_last_items').empty().append(items);
    $('#ai_wbr_injection_text').text(lastRun.injectionText || '尚无本轮注入记录');
    $('#ai_wbr_router_prompt').text(lastRun.routerPrompt || '尚无前置 AI Prompt 记录');
    $('#ai_wbr_router_raw').text(lastRun.routerRaw || '尚无前置 AI 返回记录');
}

function debugLog(...args) {
    if (settings.debug) {
        console.debug(LOG_PREFIX, ...args);
    }
}

function debugRun(candidates, selected, injection, source, routerPrompt = '', routerRaw = '') {
    lastRun = {
        candidates,
        selected,
        injectedChars: injection.length,
        injectionText: injection,
        source,
        error: '',
        routerPrompt,
        routerRaw,
    };

    if (settings.debug) {
        console.groupCollapsed(`${LOG_PREFIX} routed ${selected.length}/${candidates.length}`);
        console.debug('Candidates:', candidates.map(entry => ({
            id: entry.routerId,
            world: entry.world,
            comment: entry.comment,
            keys: entry.keys.all,
            matchedKeys: entry.matchedKeys,
            score: entry.score,
            constant: entry.constant,
        })));
        console.debug('Selected:', selected.map(entry => ({
            id: entry.routerId,
            reason: entry.reason,
        })));
        console.debug('Injection chars:', injection.length);
        console.debug('Injection:', injection);
        console.groupEnd();
    }

    renderDebugPanel();
}

function debugError(error) {
    lastRun = {
        candidates: [],
        selected: [],
        injectedChars: 0,
        injectionText: '',
        source: 'error',
        error: error?.message || String(error),
        routerPrompt: '',
        routerRaw: '',
    };
    renderDebugPanel();
}

async function routeWorldbookForMessages(context, recentMessages, routeSource = 'generate_interceptor', logMeta = {}) {
    const lastUserMessage = getLastUserMessage(recentMessages);
    debugLog('Generation intercepted', { ...logMeta, routeSource, lastUserMessage });

    const mvuSummary = getMvuSummary(context);
    const entries = await getWorldbookEntries(context);
    const candidates = recallCandidates(entries, recentMessages, mvuSummary);

    if (candidates.length === 0) {
        debugRun([], [], '', `none-${routeSource}`);
        lastRouteCompletedAt = Date.now();
        return {
            candidates,
            selected: [],
            injection: '',
            source: `none-${routeSource}`,
        };
    }

    let selected = [];
    let routerPrompt = '';
    let routerRaw = '';
    let source = `ai-${routeSource}`;
    try {
        isRouterSelectionRequest = true;
        const aiResult = await selectWithAi(context, recentMessages, mvuSummary, candidates);
        selected = aiResult.selected;
        routerPrompt = aiResult.prompt;
        routerRaw = aiResult.rawPreview;
        source = selected.length ? `ai-${routeSource}` : `keyword-empty-ai-${routeSource}`;
    } catch (error) {
        source = `keyword-ai-fallback-${routeSource}`;
        console.warn(`${LOG_PREFIX} AI selection failed; falling back to keyword score.`, error);
        routerPrompt = error?.routerPrompt || '';
        routerRaw = error?.routerRaw || error?.message || String(error);
    } finally {
        isRouterSelectionRequest = false;
    }

    if (!selected.length) {
        selected = selectWithFallback(candidates);
    }

    const injection = buildInjection(selected);
    setExtensionPrompt(PROMPT_KEY, injection, settings.position, settings.depth, false, settings.role);
    debugRun(candidates, selected, injection, source, routerPrompt, routerRaw);
    lastRouteCompletedAt = Date.now();

    return {
        candidates,
        selected,
        injection,
        source,
    };
}

async function runTavernHelperRoute(args) {
    const options = args?.[0];
    if (!shouldRouteTavernHelperGenerate(options)) {
        return false;
    }

    options._ai_wbr_routed = true;
    isCompatRouterRunning = true;
    const endRouterBusy = beginRouterBusy();
    setExtensionPrompt(PROMPT_KEY, '', settings.position, settings.depth, false, settings.role);
    clearEntryBurst();
    startWorldInfoAnimation();

    try {
        const context = getContext();
        const recentMessages = buildCompatRecentMessages(context, options);
        const result = await routeWorldbookForMessages(context, recentMessages, 'tavernhelper_generate', {
            type: 'tavernhelper',
        });

        stopWorldInfoAnimation();
        if (result.selected.length && !result.source.includes('fallback')) {
            playSelectedEntriesBurst(result.selected);
        }

        return true;
    } catch (error) {
        setExtensionPrompt(PROMPT_KEY, '', settings.position, settings.depth, false, settings.role);
        debugError(error);
        console.error(`${LOG_PREFIX} TavernHelper route failed`, error);
        return false;
    } finally {
        stopWorldInfoAnimation();
        endRouterBusy();
        isCompatRouterRunning = false;
    }
}

function renderRouterModelOptions() {
    const select = $('#ai_wbr_router_model');
    if (!select.length) {
        return;
    }

    select.empty();
    select.append('<option value="">未选择</option>');
    for (const modelId of settings.routerModels || []) {
        select.append($('<option></option>', {
            value: modelId,
            text: modelId,
            selected: modelId === settings.routerModel,
        }));
    }

    if (settings.routerModel && !settings.routerModels.includes(settings.routerModel)) {
        select.append($('<option></option>', {
            value: settings.routerModel,
            text: `${settings.routerModel} (手动)`,
            selected: true,
        }));
    }
}

async function fetchRouterModels() {
    const context = getContext();
    const apiUrl = normalizeUrl(settings.routerApiUrl);
    const apiKey = String(settings.routerApiKey || '').trim();

    if (!apiUrl) {
        toastr.warning('请先填写独立路由模型的 API URL。', '世界书读取');
        return;
    }

    if (!apiKey) {
        toastr.warning('请先填写独立路由模型的 API Key。', '世界书读取');
        return;
    }

    setRouterStatus('正在拉取模型...');

    try {
        const response = await fetch('/api/backends/chat-completions/status', {
            method: 'POST',
            headers: context.getRequestHeaders(),
            cache: 'no-cache',
            body: JSON.stringify({
                chat_completion_source: 'openai',
                reverse_proxy: apiUrl,
                proxy_password: apiKey,
            }),
        });

        const data = await response.json();
        const models = Array.isArray(data?.data)
            ? data.data.map(model => String(model?.id || '')).filter(Boolean)
            : [];

        if (!response.ok || !models.length) {
            throw new Error(data?.error?.message || data?.message || '没有拿到可用模型');
        }

        settings.routerModels = models;
        if (!models.includes(settings.routerModel)) {
            settings.routerModel = models[0];
        }

        Object.assign(extension_settings[MODULE_NAME], settings);
        saveSettingsDebounced();
        renderRouterModelOptions();
        setRouterStatus(`已拉取 ${models.length} 个模型`);
        toastr.success(`已拉取 ${models.length} 个模型`, '世界书读取');
    } catch (error) {
        setRouterStatus(`拉取失败：${error.message || error}`);
        console.error(`${LOG_PREFIX} Failed to fetch router models`, error);
        toastr.error(String(error.message || error), '世界书读取');
    }
}

async function interceptGeneration(chat, contextSize, abort, type) {
    setExtensionPrompt(PROMPT_KEY, '', settings.position, settings.depth, false, settings.role);

    if (!settings.enabled || type === 'quiet') {
        return;
    }

    const context = getContext();
    const endRouterBusy = beginRouterBusy();
    clearEntryBurst();
    startWorldInfoAnimation();
    try {
        const recentMessages = getRecentMessages(chat);
        const result = await routeWorldbookForMessages(context, recentMessages, 'generate_interceptor', {
            type,
            contextSize,
        });
        stopWorldInfoAnimation();
        if (result.selected.length && !result.source.includes('fallback')) {
            playSelectedEntriesBurst(result.selected);
        }
    } catch (error) {
        setExtensionPrompt(PROMPT_KEY, '', settings.position, settings.depth, false, settings.role);
        debugError(error);
        console.error(`${LOG_PREFIX} Interceptor failed`, error);
    } finally {
        stopWorldInfoAnimation();
        endRouterBusy();
    }
}

function bindCheckbox(id, key) {
    $(id).prop('checked', !!settings[key]).on('input', function () {
        saveSetting(key, !!$(this).prop('checked'));
    });
}

function bindNumber(id, key, min, max) {
    $(id).val(settings[key]).on('input', function () {
        const value = clampNumber($(this).val(), defaultSettings[key], min, max);
        saveSetting(key, value);
        $(this).val(value);
    });
}

function bindSelectNumber(id, key) {
    $(id).val(String(settings[key])).on('change', function () {
        saveSetting(key, Number($(this).val()));
    });
}

function bindTextarea(id, key) {
    $(id).val(settings[key]).on('input', function () {
        saveSetting(key, String($(this).val()));
    });
}

function bindText(id, key, normalizer = (value) => String(value)) {
    $(id).val(settings[key]).on('input', function () {
        saveSetting(key, normalizer($(this).val()));
    });
}

function renderTitleBlocklistEditor() {
    const container = $('#ai_wbr_title_block_items');
    if (!container.length) {
        return;
    }

    const rules = parseBlockRules(settings.titleBlocklist);
    container.empty();

    if (!rules.length) {
        container.append('<div class="ai-wbr-token-empty">暂无拦截标题</div>');
        return;
    }

    for (const rule of rules) {
        const item = $('<div class="ai-wbr-token-item"></div>');
        item.append($('<span class="ai-wbr-token-label"></span>').text(rule));
        item.append($('<button class="ai-wbr-token-remove" type="button" aria-label="删除">×</button>')
            .on('click', () => {
                const nextRules = parseBlockRules(settings.titleBlocklist).filter(entry => entry !== rule);
                saveSetting('titleBlocklist', nextRules.join('\n'));
                renderTitleBlocklistEditor();
            }));
        container.append(item);
    }
}

function bindTitleBlocklistEditor() {
    const input = $('#ai_wbr_title_block_input');
    const button = $('#ai_wbr_title_block_add');
    if (!input.length || !button.length) {
        return;
    }

    const submit = () => {
        const value = String(input.val() || '').trim();
        if (!value) {
            return;
        }

        const rules = parseBlockRules(settings.titleBlocklist);
        if (!rules.includes(value)) {
            rules.push(value);
            saveSetting('titleBlocklist', rules.join('\n'));
        }

        input.val('');
        renderTitleBlocklistEditor();
    };

    button.on('click', submit);
    input.on('keydown', (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            submit();
        }
    });

    renderTitleBlocklistEditor();
}

async function addSettingsUi() {
    const html = await renderExtensionTemplateAsync('third-party/ai-worldbook-router', 'settings');
    $('#extensions_settings2').append(html);

    bindCheckbox('#ai_wbr_enabled', 'enabled');
    bindCheckbox('#ai_wbr_debug', 'debug');
    bindCheckbox('#ai_wbr_router_use_separate_model', 'routerUseSeparateModel');
    bindCheckbox('#ai_wbr_keyword_recall', 'keywordRecall');
    bindCheckbox('#ai_wbr_use_mvu', 'useMvu');
    bindCheckbox('#ai_wbr_allow_constant', 'allowConstant');

    bindNumber('#ai_wbr_max_candidates', 'maxCandidates', 1, 100);
    bindNumber('#ai_wbr_max_selected', 'maxSelected', 1, 50);
    bindNumber('#ai_wbr_max_chars', 'maxChars', 100, 30000);
    bindNumber('#ai_wbr_scan_messages', 'scanMessages', 1, 50);
    bindNumber('#ai_wbr_depth', 'depth', 0, 1000);
    bindNumber('#ai_wbr_ai_response_length', 'aiResponseLength', 32, 16384);
    bindNumber('#ai_wbr_router_retries', 'routerRetries', 0, 5);

    bindSelectNumber('#ai_wbr_position', 'position');
    bindSelectNumber('#ai_wbr_role', 'role');
    bindTitleBlocklistEditor();
    bindTextarea('#ai_wbr_system_prompt', 'systemPrompt');
    bindText('#ai_wbr_router_api_url', 'routerApiUrl', normalizeUrl);
    bindText('#ai_wbr_router_api_key', 'routerApiKey', (value) => String(value).trim());

    renderRouterModelOptions();
    $('#ai_wbr_router_model').val(settings.routerModel).on('change', function () {
        saveSetting('routerModel', String($(this).val() || ''));
    });
    $('#ai_wbr_fetch_models').on('click', async (event) => {
        event.preventDefault();
        await fetchRouterModels();
    });
    $('#ai_wbr_router_status').text(settings.routerStatus || '未连接');

    renderDebugPanel();
}

globalThis.ai_worldbook_router_intercept = interceptGeneration;
installFetchFallbackHook();

jQuery(async () => {
    try {
        ensureSettings();
        await addSettingsUi();
        installFetchFallbackHook();
        installCompatSendHooks();
        ensureTavernHelperCompatHook();
        startCompatGenerateHookPolling();

        eventSource.on(event_types.GENERATION_STARTED, () => {
            isGenerationActive = true;
        });
        eventSource.on(event_types.GENERATION_ENDED, () => {
            isGenerationActive = false;
            scheduleCompatFlush();
        });
        eventSource.on(event_types.GENERATION_STOPPED, () => {
            isGenerationActive = false;
            scheduleCompatFlush();
        });

        eventSource.on(event_types.CHAT_CHANGED, () => {
            clearEntryBurst();
            stopWorldInfoAnimation();
            pendingCompatSend = false;
            suppressCompatReplay = false;
            lastRun = {
                candidates: [],
                selected: [],
                injectedChars: 0,
                injectionText: '',
                source: 'none',
                error: '',
                routerPrompt: '',
                routerRaw: '',
            };
            setExtensionPrompt(PROMPT_KEY, '', settings.position, settings.depth, false, settings.role);
            renderDebugPanel();
        });

        debugLog('Loaded');
    } catch (error) {
        console.error(`${LOG_PREFIX} Failed during initialization`, error);
    }
});
