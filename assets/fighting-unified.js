(() => {
  const C = window.BONCATTA;
  const data = window.BONCATTA_GAME_DATA;
  if (!C || !data || !document.getElementById("modeSelect")) return;

  const $ = (id) => document.getElementById(id);
  const { CHARACTER_DEFS, CHARACTER_BY_ID, SKILL_META, COLORS } = data;
  const ROOM_TTL_MS = 35000;
  const ROOM_HEARTBEAT_MS = 7000;
  const MQTT_BROKER = "wss://broker.emqx.io:8084/mqtt";
  const MQTT_TOPIC = "boncatta/baota/unified/v1/rooms";

  const MODES = {
    duel: {
      label: "1v1 经典",
      short: "1v1",
      maxSeats: 2,
      minStart: 2,
      setup: "single",
      seatOwners: ["host", "guest"],
      teamOf: (index) => index,
      note: "经典单角色对战：两名玩家各控制一名角色，最后存活者胜利。",
    },
    commander: {
      label: "2v2 指挥官",
      short: "指挥官",
      maxSeats: 4,
      minStart: 4,
      setup: "team",
      seatOwners: ["host", "host", "guest", "guest"],
      teamOf: (index) => (index < 2 ? 0 : 1),
      note: "两名真实玩家各控制两名角色；房主队对访客队。",
    },
    team4: {
      label: "2v2 四玩家",
      short: "四玩家",
      maxSeats: 4,
      minStart: 4,
      setup: "single",
      seatOwners: ["host", "guest", "guest", "guest"],
      teamOf: (index) => (index === 0 || index === 2 ? 0 : 1),
      note: "四名真实玩家各控制一名角色；1、3 号为房主队，2、4 号为访客队。",
    },
    ffa: {
      label: "多人混战",
      short: "混战",
      maxSeats: 4,
      minStart: 2,
      setup: "single",
      seatOwners: ["host", "guest", "guest", "guest"],
      teamOf: (index) => index,
      note: "最多四名玩家各自为战，最后存活者获胜。",
    },
  };

  const DEFAULT_CHARS = ["undead", "frost", "medicine", "knight"];

  const app = {
    mode: "duel",
    role: "lobby",
    roomCode: "",
    peer: null,
    hostConn: null,
    conns: new Map(),
    seatIndex: null,
    seats: [],
    engine: null,
    rooms: new Map(),
    lobbyClient: null,
    lobbyTimer: null,
    auth: null,
    lobbyStarted: false,
  };

  const ACCOUNTS_KEY = "boncattaAccountsV1";
  const SESSION_KEY = "boncattaSessionV1";

  function loadAccounts() {
    try {
      return JSON.parse(localStorage.getItem(ACCOUNTS_KEY) || "{}");
    } catch {
      return {};
    }
  }

  function saveAccounts(accounts) {
    localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(accounts));
  }

  async function hashPassword(username, password) {
    const input = new TextEncoder().encode(`${username}\n${password}`);
    const digest = await crypto.subtle.digest("SHA-256", input);
    return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  function cleanUsername(value) {
    return String(value || "").trim().replace(/\s+/g, " ").slice(0, 18);
  }

  function restoreSession() {
    try {
      const session = JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
      const accounts = loadAccounts();
      if (session?.username && accounts[session.username]) app.auth = { username: session.username };
    } catch {
      app.auth = null;
    }
  }

  function fillNamesFromAuth(force = false) {
    if (!app.auth?.username) return;
    const username = app.auth.username;
    const defaults = new Set(["", "玩家", "玩家一号", "玩家二号"]);
    const setIfDefault = (id, value) => {
      const node = $(id);
      if (!node) return;
      if (force || defaults.has(node.value)) node.value = value;
    };
    setIfDefault("playerName0", username);
    setIfDefault("playerName1", `${username}一号`);
    setIfDefault("playerName2", `${username}二号`);
  }

  function applyAuthState() {
    const authed = Boolean(app.auth);
    $("loginPanel").hidden = authed;
    $("gameContent").hidden = !authed;
    if (authed) {
      fillNamesFromAuth();
      updateNotes();
      updateNetworkStatus(`${app.auth.username} 已登录。`);
      if (!app.lobbyStarted) {
        app.lobbyStarted = true;
        connectLobby();
      }
    } else {
      updateNetworkStatus("请先登录暴塔。");
    }
    updateLocks();
  }

  async function login() {
    const username = cleanUsername($("loginName").value);
    const password = $("loginPassword").value;
    const message = $("loginMessage");
    if (!username) {
      message.textContent = "请输入用户名。";
      return;
    }
    if (!/^\d{6,}$/.test(password)) {
      message.textContent = "密码必须是 6 位以上数字。";
      return;
    }
    if (!crypto?.subtle) {
      message.textContent = "当前浏览器不支持本地密码哈希。";
      return;
    }
    const accounts = loadAccounts();
    const hash = await hashPassword(username, password);
    if (accounts[username] && accounts[username].hash !== hash) {
      message.textContent = "密码不正确。";
      return;
    }
    if (!accounts[username]) {
      accounts[username] = { hash, createdAt: Date.now() };
      saveAccounts(accounts);
      message.textContent = "已创建本地账号。";
    }
    localStorage.setItem(SESSION_KEY, JSON.stringify({ username, loggedAt: Date.now() }));
    app.auth = { username };
    fillNamesFromAuth(true);
    applyAuthState();
  }

  function clampName(value, fallback) {
    const clean = String(value || "").trim().replace(/\s+/g, " ").slice(0, 18);
    return clean || fallback;
  }

  function currentDef(id) {
    return CHARACTER_BY_ID[id] || CHARACTER_DEFS[0];
  }

  function cleanSelection(selection, fallbackName, fallbackCharacter = "undead") {
    const def = currentDef(selection?.characterId || fallbackCharacter);
    return { name: clampName(selection?.name, fallbackName), characterId: def.id };
  }

  function blankSeat(index, mode = app.mode) {
    const config = MODES[mode];
    return {
      index,
      occupied: false,
      owner: config.seatOwners[index] || "guest",
      connId: "",
      team: config.teamOf(index),
      selection: cleanSelection({}, `空位${index + 1}`, DEFAULT_CHARS[index] || "undead"),
    };
  }

  function makeSeats(mode = app.mode) {
    return Array.from({ length: MODES[mode].maxSeats }, (_, index) => blankSeat(index, mode));
  }

  function singleSelection() {
    return cleanSelection({
      name: $("playerName0").value,
      characterId: $("playerCharacter0").value,
    }, app.auth?.username || "玩家", "undead");
  }

  function commanderSelections(owner) {
    const prefix = owner === "host" ? "房主" : "访客";
    return [
      cleanSelection({ name: $("playerName1").value, characterId: $("playerCharacter1").value }, `${prefix}一号`, "undead"),
      cleanSelection({ name: $("playerName2").value, characterId: $("playerCharacter2").value }, `${prefix}二号`, "frost"),
    ];
  }

  function mySelectionsForMode(mode = app.mode) {
    return MODES[mode].setup === "team" ? commanderSelections(app.role === "guest" ? "guest" : "host") : [singleSelection()];
  }

  function setSeatSelectionFromMine() {
    const selections = mySelectionsForMode();
    if (app.role === "host") {
      if (app.mode === "commander") {
        occupySeat(0, selections[0], "host", "");
        occupySeat(1, selections[1], "host", "");
      } else {
        occupySeat(0, selections[0], "host", "");
      }
    } else if (app.seatIndex != null) {
      if (app.mode === "commander") {
        occupySeat(2, selections[0], "guest", app.hostConn?.connectionId || "guest");
        occupySeat(3, selections[1], "guest", app.hostConn?.connectionId || "guest");
      } else {
        occupySeat(app.seatIndex, selections[0], "guest", app.hostConn?.connectionId || "guest");
      }
    }
  }

  function occupySeat(index, selection, owner, connId) {
    if (!app.seats[index]) app.seats[index] = blankSeat(index);
    app.seats[index] = {
      ...app.seats[index],
      occupied: true,
      owner,
      connId: connId || "",
      selection: cleanSelection(selection, `${owner === "host" ? "房主" : "玩家"}${index + 1}`, DEFAULT_CHARS[index] || "undead"),
    };
  }

  function vacantJoinSeat() {
    if (app.mode === "commander") return app.seats[2]?.occupied ? null : 2;
    for (let index = 1; index < app.seats.length; index += 1) {
      if (!app.seats[index].occupied) return index;
    }
    return null;
  }

  function selectedMode() {
    return $("modeSelect").value || "duel";
  }

  function updateModeUi() {
    app.mode = selectedMode();
    const config = MODES[app.mode];
    $("modeNote").innerHTML = `<strong>${config.label}</strong><p class="small">${config.note}</p>`;
    $("singleSetup").hidden = config.setup === "team";
    $("commanderSetup").hidden = config.setup !== "team";
    $("startGame").textContent = app.mode === "ffa" ? "开始混战" : app.mode === "duel" ? "开始 1v1" : "开始 2v2";
    $("createRoom").textContent = `创建${config.short}房间`;
    renderSeats();
  }

  function renderOptions() {
    const options = CHARACTER_DEFS.map((def) => `<option value="${def.id}">${C.escapeHtml(def.name)} - ${C.escapeHtml(def.desc)}</option>`).join("");
    ["playerCharacter0", "playerCharacter1", "playerCharacter2"].forEach((id, index) => {
      const node = $(id);
      if (!node) return;
      node.innerHTML = options;
      node.value = DEFAULT_CHARS[index] || "undead";
    });
  }

  function updateNotes() {
    [0, 1, 2].forEach((index) => {
      const character = $(`playerCharacter${index}`)?.value;
      const note = $(`playerNote${index}`);
      if (!character || !note) return;
      const def = currentDef(character);
      const total = def.skills.reduce((sum, skill) => sum + skill[1], 0);
      note.innerHTML = `<strong>${C.escapeHtml(def.name)}</strong>：${C.escapeHtml(def.desc)}<div class="tags">${def.skills.map(([name, prob, handler]) => `<span class="tag" style="border-color:${SKILL_META[handler]?.[1] || "#d8dee8"}">${C.escapeHtml(name)} ${prob}%</span>`).join("")}</div><div class="small">概率合计 ${total}%</div>`;
    });
  }

  function renderRoster() {
    $("roster").innerHTML = CHARACTER_DEFS.map((def) => {
      const skills = def.skills.map(([name, prob, handler]) => {
        const color = SKILL_META[handler]?.[1] || "#667085";
        return `<span class="tag" style="border-color:${color};color:${color}">${C.escapeHtml(name)} ${prob}%</span>`;
      }).join("");
      return `<article class="game-roster-card"><h3>${C.escapeHtml(def.name)}</h3><p class="small">${C.escapeHtml(def.desc)}</p><div class="tags">${skills}</div></article>`;
    }).join("");
  }

  function seatTeamLabel(mode, index) {
    if (mode === "ffa") return `独立阵营 ${index + 1}`;
    if (mode === "team4") return index === 0 || index === 2 ? "房主队" : "访客队";
    if (mode === "commander") return index < 2 ? "房主队" : "访客队";
    return index === 0 ? "房主" : "访客";
  }

  function renderSeats() {
    const seats = app.seats.length ? app.seats : makeSeats(app.mode);
    $("seatHelp").textContent = MODES[app.mode].note;
    $("seatList").innerHTML = seats.map((seat, index) => {
      const def = currentDef(seat.selection?.characterId);
      const me = app.seatIndex === index || (app.role === "host" && app.mode === "commander" && index < 2);
      return `<article class="multi-seat ${seat.occupied ? "is-occupied" : ""} ${me ? "is-me" : ""}">
        <strong>${index + 1} 号位 · ${C.escapeHtml(seatTeamLabel(app.mode, index))}</strong>
        <span>${seat.occupied ? C.escapeHtml(seat.selection?.name || "玩家") : "空位"}</span>
        <span class="small">${seat.occupied ? C.escapeHtml(def.name) : "等待加入"}</span>
      </article>`;
    }).join("");
  }

  function updateNetworkStatus(text) {
    $("networkStatus").textContent = text;
    $("roomInfo").textContent = text;
  }

  function updateLocks() {
    const authed = Boolean(app.auth);
    const inRoom = app.role !== "lobby";
    const inBattle = Boolean(app.engine);
    $("modeSelect").disabled = inRoom;
    $("createRoom").disabled = !authed || inRoom || inBattle;
    $("joinRoom").disabled = !authed || inRoom || inBattle;
    $("copyRoom").disabled = !app.roomCode;
    $("leaveRoom").disabled = !inRoom;
    $("startGame").disabled = !authed || app.role !== "host" || inBattle || occupiedCount() < MODES[app.mode].minStart;
    $("sideHint").textContent = !authed
      ? "请先登录。"
      : app.role === "host"
      ? "你是房主，负责结算并同步战斗。"
      : app.role === "guest"
        ? `你是 ${Number(app.seatIndex) + 1} 号位，等待房主开始。`
        : "选择模式后创建房间；加入房间时会自动采用该房间模式。";
  }

  function occupiedCount() {
    return app.seats.filter((seat) => seat.occupied).length;
  }

  function roomSummary() {
    const config = MODES[app.mode];
    const names = app.seats.filter((seat) => seat.occupied).map((seat) => seat.selection?.name).join(" / ");
    return `${config.short} · ${occupiedCount()}/${config.maxSeats} · ${names || "等待玩家"}`;
  }

  function createRoomCode() {
    return Math.random().toString(36).slice(2, 7).toUpperCase();
  }

  function peerId(code, mode = app.mode) {
    return `boncatta-unified-${mode}-${String(code || "").trim().toLowerCase().replace(/[^a-z0-9-]/g, "")}`;
  }

  function mqttTopic(code = "+") {
    return `${MQTT_TOPIC}/${code}`;
  }

  function publishRoom(status = null) {
    if (app.role !== "host" || !app.roomCode) return;
    const payload = {
      type: "room",
      code: app.roomCode,
      mode: app.mode,
      label: MODES[app.mode].label,
      status: status || (app.engine ? "playing" : occupiedCount() >= MODES[app.mode].minStart ? "ready" : "waiting"),
      count: occupiedCount(),
      maxSeats: MODES[app.mode].maxSeats,
      summary: roomSummary(),
      updatedAt: Date.now(),
      createdAt: Date.now(),
    };
    app.rooms.set(app.roomCode, { ...payload, seenAt: Date.now() });
    renderRooms();
    if (app.lobbyClient?.connected) app.lobbyClient.publish(mqttTopic(app.roomCode), JSON.stringify(payload), { qos: 0, retain: false });
  }

  function closePublishedRoom() {
    if (!app.roomCode) return;
    const payload = { type: "room", code: app.roomCode, mode: app.mode, status: "closed", updatedAt: Date.now() };
    app.rooms.delete(app.roomCode);
    renderRooms();
    if (app.lobbyClient?.connected) app.lobbyClient.publish(mqttTopic(app.roomCode), JSON.stringify(payload), { qos: 0, retain: false });
  }

  function connectLobby(force = false) {
    if (!window.mqtt) {
      updateNetworkStatus("公共大厅库加载失败，可以手动输入房间码。");
      return;
    }
    if (!force && app.lobbyClient?.connected) return;
    try { app.lobbyClient?.end(true); } catch {}
    $("lobbyStatus").textContent = "连接公共大厅中...";
    app.lobbyClient = mqtt.connect(MQTT_BROKER, {
      clientId: `boncatta_unified_${Math.random().toString(36).slice(2)}`,
      clean: true,
      connectTimeout: 8000,
      reconnectPeriod: 5000,
    });
    app.lobbyClient.on("connect", () => {
      updateNetworkStatus("公共大厅已连接。");
      $("lobbyStatus").textContent = "公共大厅已连接，统一房间列表实时更新。";
      app.lobbyClient.subscribe(mqttTopic("+"));
      publishRoom();
    });
    app.lobbyClient.on("message", (topic, buffer) => {
      let room;
      try { room = JSON.parse(buffer.toString()); } catch { return; }
      if (!room?.code) return;
      if (room.status === "closed") app.rooms.delete(room.code);
      else app.rooms.set(room.code, { ...room, seenAt: Date.now() });
      renderRooms();
    });
    app.lobbyClient.on("close", () => {
      updateNetworkStatus("公共大厅连接断开，正在重连。");
      $("lobbyStatus").textContent = "公共大厅连接断开，正在重连。";
    });
    app.lobbyClient.on("error", () => {
      updateNetworkStatus("公共大厅连接失败，可以手动输入房间码。");
      $("lobbyStatus").textContent = "公共大厅连接失败，可以手动输入房间码。";
    });
  }

  function renderRooms() {
    const rooms = [...app.rooms.values()]
      .filter((room) => Date.now() - (room.updatedAt || 0) < ROOM_TTL_MS)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    $("roomList").innerHTML = rooms.length
      ? rooms.map((room) => {
        const statusText = room.status === "playing" ? "对战中" : room.status === "ready" ? "可开始" : "等待中";
        const full = Number(room.count || 0) >= Number(room.maxSeats || 2);
        const disabled = app.role !== "lobby" || room.status === "playing" || full;
        return `<article class="game-room-card">
          <div>
            <strong>${C.escapeHtml(room.code)}</strong>
            <span class="game-room-status status-${C.escapeHtml(room.status || "waiting")}">${statusText}</span>
            <span class="game-room-status status-ready">${C.escapeHtml(room.label || MODES[room.mode]?.label || "暴塔")}</span>
          </div>
          <p>${C.escapeHtml(room.summary || "")}</p>
          <p class="small">${C.fmt.format(room.count || 0)} / ${C.fmt.format(room.maxSeats || 2)} 人</p>
          <button type="button" data-join-room="${C.escapeHtml(room.code)}" data-room-mode="${C.escapeHtml(room.mode || "duel")}" ${disabled ? "disabled" : ""}>加入</button>
        </article>`;
      }).join("")
      : `<div class="empty">暂无公开房间。你可以选择模式创建一个。</div>`;
  }

  function createRoom() {
    if (!app.auth) {
      updateNetworkStatus("请先登录。");
      return;
    }
    if (!window.Peer) {
      updateNetworkStatus("联机库暂时没有加载成功，请稍后重试。");
      return;
    }
    app.mode = selectedMode();
    app.role = "host";
    app.seatIndex = 0;
    app.roomCode = createRoomCode();
    app.seats = makeSeats(app.mode);
    setSeatSelectionFromMine();
    app.peer = new Peer(peerId(app.roomCode), { debug: 1 });
    app.peer.on("open", () => {
      updateNetworkStatus(`${MODES[app.mode].label} 房间已创建：${app.roomCode}`);
      publishRoom("waiting");
      app.lobbyTimer = window.setInterval(() => publishRoom(), ROOM_HEARTBEAT_MS);
      renderSeats();
      updateLocks();
    });
    app.peer.on("connection", setupGuestConnection);
    app.peer.on("error", (err) => {
      updateNetworkStatus(`创建房间失败：${err.message || err.type || err}`);
      updateLocks();
    });
    renderSeats();
    updateLocks();
  }

  function setupGuestConnection(conn) {
    conn.on("open", () => {
      conn.send({ type: "hello", mode: app.mode, seats: app.seats });
    });
    conn.on("data", (message) => handleHostMessage(conn, message));
    conn.on("close", () => {
      for (const [seat, existing] of app.conns.entries()) {
        if (existing === conn) app.conns.delete(seat);
      }
      for (const seat of app.seats) {
        if (seat.connId === conn.connectionId) {
          seat.occupied = false;
          seat.connId = "";
        }
      }
      renderSeats();
      publishRoom();
      broadcast({ type: "seats", mode: app.mode, seats: app.seats });
      updateLocks();
    });
  }

  function handleHostMessage(conn, message) {
    if (!message || typeof message !== "object") return;
    if (message.type === "join") {
      const seatIndex = vacantJoinSeat();
      if (seatIndex == null) {
        conn.send({ type: "error", message: "房间已满" });
        setTimeout(() => conn.close(), 300);
        return;
      }
      const selections = Array.isArray(message.selections) ? message.selections : [message.selection];
      if (app.mode === "commander") {
        occupySeat(2, selections[0], "guest", conn.connectionId);
        occupySeat(3, selections[1] || selections[0], "guest", conn.connectionId);
        app.conns.set(2, conn);
        app.conns.set(3, conn);
      } else {
        occupySeat(seatIndex, selections[0], "guest", conn.connectionId);
        app.conns.set(seatIndex, conn);
      }
      conn.send({ type: "joined", mode: app.mode, seatIndex, seats: app.seats });
      broadcast({ type: "seats", mode: app.mode, seats: app.seats });
      renderSeats();
      publishRoom();
      updateLocks();
      return;
    }
    if (message.type === "selection") {
      const seats = app.mode === "commander" ? [2, 3] : [message.seatIndex];
      const selections = Array.isArray(message.selections) ? message.selections : [message.selection];
      seats.forEach((seat, index) => {
        if (app.seats[seat]?.connId === conn.connectionId) occupySeat(seat, selections[index] || selections[0], "guest", conn.connectionId);
      });
      broadcast({ type: "seats", mode: app.mode, seats: app.seats });
      renderSeats();
      publishRoom();
      return;
    }
    if (message.type === "intent" && app.engine) {
      const current = app.engine.currentFighter();
      const controlled = seatsControlledByConn(conn);
      if (controlled.includes(current?.seatIndex)) {
        app.engine.takeAction(message.targets || {});
        renderBattle();
        broadcastSnapshot();
      }
    }
  }

  function seatsControlledByConn(conn) {
    return app.seats.filter((seat) => seat.connId === conn.connectionId).map((seat) => seat.index);
  }

  function broadcast(message) {
    for (const conn of new Set(app.conns.values())) {
      if (conn.open) conn.send(message);
    }
  }

  function broadcastSnapshot() {
    broadcast({ type: "snapshot", snapshot: app.engine?.clone() });
  }

  function joinRoom(modeFromRoom = null) {
    if (!app.auth) {
      updateNetworkStatus("请先登录。");
      return;
    }
    if (!window.Peer) {
      updateNetworkStatus("联机库暂时没有加载成功，请稍后重试。");
      return;
    }
    const code = $("roomInput").value.trim().toUpperCase();
    if (!code) {
      updateNetworkStatus("请输入房间码。");
      return;
    }
    app.mode = modeFromRoom || selectedMode();
    $("modeSelect").value = app.mode;
    updateModeUi();
    app.role = "guest";
    app.roomCode = code;
    app.peer = new Peer(undefined, { debug: 1 });
    app.peer.on("open", () => {
      updateNetworkStatus(`正在加入 ${MODES[app.mode].label} 房间 ${app.roomCode}...`);
      const conn = app.peer.connect(peerId(app.roomCode, app.mode), { reliable: true });
      app.hostConn = conn;
      conn.on("open", () => {
        conn.send({ type: "join", selections: mySelectionsForMode(app.mode) });
      });
      conn.on("data", handleGuestMessage);
      conn.on("close", () => {
        updateNetworkStatus("联机已断开，可以重新创建或加入房间。");
        updateLocks();
      });
    });
    app.peer.on("error", (err) => {
      updateNetworkStatus(`加入房间失败：${err.message || err.type || err}`);
      updateLocks();
    });
    updateLocks();
  }

  function handleGuestMessage(message) {
    if (!message || typeof message !== "object") return;
    if (message.type === "hello") {
      app.mode = message.mode || app.mode;
      $("modeSelect").value = app.mode;
      app.seats = message.seats || makeSeats(app.mode);
      updateModeUi();
      renderSeats();
      return;
    }
    if (message.type === "joined") {
      app.mode = message.mode || app.mode;
      app.seatIndex = message.seatIndex;
      app.seats = message.seats || app.seats;
      updateNetworkStatus(`已加入房间 ${app.roomCode}，你是 ${Number(app.seatIndex) + 1} 号位。`);
      renderSeats();
      updateLocks();
      return;
    }
    if (message.type === "seats") {
      app.mode = message.mode || app.mode;
      app.seats = message.seats || app.seats;
      renderSeats();
      updateLocks();
      return;
    }
    if (message.type === "start") {
      app.mode = message.mode || app.mode;
      app.seats = message.seats || app.seats;
      app.engine = BattleEngine.fromSnapshot(message.snapshot, app.mode);
      renderBattle();
      return;
    }
    if (message.type === "snapshot") {
      app.engine = BattleEngine.fromSnapshot(message.snapshot, app.mode);
      renderBattle();
      return;
    }
    if (message.type === "reset") {
      app.engine = null;
      $("battlePanel").hidden = true;
      updateLocks();
      return;
    }
    if (message.type === "error") updateNetworkStatus(message.message || "联机错误");
  }

  function pushSelection() {
    updateNotes();
    if (app.role === "host") {
      setSeatSelectionFromMine();
      renderSeats();
      publishRoom();
      broadcast({ type: "seats", mode: app.mode, seats: app.seats });
    } else if (app.role === "guest" && app.hostConn?.open) {
      app.hostConn.send({ type: "selection", seatIndex: app.seatIndex, selections: mySelectionsForMode(app.mode) });
    }
  }

  function leaveRoom() {
    if (app.role === "host") closePublishedRoom();
    if (app.lobbyTimer) window.clearInterval(app.lobbyTimer);
    try { app.hostConn?.close(); } catch {}
    try { app.peer?.destroy(); } catch {}
    app.role = "lobby";
    app.roomCode = "";
    app.peer = null;
    app.hostConn = null;
    app.conns.clear();
    app.seatIndex = null;
    app.seats = [];
    app.engine = null;
    $("battlePanel").hidden = true;
    updateNetworkStatus("已回到统一大厅。");
    renderSeats();
    renderRooms();
    updateLocks();
  }

  async function copyRoom() {
    if (!app.roomCode) return;
    try {
      await navigator.clipboard.writeText(app.roomCode);
      updateNetworkStatus(`房间码 ${app.roomCode} 已复制。`);
    } catch {
      updateNetworkStatus(`房间码：${app.roomCode}`);
    }
  }

  function startGame() {
    if (!app.auth) return;
    if (app.role !== "host") return;
    setSeatSelectionFromMine();
    if (occupiedCount() < MODES[app.mode].minStart) {
      updateNetworkStatus(`${MODES[app.mode].label} 至少需要 ${MODES[app.mode].minStart} 人。`);
      return;
    }
    app.engine = new BattleEngine(app.mode, app.seats.filter((seat) => seat.occupied));
    renderBattle();
    publishRoom("playing");
    broadcast({ type: "start", mode: app.mode, seats: app.seats, snapshot: app.engine.clone() });
  }

  function resetGame() {
    if (app.role !== "host") return;
    app.engine = null;
    $("battlePanel").hidden = true;
    publishRoom();
    broadcast({ type: "reset" });
    updateLocks();
  }

  function collectTargets() {
    return {
      primary: Number($("targetPrimary").value),
      secondary: Number($("targetSecondary").value),
      tertiary: Number($("targetTertiary").value),
      multi: Array.from($("targetMulti").selectedOptions).map((option) => Number(option.value)),
    };
  }

  function performAction() {
    if (!app.engine) return;
    const targets = collectTargets();
    const current = app.engine.currentFighter();
    if (!current) return;
    if (app.role === "host" && controlsSeat(current.seatIndex)) {
      app.engine.takeAction(targets);
      renderBattle();
      broadcastSnapshot();
    } else if (app.role === "guest" && controlsSeat(current.seatIndex) && app.hostConn?.open) {
      app.hostConn.send({ type: "intent", targets });
    }
  }

  function controlsSeat(seatIndex) {
    if (app.role === "host") {
      if (app.mode === "commander") return seatIndex === 0 || seatIndex === 1;
      return seatIndex === 0;
    }
    if (app.mode === "commander") return seatIndex === 2 || seatIndex === 3;
    return seatIndex === app.seatIndex;
  }

  class BattleEngine {
    constructor(mode, seats) {
      this.mode = mode;
      this.config = MODES[mode];
      this.players = seats.map((seat) => createFighter(seat, mode));
      this.turnOrder = this.players.map((_, index) => index);
      this.current = this.firstAliveIndex();
      this.phase = 1;
      this.gameOver = false;
      this.skillText = "等待行动";
      this.skillColor = "#667085";
      this.lastRoll = null;
      this.logs = [];
      if (this.current != null) this.players[this.current].actionPoints = 1;
      this.log(`\n╔${"=".repeat(45)}`);
      this.log(`║ ${`${this.config.label} 战斗开始!`.padStart(25).padEnd(44)} `);
      this.log(`╚${"=".repeat(45)}`);
      this.log(`\n${this.currentFighter()?.displayName || "未知角色"} 先手行动！`);
    }

    static fromSnapshot(snapshot, fallbackMode = "duel") {
      const engine = Object.create(BattleEngine.prototype);
      engine.mode = snapshot.mode || fallbackMode;
      engine.config = MODES[engine.mode];
      engine.players = (snapshot.players || []).map((player) => ({
        ...player,
        shields: (player.shields || []).map((shield) => ({ ...shield })),
      }));
      engine.turnOrder = snapshot.turnOrder || engine.players.map((_, index) => index);
      engine.current = snapshot.current;
      engine.phase = snapshot.phase || 1;
      engine.gameOver = Boolean(snapshot.gameOver);
      engine.skillText = snapshot.skillText || "等待行动";
      engine.skillColor = snapshot.skillColor || "#667085";
      engine.lastRoll = snapshot.lastRoll || null;
      engine.logs = snapshot.logs || [];
      return engine;
    }

    clone() {
      return {
        mode: this.mode,
        players: this.players.map((player) => ({ ...player, shields: (player.shields || []).map((shield) => ({ ...shield })) })),
        turnOrder: this.turnOrder.slice(),
        current: this.current,
        phase: this.phase,
        gameOver: this.gameOver,
        skillText: this.skillText,
        skillColor: this.skillColor,
        lastRoll: this.lastRoll,
        logs: this.logs.slice(-260),
      };
    }

    log(text, color = "") {
      this.logs.push({ text, color });
    }

    currentFighter() {
      return this.current == null ? null : this.players[this.current];
    }

    teamOfSeat(seatIndex) {
      return this.config.teamOf(seatIndex);
    }

    firstAliveIndex() {
      return this.turnOrder.find((index) => this.players[index]?.health > 0) ?? null;
    }

    aliveIndexes(group = "any") {
      const attacker = this.currentFighter();
      return this.players
        .map((player, index) => ({ player, index }))
        .filter(({ player, index }) => {
          if (!player || player.health <= 0) return false;
          if (!attacker) return true;
          if (group === "self") return index === this.current;
          if (group === "any") return true;
          if (group === "anyOther") return index !== this.current;
          if (group === "enemy") return this.teamOfSeat(player.seatIndex) !== this.teamOfSeat(attacker.seatIndex);
          if (group === "allySelf") return this.teamOfSeat(player.seatIndex) === this.teamOfSeat(attacker.seatIndex);
          if (group === "ally") return index !== this.current && this.teamOfSeat(player.seatIndex) === this.teamOfSeat(attacker.seatIndex);
          return true;
        })
        .map(({ index }) => index);
    }

    normalizeTargets(raw = {}) {
      const clean = (value) => {
        const parsed = Number(value);
        return Number.isInteger(parsed) ? parsed : null;
      };
      return {
        primary: clean(raw.primary),
        secondary: clean(raw.secondary),
        tertiary: clean(raw.tertiary),
        multi: Array.isArray(raw.multi) ? raw.multi.map(clean).filter((value) => value != null) : [],
      };
    }

    context(raw) {
      return { targets: this.normalizeTargets(raw), used: new Set(), mark: (target) => target && this.players.includes(target) && target.health > -999 && null };
    }

    mark(ctx, target) {
      if (target) ctx.used.add(target.displayName);
    }

    target(ctx, slot, group, fallbackGroup = group) {
      const valid = this.aliveIndexes(group);
      const requested = ctx.targets[slot];
      if (valid.includes(requested)) return this.players[requested];
      const fallback = fallbackGroup === group ? valid : this.aliveIndexes(fallbackGroup);
      return this.players[fallback[0]] || null;
    }

    targets(ctx, group, fallback = "one") {
      const valid = this.aliveIndexes(group);
      const picked = ctx.targets.multi.filter((index) => valid.includes(index));
      if (picked.length) return picked.map((index) => this.players[index]);
      for (const slot of ["primary", "secondary", "tertiary"]) {
        if (valid.includes(ctx.targets[slot])) return [this.players[ctx.targets[slot]]];
      }
      if (fallback === "all") return valid.map((index) => this.players[index]);
      return valid.slice(0, 1).map((index) => this.players[index]);
    }

    combo(ctx, group, count) {
      const valid = this.aliveIndexes(group);
      const slots = ["primary", "secondary", "tertiary"];
      const picked = slots.map((slot) => ctx.targets[slot]).filter((index) => valid.includes(index));
      if (!picked.length && valid.length) picked.push(valid[0]);
      while (picked.length < count && picked.length) picked.push(picked[picked.length - 1]);
      return picked.slice(0, count).map((index) => this.players[index]);
    }

    addShield(target, type = "normal", count = 1, source = null, ctx = null) {
      target.shields = target.shields || [];
      for (let index = 0; index < count; index += 1) target.shields.push({ type });
      target.shield = target.shields.length;
      this.log(`${source?.displayName || target.displayName} 为 ${target.displayName} 添加${type === "ice" ? "冰晶" : ""}护盾。`);
      this.mark(ctx || { used: new Set() }, target);
    }

    breakShield(target, reason) {
      target.shields = target.shields || [];
      const shield = target.shields.shift() || { type: "normal" };
      target.shield = target.shields.length;
      this.log(`${target.displayName} 的${shield.type === "ice" ? "冰晶" : ""}护盾抵挡了${reason}。`);
      if (shield.type === "ice") {
        target.health -= 10;
        this.log(`${target.displayName} 的冰晶护盾破碎，损失10点生命值！`);
      }
    }

    damage(target, amount, source, label, ctx, blockable = true) {
      if (!target || target.health <= 0) return;
      if (blockable && target.shield > 0) {
        this.breakShield(target, label);
        this.mark(ctx, target);
        return;
      }
      target.health -= amount;
      this.log(`${source.displayName} 对 ${target.displayName} 造成${amount}点${label}。`);
      this.mark(ctx, target);
    }

    heal(target, amount, source, ctx) {
      if (!target || target.health <= 0) return;
      target.health += amount;
      this.log(`${source.displayName} 使 ${target.displayName} 恢复${amount}点生命值。`);
      this.mark(ctx, target);
    }

    swapHealth(attacker, target, ctx) {
      if (!target || target.health <= 0) return;
      [attacker.health, target.health] = [target.health, attacker.health];
      this.log(`${attacker.displayName} 与 ${target.displayName} 交换生命值。`);
      this.mark(ctx, target);
    }

    silence(target, amount, source, ctx) {
      if (!target || target.health <= 0) return;
      target.actionPoints -= amount;
      this.log(`${source.displayName} 沉默 ${target.displayName}，行动点减少${amount}。`);
      this.mark(ctx, target);
    }

    allDamage(attacker, amount, label, ctx) {
      for (const target of this.aliveIndexes("any").map((index) => this.players[index])) this.damage(target, amount, attacker, label, ctx);
    }

    allHalf(attacker, ctx) {
      this.log(`${attacker.displayName} 发动全场生命削减！`);
      for (const target of this.aliveIndexes("any").map((index) => this.players[index])) {
        if (target.shield > 0) {
          this.breakShield(target, "生命削减");
        } else {
          const next = Math.max(1, Math.floor(target.health / 2));
          const lost = target.health - next;
          target.health = next;
          this.log(`${target.displayName} 生命减半，失去${lost}点生命值。`);
        }
        this.mark(ctx, target);
      }
    }

    teamsAlive() {
      const teams = new Set();
      for (const player of this.players) {
        if (player.health > 0) teams.add(this.teamOfSeat(player.seatIndex));
      }
      return teams;
    }

    checkGameOver() {
      const teams = this.teamsAlive();
      if (teams.size > 1) return false;
      this.gameOver = true;
      this.current = null;
      if (!teams.size) this.skillText = "平局！";
      else {
        const team = [...teams][0];
        this.skillText = this.mode === "ffa" || this.mode === "duel"
          ? `${this.players.find((player) => player.health > 0 && this.teamOfSeat(player.seatIndex) === team)?.displayName || "幸存者"} 获胜！`
          : `${team === 0 ? "房主队" : "访客队"} 获胜！`;
      }
      this.skillColor = COLORS.ultimate;
      this.log(this.skillText);
      return true;
    }

    advanceTurn() {
      if (this.checkGameOver()) return;
      const old = this.turnOrder.indexOf(this.current);
      let pointer = old >= 0 ? old : 0;
      for (let guard = 0; guard < this.turnOrder.length * 6; guard += 1) {
        pointer = (pointer + 1) % this.turnOrder.length;
        if (pointer === 0) {
          this.phase += 1;
          this.log(`\n===== 第 ${this.phase} 回合开始 =====`);
        }
        const next = this.turnOrder[pointer];
        const player = this.players[next];
        if (!player || player.health <= 0) continue;
        player.actionPoints += 1;
        if (player.actionPoints <= 0) {
          this.log(`${player.displayName} 被沉默压制，跳过本次行动。`);
          continue;
        }
        this.current = next;
        this.log(`${player.displayName} 开始行动！`);
        return;
      }
    }

    takeAction(rawTargets) {
      if (this.gameOver || this.current == null) return;
      const attacker = this.currentFighter();
      const ctx = this.context(rawTargets);
      const result = this.rollSkill(attacker, ctx);
      const meta = result.handler ? SKILL_META[result.handler] : null;
      this.skillColor = meta?.[1] || "#151b23";
      const targetLabel = ctx.used.size ? [...ctx.used].join("、") : "未命中目标";
      this.lastRoll = result.roll ? { roll: result.roll, max: 100, skill: result.name, target: targetLabel, range: result.range } : null;
      this.skillText = `${attacker.displayName} 使用了 [${result.name}] · 随机数 ${result.roll}/100 · 目标 ${targetLabel}`;
      attacker.actionPoints -= 1;
      if (this.checkGameOver()) return;
      if (attacker.actionPoints <= 0) this.advanceTurn();
    }

    rollSkill(attacker, ctx) {
      const def = currentDef(attacker.characterId);
      const roll = Math.floor(Math.random() * 100) + 1;
      this.log(`${attacker.displayName} 行动随机数：${roll}/100。`, "#93c5fd");
      let cumulative = 0;
      for (const [name, probability, handler] of def.skills) {
        const start = cumulative + 1;
        cumulative += probability;
        if (roll <= cumulative) {
          this.log(`命中区间：${start}-${cumulative}，技能：[${name}]`, "#93c5fd");
          this.apply(handler, attacker, ctx);
          return { name, handler, roll, range: [start, cumulative] };
        }
      }
      return { name: "犹豫不决", handler: "", roll, range: null };
    }

    apply(handler, attacker, ctx) {
      const enemy = () => this.target(ctx, "primary", "enemy");
      const ally = () => this.target(ctx, "primary", "allySelf", "self") || attacker;
      const selfHeal = (amount) => this.heal(attacker, amount * attacker.healMultiplier, attacker, ctx);
      const groupHeal = (amount) => this.targets(ctx, "allySelf", "one").forEach((target) => this.heal(target, amount * attacker.healMultiplier, attacker, ctx));
      const normal = (target, mult = attacker.attackMultiplier) => this.damage(target, 10 * mult, attacker, "攻击伤害", ctx);
      const crit = (target, mult = attacker.attackMultiplier) => this.damage(target, 20 * mult, attacker, "暴击伤害", ctx);
      const resetAttack = () => { attacker.attackMultiplier = 1; };
      const handlers = {
        normal_attack: () => { normal(enemy()); resetAttack(); },
        critical_hit: () => { crit(enemy()); resetAttack(); },
        gain_shield: () => this.addShield(ally(), "normal", 1, attacker, ctx),
        ice_shield: () => this.targets(ctx, "allySelf", "one").forEach((target) => this.addShield(target, "ice", 1, attacker, ctx)),
        self_harm: () => this.damage(attacker, 10, attacker, "反噬伤害", ctx),
        heal: () => { selfHeal(10); attacker.healMultiplier = 1; },
        red_recovery: () => { selfHeal(30); attacker.healMultiplier = 1; },
        critical_heal: () => { selfHeal(20); attacker.healMultiplier = 1; },
        two_more: () => { attacker.actionPoints += 2; this.log(`${attacker.displayName} 获得2个额外行动点。`); this.mark(ctx, attacker); },
        blood_swap: () => this.swapHealth(attacker, this.target(ctx, "primary", "anyOther"), ctx),
        blood_swap1: () => { const target = this.target(ctx, "primary", "anyOther"); this.swapHealth(attacker, target, ctx); this.damage(target, 10, attacker, "换血追击", ctx); },
        silence: () => this.silence(enemy(), 3, attacker, ctx),
        undead_ultimate: () => { const target = this.target(ctx, "primary", "anyOther"); this.swapHealth(attacker, target, ctx); crit(target); this.addShield(attacker, "normal", 1, attacker, ctx); resetAttack(); },
        ice_attack: () => this.damage(enemy(), 30, attacker, "寒冰伤害", ctx),
        ice_silence: () => this.targets(ctx, "anyOther", "all").forEach((target) => this.silence(target, 1, attacker, ctx)),
        bomb_attack: () => { this.targets(ctx, "enemy", "all").forEach((target) => this.damage(target, 20, attacker, "爆裂伤害", ctx)); this.damage(attacker, 20, attacker, "爆裂反冲", ctx); },
        double_attack: () => { this.damage(enemy(), 20 * attacker.attackMultiplier, attacker, "燃血轰击", ctx); resetAttack(); this.damage(attacker, 10, attacker, "反噬伤害", ctx); },
        poison_attack: () => { this.targets(ctx, "enemy", "all").forEach((target) => this.damage(target, 10, attacker, "毒药伤害", ctx)); this.damage(attacker, 30, attacker, "毒雾反噬", ctx); },
        mage_ultimate: () => { this.damage(enemy(), 30, attacker, "绝对零度", ctx); this.heal(attacker, 30, attacker, ctx); },
        medicine_both_heal: () => { groupHeal(10); attacker.healMultiplier = 1; },
        medicine_crit_heal: () => { crit(enemy()); selfHeal(10); attacker.healMultiplier = 1; resetAttack(); },
        medicine_crit_silence: () => { const target = enemy(); crit(target); this.silence(target, 1, attacker, ctx); resetAttack(); },
        medicine_boost_heal: () => { attacker.healMultiplier *= 2; this.log(`${attacker.displayName} 强化治疗效果。`); this.mark(ctx, attacker); },
        medicine_mega_heal: () => { selfHeal(60); attacker.healMultiplier = 1; },
        double_normal_attack: () => { const mult = attacker.attackMultiplier; this.combo(ctx, "enemy", 2).forEach((target) => normal(target, mult)); resetAttack(); },
        attack_and_draw: () => { normal(enemy()); resetAttack(); attacker.actionPoints += 1; this.log(`${attacker.displayName} 获得1个额外行动点。`); },
        attack_and_heal: () => { normal(enemy()); resetAttack(); selfHeal(10); attacker.healMultiplier = 1; },
        attack_and_shield: () => { normal(enemy()); resetAttack(); this.addShield(this.target(ctx, "secondary", "allySelf", "self") || attacker, "normal", 1, attacker, ctx); },
        half_hp_and_attack: () => { this.allHalf(attacker, ctx); normal(enemy()); resetAttack(); },
        double_next_attack: () => { attacker.attackMultiplier *= 2; this.log(`${attacker.displayName} 下次攻击威力翻倍。`); this.mark(ctx, attacker); },
        self_harm_and_triple_critical: () => { const mult = attacker.attackMultiplier; this.combo(ctx, "enemy", 3).forEach((target) => crit(target, mult)); resetAttack(); if (!this.checkGameOver()) this.damage(attacker, 40, attacker, "毁灭代价", ctx, false); },
        double_deduction: () => this.allDamage(attacker, 10, "全场冲击", ctx),
        double_deduction_and_draw: () => { this.allDamage(attacker, 10, "全场连打", ctx); attacker.actionPoints += 1; },
        half_hp_both: () => this.allHalf(attacker, ctx),
        attack_critical_draw: () => { const [a, b] = this.combo(ctx, "enemy", 2); normal(a); crit(b); resetAttack(); attacker.actionPoints += 1; },
        double_deduction_30_attack_critical_draw: () => { this.allDamage(attacker, 30, "终极全场冲击", ctx); const [a, b] = this.combo(ctx, "enemy", 2); normal(a); crit(b); resetAttack(); attacker.actionPoints += 1; },
        both_heal_10: () => { groupHeal(10); attacker.healMultiplier = 1; },
        critical_and_critical_heal_and_draw: () => { crit(enemy()); resetAttack(); selfHeal(20); attacker.healMultiplier = 1; attacker.actionPoints += 2; },
        shield_and_self_harm_10: () => { this.addShield(ally(), "normal", 1, attacker, ctx); this.damage(attacker, 10, attacker, "不可格挡反噬", ctx, false); },
        knight_ultimate: () => { crit(enemy()); resetAttack(); attacker.actionPoints += 1; this.addShield(attacker, "normal", 3, attacker, ctx); },
      };
      (handlers[handler] || (() => this.log(`技能 ${handler} 暂未实现。`)))();
    }
  }

  function createFighter(seat, mode) {
    const def = currentDef(seat.selection.characterId);
    return {
      seatIndex: seat.index,
      team: MODES[mode].teamOf(seat.index),
      displayName: `${seat.selection.name}(${def.name})`,
      playerName: seat.selection.name,
      characterId: def.id,
      characterName: def.name,
      health: 100,
      shield: 0,
      shields: [],
      actionPoints: 0,
      healMultiplier: 1,
      attackMultiplier: 1,
    };
  }

  function renderBattle() {
    const engine = app.engine;
    $("battlePanel").hidden = !engine;
    if (!engine) {
      updateLocks();
      return;
    }
    const snapshot = engine.clone();
    $("roundTitle").textContent = `第 ${snapshot.phase} 回合`;
    $("skillBanner").textContent = snapshot.skillText || "等待行动";
    $("skillBanner").style.color = snapshot.skillColor || "#667085";
    $("rollInfo").textContent = snapshot.lastRoll
      ? `上次随机数 ${snapshot.lastRoll.roll}/${snapshot.lastRoll.max} · ${snapshot.lastRoll.skill} · 目标 ${snapshot.lastRoll.target}${snapshot.lastRoll.range ? ` · 区间 ${snapshot.lastRoll.range[0]}-${snapshot.lastRoll.range[1]}` : ""}`
      : "上次随机数：等待首次行动";
    $("arena").innerHTML = snapshot.players.map((player, index) => {
      const healthPercent = Math.max(0, Math.min(100, player.health));
      const side = app.mode === "ffa" ? `阵营 ${player.seatIndex + 1}` : seatTeamLabel(app.mode, player.seatIndex);
      return `<article class="game-fighter ${snapshot.current === index ? "is-current" : ""} ${player.health <= 0 ? "is-dead" : ""}">
        <div class="game-fighter-head">
          <h3>${C.escapeHtml(player.displayName)}</h3>
          <span class="game-side">${C.escapeHtml(side)}</span>
        </div>
        <div class="game-health"><span style="width:${healthPercent}%"></span></div>
        <dl class="game-stats">
          <div><dt>生命</dt><dd>${Math.max(0, player.health)}</dd></div>
          <div><dt>护盾</dt><dd>${player.shield}${player.shields?.some((shield) => shield.type === "ice") ? " 冰晶" : ""}</dd></div>
          <div><dt>行动点</dt><dd>${player.actionPoints}</dd></div>
        </dl>
      </article>`;
    }).join("");
    const current = snapshot.current == null ? null : snapshot.players[snapshot.current];
    $("turnHint").textContent = snapshot.gameOver
      ? "战斗结束"
      : current
        ? `${current.displayName} 行动中`
        : "等待行动";
    $("battleRoomCode").textContent = app.roomCode ? `房间 ${app.roomCode} · ${MODES[app.mode].label}` : "房间 --";
    $("battleLog").innerHTML = snapshot.logs.map((entry) => `<p ${entry.color ? `style="color:${entry.color}"` : ""}>${C.escapeHtml(entry.text)}</p>`).join("");
    $("logCount").textContent = C.fmt.format(snapshot.logs.length);
    $("battleLog").scrollTop = $("battleLog").scrollHeight;
    renderTargetOptions();
    updateBattleControls();
    updateLocks();
  }

  function renderTargetOptions() {
    const ids = ["targetPrimary", "targetSecondary", "targetTertiary", "targetMulti"];
    const old = Object.fromEntries(ids.map((id) => [id, $(id).value]));
    const oldMulti = Array.from($("targetMulti").selectedOptions || []).map((option) => option.value);
    const current = app.engine?.current;
    const html = app.engine
      ? app.engine.aliveIndexes("any").map((index) => {
        const player = app.engine.players[index];
        const relation = index === current ? "自己" : app.engine.teamOfSeat(player.seatIndex) === app.engine.teamOfSeat(app.engine.currentFighter()?.seatIndex) ? "友方" : "敌方";
        return `<option value="${index}">${C.escapeHtml(player.displayName)} · ${relation} · 生命 ${Math.max(0, player.health)} · 护盾 ${player.shield}</option>`;
      }).join("")
      : "";
    ids.forEach((id) => { $(id).innerHTML = html || `<option value="">暂无目标</option>`; });
    const enemies = app.engine?.aliveIndexes("enemy") || [];
    const allies = app.engine?.aliveIndexes("allySelf") || [];
    setSelectValue("targetPrimary", old.targetPrimary, String(enemies[0] ?? allies[0] ?? ""));
    setSelectValue("targetSecondary", old.targetSecondary, String(enemies[1] ?? allies[0] ?? enemies[0] ?? ""));
    setSelectValue("targetTertiary", old.targetTertiary, String(enemies[2] ?? enemies[0] ?? ""));
    Array.from($("targetMulti").options).forEach((option) => {
      option.selected = oldMulti.includes(option.value) || (!oldMulti.length && enemies.includes(Number(option.value)));
    });
  }

  function setSelectValue(id, preferred, fallback) {
    const node = $(id);
    const values = Array.from(node.options).map((option) => option.value);
    node.value = values.includes(preferred) ? preferred : values.includes(fallback) ? fallback : values[0] || "";
  }

  function updateBattleControls() {
    const current = app.engine?.currentFighter();
    const canAct = Boolean(app.engine && !app.engine.gameOver && current && controlsSeat(current.seatIndex));
    $("actionButton").disabled = !canAct;
    $("restartButton").disabled = app.role !== "host" || !app.engine;
    ["targetPrimary", "targetSecondary", "targetTertiary", "targetMulti"].forEach((id) => { $(id).disabled = !canAct; });
  }

  function bindEvents() {
    $("loginButton").addEventListener("click", login);
    ["loginName", "loginPassword"].forEach((id) => {
      $(id).addEventListener("keydown", (event) => {
        if (event.key === "Enter") login();
      });
    });
    $("modeSelect").addEventListener("change", () => {
      updateModeUi();
      renderRooms();
    });
    ["playerName0", "playerName1", "playerName2", "playerCharacter0", "playerCharacter1", "playerCharacter2"].forEach((id) => {
      $(id)?.addEventListener("input", pushSelection);
      $(id)?.addEventListener("change", pushSelection);
    });
    $("createRoom").addEventListener("click", createRoom);
    $("joinRoom").addEventListener("click", () => joinRoom());
    $("roomList").addEventListener("click", (event) => {
      const button = event.target.closest("button[data-join-room]");
      if (!button || button.disabled) return;
      $("roomInput").value = button.dataset.joinRoom;
      joinRoom(button.dataset.roomMode);
    });
    $("refreshRooms").addEventListener("click", () => {
      app.rooms.clear();
      renderRooms();
      connectLobby(true);
    });
    $("copyRoom").addEventListener("click", copyRoom);
    $("leaveRoom").addEventListener("click", leaveRoom);
    $("startGame").addEventListener("click", startGame);
    $("actionButton").addEventListener("click", performAction);
    $("restartButton").addEventListener("click", resetGame);
    window.addEventListener("beforeunload", () => {
      if (app.role === "host" && app.roomCode) closePublishedRoom();
    });
  }

  function init() {
    C.renderNav("game");
    C.tickBeijing("nowBeijing");
    renderOptions();
    updateNotes();
    updateModeUi();
    renderRoster();
    renderRooms();
    bindEvents();
    restoreSession();
    if (app.auth?.username) $("loginName").value = app.auth.username;
    applyAuthState();
  }

  init();
})();
