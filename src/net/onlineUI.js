// 在线模式 UI：服务器地址 → 大厅（排行榜 / 房间列表）→ 房间详情
// 与 src/main.js 协作：选模式 online 时调用 showOnline()；
// "单人在线练习"通过回调交还 main.js 走 solo 流程（成绩自动上传）。
import { TRACKS } from "../track/tracks.js";
import { AI_CONFIGS } from "../game/ai.js";
import { conn } from "./connection.js";
import { getFingerprint } from "./fingerprint.js";
import { isAutopilotOn } from "../ui/autopilot.js";

const el = {};
let cb = {};                       // { onStartPractice }
let currentTab = "boards";
let room = null;                   // 当前所在房间 view
let lastRoomId = null;             // 重连后尝试重新加入
let myCarId = null;
let myReady = false;
let boardTrackId = null;
let roomLaps = 0;                  // 房主自定义圈数（0 = 赛道默认）
let intentionalClose = false;      // 用户主动断开（不触发自动重连）
let reconnectTries = 0;

const ADDR_KEY = "gp_server_url";
const NICK_KEY = "gp_nickname";

function $(id) { return document.getElementById(id); }

function defaultServerAddr() {
  const saved = localStorage.getItem(ADDR_KEY);
  if (saved) return saved;
  return `ws://${location.hostname || "localhost"}:8080`;
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
    exitBtn: $("onlineExitBtn"),
  });
  if (!el.wrap) return;

  el.addrInput.value = defaultServerAddr();
  el.nickInput.value = localStorage.getItem(NICK_KEY) || "";
  el.connectBtn.addEventListener("click", connect);
  // 返回主菜单：房间/比赛的退出由主流程统一处理（会先 room_leave / 认输）
  el.exitBtn?.addEventListener("click", () => cb.onExit?.());
  el.addrInput.addEventListener("keydown", (e) => { if (e.key === "Enter") connect(); });
  el.nickInput.addEventListener("keydown", (e) => { if (e.key === "Enter") connect(); });
  el.disconnectBtn.addEventListener("click", () => {
    intentionalClose = true;
    conn.close();
    showAddr("已断开连接");
  });
  el.practiceBtn.addEventListener("click", () => {
    leaveOnlineRoom();
    cb.onStartPractice?.();
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
  el.roomView.addEventListener("click", onRoomClick);
  el.roomView.addEventListener("change", onRoomChange);

  conn.on("room_update", (msg) => {
    room = msg.room || null;
    if (!room) { renderLobby(); switchView("lobby"); return; }
    lastRoomId = room.id;
    // 同步自己在房间内的选车/就绪状态
    const mySid = conn.session?.sid || conn.session?.playerId;
    const me = room.players.find(p => p.id === mySid);
    if (me) { myCarId = me.carId; myReady = me.ready; }
    renderRoom();
    switchView("room");
  });

  // 服务端确认退出房间：清掉本地房间态，回到大厅（比赛中的退出由服务端判负并广播）
  conn.on("room_leave_ok", () => {
    room = null;
    myReady = false;
    lastRoomId = null;
    if (conn.isOpen()) { renderLobby(); switchView("lobby"); }
  });
  conn.on("_closed", () => {
    room = null;
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
}

export function showOnline() {
  el.wrap.classList.remove("hidden");
  room = null;
  if (conn.isOpen()) { renderLobby(); switchView("lobby"); }
  else showAddr();
}

export function hideOnline() {
  el.wrap.classList.add("hidden");
}

// 主动退出当前房间：服务端在比赛进行中会把这次退出判定为认输，并把房间视图广播给其他人。
// 返回是否真的在房间里（供上层决定是否需要额外提示）。
export function leaveOnlineRoom() {
  if (!room) return false;
  if (conn.isOpen()) conn.send({ t: "room_leave" });
  room = null;
  myReady = false;
  lastRoomId = null;          // 断线重连后不要自动回到已退出的房间
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
async function connect() {
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
  } catch (e) {
    el.status.textContent = e.code === "connect_failed"
      ? "❌ 连接失败：请检查服务器地址与服务端是否启动"
      : `❌ 连接被拒绝：${e.msg || e.code || ""}`;
  } finally {
    el.connectBtn.disabled = false;
  }
}

// ---- 大厅 ----
function renderLobby() {
  const s = conn.session;
  if (!s) return;
  const online = s.online != null ? ` · 🟢 ${s.online} 人在线` : "";
  el.connInfo.textContent = `已连接 ${conn.url} · 身份 ${s.nickname}${online}`;
  renderLobbyBody();
}

function renderLobbyBody() {
  if (currentTab === "boards") el.lobbyBody.innerHTML = boardsHtml();
  else el.lobbyBody.innerHTML = roomsHtml();
}

function boardsHtml() {
  const s = conn.session;
  const chips = s.tracks.map(t =>
    `<button class="online-chip ${t.id === boardTrackId ? "active" : ""}" data-board-track="${t.id}">
      ${t.flag} ${t.name}</button>`).join("");
  const entries = (s.leaderboards[boardTrackId] || []);
  const rows = entries.length
    ? entries.map(r => `
        <div class="online-row">
          <b class="ol-rank">${r.rank}</b>
          <span class="ol-name">${escapeHtml(r.nickname)}</span>
          <span class="ol-car">${escapeHtml(r.carId)}</span>
          <span class="ol-time">${fmtMs(r.bestLapMs)}</span>
          <span class="ol-src">${r.source === "online_race" ? "对战" : "练习"}</span>
        </div>`).join("")
    : `<div class="online-empty">该赛道还没有有效成绩，来做第一个刷榜的人！</div>`;
  return `
    <p class="track-modal-desc">各赛道最快单圈榜 · 前往"单人在线练习"刷圈即可上传成绩</p>
    <div class="online-chips">${chips}</div>
    <div class="online-list">${rows}</div>`;
}

function roomsHtml() {
  const s = conn.session;
  const roomRows = s.rooms?.length
    ? s.rooms.map(r => `
        <div class="online-row">
          <b class="ol-rank">${r.id}</b>
          <span class="ol-name">${r.trackId}${r.fillAI === false ? " · 纯玩家" : " · 含 AI"}</span>
          <span class="ol-car">${r.playerCount}/${r.maxPlayers} 人 · ${r.state === "racing" ? "比赛中" : "等待中"}</span>
          <button class="vt-mini" data-join-room="${r.id}">加入</button>
        </div>`).join("")
    : `<div class="online-empty">暂无房间，创建一个吧</div>`;
  const trackOpts = s.tracks.map(t => `<option value="${t.id}">${t.flag} ${t.name}</option>`).join("");
  return `
    <p class="track-modal-desc">创建房间与好友同场 PK · 可自行决定是否加 AI 补位车</p>
    <div class="online-create">
      <select id="createTrackSel">${trackOpts}</select>
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

function onLobbyChange() { /* 预留 */ }

// ---- 房间 ----
function renderRoom() {
  if (!room) return;
  const mySid = conn.session?.sid || conn.session?.playerId;
  const isHost = room.hostId === mySid;
  const me = room.players.find(p => p.id === mySid);
  const players = room.players.map(p => `
    <div class="online-row">
      <b class="ol-rank">${p.id === room.hostId ? "👑" : "·"}</b>
      <span class="ol-name">${escapeHtml(p.nickname || p.id)}${p.id === mySid ? " (你)" : ""}</span>
      <span class="ol-car">${p.carId ? escapeHtml(p.carId) : "未选车"}</span>
      <span class="ol-src">${p.ready ? "✅ 已就绪" : "⌛ 准备中"}</span>
    </div>`).join("");

  const track = TRACKS.find(t => t.id === room.trackId);
  const trackOpts = TRACKS.map(t =>
    `<option value="${t.id}" ${t.id === room.trackId ? "selected" : ""}>${t.flag} ${t.name}</option>`).join("");
  const carOpts = AI_CONFIGS.map(c =>
    `<option value="${c.id}" ${c.id === myCarId ? "selected" : ""}>${c.shortName} (#${c.number})</option>`).join("");
  const othersReady = room.players.filter(p => p.id !== room.hostId).every(p => p.carId && p.ready);
  const canStart = isHost && room.players.length > 0 && !!myCarId && myReady && othersReady;
  // AI 补位数量与服务器一致：maxPlayers - 真人数量（最多 7 台，AI_CONFIGS 只有 7 套配置）
  const aiCount = room.fillAI
    ? Math.max(0, Math.min(AI_CONFIGS.length, (room.maxPlayers || 8) - room.players.length))
    : 0;
  const fieldText = room.fillAI
    ? `🤖 AI 补位 ${aiCount} 台 · 共 ${room.players.length + aiCount} 车`
    : "👥 纯玩家对战 · 无 AI";
  const lapsOpts = [0, 1, 2, 3, 5, 8, 10, 15, 20].map(n =>
    `<option value="${n}" ${roomLaps === n ? "selected" : ""}>${n === 0 ? "赛道默认圈数" : n + " 圈"}</option>`).join("");

  el.roomView.innerHTML = `
    <p class="track-modal-desc">
      房间 <b>${room.id}</b> · ${track ? track.flag + " " + track.name : room.trackId}
      · ${fieldText}
      · 💥 QQ飞车式网络即时碰撞（0延迟阻挡、动量防穿模）
      · ${room.playerCount}/${room.maxPlayers} 人
    </p>
    <div class="online-list">${players}</div>
    ${isHost ? `
      <div class="online-create">
        <label>赛道 <select id="roomTrackSel">${trackOpts}</select></label>
        <label>圈数 <select id="roomLapsSel">${lapsOpts}</select></label>
        <label class="online-ck"><input type="checkbox" id="roomFillAI" ${room.fillAI ? "checked" : ""}> AI 补位车</label>
      </div>` : ""}
      <div class="online-create">
        <label>选择赛车 <select id="roomCarSel">${carOpts}</select></label>
        <button class="results-btn online-btn" id="roomReadyBtn">${myReady ? "取消就绪" : "✔ 准备就绪"}</button>
      </div>
    <div class="online-room-actions">
      <button class="results-btn primary online-btn" id="roomStartBtn" ${canStart ? "" : "disabled"}
        title="${canStart ? "全员就绪，开赛！" : "房主在全员选车并就绪后可开赛"}">🏁 开始比赛</button>
      <button class="results-btn online-btn ${isAutopilotOn() ? "on" : ""}" id="roomAutopilotBtn"
        title="开启后由算法驾驶你的赛车（本地运行，支持自定义算法）">🤖 自动驾驶：${isAutopilotOn() ? "开" : "关"}</button>
      <button class="results-btn online-btn" id="roomLeaveBtn">← 离开房间</button>
    </div>`;
}

function onRoomClick(e) {
  if (e.target.closest("#roomStartBtn")) {
    conn.send({ t: "room_start", laps: roomLaps || undefined });
    return;
  }
  if (e.target.closest("#roomAutopilotBtn")) {
    cb.onOpenAutopilot?.();
    return;
  }
  if (e.target.closest("#roomLeaveBtn")) {
    leaveOnlineRoom();
    return;
  }
  if (e.target.closest("#roomReadyBtn")) {
    myReady = !myReady;
    conn.send({ t: "room_set", ready: myReady, carId: myCarId });
  }
}

function onRoomChange(e) {
  const id = e.target.id;
  if (id === "roomTrackSel") conn.send({ t: "room_set", trackId: e.target.value });
  else if (id === "roomFillAI") conn.send({ t: "room_set", fillAI: e.target.checked });
  else if (id === "roomLapsSel") roomLaps = Number(e.target.value) || 0;
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
