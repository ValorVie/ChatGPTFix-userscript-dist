// ==UserScript==
// @name         ChatGPT 長對話減載
// @namespace    https://github.com/ValorVie/ChatGPTFix
// @version      0.1.0.23
// @description  保留最近 N 則訊息，支援三態 compact panel 與 Load more / Load all
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @run-at       document-start
// @sandbox      JavaScript
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @grant        unsafeWindow
// ==/UserScript==

(() => {
  // src/chatgpt-lag-userscript/settings-store.js
  var DEFAULT_SETTINGS = {
    enabled: true,
    keepLastN: 4,
    loadMoreStep: 10,
    autoReloadEnabled: false,
    debug: false
  };
  function readSetting(gmGetValue, key) {
    if (typeof gmGetValue !== "function") {
      return DEFAULT_SETTINGS[key];
    }
    try {
      return gmGetValue(key, DEFAULT_SETTINGS[key]);
    } catch {
      return DEFAULT_SETTINGS[key];
    }
  }
  function createSettingsStore({ gmGetValue, gmSetValue }) {
    return {
      read() {
        return {
          enabled: readSetting(gmGetValue, "enabled"),
          keepLastN: readSetting(gmGetValue, "keepLastN"),
          loadMoreStep: readSetting(gmGetValue, "loadMoreStep"),
          autoReloadEnabled: readSetting(gmGetValue, "autoReloadEnabled"),
          debug: readSetting(gmGetValue, "debug")
        };
      },
      write(next) {
        if (typeof gmSetValue !== "function") {
          return;
        }
        for (const [key, value] of Object.entries(next ?? {})) {
          if (Object.hasOwn(DEFAULT_SETTINGS, key)) {
            try {
              gmSetValue(key, value);
            } catch {
              return;
            }
          }
        }
      }
    };
  }

  // src/chatgpt-lag-userscript/conversation-state.js
  var STORAGE_KEY = "chatgpt-lag-userscript:conversation-state";
  function createDefaultState(currentUrl) {
    return {
      url: currentUrl,
      extraMessages: 0,
      loadAll: false
    };
  }
  function readRawState(storage) {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) {
      return null;
    }
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  function createConversationState(storage) {
    return {
      read(currentUrl) {
        const parsed = readRawState(storage);
        if (!parsed) {
          return createDefaultState(currentUrl);
        }
        if (parsed.url !== currentUrl) {
          storage.removeItem(STORAGE_KEY);
          return createDefaultState(currentUrl);
        }
        return {
          url: parsed.url,
          extraMessages: parsed.extraMessages ?? 0,
          loadAll: parsed.loadAll ?? false
        };
      },
      write(next) {
        storage.setItem(STORAGE_KEY, JSON.stringify(next));
      },
      reset(currentUrl) {
        storage.setItem(STORAGE_KEY, JSON.stringify(createDefaultState(currentUrl)));
      }
    };
  }

  // src/chatgpt-lag-userscript/request-matcher.js
  var DETAIL_PATH_RE = /^\/backend-api\/(conversation|shared_conversation)\/[^/]+\/?$/;
  var ALLOWED_HOSTS = /* @__PURE__ */ new Set(["chatgpt.com", "chat.openai.com"]);
  var DIRECT_CONVERSATION_PATH_RE = /^\/c\/([^/]+)\/?$/;
  var PROJECT_CONVERSATION_PATH_RE = /^\/g\/[^/]+\/c\/([^/]+)\/?$/;
  function parseChatGptUrl(url) {
    try {
      return new URL(url, "https://chatgpt.com");
    } catch {
      return null;
    }
  }
  function isAllowedChatGptHost(parsedUrl) {
    if (!parsedUrl) {
      return false;
    }
    return ALLOWED_HOSTS.has(parsedUrl.hostname);
  }
  function extractConversationId(url) {
    const parsedUrl = parseChatGptUrl(url);
    if (!parsedUrl || !isAllowedChatGptHost(parsedUrl)) {
      return null;
    }
    const directConversationMatch = parsedUrl.pathname.match(DIRECT_CONVERSATION_PATH_RE);
    if (directConversationMatch) {
      return directConversationMatch[1];
    }
    const projectConversationMatch = parsedUrl.pathname.match(PROJECT_CONVERSATION_PATH_RE);
    return projectConversationMatch?.[1] ?? null;
  }
  function isConversationRequest(method, url) {
    if (String(method).toUpperCase() !== "GET") {
      return false;
    }
    const parsedUrl = parseChatGptUrl(url);
    return Boolean(parsedUrl) && isAllowedChatGptHost(parsedUrl) && DETAIL_PATH_RE.test(parsedUrl.pathname);
  }

  // src/chatgpt-lag-userscript/fetch-hook.js
  function getRequestUrl(input) {
    if (input instanceof Request) {
      return input.url;
    }
    return String(input);
  }
  function getRequestMethod(input, init) {
    if (init?.method) {
      return String(init.method).toUpperCase();
    }
    if (input instanceof Request && input.method) {
      return input.method.toUpperCase();
    }
    return "GET";
  }
  function isJsonResponse(response) {
    const contentType = response.headers.get("content-type") ?? "";
    return contentType.includes("application/json");
  }
  function createFetchInterceptor({
    nativeFetch,
    getCurrentUrl = () => globalThis.location?.href ?? "",
    getRuntimeConfig: getRuntimeConfig2,
    trimConversationMapping: trimConversationMapping2,
    dispatchStatus: dispatchStatus2,
    log: log2 = () => {
    }
  }) {
    return async function interceptedFetch(input, init) {
      const requestUrl = getRequestUrl(input);
      const method = getRequestMethod(input, init);
      if (!isConversationRequest(method, requestUrl)) {
        return nativeFetch(input, init);
      }
      log2("debug", "matched conversation request", {
        method,
        requestUrl
      });
      const pageUrl = getCurrentUrl();
      const conversationId = extractConversationId(pageUrl);
      const runtimeConfig = getRuntimeConfig2();
      if (!runtimeConfig.enabled || runtimeConfig.loadAll) {
        log2("debug", "skipped trimming for request", {
          enabled: runtimeConfig.enabled,
          loadAll: runtimeConfig.loadAll
        });
        return nativeFetch(input, init);
      }
      const response = await nativeFetch(input, init);
      if (!isJsonResponse(response)) {
        log2("warn", "received non-json conversation response", {
          contentType: response.headers.get("content-type") ?? ""
        });
        return response;
      }
      const payload = await response.clone().json().catch(() => null);
      if (!payload?.mapping || !payload?.current_node) {
        log2("warn", "conversation payload missing expected shape");
        return response;
      }
      const effectiveLimit = Math.max(
        1,
        Number(runtimeConfig.keepLastN ?? 0) + Number(runtimeConfig.extraMessages ?? 0)
      );
      try {
        const trimmed = trimConversationMapping2(payload, effectiveLimit);
        if (!trimmed) {
          log2("warn", "trim returned null; using original response");
          return response;
        }
        dispatchStatus2({
          pageUrl,
          conversationId,
          totalMessages: trimmed.visibleTotal,
          renderedMessages: trimmed.visibleKept,
          hasOlderMessages: trimmed.hasOlderMessages,
          effectiveLimit
        });
        log2("debug", "trim applied", {
          effectiveLimit,
          visibleTotal: trimmed.visibleTotal,
          visibleKept: trimmed.visibleKept,
          hasOlderMessages: trimmed.hasOlderMessages
        });
        return new Response(
          JSON.stringify({
            ...payload,
            mapping: trimmed.mapping,
            current_node: trimmed.current_node,
            root: trimmed.root
          }),
          {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers
          }
        );
      } catch (error) {
        log2("error", "trim pipeline failed; using original response", {
          error: error instanceof Error ? error.message : String(error)
        });
        return response;
      }
    };
  }

  // src/chatgpt-lag-userscript/trim-engine.js
  var HIDDEN_ROLES = /* @__PURE__ */ new Set(["system", "tool", "thinking"]);
  function isVisibleNode(node) {
    const role = node?.message?.author?.role;
    return Boolean(role) && !HIDDEN_ROLES.has(role);
  }
  function trimConversationMapping(data, limit) {
    const mapping = data?.mapping;
    const currentNode = data?.current_node;
    if (!mapping || !currentNode || !mapping[currentNode]) {
      return null;
    }
    const path = [];
    const visited = /* @__PURE__ */ new Set();
    let cursor = currentNode;
    while (cursor && mapping[cursor] && !visited.has(cursor)) {
      visited.add(cursor);
      path.push(cursor);
      cursor = mapping[cursor].parent ?? null;
    }
    path.reverse();
    const keepCount = Math.max(1, limit);
    const keptGroups = [];
    let visibleTotal = 0;
    let lastVisibleRole = null;
    for (const id of path) {
      if (!isVisibleNode(mapping[id])) {
        continue;
      }
      const role = mapping[id]?.message?.author?.role;
      const lastGroup = keptGroups.at(-1);
      if (role === lastVisibleRole && lastGroup) {
        lastGroup.ids.push(id);
        continue;
      }
      visibleTotal += 1;
      lastVisibleRole = role;
      keptGroups.push({ role, ids: [id] });
      if (keptGroups.length > keepCount) {
        keptGroups.shift();
      }
    }
    const keptVisibleIds = keptGroups.flatMap((group) => group.ids);
    if (keptVisibleIds.length === 0) {
      return null;
    }
    const requestedRootId = data?.root;
    const rootId = requestedRootId && mapping[requestedRootId] && visited.has(requestedRootId) ? requestedRootId : path[0];
    const trimmedIds = rootId === keptVisibleIds[0] ? [...keptVisibleIds] : [rootId, ...keptVisibleIds];
    const nextMapping = {};
    trimmedIds.forEach((id, index) => {
      const node = mapping[id];
      if (!node) {
        return;
      }
      nextMapping[id] = {
        ...node,
        parent: index === 0 ? null : trimmedIds[index - 1],
        children: trimmedIds[index + 1] ? [trimmedIds[index + 1]] : []
      };
    });
    return {
      mapping: nextMapping,
      current_node: keptVisibleIds.at(-1),
      root: rootId,
      visibleTotal,
      visibleKept: keptGroups.length,
      hasOlderMessages: keptGroups.length < visibleTotal
    };
  }

  // src/chatgpt-lag-userscript/runtime-events.js
  var STATUS_EVENT = "chatgpt-lag-userscript:status";
  function dispatchStatus(detail) {
    window.dispatchEvent(new CustomEvent(STATUS_EVENT, { detail }));
  }
  function subscribeStatus(listener) {
    window.addEventListener(STATUS_EVENT, listener);
    return () => window.removeEventListener(STATUS_EVENT, listener);
  }

  // src/chatgpt-lag-userscript/panel-action-contract.js
  var DEFAULT_VARIANT = "secondary";
  function normalizeVariant(variant) {
    return variant === "primary" ? "primary" : DEFAULT_VARIANT;
  }
  function createPanelAction(action = {}) {
    return {
      id: String(action.id ?? ""),
      label: String(action.label ?? ""),
      variant: normalizeVariant(action.variant),
      onSelect: typeof action.onSelect === "function" ? action.onSelect : null
    };
  }
  function normalizePanelActions(actions = []) {
    return actions.filter((action) => action?.id && action?.label).map((action) => createPanelAction(action));
  }

  // src/chatgpt-lag-userscript/panel-adapters/v1-panel-actions.js
  function createV1PanelActions({
    runtimeMode,
    hasOlderMessages,
    loadAll,
    loadMoreStep,
    onLoadMore,
    onLoadAll,
    onBackToTrimmed,
    onEnableTrimming
  } = {}) {
    if (runtimeMode === "disabled") {
      return [
        createPanelAction({
          id: "enable-trimming",
          label: "\u555F\u7528\u7CBE\u7C21\u6A21\u5F0F",
          variant: "primary",
          onSelect: onEnableTrimming
        })
      ];
    }
    if (runtimeMode === "loadAll") {
      return [
        createPanelAction({
          id: "back-to-trimmed",
          label: "\u56DE\u5230\u7CBE\u7C21\u6A21\u5F0F",
          onSelect: onBackToTrimmed
        })
      ];
    }
    const actions = [];
    if (hasOlderMessages && !loadAll) {
      actions.push(
        createPanelAction({
          id: "load-more",
          label: `\u518D\u8F09\u5165 ${Number(loadMoreStep ?? 0)} \u5247`,
          variant: "primary",
          onSelect: onLoadMore
        })
      );
      actions.push(
        createPanelAction({
          id: "load-all",
          label: "\u5168\u90E8\u8F09\u5165",
          onSelect: onLoadAll
        })
      );
    }
    if (runtimeMode === "extended") {
      actions.push(
        createPanelAction({
          id: "back-to-trimmed",
          label: "\u56DE\u5230\u7CBE\u7C21\u6A21\u5F0F",
          onSelect: onBackToTrimmed
        })
      );
    }
    return actions;
  }

  // src/chatgpt-lag-userscript/panel-view-model.js
  var PANEL_MODES = /* @__PURE__ */ new Set(["launcher", "conversation-pending", "conversation-ready"]);
  function normalizeRuntimeMode(runtimeMode) {
    if (runtimeMode === "disabled" || runtimeMode === "loadAll" || runtimeMode === "extended") {
      return runtimeMode;
    }
    return "trimmed";
  }
  function normalizePanelMode(panelMode) {
    return PANEL_MODES.has(panelMode) ? panelMode : "conversation-ready";
  }
  function getPanelTitle(panelMode, runtimeMode) {
    if (panelMode === "launcher") {
      return "\u555F\u52D5\u5668";
    }
    if (panelMode === "conversation-pending") {
      return "\u5C0D\u8A71\u5F85\u547D";
    }
    if (runtimeMode === "loadAll") {
      return "\u5B8C\u6574\u8F09\u5165\u6A21\u5F0F";
    }
    if (runtimeMode === "disabled") {
      return "\u5DF2\u505C\u7528";
    }
    return "\u7CBE\u7C21\u6A21\u5F0F";
  }
  function getStatusText(panelMode, runtimeMode, effectiveLimit, extraMessages, monitor) {
    if (panelMode === "launcher") {
      return "\u76EE\u524D\u986F\u793A\u5168\u57DF\u555F\u52D5\u5668\u3002";
    }
    if (panelMode === "conversation-pending") {
      return "\u5DF2\u9032\u5165\u5C0D\u8A71\u9801\uFF0C\u7B49\u5F85 runtime status\u3002";
    }
    if (runtimeMode === "disabled") {
      return "\u76EE\u524D\u5DF2\u505C\u7528\uFF0C\u5C07\u7DAD\u6301\u5B8C\u6574\u8F09\u5165\u3002";
    }
    if (runtimeMode === "loadAll") {
      return "\u76EE\u524D\u70BA\u5B8C\u6574\u8F09\u5165\u6A21\u5F0F\u3002";
    }
    if (runtimeMode === "extended") {
      return `\u76EE\u524D\u5DF2\u984D\u5916\u8F09\u5165 ${extraMessages} \u5247\u3002`;
    }
    if (monitor && (monitor.phase === "warned" || monitor.phase === "arming" || monitor.phase === "countdown") && Number.isFinite(monitor.bubbleCount) && monitor.bubbleCount >= Number(monitor.warningThreshold ?? 0)) {
      return `\u76EE\u524D\u4FDD\u7559\u6700\u8FD1 ${effectiveLimit} \u5247\u3002\u5C0D\u8A71\u5DF2\u9054 ${monitor.bubbleCount} \u5247\uFF0C\u5EFA\u8B70\u91CD\u65B0\u6574\u7406\u4EE5\u7DAD\u6301\u6D41\u66A2\u3002`;
    }
    return `\u76EE\u524D\u4FDD\u7559\u6700\u8FD1 ${effectiveLimit} \u5247\u3002`;
  }
  function getCollapsedSummary({
    panelMode,
    runtimeMode,
    totalMessages,
    renderedMessages,
    extraMessages,
    effectiveLimit
  }) {
    if (panelMode === "launcher") {
      return "LAUNCHER";
    }
    if (panelMode === "conversation-pending") {
      return "PENDING";
    }
    if (runtimeMode === "loadAll") {
      return "ALL";
    }
    if (runtimeMode === "disabled") {
      return "OFF";
    }
    if (runtimeMode === "extended") {
      return `+${extraMessages}`;
    }
    const visibleCount = Number.isFinite(renderedMessages) && renderedMessages > 0 ? renderedMessages : effectiveLimit;
    if (Number.isFinite(totalMessages) && totalMessages > 0) {
      return `${visibleCount}/${totalMessages}`;
    }
    return String(visibleCount);
  }
  function getPanelActions(panelMode, actions) {
    if (panelMode !== "conversation-ready") {
      return [];
    }
    return normalizePanelActions(actions);
  }
  function createPanelViewModel({
    panelMode,
    runtimeMode,
    effectiveLimit = 0,
    extraMessages = 0,
    totalMessages = 0,
    renderedMessages = 0,
    monitor = null,
    onReloadNow = null,
    actions = []
  } = {}) {
    const normalizedPanelMode = normalizePanelMode(panelMode);
    const normalizedRuntimeMode = normalizedPanelMode === "conversation-ready" ? normalizeRuntimeMode(runtimeMode) : runtimeMode ?? null;
    const viewModel = {
      panelMode: normalizedPanelMode,
      runtimeMode: normalizedRuntimeMode,
      title: getPanelTitle(normalizedPanelMode, normalizedRuntimeMode),
      statusText: getStatusText(
        normalizedPanelMode,
        normalizedRuntimeMode,
        effectiveLimit,
        extraMessages,
        monitor
      ),
      collapsedSummary: getCollapsedSummary({
        panelMode: normalizedPanelMode,
        runtimeMode: normalizedRuntimeMode,
        totalMessages,
        renderedMessages,
        extraMessages,
        effectiveLimit
      }),
      actions: getPanelActions(normalizedPanelMode, actions)
    };
    if (typeof onReloadNow === "function") {
      viewModel.onReloadNow = onReloadNow;
    }
    return viewModel;
  }

  // src/chatgpt-lag-userscript/panel-state-store.js
  var DEFAULT_PANEL_STATE = {
    position: { left: 20, top: 20 },
    panelViewState: "expanded",
    lastNonHiddenState: "expanded"
  };
  var PANEL_VIEW_STATES = /* @__PURE__ */ new Set(["expanded", "collapsed", "hidden"]);
  var NON_HIDDEN_PANEL_VIEW_STATES = /* @__PURE__ */ new Set(["expanded", "collapsed"]);
  function clonePosition(position) {
    return {
      left: position?.left ?? DEFAULT_PANEL_STATE.position.left,
      top: position?.top ?? DEFAULT_PANEL_STATE.position.top
    };
  }
  function readSetting2(gmGetValue, key, fallback) {
    if (typeof gmGetValue !== "function") {
      return fallback;
    }
    try {
      return gmGetValue(key, fallback);
    } catch {
      return fallback;
    }
  }
  function normalizePosition(position) {
    return clonePosition(position);
  }
  function normalizePanelViewState(value) {
    return PANEL_VIEW_STATES.has(value) ? value : null;
  }
  function normalizeLastNonHiddenState(value) {
    return NON_HIDDEN_PANEL_VIEW_STATES.has(value) ? value : null;
  }
  function createPanelStateStore({ gmGetValue, gmSetValue }) {
    return {
      read() {
        const position = normalizePosition(
          readSetting2(gmGetValue, "panelPosition", DEFAULT_PANEL_STATE.position)
        );
        const storedPanelViewState = readSetting2(gmGetValue, "panelViewState", void 0);
        const storedCollapsed = readSetting2(gmGetValue, "panelCollapsed", void 0);
        const panelViewState = normalizePanelViewState(storedPanelViewState) ?? (typeof storedCollapsed === "boolean" ? storedCollapsed ? "collapsed" : "expanded" : DEFAULT_PANEL_STATE.panelViewState);
        const lastNonHiddenState = normalizeLastNonHiddenState(readSetting2(gmGetValue, "panelLastNonHiddenState", void 0)) ?? (panelViewState === "hidden" ? "collapsed" : panelViewState);
        return {
          position,
          panelViewState,
          lastNonHiddenState
        };
      },
      write(next) {
        if (typeof gmSetValue !== "function") {
          return;
        }
        if (next?.position !== void 0) {
          try {
            gmSetValue("panelPosition", clonePosition(next.position));
          } catch {
            return;
          }
        }
        const nextPanelViewState = normalizePanelViewState(next?.panelViewState) ?? (typeof next?.collapsed === "boolean" ? next.collapsed ? "collapsed" : "expanded" : null);
        if (nextPanelViewState !== null) {
          try {
            gmSetValue("panelViewState", nextPanelViewState);
          } catch {
            return;
          }
        }
        const nextLastNonHiddenState = normalizeLastNonHiddenState(next?.lastNonHiddenState) ?? (nextPanelViewState && nextPanelViewState !== "hidden" ? nextPanelViewState : null);
        if (nextLastNonHiddenState !== null) {
          try {
            gmSetValue("panelLastNonHiddenState", nextLastNonHiddenState);
          } catch {
            return;
          }
        }
      }
    };
  }

  // raw-svg:/Users/arlen/ChatGPTFix/src/chatgpt-lag-userscript/assets/chatgpt-icon.svg
  var chatgpt_icon_default = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2406 2406" fill="none" aria-hidden="true">\n  <path\n    id="a"\n    d="M1107.3 299.1c-197.999 0-373.9 127.3-435.2 315.3L650 743.5v427.9c0 21.4 11 40.4 29.4 51.4l344.5 198.515V833.3h.1v-27.9L1372.7 604c33.715-19.52 70.44-32.857 108.47-39.828L1447.6 450.3C1361 353.5 1237.1 298.5 1107.3 299.1zm0 117.5-.6.6c79.699 0 156.3 27.5 217.6 78.4-2.5 1.2-7.4 4.3-11 6.1L952.8 709.3c-18.4 10.4-29.4 30-29.4 51.4V1248l-155.1-89.4V755.8c-.1-187.099 151.601-338.9 339-339.2z"\n    fill="currentColor"\n  />\n  <use href="#a" transform="rotate(60 1203 1203)" fill="currentColor" />\n  <use href="#a" transform="rotate(120 1203 1203)" fill="currentColor" />\n  <use href="#a" transform="rotate(180 1203 1203)" fill="currentColor" />\n  <use href="#a" transform="rotate(240 1203 1203)" fill="currentColor" />\n  <use href="#a" transform="rotate(300 1203 1203)" fill="currentColor" />\n</svg>\n';

  // src/chatgpt-lag-userscript/panel-icons.js
  var PANEL_ICON_MARKUP = {
    brand: chatgpt_icon_default.trim(),
    collapse: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M7.5 8h9M7.5 12h9M7.5 16h9" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>',
    expand: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M7 9.25l5 4.75 5-4.75" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    hidden: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="5.5" y="5.5" width="13" height="13" rx="4" stroke="currentColor" stroke-width="1.8"/><path d="M8.6 8.6l6.8 6.8M8.6 15.4l6.8-6.8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    reload: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M19 7.5V4.75m0 0h-2.75M19 4.75l-2.7 2.7a7 7 0 1 0 1.95 5.7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    restore: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 12s2.8-5.5 8-5.5S20 12 20 12s-2.8 5.5-8 5.5S4 12 4 12Z" stroke="currentColor" stroke-width="1.6"/><circle cx="12" cy="12" r="2.8" fill="currentColor"/></svg>'
  };
  var PANEL_STATE_TOGGLE_ICON_NAME = {
    expanded: "collapse",
    collapsed: "expand",
    hidden: "restore"
  };
  var PANEL_STATE_ACTION_LABEL = {
    expanded: "\u7E2E\u5C0F\u9762\u677F",
    collapsed: "\u5C55\u958B\u9762\u677F",
    hidden: "\u6062\u5FA9\u9762\u677F"
  };
  function normalizePanelIconName(name) {
    return Object.prototype.hasOwnProperty.call(PANEL_ICON_MARKUP, name) ? name : "brand";
  }
  function getPanelIconMarkup(name) {
    return PANEL_ICON_MARKUP[normalizePanelIconName(name)];
  }
  function getPanelStateToggleIconName(panelViewState) {
    return PANEL_STATE_TOGGLE_ICON_NAME[panelViewState] ?? "collapse";
  }
  function getPanelStateActionLabel(panelViewState) {
    return PANEL_STATE_ACTION_LABEL[panelViewState] ?? "\u5207\u63DB\u9762\u677F";
  }

  // src/chatgpt-lag-userscript/theme-resolver.js
  function getRoot(doc) {
    return doc?.documentElement ?? null;
  }
  function resolveThemeFromRoot(root) {
    if (!root) {
      return null;
    }
    if (root.classList.contains("dark")) {
      return "dark";
    }
    if (root.classList.contains("light")) {
      return "light";
    }
    if (root.dataset.theme === "dark") {
      return "dark";
    }
    if (root.dataset.theme === "light") {
      return "light";
    }
    return null;
  }
  function getMediaQueryList(matchMedia) {
    if (typeof matchMedia !== "function") {
      return null;
    }
    try {
      return matchMedia("(prefers-color-scheme: dark)");
    } catch {
      return null;
    }
  }
  function resolveTheme(doc, matchMedia) {
    const root = getRoot(doc);
    const explicitTheme = resolveThemeFromRoot(root);
    if (explicitTheme) {
      return explicitTheme;
    }
    const mediaQueryList = getMediaQueryList(matchMedia);
    return mediaQueryList?.matches ? "dark" : "light";
  }
  function subscribeTheme({ doc, matchMedia, onThemeChange }) {
    const root = getRoot(doc);
    const mediaQueryList = getMediaQueryList(matchMedia);
    const getCurrentTheme = () => {
      const explicitTheme = resolveThemeFromRoot(root);
      if (explicitTheme) {
        return explicitTheme;
      }
      return mediaQueryList?.matches ? "dark" : "light";
    };
    let currentTheme = getCurrentTheme();
    const emitIfChanged = () => {
      const nextTheme = getCurrentTheme();
      if (nextTheme !== currentTheme) {
        currentTheme = nextTheme;
        onThemeChange(nextTheme);
      }
    };
    const observer = root ? new MutationObserver(() => {
      emitIfChanged();
    }) : null;
    if (observer && root) {
      observer.observe(root, {
        attributes: true,
        attributeFilter: ["class", "data-theme"]
      });
    }
    const mediaListener = () => {
      emitIfChanged();
    };
    if (mediaQueryList?.addEventListener) {
      mediaQueryList.addEventListener("change", mediaListener);
    } else if (mediaQueryList?.addListener) {
      mediaQueryList.addListener(mediaListener);
    }
    return () => {
      observer?.disconnect();
      if (mediaQueryList?.removeEventListener) {
        mediaQueryList.removeEventListener("change", mediaListener);
      } else if (mediaQueryList?.removeListener) {
        mediaQueryList.removeListener(mediaListener);
      }
    };
  }

  // src/chatgpt-lag-userscript/ui-controls.js
  var PANEL_SELECTOR = '[data-chatgpt-lag-userscript="controls"]';
  var DEFAULT_PANEL_POSITION = 20;
  var PANEL_COMPACT_HEIGHT = 40;
  var PANEL_HIDDEN_WIDTH = PANEL_COMPACT_HEIGHT;
  var COMPACT_VIEWPORT_MAX_WIDTH = 420;
  var COLLAPSED_CLICK_DISTANCE = 6;
  var PANEL_VIEW_STATES2 = /* @__PURE__ */ new Set(["expanded", "collapsed", "hidden"]);
  var BRAND_SLOT_SIZE = 24;
  var BRAND_ICON_SIZE = 16;
  var HEADER_ACTION_BUTTON_SIZE = 26;
  var HEADER_ACTION_ICON_SIZE = 14;
  var DEFAULT_ICON_SIZE = 15;
  var BUTTON_HOVER_TRANSITION = "background-color 140ms ease, color 140ms ease";
  var panelRoot = null;
  var panelController = null;
  var defaultPanelStateStore = null;
  function applyStyles(element, styles) {
    Object.assign(element.style, styles);
    return element;
  }
  function bindBackgroundHoverState(button, defaultBackground, hoverBackground) {
    const applyBackground = (isActive) => {
      button.style.background = isActive ? hoverBackground : defaultBackground;
    };
    button.addEventListener("mouseenter", () => applyBackground(true));
    button.addEventListener("mouseleave", () => applyBackground(false));
    button.addEventListener("focus", () => applyBackground(true));
    button.addEventListener("blur", () => applyBackground(false));
  }
  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }
  function toNumber(value, fallback) {
    const next = Number(value);
    return Number.isFinite(next) ? next : fallback;
  }
  function getViewportSize() {
    return {
      width: Number(globalThis.innerWidth ?? document.documentElement?.clientWidth ?? 0),
      height: Number(globalThis.innerHeight ?? document.documentElement?.clientHeight ?? 0)
    };
  }
  function normalizePosition2(position) {
    return {
      left: toNumber(position?.left, DEFAULT_PANEL_POSITION),
      top: toNumber(position?.top, DEFAULT_PANEL_POSITION)
    };
  }
  function getThemePalette(theme) {
    if (theme === "dark") {
      return {
        background: "rgba(15, 23, 42, 0.96)",
        borderColor: "rgba(148, 163, 184, 0.24)",
        color: "#e2e8f0",
        mutedColor: "rgba(226, 232, 240, 0.78)",
        divider: "rgba(148, 163, 184, 0.18)",
        primaryBackground: "#e2e8f0",
        primaryColor: "#0f172a",
        secondaryBackground: "#1e293b",
        secondaryColor: "#e2e8f0",
        secondaryBorder: "rgba(148, 163, 184, 0.32)",
        shadow: "0 20px 70px rgba(15, 23, 42, 0.45)"
      };
    }
    return {
      background: "rgba(255, 255, 255, 0.96)",
      borderColor: "rgba(15, 23, 42, 0.12)",
      color: "#111827",
      mutedColor: "rgba(17, 24, 39, 0.78)",
      divider: "rgba(15, 23, 42, 0.08)",
      primaryBackground: "#111827",
      primaryColor: "#ffffff",
      secondaryBackground: "#ffffff",
      secondaryColor: "#111827",
      secondaryBorder: "rgba(15, 23, 42, 0.14)",
      shadow: "0 18px 60px rgba(15, 23, 42, 0.18)"
    };
  }
  function getExpandedThemePalette(theme, palette) {
    if (theme === "dark") {
      return {
        ...palette,
        background: "rgb(24, 24, 24)",
        borderColor: "rgba(255, 255, 255, 0.08)",
        color: "#e2e8f0",
        mutedColor: "rgba(226, 232, 240, 0.66)",
        secondaryBackground: "rgba(51, 65, 85, 0.72)",
        secondaryColor: "#e2e8f0",
        secondaryBorder: "rgba(148, 163, 184, 0.16)",
        shadow: "0 10px 24px rgba(2, 6, 23, 0.22)",
        actionPrimaryBackground: "rgba(226, 232, 240, 0.12)",
        actionPrimaryHoverBackground: "rgba(226, 232, 240, 0.18)",
        actionPrimaryColor: "#f8fafc",
        actionPrimaryBorder: "rgba(226, 232, 240, 0.12)",
        actionSecondaryBackground: "rgba(51, 65, 85, 0.68)",
        actionSecondaryHoverBackground: "rgba(71, 85, 105, 0.84)",
        actionSecondaryColor: "rgba(226, 232, 240, 0.9)",
        actionSecondaryBorder: "rgba(148, 163, 184, 0.16)",
        controlColor: "rgba(226, 232, 240, 0.72)",
        controlHoverBackground: "rgba(226, 232, 240, 0.12)"
      };
    }
    return {
      ...palette,
      background: "rgb(249, 249, 249)",
      borderColor: "rgba(15, 23, 42, 0.06)",
      color: "#111827",
      mutedColor: "rgba(51, 65, 85, 0.66)",
      secondaryBackground: "rgba(241, 245, 249, 0.9)",
      secondaryColor: "#111827",
      secondaryBorder: "rgba(148, 163, 184, 0.22)",
      shadow: "0 8px 18px rgba(15, 23, 42, 0.08)",
      actionPrimaryBackground: "rgba(15, 23, 42, 0.05)",
      actionPrimaryHoverBackground: "rgba(15, 23, 42, 0.08)",
      actionPrimaryColor: "#111827",
      actionPrimaryBorder: "rgba(15, 23, 42, 0.08)",
      actionSecondaryBackground: "rgba(248, 250, 252, 0.92)",
      actionSecondaryHoverBackground: "rgba(226, 232, 240, 0.92)",
      actionSecondaryColor: "rgba(17, 24, 39, 0.88)",
      actionSecondaryBorder: "rgba(148, 163, 184, 0.2)",
      controlColor: "rgba(51, 65, 85, 0.72)",
      controlHoverBackground: "rgba(15, 23, 42, 0.05)"
    };
  }
  function createActionButton(label, onClick, palette, variant = "secondary", compact = false) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    if (typeof onClick === "function") {
      button.addEventListener("click", onClick);
    }
    const background = compact && variant === "primary" ? palette.actionPrimaryBackground ?? palette.primaryBackground : compact ? palette.actionSecondaryBackground ?? palette.secondaryBackground : variant === "primary" ? palette.primaryBackground : palette.secondaryBackground;
    const color = compact && variant === "primary" ? palette.actionPrimaryColor ?? palette.primaryColor : compact ? palette.actionSecondaryColor ?? palette.secondaryColor : variant === "primary" ? palette.primaryColor : palette.secondaryColor;
    const border = compact && variant === "primary" ? palette.actionPrimaryBorder ?? palette.secondaryBorder : compact ? palette.actionSecondaryBorder ?? palette.secondaryBorder : variant === "primary" ? palette.primaryBackground : palette.secondaryBorder;
    const hoverBackground = variant === "primary" ? palette.actionPrimaryHoverBackground ?? background : palette.actionSecondaryHoverBackground ?? background;
    applyStyles(button, {
      border: `1px solid ${border}`,
      borderRadius: "999px",
      background,
      color,
      cursor: "pointer",
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      boxSizing: "border-box",
      fontSize: compact ? "11px" : "12px",
      fontWeight: "600",
      lineHeight: "1",
      letterSpacing: compact ? "-0.01em" : "0",
      padding: compact ? "0 10px" : "8px 12px",
      height: compact ? "30px" : "auto",
      minHeight: compact ? "30px" : "0",
      boxShadow: compact ? "none" : "0 0 0 transparent",
      whiteSpace: "nowrap",
      transition: BUTTON_HOVER_TRANSITION
    });
    bindBackgroundHoverState(button, background, hoverBackground);
    return button;
  }
  function createIconNode(name, size = DEFAULT_ICON_SIZE) {
    const wrapper = document.createElement("span");
    wrapper.dataset.chatgptLagUserscript = `icon-${name}`;
    wrapper.setAttribute("aria-hidden", "true");
    applyStyles(wrapper, {
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      flex: "0 0 auto",
      width: `${size}px`,
      height: `${size}px`,
      lineHeight: "0"
    });
    wrapper.innerHTML = getPanelIconMarkup(name);
    const svg = wrapper.querySelector("svg");
    if (svg) {
      applyStyles(svg, {
        display: "block",
        width: "100%",
        height: "100%"
      });
    }
    return wrapper;
  }
  function createBrandSlot(color) {
    const brand = document.createElement("div");
    brand.dataset.chatgptLagUserscript = "controls-brand";
    brand.setAttribute("aria-hidden", "true");
    applyStyles(brand, {
      width: `${BRAND_SLOT_SIZE}px`,
      height: `${BRAND_SLOT_SIZE}px`,
      flex: "0 0 auto",
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      color
    });
    const icon = createIconNode("brand");
    applyStyles(icon, {
      width: `${BRAND_ICON_SIZE}px`,
      height: `${BRAND_ICON_SIZE}px`
    });
    brand.appendChild(icon);
    return brand;
  }
  function createIconButton({
    label,
    iconName,
    palette,
    onClick,
    variant = "secondary",
    compact = false,
    dataName = null
  }) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.chatgptLagUserscript = "controls-toggle";
    if (dataName) {
      button.dataset.chatgptLagUserscript = dataName;
    }
    button.setAttribute("aria-label", label);
    button.title = label;
    button.appendChild(
      createIconNode(iconName, compact ? HEADER_ACTION_ICON_SIZE : DEFAULT_ICON_SIZE)
    );
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      onClick?.();
    });
    const hoverBackground = compact ? palette.controlHoverBackground ?? palette.actionPrimaryBackground ?? "transparent" : null;
    if (compact) {
      bindBackgroundHoverState(button, "transparent", hoverBackground);
    }
    applyStyles(button, {
      border: compact ? "0" : variant === "primary" ? `1px solid ${palette.primaryBackground}` : `1px solid ${palette.secondaryBorder}`,
      borderRadius: compact ? "8px" : "999px",
      background: compact ? "transparent" : variant === "primary" ? palette.primaryBackground : "transparent",
      color: compact ? palette.controlColor ?? palette.color : variant === "primary" ? palette.primaryColor : palette.mutedColor,
      cursor: "pointer",
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      gap: compact ? "0" : "6px",
      width: compact ? `${HEADER_ACTION_BUTTON_SIZE}px` : "auto",
      minWidth: compact ? `${HEADER_ACTION_BUTTON_SIZE}px` : "0",
      height: compact ? `${HEADER_ACTION_BUTTON_SIZE}px` : "auto",
      minHeight: compact ? `${HEADER_ACTION_BUTTON_SIZE}px` : "0",
      fontSize: "11px",
      fontWeight: "700",
      lineHeight: "1",
      padding: compact ? "0" : "6px 10px",
      transition: compact ? BUTTON_HOVER_TRANSITION : "none"
    });
    return button;
  }
  function normalizeRuntimeMode2(options) {
    if (options.runtimeMode) {
      return options.runtimeMode;
    }
    if (!options.enabled) {
      return "disabled";
    }
    if (options.loadAll) {
      return "loadAll";
    }
    if (options.hasOverride) {
      return "extended";
    }
    return "trimmed";
  }
  function resolvePanelMode(options) {
    return normalizePanelMode(options.panelMode ?? options.viewModel?.panelMode);
  }
  function readPanelState(panelStateStore2) {
    if (!panelStateStore2?.read) {
      return null;
    }
    try {
      return panelStateStore2.read();
    } catch {
      return null;
    }
  }
  function getDefaultPanelStateStore() {
    if (defaultPanelStateStore) {
      return defaultPanelStateStore;
    }
    const gmGetValue = typeof globalThis.GM_getValue === "function" ? globalThis.GM_getValue.bind(globalThis) : null;
    const gmSetValue = typeof globalThis.GM_setValue === "function" ? globalThis.GM_setValue.bind(globalThis) : null;
    defaultPanelStateStore = createPanelStateStore({
      gmGetValue,
      gmSetValue
    });
    return defaultPanelStateStore;
  }
  function normalizePanelViewState2(options, viewportWidth) {
    if (options.panelViewState) {
      return options.panelViewState;
    }
    const storedState = readPanelState(options.panelStateStore);
    if (PANEL_VIEW_STATES2.has(storedState?.panelViewState)) {
      return storedState.panelViewState;
    }
    if (typeof storedState?.collapsed === "boolean") {
      return storedState.collapsed ? "collapsed" : "expanded";
    }
    if (viewportWidth <= COMPACT_VIEWPORT_MAX_WIDTH) {
      return "collapsed";
    }
    return "expanded";
  }
  function shouldKeepLegacyHiddenState(options) {
    return options.panelViewState == null && options.runtimeMode == null && options.enabled === true && options.hasOlderMessages === false && options.hasOverride === false;
  }
  function getLegacyActions(options, runtimeMode, panelMode) {
    if (panelMode !== "conversation-ready") {
      return [];
    }
    if (runtimeMode === "disabled") {
      return [
        {
          id: "enable-trimming",
          label: "\u555F\u7528\u7CBE\u7C21\u6A21\u5F0F",
          variant: "primary",
          onSelect: options.onEnableTrimming
        }
      ];
    }
    if (runtimeMode === "loadAll") {
      return [
        {
          id: "back-to-trimmed",
          label: "\u56DE\u5230\u7CBE\u7C21\u6A21\u5F0F",
          onSelect: options.onBackToTrimmed
        }
      ];
    }
    const actions = [];
    if (options.hasOlderMessages && !options.loadAll) {
      actions.push({
        id: "load-more",
        label: `\u518D\u8F09\u5165 ${Number(options.loadMoreStep ?? 0)} \u5247`,
        variant: "primary",
        onSelect: options.onLoadMore
      });
      actions.push({
        id: "load-all",
        label: "\u5168\u90E8\u8F09\u5165",
        onSelect: options.onLoadAll
      });
    }
    if (runtimeMode === "extended") {
      actions.push({
        id: "back-to-trimmed",
        label: "\u56DE\u5230\u7CBE\u7C21\u6A21\u5F0F",
        onSelect: options.onBackToTrimmed
      });
    }
    return actions;
  }
  function resolveViewModel(options, panelMode, runtimeMode) {
    if (options.viewModel) {
      return options.viewModel;
    }
    return createPanelViewModel({
      panelMode,
      runtimeMode,
      effectiveLimit: Number(options.effectiveLimit ?? 0),
      extraMessages: Number(options.extraMessages ?? 0),
      totalMessages: Number(options.totalMessages ?? 0),
      renderedMessages: Number(options.renderedMessages ?? 0),
      actions: getLegacyActions(options, runtimeMode, panelMode),
      onReloadNow: options.onReloadNow
    });
  }
  function ensureRoot() {
    if (panelRoot && panelRoot.isConnected) {
      return panelRoot;
    }
    if (panelController) {
      panelController.position = null;
      panelController.isDragging = false;
      panelController.dragPointerId = null;
    }
    if (!panelRoot) {
      panelRoot = document.querySelector(PANEL_SELECTOR) ?? document.createElement("div");
    }
    return panelRoot;
  }
  function getRootMetrics(root) {
    const rect = root.getBoundingClientRect();
    return {
      width: Number(rect.width ?? 0),
      height: Number(rect.height ?? 0)
    };
  }
  function getPanelBounds(position, root) {
    const { width: viewportWidth, height: viewportHeight } = getViewportSize();
    const { width: panelWidth, height: panelHeight } = getRootMetrics(root);
    const maxLeft = Math.max(0, viewportWidth - panelWidth);
    const maxTop = Math.max(0, viewportHeight - panelHeight);
    return {
      left: clamp(toNumber(position?.left, DEFAULT_PANEL_POSITION), 0, maxLeft),
      top: clamp(toNumber(position?.top, DEFAULT_PANEL_POSITION), 0, maxTop)
    };
  }
  function resolvePanelState(options, currentPosition) {
    const storedState = readPanelState(options.panelStateStore);
    const position = normalizePosition2(options.panelPosition ?? currentPosition ?? storedState?.position);
    const viewport = getViewportSize();
    const panelViewState = normalizePanelViewState2(options, viewport.width);
    const lastNonHiddenState = storedState?.lastNonHiddenState && storedState.lastNonHiddenState !== "hidden" ? storedState.lastNonHiddenState : panelViewState === "hidden" ? "collapsed" : panelViewState;
    return {
      position,
      panelViewState,
      lastNonHiddenState
    };
  }
  function updateRootStyles(root, palette, panelViewState, expandedPalette, panelMode) {
    const isHidden = panelViewState === "hidden";
    const isCollapsed = panelViewState === "collapsed";
    const surfacePalette = expandedPalette ?? palette;
    applyStyles(root, {
      position: "fixed",
      left: "16px",
      top: "16px",
      zIndex: "2147483647",
      width: isHidden ? `${PANEL_HIDDEN_WIDTH}px` : "fit-content",
      maxWidth: isHidden ? `${PANEL_HIDDEN_WIDTH}px` : "calc(100vw - 32px)",
      height: isHidden ? `${PANEL_HIDDEN_WIDTH}px` : "auto",
      minHeight: isHidden ? `${PANEL_HIDDEN_WIDTH}px` : isCollapsed ? `${PANEL_COMPACT_HEIGHT}px` : "0",
      borderRadius: isHidden || isCollapsed ? "999px" : "16px",
      border: `1px solid ${surfacePalette.borderColor}`,
      background: surfacePalette.background,
      boxShadow: surfacePalette.shadow,
      backdropFilter: "blur(10px)",
      color: surfacePalette.color,
      fontFamily: '"Noto Sans TC", "PingFang TC", "Microsoft JhengHei", system-ui, sans-serif',
      padding: isHidden ? "0" : isCollapsed ? "6px 8px 6px 8px" : "10px 8px 10px 8px",
      boxSizing: "border-box",
      display: isHidden ? "inline-flex" : "flex",
      flexDirection: isHidden || isCollapsed ? "row" : "column",
      alignItems: isHidden || isCollapsed ? "center" : "stretch",
      justifyContent: isHidden ? "center" : isCollapsed ? "space-between" : "flex-start",
      gap: isHidden ? "0" : isCollapsed ? "8px" : "6px",
      overflow: "hidden"
    });
  }
  function updateRootPosition(root, position) {
    applyStyles(root, {
      left: `${Math.round(position.left)}px`,
      top: `${Math.round(position.top)}px`
    });
  }
  function shouldRenderConversationActions(panelMode) {
    return panelMode === "conversation-ready";
  }
  function createLauncherButton({
    palette,
    label,
    onClick = null,
    cursor = null
  }) {
    const launcher = document.createElement("button");
    launcher.type = "button";
    launcher.dataset.chatgptLagUserscript = "controls-handle";
    launcher.setAttribute("aria-label", label);
    launcher.title = label;
    launcher.appendChild(createBrandSlot(palette.color));
    applyStyles(launcher, {
      width: "100%",
      height: "100%",
      justifyContent: "center",
      alignItems: "center",
      display: "inline-flex",
      padding: "0",
      border: "0",
      background: "transparent",
      color: palette.color,
      ...cursor ? { cursor } : {}
    });
    if (typeof onClick === "function") {
      launcher.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        onClick();
      });
    }
    return launcher;
  }
  function renderContent({
    root,
    palette,
    expandedPalette,
    panelViewState,
    lastNonHiddenState,
    panelMode,
    viewModel,
    onSetPanelViewState,
    onRestoreFromHidden
  }) {
    const runtimeMode = viewModel.runtimeMode;
    const isHidden = panelViewState === "hidden";
    const isCollapsed = panelViewState === "collapsed";
    const surfacePalette = expandedPalette ?? palette;
    root.innerHTML = "";
    root.dataset.panelMode = panelMode;
    root.dataset.panelViewState = panelViewState;
    if (runtimeMode != null) {
      root.dataset.runtimeMode = runtimeMode;
    } else {
      root.removeAttribute("data-runtime-mode");
    }
    if (isHidden) {
      const launcher = createLauncherButton({
        palette: surfacePalette,
        label: getPanelStateActionLabel("hidden"),
        onClick: () => onRestoreFromHidden?.()
      });
      root.appendChild(launcher);
      return;
    }
    if (isCollapsed) {
      const collapsedRow = document.createElement("div");
      collapsedRow.dataset.chatgptLagUserscript = "controls-handle";
      applyStyles(collapsedRow, {
        display: "flex",
        alignItems: "center",
        gap: "8px",
        minWidth: "0",
        flex: "1 1 auto",
        cursor: "grab",
        userSelect: "none",
        touchAction: "none"
      });
      const brand2 = createBrandSlot(surfacePalette.color);
      collapsedRow.appendChild(brand2);
      const summary = document.createElement("div");
      summary.dataset.chatgptLagUserscript = "controls-summary";
      summary.textContent = viewModel.collapsedSummary;
      applyStyles(summary, {
        minWidth: "0",
        flex: "1 1 auto",
        fontSize: "12px",
        fontWeight: "700",
        lineHeight: "1.2",
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis"
      });
      collapsedRow.appendChild(summary);
      const collapsedActions = document.createElement("div");
      applyStyles(collapsedActions, {
        display: "flex",
        alignItems: "center",
        gap: "1px",
        flex: "0 0 auto"
      });
      if (typeof viewModel.onReloadNow === "function") {
        collapsedActions.appendChild(
          createIconButton({
            label: "\u7ACB\u5373\u91CD\u6574",
            iconName: "reload",
            palette: surfacePalette,
            onClick: viewModel.onReloadNow,
            variant: "secondary",
            compact: true,
            dataName: "controls-reload"
          })
        );
      }
      collapsedActions.appendChild(
        createIconButton({
          label: "\u5C55\u958B\u9762\u677F",
          iconName: "expand",
          palette: surfacePalette,
          onClick: () => onSetPanelViewState("expanded"),
          variant: "secondary",
          compact: true
        })
      );
      collapsedActions.appendChild(
        createIconButton({
          label: "\u96B1\u85CF\u9762\u677F",
          iconName: "hidden",
          palette: surfacePalette,
          onClick: () => onSetPanelViewState("hidden", "collapsed"),
          variant: "secondary",
          compact: true
        })
      );
      root.appendChild(collapsedRow);
      root.appendChild(collapsedActions);
      return;
    }
    const header = document.createElement("div");
    header.dataset.chatgptLagUserscript = "controls-handle";
    applyStyles(header, {
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: "6px",
      cursor: "grab",
      userSelect: "none",
      touchAction: "none"
    });
    const titleGroup = document.createElement("div");
    applyStyles(titleGroup, {
      display: "flex",
      alignItems: "center",
      gap: "7px",
      minWidth: "0"
    });
    const brand = createBrandSlot(surfacePalette.color);
    titleGroup.appendChild(brand);
    const titleWrap = document.createElement("div");
    applyStyles(titleWrap, {
      display: "flex",
      flexDirection: "column",
      minWidth: "0"
    });
    const title = document.createElement("div");
    title.textContent = viewModel.title;
    applyStyles(title, {
      fontSize: "12px",
      fontWeight: "600",
      lineHeight: "1.2",
      letterSpacing: "-0.01em",
      color: surfacePalette.color
    });
    titleWrap.appendChild(title);
    titleGroup.appendChild(titleWrap);
    header.appendChild(titleGroup);
    const headerActions = document.createElement("div");
    applyStyles(headerActions, {
      display: "flex",
      alignItems: "center",
      gap: "0px",
      flex: "0 0 auto"
    });
    if (typeof viewModel.onReloadNow === "function") {
      headerActions.appendChild(
        createIconButton({
          label: "\u7ACB\u5373\u91CD\u6574",
          iconName: "reload",
          palette: surfacePalette,
          onClick: viewModel.onReloadNow,
          variant: "secondary",
          compact: true,
          dataName: "controls-reload"
        })
      );
    }
    headerActions.appendChild(
      createIconButton({
        label: getPanelStateActionLabel(panelViewState),
        iconName: getPanelStateToggleIconName(panelViewState),
        palette: surfacePalette,
        onClick: () => {
          if (panelViewState === "expanded") {
            onSetPanelViewState("collapsed");
            return;
          }
          if (panelViewState === "collapsed") {
            onSetPanelViewState("expanded");
            return;
          }
          onSetPanelViewState(lastNonHiddenState);
        },
        variant: "secondary",
        compact: true
      })
    );
    headerActions.appendChild(
      createIconButton({
        label: "\u96B1\u85CF\u9762\u677F",
        iconName: "hidden",
        palette: surfacePalette,
        onClick: () => onSetPanelViewState("hidden", panelViewState),
        variant: "secondary",
        compact: true
      })
    );
    header.appendChild(headerActions);
    root.appendChild(header);
    const content = document.createElement("div");
    applyStyles(content, {
      display: "flex",
      flexDirection: "column",
      gap: "4px",
      minWidth: "0"
    });
    const status = document.createElement("div");
    status.textContent = viewModel.statusText;
    applyStyles(status, {
      fontSize: "11px",
      lineHeight: "1.35",
      color: surfacePalette.mutedColor,
      margin: "0"
    });
    content.appendChild(status);
    if (shouldRenderConversationActions(panelMode)) {
      const actions = document.createElement("div");
      actions.dataset.chatgptLagUserscript = "controls-actions";
      applyStyles(actions, {
        display: "flex",
        flexWrap: "wrap",
        gap: "6px",
        alignItems: "center",
        paddingTop: "0",
        borderTop: "0",
        maxWidth: "100%"
      });
      for (const action of viewModel.actions) {
        actions.appendChild(
          createActionButton(action.label, action.onSelect, surfacePalette, action.variant, true)
        );
      }
      if (actions.childElementCount > 0) {
        content.appendChild(actions);
      }
    }
    root.appendChild(content);
  }
  function getController() {
    if (panelController) {
      return panelController;
    }
    panelController = {
      position: null,
      panelStateStore: null,
      panelViewState: "expanded",
      lastNonHiddenState: "expanded",
      theme: null,
      themeUnsubscribe: null,
      lastOptions: null,
      isDragging: false,
      dragMoved: false,
      dragPointerId: null,
      dragStartX: 0,
      dragStartY: 0,
      dragStartPosition: normalizePosition2(),
      suppressNextHiddenClick: false,
      resizeObserver: null,
      onWindowPointerMove: null,
      onWindowPointerUp: null,
      onWindowResize: null,
      onRootPointerDown: null,
      bind(root) {
        if (this.onWindowResize) {
          return;
        }
        this.onWindowPointerMove = (event) => {
          if (!this.isDragging || event.pointerId !== this.dragPointerId) {
            return;
          }
          const nextPosition = getPanelBounds(
            {
              left: this.dragStartPosition.left + (event.clientX - this.dragStartX),
              top: this.dragStartPosition.top + (event.clientY - this.dragStartY)
            },
            root
          );
          const deltaX = event.clientX - this.dragStartX;
          const deltaY = event.clientY - this.dragStartY;
          if (Math.abs(deltaX) >= COLLAPSED_CLICK_DISTANCE || Math.abs(deltaY) >= COLLAPSED_CLICK_DISTANCE) {
            this.dragMoved = true;
          }
          this.position = nextPosition;
          updateRootPosition(root, nextPosition);
        };
        this.onWindowPointerUp = (event) => {
          if (!this.isDragging || event.pointerId !== this.dragPointerId) {
            return;
          }
          this.isDragging = false;
          this.dragPointerId = null;
          updateRootPosition(root, this.position);
          if (root.dataset.panelViewState === "hidden" && !this.dragMoved) {
            this.suppressNextHiddenClick = true;
            this.setPanelViewState(this.lastNonHiddenState ?? "collapsed");
            return;
          }
          if (root.dataset.panelViewState === "collapsed" && !this.dragMoved) {
            this.setPanelViewState("expanded");
            return;
          }
          this.panelStateStore?.write?.({ position: this.position });
        };
        this.onWindowResize = () => {
          const nextViewState = normalizePanelViewState2(this.lastOptions ?? {}, getViewportSize().width);
          if (nextViewState !== root.dataset.panelViewState) {
            this.rerender();
            return;
          }
          const nextPosition = getPanelBounds(this.position, root);
          this.position = nextPosition;
          updateRootPosition(root, nextPosition);
        };
        this.onRootPointerDown = (event) => {
          const handle = event.target?.closest?.('[data-chatgpt-lag-userscript="controls-handle"]');
          if (!handle) {
            return;
          }
          if (event.target?.closest?.("button") && root.dataset.panelViewState !== "hidden" && root.dataset.panelMode !== "launcher") {
            return;
          }
          this.startDrag(event, root);
        };
        window.addEventListener("pointermove", this.onWindowPointerMove);
        window.addEventListener("pointerup", this.onWindowPointerUp);
        window.addEventListener("resize", this.onWindowResize);
        root.addEventListener("pointerdown", this.onRootPointerDown);
        if (typeof ResizeObserver === "function") {
          this.resizeObserver = new ResizeObserver(() => {
            const nextPosition = getPanelBounds(this.position, root);
            this.position = nextPosition;
            updateRootPosition(root, nextPosition);
          });
          this.resizeObserver.observe(root);
        }
      },
      startDrag(event, root) {
        if (event.button != null && event.button !== 0) {
          return;
        }
        this.isDragging = true;
        this.dragMoved = false;
        this.dragPointerId = event.pointerId;
        this.dragStartX = event.clientX;
        this.dragStartY = event.clientY;
        this.dragStartPosition = { ...this.position };
        this.suppressNextHiddenClick = false;
        updateRootPosition(root, this.position);
        event.preventDefault();
      },
      updateFromOptions({ position, panelStateStore: panelStateStore2, panelViewState, lastNonHiddenState }) {
        if (panelStateStore2) {
          this.panelStateStore = panelStateStore2;
        }
        if (position) {
          this.position = position;
        }
        if (panelViewState) {
          this.panelViewState = panelViewState;
        }
        if (lastNonHiddenState) {
          this.lastNonHiddenState = lastNonHiddenState;
        }
      },
      updateLastOptions(options) {
        this.lastOptions = options;
      },
      ensureThemeSubscription() {
        if (this.theme == null) {
          this.theme = resolveTheme(document, globalThis.matchMedia);
        }
        if (this.themeUnsubscribe) {
          return;
        }
        this.themeUnsubscribe = subscribeTheme({
          doc: document,
          matchMedia: globalThis.matchMedia,
          onThemeChange: (nextTheme) => {
            this.theme = nextTheme;
            this.rerender();
          }
        });
      },
      rerender() {
        if (!this.lastOptions) {
          return;
        }
        renderControls({
          ...this.lastOptions,
          panelViewState: this.panelViewState,
          lastNonHiddenState: this.lastNonHiddenState
        });
      },
      setPanelViewState(nextPanelViewState, nextLastNonHiddenState = null) {
        if (!PANEL_VIEW_STATES2.has(nextPanelViewState)) {
          return;
        }
        const resolvedLastNonHiddenState = nextPanelViewState === "hidden" ? nextLastNonHiddenState ?? this.lastNonHiddenState ?? "expanded" : nextPanelViewState;
        this.panelViewState = nextPanelViewState;
        this.lastNonHiddenState = resolvedLastNonHiddenState;
        this.panelStateStore?.write?.({
          panelViewState: nextPanelViewState,
          lastNonHiddenState: resolvedLastNonHiddenState
        });
        this.rerender();
      },
      restoreFromHidden() {
        if (this.suppressNextHiddenClick) {
          this.suppressNextHiddenClick = false;
          return;
        }
        this.setPanelViewState(this.lastNonHiddenState ?? "collapsed");
      },
      toggleCollapsed(nextCollapsed = panelRoot?.dataset.panelViewState !== "collapsed") {
        this.setPanelViewState(nextCollapsed ? "collapsed" : "expanded");
      },
      sync(root) {
        const clampedPosition = getPanelBounds(this.position, root);
        this.position = clampedPosition;
        updateRootPosition(root, clampedPosition);
      }
    };
    return panelController;
  }
  function renderControls(options = {}) {
    const panelMode = resolvePanelMode(options);
    if (!options.viewModel && panelMode === "conversation-ready" && shouldKeepLegacyHiddenState(options)) {
      return { root: null };
    }
    const root = ensureRoot();
    const controller = getController();
    const panelStateStore2 = options.panelStateStore ?? getDefaultPanelStateStore();
    const runtimeMode = options.viewModel?.runtimeMode ?? normalizeRuntimeMode2(options);
    const viewModel = resolveViewModel(options, panelMode, runtimeMode);
    controller.ensureThemeSubscription();
    const theme = resolveTheme(document, globalThis.matchMedia);
    controller.theme = theme;
    const palette = getThemePalette(theme);
    const expandedPalette = getExpandedThemePalette(theme, palette);
    const resolved = resolvePanelState(
      {
        ...options,
        panelStateStore: panelStateStore2
      },
      controller.position
    );
    const panelViewState = resolved.panelViewState;
    const host = document.body ?? options.mountTarget;
    if (!host) {
      return { root: null };
    }
    controller.updateLastOptions({
      ...options,
      panelMode,
      panelStateStore: panelStateStore2,
      panelViewState: resolved.panelViewState,
      lastNonHiddenState: resolved.lastNonHiddenState,
      viewModel
    });
    controller.updateFromOptions({
      position: resolved.position,
      panelStateStore: panelStateStore2,
      panelViewState: resolved.panelViewState,
      lastNonHiddenState: resolved.lastNonHiddenState
    });
    root.dataset.chatgptLagUserscript = "controls";
    root.dataset.theme = theme;
    updateRootStyles(root, palette, panelViewState, expandedPalette, panelMode);
    renderContent({
      root,
      palette,
      expandedPalette,
      panelViewState,
      lastNonHiddenState: resolved.lastNonHiddenState,
      panelMode,
      viewModel,
      onSetPanelViewState: (nextPanelViewState, nextLastNonHiddenState) => controller.setPanelViewState(nextPanelViewState, nextLastNonHiddenState),
      onRestoreFromHidden: () => controller.restoreFromHidden()
    });
    host.appendChild(root);
    controller.bind(root);
    controller.sync(root);
    return { root };
  }

  // src/chatgpt-lag-userscript/menu-commands.js
  function formatToggleLabel(label, enabled, enableText, disableText) {
    return `${label}\uFF1A${enabled ? "\u958B\u555F" : "\u95DC\u9589"}\uFF08\u9EDE\u6B64${enabled ? disableText : enableText}\uFF09`;
  }
  function registerMenuCommands({
    settingsStore: settingsStore2,
    conversationState: conversationState2,
    threadMonitorState: threadMonitorState2,
    getCurrentUrl,
    rebuild,
    registerMenuCommand
  }) {
    if (typeof registerMenuCommand !== "function") {
      return false;
    }
    const current = settingsStore2.read();
    registerMenuCommand(formatToggleLabel("\u7CBE\u7C21\u6A21\u5F0F", current.enabled, "\u555F\u7528", "\u505C\u7528"), () => {
      const current2 = settingsStore2.read();
      const nextEnabled = !current2.enabled;
      settingsStore2.write({ enabled: nextEnabled });
      if (nextEnabled) {
        conversationState2?.reset?.(getCurrentUrl());
      }
      rebuild();
    });
    registerMenuCommand(`\u8A2D\u5B9A\u4FDD\u7559\u6700\u8FD1 N \u5247\uFF08\u76EE\u524D\uFF1A${current.keepLastN}\uFF09`, () => {
      const current2 = settingsStore2.read();
      const next = Number(prompt("keep last N", String(current2.keepLastN)));
      if (Number.isFinite(next) && next > 0) {
        settingsStore2.write({ keepLastN: next });
        rebuild();
      }
    });
    registerMenuCommand(`\u8A2D\u5B9A\u6BCF\u6B21\u591A\u8F09\u5165\u7B46\u6578\uFF08\u76EE\u524D\uFF1A${current.loadMoreStep}\uFF09`, () => {
      const current2 = settingsStore2.read();
      const next = Number(prompt("load more step", String(current2.loadMoreStep)));
      if (Number.isFinite(next) && next > 0) {
        settingsStore2.write({ loadMoreStep: next });
        rebuild();
      }
    });
    registerMenuCommand(
      formatToggleLabel("\u81EA\u52D5\u91CD\u6574", current.autoReloadEnabled, "\u555F\u7528", "\u505C\u7528"),
      () => {
        const current2 = settingsStore2.read();
        settingsStore2.write({ autoReloadEnabled: !current2.autoReloadEnabled });
        rebuild();
      }
    );
    registerMenuCommand("\u91CD\u8A2D\u76EE\u524D\u5C0D\u8A71\u72C0\u614B", () => {
      const currentUrl = getCurrentUrl();
      conversationState2?.reset?.(currentUrl);
      threadMonitorState2?.reset?.(currentUrl);
      rebuild();
    });
    return true;
  }

  // src/chatgpt-lag-userscript/thread-monitor-state.js
  var STORAGE_KEY2 = "chatgpt-lag-userscript:thread-monitor-state";
  function createDefaultState2(currentUrl) {
    return {
      url: currentUrl,
      phase: "idle",
      lastObservedBubbleCount: 0,
      lastWarnedBubbleCount: 0,
      lastReloadedBubbleCount: 0,
      countdownStartedAt: null
    };
  }
  function readRawState2(storage) {
    const raw = storage.getItem(STORAGE_KEY2);
    if (!raw) {
      return null;
    }
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  function createThreadMonitorState(storage) {
    return {
      read(currentUrl) {
        const parsed = readRawState2(storage);
        if (!parsed) {
          return createDefaultState2(currentUrl);
        }
        if (parsed.url !== currentUrl) {
          storage.removeItem(STORAGE_KEY2);
          return createDefaultState2(currentUrl);
        }
        return {
          url: parsed.url,
          phase: parsed.phase ?? "idle",
          lastObservedBubbleCount: parsed.lastObservedBubbleCount ?? 0,
          lastWarnedBubbleCount: parsed.lastWarnedBubbleCount ?? 0,
          lastReloadedBubbleCount: parsed.lastReloadedBubbleCount ?? 0,
          countdownStartedAt: parsed.countdownStartedAt ?? null
        };
      },
      write(next) {
        storage.setItem(STORAGE_KEY2, JSON.stringify(next));
      },
      reset(currentUrl) {
        storage.setItem(STORAGE_KEY2, JSON.stringify(createDefaultState2(currentUrl)));
      }
    };
  }

  // src/chatgpt-lag-userscript/thread-monitor.js
  var DEFAULT_THREAD_SELECTOR = "#thread";
  var DEFAULT_BUBBLE_SELECTORS = [
    '[data-message-author-role="user"]',
    '[data-message-author-role="assistant"]'
  ];
  function resolveBubbleSelector(bubbleSelectors) {
    if (Array.isArray(bubbleSelectors)) {
      return bubbleSelectors.join(", ");
    }
    return bubbleSelectors ?? DEFAULT_BUBBLE_SELECTORS.join(", ");
  }
  function resolveThreadRoot(doc, threadSelector) {
    return doc.querySelector(threadSelector) ?? null;
  }
  function isVisible(element, view) {
    if (!(element instanceof view.HTMLElement)) {
      return false;
    }
    if (element.hidden) {
      return false;
    }
    const style = view.getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden";
  }
  function getBubbleRole(element) {
    return element.getAttribute("data-message-author-role");
  }
  function hasMatchedRoleAncestor(element, bubbleSelector) {
    return Boolean(element.parentElement?.closest(bubbleSelector));
  }
  function collectVisibleBubbleGroups(thread, view, bubbleSelector) {
    const groups = [];
    let lastRole = null;
    for (const element of thread.querySelectorAll(bubbleSelector)) {
      if (!isVisible(element, view) || hasMatchedRoleAncestor(element, bubbleSelector)) {
        continue;
      }
      const role = getBubbleRole(element);
      if (!role || role === lastRole) {
        continue;
      }
      groups.push({
        role,
        element
      });
      lastRole = role;
    }
    return groups;
  }
  function countVisibleBubbles(doc = document, {
    threadSelector = DEFAULT_THREAD_SELECTOR,
    bubbleSelectors = DEFAULT_BUBBLE_SELECTORS
  } = {}) {
    const view = doc.defaultView ?? globalThis;
    const thread = resolveThreadRoot(doc, threadSelector);
    if (!thread) {
      return 0;
    }
    const bubbleSelector = resolveBubbleSelector(bubbleSelectors);
    return collectVisibleBubbleGroups(thread, view, bubbleSelector).length;
  }
  function observeBubbleCount({
    doc = document,
    threadSelector = DEFAULT_THREAD_SELECTOR,
    bubbleSelectors = DEFAULT_BUBBLE_SELECTORS,
    MutationObserver: MutationObserver2,
    MutationObserverImpl = globalThis.MutationObserver,
    onCountChange
  } = {}) {
    const ObserverCtor = typeof MutationObserver2 === "function" ? MutationObserver2 : MutationObserverImpl;
    if (typeof ObserverCtor !== "function") {
      return () => {
      };
    }
    let lastCount = null;
    let emitScheduled = false;
    let stopped = false;
    let observedThread = null;
    let threadObserver = null;
    const emit = () => {
      const nextCount = countVisibleBubbles(doc, { threadSelector, bubbleSelectors });
      if (nextCount === lastCount) {
        return;
      }
      lastCount = nextCount;
      onCountChange?.(nextCount);
    };
    const scheduleEmit = () => {
      if (emitScheduled || stopped) {
        return;
      }
      emitScheduled = true;
      Promise.resolve().then(() => {
        emitScheduled = false;
        if (stopped) {
          return;
        }
        emit();
      });
    };
    const attachThreadObserver = ({ resetCount = false } = {}) => {
      const previousThread = observedThread;
      if (threadObserver) {
        threadObserver.disconnect();
        threadObserver = null;
      }
      const nextThread = resolveThreadRoot(doc, threadSelector);
      if (!nextThread) {
        return false;
      }
      observedThread = nextThread;
      if (resetCount && previousThread !== nextThread) {
        lastCount = null;
      }
      threadObserver = new ObserverCtor(scheduleEmit);
      threadObserver.observe(observedThread, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["hidden", "style", "class"]
      });
      return true;
    };
    const rootObserverTarget = doc.body ?? doc.documentElement;
    const rootObserver = new ObserverCtor(() => {
      if (observedThread && doc.contains(observedThread)) {
        return;
      }
      if (attachThreadObserver({ resetCount: true })) {
        emit();
      }
    });
    if (rootObserverTarget) {
      rootObserver.observe(rootObserverTarget, {
        childList: true,
        subtree: true
      });
    }
    if (attachThreadObserver()) {
      emit();
    }
    return () => {
      stopped = true;
      rootObserver.disconnect();
      threadObserver?.disconnect();
    };
  }

  // src/chatgpt-lag-userscript/thread-monitor-coordinator.js
  function normalizeMonitorState(monitorState) {
    const current = monitorState ?? {};
    return {
      phase: current.phase ?? "idle",
      lastObservedBubbleCount: current.lastObservedBubbleCount ?? 0,
      lastWarnedBubbleCount: current.lastWarnedBubbleCount ?? 0,
      lastReloadedBubbleCount: current.lastReloadedBubbleCount ?? 0,
      countdownStartedAt: current.countdownStartedAt ?? null
    };
  }
  function isPausedRuntimeMode(runtimeMode) {
    return runtimeMode === "disabled" || runtimeMode === "extended" || runtimeMode === "loadAll";
  }
  function createThreadMonitorCoordinator({
    warningThreshold = 8,
    countdownMs = 1e4
  } = {}) {
    return {
      evaluate({
        monitorState,
        runtimeMode,
        bubbleCount,
        autoReloadEnabled,
        isStreaming,
        hasDraft,
        now = Date.now()
      }) {
        const nextState = normalizeMonitorState(monitorState);
        const bubbleCountChanged = bubbleCount !== nextState.lastObservedBubbleCount;
        nextState.lastObservedBubbleCount = bubbleCount;
        if (isPausedRuntimeMode(runtimeMode)) {
          return {
            state: {
              ...nextState,
              phase: "paused",
              countdownStartedAt: null
            },
            shouldWarn: false,
            shouldReload: false
          };
        }
        if (bubbleCount < warningThreshold) {
          return {
            state: {
              ...nextState,
              phase: "idle",
              countdownStartedAt: null
            },
            shouldWarn: false,
            shouldReload: false
          };
        }
        const shouldWarn = bubbleCount > nextState.lastWarnedBubbleCount;
        if (shouldWarn) {
          nextState.lastWarnedBubbleCount = bubbleCount;
        }
        if (!autoReloadEnabled) {
          return {
            state: {
              ...nextState,
              phase: "warned",
              countdownStartedAt: null
            },
            shouldWarn,
            shouldReload: false
          };
        }
        if (bubbleCount <= nextState.lastReloadedBubbleCount) {
          return {
            state: {
              ...nextState,
              phase: "warned",
              countdownStartedAt: null
            },
            shouldWarn,
            shouldReload: false
          };
        }
        const safeToReload = !isStreaming && !hasDraft;
        if (!safeToReload) {
          return {
            state: {
              ...nextState,
              phase: "arming",
              countdownStartedAt: null
            },
            shouldWarn,
            shouldReload: false
          };
        }
        const countdownStartedAt = bubbleCountChanged || nextState.countdownStartedAt == null ? now : nextState.countdownStartedAt;
        const shouldReload = now - countdownStartedAt >= countdownMs;
        return {
          state: {
            ...nextState,
            phase: "countdown",
            countdownStartedAt,
            lastReloadedBubbleCount: shouldReload ? bubbleCount : nextState.lastReloadedBubbleCount
          },
          shouldWarn,
          shouldReload
        };
      }
    };
  }

  // src/chatgpt-lag-userscript/navigation-observer.js
  var OBSERVER_STATE = /* @__PURE__ */ new WeakMap();
  function getState(win) {
    return OBSERVER_STATE.get(win) ?? null;
  }
  function emitNavigation(state) {
    state.subscriptions.forEach((callback) => {
      callback({ url: state.win.location.href });
    });
  }
  function ensurePatched(win) {
    let state = getState(win);
    if (state) {
      return state;
    }
    const { history } = win;
    const nativePushState = history.pushState;
    const nativeReplaceState = history.replaceState;
    state = {
      win,
      subscriptions: /* @__PURE__ */ new Map(),
      nativePushState,
      nativeReplaceState,
      removePopstateListener: null
    };
    const emit = () => emitNavigation(state);
    history.pushState = (...args) => {
      const result = nativePushState.apply(history, args);
      emit();
      return result;
    };
    history.replaceState = (...args) => {
      const result = nativeReplaceState.apply(history, args);
      emit();
      return result;
    };
    win.addEventListener("popstate", emit);
    state.removePopstateListener = () => {
      win.removeEventListener("popstate", emit);
    };
    OBSERVER_STATE.set(win, state);
    return state;
  }
  function restoreIfIdle(state) {
    if (state.subscriptions.size > 0) {
      return;
    }
    const { win, nativePushState, nativeReplaceState, removePopstateListener } = state;
    win.history.pushState = nativePushState;
    win.history.replaceState = nativeReplaceState;
    removePopstateListener?.();
    OBSERVER_STATE.delete(win);
  }
  function observeNavigation({ win = window, onNavigate } = {}) {
    const state = ensurePatched(win);
    const callback = typeof onNavigate === "function" ? onNavigate : null;
    const subscriptionId = /* @__PURE__ */ Symbol("navigation-observer-subscription");
    let active = true;
    if (callback) {
      state.subscriptions.set(subscriptionId, callback);
    }
    return () => {
      if (!active) {
        return;
      }
      active = false;
      if (callback) {
        state.subscriptions.delete(subscriptionId);
      }
      restoreIfIdle(state);
    };
  }

  // src/chatgpt-lag-userscript/page-context-resolver.js
  function isProjectRoute(parsedUrl) {
    return parsedUrl.pathname.includes("/projects/") || /^\/g\/[^/]+\/project\/?$/.test(parsedUrl.pathname);
  }
  function isElementVisible(doc, element) {
    if (!element || element.hidden || element.getAttribute("aria-hidden") === "true") {
      return false;
    }
    const view = doc.defaultView;
    const style = view?.getComputedStyle?.(element);
    if (style && (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse")) {
      return false;
    }
    return true;
  }
  function hasVisibleBubbles(doc) {
    const bubbleSelectors = '[data-message-author-role="user"], [data-message-author-role="assistant"]';
    for (const bubble of doc.querySelectorAll(bubbleSelectors)) {
      if (isElementVisible(doc, bubble)) {
        return true;
      }
    }
    return false;
  }
  function resolvePageContext(doc = document, url = location.href, { includeVisibleBubbles = true } = {}) {
    const parsedUrl = parseChatGptUrl(url);
    const urlHref = parsedUrl?.href ?? String(url);
    const hasThreadRoot = Boolean(doc.querySelector("#thread"));
    const visibleBubbles = includeVisibleBubbles ? hasVisibleBubbles(doc) : false;
    if (!parsedUrl || !isAllowedChatGptHost(parsedUrl)) {
      return {
        url: urlHref,
        routeKind: "unknown",
        conversationId: null,
        hasThreadRoot,
        hasVisibleBubbles: visibleBubbles
      };
    }
    const conversationId = extractConversationId(parsedUrl.href);
    const routeKind = conversationId ? "conversation" : isProjectRoute(parsedUrl) ? "project" : "other";
    return {
      url: urlHref,
      routeKind,
      conversationId,
      hasThreadRoot,
      hasVisibleBubbles: visibleBubbles
    };
  }

  // src/chatgpt-lag-userscript/runtime-status-store.js
  function createRuntimeStatusStore() {
    let current = null;
    return {
      read(target = {}) {
        if (!current) {
          return null;
        }
        if (target.conversationId) {
          return current.conversationId === target.conversationId ? current.status : null;
        }
        return current.url === target.url ? current.status : null;
      },
      write(next) {
        if (!next?.url || !next?.status) {
          return;
        }
        current = {
          url: next.url,
          conversationId: next.conversationId ?? null,
          status: next.status
        };
      },
      clear() {
        current = null;
      }
    };
  }

  // src/chatgpt-lag-userscript/entry.js
  var LOG_PREFIX = "[chatgpt-lag-userscript]";
  var pageWindow = typeof globalThis.unsafeWindow === "object" && globalThis.unsafeWindow ? globalThis.unsafeWindow : window;
  var gmApi = {
    getValue: typeof globalThis.GM_getValue === "function" ? globalThis.GM_getValue.bind(globalThis) : null,
    setValue: typeof globalThis.GM_setValue === "function" ? globalThis.GM_setValue.bind(globalThis) : null,
    registerMenuCommand: typeof globalThis.GM_registerMenuCommand === "function" ? globalThis.GM_registerMenuCommand.bind(globalThis) : null
  };
  var settingsStore = createSettingsStore({
    gmGetValue: gmApi.getValue,
    gmSetValue: gmApi.setValue
  });
  var panelStateStore = createPanelStateStore({
    gmGetValue: gmApi.getValue,
    gmSetValue: gmApi.setValue
  });
  var conversationState = createConversationState(window.sessionStorage);
  var threadMonitorState = createThreadMonitorState(window.sessionStorage);
  var runtimeStatusStore = createRuntimeStatusStore();
  var AUTO_RELOAD_RECHECK_MS = 1e3;
  var AUTO_RELOAD_COUNTDOWN_MS = 1e4;
  var loadMountListenerAttached = false;
  var stopThreadMonitor = null;
  var isStartingThreadMonitor = false;
  var threadMonitorCoordinator = null;
  var threadMonitorCoordinatorWarningThreshold = null;
  var threadMonitorRecheckTimerId = null;
  var domContextObserver = null;
  var lastContextFingerprint = null;
  var lastDomContextHintFingerprint = null;
  function getPageDocument(doc = null) {
    return doc ?? globalThis.document ?? null;
  }
  function getPageUrl(doc = null) {
    const resolvedDoc = getPageDocument(doc);
    return resolvedDoc?.defaultView?.location?.href ?? globalThis.window?.location?.href ?? "about:blank";
  }
  function reloadPage(doc = null) {
    const resolvedDoc = getPageDocument(doc);
    const view = resolvedDoc?.defaultView ?? globalThis.window ?? null;
    view?.location?.reload?.();
  }
  function deriveWarningThreshold(keepLastN) {
    return Math.max(1, Number(keepLastN ?? 0) * 2);
  }
  function buildThreadMonitorViewModel(runtimeConfig, runtimeMode) {
    if (runtimeMode !== "trimmed") {
      return null;
    }
    const monitorState = threadMonitorState.read(getPageUrl());
    if (monitorState.lastObservedBubbleCount < Number(runtimeConfig.warningThreshold ?? 0)) {
      return null;
    }
    return {
      phase: monitorState.phase ?? "idle",
      bubbleCount: monitorState.lastObservedBubbleCount,
      warningThreshold: Number(runtimeConfig.warningThreshold ?? 0)
    };
  }
  function log(level, message, details) {
    if (level === "debug" && !settingsStore.read().debug) {
      return;
    }
    const payload = details === void 0 ? [LOG_PREFIX, message] : [LOG_PREFIX, message, details];
    const fn = console[level] ?? console.log;
    fn(...payload);
  }
  log("debug", "bootstrap start", {
    url: getPageUrl(),
    readyState: document.readyState,
    hasGMGetValue: Boolean(gmApi.getValue),
    hasGMSetValue: Boolean(gmApi.setValue),
    hasGMRegisterMenuCommand: Boolean(gmApi.registerMenuCommand),
    usingUnsafeWindow: pageWindow !== window
  });
  if (!gmApi.getValue || !gmApi.setValue) {
    log("warn", "GM storage API unavailable; using defaults and no-op persistence");
  }
  function getRuntimeConfig(doc = null) {
    const settings = settingsStore.read();
    const state = conversationState.read(getPageUrl(doc));
    return {
      ...settings,
      warningThreshold: deriveWarningThreshold(settings.keepLastN),
      extraMessages: state.extraMessages,
      loadAll: state.loadAll
    };
  }
  function resolveRuntimeMode({ enabled, loadAll, extraMessages }) {
    if (!enabled) {
      return "disabled";
    }
    if (loadAll) {
      return "loadAll";
    }
    if (Number(extraMessages ?? 0) > 0) {
      return "extended";
    }
    return "trimmed";
  }
  function buildStatusSummary(runtimeConfig, status = {}) {
    const runtimeMode = resolveRuntimeMode(runtimeConfig);
    return {
      runtimeMode,
      enabled: Boolean(runtimeConfig.enabled),
      loadAll: Boolean(runtimeConfig.loadAll),
      hasOverride: Boolean(runtimeConfig.loadAll || Number(runtimeConfig.extraMessages ?? 0) > 0),
      hasOlderMessages: Boolean(status?.hasOlderMessages),
      totalMessages: Number(status?.totalMessages ?? 0),
      renderedMessages: Number(status?.renderedMessages ?? 0),
      effectiveLimit: Math.max(
        1,
        Number(runtimeConfig.keepLastN ?? 0) + Number(runtimeConfig.extraMessages ?? 0)
      ),
      extraMessages: Number(runtimeConfig.extraMessages ?? 0)
    };
  }
  function resolveConversationStatusSummary(pageContext, runtimeConfig) {
    if (pageContext.routeKind !== "conversation") {
      return null;
    }
    const storedStatusSummary = runtimeStatusStore.read(pageContext);
    if (storedStatusSummary) {
      return storedStatusSummary;
    }
    const runtimeMode = resolveRuntimeMode(runtimeConfig);
    if (runtimeMode === "loadAll" || runtimeMode === "disabled") {
      return buildStatusSummary(runtimeConfig);
    }
    return null;
  }
  function reloadWithState(nextState) {
    conversationState.write({ url: getPageUrl(), ...nextState });
    reloadPage();
  }
  function clearThreadMonitorRecheckTimer() {
    if (threadMonitorRecheckTimerId == null) {
      return;
    }
    window.clearTimeout(threadMonitorRecheckTimerId);
    threadMonitorRecheckTimerId = null;
  }
  function getThreadMonitorCoordinator(warningThreshold) {
    const normalizedWarningThreshold = Number(warningThreshold ?? 0);
    if (threadMonitorCoordinator && threadMonitorCoordinatorWarningThreshold === normalizedWarningThreshold) {
      return threadMonitorCoordinator;
    }
    threadMonitorCoordinator = createThreadMonitorCoordinator({
      warningThreshold: normalizedWarningThreshold
    });
    threadMonitorCoordinatorWarningThreshold = normalizedWarningThreshold;
    return threadMonitorCoordinator;
  }
  function stopMonitoringThread() {
    if (typeof stopThreadMonitor === "function") {
      stopThreadMonitor();
    }
    stopThreadMonitor = null;
    isStartingThreadMonitor = false;
    clearThreadMonitorRecheckTimer();
  }
  function detectStreaming(doc = document) {
    return Boolean(
      doc.querySelector(
        '[data-testid="stop-button"], button[aria-label*="\u505C\u6B62"], button[aria-label*="Stop"]'
      )
    );
  }
  function detectDraft(doc = document) {
    const textarea = doc.querySelector("textarea");
    if (textarea && textarea.value.trim().length > 0) {
      return true;
    }
    const textbox = doc.querySelector('[contenteditable="true"][role="textbox"], div.ProseMirror');
    if (!textbox) {
      return false;
    }
    return textbox.textContent?.trim().length > 0;
  }
  function scheduleThreadMonitorRecheck(runtimeConfig, result) {
    clearThreadMonitorRecheckTimer();
    if (!runtimeConfig.autoReloadEnabled) {
      return;
    }
    if (resolveRuntimeMode(runtimeConfig) !== "trimmed") {
      return;
    }
    if (result.state.lastObservedBubbleCount < Number(runtimeConfig.warningThreshold ?? 0)) {
      return;
    }
    let delayMs = null;
    if (result.state.phase === "arming") {
      delayMs = AUTO_RELOAD_RECHECK_MS;
    } else if (result.state.phase === "countdown" && !result.shouldReload) {
      delayMs = Math.max(
        0,
        result.state.countdownStartedAt + AUTO_RELOAD_COUNTDOWN_MS - Date.now()
      );
    }
    if (delayMs == null) {
      return;
    }
    threadMonitorRecheckTimerId = window.setTimeout(() => {
      threadMonitorRecheckTimerId = null;
      evaluateThreadMonitor(countVisibleBubbles(document));
      reconcilePanel();
    }, delayMs);
  }
  function evaluateThreadMonitor(bubbleCount) {
    const runtimeConfig = getRuntimeConfig();
    const coordinator = getThreadMonitorCoordinator(runtimeConfig.warningThreshold);
    const result = coordinator.evaluate({
      monitorState: threadMonitorState.read(getPageUrl()),
      runtimeMode: resolveRuntimeMode(runtimeConfig),
      bubbleCount,
      autoReloadEnabled: runtimeConfig.autoReloadEnabled,
      isStreaming: detectStreaming(document),
      hasDraft: detectDraft(document),
      now: Date.now()
    });
    threadMonitorState.write({
      url: getPageUrl(),
      ...result.state
    });
    if (result.shouldReload) {
      clearThreadMonitorRecheckTimer();
      reloadPage();
      return result;
    }
    scheduleThreadMonitorRecheck(runtimeConfig, result);
    return result;
  }
  function syncThreadMonitor(pageContext, statusSummary, doc = null) {
    const resolvedDoc = getPageDocument(doc);
    if (pageContext.routeKind !== "conversation" || !statusSummary || statusSummary.runtimeMode !== "trimmed") {
      stopMonitoringThread();
      threadMonitorState.reset(getPageUrl(resolvedDoc));
      return;
    }
    if (!resolvedDoc || stopThreadMonitor || isStartingThreadMonitor) {
      return;
    }
    isStartingThreadMonitor = true;
    try {
      stopThreadMonitor = observeBubbleCount({
        doc: resolvedDoc,
        onCountChange: (bubbleCount) => {
          evaluateThreadMonitor(bubbleCount);
          reconcilePanel(pageContext, resolvedDoc);
        }
      });
    } finally {
      isStartingThreadMonitor = false;
    }
  }
  function createConversationActions(runtimeConfig, statusSummary) {
    return createV1PanelActions({
      runtimeMode: statusSummary.runtimeMode,
      hasOlderMessages: statusSummary.hasOlderMessages,
      loadAll: statusSummary.loadAll,
      loadMoreStep: runtimeConfig.loadMoreStep,
      onLoadMore: () => reloadWithState({
        extraMessages: runtimeConfig.extraMessages + runtimeConfig.loadMoreStep,
        loadAll: false
      }),
      onLoadAll: () => reloadWithState({
        extraMessages: 0,
        loadAll: true
      }),
      onBackToTrimmed: () => reloadWithState({
        extraMessages: 0,
        loadAll: false
      }),
      onEnableTrimming: () => {
        settingsStore.write({ enabled: true });
        conversationState.reset(getPageUrl());
        reloadPage();
      }
    });
  }
  function createConversationViewModel(runtimeConfig, statusSummary) {
    const panelMode = statusSummary ? "conversation-ready" : "conversation-pending";
    const monitor = statusSummary ? buildThreadMonitorViewModel(runtimeConfig, statusSummary.runtimeMode) : null;
    const effectiveLimit = statusSummary?.effectiveLimit ?? Math.max(1, Number(runtimeConfig.keepLastN ?? 0) + Number(runtimeConfig.extraMessages ?? 0));
    return createPanelViewModel({
      panelMode,
      runtimeMode: statusSummary?.runtimeMode,
      effectiveLimit,
      extraMessages: statusSummary?.extraMessages ?? Number(runtimeConfig.extraMessages ?? 0),
      totalMessages: statusSummary?.totalMessages ?? 0,
      renderedMessages: statusSummary?.renderedMessages ?? 0,
      monitor,
      onReloadNow: () => reloadPage(),
      actions: statusSummary ? createConversationActions(runtimeConfig, statusSummary) : []
    });
  }
  function createLauncherViewModel() {
    return createPanelViewModel({
      panelMode: "launcher"
    });
  }
  function mountControls(viewModel, doc = null) {
    const mountTarget = getPageDocument(doc)?.body ?? null;
    if (!mountTarget) {
      log("warn", "body mount target not found yet");
      return false;
    }
    renderControls({
      mountTarget,
      panelStateStore,
      viewModel
    });
    log("debug", "controls mounted", {
      panelMode: viewModel.panelMode ?? "conversation-ready",
      runtimeMode: viewModel.runtimeMode ?? "n/a"
    });
    return true;
  }
  function schedulePanelReconcile(doc = null) {
    const resolvedDoc = getPageDocument(doc);
    if (!resolvedDoc) {
      return;
    }
    const run = () => {
      loadMountListenerAttached = false;
      reconcilePanel(null, resolvedDoc);
    };
    if (resolvedDoc.body) {
      run();
      return;
    }
    if (loadMountListenerAttached) {
      return;
    }
    loadMountListenerAttached = true;
    resolvedDoc.defaultView?.addEventListener("load", run, { once: true });
  }
  function buildContextFingerprint(pageContext) {
    return JSON.stringify([
      pageContext.url,
      pageContext.routeKind,
      pageContext.conversationId,
      pageContext.hasThreadRoot,
      pageContext.hasVisibleBubbles
    ]);
  }
  function buildDomContextHintFingerprint(pageContext) {
    return JSON.stringify([
      pageContext.url,
      pageContext.routeKind,
      pageContext.conversationId,
      pageContext.hasThreadRoot
    ]);
  }
  function ensureDomContextObserver() {
    if (domContextObserver || typeof MutationObserver !== "function") {
      return;
    }
    const doc = document;
    const observerTarget = doc.documentElement ?? doc.body;
    if (!observerTarget) {
      return;
    }
    domContextObserver = new MutationObserver(() => {
      const panelExists = Boolean(doc.querySelector('[data-chatgpt-lag-userscript="controls"]'));
      const pageContextHint = resolvePageContext(doc, getPageUrl(doc), {
        includeVisibleBubbles: false
      });
      const hintFingerprint = buildDomContextHintFingerprint(pageContextHint);
      if (panelExists && hintFingerprint === lastDomContextHintFingerprint) {
        return;
      }
      const pageContext = panelExists ? pageContextHint : resolvePageContext(doc, getPageUrl(doc));
      const fingerprint = buildContextFingerprint(pageContext);
      if (!panelExists || fingerprint !== lastContextFingerprint) {
        reconcilePanel(pageContext, doc);
      }
    });
    domContextObserver.observe(observerTarget, {
      childList: true,
      subtree: true
    });
  }
  function reconcilePanel(pageContext = null, doc = null) {
    const resolvedDoc = getPageDocument(doc);
    if (!resolvedDoc) {
      return false;
    }
    const resolvedPageContext = pageContext ?? resolvePageContext(resolvedDoc, getPageUrl(resolvedDoc));
    const runtimeConfig = getRuntimeConfig(resolvedDoc);
    const statusSummary = resolveConversationStatusSummary(resolvedPageContext, runtimeConfig);
    const viewModel = resolvedPageContext.routeKind === "conversation" ? createConversationViewModel(runtimeConfig, statusSummary) : createLauncherViewModel();
    if (!mountControls(viewModel, resolvedDoc)) {
      schedulePanelReconcile(resolvedDoc);
      return false;
    }
    lastContextFingerprint = buildContextFingerprint(resolvedPageContext);
    lastDomContextHintFingerprint = buildDomContextHintFingerprint(resolvedPageContext);
    syncThreadMonitor(resolvedPageContext, statusSummary, resolvedDoc);
    return true;
  }
  if (!pageWindow.__chatgptLagUserscriptPatched__) {
    const nativeFetch = pageWindow.fetch.bind(pageWindow);
    pageWindow.fetch = createFetchInterceptor({
      nativeFetch,
      getCurrentUrl: () => getPageUrl(),
      getRuntimeConfig,
      trimConversationMapping,
      dispatchStatus,
      log
    });
    pageWindow.__chatgptLagUserscriptPatched__ = true;
    log("debug", "window.fetch patched", {
      usingUnsafeWindow: pageWindow !== window
    });
  }
  var didRegisterMenuCommands = registerMenuCommands({
    settingsStore,
    conversationState,
    threadMonitorState,
    getCurrentUrl: () => getPageUrl(),
    rebuild: () => reloadPage(),
    registerMenuCommand: gmApi.registerMenuCommand
  });
  if (didRegisterMenuCommands) {
    log("debug", "menu commands registered");
  } else {
    log("warn", "GM menu command API unavailable; menu commands not registered");
  }
  subscribeStatus((event) => {
    log("debug", "received runtime status", event.detail);
    const doc = getPageDocument();
    if (!doc) {
      return;
    }
    const pageContext = resolvePageContext(doc, getPageUrl(doc));
    const runtimeConfig = getRuntimeConfig(doc);
    const statusSummary = buildStatusSummary(runtimeConfig, event.detail);
    const statusConversationId = typeof event.detail?.conversationId === "string" && event.detail.conversationId.length > 0 ? event.detail.conversationId : null;
    const statusPageUrl = typeof event.detail?.pageUrl === "string" && event.detail.pageUrl.length > 0 ? event.detail.pageUrl : null;
    if (statusConversationId && pageContext.conversationId && statusConversationId !== pageContext.conversationId || !statusConversationId && statusPageUrl && statusPageUrl !== pageContext.url) {
      log("debug", "ignored runtime status for inactive page context", {
        currentUrl: pageContext.url,
        currentConversationId: pageContext.conversationId,
        statusPageUrl,
        statusConversationId
      });
      return;
    }
    if (pageContext.routeKind === "conversation") {
      runtimeStatusStore.write({
        url: statusPageUrl ?? pageContext.url,
        conversationId: statusConversationId ?? pageContext.conversationId,
        status: statusSummary
      });
    }
    reconcilePanel(pageContext, doc);
  });
  observeNavigation({
    win: window,
    onNavigate: () => {
      reconcilePanel(resolvePageContext(document, getPageUrl()));
    }
  });
  ensureDomContextObserver();
  schedulePanelReconcile();
})();
