// WebSocket 连接封装：握手 / 事件分发 / 状态管理
// 协议与服务端 server/net/gateway.js 对应（v1, JSON 文本帧）
const handlers = new Map();

let ws = null;

function emit(type, msg) {
  for (const fn of handlers.get(type) || []) {
    try { fn(msg); } catch (e) { console.error("[conn] handler error", e); }
  }
}

export const conn = {
  status: "idle",        // idle | connecting | open | closed | error
  url: null,             // ws://host:port
  httpBase: null,        // 对应的 REST 基地址
  session: null,         // welcome 消息载荷（playerId/nickname/leaderboards/...）

  // 连接并完成 hello 握手；resolve(welcomePayload) / reject(error)
  connect(url, { fingerprint, nickname }) {
    return new Promise((resolve, reject) => {
      this.close();
      // 无路径的地址自动补全默认网关路径 /ws（与 server/net/gateway.js 对应）
      try {
        const u = new URL(url.replace(/^ws/i, "http"));
        if (u.pathname === "/" || u.pathname === "") url = url.replace(/\/+$/, "") + "/ws";
      } catch { /* 由浏览器负责报错 */ }
      this.url = url;
      // REST 基地址取同源 origin（不能把 /ws 网关路径拼进去）
      try {
        this.httpBase = new URL(url.replace(/^ws/, "http")).origin;
      } catch {
        this.httpBase = url.replace(/^ws/, "http").replace(/\/+$/, "");
      }
      this.status = "connecting";
      ws = new WebSocket(url);

      let settled = false;
      ws.onopen = () => {
        ws.send(JSON.stringify({ t: "hello", fingerprint, nickname }));
      };
      ws.onmessage = (e) => {
        let msg;
        try { msg = JSON.parse(e.data); } catch { return; }
        if (msg.t === "welcome") {
          this.status = "open";
          this.session = msg;
          if (!settled) { settled = true; resolve(msg); }
        }
        if (msg.t === "error" && !settled) {
          settled = true;
          this.status = "error";
          reject(msg);
          return;
        }
        emit(msg.t, msg);
      };
      ws.onerror = () => {
        if (!settled) { settled = true; this.status = "error"; reject({ code: "connect_failed" }); }
      };
      ws.onclose = () => {
        this.status = "closed";
        this.session = null;
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
    if (this.isOpen()) ws.send(JSON.stringify(obj));
  },

  isOpen() { return !!ws && ws.readyState === 1; },

  close() {
    if (ws) { try { ws.close(); } catch { /* ignore */ } ws = null; }
    this.status = "idle";
    this.session = null;
  },
};
