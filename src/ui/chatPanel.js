// 在线聊天面板（左下角，连上服务器后才出现）：
//  · 大厅：只有全局频道（服务器广播给所有在线会话）
//  · 房间 / 比赛中：可以切换发送范围「全局 / 房间」
//  · 只保留最近 MAX_LINES 条，每条带发送时间；刚连上 / 刚进房由服务器补发历史记录
// 输入框内的按键一律 stopPropagation：否则打字时 R 重开、T 换赛道、Esc 退出比赛会被误触发。
import { conn } from "../net/connection.js";

const MAX_LINES = 10;     // 聊天记录只留最近 10 条

let root = null, logEl = null, inputEl = null, scopeSel = null, scopeTagEl = null;
let toggleEl = null, sendBtn = null;
let inRoom = false;
let bound = false;
let wantVisible = false;      // 主流程是否处于在线流程（真正显示还要 conn 已连上）
let entries = [];             // { kind:"msg"|"sys", scope, nick, text, ts, mine }

const $ = (id) => document.getElementById(id);

function currentScope() {
  return inRoom && scopeSel?.value === "room" ? "room" : "global";
}

function syncScopeUi() {
  if (!scopeSel) return;
  scopeSel.classList.toggle("hidden", !inRoom);
  scopeTagEl?.classList.toggle("hidden", inRoom);
  scopeSel.value = currentScope();
}

// 面板展开时才把左下角操作说明顶上去
function syncHelpOffset() {
  const expanded = !!root && !root.classList.contains("hidden") && !root.classList.contains("collapsed");
  document.body.classList.toggle("chat-on", expanded);
}

// 只有真的连上服务器（收到 welcome 且连接未断）才显示面板：
// 站在地址输入页 / 掉线后都不出现，避免"没连上却能打字"的错觉
function syncVisible() {
  if (!root) return;
  const show = wantVisible && conn.isOpen();
  root.classList.toggle("hidden", !show);
  syncHelpOffset();
}

function fmtTime(ts) {
  const d = new Date(Number(ts) || Date.now());
  if (Number.isNaN(d.getTime())) return "";
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

function buildLine(e) {
  const line = document.createElement("div");
  const time = document.createElement("span");
  time.className = "chat-time";
  time.textContent = fmtTime(e.ts);

  if (e.kind === "sys") {
    line.className = "chat-line sys";
    line.append(time, document.createTextNode(e.text));
    return line;
  }

  line.className = "chat-line " + (e.scope === "room" ? "room" : "global") + (e.mine ? " mine" : "");
  const tag = document.createElement("span");
  tag.className = "chat-tag";
  tag.textContent = e.scope === "room" ? "[房间]" : "[全局]";
  const name = document.createElement("b");
  name.textContent = e.nick;
  const body = document.createElement("span");
  body.textContent = e.text;
  line.append(time, tag, name, body);
  return line;
}

function renderLog() {
  if (!logEl) return;
  logEl.textContent = "";
  for (const e of entries) logEl.appendChild(buildLine(e));
  logEl.scrollTop = logEl.scrollHeight;
}

function trim() {
  if (entries.length > MAX_LINES) entries = entries.slice(-MAX_LINES);
}

function pushEntry(entry) {
  entries.push(entry);
  trim();
  renderLog();
}

export function pushSystemChat(text) {
  if (!text) return;
  pushEntry({ kind: "sys", text, ts: Date.now() });
}

function send() {
  const text = (inputEl?.value || "").trim();
  if (!text) return;
  if (!conn.isOpen()) {
    pushSystemChat("⚠️ 未连接服务器，消息没有发出");
    return;
  }
  conn.send({ t: "chat", scope: currentScope(), text });
  inputEl.value = "";
}

function mySid() {
  return conn.session?.sid || conn.session?.playerId;
}

function toEntry(m, fallbackScope) {
  return {
    kind: "msg",
    scope: (m.scope || fallbackScope) === "room" ? "room" : "global",
    nick: m.from?.nickname || "车手",
    text: String(m.text || ""),
    ts: Number(m.ts) || Date.now(),
    mine: !!mySid() && m.from?.sid === mySid(),
  };
}

function onChatMessage(m) {
  if (!m || !m.text) return;
  pushEntry(toEntry(m, "global"));
}

// 服务器补发的历史：用它替换同频道的本地缓存（历史里已包含这些消息，避免重复）
function onChatHistory(m) {
  const scope = m.scope === "room" ? "room" : "global";
  const items = Array.isArray(m.items) ? m.items : [];
  const hist = items
    .map(it => toEntry(it, scope))
    .filter(e => e.text);
  entries = entries.filter(e => e.kind === "sys" || e.scope !== scope);
  entries = [...hist, ...entries].sort((a, b) => (a.ts || 0) - (b.ts || 0));
  trim();
  renderLog();
}

// 主动向服务器要某个频道的历史（切频道 / 面板重新显示时补齐最近 10 条）
function requestHistory(scope) {
  if (!conn.isOpen()) return;
  conn.send({ t: "chat_history_req", scope: scope === "room" ? "room" : "global" });
}

// 是否在房间里：决定能不能选「房间」频道
export function setChatRoom(isRoom) {
  const next = !!isRoom;
  if (next !== inRoom && scopeSel) scopeSel.value = next ? "room" : "global";
  inRoom = next;
  syncScopeUi();
  requestHistory(currentScope());
}

// 进入 / 离开在线流程：真正是否显示由"是否已连上服务器"决定（见 syncVisible）
export function showChat(visible) {
  wantVisible = !!visible;
  syncVisible();
  if (wantVisible) requestHistory(currentScope());
}

export function initChatPanel() {
  if (bound) return;
  root = $("chatPanel");
  if (!root) return;
  bound = true;

  logEl = $("chatLog");
  inputEl = $("chatInput");
  scopeSel = $("chatScope");
  scopeTagEl = $("chatScopeTag");
  toggleEl = $("chatToggle");
  sendBtn = $("chatSend");

  sendBtn?.addEventListener("click", send);
  scopeSel?.addEventListener("change", () => {
    syncScopeUi();
    requestHistory(currentScope());   // 切到「全局」也能立刻看到全局历史
  });

  toggleEl?.addEventListener("click", () => {
    root.classList.toggle("collapsed");
    toggleEl.textContent = root.classList.contains("collapsed") ? "+" : "—";
    syncHelpOffset();
  });

  inputEl?.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") { e.preventDefault(); send(); }
    else if (e.key === "Escape") { e.preventDefault(); inputEl.blur(); }
  });

  conn.on("chat", onChatMessage);
  conn.on("chat_history", onChatHistory);
  conn.on("chat_slow", () => pushSystemChat("⚠️ 发送太快了，稍等一下再发"));
  // 连接建立 / 断开：面板跟着显隐（历史记录由服务器紧接着补发）
  conn.on("welcome", () => {
    syncVisible();
    pushSystemChat(`已连接服务器 · 大厅为全局频道，进房后可切到房间频道`);
  });
  conn.on("_closed", () => syncVisible());

  syncScopeUi();
  syncVisible();
}
