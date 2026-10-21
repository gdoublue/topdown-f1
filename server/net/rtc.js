// WebRTC DataChannel（UDP）状态通道
//
// 为什么需要它：现有 WebSocket 走 TCP，一个包迟到会把后面所有包一起堵住（队头阻塞）。
// 实测"1% 概率单包延迟 180ms"会让远端车出现 2.58 倍速度的弹跳，而这种尖峰在丢包链路上
// 是常态。位姿数据是"只认最新"的：晚到的旧坐标没有价值，重传只会制造更多延迟。
// 所以 DataChannel 用 unordered + maxRetransmits:0，丢包直接丢，下一包 16ms 后就到了。
//
// 设计取舍：
//   · 信令（offer/answer/candidate）仍然走 WebSocket —— 低频、必须可靠
//   · 大厅/房间/成绩仍然走 WebSocket —— 必须可靠有序
//   · 只有 snapshot / peer_state / car_state 走 DataChannel
//   · 任何一步失败（缺依赖、建链超时、UDP 被封）都静默回落 WebSocket，游戏照常跑
import { SERVER_CONFIG } from "../config.js";

const RTC_CONFIG = SERVER_CONFIG.rtc;

// 原生依赖缺失（没跑 npm install / 平台没有预编译包）时不能让整个服务起不来
let ndc = null;
try {
  ndc = await import("node-datachannel");
} catch (e) {
  console.warn("[rtc] node-datachannel 不可用，状态通道回落 WebSocket：", e.message);
}

export const rtcAvailable = !!ndc && RTC_CONFIG.enabled;

// 建链超时：超过这个时间还没开，就当没有 UDP 这条路（客户端继续走 WS）
const HANDSHAKE_TIMEOUT_MS = 12000;

// TURN 规格：turn[s]://user:pass@host:port[?transport=tls]
// 浏览器要 {urls, username, credential}，libdatachannel 要 {hostname, port, ...}，两边都要支持。
function parseTurn(spec) {
  if (!spec) return null;
  const m = /^(turns?):(?:(.+?):(.+?)@)?([^:?]+)(?::(\d+))?(?:\?transport=tls)?$/.exec(String(spec).trim());
  if (!m) return null;
  const scheme = m[1];
  const hostname = m[4];
  const port = Number(m[5] || (scheme === "turns" ? 5349 : 3478));
  return {
    urls: `${scheme}:${hostname}:${port}${scheme === "turns" ? "?transport=tls" : ""}`,
    server: {
      hostname,
      port,
      username: m[2],
      password: m[3],
      relayType: scheme === "turns" ? "TurnTls" : "TurnUdp",
    },
  };
}
const TURN = parseTurn(RTC_CONFIG.turn);

function iceServerList() {
  const list = [...RTC_CONFIG.iceServers];
  if (TURN) list.push(TURN.server);
  return list;
}

/**
 * 为一个会话建立一条 DataChannel 通道（服务端做 offer 方）。
 * @param session 已鉴权的会话对象
 * @param wsSend  (obj) => void   通过 WebSocket 下发信令
 * @param onMessage (msgObj) => void  客户端经 DataChannel 发来的消息（只会有 car_state）
 * @returns link { open, send(str), close(), state() }
 */
export function createRtcLink(session, wsSend, onMessage) {
  if (!rtcAvailable) return null;

  const cfg = {
    iceServers: iceServerList(),
    portRangeBegin: RTC_CONFIG.portRangeBegin,
    portRangeEnd: RTC_CONFIG.portRangeEnd,
    maxMessageSize: RTC_CONFIG.maxMessageSize,
  };

  let pc = null;
  let dc = null;
  let open = false;
  let closed = false;
  const stats = { offered: false, opened: false, sentBytes: 0, sentPackets: 0, recvPackets: 0, dropped: 0, lastState: "new" };

  const fail = (why) => {
    stats.lastState = why;
    open = false;
  };

  try {
    pc = new ndc.PeerConnection(session.id, cfg);
  } catch (e) {
    console.warn("[rtc] PeerConnection 创建失败：", e.message);
    return null;
  }

  // 注意注册顺序：createDataChannel() 在部分版本里会**同步**触发 SDP 生成，
  // 监听必须先挂上，否则 onLocalDescription 永远等不到回调（表现为客户端收不到 offer）。
  pc.onStateChange((s) => {
    stats.lastState = s;
    if (s === "failed" || s === "closed" || s === "disconnected") open = false;
  });
  pc.onLocalDescription((sdp, type) => {
    if (stats.offered) return;
    stats.offered = true;
    wsSend({ t: "rtc_offer", sdp, type });
  });
  pc.onLocalCandidate((candidate, mid) => {
    wsSend({ t: "rtc_ice", candidate, mid });
  });

  // 位姿通道：无序 + 不重传（unordered / maxRetransmits:0）
  try {
    dc = pc.createDataChannel("state", { unordered: true, maxRetransmits: 0 });
  } catch (e) {
    console.warn("[rtc] DataChannel 创建失败：", e.message);
    try { pc.close(); } catch { /* ignore */ }
    return null;
  }

  dc.onOpen(() => {
    open = true;
    stats.opened = true;
    stats.lastState = "open";
    console.log(`[rtc] ${session.id} UDP 状态通道已建立（位姿改走 DataChannel）`);
  });
  dc.onClosed(() => {
    open = false;
    stats.lastState = "closed";
    console.log(`[rtc] ${session.id} UDP 状态通道关闭，自动回落 WebSocket`);
  });
  dc.onError((err) => {
    fail("error:" + err);
    console.warn(`[rtc] ${session.id} DataChannel 错误：${err}`);
  });
  dc.onMessage((raw) => {
    // 只接受状态类消息；其余一律丢弃 —— DataChannel 不作为控制通道，防止绕过 WS 鉴权
    let msg;
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8"));
    } catch {
      stats.dropped++;
      return;
    }
    if (!msg || msg.t !== "car_state") { stats.dropped++; return; }
    stats.recvPackets++;
    onMessage(msg);
  });

  pc.onStateChange((s) => {
    stats.lastState = s;
    if (s === "failed" || s === "closed" || s === "disconnected") open = false;
  });

  // 触发生成 offer
  try {
    pc.setLocalDescription("offer");
  } catch (e) {
    console.warn("[rtc] setLocalDescription 失败：", e.message);
    try { pc.close(); } catch { /* ignore */ }
    return null;
  }

  // 兜底：万一描述在回调注册前就已经生成好了，这里补发一次
  if (!stats.offered) {
    try {
      const local = typeof pc.localDescription === "function" ? pc.localDescription() : null;
      if (local && local.sdp) {
        stats.offered = true;
        wsSend({ t: "rtc_offer", sdp: local.sdp, type: local.type });
      }
    } catch { /* ignore */ }
  }
  console.log(`[rtc] ${session.id} 已下发 offer（offered=${stats.offered}），等待客户端 answer（ICE: ${iceServerList().join(",")}${TURN ? " + TURN" : ""}）`);

  const timer = setTimeout(() => {
    if (!open && !closed) fail("handshake-timeout");
  }, HANDSHAKE_TIMEOUT_MS);
  if (typeof timer.unref === "function") timer.unref();

  // 运维可见性：定期打印该会话走 UDP 的实际流量（sentPackets 为 0 说明一直在回落 WS）
  const report = setInterval(() => {
    if (!stats.sentPackets) return;
    console.log(`[rtc] ${session.id} UDP 下行 ${stats.sentPackets} 包 / ${(stats.sentBytes / 1024).toFixed(1)}KB` +
      ` · 上行 ${stats.recvPackets} 包（通道 ${stats.lastState}，丢弃 ${stats.dropped}）`);
  }, 15000);
  if (typeof report.unref === "function") report.unref();

  return {
    get open() { return open && !!dc && dc.isOpen(); },
    stats() { return { ...stats }; },

    /** 通过 DataChannel 下发一条已序列化的消息；返回是否真的走了 UDP */
    send(str) {
      if (!open || !dc || !dc.isOpen()) return false;
      try {
        const ok = dc.sendMessage(str);
        if (!ok) return false;
        stats.sentPackets++;
        stats.sentBytes += str.length;
        return true;
      } catch {
        open = false;
        return false;
      }
    },

    /** 客户端回信令 */
    handleAnswer(sdp) {
      try { pc.setRemoteDescription(String(sdp), "answer"); } catch (e) {
        console.warn("[rtc] setRemoteDescription(answer) 失败：", e.message);
      }
    },
    handleCandidate(candidate, mid) {
      if (!candidate) return;
      try { pc.addRemoteCandidate(String(candidate), String(mid ?? "0")); } catch { /* 候选过期，忽略 */ }
    },

    close() {
      closed = true;
      clearTimeout(timer);
      clearInterval(report);
      open = false;
      try { dc && dc.close(); } catch { /* ignore */ }
      try { pc && pc.close(); } catch { /* ignore */ }
    },
  };
}

export function rtcCleanup() {
  if (!ndc) return;
  try { ndc.cleanup(); } catch { /* ignore */ }
}

/**
 * 下发给客户端的 ICE 配置。
 * 注意：浏览器的 RTCIceServer 只接受 { urls, username?, credential? }，
 * 直接把 "stun:host:port" 这种字符串数组丢过去会被浏览器拒绝（会静默回落 WS）。
 */
export function rtcClientConfig() {
  if (!rtcAvailable) return null;
  const list = RTC_CONFIG.iceServers.map(u => ({ urls: u }));
  if (TURN) {
    list.push({
      urls: TURN.urls,
      ...(TURN.server.username ? { username: TURN.server.username, credential: TURN.server.password } : {}),
    });
  }
  return { iceServers: list };
}