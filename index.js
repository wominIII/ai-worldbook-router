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
const MAX_MEMORY_CONTEXT_PREVIEW = 260;
const MAX_MEMORY_SELECTED = 4;
const CHAT_MEMORY_FIELD = 'AIWBR_ChatMemory';
const MEMORY_GRAPH_CANVAS_WIDTH = 760;
const MEMORY_GRAPH_CANVAS_HEIGHT = 340;
const MEMORY_GRAPH_NODE_WIDTH = 172;
const MEMORY_GRAPH_NODE_HEIGHT = 82;
const MEMORY_GRAPH_NODE_HORIZONTAL_GAP = 36;
const MEMORY_GRAPH_NODE_VERTICAL_GAP = 28;
const MEMORY_GRAPH_SAFE_PADDING = 12;
const MEMORY_GRAPH_TOP_SAFE_PADDING = 56;
const MEMORY_GRAPH_NODE_COLORS = [
    '#54d6ff', '#4ff0b4', '#ffc15f', '#c29cff', '#ffe06e', '#ff96bd',
    '#80a7ff', '#f48cff', '#8ff5e8', '#ff8f70', '#b6f36b', '#a98cff',
];
const MEMORY_NODE_TYPE_OPTIONS = [
    { value: 'event', label: '事件' },
    { value: 'character', label: '角色' },
    { value: 'location', label: '地点' },
    { value: 'faction', label: '势力' },
    { value: 'item', label: '道具' },
    { value: 'concept', label: '概念' },
    { value: 'rule', label: '规则' },
    { value: 'quest', label: '任务' },
];
const MEMORY_LINK_TYPE_OPTIONS = [
    { value: 'INVOLVES', label: '涉及' },
    { value: 'PART_OF', label: '属于' },
    { value: 'HAPPENS_AT', label: '发生于' },
    { value: 'FOLLOWS', label: '后续于' },
    { value: 'UPDATES', label: '更新' },
    { value: 'OPPOSES', label: '对立' },
    { value: 'ALLIED_WITH', label: '同盟' },
    { value: 'CAUSES', label: '导致' },
    { value: 'RELATED', label: '相关' },
    { value: 'MENTIONS', label: '提及' },
];
const MEMORY_LINK_TYPES = new Set([
    'INVOLVES', 'PART_OF', 'HAPPENS_AT', 'FOLLOWS', 'UPDATES', 'OPPOSES',
    'ALLIED_WITH', 'CAUSES', 'RELATED', 'MENTIONS',
]);
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
只做一件事：从候选 keys 中选择本轮真正相关的条目。
只输出严格 JSON。
禁止 Markdown。
禁止解释。
禁止 reasoning。
禁止额外字段。
唯一合法格式：{"selected":[{"key":"命中的 key","reason":"简短原因"}]}`;

const defaultSettings = {
    enabled: false,
    debug: false,
    routerUseSeparateModel: false,
    routerApiUrl: '',
    routerApiKey: '',
    routerModel: '',
    routerModels: [],
    routerStatus: '未连接',
    routerRequestMaxTokens: 10000,
    maxCandidates: 24,
    maxSelected: 5,
    maxChars: 4000,
    scanMessages: 8,
    mainHistoryAiTurns: 0,
    memoryEnabled: false,
    memoryAutoRun: true,
    memoryAutoRunInterval: 20,
    memoryInjectToRouter: true,
    memoryDebug: false,
    memoryScopeDebug: false,
    memoryScanMessages: 6,
    memoryRequestMaxTokens: 10000,
    memoryRetries: 3,
    memoryMaxNodes: 60,
    memoryMaxLinks: 120,
    memoryContainersByChat: {},
    memoryLegacyGraphChatKeys: {},
    memoryGraphsByChat: {},
    memoryStatusesByChat: {},
    memoryLastTurnSignaturesByChat: {},
    memoryLastPromptsByChat: {},
    memoryLastRawByChat: {},
    memoryLastErrorsByChat: {},
    memoryGraph: null,
    memoryLastTurnSignature: '',
    memoryStatus: '未启用',
    memoryLastPrompt: '',
    memoryLastRaw: '',
    memoryLastError: '',
    keywordRecall: true,
    useMvu: false,
    allowConstant: false,
    titleBlocklist: '',
    worldSelectionStates: {},
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
    memoryCandidates: [],
    selectedMemories: [],
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
let isMemoryWorkerRunning = false;
let memoryUpdateTimer = null;
let chatUiRefreshTimers = [];
let chatScopedUiPollTimer = null;
let lastObservedChatScopedUiSignature = '';
let memoryGraphView = { x: 0, y: 0, width: MEMORY_GRAPH_CANVAS_WIDTH, height: MEMORY_GRAPH_CANVAS_HEIGHT };
let memoryGraphDrag = null;
let memoryGraphPan = null;
let memoryGraphLinkSourceId = '';
let memoryGraphSelectedNodeId = '';
let memoryGraphSelectedLinkId = '';
let lastKnownChatFileName = '';

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

function clearChatUiRefreshTimers() {
    for (const timer of chatUiRefreshTimers) {
        clearTimeout(timer);
    }
    chatUiRefreshTimers = [];
}

function getChatScopedUiSignature(context = getContext()) {
    const chat = Array.isArray(context?.chat) ? context.chat : [];
    const first = chat[0];
    const memoryRaw = first && typeof first === 'object' ? first[CHAT_MEMORY_FIELD] : '';
    const memoryStamp = typeof memoryRaw === 'string'
        ? memoryRaw.slice(0, 120)
        : JSON.stringify(memoryRaw || {}).slice(0, 120);
    const charaFile = String(getCharaFilename?.() || '');
    const character = context?.characters?.[context?.characterId] || context?.character;
    const worldStamp = getActiveWorldbookBindings(context)
        .map(binding => `${binding.worldName}:${binding.source}:${getWorldSelectionState(binding.worldName) ? '1' : '0'}`)
        .join(',');
    return [
        charaFile,
        String(context?.characterId ?? context?.character_id ?? ''),
        String(context?.groupId ?? context?.group_id ?? ''),
        String(character?.avatar ?? character?.name ?? ''),
        String(context?.chatId ?? context?.chat_id ?? context?.conversationId ?? context?.sessionId ?? ''),
        String(context?.chatMetadata?.file_name ?? context?.chatMetadata?.main_chat ?? context?.chatMetadata?.name ?? ''),
        String(chat.length),
        memoryStamp,
        worldStamp,
    ].join('|');
}

function rememberChatIdentifierFromEvent(...args) {
    for (const arg of args) {
        const value = typeof arg === 'string'
            ? arg
            : (arg?.chatId || arg?.chat_id || arg?.file_name || arg?.filename || arg?.name || '');
        const text = String(value || '').trim();
        if (text && text !== 'null' && text !== 'undefined') {
            lastKnownChatFileName = text;
            return text;
        }
    }
    return '';
}

function getMemoryGraphSummary(graph) {
    const safeGraph = graph && typeof graph === 'object' ? graph : getDefaultMemoryGraph();
    const state = safeGraph.state || {};
    return {
        location: state.current_location || '',
        time: state.current_time || '',
        objective: state.current_objective || '',
        nodes: Array.isArray(safeGraph.nodes) ? safeGraph.nodes.length : 0,
        links: Array.isArray(safeGraph.links) ? safeGraph.links.length : 0,
        nodeTitles: (Array.isArray(safeGraph.nodes) ? safeGraph.nodes : []).slice(0, 8).map(node => `${node.type || 'memory'}:${node.title || node.id}`),
        updatedAt: safeGraph.updatedAt || '',
    };
}

function getMemoryScopeDebugSnapshot(context = getContext()) {
    const chat = Array.isArray(context?.chat) ? context.chat : [];
    const first = getChatMemoryFirstMessage(context);
    const raw = first && typeof first === 'object' ? first[CHAT_MEMORY_FIELD] : undefined;
    const parsed = typeof raw === 'string'
        ? (() => {
            try {
                return JSON.parse(raw);
            } catch {
                return null;
            }
        })()
        : raw;
    return {
        signature: getChatScopedUiSignature(context),
        chatLength: chat.length,
        firstMessageName: first?.name || '',
        hasFirstMessage: !!first,
        hasChatMemoryField: raw !== undefined,
        rawType: raw === undefined ? 'undefined' : typeof raw,
        rawPreview: typeof raw === 'string' ? raw.slice(0, 180) : JSON.stringify(raw || null).slice(0, 180),
        parsedGraph: getMemoryGraphSummary(parsed?.graph || null),
        contextIds: {
            charaFile: String(getCharaFilename?.() || ''),
            characterId: context?.characterId ?? context?.character_id ?? '',
            groupId: context?.groupId ?? context?.group_id ?? '',
            chatId: context?.chatId ?? context?.chat_id ?? '',
            conversationId: context?.conversationId ?? '',
            sessionId: context?.sessionId ?? '',
            metadataFile: context?.chatMetadata?.file_name ?? context?.chatMetadata?.main_chat ?? context?.chatMetadata?.name ?? '',
        },
    };
}

function memoryScopeDebugLog(action, details = {}, context = getContext()) {
    if (!settings.memoryScopeDebug) {
        return;
    }
    try {
        console.groupCollapsed(`${LOG_PREFIX} [MemoryScope] ${action}`);
        console.debug('snapshot:', getMemoryScopeDebugSnapshot(context));
        if (details && Object.keys(details).length) {
            console.debug('details:', details);
        }
        console.groupEnd();
    } catch (error) {
        console.warn(`${LOG_PREFIX} [MemoryScope] debug log failed`, error);
    }
}

if (typeof window !== 'undefined') {
    window.aiWbrMemoryDebugDump = () => {
        const snapshot = getMemoryScopeDebugSnapshot();
        console.debug(`${LOG_PREFIX} [MemoryScope] manual dump`, snapshot);
        return snapshot;
    };
}

function clearMemoryUiForScopeSwitch() {
    memoryScopeDebugLog('clearMemoryUiForScopeSwitch');
    $('#ai_wbr_memory_node_popover').hide();
    $('#ai_wbr_memory_graph').html('<div class="ai-wbr-token-empty">正在切换聊天记忆...</div>');
    $('#ai_wbr_memory_node_editor').empty().append('<div class="ai-wbr-token-empty">点击上方图谱节点后，这里会显示该节点的可编辑信息。</div>');
    $('#ai_wbr_memory_nodes').empty();
    $('#ai_wbr_memory_links').empty();
    $('#ai_wbr_memory_json').val('');
}

function safeRenderChatScopedPanels() {
    if (memoryGraphDrag || memoryGraphPan) {
        memoryScopeDebugLog('safeRenderChatScopedPanels skipped while dragging/panning');
        return;
    }
    memoryScopeDebugLog('safeRenderChatScopedPanels before render');
    renderDebugPanel();
    renderMemoryPanel();
    renderActiveWorldbookSelector();
}

function scheduleChatScopedUiRefresh() {
    clearChatUiRefreshTimers();
    const delays = [0, 40, 140, 360, 800];
    memoryScopeDebugLog('scheduleChatScopedUiRefresh', { delays });
    for (const delay of delays) {
        const timer = setTimeout(() => {
            safeRenderChatScopedPanels();
        }, delay);
        chatUiRefreshTimers.push(timer);
    }
}

function startChatScopedUiPolling() {
    if (chatScopedUiPollTimer) {
        clearInterval(chatScopedUiPollTimer);
    }
    lastObservedChatScopedUiSignature = getChatScopedUiSignature();
    chatScopedUiPollTimer = setInterval(() => {
        if (memoryGraphDrag || memoryGraphPan) {
            return;
        }
        const nextSignature = getChatScopedUiSignature();
        if (nextSignature !== lastObservedChatScopedUiSignature) {
            memoryScopeDebugLog('poll signature changed', {
                previous: lastObservedChatScopedUiSignature,
                next: nextSignature,
            });
            lastObservedChatScopedUiSignature = nextSignature;
            safeRenderChatScopedPanels();
        }
    }, 500);
}

function handleChatScopedUiMaybeChanged() {
    memoryScopeDebugLog('handleChatScopedUiMaybeChanged');
    clearEntryBurst();
    stopWorldInfoAnimation();
    clearTimeout(memoryUpdateTimer);
    clearChatUiRefreshTimers();
    memoryGraphSelectedNodeId = '';
    memoryGraphSelectedLinkId = '';
    memoryGraphLinkSourceId = '';
    clearMemoryUiForScopeSwitch();
    lastObservedChatScopedUiSignature = '';
    scheduleChatScopedUiRefresh();
}

function handleMessageDeletedOrSwiped() {
    try {
        const context = getContext();
        const container = getChatMemoryContainer(context);
        if (container.graphBackup) {
            memoryScopeDebugLog('Restoring memory graph from backup due to message deletion/swipe');
            container.graph = cloneMemoryGraph(container.graphBackup);
            container.graphBackup = null;
            persistChatMemoryContainer(container, context);
            settings.memoryGraph = container.graph;
            Object.assign(extension_settings[MODULE_NAME], settings);
            saveSettingsDebounced();
            setCurrentMemoryLastTurnSignature('', context);
            setMemoryStatus('已回退记忆状态（检测到重刷/删除）', context);
            
            // Re-render UI if applicable
            if (!memoryGraphDrag && !memoryGraphPan) {
                scheduleChatScopedUiRefresh();
            }
        }
    } catch (error) {
        console.warn(`${LOG_PREFIX} Failed to restore memory graph backup`, error);
    }
}

function installChatScopedUiRefreshEventHooks() {
    const strictScopeEvents = [
        'CHAT_CHANGED',
        'CHAT_LOADED',
    ];

    for (const key of strictScopeEvents) {
        const value = event_types?.[key];
        if (!value) {
            continue;
        }
        try {
            eventSource.on(value, (...args) => {
                rememberChatIdentifierFromEvent(...args);
                memoryScopeDebugLog(`event ${key}`, {
                    eventValue: value,
                    argsPreview: args.slice(0, 2).map(arg => {
                        try {
                            return JSON.stringify(arg).slice(0, 240);
                        } catch {
                            return String(arg);
                        }
                    }),
                });
                handleChatScopedUiMaybeChanged();
            });
        } catch {
            // no-op
        }
    }

    const rollbackEvents = ['MESSAGE_DELETED', 'MESSAGE_SWIPED'];
    for (const key of rollbackEvents) {
        const value = event_types?.[key];
        if (!value) {
            continue;
        }
        try {
            eventSource.on(value, () => {
                handleMessageDeletedOrSwiped();
            });
        } catch {
            // no-op
        }
    }
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
    settings.memoryContainersByChat = settings.memoryContainersByChat && typeof settings.memoryContainersByChat === 'object' ? settings.memoryContainersByChat : {};
    settings.memoryLegacyGraphChatKeys = settings.memoryLegacyGraphChatKeys && typeof settings.memoryLegacyGraphChatKeys === 'object' ? settings.memoryLegacyGraphChatKeys : {};
    settings.worldSelectionStates = settings.worldSelectionStates && typeof settings.worldSelectionStates === 'object' ? settings.worldSelectionStates : {};
    settings.memoryGraphsByChat = settings.memoryGraphsByChat && typeof settings.memoryGraphsByChat === 'object' ? settings.memoryGraphsByChat : {};
    settings.memoryStatusesByChat = settings.memoryStatusesByChat && typeof settings.memoryStatusesByChat === 'object' ? settings.memoryStatusesByChat : {};
    settings.memoryLastTurnSignaturesByChat = settings.memoryLastTurnSignaturesByChat && typeof settings.memoryLastTurnSignaturesByChat === 'object' ? settings.memoryLastTurnSignaturesByChat : {};
    settings.memoryLastPromptsByChat = settings.memoryLastPromptsByChat && typeof settings.memoryLastPromptsByChat === 'object' ? settings.memoryLastPromptsByChat : {};
    settings.memoryLastRawByChat = settings.memoryLastRawByChat && typeof settings.memoryLastRawByChat === 'object' ? settings.memoryLastRawByChat : {};
    settings.memoryLastErrorsByChat = settings.memoryLastErrorsByChat && typeof settings.memoryLastErrorsByChat === 'object' ? settings.memoryLastErrorsByChat : {};
    if (!settings.memoryGraph || typeof settings.memoryGraph !== 'object') {
        settings.memoryGraph = getDefaultMemoryGraph();
    }
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

function startMemoryAnimation() {
    startWorldInfoAnimation();
    const underline = $('#ai_wbr_fx_layer .ai-wbr-book-underline');
    if (!underline.length) {
        return;
    }
    underline.addClass('ai-wbr-book-underline-memory');
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

async function requestMemoryExtraction(context, prompt, systemPrompt) {
    if (settings.routerUseSeparateModel && settings.routerApiUrl && settings.routerApiKey && settings.routerModel) {
        return sendSeparateMemoryRequest(context, prompt, {
            systemPrompt,
            maxTokens: getMemoryRequestMaxTokens(),
        });
    }

    return context.generateRaw({
        prompt,
        systemPrompt,
        responseLength: getMemoryRequestMaxTokens(),
        trimNames: false,
    });
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

function getMemoryBurstLabel(entry) {
    const title = String(entry?.title || '').trim();
    if (title) {
        return truncateText(title, 22);
    }
    const content = String(entry?.content || '').trim();
    if (content) {
        return truncateText(content.split(/[。.!?\n]/u)[0], 22);
    }
    return truncateText(String(entry?.id || '记忆更新'), 22);
}

function playEntryBurst(entries, {
    variant = 'router',
    labelGetter = getEntryBurstLabel,
} = {}) {
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
        const chip = $('<div class="ai-wbr-entry-burst"></div>')
            .addClass(variant === 'memory' ? 'ai-wbr-entry-burst-memory' : '')
            .text(labelGetter(entry));
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

function playSelectedEntriesBurst(entries) {
    playEntryBurst(entries, {
        variant: 'router',
        labelGetter: getEntryBurstLabel,
    });
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

function truncateTextByDisplayWidth(value, maxWidth) {
    const text = String(value ?? '').trim();
    let width = 0;
    let result = '';

    for (const char of text) {
        const charWidth = /[\u1100-\u115f\u2e80-\u9fff\uf900-\ufaff\uff01-\uff60\uffe0-\uffe6]/u.test(char) ? 2 : 1;
        if (width + charWidth > Math.max(0, maxWidth - 1)) {
            return `${result}…`;
        }
        width += charWidth;
        result += char;
    }

    return result;
}

function hashMemoryGraphColorKey(value) {
    const text = String(value ?? '');
    let hash = 0;
    for (let i = 0; i < text.length; i += 1) {
        hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
    }
    return Math.abs(hash);
}

function getMemoryNodeColor(node, index = 0) {
    const colorIndex = (hashMemoryGraphColorKey(node?.id || node?.title || index) + index) % MEMORY_GRAPH_NODE_COLORS.length;
    return MEMORY_GRAPH_NODE_COLORS[colorIndex] || MEMORY_GRAPH_NODE_COLORS[0];
}

function getSvgSafeId(value) {
    return String(value ?? '')
        .replace(/[^a-zA-Z0-9_-]/g, '_')
        .replace(/^([^a-zA-Z_])/, '_$1');
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

function getWorldSelectionState(worldName) {
    const name = String(worldName || '').trim();
    if (!name) {
        return true;
    }
    const state = settings.worldSelectionStates?.[name];
    return state !== false;
}

function setWorldSelectionState(worldName, enabled) {
    const name = String(worldName || '').trim();
    if (!name) {
        return;
    }
    const nextStates = {
        ...(settings.worldSelectionStates || {}),
        [name]: !!enabled,
    };
    saveSetting('worldSelectionStates', nextStates);
}

function getActiveWorldbookBindings(context = getContext()) {
    const character = context.characters?.[context.characterId];
    const worldBindings = [];
    const seen = new Set();

    const addWorld = (worldName, source) => {
        const name = String(worldName || '').trim();
        if (!name || seen.has(name)) {
            return;
        }
        seen.add(name);
        worldBindings.push({
            worldName: name,
            source,
        });
    };

    for (const worldName of selected_world_info || []) {
        addWorld(worldName, '全局');
    }

    addWorld(context.chatMetadata?.[METADATA_KEY], '聊天绑定');
    addWorld(character?.data?.extensions?.world, '角色绑定');
    addWorld(context.powerUserSettings?.persona_description_lorebook, '人格绑定');

    try {
        const fileName = context.characterId !== undefined ? getCharaFilename(context.characterId) : '';
        const extraCharLore = world_info.charLore?.find(entry => entry.name === fileName);
        for (const worldName of extraCharLore?.extraBooks || []) {
            addWorld(worldName, '角色额外');
        }
    } catch (error) {
        debugLog('Could not read active worldbook bindings', error);
    }

    const embeddedBook = character?.data?.character_book;
    if (embeddedBook?.entries?.length) {
        addWorld(embeddedBook.name || character?.name || 'embedded', '角色内嵌');
    }

    return worldBindings;
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

function trimMainGenerationMessages(messages) {
    if (!Array.isArray(messages)) {
        return { changed: false, trimmedCount: 0 };
    }

    const maxAssistantTurns = clampNumber(settings.mainHistoryAiTurns, 0, 0, 100);
    if (maxAssistantTurns <= 0) {
        return { changed: false, trimmedCount: 0 };
    }

    const assistantIndexes = [];
    for (let index = 0; index < messages.length; index += 1) {
        if (String(messages[index]?.role || '').toLowerCase() === 'assistant') {
            assistantIndexes.push(index);
        }
    }

    if (assistantIndexes.length <= maxAssistantTurns) {
        return { changed: false, trimmedCount: 0 };
    }

    let startIndex = assistantIndexes[assistantIndexes.length - maxAssistantTurns];
    while (startIndex > 0 && String(messages[startIndex - 1]?.role || '').toLowerCase() === 'user') {
        startIndex -= 1;
    }

    const trimmedMessages = messages.filter((message, index) => {
        const role = String(message?.role || '').toLowerCase();
        if (role !== 'user' && role !== 'assistant') {
            return true;
        }

        return index >= startIndex;
    });

    const trimmedCount = messages.length - trimmedMessages.length;
    if (trimmedCount <= 0) {
        return { changed: false, trimmedCount: 0 };
    }

    messages.splice(0, messages.length, ...trimmedMessages);
    return { changed: true, trimmedCount };
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
        if (!body) {
            return originalFetch(input, init);
        }

        let payload;
        try {
            payload = JSON.parse(body);
        } catch {
            return originalFetch(input, init);
        }

        const context = getContext();
        const recentMessages = buildFetchFallbackMessages(context, payload);
        const trimResult = trimMainGenerationMessages(payload.messages);
        const shouldSkipRouting = body.includes('[本轮相关世界书]') || Date.now() - lastRouteCompletedAt < 3000;

        if (shouldSkipRouting) {
            if (trimResult.changed) {
                debugLog('Trimmed main generation history without rerouting', {
                    url: getFetchUrl(input),
                    trimmedCount: trimResult.trimmedCount,
                    remainingMessages: payload.messages?.length ?? 0,
                });
                return originalFetch(input, {
                    ...init,
                    body: JSON.stringify(payload),
                });
            }

            return originalFetch(input, init);
        }

        const endRouterBusy = beginRouterBusy();
        clearEntryBurst();
        startWorldInfoAnimation();

        try {
            if (!recentMessages.length) {
                return originalFetch(input, trimResult.changed ? {
                    ...init,
                    body: JSON.stringify(payload),
                } : init);
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
                trimmedCount: trimResult.trimmedCount,
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

function getDefaultMemoryGraph() {
    return {
        version: 1,
        state: {
            current_location: '',
            current_time: '',
            protagonist_status: '',
            current_objective: '',
            current_phase: '',
            active_topics: [],
            open_questions: [],
            custom_values: {},
        },
        stateDefinitions: [],
        nodes: [],
        links: [],
        lastSummary: '',
        updatedAt: '',
    };
}

function hashString(value) {
    let hash = 0;
    const text = String(value || '');
    for (let i = 0; i < text.length; i += 1) {
        hash = ((hash << 5) - hash) + text.charCodeAt(i);
        hash |= 0;
    }
    return Math.abs(hash).toString(36);
}

function getCurrentChatMemoryKey(context = getContext()) {
    const stableChatParts = [];
    const stableChatCandidates = [
        context?.chatId,
        context?.chat_id,
        context?.conversationId,
        context?.sessionId,
        context?.chatFileName,
        context?.chat_filename,
        context?.chatName,
        context?.chat_name,
        lastKnownChatFileName,
        context?.chatMetadata?.chat_id,
        context?.chatMetadata?.session_id,
        context?.chatMetadata?.filename,
        context?.chatMetadata?.file_name,
        context?.chatMetadata?.main_chat,
        context?.chatMetadata?.mainChat,
        context?.chatMetadata?.chat_name,
        context?.chatMetadata?.name,
    ];
    for (const candidate of stableChatCandidates) {
        const value = String(candidate ?? '').trim();
        if (value && !stableChatParts.includes(value)) {
            stableChatParts.push(value);
        }
    }

    const scopeParts = [];
    const scopeCandidates = [
        context?.groupId,
        context?.group_id,
        context?.characterId,
        context?.character_id,
    ];
    for (const candidate of scopeCandidates) {
        const value = String(candidate ?? '').trim();
        if (value && !scopeParts.includes(value)) {
            scopeParts.push(value);
        }
    }

    const charaFile = String(getCharaFilename?.() || '').trim();
    if (charaFile && !scopeParts.includes(charaFile)) {
        scopeParts.push(charaFile);
    }

    if (stableChatParts.length) {
        return `chat:${[...scopeParts, ...stableChatParts].join('|')}`;
    }

    const weakNameCandidates = [
        context?.chatMetadata?.chat_name,
        context?.chatMetadata?.name,
    ];
    const weakParts = [];
    for (const candidate of weakNameCandidates) {
        const value = String(candidate ?? '').trim();
        if (value && !weakParts.includes(value)) {
            weakParts.push(value);
        }
    }
    if (weakParts.length) {
        return `chat:weak:${[...scopeParts, ...weakParts].join('|')}`;
    }

    const chat = Array.isArray(context?.chat) ? context.chat : [];
    if (chat.length) {
        const fingerprint = chat
            .slice(0, 6)
            .map(item => `${item?.is_user ? 'u' : 'a'}:${item?.name || ''}:${item?.mes || item?.text || ''}`)
            .join('\n');
        if (fingerprint.trim()) {
            return `chat:fallback:${hashString(`${scopeParts.join('|')}|${fingerprint}`)}`;
        }
    }

    return 'chat:default';
}

function cloneMemoryGraph(graph) {
    try {
        return JSON.parse(JSON.stringify(graph || getDefaultMemoryGraph()));
    } catch {
        return getDefaultMemoryGraph();
    }
}

function normalizeMemoryStateDefinition(definition, index = 0) {
    const rawLabel = String(definition?.label || definition?.name || '').trim();
    const rawInstruction = String(definition?.instruction || definition?.desc || definition?.description || '').trim();
    const label = truncateText(rawLabel || `自定义字段${index + 1}`, 40);
    const keyBase = String(definition?.key || createMemoryId(rawLabel || rawInstruction || `custom_state_${index + 1}`, 'custom_state')).trim();
    const key = keyBase.startsWith('custom_') ? keyBase : `custom_${keyBase}`;
    return {
        key,
        label,
        instruction: truncateText(rawInstruction, 140),
    };
}

function getCustomMemoryStateDefinitions(graph) {
    return (Array.isArray(graph?.stateDefinitions) ? graph.stateDefinitions : [])
        .map((definition, index) => normalizeMemoryStateDefinition(definition, index))
        .filter((definition, index, array) => definition.label && array.findIndex(item => item.key === definition.key) === index);
}

function getChatMemoryFirstMessage(context = getContext()) {
    const chat = Array.isArray(context?.chat) ? context.chat : [];
    const first = chat[0];
    return first && typeof first === 'object' ? first : null;
}

function normalizeChatMemoryContainer(container) {
    const normalized = container && typeof container === 'object' && !Array.isArray(container)
        ? { ...container }
        : {};
    normalized.version = Number(normalized.version || 1);
    normalized.graph = cloneMemoryGraph(normalized.graph || getDefaultMemoryGraph());
    normalized.graph.stateDefinitions = getCustomMemoryStateDefinitions(normalized.graph);
    normalized.graph.state = {
        ...getDefaultMemoryGraph().state,
        ...(normalized.graph.state && typeof normalized.graph.state === 'object' ? normalized.graph.state : {}),
    };
    normalized.graph.state.custom_values = normalized.graph.state.custom_values && typeof normalized.graph.state.custom_values === 'object'
        ? { ...normalized.graph.state.custom_values }
        : {};
    normalized.graphBackup = normalized.graphBackup && typeof normalized.graphBackup === 'object'
        ? cloneMemoryGraph(normalized.graphBackup)
        : null;
    normalized.chatKey = String(normalized.chatKey || '');
    normalized.lastAutoMessageCount = clampNumber(normalized.lastAutoMessageCount, 0, 0, 1000000);
    normalized.status = String(normalized.status || '');
    normalized.lastTurnSignature = String(normalized.lastTurnSignature || '');
    normalized.lastPrompt = String(normalized.lastPrompt || '');
    normalized.lastRaw = String(normalized.lastRaw || '');
    normalized.lastError = String(normalized.lastError || '');
    return normalized;
}

function getChatMemoryContainer(context = getContext()) {
    const currentChatKey = getCurrentChatMemoryKey(context);
    const storedContainer = settings.memoryContainersByChat?.[currentChatKey];
    if (storedContainer && typeof storedContainer === 'object' && !Array.isArray(storedContainer)) {
        const normalizedStored = normalizeChatMemoryContainer(storedContainer);
        normalizedStored.chatKey = currentChatKey;
        memoryScopeDebugLog('getChatMemoryContainer from settings map', {
            chatKey: currentChatKey,
            graph: getMemoryGraphSummary(normalizedStored.graph),
        }, context);
        return normalizedStored;
    }

    const first = getChatMemoryFirstMessage(context);
    if (!first) {
        memoryScopeDebugLog('getChatMemoryContainer no first message', {}, context);
        const empty = normalizeChatMemoryContainer(null);
        empty.chatKey = currentChatKey;
        return empty;
    }

    const raw = first[CHAT_MEMORY_FIELD];
    const parsed = typeof raw === 'string'
        ? (() => {
            try {
                return JSON.parse(raw);
            } catch {
                return null;
            }
        })()
        : raw;

    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const normalized = normalizeChatMemoryContainer(parsed);
        if (normalized.chatKey && normalized.chatKey !== currentChatKey) {
            memoryScopeDebugLog('getChatMemoryContainer ignored mismatched chatKey', {
                storedChatKey: normalized.chatKey,
                currentChatKey,
                graph: getMemoryGraphSummary(normalized.graph),
            }, context);
            const empty = normalizeChatMemoryContainer(null);
            empty.chatKey = currentChatKey;
            return empty;
        }
        if (!normalized.chatKey && (normalized.graph?.nodes?.length || normalized.graph?.links?.length || hasMemoryState(normalized.graph))) {
            const legacySignature = hashString(JSON.stringify(getMemoryGraphSummary(normalized.graph)));
            const legacyOwnerKey = settings.memoryLegacyGraphChatKeys?.[legacySignature];
            if (legacyOwnerKey && legacyOwnerKey !== currentChatKey) {
                memoryScopeDebugLog('getChatMemoryContainer ignored legacy graph claimed by another chat', {
                    legacyOwnerKey,
                    currentChatKey,
                    graph: getMemoryGraphSummary(normalized.graph),
                }, context);
                const empty = normalizeChatMemoryContainer(null);
                empty.chatKey = currentChatKey;
                return empty;
            }
            settings.memoryLegacyGraphChatKeys[legacySignature] = currentChatKey;
        }
        normalized.chatKey = currentChatKey;
        settings.memoryContainersByChat[currentChatKey] = normalized;
        Object.assign(extension_settings[MODULE_NAME], settings);
        saveSettingsDebounced();
        memoryScopeDebugLog('getChatMemoryContainer from chat[0]', {
            rawType: typeof raw,
            chatKey: normalized.chatKey,
            graph: getMemoryGraphSummary(normalized.graph),
        }, context);
        return normalized;
    }

    memoryScopeDebugLog('getChatMemoryContainer empty/default', {
        rawType: raw === undefined ? 'undefined' : typeof raw,
        rawPreview: typeof raw === 'string' ? raw.slice(0, 180) : JSON.stringify(raw || null).slice(0, 180),
    }, context);
    const empty = normalizeChatMemoryContainer(null);
    empty.chatKey = currentChatKey;
    return empty;
}

function persistChatMemoryContainer(container, context = getContext()) {
    const chatKey = getCurrentChatMemoryKey(context);
    const normalized = normalizeChatMemoryContainer(container);
    normalized.chatKey = chatKey;
    settings.memoryContainersByChat[chatKey] = normalized;
    Object.assign(extension_settings[MODULE_NAME], settings);
    saveSettingsDebounced();

    const first = getChatMemoryFirstMessage(context);
    if (!first) {
        memoryScopeDebugLog('persistChatMemoryContainer skipped no first message', {}, context);
        return;
    }

    first[CHAT_MEMORY_FIELD] = normalized;
    memoryScopeDebugLog('persistChatMemoryContainer wrote chat[0]', {
        chatKey: normalized.chatKey,
        graph: getMemoryGraphSummary(first[CHAT_MEMORY_FIELD]?.graph),
        hasSaveChat: typeof context?.saveChat === 'function',
    }, context);
    if (typeof context?.saveChat === 'function') {
        Promise.resolve(context.saveChat()).catch((error) => {
            console.warn(`${LOG_PREFIX} Failed to save chat memory container`, error);
        });
    }
}

function getPerChatMemoryValue(storeName, fallbackValue, context = getContext()) {
    const container = getChatMemoryContainer(context);
    const fieldMap = {
        memoryStatusesByChat: 'status',
        memoryLastTurnSignaturesByChat: 'lastTurnSignature',
        memoryLastPromptsByChat: 'lastPrompt',
        memoryLastRawByChat: 'lastRaw',
        memoryLastErrorsByChat: 'lastError',
    };
    const field = fieldMap[storeName];
    if (!field) {
        return fallbackValue;
    }
    return container[field] ?? fallbackValue;
}

function setPerChatMemoryValue(storeName, value, context = getContext()) {
    const fieldMap = {
        memoryStatusesByChat: 'status',
        memoryLastTurnSignaturesByChat: 'lastTurnSignature',
        memoryLastPromptsByChat: 'lastPrompt',
        memoryLastRawByChat: 'lastRaw',
        memoryLastErrorsByChat: 'lastError',
    };
    const field = fieldMap[storeName];
    if (!field) {
        return;
    }
    const container = getChatMemoryContainer(context);
    container[field] = value;
    persistChatMemoryContainer(container, context);
}

function getCurrentMemoryStatus(context = getContext()) {
    return String(getPerChatMemoryValue('memoryStatusesByChat', settings.memoryStatus || '', context) || '');
}

function setCurrentMemoryStatus(text, context = getContext()) {
    setPerChatMemoryValue('memoryStatusesByChat', String(text || ''), context);
}

function getCurrentMemoryLastTurnSignature(context = getContext()) {
    return String(getPerChatMemoryValue('memoryLastTurnSignaturesByChat', settings.memoryLastTurnSignature || '', context) || '');
}

function setCurrentMemoryLastTurnSignature(value, context = getContext()) {
    setPerChatMemoryValue('memoryLastTurnSignaturesByChat', String(value || ''), context);
}

function getCurrentMemoryLastPrompt(context = getContext()) {
    return String(getPerChatMemoryValue('memoryLastPromptsByChat', settings.memoryLastPrompt || '', context) || '');
}

function setCurrentMemoryLastPrompt(value, context = getContext()) {
    setPerChatMemoryValue('memoryLastPromptsByChat', String(value || ''), context);
}

function getCurrentMemoryLastRaw(context = getContext()) {
    return String(getPerChatMemoryValue('memoryLastRawByChat', settings.memoryLastRaw || '', context) || '');
}

function setCurrentMemoryLastRaw(value, context = getContext()) {
    setPerChatMemoryValue('memoryLastRawByChat', String(value || ''), context);
}

function getCurrentMemoryLastError(context = getContext()) {
    return String(getPerChatMemoryValue('memoryLastErrorsByChat', settings.memoryLastError || '', context) || '');
}

function setCurrentMemoryLastError(value, context = getContext()) {
    setPerChatMemoryValue('memoryLastErrorsByChat', String(value || ''), context);
}

function getMemoryGraph(context = getContext()) {
    const container = getChatMemoryContainer(context);
    const graph = container.graph || getDefaultMemoryGraph();
    graph.version = Number(graph.version || 1);
    graph.state = {
        ...getDefaultMemoryGraph().state,
        ...(graph.state && typeof graph.state === 'object' ? graph.state : {}),
    };
    graph.state.custom_values = graph.state.custom_values && typeof graph.state.custom_values === 'object'
        ? { ...graph.state.custom_values }
        : {};
    graph.state.active_topics = uniqueStrings(Array.isArray(graph.state.active_topics) ? graph.state.active_topics : []);
    graph.state.open_questions = uniqueStrings(Array.isArray(graph.state.open_questions) ? graph.state.open_questions : []);
    graph.stateDefinitions = getCustomMemoryStateDefinitions(graph);
    graph.nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
    graph.links = Array.isArray(graph.links) ? graph.links : [];
    graph.lastSummary = String(graph.lastSummary || '');
    graph.updatedAt = String(graph.updatedAt || '');
    return graph;
}

function saveMemoryGraph(graph = getMemoryGraph(), context = getContext(), skipRender = false) {
    const container = getChatMemoryContainer(context);
    container.graph = graph;
    persistChatMemoryContainer(container, context);
    settings.memoryGraph = graph;
    Object.assign(extension_settings[MODULE_NAME], settings);
    saveSettingsDebounced();
    if (!skipRender) {
        renderMemoryPanel();
    }
}

function setMemoryStatus(text, context = getContext()) {
    settings.memoryStatus = String(text || '');
    setCurrentMemoryStatus(text, context);
    $('#ai_wbr_memory_status').text(getCurrentMemoryStatus(context));
}

function createMemoryId(title, fallback = 'memory') {
    const base = String(title || fallback)
        .trim()
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, '_')
        .replace(/^_+|_+$/gu, '')
        .slice(0, 42);
    return base || `${fallback}_${Date.now().toString(36)}`;
}

function normalizeMemoryNode(rawNode, fallbackIndex = 0) {
    const title = truncateText(rawNode?.title || rawNode?.label || rawNode?.id || `记忆 ${fallbackIndex + 1}`, 80);
    return {
        id: createMemoryId(rawNode?.id || title, `node_${fallbackIndex + 1}`),
        title,
        type: truncateText(rawNode?.type || 'event', 32),
        content: truncateText(rawNode?.content || rawNode?.description || '', 1200),
        summary: truncateText(rawNode?.summary || title, 120),
        location: truncateText(rawNode?.location || rawNode?.scene || '', 120),
        timeSpan: truncateText(rawNode?.timeSpan || rawNode?.time_span || rawNode?.time || '', 120),
        keys: uniqueStrings(Array.isArray(rawNode?.keys)
            ? rawNode.keys
            : String(rawNode?.keys || '').split(/[,\n，、]+/u)),
        tags: uniqueStrings(Array.isArray(rawNode?.tags)
            ? rawNode.tags
            : String(rawNode?.tags || '').split(/[,\n，、]+/u)),
        importance: clampNumber(rawNode?.importance, 0.6, 0, 1),
        credibility: clampNumber(rawNode?.credibility, 0.8, 0, 1),
        updatedAt: new Date().toISOString(),
    };
}

function normalizeMemoryLink(rawLink, nodeIds, fallbackIndex = 0) {
    const source = createMemoryId(rawLink?.source || rawLink?.sourceId || rawLink?.from || '');
    const target = createMemoryId(rawLink?.target || rawLink?.targetId || rawLink?.to || '');
    if (!source || !target || source === target || !nodeIds.has(source) || !nodeIds.has(target)) {
        return null;
    }

    const type = String(rawLink?.type || rawLink?.label || 'RELATED').trim().toUpperCase();
    return {
        id: truncateText(rawLink?.id || `${source}_${type}_${target}_${fallbackIndex}`, 120),
        source,
        target,
        type: MEMORY_LINK_TYPES.has(type) ? type : 'RELATED',
        weight: clampNumber(rawLink?.weight, 0.7, 0, 1),
        description: truncateText(rawLink?.description || rawLink?.reason || '', 480),
        updatedAt: new Date().toISOString(),
    };
}

function getRecentMessagesByCount(chat, count) {
    const limit = clampNumber(count, 6, 2, 40);
    return chat
        .filter(message => message && !message.is_system && message.mes)
        .slice(-limit)
        .map(message => ({
            name: message.name || '',
            text: message.is_user ? extractActualUserInput(message.mes) : String(message.mes || ''),
            isUser: !!message.is_user,
        }));
}

function sanitizeMemoryMessageText(value) {
    return String(value ?? '')
        .replace(/\[本轮相关世界书\][\s\S]*?\[\/本轮相关世界书\]/gu, ' ')
        .replace(/<draft_notes>[\s\S]*?<\/draft_notes>/giu, ' ')
        .replace(/<ai_last_output>[\s\S]*?<\/ai_last_output>/giu, ' ')
        .replace(/<\/?peip>/giu, ' ')
        .replace(/\r/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/[ \t]{2,}/g, ' ')
        .trim();
}

function getMemoryRelevantMessages(chat, count) {
    return getRecentMessagesByCount(chat, count)
        .map(message => ({
            ...message,
            text: sanitizeMemoryMessageText(message.text),
        }))
        .filter(message => message.text);
}

function getMemoryAutoRunMessageCount(context = getContext()) {
    const chat = Array.isArray(context?.chat) ? context.chat : [];
    return chat.filter(message => message && !message.is_system && message.mes).length;
}

function getMemoryTurnSignature(recentMessages) {
    return recentMessages
        .slice(-4)
        .map(message => `${message.isUser ? 'U' : 'A'}:${message.name}:${truncateText(message.text, 240)}`)
        .join('\n---\n');
}

function buildMemoryRouterSummary() {
    if (!settings.memoryInjectToRouter) {
        return '';
    }

    const graph = getMemoryGraph();
    const state = graph.state || {};
    const topNodes = [...graph.nodes]
        .sort((a, b) => (Number(b.importance || 0) - Number(a.importance || 0)))
        .slice(0, 8)
        .map(node => `- ${node.title} (${node.type || 'memory'}): ${truncateText(node.content, 160)}`)
        .join('\n');
    const topLinks = graph.links
        .slice(-8)
        .map(link => {
            const source = graph.nodes.find(node => node.id === link.source)?.title || link.source;
            const target = graph.nodes.find(node => node.id === link.target)?.title || link.target;
            return `- ${source} ${link.type || 'RELATED'} ${target}${link.description ? `：${truncateText(link.description, 90)}` : ''}`;
        })
        .join('\n');
    const customStateLines = getCustomMemoryStateDefinitions(graph)
        .map(definition => {
            const value = String(state.custom_values?.[definition.key] || '').trim();
            return value ? `${definition.label}：${value}` : '';
        })
        .filter(Boolean)
        .join('\n');

    const parts = [
        '[轻量记忆状态]',
        state.current_location ? `当前地点：${state.current_location}` : '',
        state.current_objective ? `当前目标：${state.current_objective}` : '',
        state.active_topics?.length ? `活跃主题：${state.active_topics.join('、')}` : '',
        state.open_questions?.length ? `未解问题：${state.open_questions.join('、')}` : '',
        customStateLines,
        graph.lastSummary ? `最近摘要：${truncateText(graph.lastSummary, 420)}` : '',
        topNodes ? `关键记忆节点：\n${topNodes}` : '',
        topLinks ? `关键关系：\n${topLinks}` : '',
        '[/轻量记忆状态]',
    ].filter(Boolean);

    return parts.length > 2 ? truncateText(parts.join('\n'), MAX_MVU_CHARS) : '';
}

function getCombinedStateSummary(context) {
    return [getMvuSummary(context), buildMemoryRouterSummary()].filter(Boolean).join('\n\n');
}

function getMemoryExtractionSchema() {
    return {
        name: 'ai_worldbook_memory_graph_update',
        value: {
            type: 'object',
            additionalProperties: true,
            properties: {
                state: { type: 'object' },
                nodes: { type: 'array', items: { type: 'object' } },
                updates: { type: 'array', items: { type: 'object' } },
                links: { type: 'array', items: { type: 'object' } },
                remove_node_ids: { type: 'array', items: { type: 'string' } },
                remove_link_ids: { type: 'array', items: { type: 'string' } },
                summary: { type: 'string' },
            },
        },
        strict: false,
    };
}

function buildMemoryExtractionPrompt(recentMessages, graph) {
    const recentContext = recentMessages
        .map(message => `${message.name || (message.isUser ? 'User' : 'Assistant')}: ${truncateText(message.text, MAX_MEMORY_CONTEXT_PREVIEW)}`)
        .join('\n\n');
    const currentGraph = truncateText(JSON.stringify({
        state: graph.state,
        stateDefinitions: getCustomMemoryStateDefinitions(graph),
        nodes: graph.nodes.slice(-8).map(node => ({
            id: node.id,
            title: node.title,
            type: node.type,
        })),
        links: graph.links.slice(-12).map(link => ({
            source: link.source,
            target: link.target,
            type: link.type,
        })),
    }, null, 2), 4200);
    const customDefinitions = getCustomMemoryStateDefinitions(graph);
    const customDefinitionLines = customDefinitions.length
        ? customDefinitions.map(definition => `- ${definition.label} (${definition.key})：${definition.instruction || '自定义状态字段'}`).join('\n')
        : '- 无';

    return `<role>你是 SillyTavern 的后置轻量记忆变量块输出器。</role>

<task>
从最近对话里提取“对后续 RP / 剧情推进仍有用”的记忆。
只返回固定变量块。
</task>

<rules>
1. 不要输出 JSON 对象。
2. 不要输出 Markdown。
3. 不要输出解释、分析、reasoning、前后缀。
4. 不要返回 {content:{}}。
5. 只允许输出变量块本体。
6. 如果最近对话存在剧情推进、角色互动、地点变化、任务变化、世界观设定、重要承诺、冲突、发现、战斗、交易、关系变化，memory_nodes_json 必须至少有 1 个节点。
7. 角色扮演场景里，只要互动会影响后续扮演，也要压缩成 event / character / location / quest 节点。
8. 已有同义节点优先写入 memory_updates_json，不要重复造节点。
</rules>

<custom_state_definitions>
${customDefinitionLines}
</custom_state_definitions>

<example>
输入剧情：角色逃跑，被导师用魔法拦住。
正确输出：
[[AIWBR_MEMORY_VARS_BEGIN]]
memory_state_current_location_json="小巷口"
memory_state_current_time_json="夜晚"
memory_state_protagonist_status_json="紧张，试图脱身"
memory_state_current_objective_json="脱身"
memory_state_current_phase_json="冲突升级"
memory_active_topics_json=["逃跑","拦截","导师"]
memory_open_questions_json=["导师会如何处置主角？"]
memory_custom_state_json={}
memory_nodes_json=[{"id":"event_escape_blocked","title":"逃跑被导师拦住","type":"event","content":"主角试图逃跑，被导师用魔法阻断去路。","tags":["冲突"],"importance":0.8,"credibility":0.9}]
memory_updates_json=[]
memory_links_json=[]
memory_remove_node_ids_json=[]
memory_remove_link_ids_json=[]
memory_summary_json="本轮新增了主角逃跑并被导师拦截的关键冲突事件。"
[[AIWBR_MEMORY_VARS_END]]
</example>

<current_graph>
${currentGraph || '{}'}
</current_graph>

<recent_dialogue>
${recentContext || '(空)'}
</recent_dialogue>

<required_output>

[[AIWBR_MEMORY_VARS_BEGIN]]
memory_state_current_location_json=""
memory_state_current_time_json=""
memory_state_protagonist_status_json=""
memory_state_current_objective_json=""
memory_state_current_phase_json=""
memory_active_topics_json=[]
memory_open_questions_json=[]
memory_custom_state_json={}
memory_nodes_json=[]
memory_updates_json=[]
memory_links_json=[]
memory_remove_node_ids_json=[]
memory_remove_link_ids_json=[]
memory_summary_json=""
[[AIWBR_MEMORY_VARS_END]]
</required_output>

<field_rules>
1. 上面所有行必须全部输出，顺序不要变。
2. 每行等号右边必须是合法 JSON 值；字符串用 "...", 数组用 [...]。
3. 如果没有内容，字符串填 ""，数组填 []。
4. memory_custom_state_json 必须是 JSON 对象；key 只能来自 <custom_state_definitions> 中给出的 key，value 为字符串。
5. memory_nodes_json 节点格式：
{"id":"稳定英文或拼音id","title":"简短标题","type":"event|character|location|faction|item|concept|rule|quest","content":"已确认事实","tags":["标签"],"importance":0.6,"credibility":0.8}
6. memory_links_json 关系格式：
{"source":"源节点id或标题","target":"目标节点id或标题","type":"INVOLVES|PART_OF|HAPPENS_AT|FOLLOWS|UPDATES|OPPOSES|ALLIED_WITH|CAUSES|RELATED","weight":0.7,"description":"关系证据"}
7. memory_summary_json 必须概括“为什么值得写入”；只有确实没有长期价值时才允许是 ""。
8. 不要输出任何额外字段。
</field_rules>`;
}

function buildMemoryExtractionRetryPrompt(recentMessages, graph) {
    const compactContext = recentMessages
        .slice(-4)
        .map(message => `${message.name || (message.isUser ? 'User' : 'Assistant')}: ${truncateText(message.text, 280)}`)
        .join('\n\n');

    const compactState = JSON.stringify({
        state: graph.state || {},
        stateDefinitions: getCustomMemoryStateDefinitions(graph),
        node_titles: (graph.nodes || []).slice(-8).map(node => ({ id: node.id, title: node.title, type: node.type })),
    }, null, 2);
    const customDefinitions = getCustomMemoryStateDefinitions(graph);
    const customDefinitionLines = customDefinitions.length
        ? customDefinitions.map(definition => `- ${definition.label} (${definition.key})：${definition.instruction || '自定义状态字段'}`).join('\n')
        : '- 无';

    return `<role>你是后置轻量记忆整理器。</role>
<task>根据最近对话，为长期 RP / 剧情状态输出固定变量块。</task>
<rules>不要思考过程；不要解释；不要空回复；不要 JSON 对象；只输出变量块。</rules>
<custom_state_definitions>${customDefinitionLines}</custom_state_definitions>
<current_graph>${compactState}</current_graph>
<recent_dialogue>${compactContext || '(空)'}</recent_dialogue>
<rule>如果存在剧情推进、角色互动、地点变化、任务变化、设定变化，memory_nodes_json 必须至少有 1 个节点。</rule>
<required_output>
[[AIWBR_MEMORY_VARS_BEGIN]]
memory_state_current_location_json=""
memory_state_current_time_json=""
memory_state_protagonist_status_json=""
memory_state_current_objective_json=""
memory_state_current_phase_json=""
memory_active_topics_json=[]
memory_open_questions_json=[]
memory_custom_state_json={}
memory_nodes_json=[]
memory_updates_json=[]
memory_links_json=[]
memory_remove_node_ids_json=[]
memory_remove_link_ids_json=[]
memory_summary_json=""
[[AIWBR_MEMORY_VARS_END]]
</required_output>`;
}

function getRouterRequestMaxTokens() {
    return clampNumber(settings.routerRequestMaxTokens, defaultSettings.routerRequestMaxTokens, 32, 100000);
}

function getMemoryRequestMaxTokens() {
    return clampNumber(settings.memoryRequestMaxTokens, defaultSettings.memoryRequestMaxTokens, 32, 100000);
}

function parseMemoryUpdate(rawResponse, prompt = '') {
    const parseMemoryVariableBlock = (text) => {
        const raw = String(text || '');
        if (!raw.trim()) {
            return null;
        }

        const blockMatch = raw.match(/\[\[AIWBR_MEMORY_VARS_BEGIN\]\]([\s\S]*?)\[\[AIWBR_MEMORY_VARS_END\]\]/u);
        const body = (blockMatch ? blockMatch[1] : raw).trim();
        if (!body.includes('memory_nodes_json=') && !body.includes('memory_summary_json=')) {
            return null;
        }

        const lines = body
            .split(/\r?\n/u)
            .map(line => line.trim())
            .filter(Boolean);

        const values = {};
        for (const line of lines) {
            const index = line.indexOf('=');
            if (index <= 0) {
                continue;
            }
            const key = line.slice(0, index).trim();
            const valueText = line.slice(index + 1).trim();
            values[key] = valueText;
        }

        const readJsonValue = (key, fallback) => {
            const valueText = values[key];
            if (valueText === undefined) {
                return fallback;
            }
            try {
                return JSON.parse(valueText);
            } catch {
                return fallback;
            }
        };

        return {
            state: {
                current_location: readJsonValue('memory_state_current_location_json', ''),
                current_time: readJsonValue('memory_state_current_time_json', ''),
                protagonist_status: readJsonValue('memory_state_protagonist_status_json', ''),
                current_objective: readJsonValue('memory_state_current_objective_json', ''),
                current_phase: readJsonValue('memory_state_current_phase_json', ''),
                active_topics: readJsonValue('memory_active_topics_json', []),
                open_questions: readJsonValue('memory_open_questions_json', []),
                custom_state: readJsonValue('memory_custom_state_json', {}),
            },
            nodes: readJsonValue('memory_nodes_json', []),
            updates: readJsonValue('memory_updates_json', []),
            links: readJsonValue('memory_links_json', []),
            remove_node_ids: readJsonValue('memory_remove_node_ids_json', []),
            remove_link_ids: readJsonValue('memory_remove_link_ids_json', []),
            summary: readJsonValue('memory_summary_json', ''),
        };
    };

    const looksLikeMemoryPayload = (value) => {
        return value && typeof value === 'object' && !Array.isArray(value) && (
            value.state !== undefined
            || value.nodes !== undefined
            || value.updates !== undefined
            || value.links !== undefined
            || value.summary !== undefined
        );
    };

    if (rawResponse && typeof rawResponse === 'object' && !Array.isArray(rawResponse)) {
        if (looksLikeMemoryPayload(rawResponse)) {
            return rawResponse;
        }

        if (looksLikeMemoryPayload(rawResponse.content)) {
            return rawResponse.content;
        }

        if (looksLikeMemoryPayload(rawResponse.message?.content)) {
            return rawResponse.message.content;
        }

        if (looksLikeMemoryPayload(rawResponse.choices?.[0]?.message?.content)) {
            return rawResponse.choices[0].message.content;
        }
    }

    const texts = collectRouterResponseTexts(rawResponse);
    for (const text of texts) {
        const variableParsed = parseMemoryVariableBlock(text);
        if (variableParsed) {
            return variableParsed;
        }
        const parsed = tryParseSelectionText(text);
        if (parsed && !Array.isArray(parsed)) {
            return parsed;
        }
        const rawText = String(text || '').trim();
        const withoutFence = rawText.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
        const firstBrace = withoutFence.indexOf('{');
        const lastBrace = withoutFence.lastIndexOf('}');
        const candidates = [
            withoutFence,
            firstBrace >= 0 && lastBrace > firstBrace ? withoutFence.slice(firstBrace, lastBrace + 1) : '',
        ].filter(Boolean);
        for (const candidate of candidates) {
            try {
                return JSON.parse(candidate);
            } catch {
                // keep trying
            }
        }
    }

    if (typeof rawResponse === 'string') {
        const variableParsed = parseMemoryVariableBlock(rawResponse);
        if (variableParsed) {
            return variableParsed;
        }
    }

    const error = new Error(`Memory graph JSON parse failed. Preview: ${truncateText(texts.join(' '), 220) || '(empty)'}`);
    error.routerPrompt = prompt;
    error.routerRaw = summarizeRouterResponse(rawResponse);
    throw error;
}

function resolveMemoryNodeId(value, graph) {
    const raw = String(value || '').trim();
    if (!raw) {
        return '';
    }
    const direct = createMemoryId(raw);
    if (graph.nodes.some(node => node.id === direct)) {
        return direct;
    }
    const byTitle = graph.nodes.find(node => normalizeText(node.title) === normalizeText(raw));
    return byTitle?.id || direct;
}

function applyMemoryGraphUpdate(update, context = getContext()) {
    const graph = getMemoryGraph(context);
    const now = new Date().toISOString();
    let addedOrUpdatedNodeCount = 0;
    const touchedEntries = [];

    const state = update?.state && typeof update.state === 'object' ? update.state : {};
    if (typeof state.current_location === 'string') {
        graph.state.current_location = truncateText(state.current_location, 120);
    }
    if (typeof state.current_time === 'string') {
        graph.state.current_time = truncateText(state.current_time, 120);
    }
    if (typeof state.protagonist_status === 'string') {
        graph.state.protagonist_status = truncateText(state.protagonist_status, 180);
    }
    if (typeof state.current_objective === 'string') {
        graph.state.current_objective = truncateText(state.current_objective, 180);
    }
    if (typeof state.current_phase === 'string') {
        graph.state.current_phase = truncateText(state.current_phase, 120);
    }
    if (Array.isArray(state.active_topics)) {
        graph.state.active_topics = uniqueStrings([...state.active_topics]).slice(0, 12);
    }
    if (Array.isArray(state.open_questions)) {
        graph.state.open_questions = uniqueStrings([...state.open_questions]).slice(0, 12);
    }
    if (state.custom_state && typeof state.custom_state === 'object' && !Array.isArray(state.custom_state)) {
        const allowedKeys = new Set(getCustomMemoryStateDefinitions(graph).map(definition => definition.key));
        graph.state.custom_values = graph.state.custom_values && typeof graph.state.custom_values === 'object'
            ? graph.state.custom_values
            : {};
        for (const [key, rawValue] of Object.entries(state.custom_state)) {
            if (!allowedKeys.has(key)) {
                continue;
            }
            graph.state.custom_values[key] = truncateText(String(rawValue || '').trim(), 220);
        }
    }

    const removeNodeIds = new Set((Array.isArray(update?.remove_node_ids) ? update.remove_node_ids : []).map(createMemoryId));
    if (removeNodeIds.size) {
        graph.nodes = graph.nodes.filter(node => !removeNodeIds.has(node.id));
        graph.links = graph.links.filter(link => !removeNodeIds.has(link.source) && !removeNodeIds.has(link.target));
    }

    const byId = new Map(graph.nodes.map(node => [node.id, node]));
    const incomingNodes = Array.isArray(update?.nodes) ? update.nodes : [];
    for (const rawNode of incomingNodes.slice(0, 8)) {
        const node = normalizeMemoryNode(rawNode, byId.size);
        const existing = byId.get(node.id) || graph.nodes.find(item => normalizeText(item.title) === normalizeText(node.title));
        if (existing) {
            Object.assign(existing, {
                ...existing,
                title: node.title || existing.title,
                type: node.type || existing.type,
                content: node.content || existing.content,
                summary: node.summary || existing.summary,
                location: node.location || existing.location,
                timeSpan: node.timeSpan || existing.timeSpan,
                keys: uniqueStrings([...(existing.keys || []), ...(node.keys || [])]),
                tags: uniqueStrings([...(existing.tags || []), ...(node.tags || [])]),
                importance: Math.max(Number(existing.importance || 0), Number(node.importance || 0)),
                credibility: Math.max(Number(existing.credibility || 0), Number(node.credibility || 0)),
                updatedAt: now,
            });
            byId.set(existing.id, existing);
            addedOrUpdatedNodeCount += 1;
            touchedEntries.push(existing);
        } else {
            graph.nodes.push(node);
            byId.set(node.id, node);
            addedOrUpdatedNodeCount += 1;
            touchedEntries.push(node);
        }
    }

    const updates = Array.isArray(update?.updates) ? update.updates : [];
    for (const rawUpdate of updates.slice(0, 8)) {
        const resolvedId = resolveMemoryNodeId(rawUpdate?.id || rawUpdate?.title || rawUpdate?.titleToUpdate, graph);
        const existing = byId.get(resolvedId) || graph.nodes.find(item => normalizeText(item.title) === normalizeText(rawUpdate?.title || rawUpdate?.titleToUpdate || ''));
        if (!existing) {
            continue;
        }
        if (rawUpdate.title) {
            existing.title = truncateText(rawUpdate.title, 80);
        }
        if (rawUpdate.content || rawUpdate.newContent) {
            existing.content = truncateText(rawUpdate.content || rawUpdate.newContent, 1400);
        }
        if (rawUpdate.summary) {
            existing.summary = truncateText(rawUpdate.summary, 120);
        }
        if (rawUpdate.location) {
            existing.location = truncateText(rawUpdate.location, 120);
        }
        if (rawUpdate.timeSpan || rawUpdate.time_span) {
            existing.timeSpan = truncateText(rawUpdate.timeSpan || rawUpdate.time_span, 120);
        }
        if (rawUpdate.keys) {
            existing.keys = uniqueStrings([...(existing.keys || []), ...(Array.isArray(rawUpdate.keys) ? rawUpdate.keys : String(rawUpdate.keys).split(/[,\n，、]+/u))]);
        }
        if (rawUpdate.importance !== undefined) {
            existing.importance = clampNumber(rawUpdate.importance, existing.importance || 0.6, 0, 1);
        }
        if (rawUpdate.credibility !== undefined) {
            existing.credibility = clampNumber(rawUpdate.credibility, existing.credibility || 0.8, 0, 1);
        }
        existing.updatedAt = now;
        addedOrUpdatedNodeCount += 1;
        touchedEntries.push(existing);
    }

    if (!addedOrUpdatedNodeCount && typeof update?.summary === 'string' && update.summary.trim()) {
        const fallbackTitle = truncateText(update.summary.trim().split(/[。.!?\n]/u)[0] || '本轮关键事件', 48);
        const fallbackNode = normalizeMemoryNode({
            id: `event_${Date.now().toString(36)}`,
            title: fallbackTitle,
            type: 'event',
            summary: fallbackTitle,
            content: update.summary.trim(),
            tags: ['自动摘要'],
            importance: 0.55,
            credibility: 0.75,
        }, byId.size);
        graph.nodes.push(fallbackNode);
        byId.set(fallbackNode.id, fallbackNode);
        touchedEntries.push(fallbackNode);
    }

    graph.nodes = graph.nodes
        .sort((a, b) => (Number(b.importance || 0) - Number(a.importance || 0)) || String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
        .slice(0, clampNumber(settings.memoryMaxNodes, 60, 5, 200));

    const nodeIds = new Set(graph.nodes.map(node => node.id));
    const removeLinkIds = new Set((Array.isArray(update?.remove_link_ids) ? update.remove_link_ids : []).map(value => String(value)));
    graph.links = graph.links.filter(link => !removeLinkIds.has(String(link.id)) && nodeIds.has(link.source) && nodeIds.has(link.target));

    const incomingLinks = Array.isArray(update?.links) ? update.links : [];
    const existingLinkKeys = new Set(graph.links.map(link => `${link.source}|${link.type}|${link.target}`));
    for (const rawLink of incomingLinks.slice(0, 12)) {
        const normalized = normalizeMemoryLink({
            ...rawLink,
            source: resolveMemoryNodeId(rawLink?.source || rawLink?.sourceId || rawLink?.from, graph),
            target: resolveMemoryNodeId(rawLink?.target || rawLink?.targetId || rawLink?.to, graph),
        }, nodeIds, graph.links.length);
        if (!normalized) {
            continue;
        }
        const key = `${normalized.source}|${normalized.type}|${normalized.target}`;
        const existing = graph.links.find(link => `${link.source}|${link.type}|${link.target}` === key);
        if (existing) {
            existing.weight = Math.max(Number(existing.weight || 0), Number(normalized.weight || 0));
            existing.description = normalized.description || existing.description;
            existing.updatedAt = now;
            continue;
        }
        if (!existingLinkKeys.has(key)) {
            graph.links.push(normalized);
            existingLinkKeys.add(key);
        }
    }

    graph.links = graph.links
        .filter(link => nodeIds.has(link.source) && nodeIds.has(link.target))
        .slice(-clampNumber(settings.memoryMaxLinks, 120, 0, 400));
    if (typeof update?.summary === 'string' && update.summary.trim()) {
        graph.lastSummary = truncateText(update.summary, 900);
    }
    graph.updatedAt = now;
    saveMemoryGraph(graph, context);
    return {
        graph,
        touchedEntries: uniqueStrings(touchedEntries.map(entry => entry?.id))
            .map(id => graph.nodes.find(node => node.id === id))
            .filter(Boolean),
    };
}

function stopMemoryAnimation(success = true) {
    const underline = $('#ai_wbr_fx_layer .ai-wbr-book-underline');
    if (!underline.length) {
        return;
    }
    if (success) {
        setTimeout(() => underline.remove(), 120);
    } else {
        underline.addClass('ai-wbr-book-underline-error');
        setTimeout(() => underline.remove(), 980);
    }
}

async function runMemoryGraphUpdate(reason = 'auto') {
    if (!settings.memoryEnabled || isMemoryWorkerRunning || isRouterSelectionRequest) {
        return false;
    }

    const context = getContext();
    const memoryRunChatKey = getCurrentChatMemoryKey(context);
    const chat = Array.isArray(context?.chat) ? context.chat : [];
    const recentMessages = getMemoryRelevantMessages(chat, settings.memoryScanMessages);
    if (recentMessages.length < 2) {
        return false;
    }

    const signature = getMemoryTurnSignature(recentMessages);
    if (reason === 'auto' && signature && signature === getCurrentMemoryLastTurnSignature(context)) {
        return false;
    }

    isMemoryWorkerRunning = true;
    startMemoryAnimation();
    setMemoryStatus('记忆整理中...');

    try {
        const graph = getMemoryGraph();
        const prompt = buildMemoryExtractionPrompt(recentMessages, graph);
        setCurrentMemoryLastRaw('', context);
        setCurrentMemoryLastError('', context);
        const maxAttempts = Math.max(1, Number(settings.memoryRetries || 0) + 1);
        const baseSystemPrompt = '你是后置轻量记忆变量块输出器。禁止解释，禁止 reasoning，禁止 Markdown，禁止 JSON 对象；只输出指定变量块。';
        const retrySystemPrompt = '你是变量块输出器。禁止空回复，禁止解释，禁止思考过程，直接输出变量块。';
        let raw = '';
        let lastError = null;

        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
            const useRetryPrompt = attempt > 1;
            const activePrompt = useRetryPrompt ? buildMemoryExtractionRetryPrompt(recentMessages, graph) : prompt;
            const activeSystemPrompt = useRetryPrompt ? retrySystemPrompt : baseSystemPrompt;
            const promptLog = useRetryPrompt
                ? `${prompt}\n\n----- RETRY #${attempt - 1} PROMPT -----\n\n${activePrompt}`
                : prompt;
            setCurrentMemoryLastPrompt(promptLog, context);

            try {
                isRouterSelectionRequest = true;
                raw = await requestMemoryExtraction(context, activePrompt, activeSystemPrompt);
            } catch (error) {
                lastError = error;
                if (isGatewayLikeError(error) || attempt >= maxAttempts) {
                    throw error;
                }
                playStatusBurst('🔄', 'retry');
                continue;
            } finally {
                isRouterSelectionRequest = false;
            }

            setCurrentMemoryLastRaw(summarizeRouterResponse(raw), context);

            if (hasEmptyVisibleContentDueToLength(raw)) {
                lastError = new Error('Memory extraction returned empty visible content due to length.');
                if (attempt >= maxAttempts) {
                    throw lastError;
                }
                playStatusBurst('🔄', 'retry');
                continue;
            }

            try {
                const update = parseMemoryUpdate(raw, promptLog);
                setCurrentMemoryLastError('', context);
                if (getCurrentChatMemoryKey() !== memoryRunChatKey) {
                    debugLog('Discarded memory update because chat changed before completion', {
                        started: memoryRunChatKey,
                        current: getCurrentChatMemoryKey(),
                    });
                    return false;
                }
                
                // Backup graph before applying update
                const container = getChatMemoryContainer(context);
                container.graphBackup = cloneMemoryGraph(graph);
                persistChatMemoryContainer(container, context);
                
                const memoryResult = applyMemoryGraphUpdate(update, context);
                setCurrentMemoryLastTurnSignature(signature, context);
                const updatedContainer = getChatMemoryContainer(context);
                updatedContainer.lastAutoMessageCount = getMemoryAutoRunMessageCount(context);
                persistChatMemoryContainer(updatedContainer, context);
                const nodeCount = memoryResult.graph.nodes.length;
                const linkCount = memoryResult.graph.links.length;
                setMemoryStatus(`已更新：${nodeCount} 节点 / ${linkCount} 关系`);
                if (memoryResult.touchedEntries.length) {
                    playEntryBurst(memoryResult.touchedEntries, {
                        variant: 'memory',
                        labelGetter: getMemoryBurstLabel,
                    });
                } else {
                    playStatusBurst('✦', 'memory');
                }
                stopMemoryAnimation(true);
                return true;
            } catch (error) {
                lastError = error;
                setCurrentMemoryLastError(error?.message || String(error), context);
                if (attempt >= maxAttempts) {
                    throw error;
                }
                playStatusBurst('🔄', 'retry');
            }
        }

        throw lastError || new Error('Memory extraction failed.');
    } catch (error) {
        console.warn(`${LOG_PREFIX} Memory graph update failed`, error);
        setCurrentMemoryLastError(error?.message || String(error), context);
        if (error?.routerRaw && !getCurrentMemoryLastRaw(context)) {
            setCurrentMemoryLastRaw(error.routerRaw, context);
        }
        if (error?.routerPrompt && !getCurrentMemoryLastPrompt(context)) {
            setCurrentMemoryLastPrompt(error.routerPrompt, context);
        }
        setMemoryStatus(`记忆失败：${truncateText(error?.message || error, 80)}`);
        playStatusBurst('×', 'fail');
        stopMemoryAnimation(false);
        return false;
    } finally {
        isMemoryWorkerRunning = false;
        renderMemoryPanel();
    }
}

function scheduleMemoryGraphUpdate() {
    if (!settings.memoryEnabled || !settings.memoryAutoRun) {
        return;
    }

    const context = getContext();
    const interval = clampNumber(settings.memoryAutoRunInterval, defaultSettings.memoryAutoRunInterval, 1, 100);
    const currentCount = getMemoryAutoRunMessageCount(context);
    const lastCount = clampNumber(getChatMemoryContainer(context).lastAutoMessageCount, 0, 0, 1000000);
    if (currentCount - lastCount < interval) {
        debugLog('Memory auto-run skipped by interval', { currentCount, lastCount, interval });
        return;
    }

    clearTimeout(memoryUpdateTimer);
    memoryUpdateTimer = setTimeout(() => {
        runMemoryGraphUpdate('auto');
    }, 900);
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

    const worldName = book.name || character?.name || 'embedded';
    if (!getWorldSelectionState(worldName)) {
        return [];
    }

    const converted = convertCharacterBook(book);
    return worldEntriesFromData(converted, 'character_book', worldName);
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
        if (!getWorldSelectionState(worldName)) {
            debugLog('Skipped unselected worldbook', { worldName, source });
            continue;
        }
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

function buildAiPrompt(recentMessages, mvuSummary, candidates, maxSelectCount = settings.maxSelected) {
    const lastUserMessage = getLastUserMessage(recentMessages);
    const recentContext = recentMessages
        .map(message => `${message.name || (message.isUser ? 'User' : 'Assistant')}: ${truncateText(message.text, MAX_ROUTER_CONTEXT_PREVIEW)}`)
        .join('\n\n');
    const candidateText = candidates.map(entry => {
        const keys = entry.keys.all.length ? entry.keys.all.join(' / ') : '(无 keys)';
        return `- ${keys}`;
    }).join('\n');

    return `<task>
从候选 keys 中选择最多 ${maxSelectCount} 条“本轮真正相关”的条目（世界书或记忆）。
</task>

<rules>
1. 只能从候选 keys 中选。
2. 只输出严格 JSON。
3. 禁止 Markdown、禁止解释、禁止 reasoning、禁止额外字段。
4. 不要返回标题，不要返回 id，只返回命中的 key。
5. 如果没有合适条目，输出 {"selected":[]}。
</rules>

<output_format>
{"selected":[{"key":"命中的 key","reason":"简短原因"}]}
</output_format>

<example>
输入：
最后用户消息：我想偷偷补完魔法阵然后逃跑
候选 keys：
- 魔法 / 魔法阵 / 画魔法
- 奇夫利 / 老师
- 魔法商品 / 魔法器
输出：
{"selected":[{"key":"魔法阵","reason":"用户正在补画魔法阵"},{"key":"奇夫利","reason":"当前互动对象是奇夫利"}]}
</example>

<last_user_message>
${lastUserMessage || '(空)'}
</last_user_message>

<recent_context>
${recentContext || '(空)'}
</recent_context>

<state_summary>
${mvuSummary || '(未启用或未读取到)'}
</state_summary>

<candidate_keys>
${candidateText || '(无)'}
</candidate_keys>`;
}

function buildCompactAiPrompt(recentMessages, mvuSummary, candidates, maxSelectCount = settings.maxSelected) {
    const lastUserMessage = truncateText(getLastUserMessage(recentMessages), 220);
    const compactContext = recentMessages
        .slice(-4)
        .map(message => `${message.name || (message.isUser ? 'User' : 'Assistant')}: ${truncateText(message.text, 180)}`)
        .join('\n');
    const compactSummary = truncateText(String(mvuSummary || ''), 320);
    const candidateText = candidates
        .slice(0, Math.min(candidates.length, 14))
        .map(entry => `- ${(entry.keys.all.length ? entry.keys.all.join(' / ') : '(无 keys)')}`)
        .join('\n');

    return `<task>从候选 keys 中选择最多 ${maxSelectCount} 条本轮相关条目。</task>
<rules>只输出严格 JSON；禁止解释；禁止 reasoning；禁止额外字段；如果没有合适条目，输出 {"selected":[]}。</rules>
<output>{"selected":[{"key":"命中的 key","reason":"简短原因"}]}</output>
<last_user_message>${lastUserMessage || '(空)'}</last_user_message>
<recent_context>${compactContext || '(空)'}</recent_context>
<state_summary>${compactSummary || '(无)'}</state_summary>
<candidate_keys>
${candidateText || '(无)'}
</candidate_keys>`;
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

    const texts = collectRouterResponseTexts(rawResponse)
        .map(text => stripReasoningForDisplay(text))
        .filter(text => String(text || '').trim());
    if (texts.length) {
        return texts.join('\n\n---\n\n');
    }

    try {
        return stripReasoningForDisplay(JSON.stringify(rawResponse, null, 2));
    } catch {
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

function getRouterMessages(prompt, systemPrompt = settings.systemPrompt) {
    return [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt },
    ];
}

function isEffectivelyEmptyStructuredResponse(rawResponse) {
    if (rawResponse == null) {
        return true;
    }

    if (typeof rawResponse === 'string') {
        return !rawResponse.trim();
    }

    if (typeof rawResponse !== 'object') {
        return false;
    }

    const content = rawResponse.content;
    if (content && typeof content === 'object' && !Array.isArray(content) && !Object.keys(content).length) {
        return true;
    }

    const texts = collectRouterResponseTexts(rawResponse);
    if (!texts.length && !Object.keys(rawResponse).length) {
        return true;
    }

    return false;
}

function hasEmptyVisibleContentDueToLength(rawResponse) {
    const choice = rawResponse?.choices?.[0];
    return !!choice
        && choice?.finish_reason === 'length'
        && typeof choice?.message?.content === 'string'
        && !choice.message.content.trim();
}

function isGatewayLikeError(error) {
    if (error?.isGatewayError) {
        return true;
    }
    const text = `${error?.message || ''}\n${String(error || '')}`.toLowerCase();
    return /\b(502|503|504)\b/u.test(text)
        || text.includes('gateway time-out')
        || text.includes('gateway timeout')
        || text.includes('endpoint failed');
}

function buildPlainSeparateChatPayload(prompt, {
    systemPrompt = settings.systemPrompt,
    maxTokens = getRouterRequestMaxTokens(),
} = {}) {
    return {
        stream: false,
        messages: getRouterMessages(prompt, systemPrompt),
        model: settings.routerModel,
        chat_completion_source: 'openai',
        max_tokens: maxTokens,
        temperature: 0,
        reverse_proxy: normalizeUrl(settings.routerApiUrl),
        proxy_password: String(settings.routerApiKey || ''),
    };
}

async function sendPlainSeparateChatRequest(context, payload) {
    const response = await fetch('/api/backends/chat-completions/generate', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...(typeof context.getRequestHeaders === 'function' ? context.getRequestHeaders() : {}),
        },
        cache: 'no-cache',
        body: JSON.stringify(payload),
    });

    const text = await response.text();
    if (!response.ok) {
        let errorMessage = text;
        try {
            const parsed = JSON.parse(text);
            errorMessage = parsed?.error?.message || parsed?.message || text;
        } catch {
            errorMessage = text.slice(0, 180);
        }
        const error = new Error(`Endpoint failed (${response.status}): ${errorMessage}`);
        error.status = response.status;
        error.isGatewayError = [502, 503, 504].includes(response.status);
        throw error;
    }

    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}

async function sendSeparateRouterRequest(context, prompt, {
    recentMessages = [],
    mvuSummary = '',
    candidates = [],
    systemPrompt = settings.systemPrompt,
    maxTokens = getRouterRequestMaxTokens(),
    maxSelectCount = settings.maxSelected,
} = {}) {
    const firstRequest = buildPlainSeparateChatPayload(prompt, {
        systemPrompt,
        maxTokens,
    });
    let raw = await sendPlainSeparateChatRequest(context, firstRequest);
    if (!isEffectivelyEmptyStructuredResponse(raw) && !hasEmptyVisibleContentDueToLength(raw)) {
        return { raw, usedRetry: false, usedCompactPrompt: false };
    }

    const compactPrompt = buildCompactAiPrompt(
        recentMessages,
        mvuSummary,
        candidates,
        maxSelectCount
    );
    const retryRequest = buildPlainSeparateChatPayload(compactPrompt, {
        systemPrompt: '你是前置世界书路由 JSON 输出器。禁止解释，禁止 reasoning，只输出 {"selected":[...]}。',
        maxTokens: getRouterRequestMaxTokens(),
    });
    raw = await sendPlainSeparateChatRequest(context, retryRequest);
    return { raw, usedRetry: true, usedCompactPrompt: true, retryPrompt: compactPrompt };
}

async function sendSeparateMemoryRequest(context, prompt, {
    systemPrompt,
    maxTokens = getMemoryRequestMaxTokens(),
} = {}) {
    const requestData = buildPlainSeparateChatPayload(prompt, {
        systemPrompt,
        maxTokens,
    });
    return await sendPlainSeparateChatRequest(context, requestData);
}

function getRouterRequestData(context, prompt) {
    return buildPlainSeparateChatPayload(prompt, {
        systemPrompt: settings.systemPrompt,
        maxTokens: getRouterRequestMaxTokens(),
    });
}

async function selectWithSeparateRouterModel(context, recentMessages, mvuSummary, candidates, maxSelectCount = settings.maxSelected) {
    const prompt = buildAiPrompt(recentMessages, mvuSummary, candidates, maxSelectCount);
    const result = await sendSeparateRouterRequest(context, prompt, {
        recentMessages,
        mvuSummary,
        candidates,
        systemPrompt: settings.systemPrompt,
        maxTokens: getRouterRequestMaxTokens(),
        maxSelectCount,
    });
    const promptForParse = result.usedCompactPrompt ? `${prompt}\n\n----- COMPACT RETRY PROMPT -----\n\n${result.retryPrompt}` : prompt;
    const parsed = parseSelectionJson(result.raw, candidates, promptForParse);
    return {
        parsed,
        prompt: promptForParse,
        rawPreview: summarizeRouterResponse(result.raw),
    };
}

async function runSingleAiSelectionAttempt(context, recentMessages, mvuSummary, candidates, maxSelectCount = settings.maxSelected) {
    let parsed;
    let prompt = '';
    let rawPreview = '';
    if (settings.routerUseSeparateModel && settings.routerApiUrl && settings.routerApiKey && settings.routerModel) {
        const result = await selectWithSeparateRouterModel(context, recentMessages, mvuSummary, candidates, maxSelectCount);
        parsed = result.parsed;
        prompt = result.prompt;
        rawPreview = result.rawPreview;
    } else {
        prompt = buildAiPrompt(recentMessages, mvuSummary, candidates, maxSelectCount);
        const raw = await context.generateRaw({
            prompt,
            systemPrompt: settings.systemPrompt,
            responseLength: getRouterRequestMaxTokens(),
            trimNames: false,
            jsonSchema: getSelectionSchema(),
        });
        parsed = parseSelectionJson(raw, candidates, prompt);
        rawPreview = summarizeRouterResponse(raw);
    }

    return { parsed, prompt, rawPreview };
}

async function selectWithAi(context, recentMessages, mvuSummary, candidates, maxSelectCount = settings.maxSelected) {
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
            const result = await runSingleAiSelectionAttempt(context, recentMessages, mvuSummary, candidates, maxSelectCount);
            parsed = result.parsed;
            prompt = result.prompt;
            rawPreview = result.rawPreview;
            break;
        } catch (error) {
            lastError = error;
            prompt = error?.routerPrompt || prompt || '';
            rawPreview = error?.routerRaw || rawPreview || error?.message || String(error);
            debugLog(`Router attempt ${attempt}/${maxAttempts} failed`, error);

            if (!isGatewayLikeError(error) && attempt < maxAttempts) {
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

        if (selected.length >= maxSelectCount) {
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

function hasMemoryState(graph) {
    const state = graph?.state || {};
    const customValues = state.custom_values && typeof state.custom_values === 'object' ? state.custom_values : {};
    return !!(
        String(state.current_location || '').trim()
        || String(state.current_time || '').trim()
        || String(state.protagonist_status || '').trim()
        || String(state.current_objective || '').trim()
        || String(state.current_phase || '').trim()
        || (Array.isArray(state.active_topics) && state.active_topics.length)
        || (Array.isArray(state.open_questions) && state.open_questions.length)
        || Object.values(customValues).some(value => String(value || '').trim())
    );
}

function collectMemoryKeywords(node) {
    const keys = [];
    const push = (value) => {
        const text = String(value || '').trim();
        if (text) {
            keys.push(text);
        }
    };

    push(node.id);
    push(node.title);
    push(node.summary);
    push(node.location);
    push(node.timeSpan);
    for (const key of Array.isArray(node.keys) ? node.keys : []) {
        push(key);
    }
    for (const tag of Array.isArray(node.tags) ? node.tags : []) {
        push(tag);
    }

    const snippets = String(node.content || '')
        .split(/[，,。.!?\n；;：:]/u)
        .map(part => part.trim())
        .filter(part => part.length >= 2 && part.length <= 18)
        .slice(0, 8);
    for (const snippet of snippets) {
        push(snippet);
    }

    return uniqueStrings(keys);
}

function buildMemoryCandidates(graph) {
    const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
    return nodes.map((node, index) => {
        const allKeys = collectMemoryKeywords(node);
        return {
            routerId: `memory:${node.id}`,
            uid: node.id,
            source: 'memory',
            world: 'memory',
            comment: node.title || `记忆 ${index + 1}`,
            content: node.content || node.title || '',
            order: index,
            constant: false,
            disable: false,
            keys: {
                primary: uniqueStrings([node.title, ...(Array.isArray(node.tags) ? node.tags.slice(0, 2) : [])].filter(Boolean)),
                secondary: uniqueStrings(allKeys.slice(1)),
                all: allKeys,
            },
            memoryType: String(node.type || 'event'),
            nodeRef: node,
        };
    });
}

function isMemoryEventType(type) {
    return ['event', 'quest'].includes(String(type || '').toLowerCase());
}

function getMemoryEventNodes(graph) {
    return (Array.isArray(graph?.nodes) ? graph.nodes : [])
        .filter(node => isMemoryEventType(node.type))
        .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

function getMemoryNonEventNodes(graph) {
    return (Array.isArray(graph?.nodes) ? graph.nodes : [])
        .filter(node => !isMemoryEventType(node.type))
        .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

function getMemoryStateRows(graph) {
    const state = graph?.state || {};
    const rows = [
        { key: 'current_location', label: '当前地点', value: state.current_location || '' },
        { key: 'current_time', label: '当前时间', value: state.current_time || '' },
        { key: 'protagonist_status', label: '主角状态', value: state.protagonist_status || '' },
        { key: 'current_objective', label: '当前目标', value: state.current_objective || '' },
        { key: 'current_phase', label: '当前阶段', value: state.current_phase || '' },
        { key: 'active_topics', label: '活跃主题', value: (state.active_topics || []).join('，') },
        { key: 'open_questions', label: '未解问题', value: (state.open_questions || []).join('；') },
    ];
    const customValues = state.custom_values && typeof state.custom_values === 'object' ? state.custom_values : {};
    for (const definition of getCustomMemoryStateDefinitions(graph)) {
        rows.push({
            key: definition.key,
            label: definition.label,
            description: definition.instruction,
            value: String(customValues[definition.key] || ''),
            isCustom: true,
        });
    }
    return rows;
}

function recallMemoryCandidates(graph, recentMessages, mvuSummary) {
    const candidates = recallCandidates(buildMemoryCandidates(graph), recentMessages, mvuSummary)
        .filter(entry => entry.score > 0 || ['event', 'quest', 'character', 'location'].includes(entry.memoryType));

    return candidates
        .sort((a, b) => (b.score - a.score) || String(b.nodeRef?.updatedAt || '').localeCompare(String(a.nodeRef?.updatedAt || '')))
        .slice(0, MAX_MEMORY_SELECTED + 4);
}

function selectMemoryWithFallback(candidates) {
    return candidates.slice(0, MAX_MEMORY_SELECTED).map(entry => ({
        ...entry,
        reason: entry.matchedKeys?.length
            ? `记忆关键词命中：${entry.matchedKeys.join(', ')}`
            : `近期记忆 fallback：${entry.score}`,
    }));
}

function buildMemoryInjection(graph, selectedMemories) {
    const state = graph?.state || {};
    const hasState = hasMemoryState(graph);
    const memoryItems = Array.isArray(selectedMemories) ? selectedMemories : [];
    if (!hasState && !memoryItems.length) {
        return '';
    }

    const parts = ['[本轮相关记忆]\n以下内容来自当前聊天的动态记忆，仅用于本轮回复保持剧情连续性。\n'];

    if (String(state.current_location || '').trim()) {
        parts.push(`\n当前地点：${state.current_location.trim()}\n`);
    }
    if (String(state.current_time || '').trim()) {
        parts.push(`当前时间：${state.current_time.trim()}\n`);
    }
    if (String(state.protagonist_status || '').trim()) {
        parts.push(`主角状态：${state.protagonist_status.trim()}\n`);
    }
    if (String(state.current_objective || '').trim()) {
        parts.push(`当前目标：${state.current_objective.trim()}\n`);
    }
    if (String(state.current_phase || '').trim()) {
        parts.push(`当前阶段：${state.current_phase.trim()}\n`);
    }
    if (Array.isArray(state.active_topics) && state.active_topics.length) {
        parts.push(`活跃主题：${state.active_topics.join('、')}\n`);
    }
    if (Array.isArray(state.open_questions) && state.open_questions.length) {
        parts.push('未解问题：\n');
        for (const question of state.open_questions.slice(0, 6)) {
            parts.push(`- ${question}\n`);
        }
    }
    for (const definition of getCustomMemoryStateDefinitions(graph)) {
        const value = String(state.custom_values?.[definition.key] || '').trim();
        if (!value) {
            continue;
        }
        parts.push(`${definition.label}：${value}\n`);
    }

    if (memoryItems.length) {
        parts.push('\n近期相关记忆：\n');
        for (const entry of memoryItems) {
            const node = entry.nodeRef || {};
            const prefix = [node.timeSpan, node.location].filter(Boolean).join(' | ');
            parts.push(`- ${entry.comment || node.title || entry.uid}${prefix ? ` [${prefix}]` : ''}：${truncateText(node.summary || node.content || entry.content || '', 220)}\n`);
        }
    }

    parts.push('[/本轮相关记忆]');
    return parts.join('');
}

function buildInjection(selectedEntries, memoryGraph = null, selectedMemories = []) {
    const worldbookBlock = (() => {
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
    })();

    const memoryBlock = buildMemoryInjection(memoryGraph || getMemoryGraph(), selectedMemories);
    if (!worldbookBlock && !memoryBlock) {
        return '';
    }
    return [worldbookBlock, memoryBlock].filter(Boolean).join('\n\n');
}

function renderDebugPanel() {
    const candidates = Array.isArray(lastRun?.candidates) ? lastRun.candidates : [];
    const selected = Array.isArray(lastRun?.selected) ? lastRun.selected : [];
    const memoryCandidates = Array.isArray(lastRun?.memoryCandidates) ? lastRun.memoryCandidates : [];
    const selectedMemories = Array.isArray(lastRun?.selectedMemories) ? lastRun.selectedMemories : [];
    const summary = lastRun.error
        ? `失败：${lastRun.error}`
        : `世界书候选 ${candidates.length} 条，选择 ${selected.length} 条；记忆候选 ${memoryCandidates.length} 条，选择 ${selectedMemories.length} 条；注入 ${lastRun.injectedChars} 字符，来源：${lastRun.source}`;
    $('#ai_wbr_last_summary').text(summary);

    const worldbookItems = selected.map(entry => {
        const title = entry.comment || entry.keys?.primary?.[0] || entry.uid;
        const keys = entry.matchedKeys?.length ? ` | keys: ${entry.matchedKeys.join(', ')}` : '';
        return $('<div class="ai-wbr-last-item"></div>')
            .append($('<div></div>').text(`${title} (${entry.world || entry.source}#${entry.uid})`))
            .append($('<small></small>').text(`${entry.reason || ''}${keys}`));
    });

    const memoryItems = selectedMemories.map(entry => {
        const title = entry.comment || entry.uid;
        const keys = entry.matchedKeys?.length ? ` | keys: ${entry.matchedKeys.join(', ')}` : '';
        return $('<div class="ai-wbr-last-item"></div>')
            .append($('<div></div>').text(`[记忆] ${title} (${entry.memoryType || 'memory'}#${entry.uid})`))
            .append($('<small></small>').text(`${entry.reason || ''}${keys}`));
    });

    $('#ai_wbr_last_items').empty().append([...worldbookItems, ...memoryItems]);
    $('#ai_wbr_injection_text').text(lastRun.injectionText || '尚无本轮注入记录');
    $('#ai_wbr_router_prompt').text(lastRun.routerPrompt || '尚无前置 AI Prompt 记录');
    $('#ai_wbr_router_raw').text(lastRun.routerRaw || '尚无前置 AI 返回记录');
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function escapeCssSelector(value) {
    const text = String(value ?? '');
    if (globalThis.CSS?.escape) {
        return CSS.escape(text);
    }

    return text.replace(/["\\]/g, '\\$&');
}

function doMemoryNodesOverlap(a, b, gap = 18) {
    return Math.abs((Number(a.x || 0) + (MEMORY_GRAPH_NODE_WIDTH / 2)) - (Number(b.x || 0) + (MEMORY_GRAPH_NODE_WIDTH / 2))) < MEMORY_GRAPH_NODE_WIDTH + gap
        && Math.abs((Number(a.y || 0) + (MEMORY_GRAPH_NODE_HEIGHT / 2)) - (Number(b.y || 0) + (MEMORY_GRAPH_NODE_HEIGHT / 2))) < MEMORY_GRAPH_NODE_HEIGHT + gap;
}

function shouldAutoArrangeMemoryNodes(nodes) {
    for (let i = 0; i < nodes.length; i += 1) {
        const a = nodes[i];
        if (!Number.isFinite(Number(a.x)) || !Number.isFinite(Number(a.y))) {
            return true;
        }
        for (let j = i + 1; j < nodes.length; j += 1) {
            if (doMemoryNodesOverlap(a, nodes[j])) {
                return true;
            }
        }
    }
    return false;
}

function getMemoryGraphArrangeMetrics(nodeCount, canvasWidth = MEMORY_GRAPH_CANVAS_WIDTH) {
    const cellWidth = MEMORY_GRAPH_NODE_WIDTH + MEMORY_GRAPH_NODE_HORIZONTAL_GAP;
    const cellHeight = MEMORY_GRAPH_NODE_HEIGHT + MEMORY_GRAPH_NODE_VERTICAL_GAP;
    const columns = Math.max(1, Math.floor((canvasWidth - (MEMORY_GRAPH_SAFE_PADDING * 2)) / cellWidth));
    const rows = Math.max(1, Math.ceil(Math.max(1, nodeCount) / columns));
    const requiredHeight = MEMORY_GRAPH_TOP_SAFE_PADDING
        + (rows * MEMORY_GRAPH_NODE_HEIGHT)
        + ((rows - 1) * MEMORY_GRAPH_NODE_VERTICAL_GAP)
        + MEMORY_GRAPH_SAFE_PADDING;
    return { cellWidth, cellHeight, columns, rows, requiredHeight };
}

function arrangeMemoryGraphNodes(nodes, canvasWidth = MEMORY_GRAPH_CANVAS_WIDTH, canvasHeight = MEMORY_GRAPH_CANVAS_HEIGHT) {
    if (!Array.isArray(nodes) || !nodes.length) {
        return false;
    }

    const { cellWidth, cellHeight, columns, rows } = getMemoryGraphArrangeMetrics(nodes.length, canvasWidth);
    const usedWidth = Math.min(canvasWidth - (MEMORY_GRAPH_SAFE_PADDING * 2), (Math.min(columns, nodes.length) * cellWidth) - MEMORY_GRAPH_NODE_HORIZONTAL_GAP);
    const usedHeight = Math.min(canvasHeight - MEMORY_GRAPH_TOP_SAFE_PADDING - MEMORY_GRAPH_SAFE_PADDING, (rows * cellHeight) - MEMORY_GRAPH_NODE_VERTICAL_GAP);
    const startX = Math.max(MEMORY_GRAPH_SAFE_PADDING, (canvasWidth - usedWidth) / 2);
    const startY = Math.max(MEMORY_GRAPH_TOP_SAFE_PADDING, (canvasHeight - usedHeight) / 2);

    nodes.forEach((node, index) => {
        const row = Math.floor(index / columns);
        const column = index % columns;
        const clamped = clampMemoryNodePosition(
            startX + (column * cellWidth),
            startY + (row * cellHeight),
            canvasWidth,
            canvasHeight,
        );
        node.x = clamped.x;
        node.y = clamped.y;
    });
    return true;
}

function renderMemoryGraphSvg(graph, options = {}) {
    const container = $('#ai_wbr_memory_graph');
    if (!container.length) {
        return;
    }

    const nodes = graph.nodes.slice(0, 18);
    if (!nodes.length) {
        container.html('<div class="ai-wbr-token-empty">暂无记忆节点。生成回复后会自动整理，或点击“立即整理本轮”。</div>');
        return;
    }

    const viewport = getMemoryGraphViewportMetrics(container[0]);
    const width = MEMORY_GRAPH_CANVAS_WIDTH;
    const height = Math.max(viewport.baseHeight, getMemoryGraphArrangeMetrics(nodes.length, width).requiredHeight);
    const centerX = width / 2;
    const centerY = height / 2;
    const radius = Math.min(134, 50 + nodes.length * 9);
    const positions = new Map();
    let layoutChanged = false;

    if (!options.skipAutoArrange && shouldAutoArrangeMemoryNodes(nodes)) {
        layoutChanged = arrangeMemoryGraphNodes(nodes, width, height);
    }

    nodes.forEach((node, index) => {
        if (Number.isFinite(Number(node.x)) && Number.isFinite(Number(node.y))) {
            node.x = Number(node.x);
            node.y = Number(node.y);
            positions.set(node.id, {
                x: node.x,
                y: node.y,
            });
            return;
        }

        const angle = (Math.PI * 2 * index / nodes.length) - Math.PI / 2;
        const clamped = clampMemoryNodePosition(
            centerX + Math.cos(angle) * radius - (MEMORY_GRAPH_NODE_WIDTH / 2),
            centerY + Math.sin(angle) * radius - (MEMORY_GRAPH_NODE_HEIGHT / 2),
            width,
            height,
        );
        node.x = clamped.x;
        node.y = clamped.y;
        positions.set(node.id, {
            x: node.x,
            y: node.y,
        });
        layoutChanged = true;
    });

    if (layoutChanged) {
        saveMemoryGraph(graph, getContext(), true);
    }

    const visibleIds = new Set(nodes.map(node => node.id));
    const nodeColors = new Map(nodes.map((node, index) => [node.id, getMemoryNodeColor(node, index)]));
    const edges = graph.links.filter(link => visibleIds.has(link.source) && visibleIds.has(link.target)).slice(-32);
    const pairBuckets = new Map();
    edges.forEach((link) => {
        const pairKey = [String(link.source || ''), String(link.target || '')].sort().join('||');
        if (!pairBuckets.has(pairKey)) {
            pairBuckets.set(pairKey, []);
        }
        pairBuckets.get(pairKey).push(link);
    });
    const edgeDefs = [];
    const lines = edges.map(link => {
        const source = positions.get(link.source);
        const target = positions.get(link.target);
        if (!source || !target) {
            return '';
        }
        const opacity = Math.max(0.22, Math.min(0.85, Number(link.weight || 0.5)));
        const selectedClass = String(link.id) === String(memoryGraphSelectedLinkId) ? ' ai-wbr-memory-edge-selected' : '';
        const pairKey = [String(link.source || ''), String(link.target || '')].sort().join('||');
        const siblings = (pairBuckets.get(pairKey) || []).slice().sort((a, b) => String(a.id || '').localeCompare(String(b.id || '')));
        const siblingIndex = siblings.findIndex(item => String(item.id || '') === String(link.id || ''));
        const offsetIndex = siblingIndex - ((siblings.length - 1) / 2);
        const laneOffset = siblings.length > 1 ? offsetIndex * 18 : 0;
        const geometry = buildMemoryEdgeGeometry(source, target, laneOffset);
        const sourceColor = nodeColors.get(link.source) || MEMORY_GRAPH_NODE_COLORS[0];
        const targetColor = nodeColors.get(link.target) || MEMORY_GRAPH_NODE_COLORS[1];
        const linkId = escapeHtml(String(link.id || ''));
        const safeId = getSvgSafeId(`${link.id || ''}_${link.source}_${link.target}_${siblingIndex}`);
        const gradientId = `ai_wbr_memory_edge_gradient_${safeId}`;
        const markerId = `ai_wbr_memory_edge_arrow_${safeId}`;
        edgeDefs.push(`
            <linearGradient id="${gradientId}" gradientUnits="userSpaceOnUse" x1="${geometry.startX}" y1="${geometry.startY}" x2="${geometry.endX}" y2="${geometry.endY}">
                <stop offset="0%" stop-color="${escapeHtml(sourceColor)}"></stop>
                <stop offset="52%" stop-color="${escapeHtml(sourceColor)}"></stop>
                <stop offset="100%" stop-color="${escapeHtml(targetColor)}"></stop>
            </linearGradient>
            <marker id="${markerId}" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="strokeWidth">
                <path d="M 1 1 L 7 4 L 1 7" fill="none" stroke="${escapeHtml(targetColor)}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"></path>
            </marker>
        `);
        return `
            <path d="${geometry.path}" class="ai-wbr-memory-edge-hit" data-memory-link-id="${linkId}" data-source-id="${escapeHtml(link.source)}" data-target-id="${escapeHtml(link.target)}"></path>
            <path d="${geometry.path}" class="ai-wbr-memory-edge${selectedClass}" data-memory-link-id="${linkId}" data-source-id="${escapeHtml(link.source)}" data-target-id="${escapeHtml(link.target)}" style="opacity:${opacity};stroke:url(#${gradientId});marker-end:url(#${markerId});"><title>${escapeHtml(link.type || 'RELATED')}</title></path>
        `;
    }).join('');
    const defs = edgeDefs.length ? `<defs>${edgeDefs.join('')}</defs>` : '';

    const cards = nodes.map((node, index) => {
        const position = positions.get(node.id);
        const rawType = String(node.type || 'event');
        const colorClass = `ai-wbr-memory-node-${escapeHtml(rawType.toLowerCase())}`;
        const typeLabel = getOptionLabel(MEMORY_NODE_TYPE_OPTIONS, rawType, rawType);
        const subtitle = node.summary || node.content || '';
        const nodeColor = nodeColors.get(node.id) || getMemoryNodeColor(node, index);
        return `<g class="ai-wbr-memory-node ${colorClass}" data-memory-node-id="${escapeHtml(node.id)}" style="--memory-node-accent:${escapeHtml(nodeColor)}" transform="translate(${position.x},${position.y})">
            <rect class="ai-wbr-memory-node-card" x="0" y="0" width="${MEMORY_GRAPH_NODE_WIDTH}" height="${MEMORY_GRAPH_NODE_HEIGHT}" rx="14" ry="14"></rect>
            <circle class="ai-wbr-memory-node-accent" cx="16" cy="16" r="4"></circle>
            <text class="ai-wbr-memory-node-title" x="28" y="21">${escapeHtml(truncateTextByDisplayWidth(node.title || node.id, 18))}</text>
            <text class="ai-wbr-memory-node-subtitle" x="14" y="42">${escapeHtml(truncateTextByDisplayWidth(subtitle, 24) || '暂无摘要')}</text>
            <g class="ai-wbr-memory-node-badge" transform="translate(12,56)">
                <rect width="${Math.max(34, typeLabel.length * 12)}" height="18" rx="9" ry="9"></rect>
                <text x="${Math.max(34, typeLabel.length * 12) / 2}" y="12">${escapeHtml(typeLabel)}</text>
            </g>
            <title>${escapeHtml(`${node.title}\n${node.content || ''}`)}</title>
        </g>`;
    }).join('');

    if (!memoryGraphView || !Number.isFinite(memoryGraphView.width)) {
        memoryGraphView = { x: 0, y: 0, width, height };
    }
    if (!options.preserveView) {
        syncMemoryGraphViewToContainerAspect(container[0]);
    }
    if (!options.preserveView && memoryGraphView.height < height) {
        memoryGraphView.y = Math.min(memoryGraphView.y, 0);
        memoryGraphView.height = height;
    }

    container.html(`
        <div class="ai-wbr-memory-graph-toolbar">
            <button class="menu_button ai-wbr-memory-zoom-in" type="button">＋</button>
            <button class="menu_button ai-wbr-memory-zoom-out" type="button">－</button>
            <button class="menu_button ai-wbr-memory-zoom-reset" type="button">重置视图</button>
            <button class="menu_button ai-wbr-memory-arrange" type="button">重排</button>
            <span class="ai-wbr-memory-link-hint">${memoryGraphLinkSourceId ? `连线起点：${escapeHtml(graph.nodes.find(node => node.id === memoryGraphLinkSourceId)?.title || memoryGraphLinkSourceId)}` : ''}</span>
        </div>
        <svg viewBox="${memoryGraphView.x} ${memoryGraphView.y} ${memoryGraphView.width} ${memoryGraphView.height}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="记忆图谱">${defs}${lines}${cards}</svg>
    `);
    bindMemoryGraphSvgInteractions();
}

function getMemoryGraphSvgPoint(svg, clientX, clientY) {
    const point = svg.createSVGPoint();
    point.x = clientX;
    point.y = clientY;
    return point.matrixTransform(svg.getScreenCTM().inverse());
}

function updateMemoryGraphViewBox(svg) {
    svg.setAttribute('viewBox', `${memoryGraphView.x} ${memoryGraphView.y} ${memoryGraphView.width} ${memoryGraphView.height}`);
}

function getMemoryGraphViewportMetrics(containerEl) {
    const rect = containerEl?.getBoundingClientRect?.();
    const pixelWidth = Math.max(1, Number(rect?.width || 1));
    const pixelHeight = Math.max(1, Number(rect?.height || 1));
    const aspect = pixelWidth / pixelHeight;
    return {
        aspect,
        baseWidth: MEMORY_GRAPH_CANVAS_WIDTH,
        baseHeight: Math.max(220, MEMORY_GRAPH_CANVAS_WIDTH / aspect),
    };
}

function syncMemoryGraphViewToContainerAspect(containerEl) {
    if (!memoryGraphView || !Number.isFinite(memoryGraphView.width)) {
        return;
    }
    const { aspect } = getMemoryGraphViewportMetrics(containerEl);
    const nextHeight = Math.max(120, memoryGraphView.width / Math.max(0.2, aspect));
    if (!Number.isFinite(nextHeight) || Math.abs(nextHeight - memoryGraphView.height) < 0.5) {
        return;
    }
    const centerY = memoryGraphView.y + (memoryGraphView.height / 2);
    memoryGraphView.height = nextHeight;
    memoryGraphView.y = centerY - (nextHeight / 2);
}

function parseMemoryNodeTransform(transform) {
    const text = String(transform || '');
    const match = text.match(/translate\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)/i);
    if (!match) {
        return null;
    }
    return {
        x: Number(match[1]),
        y: Number(match[2]),
    };
}

function getOptionLabel(options, value, fallback = '') {
    const normalizedValue = String(value || '');
    return options.find(option => option.value === normalizedValue)?.label || fallback || normalizedValue;
}

function clampMemoryNodePosition(x, y, canvasWidth = MEMORY_GRAPH_CANVAS_WIDTH, canvasHeight = MEMORY_GRAPH_CANVAS_HEIGHT, topPadding = MEMORY_GRAPH_TOP_SAFE_PADDING) {
    return {
        x: Math.min(
            canvasWidth - MEMORY_GRAPH_NODE_WIDTH - MEMORY_GRAPH_SAFE_PADDING,
            Math.max(MEMORY_GRAPH_SAFE_PADDING, Number(x || 0)),
        ),
        y: Math.min(
            canvasHeight - MEMORY_GRAPH_NODE_HEIGHT - MEMORY_GRAPH_SAFE_PADDING,
            Math.max(topPadding, Number(y || 0)),
        ),
    };
}

function clampMemoryNodePositionToView(x, y, view = memoryGraphView, topPadding = 0) {
    const safeTop = Math.max(0, Number(topPadding || 0));
    const overflowAllowanceX = MEMORY_GRAPH_NODE_WIDTH * 0.45;
    const overflowAllowanceY = MEMORY_GRAPH_NODE_HEIGHT * 0.45;
    const minX = Number(view?.x || 0) - overflowAllowanceX;
    const minY = Number(view?.y || 0) + safeTop - overflowAllowanceY;
    const maxX = Number(view?.x || 0) + Number(view?.width || MEMORY_GRAPH_CANVAS_WIDTH) - MEMORY_GRAPH_NODE_WIDTH + overflowAllowanceX;
    const maxY = Number(view?.y || 0) + Number(view?.height || MEMORY_GRAPH_CANVAS_HEIGHT) - MEMORY_GRAPH_NODE_HEIGHT + overflowAllowanceY;
    return {
        x: Math.min(maxX, Math.max(minX, Number(x || 0))),
        y: Math.min(maxY, Math.max(minY, Number(y || 0))),
    };
}

function getMemoryNodeRect(position) {
    return {
        x: Number(position?.x || 0),
        y: Number(position?.y || 0),
        width: MEMORY_GRAPH_NODE_WIDTH,
        height: MEMORY_GRAPH_NODE_HEIGHT,
    };
}

function buildMemoryEdgePath(sourcePosition, targetPosition, laneOffset = 0) {
    return buildMemoryEdgeGeometry(sourcePosition, targetPosition, laneOffset).path;
}

function buildMemoryEdgeGeometry(sourcePosition, targetPosition, laneOffset = 0) {
    const sourceRect = getMemoryNodeRect(sourcePosition);
    const targetRect = getMemoryNodeRect(targetPosition);
    const sourceCenter = {
        x: sourceRect.x + (sourceRect.width / 2),
        y: sourceRect.y + (sourceRect.height / 2),
    };
    const targetCenter = {
        x: targetRect.x + (targetRect.width / 2),
        y: targetRect.y + (targetRect.height / 2),
    };
    const dx = targetCenter.x - sourceCenter.x;
    const dy = targetCenter.y - sourceCenter.y;
    const horizontal = Math.abs(dx) >= Math.abs(dy);

    let startX;
    let startY;
    let endX;
    let endY;
    let control1X;
    let control1Y;
    let control2X;
    let control2Y;

    if (horizontal) {
        const sourceToRight = dx >= 0;
        startX = sourceToRight ? sourceRect.x + sourceRect.width : sourceRect.x;
        startY = sourceRect.y + (sourceRect.height / 2);
        endX = sourceToRight ? targetRect.x : targetRect.x + targetRect.width;
        endY = targetRect.y + (targetRect.height / 2);
        const curve = Math.max(42, Math.abs(endX - startX) * 0.35);
        control1X = startX + (sourceToRight ? curve : -curve);
        control1Y = startY + laneOffset;
        control2X = endX + (sourceToRight ? -curve : curve);
        control2Y = endY + laneOffset;
        startY += laneOffset * 0.35;
        endY += laneOffset * 0.35;
    } else {
        const sourceToBottom = dy >= 0;
        startX = sourceRect.x + (sourceRect.width / 2);
        startY = sourceToBottom ? sourceRect.y + sourceRect.height : sourceRect.y;
        endX = targetRect.x + (targetRect.width / 2);
        endY = sourceToBottom ? targetRect.y : targetRect.y + targetRect.height;
        const curve = Math.max(34, Math.abs(endY - startY) * 0.35);
        control1X = startX + laneOffset;
        control1Y = startY + (sourceToBottom ? curve : -curve);
        control2X = endX + laneOffset;
        control2Y = endY + (sourceToBottom ? -curve : curve);
        startX += laneOffset * 0.35;
        endX += laneOffset * 0.35;
    }

    return {
        path: `M ${startX} ${startY} C ${control1X} ${control1Y}, ${control2X} ${control2Y}, ${endX} ${endY}`,
        startX,
        startY,
        endX,
        endY,
    };
}

function buildSelectOptionsHtml(options, currentValue) {
    const normalizedValue = String(currentValue || '');
    const known = options.some(option => option.value === normalizedValue);
    const optionHtml = options.map(option => `<option value="${escapeHtml(option.value)}" ${option.value === normalizedValue ? 'selected' : ''}>${escapeHtml(option.label)}</option>`).join('');
    if (!known && normalizedValue) {
        return `${optionHtml}<option value="${escapeHtml(normalizedValue)}" selected>自定义（${escapeHtml(normalizedValue)}）</option>`;
    }
    return optionHtml;
}

function buildNodeTypeSelect(fieldName, currentValue, extraAttributes = '') {
    return `<select class="text_pole" ${extraAttributes} data-${fieldName}="type">${buildSelectOptionsHtml(MEMORY_NODE_TYPE_OPTIONS, currentValue || 'event')}</select>`;
}

function buildLinkTypeSelect(fieldName, currentValue, extraAttributes = '') {
    return `<select class="text_pole" ${extraAttributes} data-${fieldName}="type">${buildSelectOptionsHtml(MEMORY_LINK_TYPE_OPTIONS, currentValue || 'RELATED')}</select>`;
}

function createNodeTypeSelect(fieldAttrName, currentValue, extraData = {}) {
    const select = $('<select class="text_pole"></select>').attr(fieldAttrName, 'type');
    for (const option of MEMORY_NODE_TYPE_OPTIONS) {
        select.append($('<option></option>').attr('value', option.value).text(option.label));
    }
    const normalizedValue = String(currentValue || 'event');
    if (!MEMORY_NODE_TYPE_OPTIONS.some(option => option.value === normalizedValue) && normalizedValue) {
        select.append($('<option></option>').attr('value', normalizedValue).text(`自定义（${normalizedValue}）`));
    }
    select.val(normalizedValue);
    for (const [key, value] of Object.entries(extraData)) {
        select.attr(key, value);
    }
    return select;
}

function createLinkTypeSelect(fieldAttrName, currentValue, extraData = {}) {
    const select = $('<select class="text_pole"></select>').attr(fieldAttrName, 'type');
    for (const option of MEMORY_LINK_TYPE_OPTIONS) {
        select.append($('<option></option>').attr('value', option.value).text(option.label));
    }
    const normalizedValue = String(currentValue || 'RELATED');
    if (!MEMORY_LINK_TYPE_OPTIONS.some(option => option.value === normalizedValue) && normalizedValue) {
        select.append($('<option></option>').attr('value', normalizedValue).text(`自定义（${normalizedValue}）`));
    }
    select.val(normalizedValue);
    for (const [key, value] of Object.entries(extraData)) {
        select.attr(key, value);
    }
    return select;
}

function showMemoryNodePopover(nodeId, clientX, clientY) {
    memoryGraphSelectedNodeId = String(nodeId || '');
    renderMemoryGraphSvg(getMemoryGraph(), { skipAutoArrange: true, preserveView: true });
    $('#ai_wbr_memory_link_popover').hide();

    const graph = getMemoryGraph();
    const node = graph.nodes.find(item => item.id === nodeId);
    let popover = $('#ai_wbr_memory_node_popover');
    if (!popover.length) {
        popover = $('<div id="ai_wbr_memory_node_popover" class="ai-wbr-memory-node-popover"></div>');
        $('body').append(popover);
    }
    if (!node || !popover.length) {
        return;
    }

    const sourceTitle = memoryGraphLinkSourceId
        ? graph.nodes.find(item => item.id === memoryGraphLinkSourceId)?.title || memoryGraphLinkSourceId
        : '';

    popover
        .attr('data-memory-node-id', node.id)
        .html(`
            <div class="ai-wbr-memory-popover-title">${escapeHtml(truncateText(node.title || node.id, 38))}</div>
            <label>标题<input class="text_pole" type="text" data-popover-node-field="title" value="${escapeHtml(node.title || '')}" /></label>
            <label>类型${buildNodeTypeSelect('popover-node-field', node.type || 'event')}</label>
            <label>内容<textarea class="text_pole" rows="2" data-popover-node-field="content">${escapeHtml(node.content || '')}</textarea></label>
            <div class="ai-wbr-memory-popover-actions">
                <button class="menu_button ai-wbr-memory-popover-save" type="button">保存</button>
                <button class="menu_button ai-wbr-memory-set-link-source" type="button">设为起点</button>
                <button class="menu_button ai-wbr-memory-link-to-source" type="button" ${memoryGraphLinkSourceId && memoryGraphLinkSourceId !== node.id ? '' : 'disabled'}>连接到起点${sourceTitle ? `：${escapeHtml(truncateText(sourceTitle, 8))}` : ''}</button>
                <button class="menu_button ai-wbr-memory-popover-delete" type="button">删除</button>
            </div>
        `)
        .css({
            left: `${Math.min(Math.max(clientX + 12, 8), window.innerWidth - 244)}px`,
            top: `${Math.min(Math.max(clientY + 12, 8), window.innerHeight - 210)}px`,
        })
        .show();
}

function showMemoryLinkPopover(linkId, clientX, clientY) {
    memoryGraphSelectedLinkId = String(linkId || '');
    renderMemoryGraphSvg(getMemoryGraph(), { skipAutoArrange: true, preserveView: true });

    const graph = getMemoryGraph();
    const link = graph.links.find(item => String(item.id) === String(linkId));
    let popover = $('#ai_wbr_memory_link_popover');
    if (!popover.length) {
        popover = $('<div id="ai_wbr_memory_link_popover" class="ai-wbr-memory-node-popover ai-wbr-memory-link-popover"></div>');
        $('body').append(popover);
    }
    if (!link || !popover.length) {
        return;
    }

    const sourceTitle = graph.nodes.find(node => node.id === link.source)?.title || link.source;
    const targetTitle = graph.nodes.find(node => node.id === link.target)?.title || link.target;

    popover
        .attr('data-memory-link-id', link.id)
        .data('memoryLinkId', link.id)
        .html(`
            <div class="ai-wbr-memory-popover-title">${escapeHtml(truncateTextByDisplayWidth(sourceTitle, 16))} → ${escapeHtml(truncateTextByDisplayWidth(targetTitle, 16))}</div>
            <label>关系类型${buildLinkTypeSelect('popover-link-field', link.type || 'RELATED')}</label>
            <label>权重<input class="text_pole" type="number" min="0" max="1" step="0.05" data-popover-link-field="weight" value="${escapeHtml(link.weight ?? 0.7)}" /></label>
            <label>说明<textarea class="text_pole" rows="2" data-popover-link-field="description">${escapeHtml(link.description || '')}</textarea></label>
            <div class="ai-wbr-memory-popover-actions">
                <button class="menu_button ai-wbr-memory-link-popover-save" type="button">保存</button>
                <button class="menu_button ai-wbr-memory-link-popover-delete" type="button">删除连接</button>
            </div>
        `)
        .css({
            left: `${Math.min(Math.max(clientX + 12, 8), window.innerWidth - 260)}px`,
            top: `${Math.min(Math.max(clientY + 12, 8), window.innerHeight - 230)}px`,
        })
        .show();
}

function bindMemoryGraphSvgInteractions() {
    const container = $('#ai_wbr_memory_graph');
    const svg = container.find('svg')[0];
    if (!svg) {
        return;
    }

    container.off('.memoryGraphSvg');
    $(document).off('.memoryGraphSvg');

    container.on('wheel.memoryGraphSvg', 'svg', function (event) {
        event.preventDefault();
        const original = event.originalEvent;
        const svgPoint = getMemoryGraphSvgPoint(svg, original.clientX, original.clientY);
        const factor = original.deltaY < 0 ? 0.88 : 1.14;
        const nextWidth = Math.min(1400, Math.max(120, memoryGraphView.width * factor));
        const nextHeight = Math.min(900, Math.max(80, memoryGraphView.height * factor));
        const ratioX = (svgPoint.x - memoryGraphView.x) / memoryGraphView.width;
        const ratioY = (svgPoint.y - memoryGraphView.y) / memoryGraphView.height;
        memoryGraphView = {
            x: svgPoint.x - (nextWidth * ratioX),
            y: svgPoint.y - (nextHeight * ratioY),
            width: nextWidth,
            height: nextHeight,
        };
        updateMemoryGraphViewBox(svg);
    });

    container.on('click.memoryGraphSvg', '.ai-wbr-memory-zoom-in', () => {
        memoryGraphView.width = Math.max(120, memoryGraphView.width * 0.82);
        memoryGraphView.height = Math.max(80, memoryGraphView.height * 0.82);
        updateMemoryGraphViewBox(svg);
    });

    container.on('click.memoryGraphSvg', '.ai-wbr-memory-zoom-out', () => {
        memoryGraphView.width = Math.min(1400, memoryGraphView.width * 1.18);
        memoryGraphView.height = Math.min(900, memoryGraphView.height * 1.18);
        updateMemoryGraphViewBox(svg);
    });

    container.on('click.memoryGraphSvg', '.ai-wbr-memory-zoom-reset', () => {
        const viewport = getMemoryGraphViewportMetrics(container[0]);
        memoryGraphView = { x: 0, y: 0, width: viewport.baseWidth, height: viewport.baseHeight };
        updateMemoryGraphViewBox(svg);
    });

    container.on('click.memoryGraphSvg', '.ai-wbr-memory-arrange', () => {
        const graph = getMemoryGraph();
        const viewport = getMemoryGraphViewportMetrics(container[0]);
        const visibleNodes = graph.nodes.slice(0, 18);
        const nextHeight = Math.max(viewport.baseHeight, getMemoryGraphArrangeMetrics(visibleNodes.length).requiredHeight);
        if (!arrangeMemoryGraphNodes(visibleNodes, MEMORY_GRAPH_CANVAS_WIDTH, nextHeight)) {
            return;
        }
        graph.updatedAt = new Date().toISOString();
        saveMemoryGraph(graph, getContext(), true);
        memoryGraphView = { x: 0, y: 0, width: viewport.baseWidth, height: nextHeight };
        renderMemoryGraphSvg(graph);
    });

    container.on('mousedown.memoryGraphSvg', '.ai-wbr-memory-node', function (event) {
        const nodeId = String($(this).data('memoryNodeId'));
        const start = getMemoryGraphSvgPoint(svg, event.clientX, event.clientY);
        const graph = getMemoryGraph();
        const node = graph.nodes.find(item => item.id === nodeId);
        const transform = parseMemoryNodeTransform($(this).attr('transform'));
        if (!node) {
            return;
        }

        const nodePositions = new Map();
        container.find('.ai-wbr-memory-node').each(function () {
            const id = String($(this).data('memoryNodeId'));
            const t = parseMemoryNodeTransform($(this).attr('transform'));
            if (t) {
                nodePositions.set(id, t);
            }
        });

        const visibleIds = new Set(Array.from(nodePositions.keys()));
        const edges = graph.links.filter(link => visibleIds.has(link.source) && visibleIds.has(link.target));
        const pairBuckets = new Map();
        edges.forEach((link) => {
            const pairKey = [String(link.source || ''), String(link.target || '')].sort().join('||');
            if (!pairBuckets.has(pairKey)) {
                pairBuckets.set(pairKey, []);
            }
            pairBuckets.get(pairKey).push(link);
        });

        const linkOffsets = new Map();
        edges.forEach((link) => {
            const pairKey = [String(link.source || ''), String(link.target || '')].sort().join('||');
            const siblings = (pairBuckets.get(pairKey) || []).slice().sort((a, b) => String(a.id || '').localeCompare(String(b.id || '')));
            const siblingIndex = siblings.findIndex(item => String(item.id || '') === String(link.id || ''));
            const offsetIndex = siblingIndex - ((siblings.length - 1) / 2);
            linkOffsets.set(link.id, siblings.length > 1 ? offsetIndex * 18 : 0);
        });

        memoryGraphDrag = {
            nodeId,
            startX: start.x,
            startY: start.y,
            nodeX: Number.isFinite(transform?.x) ? transform.x : Number(node.x || 0),
            nodeY: Number.isFinite(transform?.y) ? transform.y : Number(node.y || 0),
            moved: false,
            nodePositions,
            linkOffsets,
            links: edges.filter(link => link.source === nodeId || link.target === nodeId)
        };
        event.preventDefault();
        event.stopPropagation();
    });

    container.on('click.memoryGraphSvg', '.ai-wbr-memory-edge, .ai-wbr-memory-edge-hit', function (event) {
        event.preventDefault();
        event.stopPropagation();
        $('#ai_wbr_memory_node_popover').hide();
        showMemoryLinkPopover(String($(this).data('memoryLinkId') || ''), event.clientX, event.clientY);
    });

    container.on('mousedown.memoryGraphSvg', '.ai-wbr-memory-edge, .ai-wbr-memory-edge-hit', function (event) {
        event.preventDefault();
        event.stopPropagation();
    });

    container.on('mousedown.memoryGraphSvg', 'svg', function (event) {
        if ($(event.target).closest('.ai-wbr-memory-node').length) {
            return;
        }

        memoryGraphPan = {
            startClientX: event.clientX,
            startClientY: event.clientY,
            viewX: memoryGraphView.x,
            viewY: memoryGraphView.y,
            moved: false,
        };
        $('#ai_wbr_memory_node_popover').hide();
        $(svg).addClass('ai-wbr-memory-panning');
        event.preventDefault();
    });

    $(document).on('mousemove.memoryGraphSvg', (event) => {
        if (!memoryGraphDrag) {
            if (memoryGraphPan) {
                const rect = svg.getBoundingClientRect();
                const dx = (event.clientX - memoryGraphPan.startClientX) * (memoryGraphView.width / Math.max(1, rect.width));
                const dy = (event.clientY - memoryGraphPan.startClientY) * (memoryGraphView.height / Math.max(1, rect.height));
                if (Math.abs(dx) + Math.abs(dy) > 1.5) {
                    memoryGraphPan.moved = true;
                }
                memoryGraphView.x = memoryGraphPan.viewX - dx;
                memoryGraphView.y = memoryGraphPan.viewY - dy;
                updateMemoryGraphViewBox(svg);
            }
            return;
        }
        const point = getMemoryGraphSvgPoint(svg, event.clientX, event.clientY);
        const dx = point.x - memoryGraphDrag.startX;
        const dy = point.y - memoryGraphDrag.startY;
        if (Math.abs(dx) + Math.abs(dy) > 1.5) {
            memoryGraphDrag.moved = true;
        }
        
        const clamped = clampMemoryNodePositionToView(memoryGraphDrag.nodeX + dx, memoryGraphDrag.nodeY + dy);
        memoryGraphDrag.nodePositions.set(memoryGraphDrag.nodeId, { x: clamped.x, y: clamped.y });
        
        const group = container.find(`.ai-wbr-memory-node[data-memory-node-id="${escapeCssSelector(memoryGraphDrag.nodeId)}"]`);
        group.attr('transform', `translate(${clamped.x},${clamped.y})`);
        
        memoryGraphDrag.links.forEach((link) => {
            const line = container.find(`[data-memory-link-id="${escapeCssSelector(String(link.id || ''))}"]`);
            const source = memoryGraphDrag.nodePositions.get(link.source);
            const target = memoryGraphDrag.nodePositions.get(link.target);
            const laneOffset = memoryGraphDrag.linkOffsets.get(link.id) || 0;
            if (source && target) {
                line.attr('d', buildMemoryEdgePath(source, target, laneOffset));
            }
        });
    });

    $(document).on('mouseup.memoryGraphSvg', (event) => {
        if (memoryGraphPan) {
            memoryGraphPan = null;
            $(svg).removeClass('ai-wbr-memory-panning');
            lastObservedChatScopedUiSignature = getChatScopedUiSignature();
            return;
        }

        if (!memoryGraphDrag) {
            return;
        }
        const drag = memoryGraphDrag;
        memoryGraphDrag = null;
        const graph = getMemoryGraph();

        if (drag.moved) {
            const node = graph.nodes.find(item => item.id === drag.nodeId);
            if (node) {
                const point = getMemoryGraphSvgPoint(svg, event.clientX, event.clientY);
                const dx = point.x - drag.startX;
                const dy = point.y - drag.startY;
                const clamped = clampMemoryNodePositionToView(drag.nodeX + dx, drag.nodeY + dy);
                node.x = clamped.x;
                node.y = clamped.y;
                node.updatedAt = new Date().toISOString();
            }
            graph.updatedAt = new Date().toISOString();
            saveMemoryGraph(graph, getContext(), true);
            lastObservedChatScopedUiSignature = getChatScopedUiSignature();
            $('#ai_wbr_memory_json').val(JSON.stringify(graph, null, 2));
            renderMemoryGraphSvg(graph, { skipAutoArrange: true, preserveView: true });
            return;
        }

        lastObservedChatScopedUiSignature = getChatScopedUiSignature();
        showMemoryNodePopover(drag.nodeId, event.clientX, event.clientY);
    });

    $(document).on('click.memoryGraphSvg', '#ai_wbr_memory_node_popover .ai-wbr-memory-popover-save', function () {
        const graph = getMemoryGraph();
        const popover = $('#ai_wbr_memory_node_popover');
        const node = graph.nodes.find(item => item.id === String(popover.data('memoryNodeId')));
        if (!node) {
            return;
        }
        popover.find('[data-popover-node-field]').each(function () {
            const field = String($(this).data('popoverNodeField'));
            node[field] = String($(this).val() || '');
        });
        node.updatedAt = new Date().toISOString();
        graph.updatedAt = node.updatedAt;
        saveMemoryGraph(graph, getContext(), true);
        renderMemoryGraphSvg(graph, { skipAutoArrange: true, preserveView: true });
        popover.hide();
    });

    $(document).on('click.memoryGraphSvg', '#ai_wbr_memory_node_popover .ai-wbr-memory-set-link-source', function () {
        const nodeId = String($('#ai_wbr_memory_node_popover').data('memoryNodeId'));
        memoryGraphLinkSourceId = nodeId;
        renderMemoryGraphSvg(getMemoryGraph(), { skipAutoArrange: true, preserveView: true });
    });

    $(document).on('click.memoryGraphSvg', '#ai_wbr_memory_node_popover .ai-wbr-memory-link-to-source', function () {
        const graph = getMemoryGraph();
        const targetId = String($('#ai_wbr_memory_node_popover').data('memoryNodeId'));
        if (!memoryGraphLinkSourceId || memoryGraphLinkSourceId === targetId) {
            return;
        }
        const existingIndex = graph.links.findIndex(item => item.source === memoryGraphLinkSourceId && item.target === targetId && item.type === 'RELATED');
        if (existingIndex >= 0) {
            graph.links.splice(existingIndex, 1);
            graph.updatedAt = new Date().toISOString();
            saveMemoryGraph(graph, getContext(), true);
            renderMemoryGraphSvg(graph, { skipAutoArrange: true, preserveView: true });
            memoryGraphLinkSourceId = '';
            $('#ai_wbr_memory_node_popover').hide();
            return;
        }
        const link = normalizeMemoryLink({
            source: memoryGraphLinkSourceId,
            target: targetId,
            type: 'RELATED',
            weight: 0.7,
            description: '手动创建的记忆关系',
        }, new Set(graph.nodes.map(node => node.id)), graph.links.length);
        if (link && !graph.links.some(item => item.source === link.source && item.target === link.target && item.type === link.type)) {
            graph.links.push(link);
            graph.updatedAt = new Date().toISOString();
            saveMemoryGraph(graph, getContext(), true);
            renderMemoryGraphSvg(graph, { skipAutoArrange: true, preserveView: true });
        }
        memoryGraphLinkSourceId = '';
        $('#ai_wbr_memory_node_popover').hide();
    });

    $(document).on('click.memoryGraphSvg', '#ai_wbr_memory_node_popover .ai-wbr-memory-popover-delete', function () {
        const graph = getMemoryGraph();
        const nodeId = String($('#ai_wbr_memory_node_popover').data('memoryNodeId'));
        graph.nodes = graph.nodes.filter(node => node.id !== nodeId);
        graph.links = graph.links.filter(link => link.source !== nodeId && link.target !== nodeId);
        graph.updatedAt = new Date().toISOString();
        saveMemoryGraph(graph, getContext(), true);
        renderMemoryGraphSvg(graph, { skipAutoArrange: true, preserveView: true });
        $('#ai_wbr_memory_node_popover').hide();
    });

    $(document).on('click.memoryGraphSvg', '#ai_wbr_memory_link_popover .ai-wbr-memory-link-popover-save', function () {
        const graph = getMemoryGraph();
        const popover = $('#ai_wbr_memory_link_popover');
        const link = graph.links.find(item => String(item.id) === String(popover.data('memoryLinkId')));
        if (!link) {
            return;
        }
        popover.find('[data-popover-link-field]').each(function () {
            const field = String($(this).data('popoverLinkField'));
            if (field === 'weight') {
                link.weight = clampNumber($(this).val(), link.weight || 0.7, 0, 1);
            } else {
                link[field] = String($(this).val() || '');
            }
        });
        link.updatedAt = new Date().toISOString();
        graph.updatedAt = link.updatedAt;
        saveMemoryGraph(graph, getContext(), true);
        renderMemoryGraphSvg(graph, { skipAutoArrange: true, preserveView: true });
        popover.hide();
    });

    $(document).on('click.memoryGraphSvg', '#ai_wbr_memory_link_popover .ai-wbr-memory-link-popover-delete', function () {
        const graph = getMemoryGraph();
        const popover = $('#ai_wbr_memory_link_popover');
        const id = String(popover.data('memoryLinkId') || '');
        graph.links = graph.links.filter(link => String(link.id) !== id);
        if (memoryGraphSelectedLinkId === id) {
            memoryGraphSelectedLinkId = '';
        }
        graph.updatedAt = new Date().toISOString();
        saveMemoryGraph(graph, getContext(), true);
        renderMemoryGraphSvg(graph, { skipAutoArrange: true, preserveView: true });
        popover.hide();
    });

    $(document).on('click.memoryGraphSvg', '#ai_wbr_memory_link_popover, #ai_wbr_memory_link_popover *', function (event) {
        event.stopPropagation();
    });

    container.on('click.memoryGraphSvg', function (event) {
        if ($(event.target).closest('.ai-wbr-memory-node, .ai-wbr-memory-edge, .ai-wbr-memory-edge-hit, .ai-wbr-memory-graph-toolbar').length) {
            return;
        }
        $('#ai_wbr_memory_node_popover').hide();
        $('#ai_wbr_memory_link_popover').hide();
    });
}

function renderMemoryPanel() {
    if (!$('#ai_wbr_memory_graph').length) {
        return;
    }

    const graph = getMemoryGraph();
    memoryScopeDebugLog('renderMemoryPanel', {
        graph: getMemoryGraphSummary(graph),
        selectedNodeId: memoryGraphSelectedNodeId,
        linkSourceId: memoryGraphLinkSourceId,
    });
    $('#ai_wbr_memory_status').text(getCurrentMemoryStatus() || (settings.memoryEnabled ? '待整理' : '未启用'));
    $('#ai_wbr_memory_json').val(JSON.stringify(graph, null, 2));
    $('#ai_wbr_memory_debug_panel').toggle(!!settings.memoryDebug);
    $('#ai_wbr_memory_prompt').text(getCurrentMemoryLastPrompt() || '尚无后置记忆 Prompt');
    $('#ai_wbr_memory_raw').text(getCurrentMemoryLastRaw() || '尚无后置记忆返回');
    $('#ai_wbr_memory_error').text(getCurrentMemoryLastError() || '尚无错误');
    renderMemoryGraphSvg(graph);
    renderMemoryNodeEditor(graph);
    renderMemoryEdgeEditor(graph);

    const stateRows = getMemoryStateRows(graph);
    const stateTable = $('<table class="ai-wbr-memory-table"></table>');
    stateTable.append('<thead><tr><th>状态字段</th><th>当前值</th></tr></thead>');
    const stateBody = $('<tbody></tbody>');
    for (const row of stateRows) {
        stateBody.append(
            $('<tr></tr>')
                .append($('<th scope="row"></th>')
                    .append($('<div></div>').text(row.label))
                    .append(row.description ? $('<div class="ai-wbr-memory-state-desc"></div>').text(row.description) : '')
                    .append(row.isCustom
                        ? $('<button class="menu_button ai-wbr-memory-delete-state-definition m-t-05" type="button">删除</button>')
                            .attr('data-memory-state-definition-key', row.key)
                        : ''))
                .append($('<td></td>').append(
                    $('<input class="text_pole" type="text" />')
                        .attr('data-memory-state-field', row.key)
                        .val(row.value),
                )),
        );
    }
    stateTable.append(stateBody);
    $('#ai_wbr_memory_state_editor').empty().append(
        $('<div class="ai-wbr-memory-subtitle"><b>新增自定义状态字段</b></div>'),
        $(`
            <div class="ai-wbr-memory-add-state">
                <input id="ai_wbr_memory_new_state_label" class="text_pole" type="text" placeholder="字段名，例如：道具" />
                <input id="ai_wbr_memory_new_state_instruction" class="text_pole" type="text" placeholder="字段说明，例如：user背包里的道具" />
                <button id="ai_wbr_memory_add_state_definition" class="menu_button" type="button">添加字段</button>
            </div>
        `),
        $('<div class="ai-wbr-memory-subtitle"><b>状态表（固定更新）</b></div>'),
        $('<div class="ai-wbr-memory-table-wrap"></div>').append(stateTable),
    );

    const eventNodes = getMemoryEventNodes(graph);
    const nonEventNodes = getMemoryNonEventNodes(graph);
    const nodesContainer = $('#ai_wbr_memory_nodes').empty();
    nodesContainer.append($('<div class="ai-wbr-memory-subtitle"><b>事件表（剧情推进会新增）</b></div>'));
    if (!eventNodes.length) {
        nodesContainer.append('<div class="ai-wbr-token-empty">暂无事件记录</div>');
    } else {
        const eventTable = $('<table class="ai-wbr-memory-table ai-wbr-memory-event-table"></table>');
        eventTable.append('<thead><tr><th>标题</th><th>地点 / 时间</th><th>概要</th><th>详细纪要</th><th>关键词</th><th>操作</th></tr></thead>');
        const eventBody = $('<tbody></tbody>');
        for (const node of eventNodes) {
            eventBody.append(
                $('<tr></tr>')
                    .attr('data-memory-node-id', node.id)
                    .append($('<td></td>').append(
                        $('<input class="text_pole" type="text" data-memory-node-field="title" />').val(node.title || ''),
                    ))
                    .append($('<td></td>').append(
                        $('<input class="text_pole" type="text" data-memory-node-field="location" placeholder="地点" />').val(node.location || ''),
                        $('<input class="text_pole m-t-05" type="text" data-memory-node-field="timeSpan" placeholder="时间跨度" />').val(node.timeSpan || ''),
                    ))
                    .append($('<td></td>').append(
                        $('<input class="text_pole" type="text" data-memory-node-field="summary" />').val(node.summary || ''),
                    ))
                    .append($('<td></td>').append(
                        $('<textarea class="text_pole ai-wbr-memory-content" rows="3" data-memory-node-field="content"></textarea>').val(node.content || ''),
                    ))
                    .append($('<td></td>').append(
                        $('<input class="text_pole" type="text" data-memory-node-field="keys" placeholder="关键词，用逗号分隔" />').val((node.keys || []).join('，')),
                        $('<input class="text_pole m-t-05" type="text" data-memory-node-field="tags" placeholder="标签，用逗号分隔" />').val((node.tags || []).join('，')),
                    ))
                    .append($('<td></td>').append(
                        $('<div class="ai-wbr-memory-event-actions"></div>')
                            .append(createNodeTypeSelect('data-memory-node-field', node.type || 'event'))
                            .append($('<button class="menu_button ai-wbr-memory-delete-node" type="button">删除</button>')),
                    )),
            );
        }
        eventTable.append(eventBody);
        nodesContainer.append($('<div class="ai-wbr-memory-table-wrap"></div>').append(eventTable));
    }

    nodesContainer.append($('<div class="ai-wbr-memory-subtitle m-t-1"><b>非事件节点（角色 / 地点 / 概念等）</b></div>'));
    if (!nonEventNodes.length) {
        nodesContainer.append('<div class="ai-wbr-token-empty">暂无非事件节点</div>');
    } else {
        const nonEventTable = $('<table class="ai-wbr-memory-table ai-wbr-memory-entity-table"></table>');
        nonEventTable.append('<thead><tr><th>标题</th><th>类型</th><th>说明</th><th>关键词 / 标签</th><th>操作</th></tr></thead>');
        const nonEventBody = $('<tbody></tbody>');
        for (const node of nonEventNodes) {
            nonEventBody.append(
                $('<tr></tr>')
                    .attr('data-memory-node-id', node.id)
                    .append($('<td></td>').append(
                        $('<input class="text_pole" type="text" data-memory-node-field="title" />').val(node.title || ''),
                    ))
                    .append($('<td></td>').append(
                        createNodeTypeSelect('data-memory-node-field', node.type || 'character'),
                    ))
                    .append($('<td></td>').append(
                        $('<textarea class="text_pole ai-wbr-memory-content" rows="3" data-memory-node-field="content"></textarea>').val(node.content || ''),
                    ))
                    .append($('<td></td>').append(
                        $('<input class="text_pole" type="text" data-memory-node-field="keys" placeholder="关键词，用逗号分隔" />').val((node.keys || []).join('，')),
                        $('<input class="text_pole m-t-05" type="text" data-memory-node-field="tags" placeholder="标签，用逗号分隔" />').val((node.tags || []).join('，')),
                    ))
                    .append($('<td></td>').append(
                        $('<button class="menu_button ai-wbr-memory-delete-node" type="button">删除</button>'),
                    )),
            );
        }
        nonEventTable.append(nonEventBody);
        nodesContainer.append($('<div class="ai-wbr-memory-table-wrap"></div>').append(nonEventTable));
    }

    const linksContainer = $('#ai_wbr_memory_links').empty();
    linksContainer.append($('<div class="ai-wbr-memory-subtitle"><b>关系边</b></div>'));
    if (!graph.links.length) {
        linksContainer.append('<div class="ai-wbr-token-empty">暂无关系</div>');
    }
    for (const link of graph.links) {
        const source = graph.nodes.find(node => node.id === link.source)?.title || link.source;
        const target = graph.nodes.find(node => node.id === link.target)?.title || link.target;
        linksContainer.append(
            $('<div class="ai-wbr-memory-link-card"></div>')
                .attr('data-memory-link-id', link.id)
                .toggleClass('ai-wbr-memory-link-card-selected', String(link.id) === String(memoryGraphSelectedLinkId))
                .append($('<div class="ai-wbr-memory-link-title"></div>').text(`${source} → ${target}`))
                .append($('<div class="ai-wbr-memory-link-grid"></div>')
                    .append(createLinkTypeSelect('data-memory-link-field', link.type || 'RELATED'))
                    .append($('<input class="text_pole" type="number" min="0" max="1" step="0.05" data-memory-link-field="weight" />').val(link.weight ?? 0.7))
                    .append($('<button class="menu_button ai-wbr-memory-delete-link" type="button">删除</button>')))
                .append($('<input class="text_pole" type="text" data-memory-link-field="description" placeholder="关系描述" />').val(link.description || '')),
        );
    }
}

function renderMemoryNodeEditor(graph) {
    const editor = $('#ai_wbr_memory_node_editor').empty();
    const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
    const selectedNode = nodes.find(node => node.id === memoryGraphSelectedNodeId) || null;
    const sourceTitle = memoryGraphLinkSourceId
        ? nodes.find(item => item.id === memoryGraphLinkSourceId)?.title || memoryGraphLinkSourceId
        : '';
    const hasRelatedLink = !!(memoryGraphLinkSourceId && selectedNode && memoryGraphLinkSourceId !== selectedNode.id
        && graph.links.some(item => item.source === memoryGraphLinkSourceId && item.target === selectedNode.id && item.type === 'RELATED'));

    editor.append('<div class="ai-wbr-memory-subtitle"><b>节点编辑器</b></div>');

    if (!selectedNode) {
        editor.append('<div class="ai-wbr-token-empty">点击上方图谱节点后，这里会显示该节点的可编辑信息。</div>');
        return;
    }

    editor
        .attr('data-memory-node-id', selectedNode.id)
        .append(
            $('<div class="ai-wbr-memory-node-editor-card"></div>')
                .append($('<div class="ai-wbr-memory-node-editor-title"></div>').text(selectedNode.title || selectedNode.id))
                .append($('<div class="ai-wbr-memory-node-editor-grid"></div>')
                    .append(
                        $('<label class="ai-wbr-memory-node-editor-field"></label>')
                            .append('<span>标题</span>')
                            .append($('<input class="text_pole" type="text" data-memory-editor-field="title" />').val(selectedNode.title || '')),
                    )
                    .append(
                        $('<label class="ai-wbr-memory-node-editor-field"></label>')
                            .append('<span>类型</span>')
                            .append(createNodeTypeSelect('data-memory-editor-field', selectedNode.type || 'event')),
                    )
                    .append(
                        $('<label class="ai-wbr-memory-node-editor-field ai-wbr-memory-node-editor-field-wide"></label>')
                            .append('<span>内容</span>')
                            .append($('<textarea class="text_pole" rows="4" data-memory-editor-field="content"></textarea>').val(selectedNode.content || '')),
                    )
                    .append(
                        $('<label class="ai-wbr-memory-node-editor-field"></label>')
                            .append('<span>关键词</span>')
                            .append($('<input class="text_pole" type="text" data-memory-editor-field="keys" placeholder="用逗号分隔" />').val((selectedNode.keys || []).join('，'))),
                    )
                    .append(
                        $('<label class="ai-wbr-memory-node-editor-field"></label>')
                            .append('<span>标签</span>')
                            .append($('<input class="text_pole" type="text" data-memory-editor-field="tags" placeholder="用逗号分隔" />').val((selectedNode.tags || []).join('，'))),
                    ),
                )
                .append(
                    $('<div class="ai-wbr-memory-popover-actions"></div>')
                        .append('<button class="menu_button ai-wbr-memory-editor-save" type="button">保存</button>')
                        .append('<button class="menu_button ai-wbr-memory-editor-set-link-source" type="button">设为起点</button>')
                        .append($(`<button class="menu_button ai-wbr-memory-editor-link-to-source" type="button" ${memoryGraphLinkSourceId && memoryGraphLinkSourceId !== selectedNode.id ? '' : 'disabled'}>${hasRelatedLink ? '取消连线' : '连接到起点'}${sourceTitle ? `：${escapeHtml(truncateText(sourceTitle, 10))}` : ''}</button>`))
                        .append('<button class="menu_button ai-wbr-memory-editor-delete" type="button">删除</button>'),
                ),
        );
}

function renderMemoryEdgeEditor(graph) {
    const editor = $('#ai_wbr_memory_edge_editor').empty();
    const links = Array.isArray(graph?.links) ? graph.links : [];
    const selectedLink = links.find(link => String(link.id) === String(memoryGraphSelectedLinkId)) || null;
    editor.append('<div class="ai-wbr-memory-subtitle"><b>关系编辑器</b></div>');

    if (!selectedLink) {
        editor.append('<div class="ai-wbr-token-empty">点击图上的关系线，或下方关系卡片后，这里会显示该关系的可编辑信息。</div>');
        return;
    }

    const sourceTitle = graph.nodes.find(node => node.id === selectedLink.source)?.title || selectedLink.source;
    const targetTitle = graph.nodes.find(node => node.id === selectedLink.target)?.title || selectedLink.target;

    editor.append(
        $('<div class="ai-wbr-memory-node-editor-card"></div>')
            .attr('data-memory-link-id', selectedLink.id)
            .append($('<div class="ai-wbr-memory-node-editor-title"></div>').text(`${sourceTitle} → ${targetTitle}`))
                .append($('<div class="ai-wbr-memory-node-editor-grid"></div>')
                    .append(
                        $('<label class="ai-wbr-memory-node-editor-field"></label>')
                            .append('<span>关系类型</span>')
                            .append(createLinkTypeSelect('data-memory-edge-field', selectedLink.type || 'RELATED')),
                    )
                .append(
                    $('<label class="ai-wbr-memory-node-editor-field"></label>')
                        .append('<span>权重</span>')
                        .append($('<input class="text_pole" type="number" min="0" max="1" step="0.05" data-memory-edge-field="weight" />').val(selectedLink.weight ?? 0.7)),
                )
                .append(
                    $('<label class="ai-wbr-memory-node-editor-field ai-wbr-memory-node-editor-field-wide"></label>')
                        .append('<span>关系描述</span>')
                        .append($('<textarea class="text_pole" rows="3" data-memory-edge-field="description"></textarea>').val(selectedLink.description || '')),
                ),
            )
            .append(
                $('<div class="ai-wbr-memory-popover-actions"></div>')
                    .append('<button class="menu_button ai-wbr-memory-edge-save" type="button">保存</button>')
                    .append('<button class="menu_button ai-wbr-memory-edge-delete" type="button">删除这条线</button>'),
            ),
    );
}

function bindMemoryPanelActions() {
    bindCheckbox('#ai_wbr_memory_enabled', 'memoryEnabled');
    bindCheckbox('#ai_wbr_memory_auto_run', 'memoryAutoRun');
    bindCheckbox('#ai_wbr_memory_inject_to_router', 'memoryInjectToRouter');
    bindCheckbox('#ai_wbr_memory_debug', 'memoryDebug');
    bindCheckbox('#ai_wbr_memory_scope_debug', 'memoryScopeDebug');
    bindNumber('#ai_wbr_memory_auto_run_interval', 'memoryAutoRunInterval', 1, 100);
    bindNumber('#ai_wbr_memory_scan_messages', 'memoryScanMessages', 2, 40);
    bindNumber('#ai_wbr_memory_retries', 'memoryRetries', 0, 10);
    bindNumber('#ai_wbr_memory_max_nodes', 'memoryMaxNodes', 5, 200);
    bindNumber('#ai_wbr_memory_max_links', 'memoryMaxLinks', 0, 400);

    $('#ai_wbr_memory_run_now').on('click', async (event) => {
        event.preventDefault();
        await runMemoryGraphUpdate('manual');
    });

    $('#ai_wbr_memory_save_json').on('click', (event) => {
        event.preventDefault();
        try {
            const parsed = JSON.parse(String($('#ai_wbr_memory_json').val() || '{}'));
            const nextGraph = {
                ...getDefaultMemoryGraph(),
                ...parsed,
            };
            saveMemoryGraph(nextGraph);
            toastr.success('记忆 JSON 已保存', '世界书读取');
        } catch (error) {
            toastr.error(`JSON 解析失败：${error.message || error}`, '世界书读取');
        }
    });

    $('#ai_wbr_memory_clear').on('click', (event) => {
        event.preventDefault();
        if (!confirm('确定清空当前轻量记忆图谱？')) {
            return;
        }
        saveMemoryGraph(getDefaultMemoryGraph());
        setCurrentMemoryLastTurnSignature('');
        setCurrentMemoryLastPrompt('');
        setCurrentMemoryLastRaw('');
        setCurrentMemoryLastError('');
        setMemoryStatus('已清空');
    });

    $('#ai_worldbook_router_settings')
        .on('click', '#ai_wbr_memory_node_popover, #ai_wbr_memory_node_popover *', function (event) {
            event.stopPropagation();
        })
        .on('input change', '[data-memory-state-field]', function () {
            const graph = getMemoryGraph();
            const field = String($(this).data('memoryStateField'));
            const value = String($(this).val() || '').trim();
            if (field === 'active_topics' || field === 'open_questions') {
                graph.state[field] = uniqueStrings(value.split(/[,\n，、]+/u)).slice(0, 12);
            } else if (field.startsWith('custom_')) {
                graph.state.custom_values = graph.state.custom_values && typeof graph.state.custom_values === 'object'
                    ? graph.state.custom_values
                    : {};
                graph.state.custom_values[field] = truncateText(value, 220);
            } else {
                graph.state[field] = value;
            }
            graph.updatedAt = new Date().toISOString();
            saveMemoryGraph(graph);
            $('#ai_wbr_memory_json').val(JSON.stringify(graph, null, 2));
            renderMemoryGraphSvg(graph);
        })
        .on('click', '#ai_wbr_memory_add_state_definition', function () {
            const graph = getMemoryGraph();
            const label = String($('#ai_wbr_memory_new_state_label').val() || '').trim();
            const instruction = String($('#ai_wbr_memory_new_state_instruction').val() || '').trim();
            if (!label) {
                toastr.warning('请先填写字段名', '世界书读取');
                return;
            }
            const definition = normalizeMemoryStateDefinition({ label, instruction }, getCustomMemoryStateDefinitions(graph).length);
            graph.stateDefinitions = getCustomMemoryStateDefinitions(graph);
            if (graph.stateDefinitions.some(item => item.key === definition.key || item.label === definition.label)) {
                toastr.warning('已存在同名或同 key 的状态字段', '世界书读取');
                return;
            }
            graph.stateDefinitions.push(definition);
            graph.state.custom_values = graph.state.custom_values && typeof graph.state.custom_values === 'object'
                ? graph.state.custom_values
                : {};
            graph.state.custom_values[definition.key] = '';
            graph.updatedAt = new Date().toISOString();
            saveMemoryGraph(graph);
            $('#ai_wbr_memory_new_state_label').val('');
            $('#ai_wbr_memory_new_state_instruction').val('');
        })
        .on('click', '.ai-wbr-memory-delete-state-definition', function () {
            const graph = getMemoryGraph();
            const key = String($(this).data('memoryStateDefinitionKey') || '');
            graph.stateDefinitions = getCustomMemoryStateDefinitions(graph).filter(item => item.key !== key);
            if (graph.state.custom_values && typeof graph.state.custom_values === 'object') {
                delete graph.state.custom_values[key];
            }
            graph.updatedAt = new Date().toISOString();
            saveMemoryGraph(graph);
        })
        .on('input change', '[data-memory-node-field]', function () {
            const graph = getMemoryGraph();
            const card = $(this).closest('[data-memory-node-id]');
            const node = graph.nodes.find(item => item.id === String(card.data('memoryNodeId')));
            if (!node) {
                return;
            }
            const field = String($(this).data('memoryNodeField'));
            const value = String($(this).val() || '');
            if (field === 'tags') {
                node.tags = uniqueStrings(value.split(/[,\n，、]+/u));
            } else if (field === 'keys') {
                node.keys = uniqueStrings(value.split(/[,\n，、]+/u));
            } else if (field === 'title' || field === 'type' || field === 'content') {
                node[field] = value;
            } else if (field === 'summary' || field === 'location' || field === 'timeSpan') {
                node[field] = value.trim();
            }
            node.updatedAt = new Date().toISOString();
            graph.updatedAt = node.updatedAt;
            saveMemoryGraph(graph);
            $('#ai_wbr_memory_json').val(JSON.stringify(graph, null, 2));
            renderMemoryGraphSvg(graph);
        })
        .on('input change', '[data-memory-link-field]', function () {
            const graph = getMemoryGraph();
            const card = $(this).closest('[data-memory-link-id]');
            const link = graph.links.find(item => String(item.id) === String(card.data('memoryLinkId')));
            if (!link) {
                return;
            }
            const field = String($(this).data('memoryLinkField'));
            if (field === 'weight') {
                link.weight = clampNumber($(this).val(), link.weight || 0.7, 0, 1);
            } else {
                link[field] = String($(this).val() || '');
            }
            link.updatedAt = new Date().toISOString();
            graph.updatedAt = link.updatedAt;
            saveMemoryGraph(graph);
            $('#ai_wbr_memory_json').val(JSON.stringify(graph, null, 2));
            renderMemoryGraphSvg(graph);
        })
        .on('click', '.ai-wbr-memory-link-card', function (event) {
            if ($(event.target).closest('input, textarea, button, select').length) {
                return;
            }
            memoryGraphSelectedLinkId = String($(this).data('memoryLinkId') || '');
            renderMemoryPanel();
        })
        .on('input change', '[data-memory-edge-field]', function () {
            const graph = getMemoryGraph();
            const link = graph.links.find(item => String(item.id) === String(memoryGraphSelectedLinkId));
            if (!link) {
                return;
            }
            const field = String($(this).data('memoryEdgeField'));
            if (field === 'weight') {
                link.weight = clampNumber($(this).val(), link.weight || 0.7, 0, 1);
            } else {
                link[field] = String($(this).val() || '');
            }
            link.updatedAt = new Date().toISOString();
            graph.updatedAt = link.updatedAt;
            saveMemoryGraph(graph);
        })
        .on('click', '.ai-wbr-memory-edge-save', function () {
            const graph = getMemoryGraph();
            const link = graph.links.find(item => String(item.id) === String(memoryGraphSelectedLinkId));
            if (!link) {
                return;
            }
            link.updatedAt = new Date().toISOString();
            graph.updatedAt = link.updatedAt;
            saveMemoryGraph(graph);
            toastr.success('关系已保存', '世界书读取');
        })
        .on('click', '.ai-wbr-memory-edge-delete', function () {
            const graph = getMemoryGraph();
            const id = String(memoryGraphSelectedLinkId || '');
            graph.links = graph.links.filter(link => String(link.id) !== id);
            memoryGraphSelectedLinkId = '';
            graph.updatedAt = new Date().toISOString();
            saveMemoryGraph(graph);
        })
        .on('input change', '[data-memory-editor-field]', function () {
            const graph = getMemoryGraph();
            const node = graph.nodes.find(item => item.id === memoryGraphSelectedNodeId);
            if (!node) {
                return;
            }
            const field = String($(this).data('memoryEditorField'));
            const value = String($(this).val() || '');
            if (field === 'tags') {
                node.tags = uniqueStrings(value.split(/[,\n，、]+/u));
            } else if (field === 'keys') {
                node.keys = uniqueStrings(value.split(/[,\n，、]+/u));
            } else {
                node[field] = value;
            }
            node.updatedAt = new Date().toISOString();
            graph.updatedAt = node.updatedAt;
            saveMemoryGraph(graph);
        })
        .on('click', '.ai-wbr-memory-editor-save', function () {
            const graph = getMemoryGraph();
            const node = graph.nodes.find(item => item.id === memoryGraphSelectedNodeId);
            if (!node) {
                return;
            }
            node.updatedAt = new Date().toISOString();
            graph.updatedAt = node.updatedAt;
            saveMemoryGraph(graph);
            toastr.success('节点已保存', '世界书读取');
        })
        .on('click', '.ai-wbr-memory-editor-set-link-source', function () {
            if (!memoryGraphSelectedNodeId) {
                return;
            }
            memoryGraphLinkSourceId = memoryGraphSelectedNodeId;
            renderMemoryPanel();
        })
        .on('click', '.ai-wbr-memory-editor-link-to-source', function () {
            const graph = getMemoryGraph();
            const targetId = memoryGraphSelectedNodeId;
            if (!memoryGraphLinkSourceId || !targetId || memoryGraphLinkSourceId === targetId) {
                return;
            }
            const existingIndex = graph.links.findIndex(item => item.source === memoryGraphLinkSourceId && item.target === targetId && item.type === 'RELATED');
            if (existingIndex >= 0) {
                graph.links.splice(existingIndex, 1);
                graph.updatedAt = new Date().toISOString();
                saveMemoryGraph(graph);
                memoryGraphLinkSourceId = '';
                renderMemoryPanel();
                return;
            }
            const link = normalizeMemoryLink({
                source: memoryGraphLinkSourceId,
                target: targetId,
                type: 'RELATED',
                weight: 0.7,
                description: '手动创建的记忆关系',
            }, new Set(graph.nodes.map(node => node.id)), graph.links.length);
            if (link && !graph.links.some(item => item.source === link.source && item.target === link.target && item.type === link.type)) {
                graph.links.push(link);
                graph.updatedAt = new Date().toISOString();
                saveMemoryGraph(graph);
            }
            memoryGraphLinkSourceId = '';
            renderMemoryPanel();
        })
        .on('click', '.ai-wbr-memory-editor-delete', function () {
            const graph = getMemoryGraph();
            const id = memoryGraphSelectedNodeId;
            if (!id) {
                return;
            }
            graph.nodes = graph.nodes.filter(node => node.id !== id);
            graph.links = graph.links.filter(link => link.source !== id && link.target !== id);
            if (memoryGraphLinkSourceId === id) {
                memoryGraphLinkSourceId = '';
            }
            memoryGraphSelectedNodeId = '';
            saveMemoryGraph(graph);
        })
        .on('click', '.ai-wbr-memory-delete-node', function () {
            const graph = getMemoryGraph();
            const id = String($(this).closest('[data-memory-node-id]').data('memoryNodeId'));
            graph.nodes = graph.nodes.filter(node => node.id !== id);
            graph.links = graph.links.filter(link => link.source !== id && link.target !== id);
            if (memoryGraphSelectedNodeId === id) {
                memoryGraphSelectedNodeId = '';
            }
            if (memoryGraphLinkSourceId === id) {
                memoryGraphLinkSourceId = '';
            }
            saveMemoryGraph(graph);
        })
        .on('click', '.ai-wbr-memory-delete-link', function () {
            const graph = getMemoryGraph();
            const id = String($(this).closest('[data-memory-link-id]').data('memoryLinkId'));
            graph.links = graph.links.filter(link => String(link.id) !== id);
            if (memoryGraphSelectedLinkId === id) {
                memoryGraphSelectedLinkId = '';
            }
            saveMemoryGraph(graph);
        });
}

function debugLog(...args) {
    if (settings.debug) {
        console.debug(LOG_PREFIX, ...args);
    }
}

function debugRun(candidates, selected, injection, source, routerPrompt = '', routerRaw = '', memoryCandidates = [], selectedMemories = []) {
    lastRun = {
        candidates,
        selected,
        memoryCandidates,
        selectedMemories,
        injectedChars: injection.length,
        injectionText: injection,
        source,
        error: '',
        routerPrompt,
        routerRaw,
    };

    if (settings.debug) {
        console.groupCollapsed(`${LOG_PREFIX} routed wb ${selected.length}/${candidates.length}, memory ${selectedMemories.length}/${memoryCandidates.length}`);
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
        console.debug('Memory candidates:', memoryCandidates.map(entry => ({
            id: entry.routerId,
            title: entry.comment,
            keys: entry.keys.all,
            matchedKeys: entry.matchedKeys,
            score: entry.score,
            type: entry.memoryType,
        })));
        console.debug('Selected memories:', selectedMemories.map(entry => ({
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
        memoryCandidates: [],
        selectedMemories: [],
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

    const mvuSummary = getCombinedStateSummary(context);
    const memoryGraph = getMemoryGraph(context);
    const memoryCandidates = recallMemoryCandidates(memoryGraph, recentMessages, mvuSummary);
    const entries = await getWorldbookEntries(context);
    const wbCandidates = recallCandidates(entries, recentMessages, mvuSummary);

    const combinedCandidates = [...wbCandidates, ...memoryCandidates];

    if (combinedCandidates.length === 0 && !hasMemoryState(memoryGraph)) {
        debugRun([], [], '', `none-${routeSource}`, '', '', [], []);
        lastRouteCompletedAt = Date.now();
        return {
            candidates: wbCandidates,
            selected: [],
            memoryCandidates,
            selectedMemories: [],
            injection: '',
            source: `none-${routeSource}`,
        };
    }

    let selectedWb = [];
    let selectedMem = [];
    let routerPrompt = '';
    let routerRaw = '';
    let source = `ai-${routeSource}`;
    let shouldFallback = false;

    if (combinedCandidates.length) {
        try {
            isRouterSelectionRequest = true;
            const maxSelectCount = settings.maxSelected + MAX_MEMORY_SELECTED;
            const aiResult = await selectWithAi(context, recentMessages, mvuSummary, combinedCandidates, maxSelectCount);
            
            for (const item of aiResult.selected) {
                if (item.source === 'memory') {
                    selectedMem.push(item);
                } else {
                    selectedWb.push(item);
                }
            }
            
            routerPrompt = aiResult.prompt;
            routerRaw = aiResult.rawPreview;
            source = (selectedWb.length || selectedMem.length) ? `ai-${routeSource}` : `empty-ai-${routeSource}`;
        } catch (error) {
            source = `keyword-ai-fallback-${routeSource}`;
            shouldFallback = true;
            console.warn(`${LOG_PREFIX} AI selection failed; falling back to keyword score.`, error);
            routerPrompt = error?.routerPrompt || '';
            routerRaw = error?.routerRaw || error?.message || String(error);
        } finally {
            isRouterSelectionRequest = false;
        }
    }

    if (shouldFallback && !selectedWb.length && !selectedMem.length) {
        selectedWb = selectWithFallback(wbCandidates);
        selectedMem = selectMemoryWithFallback(memoryCandidates);
    }

    if (!combinedCandidates.length && (selectedMem.length || hasMemoryState(memoryGraph))) {
        source = `memory-${routeSource}`;
    }

    const injection = buildInjection(selectedWb, memoryGraph, selectedMem);
    setExtensionPrompt(PROMPT_KEY, injection, settings.position, settings.depth, false, settings.role);
    debugRun(wbCandidates, selectedWb, injection, source, routerPrompt, routerRaw, memoryCandidates, selectedMem);
    lastRouteCompletedAt = Date.now();

    return {
        candidates: wbCandidates,
        selected: selectedWb,
        memoryCandidates,
        selectedMemories: selectedMem,
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

function renderActiveWorldbookSelector(context = getContext()) {
    const container = $('#ai_wbr_active_world_items');
    if (!container.length) {
        return;
    }

    const bindings = getActiveWorldbookBindings(context);
    container.empty();

    if (!bindings.length) {
        container.append('<div class="ai-wbr-token-empty">当前聊天下暂无可识别的生效世界书</div>');
        return;
    }

    for (const binding of bindings) {
        const item = $('<label class="checkbox_label ai-wbr-world-option"></label>');
        const checkbox = $('<input type="checkbox" />')
            .prop('checked', getWorldSelectionState(binding.worldName))
            .attr('data-world-name', binding.worldName)
            .on('input', function () {
                setWorldSelectionState(binding.worldName, !!$(this).prop('checked'));
            });
        item.append(checkbox);
        item.append($('<span></span>').text(binding.worldName));
        item.append($('<small class="ai-wbr-world-source"></small>').text(binding.source));
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

function createFloatingMemoryWindow() {
    if ($('#ai_wbr_fab').length) {
        return;
    }

    const fab = $('<div id="ai_wbr_fab" class="ai-wbr-fab" title="打开记忆图谱"><i class="fa-solid fa-circle-chevron-down"></i></div>');
    const win = $('<div id="ai_wbr_floating_window" class="ai-wbr-floating-window">' +
        '<div class="ai-wbr-floating-header" id="ai_wbr_floating_header">' +
            '<div class="ai-wbr-floating-title"><i class="fa-solid fa-network-wired"></i> 记忆图谱</div>' +
            '<div class="ai-wbr-floating-close" id="ai_wbr_floating_close"><i class="fa-solid fa-times"></i></div>' +
        '</div>' +
        '<div class="ai-wbr-floating-content" id="ai_wbr_floating_content"></div>' +
    '</div>');

    $('body').append(fab).append(win);

    const graph = $('#ai_wbr_memory_graph');
    if (graph.length) {
        graph.appendTo('#ai_wbr_floating_content');
    }

    function toggleWindow() {
        const isOpen = win.hasClass('open');
        if (isOpen) {
            win.removeClass('open').addClass('closing');
            setTimeout(() => {
                win.removeClass('closing');
            }, 220);
        } else {
            win.removeClass('closing').addClass('open');
            renderMemoryPanel();
            setTimeout(renderMemoryPanel, 340);
        }
    }

    let fabDragging = false;
    let fabMoved = false;
    let fabStartX = 0, fabStartY = 0, fabInitialLeft = 0, fabInitialTop = 0;

    fab.on('pointerdown', (e) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        fabDragging = true;
        fabMoved = false;
        fabStartX = e.clientX;
        fabStartY = e.clientY;
        const rect = fab[0].getBoundingClientRect();
        fabInitialLeft = rect.left;
        fabInitialTop = rect.top;
        fab.css({ right: 'auto', bottom: 'auto', left: fabInitialLeft + 'px', top: fabInitialTop + 'px' });
        fab[0].setPointerCapture?.(e.pointerId);
        $('body').css('user-select', 'none');
    });

    $(document).on('pointermove.fabDrag', (e) => {
        if (!fabDragging) return;
        const dx = e.clientX - fabStartX;
        const dy = e.clientY - fabStartY;
        if (!fabMoved && Math.hypot(dx, dy) < 4) return;
        fabMoved = true;
        const rect = fab[0].getBoundingClientRect();
        const maxLeft = Math.max(0, window.innerWidth - rect.width);
        const maxTop = Math.max(0, window.innerHeight - rect.height);
        const newLeft = Math.max(0, Math.min(fabInitialLeft + dx, maxLeft));
        const newTop = Math.max(0, Math.min(fabInitialTop + dy, maxTop));
        fab.css({ left: newLeft + 'px', top: newTop + 'px' });
        e.preventDefault();
    });

    $(document).on('pointerup.fabDrag pointercancel.fabDrag', (e) => {
        if (fabDragging) {
            fabDragging = false;
            fab[0].releasePointerCapture?.(e.pointerId);
            $('body').css('user-select', '');
        }
    });

    fab.on('click', (e) => {
        if (fabMoved) {
            // 拖拽结束，抑制本次开窗
            fabMoved = false;
            e.preventDefault();
            e.stopPropagation();
            return;
        }
        toggleWindow();
    });

    $('#ai_wbr_floating_close').on('click', toggleWindow);

    // ESC 关闭
    $(document).on('keydown', (event) => {
        if (event.key === 'Escape' && win.hasClass('open')) {
            toggleWindow();
        }
    });

    // 拖拽逻辑（仅标题栏触发）
    let isDragging = false;
    let startX, startY, initialLeft, initialTop;

    const header = $('#ai_wbr_floating_header');

    header.on('mousedown', (e) => {
        if ($(e.target).closest('#ai_wbr_floating_close').length) return; // 排除关闭按钮
        isDragging = true;
        startX = e.clientX;
        startY = e.clientY;

        // 把 bottom/right 定位转换为 left/top，便于拖拽
        const rect = win[0].getBoundingClientRect();
        initialLeft = rect.left;
        initialTop = rect.top;

        win.css({
            right: 'auto',
            bottom: 'auto',
            left: initialLeft + 'px',
            top: initialTop + 'px'
        });

        $('body').css('user-select', 'none'); // 拖拽时禁止选中文本
    });

    $(document).on('mousemove', (e) => {
        if (!isDragging) return;

        const dx = e.clientX - startX;
        const dy = e.clientY - startY;

        let newLeft = initialLeft + dx;
        let newTop = initialTop + dy;

        // 限制在视口范围内（用全局 window.innerWidth/innerHeight 取视口尺寸）
        const rect = win[0].getBoundingClientRect();
        const maxLeft = Math.max(0, window.innerWidth - rect.width);
        const maxTop = Math.max(0, window.innerHeight - rect.height);

        newLeft = Math.max(0, Math.min(newLeft, maxLeft));
        newTop = Math.max(0, Math.min(newTop, maxTop));

        win.css({
            left: newLeft + 'px',
            top: newTop + 'px'
        });
    });

    $(document).on('mouseup', () => {
        if (isDragging) {
            isDragging = false;
            $('body').css('user-select', '');
        }
    });
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
    bindNumber('#ai_wbr_main_history_ai_turns', 'mainHistoryAiTurns', 0, 100);
    bindNumber('#ai_wbr_depth', 'depth', 0, 1000);
    bindNumber('#ai_wbr_ai_response_length', 'aiResponseLength', 32, 16384);
    bindNumber('#ai_wbr_router_retries', 'routerRetries', 0, 5);
    bindNumber('#ai_wbr_router_request_max_tokens', 'routerRequestMaxTokens', 32, 100000);
    bindNumber('#ai_wbr_memory_request_max_tokens', 'memoryRequestMaxTokens', 32, 100000);

    bindSelectNumber('#ai_wbr_position', 'position');
    bindSelectNumber('#ai_wbr_role', 'role');
    bindTitleBlocklistEditor();
    bindTextarea('#ai_wbr_system_prompt', 'systemPrompt');
    bindText('#ai_wbr_router_api_url', 'routerApiUrl', normalizeUrl);
    bindText('#ai_wbr_router_api_key', 'routerApiKey', (value) => String(value).trim());
    bindMemoryPanelActions();

    renderRouterModelOptions();
    renderActiveWorldbookSelector();
    $('#ai_wbr_router_model').val(settings.routerModel).on('change', function () {
        saveSetting('routerModel', String($(this).val() || ''));
    });
    $('#ai_wbr_fetch_models').on('click', async (event) => {
        event.preventDefault();
        await fetchRouterModels();
    });
    $('#ai_wbr_router_status').text(settings.routerStatus || '未连接');

    createFloatingMemoryWindow();

    renderDebugPanel();
    renderMemoryPanel();
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
        startChatScopedUiPolling();
        installChatScopedUiRefreshEventHooks();

        eventSource.on(event_types.GENERATION_STARTED, () => {
            isGenerationActive = true;
        });
        eventSource.on(event_types.GENERATION_ENDED, () => {
            isGenerationActive = false;
            scheduleCompatFlush();
            scheduleMemoryGraphUpdate();
        });
        eventSource.on(event_types.GENERATION_STOPPED, () => {
            isGenerationActive = false;
            scheduleCompatFlush();
        });

        eventSource.on(event_types.CHAT_CHANGED, (...args) => {
            rememberChatIdentifierFromEvent(...args);
            pendingCompatSend = false;
            suppressCompatReplay = false;
            lastRun = {
                candidates: [],
                selected: [],
                memoryCandidates: [],
                selectedMemories: [],
                injectedChars: 0,
                injectionText: '',
                source: 'none',
                error: '',
                routerPrompt: '',
                routerRaw: '',
            };
            setExtensionPrompt(PROMPT_KEY, '', settings.position, settings.depth, false, settings.role);
            renderActiveWorldbookSelector();
        });

        debugLog('Loaded');
    } catch (error) {
        console.error(`${LOG_PREFIX} Failed during initialization`, error);
    }
});
