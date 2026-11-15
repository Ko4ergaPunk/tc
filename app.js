(function () {
  "use strict";

  const BROKER_URL = "wss://broker.emqx.io:8084/mqtt";
  const TOPIC_PREFIX = "kodchat/v1";
  const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const CODE_LENGTH = 8;
  const MAX_MESSAGE_LENGTH = 2000;
  const MAX_MESSAGES = 320;
  const HISTORY_LIMIT = 200;
  const SYNC_LIMIT = 30;
  const PRESENCE_INTERVAL = 20000;
  const PEER_TIMEOUT = 90000;
  const TYPING_LIFETIME = 5000;
  const TYPING_REFRESH = 2400;
  const TYPING_STOP_DELAY = 1700;
  const AAD = new TextEncoder().encode("kodchat-v1");
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const AVATAR_COLORS = [
    "#c9ff5b",
    "#6be8c2",
    "#ffd166",
    "#8fb8ff",
    "#ff9dc0",
    "#c4b5fd",
    "#7dd3fc",
    "#fb923c"
  ];

  const $ = (id) => document.getElementById(id);
  const els = {
    landingScreen: $("landing-screen"),
    chatScreen: $("chat-screen"),
    entryForm: $("entry-form"),
    nameInput: $("name-input"),
    tabCreate: $("tab-create"),
    tabJoin: $("tab-join"),
    createPanel: $("create-panel"),
    joinPanel: $("join-panel"),
    codeInput: $("code-input"),
    entryError: $("entry-error"),
    entrySubmit: $("entry-submit"),
    entrySubmitLabel: $("entry-submit-label"),
    topbarCode: $("topbar-code"),
    topbarCodeText: $("topbar-code-text"),
    sidebarCode: $("sidebar-code"),
    sidebarCodeText: $("sidebar-code-text"),
    copyCodeButton: $("copy-code-button"),
    copyLinkButton: $("copy-link-button"),
    shareButton: $("share-button"),
    connectionPill: $("connection-pill"),
    connectionText: $("connection-text"),
    offlineBanner: $("offline-banner"),
    leaveButton: $("leave-button"),
    chatHome: $("chat-home"),
    sidebarToggle: $("sidebar-toggle"),
    sidebar: $("chat-sidebar"),
    sidebarBackdrop: $("sidebar-backdrop"),
    participantList: $("participant-list"),
    participantCount: $("participant-count"),
    mobileCount: $("mobile-count"),
    messages: $("messages"),
    messagesList: $("messages-list"),
    newMessages: $("new-messages"),
    typingLine: $("typing-line"),
    messageForm: $("message-form"),
    messageInput: $("message-input"),
    sendButton: $("send-button"),
    charCount: $("char-count"),
    toastRegion: $("toast-region")
  };

  const state = {
    tab: "create",
    busy: false,
    sessionActive: false,
    sessionToken: null,
    selfId: null,
    code: null,
    name: "",
    room: null,
    client: null,
    connected: false,
    everConnected: false,
    connectionWarned: false,
    messages: [],
    seenMessages: new Set(),
    participants: new Map(),
    sidebarOpen: false,
    selfTyping: false,
    selfTypingTimer: null,
    lastTypingPing: 0,
    saveTimer: null,
    presenceTimer: null,
    pruneTimer: null,
    typingSweepTimer: null,
    connectTimer: null,
    syncResponses: new Set()
  };

  let outbox = Promise.resolve();
  let inbox = Promise.resolve();

  function init() {
    const savedName = readStorage("kodchat:name") || "";
    els.nameInput.value = savedName;
    updateSubmitLabel();

    els.entryForm.addEventListener("submit", handleEntrySubmit);
    els.nameInput.addEventListener("input", () => {
      clearEntryError();
    });
    els.codeInput.addEventListener("input", () => {
      const normalized = normalizeCode(els.codeInput.value);
      if (els.codeInput.value !== normalized) {
        els.codeInput.value = normalized;
      }
      clearEntryError();
    });

    els.tabCreate.addEventListener("click", () => setTab("create"));
    els.tabJoin.addEventListener("click", () => setTab("join"));
    els.tabCreate.addEventListener("keydown", handleTabKeydown);
    els.tabJoin.addEventListener("keydown", handleTabKeydown);

    els.leaveButton.addEventListener("click", () => leaveLobby(true));
    els.chatHome.addEventListener("click", (event) => {
      event.preventDefault();
      leaveLobby(true);
    });
    els.topbarCode.addEventListener("click", copyLobbyCode);
    els.sidebarCode.addEventListener("click", copyLobbyCode);
    els.copyCodeButton.addEventListener("click", copyLobbyCode);
    els.copyLinkButton.addEventListener("click", copyLobbyLink);
    els.shareButton.addEventListener("click", shareLobby);

    els.sidebarToggle.addEventListener("click", () => setSidebar(!state.sidebarOpen));
    els.sidebarBackdrop.addEventListener("click", () => setSidebar(false));

    els.messageForm.addEventListener("submit", (event) => {
      event.preventDefault();
      sendCurrentMessage();
    });
    els.messageInput.addEventListener("input", handleComposerInput);
    els.messageInput.addEventListener("keydown", handleComposerKeydown);
    els.newMessages.addEventListener("click", scrollToBottom);
    els.messages.addEventListener("scroll", handleMessagesScroll, { passive: true });

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("beforeunload", flushHistory);
    window.addEventListener("pagehide", flushHistory);
    window.addEventListener("offline", () => {
      if (!state.sessionActive) {
        return;
      }
      state.connected = false;
      stopSelfTyping();
      setConnection("offline", "Нет связи");
    });
    window.addEventListener("online", () => {
      if (state.sessionActive && !state.connected && state.client) {
        state.client.reconnect();
      }
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && state.sidebarOpen) {
        setSidebar(false);
      }
    });
    window.addEventListener("resize", () => {
      if (window.innerWidth > 900 && state.sidebarOpen) {
        setSidebar(false);
      }
    });

    const initialCode = readRoomFromUrl();
    if (initialCode) {
      setTab("join");
      els.codeInput.value = initialCode;
    } else {
      setTab("create");
    }

    updateComposerState();
  }

  function handleTabKeydown(event) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
      return;
    }
    event.preventDefault();
    const next = state.tab === "create" ? "join" : "create";
    setTab(next);
    (next === "create" ? els.tabCreate : els.tabJoin).focus();
  }

  function setTab(tab) {
    if (state.busy) {
      return;
    }
    state.tab = tab;
    const isCreate = tab === "create";
    els.tabCreate.classList.toggle("is-active", isCreate);
    els.tabJoin.classList.toggle("is-active", !isCreate);
    els.tabCreate.setAttribute("aria-selected", String(isCreate));
    els.tabJoin.setAttribute("aria-selected", String(!isCreate));
    els.tabCreate.setAttribute("tabindex", isCreate ? "0" : "-1");
    els.tabJoin.setAttribute("tabindex", isCreate ? "-1" : "0");
    els.createPanel.hidden = !isCreate;
    els.joinPanel.hidden = isCreate;
    clearEntryError();
    updateSubmitLabel();
  }

  function updateSubmitLabel() {
    if (state.busy) {
      return;
    }
    els.entrySubmitLabel.textContent = state.tab === "create" ? "Создать лобби" : "Войти в лобби";
  }

  function setEntryBusy(busy, label) {
    state.busy = busy;
    els.entrySubmit.disabled = busy;
    els.entrySubmit.classList.toggle("is-busy", busy);
    els.entryForm.setAttribute("aria-busy", String(busy));
    if (busy) {
      els.entrySubmitLabel.textContent = label || "Подключаем…";
    } else {
      updateSubmitLabel();
    }
  }

  function showEntryError(message) {
    els.entryError.textContent = message;
  }

  function clearEntryError() {
    els.entryError.textContent = "";
  }

  async function handleEntrySubmit(event) {
    event.preventDefault();
    if (state.busy) {
      return;
    }

    const name = cleanName(els.nameInput.value);
    if (!name) {
      showEntryError("Введите имя — его увидят другие участники.");
      els.nameInput.focus();
      return;
    }
    els.nameInput.value = name;

    let code;
    if (state.tab === "create") {
      code = generateCode();
    } else {
      code = normalizeCode(els.codeInput.value);
      els.codeInput.value = code;
      if (!isValidCode(code)) {
        showEntryError(`Код должен состоять из ${CODE_LENGTH} символов. Проверьте его.`);
        els.codeInput.focus();
        return;
      }
    }

    if (!window.crypto || !window.crypto.subtle) {
      showEntryError("Для шифрования нужен HTTPS. Откройте сайт через GitHub Pages или localhost.");
      return;
    }
    if (!window.mqtt || typeof window.mqtt.connect !== "function") {
      showEntryError("Не удалось загрузить модуль подключения. Обновите страницу.");
      return;
    }

    writeStorage("kodchat:name", name);
    setEntryBusy(true, state.tab === "create" ? "Создаём лобби…" : "Подключаемся…");

    try {
      await startSession(code, name);
    } catch (error) {
      console.warn(error);
      forceCleanup();
      showLanding();
      showEntryError(friendlyError(error));
      setEntryBusy(false);
      return;
    }

    setEntryBusy(false);
  }

  async function startSession(code, name) {
    const room = await deriveRoom(code);
    const selfId = randomId(8);
    const sessionToken = randomId(8);

    if (state.client) {
      try {
        state.client.end(true);
      } catch (_) {}
    }

    clearSessionTimers();
    state.sessionActive = true;
    state.sessionToken = sessionToken;
    state.selfId = selfId;
    state.code = code;
    state.name = name;
    state.room = room;
    state.connected = false;
    state.everConnected = false;
    state.connectionWarned = false;
    state.messages = [];
    state.seenMessages = new Set();
    state.participants = new Map();
    state.selfTyping = false;
    state.lastTypingPing = 0;
    state.syncResponses = new Set();
    outbox = Promise.resolve();
    inbox = Promise.resolve();

    loadHistory();
    state.participants.set(selfId, {
      id: selfId,
      name,
      lastSeen: Date.now(),
      typing: false,
      typingUntil: 0
    });

    els.topbarCodeText.textContent = formatCode(code);
    els.sidebarCodeText.textContent = formatCode(code);
    els.typingLine.replaceChildren();
    els.newMessages.hidden = true;
    els.messageInput.value = "";
    resizeComposer();
    updateComposerState();
    setConnection("connecting", "Подключение…");
    showChat();
    renderParticipants();
    renderMessages({ forceBottom: true });

    setLobbyUrl(code);
    startSessionTimers();
    await connectMqtt();
  }

  function showChat() {
    els.landingScreen.hidden = true;
    els.chatScreen.hidden = false;
    document.body.classList.add("in-chat");
    document.title = `#${formatCode(state.code)} — кодчат`;
    window.scrollTo(0, 0);
    if (window.matchMedia("(pointer: fine)").matches) {
      window.setTimeout(() => els.messageInput.focus(), 220);
    }
  }

  function showLanding() {
    els.chatScreen.hidden = true;
    els.landingScreen.hidden = false;
    document.body.classList.remove("in-chat");
    document.title = "кодчат — чат по коду";
    window.scrollTo(0, 0);
    setEntryBusy(false);
    updateSubmitLabel();
  }

  async function connectMqtt() {
    const room = state.room;
    const selfId = state.selfId;
    const token = state.sessionToken;
    const leavePayload = await seal(
      { type: "leave", id: selfId, name: state.name, ts: Date.now() },
      room.key
    );

    if (!state.sessionActive || token !== state.sessionToken) {
      return;
    }

    const client = window.mqtt.connect(BROKER_URL, {
      clientId: `kd_${selfId}`,
      clean: true,
      keepalive: 30,
      reconnectPeriod: 2800,
      connectTimeout: 12000,
      protocolVersion: 4,
      will: {
        topic: room.topic,
        payload: leavePayload,
        qos: 0,
        retain: false
      }
    });

    state.client = client;

    client.on("connect", () => {
      if (state.client !== client || token !== state.sessionToken) {
        return;
      }
      state.connected = true;
      state.everConnected = true;
      state.connectionWarned = false;
      clearTimeout(state.connectTimer);
      setConnection("online", "В сети");
      updateComposerState();
      client.subscribe(room.topic, { qos: 1 }, (error) => {
        if (state.client !== client || token !== state.sessionToken) {
          return;
        }
        if (error) {
          showToast("Не удалось подписаться на лобби. Попробуйте ещё раз.", "error");
          return;
        }
        void announcePresence(true);
      });
    });

    client.on("message", (topic, payload) => {
      if (topic !== room.topic || state.client !== client || token !== state.sessionToken) {
        return;
      }
      inbox = inbox
        .then(async () => {
          if (state.client !== client || token !== state.sessionToken) {
            return;
          }
          const event = await openPayload(payload, room.key);
          if (state.client !== client || token !== state.sessionToken) {
            return;
          }
          handleEvent(event);
        })
        .catch(() => {});
    });

    client.on("close", () => {
      if (state.client !== client || token !== state.sessionToken) {
        return;
      }
      state.connected = false;
      updateComposerState();
      if (state.everConnected) {
        setConnection("offline", "Нет связи");
      }
    });

    client.on("offline", () => {
      if (state.client !== client || token !== state.sessionToken) {
        return;
      }
      state.connected = false;
      updateComposerState();
      if (state.everConnected) {
        setConnection("offline", "Нет связи");
      }
    });

    client.on("error", (error) => {
      if (state.client !== client || token !== state.sessionToken) {
        return;
      }
      console.warn("MQTT:", error && error.message ? error.message : error);
      if (!state.everConnected && !state.connectionWarned) {
        state.connectionWarned = true;
        showToast("Не удаётся подключиться к серверу. Проверьте сеть.", "error");
      }
    });

    clearTimeout(state.connectTimer);
    state.connectTimer = window.setTimeout(() => {
      if (
        state.client === client &&
        token === state.sessionToken &&
        !state.connected
      ) {
        setConnection("offline", "Нет связи");
        if (!state.connectionWarned) {
          state.connectionWarned = true;
          showToast("Сервер не отвечает. Продолжаем пытаться…", "error");
        }
      }
    }, 14000);
  }

  async function announcePresence(requestSync) {
    if (!state.connected) {
      return;
    }
    const timestamp = Date.now();
    publishEvent({
      type: "join",
      id: state.selfId,
      name: state.name,
      ts: timestamp
    });
    publishEvent({
      type: "presence",
      id: state.selfId,
      name: state.name,
      ts: timestamp
    });
    if (requestSync) {
      publishEvent({
        type: "sync-request",
        id: state.selfId,
        name: state.name,
        reqId: randomId(6),
        ts: timestamp
      });
    }
  }

  async function seal(value, key) {
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const plaintext = encoder.encode(JSON.stringify(value));
    const ciphertext = await window.crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: AAD },
      key,
      plaintext
    );
    return JSON.stringify({
      v: 1,
      iv: bytesToBase64(iv),
      d: bytesToBase64(new Uint8Array(ciphertext))
    });
  }

  async function openPayload(payload, key) {
    const raw =
      typeof payload === "string" ? payload : decoder.decode(payload);
    if (raw.length > 200000) {
      throw new Error("Payload too large");
    }
    const envelope = JSON.parse(raw);
    if (
      !envelope ||
      envelope.v !== 1 ||
      typeof envelope.iv !== "string" ||
      typeof envelope.d !== "string"
    ) {
      throw new Error("Invalid envelope");
    }
    const plaintext = await window.crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: base64ToBytes(envelope.iv),
        additionalData: AAD
      },
      key,
      base64ToBytes(envelope.d)
    );
    return JSON.parse(decoder.decode(plaintext));
  }

  function publishEvent(event) {
    const client = state.client;
    const room = state.room;
    const token = state.sessionToken;
    if (!client || !room || !client.connected || !state.sessionActive) {
      return Promise.resolve(false);
    }

    outbox = outbox
      .then(async () => {
        if (
          token !== state.sessionToken ||
          !state.sessionActive ||
          state.client !== client ||
          !client.connected
        ) {
          return false;
        }
        const payload = await seal(event, room.key);
        if (
          token !== state.sessionToken ||
          state.client !== client ||
          !client.connected
        ) {
          return false;
        }
        const qos = event.type === "chat" || event.type === "sync-response" ? 1 : 0;
        client.publish(room.topic, payload, { qos });
        return true;
      })
      .catch(() => false);

    return outbox;
  }

  function handleEvent(event) {
    if (!event || typeof event !== "object") {
      return;
    }
    const from = typeof event.id === "string" ? event.id.slice(0, 64) : "";
    if (!from || from === state.selfId) {
      return;
    }

    switch (event.type) {
      case "join": {
        const isNew = ensureParticipant(from, event.name, true);
        if (isNew) {
          publishEvent({
            type: "presence",
            id: state.selfId,
            name: state.name,
            ts: Date.now()
          });
        }
        break;
      }
      case "presence": {
        ensureParticipant(from, event.name, false);
        break;
      }
      case "leave": {
        handleParticipantLeave(from);
        break;
      }
      case "chat": {
        handleIncomingChat(event);
        break;
      }
      case "typing": {
        handleIncomingTyping(event);
        break;
      }
      case "sync-request": {
        handleSyncRequest(event);
        break;
      }
      case "sync-response": {
        handleSyncResponse(event);
        break;
      }
      default:
        break;
    }
  }

  function ensureParticipant(id, rawName, announce) {
    const name = cleanName(rawName) || "Гость";
    const now = Date.now();
    const existing = state.participants.get(id);

    if (!existing) {
      state.participants.set(id, {
        id,
        name,
        lastSeen: now,
        typing: false,
        typingUntil: 0
      });
      if (announce) {
        addSystemMessage(`${name} теперь в лобби`);
      }
      renderParticipants();
      return true;
    }

    existing.lastSeen = now;
    if (name && existing.name !== name) {
      existing.name = name;
      renderParticipants();
    }
    return false;
  }

  function handleParticipantLeave(id) {
    const participant = state.participants.get(id);
    if (!participant) {
      return;
    }
    const wasTyping = participant.typing;
    state.participants.delete(id);
    addSystemMessage(`${participant.name} больше не в лобби`);
    renderParticipants();
    if (wasTyping) {
      refreshTypingUi();
    }
  }

  function handleIncomingChat(event) {
    const message = normalizeChatMessage(event);
    if (!message) {
      return;
    }
    if (state.seenMessages.has(message.msgId)) {
      return;
    }

    ensureParticipant(message.id, message.name, false);
    addChatMessage({ ...message, mine: false }, {
      forceBottom: false,
      flash: true,
      markUnread: true
    });

    const participant = state.participants.get(message.id);
    if (participant && participant.typing) {
      participant.typing = false;
      participant.typingUntil = 0;
      refreshTypingUi();
    }
  }

  function handleIncomingTyping(event) {
    if (!event || typeof event.id !== "string" || !state.sessionActive) {
      return;
    }
    const participant = state.participants.get(event.id);
    if (!participant) {
      return;
    }
    const active = Boolean(event.active);
    const changed = participant.typing !== active;
    participant.typing = active;
    participant.typingUntil = active ? Date.now() + TYPING_LIFETIME : 0;
    participant.lastSeen = Date.now();
    if (changed) {
      refreshTypingUi();
    }
  }

  function handleSyncRequest(event) {
    if (!event || typeof event.reqId !== "string" || !state.connected) {
      return;
    }
    if (state.syncResponses.has(event.reqId)) {
      return;
    }
    state.syncResponses.add(event.reqId);
    if (state.syncResponses.size > 80) {
      state.syncResponses.clear();
      state.syncResponses.add(event.reqId);
    }

    const chats = state.messages
      .filter((message) => message.kind === "chat")
      .slice(-SYNC_LIMIT)
      .map((message) => ({
        id: message.id,
        name: message.name,
        msgId: message.msgId,
        text: message.text,
        ts: message.ts
      }));

    if (!chats.length) {
      return;
    }

    const token = state.sessionToken;
    window.setTimeout(() => {
      if (!state.sessionActive || token !== state.sessionToken || !state.connected) {
        return;
      }
      publishEvent({
        type: "sync-response",
        id: state.selfId,
        name: state.name,
        ts: Date.now(),
        messages: chats
      });
    }, 220 + Math.random() * 480);
  }

  function handleSyncResponse(event) {
    if (!event || !Array.isArray(event.messages)) {
      return;
    }
    let added = false;
    const candidates = event.messages.slice(0, SYNC_LIMIT);

    for (const rawMessage of candidates) {
      const message = normalizeChatMessage(rawMessage);
      if (!message || state.seenMessages.has(message.msgId)) {
        continue;
      }
      state.seenMessages.add(message.msgId);
      state.messages.push({ ...message, kind: "chat", mine: false });
      added = true;
    }

    if (!added) {
      return;
    }

    state.messages.sort(compareMessages);
    trimMessages();
    scheduleHistorySave();
    renderMessages({ forceBottom: false });
  }

  function addChatMessage(message, options) {
    if (!message || state.seenMessages.has(message.msgId)) {
      return false;
    }
    state.seenMessages.add(message.msgId);
    state.messages.push({
      kind: "chat",
      msgId: message.msgId,
      id: message.id,
      name: message.name,
      text: message.text,
      ts: message.ts,
      mine: Boolean(message.mine)
    });
    trimMessages();
    scheduleHistorySave();
    renderMessages({
      forceBottom: Boolean(options && options.forceBottom),
      flash: Boolean(options && options.flash),
      flashId: message.msgId,
      markUnread: Boolean(options && options.markUnread)
    });
    return true;
  }

  function addSystemMessage(text) {
    state.messages.push({
      kind: "system",
      msgId: `sys_${randomId(6)}`,
      text,
      ts: Date.now()
    });
    trimMessages();
    renderMessages({ forceBottom: false });
  }

  function trimMessages() {
    if (state.messages.length > MAX_MESSAGES) {
      state.messages.splice(0, state.messages.length - MAX_MESSAGES);
    }
  }

  function normalizeChatMessage(raw) {
    if (!raw || typeof raw !== "object") {
      return null;
    }
    const id = typeof raw.id === "string" ? raw.id.slice(0, 64) : "";
    const msgId = typeof raw.msgId === "string" ? raw.msgId.slice(0, 64) : "";
    if (!id || !msgId) {
      return null;
    }
    let text = typeof raw.text === "string" ? raw.text : "";
    if (!text.trim()) {
      return null;
    }
    text = text
      .slice(0, MAX_MESSAGE_LENGTH)
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
      .replace(/[\u202a-\u202e\u2066-\u2069]/g, "");
    if (!text) {
      return null;
    }
    const ts = Number(raw.ts);
    if (!Number.isFinite(ts) || ts <= 0) {
      return null;
    }
    return {
      id,
      msgId,
      name: cleanName(raw.name) || "Гость",
      text,
      ts: Math.min(ts, Date.now() + 300000)
    };
  }

  function compareMessages(a, b) {
    if (a.ts !== b.ts) {
      return a.ts - b.ts;
    }
    return String(a.msgId).localeCompare(String(b.msgId));
  }

  function renderMessages(options) {
    const settings = options || {};
    const nearBottom = isNearBottom();
    const scroller = els.messages;
    const previousScrollTop = scroller.scrollTop;
    const previousScrollHeight = scroller.scrollHeight;

    els.messagesList.replaceChildren();

    if (!state.messages.length) {
      els.messagesList.appendChild(createEmptyState());
    } else {
      let lastDay = "";
      let lastSender = "";
      let lastTimestamp = 0;
      let canGroup = false;

      for (const message of state.messages) {
        if (message.kind === "system") {
          const system = document.createElement("div");
          system.className = "system-message";
          system.textContent = message.text;
          els.messagesList.appendChild(system);
          canGroup = false;
          continue;
        }

        const dayKey = getDayKey(message.ts);
        if (dayKey !== lastDay) {
          els.messagesList.appendChild(createDayDivider(message.ts));
          lastDay = dayKey;
          canGroup = false;
        }

        const isMine = message.mine || message.id === state.selfId;
        const grouped =
          canGroup &&
          lastSender === message.id &&
          message.ts - lastTimestamp < 300000;

        els.messagesList.appendChild(createMessageElement(message, isMine, grouped, settings));

        lastSender = message.id;
        lastTimestamp = message.ts;
        canGroup = true;
      }
    }

    if (settings.flashId) {
      window.setTimeout(() => {
        const node = els.messagesList.querySelector(
          `[data-msg-id="${cssEscape(settings.flashId)}"]`
        );
        if (node) {
          node.classList.remove("is-new");
        }
      }, 450);
    }

    if (nearBottom || settings.forceBottom) {
      els.newMessages.hidden = true;
      scrollToBottom(false);
    } else {
      if (settings.markUnread) {
        els.newMessages.hidden = false;
      }
      const heightDelta = scroller.scrollHeight - previousScrollHeight;
      if (heightDelta > 0) {
        scroller.scrollTop = previousScrollTop + heightDelta;
      }
    }
  }

  function createMessageElement(message, isMine, grouped, settings) {
    const row = document.createElement("div");
    row.className = "message-row";
    if (isMine) {
      row.classList.add("is-own");
    }
    if (grouped) {
      row.classList.add("is-grouped");
    }
    if (settings.flash && settings.flashId === message.msgId) {
      row.classList.add("is-new");
    }
    row.dataset.msgId = message.msgId;

    if (!isMine) {
      const avatar = document.createElement("div");
      avatar.className = "message-avatar";
      if (grouped) {
        avatar.classList.add("is-hidden");
      }
      avatar.textContent = getInitials(message.name);
      avatar.style.background = getAvatarColor(message.id);
      row.appendChild(avatar);
    }

    const body = document.createElement("div");
    body.className = "message-body";

    if (!isMine && !grouped) {
      const author = document.createElement("span");
      author.className = "message-author";
      author.textContent = message.name;
      body.appendChild(author);
    }

    const bubble = document.createElement("div");
    bubble.className = "message-bubble";

    const text = document.createElement("span");
    text.className = "message-text";
    text.textContent = message.text;
    bubble.appendChild(text);

    const time = document.createElement("span");
    time.className = "message-time";
    time.textContent = formatTime(message.ts);
    time.title = formatFullDate(message.ts);
    bubble.appendChild(time);

    body.appendChild(bubble);
    row.appendChild(body);
    return row;
  }

  function createDayDivider(timestamp) {
    const divider = document.createElement("div");
    divider.className = "day-divider";
    divider.textContent = formatDay(timestamp);
    return divider;
  }

  function createEmptyState() {
    const wrapper = document.createElement("div");
    wrapper.className = "empty-state";

    const icon = document.createElement("div");
    icon.className = "empty-icon";
    icon.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11.5a8 8 0 0 1-11.6 7.1L4 20l1.4-4.4A8 8 0 1 1 20 11.5Z"/><path d="M8.5 11.5h.01M12 11.5h.01M15.5 11.5h.01"/></svg>';
    wrapper.appendChild(icon);

    const title = document.createElement("h2");
    title.textContent = "Пока тихо";
    wrapper.appendChild(title);

    const description = document.createElement("p");
    description.append("Напишите первое сообщение или отправьте код ");
    const code = document.createElement("strong");
    code.textContent = `#${formatCode(state.code || "")}`;
    description.appendChild(code);
    description.append(" друзьям.");
    wrapper.appendChild(description);

    return wrapper;
  }

  function renderParticipants() {
    const fragment = document.createDocumentFragment();
    const participants = Array.from(state.participants.values()).sort((a, b) => {
      if (a.id === state.selfId) {
        return -1;
      }
      if (b.id === state.selfId) {
        return 1;
      }
      return a.name.localeCompare(b.name, "ru");
    });

    for (const participant of participants) {
      const item = document.createElement("li");
      item.className = "participant";

      const avatar = document.createElement("span");
      avatar.className = "avatar";
      avatar.textContent = getInitials(participant.name);
      avatar.style.setProperty("--avatar", getAvatarColor(participant.id));
      item.appendChild(avatar);

      const info = document.createElement("span");
      info.className = "participant-info";

      const nameRow = document.createElement("span");
      nameRow.className = "participant-name";
      nameRow.textContent = participant.name;

      const isSelf = participant.id === state.selfId;
      if (isSelf) {
        const you = document.createElement("span");
        you.className = "participant-you";
        you.textContent = "вы";
        nameRow.appendChild(document.createTextNode(" "));
        nameRow.appendChild(you);
      }
      info.appendChild(nameRow);

      const status = document.createElement("span");
      status.className = "participant-status";
      if (participant.typing && participant.typingUntil > Date.now()) {
        status.classList.add("is-typing");
        status.textContent = "набирает текст…";
      } else {
        status.textContent = isSelf ? "это вы" : "в сети";
      }
      info.appendChild(status);
      item.appendChild(info);

      const online = document.createElement("span");
      online.className = "participant-online";
      online.setAttribute("aria-hidden", "true");
      item.appendChild(online);

      fragment.appendChild(item);
    }

    els.participantList.replaceChildren(fragment);
    els.participantCount.textContent = String(participants.length);
    els.mobileCount.textContent = String(participants.length);
  }

  function refreshTypingUi() {
    const now = Date.now();
    const typing = Array.from(state.participants.values()).filter(
      (participant) =>
        participant.id !== state.selfId &&
        participant.typing &&
        participant.typingUntil > now
    );

    els.typingLine.replaceChildren();
    if (typing.length) {
      const dots = document.createElement("span");
      dots.className = "typing-dots";
      dots.setAttribute("aria-hidden", "true");
      dots.append(document.createElement("i"), document.createElement("i"), document.createElement("i"));
      els.typingLine.appendChild(dots);

      const label = document.createElement("span");
      if (typing.length === 1) {
        label.textContent = `${typing[0].name} набирает сообщение…`;
      } else if (typing.length === 2) {
        label.textContent = `${typing[0].name} и ${typing[1].name} набирают сообщение…`;
      } else {
        label.textContent = "Несколько человек набирают сообщение…";
      }
      els.typingLine.appendChild(label);
    }

    renderParticipants();
  }

  function handleComposerInput() {
    resizeComposer();
    updateComposerState();

    const value = els.messageInput.value;
    if (!value.trim()) {
      stopSelfTyping();
      return;
    }

    if (!state.connected) {
      return;
    }

    const now = Date.now();
    if (!state.selfTyping) {
      state.selfTyping = true;
      state.lastTypingPing = now;
      sendTyping(true);
    } else if (now - state.lastTypingPing > TYPING_REFRESH) {
      state.lastTypingPing = now;
      sendTyping(true);
    }

    clearTimeout(state.selfTypingTimer);
    state.selfTypingTimer = window.setTimeout(() => {
      stopSelfTyping();
    }, TYPING_STOP_DELAY);
  }

  function handleComposerKeydown(event) {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.isComposing &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey
    ) {
      event.preventDefault();
      sendCurrentMessage();
    }
  }

  function sendCurrentMessage() {
    const text = els.messageInput.value.trim().slice(0, MAX_MESSAGE_LENGTH);
    if (!text) {
      return;
    }
    if (!state.connected) {
      showToast("Нет соединения. Сообщение можно отправить после переподключения.", "error");
      return;
    }

    const message = {
      id: state.selfId,
      msgId: randomId(8),
      name: state.name,
      text,
      ts: Date.now()
    };

    addChatMessage(
      { ...message, mine: true },
      { forceBottom: true, flash: true, markUnread: false }
    );
    publishEvent({ type: "chat", ...message });

    els.messageInput.value = "";
    resizeComposer();
    updateComposerState();
    stopSelfTyping();
    els.messageInput.focus();
  }

  function sendTyping(active) {
    if (!state.connected) {
      return;
    }
    publishEvent({
      type: "typing",
      id: state.selfId,
      name: state.name,
      active: Boolean(active),
      ts: Date.now()
    });
  }

  function stopSelfTyping() {
    clearTimeout(state.selfTypingTimer);
    state.selfTypingTimer = null;
    if (!state.selfTyping) {
      return;
    }
    state.selfTyping = false;
    if (state.connected) {
      sendTyping(false);
    }
  }

  function updateComposerState() {
    const value = els.messageInput.value;
    const length = value.length;
    const canSend = state.connected && Boolean(value.trim());
    els.sendButton.disabled = !canSend;
    els.charCount.textContent = length > 1500 ? `${length}/${MAX_MESSAGE_LENGTH}` : "";
    els.charCount.classList.toggle("is-warning", length > 1800);
  }

  function resizeComposer() {
    const input = els.messageInput;
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 136)}px`;
  }

  function setConnection(mode, text) {
    els.connectionPill.classList.remove("is-online", "is-connecting", "is-offline");
    els.connectionPill.classList.add(`is-${mode}`);
    els.connectionText.textContent = text;
    els.connectionPill.setAttribute("aria-label", text);
    els.offlineBanner.hidden = mode !== "offline";
    updateComposerState();
  }

  function startSessionTimers() {
    clearSessionTimers();
    state.presenceTimer = window.setInterval(() => {
      if (state.sessionActive && state.connected) {
        publishEvent({
          type: "presence",
          id: state.selfId,
          name: state.name,
          ts: Date.now()
        });
      }
    }, PRESENCE_INTERVAL);

    state.pruneTimer = window.setInterval(pruneParticipants, 8000);

    state.typingSweepTimer = window.setInterval(() => {
      const now = Date.now();
      let changed = false;
      for (const participant of state.participants.values()) {
        if (participant.typing && participant.typingUntil <= now) {
          participant.typing = false;
          participant.typingUntil = 0;
          changed = true;
        }
      }
      if (changed) {
        refreshTypingUi();
      }
    }, 1000);
  }

  function clearSessionTimers() {
    clearInterval(state.presenceTimer);
    clearInterval(state.pruneTimer);
    clearInterval(state.typingSweepTimer);
    clearTimeout(state.connectTimer);
    state.presenceTimer = null;
    state.pruneTimer = null;
    state.typingSweepTimer = null;
    state.connectTimer = null;
  }

  function pruneParticipants() {
    if (!state.sessionActive) {
      return;
    }
    const now = Date.now();
    let changed = false;
    let typingChanged = false;

    for (const [id, participant] of state.participants) {
      if (id === state.selfId) {
        continue;
      }
      if (now - participant.lastSeen > PEER_TIMEOUT) {
        state.participants.delete(id);
        changed = true;
        if (participant.typing) {
          typingChanged = true;
        }
      }
    }

    if (changed) {
      renderParticipants();
    }
    if (typingChanged) {
      refreshTypingUi();
    }
  }

  function handleVisibilityChange() {
    if (document.visibilityState === "hidden") {
      stopSelfTyping();
      flushHistory();
      return;
    }
    if (state.sessionActive && state.connected) {
      publishEvent({
        type: "presence",
        id: state.selfId,
        name: state.name,
        ts: Date.now()
      });
    }
  }

  async function leaveLobby(showToastAfter) {
    if (!state.sessionActive && els.chatScreen.hidden) {
      return;
    }

    const client = state.client;
    const room = state.room;
    const selfId = state.selfId;
    const name = state.name;

    stopSelfTyping();

    if (client && client.connected && room && selfId) {
      try {
        const payload = await seal(
          { type: "leave", id: selfId, name, ts: Date.now() },
          room.key
        );
        client.publish(room.topic, payload, { qos: 0 });
      } catch (_) {}
    }

    flushHistory();
    clearSessionTimers();
    state.sessionActive = false;
    state.connected = false;
    state.sessionToken = null;
    state.client = null;

    if (client) {
      window.setTimeout(() => {
        try {
          client.end(true);
        } catch (_) {}
      }, 180);
    }

    state.room = null;
    state.code = null;
    state.selfId = null;
    state.messages = [];
    state.seenMessages = new Set();
    state.participants = new Map();
    state.syncResponses = new Set();
    setSidebar(false);
    els.messagesList.replaceChildren();
    els.participantList.replaceChildren();
    els.typingLine.replaceChildren();
    els.newMessages.hidden = true;
    els.messageInput.value = "";
    resizeComposer();
    updateComposerState();
    clearLobbyUrl();
    showLanding();
    setTab("create");
    clearEntryError();
    els.codeInput.value = "";

    if (showToastAfter) {
      showToast("Вы вышли из лобби");
    }
  }

  function forceCleanup() {
    clearSessionTimers();
    clearTimeout(state.selfTypingTimer);
    state.selfTypingTimer = null;
    state.selfTyping = false;
    if (state.client) {
      try {
        state.client.end(true);
      } catch (_) {}
    }
    state.sessionActive = false;
    state.connected = false;
    state.sessionToken = null;
    state.client = null;
    state.room = null;
    state.code = null;
    state.selfId = null;
    clearLobbyUrl();
  }

  function setSidebar(open) {
    state.sidebarOpen = Boolean(open);
    if (state.sidebarOpen && document.activeElement === els.messageInput) {
      els.messageInput.blur();
    }
    els.sidebar.classList.toggle("is-open", state.sidebarOpen);
    els.sidebarBackdrop.hidden = !state.sidebarOpen;
    els.sidebarToggle.setAttribute("aria-expanded", String(state.sidebarOpen));
    els.sidebarToggle.setAttribute(
      "aria-label",
      state.sidebarOpen ? "Скрыть участников" : "Показать участников"
    );
  }

  function handleMessagesScroll() {
    if (isNearBottom()) {
      els.newMessages.hidden = true;
    }
  }

  function isNearBottom() {
    const scroller = els.messages;
    return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120;
  }

  function scrollToBottom(smooth) {
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const behavior = smooth && !reduceMotion ? "smooth" : "auto";
    els.messages.scrollTo({ top: els.messages.scrollHeight, behavior });
    els.newMessages.hidden = true;
  }

  async function copyLobbyCode() {
    if (!state.code) {
      return;
    }
    const copied = await copyText(state.code);
    showToast(copied ? "Код скопирован" : "Не удалось скопировать код", copied ? "info" : "error");
  }

  async function copyLobbyLink() {
    if (!state.code) {
      return;
    }
    const copied = await copyText(buildRoomLink());
    showToast(
      copied ? "Ссылка на лобби скопирована" : "Не удалось скопировать ссылку",
      copied ? "info" : "error"
    );
  }

  async function shareLobby() {
    if (!state.code) {
      return;
    }
    const url = buildRoomLink();
    const text = `Заходи в лобби «${formatCode(state.code)}» в кодчате`;
    if (navigator.share) {
      try {
        await navigator.share({ title: "кодчат", text, url });
        return;
      } catch (error) {
        if (error && error.name === "AbortError") {
          return;
        }
      }
    }
    const copied = await copyText(url);
    showToast(
      copied ? "Ссылка на лобби скопирована" : "Не удалось скопировать ссылку",
      copied ? "info" : "error"
    );
  }

  async function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch (_) {}
    }
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      area.style.pointerEvents = "none";
      document.body.appendChild(area);
      area.select();
      const copied = document.execCommand("copy");
      area.remove();
      return copied;
    } catch (_) {
      return false;
    }
  }

  function showToast(message, type) {
    const toast = document.createElement("div");
    toast.className = `toast${type === "error" ? " is-error" : ""}`;
    toast.textContent = message;
    els.toastRegion.appendChild(toast);

    window.setTimeout(() => {
      toast.classList.add("is-leaving");
      window.setTimeout(() => toast.remove(), 260);
    }, type === "error" ? 4500 : 3000);
  }

  function scheduleHistorySave() {
    clearTimeout(state.saveTimer);
    state.saveTimer = window.setTimeout(saveHistory, 180);
  }

  function saveHistory() {
    if (!state.room || !state.room.historyKey) {
      return;
    }
    clearTimeout(state.saveTimer);
    state.saveTimer = null;
    const chats = state.messages
      .filter((message) => message.kind === "chat")
      .slice(-HISTORY_LIMIT)
      .map((message) => ({
        msgId: message.msgId,
        id: message.id,
        name: message.name,
        text: message.text,
        ts: message.ts,
        mine: Boolean(message.mine)
      }));
    try {
      if (chats.length) {
        localStorage.setItem(state.room.historyKey, JSON.stringify(chats));
      } else {
        localStorage.removeItem(state.room.historyKey);
      }
    } catch (_) {}
  }

  function flushHistory() {
    if (state.room) {
      saveHistory();
    }
  }

  function loadHistory() {
    if (!state.room || !state.room.historyKey) {
      return;
    }
    try {
      const raw = localStorage.getItem(state.room.historyKey);
      if (!raw) {
        return;
      }
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return;
      }
      const history = [];
      for (const item of parsed.slice(-HISTORY_LIMIT)) {
        const normalized = normalizeChatMessage(item);
        if (!normalized || state.seenMessages.has(normalized.msgId)) {
          continue;
        }
        state.seenMessages.add(normalized.msgId);
        history.push({
          ...normalized,
          kind: "chat",
          mine: Boolean(item.mine)
        });
      }
      history.sort(compareMessages);
      state.messages = history.slice(-HISTORY_LIMIT);
    } catch (_) {}
  }

  async function deriveRoom(code) {
    const baseKey = await window.crypto.subtle.importKey(
      "raw",
      encoder.encode(code),
      "PBKDF2",
      false,
      ["deriveBits"]
    );
    const material = new Uint8Array(
      await window.crypto.subtle.deriveBits(
        {
          name: "PBKDF2",
          salt: encoder.encode(`${TOPIC_PREFIX}/room/v1`),
          iterations: 120000,
          hash: "SHA-256"
        },
        baseKey,
        512
      )
    );
    const roomId = bytesToHex(material.slice(0, 32));
    const key = await window.crypto.subtle.importKey(
      "raw",
      material.slice(32, 64),
      { name: "AES-GCM" },
      false,
      ["encrypt", "decrypt"]
    );
    return {
      topic: `${TOPIC_PREFIX}/${roomId}`,
      key,
      historyKey: `kodchat:history:${roomId}`
    };
  }

  function generateCode() {
    const bytes = window.crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
    let code = "";
    for (const byte of bytes) {
      code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
    }
    return code;
  }

  function normalizeCode(value) {
    return String(value || "")
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "")
      .slice(0, CODE_LENGTH);
  }

  function isValidCode(code) {
    return (
      code.length === CODE_LENGTH &&
      Array.from(code).every((character) => CODE_ALPHABET.includes(character))
    );
  }

  function formatCode(code) {
    if (!code) {
      return "";
    }
    return code.length > 4 ? `${code.slice(0, 4)} ${code.slice(4)}` : code;
  }

  function buildRoomLink() {
    try {
      const url = new URL(window.location.href);
      url.searchParams.set("room", state.code);
      url.hash = "";
      return url.toString();
    } catch (_) {
      return `${window.location.origin}${window.location.pathname}?room=${state.code}`;
    }
  }

  function setLobbyUrl(code) {
    try {
      const url = new URL(window.location.href);
      url.searchParams.set("room", code);
      url.hash = "";
      window.history.replaceState(null, "", url);
    } catch (_) {}
  }

  function clearLobbyUrl() {
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete("room");
      window.history.replaceState(null, "", url);
    } catch (_) {}
  }

  function readRoomFromUrl() {
    try {
      const code = normalizeCode(new URL(window.location.href).searchParams.get("room"));
      return isValidCode(code) ? code : "";
    } catch (_) {
      return "";
    }
  }

  function cleanName(value) {
    return String(value || "")
      .normalize("NFKC")
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .replace(/[\u202a-\u202e\u2066-\u2069]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 24);
  }

  function randomId(size) {
    const bytes = window.crypto.getRandomValues(new Uint8Array(size));
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  function bytesToBase64(bytes) {
    let binary = "";
    const chunk = 0x8000;
    for (let index = 0; index < bytes.length; index += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(index, index + chunk));
    }
    return window.btoa(binary);
  }

  function base64ToBytes(value) {
    const binary = window.atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }

  function bytesToHex(bytes) {
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  function getInitials(name) {
    const parts = String(name || "?").trim().split(/\s+/).filter(Boolean);
    if (!parts.length) {
      return "?";
    }
    const first = Array.from(parts[0])[0] || "?";
    const second = parts[1] ? Array.from(parts[1])[0] || "" : "";
    return `${first}${second}`.toUpperCase();
  }

  function getAvatarColor(id) {
    let hash = 2166136261;
    for (let index = 0; index < id.length; index += 1) {
      hash ^= id.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
  }

  function getDayKey(timestamp) {
    const date = new Date(timestamp);
    return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
  }

  function formatDay(timestamp) {
    const date = new Date(timestamp);
    const today = new Date();
    const yesterday = new Date();
    yesterday.setDate(today.getDate() - 1);
    if (getDayKey(timestamp) === getDayKey(today.getTime())) {
      return "Сегодня";
    }
    if (getDayKey(timestamp) === getDayKey(yesterday.getTime())) {
      return "Вчера";
    }
    const options = { day: "numeric", month: "long" };
    if (date.getFullYear() !== today.getFullYear()) {
      options.year = "numeric";
    }
    return date.toLocaleDateString("ru-RU", options);
  }

  function formatTime(timestamp) {
    const date = new Date(timestamp);
    return `${String(date.getHours()).padStart(2, "0")}:${String(
      date.getMinutes()
    ).padStart(2, "0")}`;
  }

  function formatFullDate(timestamp) {
    return new Date(timestamp).toLocaleString("ru-RU", {
      day: "numeric",
      month: "long",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    });
  }

  function friendlyError(error) {
    if (error && /crypto|subtle|https/i.test(String(error.message))) {
      return "Для шифрования нужен HTTPS. Откройте сайт через GitHub Pages или localhost.";
    }
    return "Не удалось создать лобби. Попробуйте ещё раз.";
  }

  function readStorage(key) {
    try {
      return localStorage.getItem(key);
    } catch (_) {
      return null;
    }
  }

  function writeStorage(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch (_) {}
  }

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === "function") {
      return window.CSS.escape(value);
    }
    return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  }

  init();
})();
