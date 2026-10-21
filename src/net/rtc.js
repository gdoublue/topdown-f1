// 客户端 WebRTC DataChannel（UDP）状态通道
//
// 与 server/net/rtc.js 配对：
//   · 信令（offer/answer/candidate）走 WebSocket —— 低频、必须可靠
//   · snapshot / peer_state（下行）与 car_state（上行）走 DataChannel —— 高频、可丢
//   · 任何一步失败都静默回落 WebSocket；上层（netrace）完全不感知传输层
//
// 传输层的意义：TCP 下一个包迟到会把后面所有包一起堵住（队头阻塞），
// 实测"1% 概率单包延迟 180ms"就能让远端车出现 2.58 倍速度的弹跳。
// DataChannel 用 unordered + 不重传，晚到的旧坐标直接丢掉，下一包 16ms 后就到了。

let pc = null;
let dc = null;
let open = false;
let started = false;
let sendSignal = null;      // (obj) => void  通过 WebSocket 发信令
let onMessage = null;       // (msgObj) => void
let state = "idle";         // idle | waiting-offer | connecting | open | failed | closed
let closedByUs = false;

const HANDSHAKE_TIMEOUT_MS = 12000;

export const rtc = {
  get state() { return state; },
  get open() { return open; },
  get transport() { return open ? "udp" : "websocket"; },

  /**
   * @param iceServers 服务端下发的 STUN/TURN 列表
   * @param sendSignal 通过 WebSocket 发送信令
   * @param onMessage  收到 DataChannel 消息（已解析的对象）
   */
  start({ iceServers, sendSignal: send, onMessage: recv }) {
    if (started) return;
    if (typeof RTCPeerConnection === "undefined") { state = "unsupported"; return; }
    started = true;
    closedByUs = false;
    sendSignal = send;
    onMessage = recv;
    state = "waiting-offer";

    try {
      pc = new RTCPeerConnection({ iceServers: iceServers || [] });
    } catch (e) {
      console.warn("[rtc] RTCPeerConnection 创建失败，回落 WebSocket：", e.message);
      rtc.fail();
      return;
    }

    // 数据通道由服务端创建，浏览器这边通过 ondatachannel 接
    pc.ondatachannel = (e) => {
      const ch = e.channel;
      dc = ch;
      ch.onopen = () => { open = true; state = "open"; };
      ch.onclose = () => { open = false; if (state === "open") state = "closed"; };
      ch.onmessage = (ev) => {
        try { onMessage(JSON.parse(ev.data)); } catch { /* 坏包直接丢 */ }
      };
    };

    pc.onicecandidate = (e) => {
      if (!e.candidate) return;
      sendSignal({ t: "rtc_ice", candidate: e.candidate.toJSON ? e.candidate.toJSON() : e.candidate.candidate, mid: e.candidate.sdpMid });
    };

    pc.onconnectionstatechange = () => {
      if (!pc) return;
      const s = pc.connectionState;
      if (s === "failed") { rtc.fail(); }
      else if (s === "disconnected") {
        // 短暂抖动：不再相信它能用了（trySend 会自动回落 WebSocket），但不主动销毁
        open = false;
        state = "disconnected";
      } else if (s === "connected" && !open) {
        state = "connecting";
      }
    };

    // 建链超时：不等了，继续用 WebSocket（对玩家完全无感）
    setTimeout(() => { if (!open && !closedByUs) rtc.fail(); }, HANDSHAKE_TIMEOUT_MS);
  },

  /** 处理服务端下发的 offer，并回 answer */
  async handleOffer(sdp) {
    if (!pc || typeof sdp !== "string") return;
    try {
      state = "connecting";
      await pc.setRemoteDescription({ type: "offer", sdp });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      sendSignal({ t: "rtc_answer", sdp: answer.sdp });
    } catch (e) {
      console.warn("[rtc] offer/answer 失败，回落 WebSocket：", e.message);
      rtc.fail();
    }
  },

  /** 处理服务端 trickle candidate */
  async handleIce(msg) {
    if (!pc || !msg || !msg.candidate) return;
    try {
      await pc.addIceCandidate(msg.mid != null ? { candidate: msg.candidate, sdpMid: String(msg.mid) } : msg);
    } catch { /* 过期候选，忽略 */ }
  },

  /** 尝试通过 DataChannel 发送；返回 false 表示"没走成，调用方请回落到 WebSocket" */
  trySend(obj) {
    if (!open || !dc || dc.readyState !== "open") return false;
    try {
      dc.send(JSON.stringify(obj));
      return true;
    } catch {
      open = false;
      return false;
    }
  },

  /** 部署排查用：连接/ICE 状态快照 */
  debugInfo() {
    return {
      state,
      open,
      conn: pc ? pc.connectionState : "none",
      ice: pc ? pc.iceConnectionState : "none",
      gathering: pc ? pc.iceGatheringState : "none",
      dc: dc ? dc.readyState : "none",
    };
  },

  fail() {
    open = false;
    state = "failed";
    rtc.stop();
  },

  stop() {
    closedByUs = true;
    open = false;
    try { dc && dc.close(); } catch { /* ignore */ }
    try { pc && pc.close(); } catch { /* ignore */ }
    dc = null; pc = null; started = false; state = "closed";
  },
};