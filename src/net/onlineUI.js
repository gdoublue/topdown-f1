// 在线模式 UI：服务器地址 → 大厅（排行榜 / 房间列表）→ 房间详情
// 与 src/main.js 协作：选模式 online 时调用 showOnline()；
// "单人在线练习"通过回调交还 main.js 走 solo 流程（成绩自动上传）。
import { TRACKS } from "../track/tracks.js";
import { AI_CONFIGS } from "../game/ai.js";
import { conn } from "./connection.js";
import { getFingerprint } from "./fingerprint.js";
import { isAutopilotOn } from "../ui/autopilot.js";
import { trackThumbUrl } from "../ui/trackThumb.js";

const el = {};
let cb = {};                       // { onStartPractice }
let currentTab = "rooms";          // 默认先看房间列表
let room = null;                   // 当前所在房间 view
let lastRoomId = null;             // 重连后尝试重新加入
let myCarId = null;
let myReady = false;
let boardTrackId = null;
let roomLaps = 0;                  // 房主自定义圈数（0 = 赛道默认）
let intentionalClose = false;      // 用户主动断开（不触发自动重连）
let reconnectTries = 0;
let lastLobbyInteract = 0;         // 上次在大厅列表里的操作时间（避免刷新打断点击）
let lobbyRefreshTimer = 0;
let autoCarRoomId = null;          // 已为哪个房间自动同步过默认车（避免重复发送）
let mySpectating = false;          // 自己当前在房间里是否观赛身份（观赛不占发车位、不参与就绪）
let pendingJoinRoomId = null;      // 邀请链接要加入的房间（等 welcome 后自动发 room_join）
let roomError = "";                // 服务端拒绝原因（not_all_ready 等），展示 4 秒
let roomErrorTimer = 0;

// 单人在线练习房：先在房间里选好赛道 / 圈数 / 赛车，再开始比赛
let practiceTrackId = TRACKS[0].id;
let practiceLaps = 0;              // 0 = 赛道默认圈数
let practiceCarId = null;

const ADDR_KEY = "gp_server_url";
const NICK_KEY = "gp_nickname";

function $(id) { return document.getElementById(id); }

// 房间内提示条（服务端拒绝 / 邀请链接失效…）：显示若干秒后自动清掉
function flashRoomError(text, ms = 4000) {
  roomError = text;
  if (roomErrorTimer) clearTimeout(roomErrorTimer);
  roomErrorTimer = setTimeout(() => {
    roomError = "";
    renderRoom();
    renderLobbyBody();
  }, ms);
  if (room && !el.roomView.classList.contains("hidden")) renderRoom();
  else renderLobbyBody();
}

// 昵称：邀请链接进来时如果本机没存过，要先让玩家填一个
export function getSavedNickname() {
  return (localStorage.getItem(NICK_KEY) || "").trim();
}

export function saveNickname(name) {
  const v = String(name || "").replace(/\s+/g, " ").trim().slice(0, 12);
  if (v) localStorage.setItem(NICK_KEY, v);
  if (el.nickInput) el.nickInput.value = v;
  return v;
}

// 历史榜单存的是涂装 id（redbull 等），统一映射到现在的车辆配置 id
const CAR_ALIASES = {
  ferrari: "apex-hunter",
  redbull: "vector-pursuit",
  aston: "classic-baseline",
  mercedes: "mercedes-w15",
  cyber: "AiMotor",
  su7ultra: "smooth-cruiser",
  yangwang: "yangwang-u9x",
};

function resolveCarId(carId) {
  return CAR_ALIASES[carId] || carId;
}

function carConfig(carId) {
  const id = resolveCarId(carId);
  return AI_CONFIGS.find(c => c.id === id) || null;
}

// 车型显示名（"红牛 · RB20"）：排行榜/房间列表都别直接怼内部 id（vector-pursuit 之类）
function carLabel(carId) {
  if (!carId) return "";
  const cfg = carConfig(carId);
  return cfg ? `${cfg.team} · ${cfg.model}` : String(carId);
}

function carColor(carId) {
  return carConfig(carId)?.color || "#7f8ea3";
}

function carNumber(carId) {
  const n = carConfig(carId)?.number;
  return n ? `#${n}` : "";
}

function trackLabel(trackId) {
  const t = TRACKS.find(x => x.id === trackId);
  return t ? `${t.flag} ${t.name}` : String(trackId || "");
}

// 赛道选择统一配小地图：所有下拉选择器旁边都能直接看到赛道形状
function trackPreview(trackId, imgId = "") {
  const t = TRACKS.find(x => x.id === trackId) || TRACKS[0];
  const idAttr = imgId ? ` id="${imgId}"` : "";
  return `<img${idAttr} class="online-track-mini" src="${trackThumbUrl(t.id)}" alt="${escapeHtml(t.name)} 赛道小地图">`;
}

function syncTrackPreview(imgId, trackId) {
  const img = $(imgId);
  if (!img) return;
  const t = TRACKS.find(x => x.id === trackId) || TRACKS[0];
  img.src = trackThumbUrl(t.id);
  img.alt = `${t.name} 赛道小地图`;
}

// 没填昵称时给一个可编辑的默认昵称（避免大厅里显示成指纹派生的 "Pilot-xxxx"）
function defaultNickname() {
  return "车手" + String(Math.floor(1000 + Math.random() * 9000));
}

function defaultServerAddr() {
  const saved = localStorage.getItem(ADDR_KEY);
  if (saved) return saved;
  // 生产环境：前后端同源部署（nginx 反代 /ws、/api），默认走同源地址
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  if (!location.port || location.port === "80" || location.port === "443") {
    return `${proto}//${location.host}`;
  }
  // 本地 vite dev(8080) 直连后端 8081（仅限本机；生产 :8080 走同源 nginx 反代）
  if (location.port === "8080" && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)) {
    return `${proto}//${location.hostname}:8081`;
  }
  return `${proto}//${location.host}`;
}

export function initOnlineUI(callbacks = {}) {
  cb = callbacks;
  Object.assign(el, {
    wrap: $("onlineWrap"),
    addrStep: $("onlineAddrStep"),
    nickInput: $("nicknameInput"),
    addrInput: $("serverAddrInput"),
    connectBtn: $("serverConnectBtn"),
    status: $("onlineStatus"),
    lobby: $("onlineLobby"),
    connInfo: $("onlineConnInfo"),
    practiceBtn: $("onlinePracticeBtn"),
    disconnectBtn: $("onlineDisconnectBtn"),
    lobbyBody: $("lobbyBody"),
    roomView: $("onlineRoom"),
    practiceView: $("onlinePracticeRoom"),
  });
  if (!el.wrap) return;

  el.addrInput.value = defaultServerAddr();
  el.nickInput.value = localStorage.getItem(NICK_KEY) || defaultNickname();
  el.connectBtn.addEventListener("click", () => connect());
  el.addrInput.addEventListener("keydown", (e) => { if (e.key === "Enter") connect(); });
  el.nickInput.addEventListener("keydown", (e) => { if (e.key === "Enter") connect(); });
  el.disconnectBtn.addEventListener("click", () => {
    intentionalClose = true;
    conn.close();
    showAddr("已断开连接");
  });
  el.practiceBtn.addEventListener("click", () => {
    leaveOnlineRoom();
    showOnlinePracticeRoom();
  });

  // Tab 切换按钮是静态 DOM（在 lobbyBody 外），单独绑定
  el.lobby.querySelector(".online-tabs")?.addEventListener("click", (e) => {
    const tab = e.target.closest(".online-tab");
    if (!tab) return;
    currentTab = tab.getAttribute("data-tab");
    el.lobby.querySelectorAll(".online-tab").forEach(t => t.classList.toggle("active", t === tab));
    renderLobbyBody();
  });

  el.lobbyBody.addEventListener("click", onLobbyClick);
  el.lobbyBody.addEventListener("change", onLobbyChange);
  // 玩家正在大厅里操作（点击/选择/输入）时，服务端推送的刷新延后执行，避免把按钮/下拉删掉导致点不中
  el.lobbyBody.addEventListener("pointerdown", markLobbyInteract, true);
  el.lobbyBody.addEventListener("keydown", markLobbyInteract, true);
  el.roomView.addEventListener("click", onRoomClick);
  el.roomView.addEventListener("change", onRoomChange);
  el.practiceView?.addEventListener("click", onPracticeClick);
  el.practiceView?.addEventListener("change", onPracticeChange);

  // 服务端拒绝（not_all_ready / not_host / already_racing ...）必须可见，
  // 否则"点击没反应"根本无从排查
  conn.on("error", (msg) => {
    // 邀请链接进房：房间不存在 → 明确提示「房间已失效」，然后停在该服务器的大厅
    if (pendingJoinRoomId && msg.code === "room_not_found") {
      const target = pendingJoinRoomId;
      pendingJoinRoomId = null;
      room = null;
      renderLobby();
      switchView("lobby");
      flashRoomError(`房间 ${target} 已失效（房主已解散或本局已结束），已进入大厅`, 6000);
      cb.onNotice?.("房间已失效", "已进入该服务器大厅，可以自己开房间或加入其他房间");
      return;
    }
    if (pendingJoinRoomId) pendingJoinRoomId = null;   // 其他失败原因交给通用提示
    flashRoomError(errorText(msg), 4000);
  });

  conn.on("room_update", (msg) => {
    room = msg.room || null;
    if (!room) { renderLobby(); switchView("lobby"); cb.onRoomState?.(false); return; }
    lastRoomId = room.id;
    pendingJoinRoomId = null;      // 邀请链接进房成功
    // 圈数进房间状态：房主改完立即广播，非房主只读展示（以前只有开赛瞬间才知道）
    roomLaps = Number(room.laps) || 0;
    // 同步自己在房间内的选车/就绪状态
    const mySid = conn.session?.sid || conn.session?.playerId;
    const me = room.players.find(p => p.id === mySid);
    if (me) {
      myCarId = me.carId;
      myReady = me.ready;
      // 观赛身份切换（观赛 → 普通成员）时选车位被服务端清空了：
      // 必须允许重新自动同步一次，否则会一直显示"未选车"而无法就绪
      if (mySpectating && !me.spectating) autoCarRoomId = null;
      mySpectating = !!me.spectating;
    }
    // 页面上的"选择赛车"下拉默认就显示了一台车 → 同步给服务器，
    // 否则别人看到的是"未选车"（房主也就永远开不了赛）
    syncRoomSelfState(me);
    renderRoom();
    switchView("room");
    cb.onRoomState?.(true);
  });

  // 服务端推送的大厅视图（房间列表 / 在线人数）：房间增删、开赛、结束都会即时下发
  conn.on("lobby", (msg) => {
    const s = conn.session;
    if (!s) return;
    if (Array.isArray(msg.rooms)) s.rooms = msg.rooms;
    if (msg.online != null) s.online = msg.online;
    // 自己所在房间的成员/状态也同步（例如别人加入、房主改赛道、比赛开打）
    if (room) {
      const fresh = (msg.rooms || []).find(r => r.id === room.id);
      if (fresh) {
        room = { ...room, ...fresh };
        roomLaps = Number(room.laps) || 0;
        const me = room.players.find(p => p.id === (conn.session?.sid || conn.session?.playerId));
        if (me) { myCarId = me.carId; myReady = me.ready; }
        if (!el.roomView.classList.contains("hidden")) renderRoom();
      }
    }
    refreshLobby();
  });

  // 服务端推送的榜单变化（练习成绩上传 / 房间比赛完赛）
  conn.on("boards", (msg) => {
    const s = conn.session;
    if (!s || !msg.trackId) return;
    if (!s.leaderboards) s.leaderboards = {};
    s.leaderboards[msg.trackId] = msg.entries || [];
    refreshLobby();
  });

  // 服务端确认退出房间：清掉本地房间态，回到大厅（比赛中的退出由服务端判负并广播）
  conn.on("room_leave_ok", () => {
    room = null;
    myReady = false;
    myCarId = null;
    mySpectating = false;
    lastRoomId = null;
    autoCarRoomId = null;
    cb.onRoomState?.(false);
    if (conn.isOpen()) { renderLobby(); switchView("lobby"); }
  });
  conn.on("_closed", () => {
    room = null;
    autoCarRoomId = null;
    if (intentionalClose) { intentionalClose = false; return; }
    cb.onDisconnected?.();   // 比赛中掉线：主流程退回菜单
    attemptReconnect();
  });
}

// ================= 断线自动重连（同指纹身份不变） =================
function attemptReconnect() {
  const url = conn.url;
  if (!url || reconnectTries >= 3 || intentionalClose) {
    reconnectTries = 0;
    showAddr("连接已断开，请重新连接");
    return;
  }
  reconnectTries++;
  showAddr(`⏳ 连接断开，正在重连（${reconnectTries}/3）…`);
  setTimeout(async () => {
    try {
      const welcome = await conn.connect(url, {
        fingerprint: getFingerprint(),
        nickname: localStorage.getItem(NICK_KEY) || "",
      });
      reconnectTries = 0;
      boardTrackId = welcome.tracks[0]?.id || TRACKS[0].id;
      renderLobby();
      switchView("lobby");
      // 之前的房间还在 → 自动重新加入
      if (lastRoomId && welcome.rooms?.some(r => r.id === lastRoomId)) {
        conn.send({ t: "room_join", roomId: lastRoomId });
      }
    } catch {
      attemptReconnect();
    }
  }, 800 * reconnectTries);
}

// ---- 视图切换 ----
function switchView(v) {
  el.addrStep.classList.toggle("hidden", v !== "addr");
  el.lobby.classList.toggle("hidden", v !== "lobby");
  el.roomView.classList.toggle("hidden", v !== "room");
  el.practiceView?.classList.toggle("hidden", v !== "practice");
}

export function showOnline() {
  el.wrap.classList.remove("hidden");
  room = null;
  cb.onRoomState?.(false);
  if (conn.isOpen()) { renderLobby(); switchView("lobby"); }
  else showAddr();
}

// 比赛结束回到当前房间：保留 room 视图状态，不清空房间
export function showOnlineRoom() {
  el.wrap.classList.remove("hidden");
  if (room) { renderRoom(); switchView("room"); }
  else if (conn.isOpen()) { renderLobby(); switchView("lobby"); }
  else showAddr();
}

// 单人练习房：开赛前统一在这里选赛道 / 圈数 / 赛车，和多人房间保持同一套流程
export function showOnlinePracticeRoom() {
  el.wrap.classList.remove("hidden");
  if (!conn.isOpen()) { showAddr("连接已断开，请重新连接"); return; }
  renderPracticeRoom();
  switchView("practice");
}

function renderPracticeRoom() {
  if (!el.practiceView) return;
  const track = TRACKS.find(t => t.id === practiceTrackId) || TRACKS[0];
  practiceTrackId = track.id;
  if (!AI_CONFIGS.some(c => c.id === practiceCarId)) practiceCarId = AI_CONFIGS[0].id;

  const trackOpts = TRACKS.map(t =>
    `<option value="${t.id}" ${t.id === track.id ? "selected" : ""}>${t.flag} ${t.name}</option>`).join("");
  const lapsOpts = [0, 1, 2, 3, 5, 8, 10, 15, 20].map(n =>
    `<option value="${n}" ${practiceLaps === n ? "selected" : ""}>${n === 0 ? "赛道默认圈数" : n + " 圈"}</option>`).join("");
  const carOpts = AI_CONFIGS.map(c =>
    `<option value="${c.id}" ${c.id === practiceCarId ? "selected" : ""}>${c.team} · ${c.model} (#${c.number})</option>`).join("");
  const laps = practiceLaps || track.laps;

  el.practiceView.innerHTML = `
    <p class="track-modal-desc">单人练习房 · 先选好赛道与圈数再发车，完赛成绩自动上传服务器排行榜</p>
    <div class="practice-preview">
      <img class="track-mini" src="${trackThumbUrl(track.id)}" alt="${escapeHtml(track.name)} 赛道图">
      <div class="practice-preview-info">
        <span class="practice-preview-tag">PRACTICE ROOM</span>
        <b>${track.flag} ${escapeHtml(track.name)}</b>
        <span class="ol-sub">${(track.length / 1000).toFixed(2)} km · ${track.turns} 弯 · ${laps} 圈 · 计时赛</span>
      </div>
    </div>
    <div class="online-create">
      <label>赛道 <select id="practiceTrackSel">${trackOpts}</select></label>
      <label>圈数 <select id="practiceLapsSel">${lapsOpts}</select></label>
      <label>赛车 <select id="practiceCarSel">${carOpts}</select></label>
    </div>
    <div class="online-room-actions">
      <button class="results-btn primary online-btn" id="practiceStartBtn">🏁 开始比赛</button>
      <button class="results-btn online-btn ${isAutopilotOn() ? "on" : ""}" id="practiceAutopilotBtn"
        title="开启后由算法驾驶你的赛车（本地运行，支持自定义算法）">🤖 自动驾驶：${isAutopilotOn() ? "开" : "关"}</button>
      <button class="results-btn online-btn" id="practiceBackBtn">← 返回大厅</button>
    </div>`;
}

function onPracticeClick(e) {
  if (e.target.closest("#practiceStartBtn")) {
    cb.onStartPractice?.({
      trackId: practiceTrackId,
      laps: practiceLaps,
      carId: practiceCarId,
    });
    return;
  }
  if (e.target.closest("#practiceAutopilotBtn")) {
    cb.onOpenAutopilot?.();
    return;
  }
  if (e.target.closest("#practiceBackBtn")) {
    renderLobby();
    switchView("lobby");
  }
}

function onPracticeChange(e) {
  const id = e.target.id;
  if (id === "practiceTrackSel") practiceTrackId = e.target.value;
  else if (id === "practiceLapsSel") practiceLaps = Number(e.target.value) || 0;
  else if (id === "practiceCarSel") practiceCarId = e.target.value;
  else return;
  renderPracticeRoom();
}

export function hideOnline() {
  el.wrap.classList.add("hidden");
}

// 主动退出当前房间：服务端在比赛进行中会把这次退出判定为认输，并把房间视图广播给其他人。
// 返回是否真的在房间里（供上层决定是否需要额外提示）。
export function leaveOnlineRoom() {
  if (!room) return false;
  // 先让主流程把自己正在进行的比赛彻底停掉（只退自己这辆车，其他车友的比赛照常进行）
  cb.onBeforeLeaveRoom?.();
  if (conn.isOpen()) conn.send({ t: "room_leave" });
  room = null;
  myReady = false;
  myCarId = null;
  mySpectating = false;
  lastRoomId = null;          // 断线重连后不要自动回到已退出的房间
  autoCarRoomId = null;       // 下次进房重新同步默认选车
  cb.onRoomState?.(false);
  if (conn.isOpen()) { renderLobby(); switchView("lobby"); }
  return true;
}

export function isInRoom() { return !!room; }

function showAddr(statusText = "") {
  room = null;
  switchView("addr");
  el.status.textContent = statusText;
}

// ---- 连接 ----
// joinRoomId：邀请链接进来的，连上服务器后立刻尝试加入这个房间
async function connect(joinRoomId = null) {
  let url = el.addrInput.value.trim();
  if (!/^wss?:\/\//.test(url)) url = "ws://" + url;
  url = url.replace(/\/+$/, "");
  const nickname = el.nickInput.value.trim();
  if (nickname) localStorage.setItem(NICK_KEY, nickname);
  intentionalClose = false;
  reconnectTries = 0;
  el.connectBtn.disabled = true;
  el.status.textContent = "⏳ 连接中…";
  try {
    const welcome = await conn.connect(url, {
      fingerprint: getFingerprint(),
      nickname,
    });
    localStorage.setItem(ADDR_KEY, url);
    boardTrackId = welcome.tracks[0]?.id || TRACKS[0].id;
    renderLobby();
    switchView("lobby");
    if (joinRoomId) {
      pendingJoinRoomId = joinRoomId;
      conn.send({ t: "room_join", roomId: joinRoomId });
    }
  } catch (e) {
    const code = e?.code || e?.message || "";
    el.status.textContent = code === "connect_failed"
      ? "❌ 连接失败：请检查服务器地址与服务端是否启动"
      : `❌ 连接被拒绝：${e?.msg || code}`;
    pendingJoinRoomId = null;
  } finally {
    el.connectBtn.disabled = false;
  }
}

// 邀请链接：用链接里（解密出来的）服务器地址连接，并尝试进入指定房间。
// 房间不存在时由 error 处理：提示「房间已失效」并停在该服务器大厅。
export async function joinSharedRoom({ wsUrl, roomId } = {}) {
  if (!wsUrl) return;
  pendingJoinRoomId = roomId || null;
  // 可能是在别的服务器 / 别的房间里点开的链接：先清掉旧房间视图
  room = null;
  myReady = false;
  autoCarRoomId = null;
  cb.onRoomState?.(false);
  el.wrap.classList.remove("hidden");
  if (conn.isOpen() && conn.url === wsUrl) {
    switchView(room ? "room" : "lobby");
    if (roomId) conn.send({ t: "room_join", roomId });
    return;
  }
  el.addrInput.value = wsUrl;
  const nick = getSavedNickname();
  if (nick) el.nickInput.value = nick;
  await connect(roomId);
}

// ---- 大厅 ----
function lobbyInfoText() {
  const s = conn.session;
  if (!s) return "";
  const online = s.online != null ? ` · 🟢 ${s.online} 人在线` : "";
  return `已连接 ${conn.url} · 身份 ${s.nickname}${online}`;
}

function renderLobby() {
  const s = conn.session;
  if (!s) return;
  el.connInfo.textContent = lobbyInfoText();
  renderLobbyBody();
}

function markLobbyInteract() {
  lastLobbyInteract = performance.now();
}

// 实时刷新：数据变了就重绘，但绝不在玩家正在点击/选择的瞬间重建 DOM
function refreshLobby() {
  const s = conn.session;
  if (!s || !el.wrap || el.wrap.classList.contains("hidden")) return;
  el.connInfo.textContent = lobbyInfoText();
  if (el.lobby.classList.contains("hidden")) return;
  if (performance.now() - lastLobbyInteract < 500) {
    if (!lobbyRefreshTimer) {
      lobbyRefreshTimer = setTimeout(() => {
        lobbyRefreshTimer = 0;
        refreshLobby();
      }, 450);
    }
    return;
  }
  renderLobbyBody();
}

function renderLobbyBody() {
  // 保留创建房间表单的选择，避免刷新把玩家选好的赛道/开关冲掉
  const prevTrack = $("createTrackSel")?.value;
  const prevFillAI = $("createFillAI")?.checked;
  el.lobbyBody.innerHTML = (roomError ? `<p class="online-error">⚠️ ${escapeHtml(roomError)}</p>` : "")
    + (currentTab === "boards" ? boardsHtml() : roomsHtml());
  const trackSel = $("createTrackSel");
  const fillAI = $("createFillAI");
  if (trackSel && prevTrack) trackSel.value = prevTrack;
  if (fillAI && prevFillAI !== undefined) fillAI.checked = prevFillAI;
  if (trackSel) syncTrackPreview("createTrackPreview", trackSel.value);
}

function boardsHtml() {
  const s = conn.session;
  const chips = s.tracks.map(t =>
    `<button class="online-chip ${t.id === boardTrackId ? "active" : ""}" data-board-track="${t.id}">
      ${t.flag} ${t.name}</button>`).join("");
  const entries = (s.leaderboards[boardTrackId] || []);
  const head = `
      <div class="online-row online-head">
        <b class="ol-rank">#</b>
        <span class="ol-color-spacer"></span>
        <span class="ol-name">车手</span>
        <span class="ol-car">车队 · 车型</span>
        <span class="ol-time">最快单圈</span>
        <span class="ol-src">来源</span>
      </div>`;
  const rows = entries.length
    ? entries.map(r => {
      const rankClass = r.rank <= 3 ? ` rank-${r.rank}` : "";
      const num = carNumber(r.carId);
      return `
        <div class="online-row${rankClass}">
          <b class="ol-rank">${r.rank}</b>
          <span class="ol-color" style="background:${carColor(r.carId)}"></span>
          <span class="ol-name">${escapeHtml(r.nickname)}</span>
          <span class="ol-car">${escapeHtml(carLabel(r.carId) || "未知车型")}${num ? `<small class="ol-num">${num}</small>` : ""}</span>
          <span class="ol-time">${fmtMs(r.bestLapMs)}</span>
          <span class="ol-src ${r.source === "online_race" ? "tag-race" : "tag-solo"}"
                title="${r.source === "online_race"
                  ? "房间对战：完赛后由服务器校验名次有效性，有效成绩自动入榜"
                  : "单人练习：客户端上传，经理论最短圈校验后入榜"}">${r.source === "online_race" ? "房间对战" : "单人练习"}</span>
        </div>`;
    }).join("")
    : `<div class="online-empty">该赛道还没有有效成绩，来做第一个刷榜的人！</div>`;
  return `
    <p class="track-modal-desc">各赛道最快单圈榜 · 单人练习与房间对战都会入榜（右侧标注成绩来源）</p>
    <div class="online-chips">${chips}</div>
    <div class="online-list">${entries.length ? head : ""}${rows}</div>`;
}

function roomsHtml() {
  const s = conn.session;
  const roomRows = s.rooms?.length
    ? s.rooms.map(r => {
      // 列表里认人靠昵称：房主 + 房内玩家昵称，房间号只作副标题
      const host = r.players?.find(p => p.id === r.hostId);
      const hostName = host?.nickname || "未命名房主";
      const names = (r.players || []).map(p => p.nickname).filter(Boolean);
      const others = names.filter(n => n !== hostName);
      return `
        <div class="online-row${r.state === "racing" ? " is-racing" : ""}">
          <b class="ol-rank">👑</b>
          <span class="ol-color" style="background:${carColor(host?.carId)}"></span>
          <span class="ol-name">${escapeHtml(hostName)}<small class="ol-sub">${r.id}</small></span>
          <span class="ol-car">${escapeHtml(trackLabel(r.trackId))} · ${r.laps ? r.laps + " 圈" : "默认圈数"} · ${r.playerCount}/${r.maxPlayers} 人${r.spectatorCount ? ` · 👀 ${r.spectatorCount} 观战` : ""}${r.fillAI === false ? " · 纯玩家" : " · 含 AI"}</span>
          <span class="ol-sub ol-players">${escapeHtml(others.length ? "车内：" + others.join("、") : "车内只有房主")}</span>
          <span class="ol-src ${r.state === "racing" ? "live" : ""}">${r.state === "racing" ? "● 比赛中" : "等待中"}</span>
          <button class="vt-mini" data-join-room="${r.id}"
            title="${r.state === "racing" ? "比赛进行中：以观赛身份进入，可切换任意赛车观看实时画面" : "加入房间，和房主同场竞速"}">${r.state === "racing" ? "👀 观赛" : "加入"}</button>
        </div>`;
    }).join("")
    : `<div class="online-empty">暂无房间，创建一个吧</div>`;
  const trackOpts = s.tracks.map(t => `<option value="${t.id}">${t.flag} ${t.name}</option>`).join("");
  return `
    <p class="track-modal-desc">创建房间与好友同场 PK · 可自行决定是否加 AI 补位车</p>
    <div class="online-create">
      <select id="createTrackSel">${trackOpts}</select>
      ${trackPreview(s.tracks[0]?.id, "createTrackPreview")}
      <label class="online-ck"><input type="checkbox" id="createFillAI" checked> 加入 AI 补位车（取消则仅玩家对战）</label>
      <button class="results-btn primary online-btn" id="createRoomBtn">➕ 创建房间</button>
    </div>
    <div class="online-list">${roomRows}</div>`;
}

function onLobbyClick(e) {
  const chip = e.target.closest("[data-board-track]");
  if (chip) {
    boardTrackId = chip.getAttribute("data-board-track");
    renderLobbyBody();
    return;
  }
  if (e.target.closest("#createRoomBtn")) {
    const trackId = $("createTrackSel")?.value || "shanghai";
    const fillAI = $("createFillAI")?.checked ?? true;   // 不勾选就没有电脑，纯玩家 PK
    conn.send({ t: "room_create", trackId, fillAI });
    return;
  }
  const join = e.target.closest("[data-join-room]");
  if (join) conn.send({ t: "room_join", roomId: join.getAttribute("data-join-room") });
}

function onLobbyChange(e) {
  if (e.target.id === "createTrackSel") syncTrackPreview("createTrackPreview", e.target.value);
}

// 服务端错误码 → 人话
function errorText(msg) {
  if (msg.code === "not_all_ready" && msg.msg) return "无法开赛：" + msg.msg;
  const map = {
    not_all_ready: "还有玩家未选车或未就绪，暂时无法开赛",
    already_racing: "比赛已经在进行中",
    not_host: "只有房主可以开赛",
    room_full: "房间已满员",
    spectator_full: "观赛人数已满，稍后再试",
    not_racing: "当前没有正在进行的比赛，无需观战",
    room_not_found: "房间已解散",
    not_in_room: "你已不在房间里，请重新进入",
    not_authed: "连接尚未完成认证，请重新连接",
    server_full: "服务器房间数已满，稍后再试",
    start_failed: "开赛失败" + (msg.msg ? "：" + msg.msg : ""),
  };
  return map[msg.code] || ("操作失败：" + (msg.msg || msg.code || "未知错误"));
}

// ---- 房间 ----
// 进房时的自状态同步：
//  1) "选择赛车"下拉默认就选中了一台车，但那只是本地 UI 状态，必须发给服务器，
//     否则别人看到的是"未选车"，开赛校验也过不了；
//  2) 房主补发一次 ready=true —— 新服务端虽然免房主就绪，但这样对旧服务端也兼容，
//     房主永远不会因为"没就绪"卡住开赛。
function syncRoomSelfState(me) {
  if (!room) return;
  // 观赛身份不占发车位：不要自动帮他选车/就绪（否则会挤掉真正参赛的人的可选车型）
  if (me?.spectating) return;
  const mySid = conn.session?.sid || conn.session?.playerId;
  const isHost = room.hostId === mySid;
  const needCar = !me?.carId && autoCarRoomId !== room.id;
  const needReady = isHost && me != null && !me.ready;
  if (!needCar && !needReady) {
    if (me?.carId) autoCarRoomId = room.id;
    return;
  }
  autoCarRoomId = room.id;
  const patch = {};
  if (needCar) {
    const used = new Set(room.players.map(p => p.carId).filter(Boolean));
    const picked = (AI_CONFIGS.find(c => !used.has(c.id)) || AI_CONFIGS[0]).id;
    myCarId = picked;
    patch.carId = picked;
  }
  if (needReady) { myReady = true; patch.ready = true; }
  if (conn.isOpen() && Object.keys(patch).length) conn.send({ t: "room_set", ...patch });
}

function renderRoom() {
  if (!room) return;
  const mySid = conn.session?.sid || conn.session?.playerId;
  const isHost = room.hostId === mySid;
  const me = room.players.find(p => p.id === mySid);
  const iAmSpectating = !!me?.spectating;
  // 参赛车手 / 观赛者分开渲染：观赛不占发车位，也不参与开赛校验
  const racers = room.players.filter(p => !p.spectating);
  const viewers = room.players.filter(p => p.spectating);
  const players = racers.map(p => {
    const isHostRow = p.id === room.hostId;
    const isMe = p.id === mySid;
    const num = p.carId ? carNumber(p.carId) : "";
    return `
    <div class="online-row room-player${isMe ? " is-me" : ""}">
      <b class="ol-rank">${isHostRow ? "👑" : "·"}</b>
      <span class="ol-color" style="background:${p.carId ? carColor(p.carId) : "rgba(255,255,255,.14)"}"></span>
      <span class="ol-name">${escapeHtml(p.nickname || "车手")}${isMe ? '<small class="ol-you">YOU</small>' : ""}</span>
      <span class="ol-car">${p.carId ? escapeHtml(carLabel(p.carId)) + `<small class="ol-num">${num}</small>` : '<span class="ol-none">未选车</span>'}</span>
      <span class="ol-src ${!isHostRow && p.ready ? "ready" : ""}">${isHostRow ? "房主 · HOST" : (p.ready ? "✔ READY" : "等待就绪")}</span>
    </div>`;
  }).join("") + viewers.map(p => {
    const isMe = p.id === mySid;
    return `
    <div class="online-row room-player is-viewer${isMe ? " is-me" : ""}">
      <b class="ol-rank">👀</b>
      <span class="ol-color" style="background:rgba(255,255,255,.14)"></span>
      <span class="ol-name">${escapeHtml(p.nickname || "车手")}${isMe ? '<small class="ol-you">YOU</small>' : ""}</span>
      <span class="ol-car"><span class="ol-none">观赛中 · 不占发车位</span></span>
      <span class="ol-src live">👀 观战</span>
    </div>`;
  }).join("");

  const track = TRACKS.find(t => t.id === room.trackId);
  const trackOpts = TRACKS.map(t =>
    `<option value="${t.id}" ${t.id === room.trackId ? "selected" : ""}>${t.flag} ${t.name}</option>`).join("");
  const carOpts = AI_CONFIGS.map(c =>
    `<option value="${c.id}" ${c.id === myCarId ? "selected" : ""}>${c.team} · ${c.model} (#${c.number})</option>`).join("");
  // 认输后回到房间时本场可能仍在进行：此时不能开下一局，只展示等待提示
  const inRace = room.state === "racing" || room.state === "countdown";
  // 房主不需要准备就绪：只要自己选好车、其他车手全部"选车 + 就绪"即可开赛
  const othersReady = racers.filter(p => p.id !== room.hostId).every(p => p.carId && p.ready);
  const canStart = !inRace && isHost && racers.length > 0 && !!myCarId && othersReady;
  // 禁用时把原因直接写在按钮上，避免"看着能点、点了没反应"
  const waitingNames = racers
    .filter(p => p.id !== room.hostId && (!p.carId || !p.ready))
    .map(p => p.nickname || "车手");
  const startReason = inRace
    ? "本场比赛还在进行中"
    : !myCarId
      ? "先选择你的赛车"
      : (waitingNames.length ? `等待 ${waitingNames.join("、")} 就绪` : "全员就绪，开赛！");
  // AI 补位数量与服务器一致：maxPlayers - 真人车手数量（最多 7 台，AI_CONFIGS 只有 7 套配置）
  const aiCount = room.fillAI
    ? Math.max(0, Math.min(AI_CONFIGS.length, (room.maxPlayers || 8) - racers.length))
    : 0;
  const fieldText = room.fillAI
    ? `🤖 AI 补位 ${aiCount} 台 · 共 ${racers.length + aiCount} 车`
    : "👥 纯玩家对战 · 无 AI";
  const lapsOpts = [0, 1, 2, 3, 5, 8, 10, 15, 20].map(n =>
    `<option value="${n}" ${roomLaps === n ? "selected" : ""}>${n === 0 ? "赛道默认圈数" : n + " 圈"}</option>`).join("");
  const lapsText = roomLaps ? `${roomLaps} 圈` : `赛道默认${track?.laps ? `（${track.laps} 圈）` : ""}`;
  // 房主可以改赛道 / 圈数 / 玩法；其他人只读展示房主的同一份设定（不能改，但必须看得到）
  const rulesHtml = isHost
    ? `<div class="online-create">
        <label>赛道 <select id="roomTrackSel">${trackOpts}</select></label>
        ${trackPreview(room.trackId, "roomTrackPreview")}
        <label>圈数 <select id="roomLapsSel">${lapsOpts}</select></label>
        <label class="online-ck"><input type="checkbox" id="roomFillAI" ${room.fillAI ? "checked" : ""}> AI 补位车</label>
      </div>`
    : `<div class="online-create room-rules" title="赛道 / 圈数 / 玩法由房主决定">
        <span class="rule-name">🏁 赛道</span><b>${track ? track.flag + " " + track.name : room.trackId}</b>
        ${trackPreview(room.trackId, "roomTrackPreview")}
        <span class="rule-name">🔄 圈数</span><b>${lapsText}</b>
        <span class="rule-name">🎮 玩法</span><b>${room.fillAI ? `AI 补位 ${aiCount} 台` : "纯玩家对战"}</b>
        <span class="ol-sub">由房主决定</span>
      </div>`;

  const viewerText = viewers.length ? ` · 👀 ${viewers.length} 人观战` : "";
  // 全员已就绪 → 服务端 5 秒后自动开赛（房主不点也照样开）；房主按钮上直接标出来
  const autoStartMs = Number(room.autoStartInMs) || 0;
  const autoStartText = autoStartMs > 0 ? ` · ${Math.ceil(autoStartMs / 1000)} 秒后自动开始` : "";
  // 提示条：观赛身份 / 比赛进行中 / 全员就绪即将自动开赛
  const hintHtml = iAmSpectating
    ? `<p class="online-error viewer-hint">👀 你当前是观赛身份：比赛进行中可切换任意赛车观看实时画面；点「加入下一局」回到参赛名单</p>`
    : inRace
      ? `<p class="online-error">⏳ 本场比赛仍在进行中，结束后即可开始下一局（也可以点「观战本场比赛」）</p>`
      : autoStartMs > 0
        ? `<p class="online-error viewer-hint">⏱ 全员已就绪 · ${Math.ceil(autoStartMs / 1000)} 秒后自动开始（房主也可立即开赛）</p>`
        : "";
  // 观赛身份没有发车位：隐藏选车 / 就绪，改成"加入下一局"
  const selfHtml = iAmSpectating
    ? `<div class="online-create">
        <span class="ol-sub">观赛中：不占发车位、不参与本局排名</span>
      </div>`
    : `<div class="online-create">
        <label>选择赛车 <select id="roomCarSel">${carOpts}</select></label>
        ${isHost
      ? `<span class="ol-sub">房主无需准备，选好车即可开赛${autoStartText}</span>`
      : `<button class="results-btn online-btn" id="roomReadyBtn" ${myReady ? "" : 'title="15 秒内未准备会自动就绪"'}
          >${myReady ? "取消就绪" : "✔ 准备就绪"}</button>`}
      </div>`;

  el.roomView.innerHTML = `
    <p class="track-modal-desc">
      房间 <b>${room.id}</b> · ${track ? track.flag + " " + track.name : room.trackId}
      · ${fieldText}
      · 即时网络碰撞 · 0 延迟阻挡 · 动量防穿模
      · ${racers.length}/${room.maxPlayers} 人${viewerText}
    </p>
    ${hintHtml}
    <div class="online-list">${players}</div>
    ${roomError ? `<p class="online-error">⚠️ ${escapeHtml(roomError)}</p>` : ""}
    ${rulesHtml}
    ${selfHtml}
    <div class="online-room-actions">
      ${iAmSpectating
      ? `<button class="results-btn primary online-btn" id="roomJoinNextBtn"
          title="回到参赛名单：可以选车、就绪，参加下一局">🏁 加入下一局</button>`
      : ""}
      ${inRace && !iAmSpectating
      ? `<button class="results-btn primary online-btn" id="roomSpectateBtn"
          title="以观赛身份进入本场比赛：可以切换任意赛车观看实时画面，不影响比赛结果">👀 观战本场比赛</button>`
      : ""}
      ${isHost && !iAmSpectating ? `
      <button class="results-btn primary online-btn" id="roomStartBtn" ${canStart ? "" : "disabled"}
        title="${startReason}（房主无需准备 · 全员就绪 5 秒后自动开始）">${canStart
      ? `🏁 开始比赛${autoStartText}`
      : "⏳ " + startReason}</button>` : ""}
      ${iAmSpectating ? "" : `<button class="results-btn online-btn ${isAutopilotOn() ? "on" : ""}" id="roomAutopilotBtn"
        title="开启后由算法驾驶你的赛车（本地运行，支持自定义算法）">🤖 自动驾驶：${isAutopilotOn() ? "开" : "关"}</button>`}
      <button class="results-btn online-btn" id="roomShareBtn"
        title="生成邀请链接：好友点开自动连接本服务器并加入这个房间">🔗 分享房间</button>
      <button class="results-btn online-btn" id="roomLeaveBtn">← 离开房间</button>
    </div>`;
}

function onRoomClick(e) {
  if (e.target.closest("#roomStartBtn")) {
    conn.send({ t: "room_start", laps: roomLaps || undefined });
    return;
  }
  // 观赛：服务端确认后会补发本局参赛名单（race_start），主流程自动切到观赛画面
  if (e.target.closest("#roomSpectateBtn")) {
    conn.send({ t: "room_spectate", on: true });
    return;
  }
  // 结束观赛身份，回到参赛名单（可选车 / 就绪，参加下一局）
  if (e.target.closest("#roomJoinNextBtn")) {
    conn.send({ t: "room_spectate", on: false });
    return;
  }
  if (e.target.closest("#roomAutopilotBtn")) {
    cb.onOpenAutopilot?.();
    return;
  }
  if (e.target.closest("#roomShareBtn")) {
    if (room) cb.onShareRoom?.(room.id);
    return;
  }
  if (e.target.closest("#roomLeaveBtn")) {
    leaveOnlineRoom();
    return;
  }
  if (e.target.closest("#roomReadyBtn")) {
    myReady = !myReady;
    // carId 为空时不要带上：服务端会把 null 转成字符串 "null" 污染选车状态
    conn.send(myCarId
      ? { t: "room_set", ready: myReady, carId: myCarId }
      : { t: "room_set", ready: myReady });
  }
}

function onRoomChange(e) {
  const id = e.target.id;
  if (id === "roomTrackSel") {
    syncTrackPreview("roomTrackPreview", e.target.value);
    conn.send({ t: "room_set", trackId: e.target.value });
  }
  else if (id === "roomFillAI") conn.send({ t: "room_set", fillAI: e.target.checked });
  else if (id === "roomLapsSel") {
    roomLaps = Number(e.target.value) || 0;
    // 圈数也同步给服务器：非房主要能提前看到房主的设定，而不是开赛才知道
    conn.send({ t: "room_set", laps: roomLaps });
  }
  else if (id === "roomCarSel") {
    myCarId = e.target.value;
    conn.send({ t: "room_set", carId: myCarId });
  }
}

function fmtMs(ms) {
  if (!ms) return "--";
  const m = Math.floor(ms / 60000), s = Math.floor(ms / 1000) % 60, cs = Math.floor(ms / 10) % 100;
  return `${m}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
