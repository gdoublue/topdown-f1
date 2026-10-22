// WebSocket 连接封装：握手 / 事件分发 / 状态管理
// 协议与服务端 server/net/gateway.js 对应（v1, JSON 文本帧）
//
// 传输层是双通道：
//   · 大厅 / 房间 / 开赛 / 成绩 / 信令 —— WebSocket（可靠有序，低频）
//   · 位姿 snapshot / peer_state / car_state —— WebRTC DataChannel（UDP，无序不重传，高频）
// 上层只管调 conn.send()、conn.on()，具体走哪条通道由这里决定；
// DataChannel 建不起来（缺 STUN、被墙、UDP 不通）时自动全程回落 WebSocket，游戏无感。
import { rtc } from "./rtc.js";

const handlers = new Map();

// 允许走 UDP 的消息类型：只认最新的高频位姿包，丢一包无所谓
const UDP_TYPES = new Set(["car_state"]);

let ws = null;
let status = "idle";
let session = null;
let settle = null;      // { resolve, reject, done }

function emit(type, msg) {
  for (const fn of handlers.get(type) || []) {
    try { fn(msg); } catch (e) { console.error("[conn] handler error", e); }
  }
}

// WebSocket 与 DataChannel 共用一套消息分发
function dispatch(msg) {
  if (!msg || !msg.t) return;

  if (msg.t === "welcome") {
    status = "open";
    session = msg;
    if (settle && !settle.done) { settle.done = true; settle.resolve(msg); }
    // 服务端支持 WebRTC 就顺手建一条 UDP 状态通道（失败自动回落 WS）
    if (msg.rtc && msg.rtc.iceServers) {
      rtc.start({
        iceServers: msg.rtc.iceServers,
        sendSignal: (o) => sendWs(o),
        onMessage: dispatch,
      });
    }
  }

  if (msg.t === "error" && settle && !settle.done) {
    settle.done = true;
    status = "error";
    settle.reject(new Error(msg.code || "error"));
    return;
  }

  emit(msg.t, msg);
}

// 只走 WebSocket（信令与控制消息）
function sendWs(obj) {
  if (ws && ws.readyState === 1) { ws.send(JSON.stringify(obj)); return true; }
  return false;
}

// 内建信令处理：offer/answer/candidate（用 Set，和 conn.on 的存储结构保持一致）
handlers.set("rtc_offer", new Set([(m) => rtc.handleOffer(m && m.sdp)]));
handlers.set("rtc_ice", new Set([(m) => rtc.handleIce(m)]));

// 拆掉底层连接但不通知上层：重连换连接时用（那种情况不是掉线，不该弹提示/再触发重连）
function teardown() {
  const sock = ws;
  ws = null;
  status = "idle";
  session = null;
  rtc.stop();
  if (sock) { try { sock.close(); } catch { /* ignore */ } }
}

export const conn = {
  get status() { return status; },
  url: null,
  httpBase: null,
  get session() { return session; },

  // 诊断：状态数据当前实际走的是哪条通道
  get transport() { return rtc.transport; },
  get rtcState() { return rtc.state; },

  // 连接并完成 hello 握手；resolve(welcomePayload) / reject(error)
  connect(url, { fingerprint, nickname }) {
    return new Promise((resolve, reject) => {
      // 换连接前先拆掉旧 socket：拆的时候不发 _closed，
      // 否则"重连"会先被当成一次掉线（上层会弹提示并再触发一轮重连）
      teardown();
      // 无路径的地址自动补全默认网关路径 /ws（与 server/net/gateway.js 对应）
      try {
        const u = new URL(url.replace(/^ws/i, "http"));
        if (u.pathname === "/" || u.pathname === "") url = url.replace(/\/+$/, "") + "/ws";
      } catch { /* 由浏览器负责报错 */ }
      this.url = url;
      // REST 基地址取同源 origin（不能把 /ws 网关路径拼进去）
      try {
        this.httpBase = new URL(url.replace(/^ws/i, "http")).origin;
      } catch {
        this.httpBase = url.replace(/^ws/, "http").replace(/\/+$/, "");
      }
      status = "connecting";
      settle = { resolve, reject, done: false };
      const sock = new WebSocket(url);
      ws = sock;
      // 旧 socket 的 onclose 是异步到达的，可能晚于新连接建立；
      // 只要 ws 已经不是它自己，就说明这条事件已经过期，必须忽略。
      const stale = () => ws !== sock;

      sock.onopen = () => {
        if (stale()) return;
        sock.send(JSON.stringify({ t: "hello", fingerprint, nickname }));
      };
      sock.onmessage = (e) => {
        if (stale()) return;
        let msg;
        try { msg = JSON.parse(e.data); } catch { return; }
        dispatch(msg);
      };
      sock.onerror = () => {
        if (stale()) return;
        if (settle && !settle.done) {
          settle.done = true;
          status = "error";
          reject(new Error("connect_failed"));
        }
      };
      sock.onclose = () => {
        if (stale()) return;   // 已主动拆掉 / 已被新连接取代：不算掉线
        status = "closed";
        session = null;
        rtc.stop();          // 连接没了，UDP 通道一并释放
        emit("_closed", {});
      };
    });
  },

  on(type, fn) {
    if (!handlers.has(type)) handlers.set(type, new Set());
    handlers.get(type).add(fn);
  },
  off(type, fn) { handlers.get(type)?.delete(fn); },

  send(obj) {
    // 位姿高频包优先走 UDP：链路无队头阻塞，丢包不阻塞后续
    if (obj && UDP_TYPES.has(obj.t) && rtc.trySend(obj)) return true;
    return sendWs(obj);
  },

  isOpen() { return !!ws && ws.readyState === 1; },

  // 主动断开：先拆连接再通知上层
  // （onlineUI 靠 _closed 复位"主动断开"标记；旧 socket 迟到的 onclose 已被 stale 检查忽略）
  close() {
    const had = !!ws;
    teardown();
    if (had) emit("_closed", {});
  },
};