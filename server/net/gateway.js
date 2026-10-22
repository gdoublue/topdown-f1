// WebSocket 网关：连接生命周期 / hello 鉴权 / 消息路由 / 心跳踢人
// 协议约定（v1, JSON 文本帧）：
//   C→S  { t: "hello", fingerprint, nickname }
//   C→S  { t: "room_create" | "room_join", roomId } | { t: "room_leave" }
//   C→S  { t: "room_set", carId?, ready?, sameCar? }   (房主可改 sameCar/trackId)
//   C→S  { t: "ping" }
//   S→C  { t: "welcome", ... } | { t: "room_update", ... } | { t: "error", code, msg }
import { WebSocketServer } from "ws";
import crypto from "node:crypto";
import { SERVER_CONFIG } from "../config.js";
import { registerPlayer, countRaceFinish } from "../core/session.js";
import { createRoom, joinRoom, leaveRoom, listRooms, handleDisconnect, findRoomOf, rooms as _rooms } from "../core/roomManager.js";
import { RaceSim } from "../core/sim.js";
import { createRtcLink, rtcAvailable, rtcClientConfig, rtcCleanup } from "./rtc.js";
import { submitLapRecord, getLeaderboardView } from "../services/leaderboard.js";
import { TRACKS } from "../../src/track/tracks.js";
import { AI_CONFIGS } from "../../src/game/ai.js";

const sessions = new Map();   // ws -> session

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

// 状态下行：优先走 WebRTC DataChannel（UDP，无序不重传），不可用时自动回落 WebSocket。
// 接受对象或已序列化的字符串：整房间同一份快照只序列化一次，两条链路都能用。
function sendSession(session, objOrStr) {
  const str = typeof objOrStr === "string" ? objOrStr : JSON.stringify(objOrStr);
  if (session.rtc && session.rtc.send(str)) return true;
  if (session.ws.readyState === 1) session.ws.send(str);
  return false;
}

function broadcastRoom(room, type, payload) {
  const msg = JSON.stringify({ t: type, ...payload });
  for (const m of room.members.values()) {
    if (m.session.ws.readyState === 1) m.session.ws.send(msg);
  }
}

// ================= 大厅推送：房间列表 / 在线人数 / 排行榜 =================
// 任何房间或成绩变化都把最新视图推给所有在线会话，客户端大厅无需重连即可即时刷新。
// 用 120ms 防抖合并同一批操作（例：开赛瞬间多名成员同时就绪）。
let lobbyTimer = null;

function flushLobby() {
  lobbyTimer = null;
  const msg = JSON.stringify({ t: "lobby", rooms: listRooms(), online: sessions.size });
  for (const s of sessions.values()) {
    if (s.ws.readyState === 1) s.ws.send(msg);
  }
}

export function broadcastLobby() {
  if (lobbyTimer) return;
  lobbyTimer = setTimeout(flushLobby, 120);
  lobbyTimer.unref?.();
}

// 某赛道榜单变化（房间比赛完赛 / 单人练习上传）→ 推送新榜单
export function broadcastBoards(trackId) {
  if (!trackId) return;
  const msg = JSON.stringify({
    t: "boards",
    trackId,
    entries: getLeaderboardView(trackId, { limit: 10 }),
  });
  for (const s of sessions.values()) {
    if (s.ws.readyState === 1) s.ws.send(msg);
  }
}

// 位姿下行合流（peer bundle）：
// 旧做法是"每收到一个 car_state 就立刻转发给房间里其他每个人"——8 人满员时
//   收 8×60 = 480 包/秒 → 发 8×7×60 = 3360 次/秒 的 DataChannel/WS 发送。
// 客户端本来就有 80~150ms 播放缓冲，"省掉这几毫秒中继等待"对画面毫无意义，
// 却让单线程 Node 承担 7 倍的 syscall / C++ addon 跨界开销。
// 现在改成：每 16ms 把房间内所有幽灵的最新位姿打成一个包广播一次（≈60 次/秒），
// 客户端收到后用与 peer_state 完全相同的路径入缓冲（样本时刻仍是发送端自报的 st）。
// flush 必须挂在 simLoop 的 8ms 驱动上、而不是 30Hz 物理 tick 里，
// 否则节拍被物理 tick 带成 30Hz，闸门永远放行也发不出 60Hz。
// 闸门取 15ms 而非 16ms：Windows 定时器若按 15.6ms 粒度派发，16ms 会整拍跳过、掉回 ~32Hz。
const PEER_FLUSH_MS = 15;

function flushPeerBundle(room, now) {
  if (!room._peersDirty) return;
  if (now - (room._peerFlushAt || 0) < PEER_FLUSH_MS) return;
  room._peerFlushAt = now;
  room._peersDirty = false;
  const sim = room.sim;
  if (!sim || sim.destroyed) return;
  const rows = [];
  for (const [sid, g] of sim.ghosts) {
    if (!g || g.gone || g.forfeited) continue;
    const c = g.car;
    rows.push([
      sid,
      Math.round((g.st || 0) * 100) / 100,
      Math.round(c.x * 100) / 100,
      Math.round(c.y * 100) / 100,
      Math.round(c.angle * 10000) / 10000,
      Math.round(c.speed * 10) / 10,
    ]);
  }
  if (!rows.length) return;
  const payload = JSON.stringify({ t: "peers_bundle", c: rows });
  for (const m of room.members.values()) {
    if (m.session.ws.readyState !== 1) continue;
    sendSession(m.session, payload);
  }
}

function attachHeartbeat(wss) {
  const timer = setInterval(() => {
    for (const [ws, s] of sessions) {
      if (ws.readyState !== 1) continue;
      if (Date.now() - s.lastSeen > SERVER_CONFIG.clientTimeoutMs) {
        ws.terminate();
        onClosed(s);
        continue;
      }
      ws.ping();
    }
  }, SERVER_CONFIG.heartbeatIntervalMs);
  wss.on("close", () => clearInterval(timer));
}

// ================= 权威模拟主循环 =================
// 8ms 高频驱动 + 累积器切出精确 30Hz 物理步，规避 setInterval/OS 定时器分辨率
// 造成的节奏抖动（Windows 定时器 ~15.6ms 量化，直接 33ms setInterval 会忽快忽慢）。
// 每个物理 tick 广播一包快照（30Hz），包小而节奏均匀，客户端插值不再枯竭。
let simAccum = 0, lastLoop = 0;
const SIM_DT = 1 / SERVER_CONFIG.simTickHz;

function simLoop() {
  const now = performance.now();
  if (!lastLoop) lastLoop = now;
  let elapsed = (now - lastLoop) / 1000;
  lastLoop = now;
  if (elapsed > 0.25) elapsed = 0.25;   // 事件循环卡顿兜底

  simAccum += elapsed;
  let steps = 0;
  while (simAccum >= SIM_DT && steps < 8) {
    simAccum -= SIM_DT;
    steps++;
    for (const room of _rooms.values()) {
      const sim = room.sim;
      if (!sim || sim.destroyed) continue;
      try {
        sim.tick(SIM_DT, now);
        // 房间状态跟随模拟器（倒计时结束 → racing），离开房间判定/大厅展示都依赖它
        if (sim.race.state === "racing" && room.state !== "racing") room.state = "racing";
        // 不足 2 名真人的比赛：真人全部冲线后，剩下的 AI 直接无渲染快进到终局，
        // 立刻广播结算，玩家不用再等 AI 跑完剩余圈数。
        if (!sim.ended && sim.race.state === "racing" && room.members.size < 2 && sim.humansAllDone()) {
          sim.fastForwardToEnd(now);
        }
        checkRaceEnd(room);
        if (sim.ended) continue;   // 终局后停止广播快照（避免空转占用带宽）
        // 每 tick 广播快照（幽灵模型：无需输入 ack）
        // 所有人收到的是同一份内容，只序列化一次：
        // 原来每个成员都 JSON.stringify 一遍（8 人房 = 每秒 240 次大对象序列化），
        // 而客户端从未读取过 `you` 字段（自车 id 来自 welcome 的 sid），直接省掉。
        const payload = JSON.stringify(sim.snapshot());
        for (const m of room.members.values()) {
          if (m.session.ws.readyState !== 1) continue;
          sendSession(m.session, payload);
        }
      } catch (e) {
        // 单房间异常只毁该房间，不拖垮整个服务进程
        console.error("[sim] room tick error, 房间已停赛:", e);
        room.sim = null;
        room.state = "lobby";
        broadcastRoom(room, "error", { code: "race_crashed", msg: e.message });
        broadcastLobby();
      }
    }
  }

  // 位姿下行合流与 30Hz 物理 tick 解耦：8ms 驱动每拍检查一次，由 PEER_FLUSH_MS 限频到 ~60Hz。
  // 挂在 tick 里会被物理节拍带成 30Hz，60Hz 上报的样本有一半会在下一次合包前被覆盖。
  for (const room of _rooms.values()) {
    if (!room.sim || room.sim.destroyed) continue;
    try {
      flushPeerBundle(room, now);
    } catch (e) {
      console.error("[sim] peer bundle error:", e);
    }
  }
}

function checkRaceEnd(room) {
  const sim = room.sim;
  if (!sim.ended || sim.endBroadcast) return;
  sim.endBroadcast = true;
  room.state = "finished";

  const results = sim.results();
  // 完赛成绩入排行榜（幽灵模型下人类成绩经 reportFinish 合理性校验）
  for (const r of results) {
    if (!r.sessionId || r.forfeited) continue;
    const member = room.members.get(r.sessionId);
    if (!member) continue;
    const playerId = member.session.player?.id;
    if (!playerId) continue;
    if (r.finished && r.valid && r.bestLapMs > 0) {
      submitLapRecord({
        playerId, trackId: room.trackId, carId: r.carId || member.carId || "unknown",
        bestLapMs: r.bestLapMs, totalMs: r.totalMs, laps: r.laps || 1,
        source: "online_race",
      });
    }
    // 成绩未通过合理性校验的名次不算胜场
    countRaceFinish(playerId, r.rank === 1 && !!r.valid);
  }

  broadcastRoom(room, "race_end", { results });

  // 终局收尾：房间回到"等待中"（可再次开赛），释放模拟器，刷新所有人的大厅视图
  room.state = "lobby";
  room.sim = null;
  broadcastBoards(room.trackId);
  broadcastLobby();
}

let simLoopStarted = false;
function ensureSimLoop() {
  if (simLoopStarted) return;
  simLoopStarted = true;
  // 8ms 高频驱动：累积器内部切精确 30Hz 步，吸收 OS 定时器抖动
  setInterval(simLoop, 8);
}

function onClosed(session) {
  session.rtc?.close();
  session.rtc = null;
  const res = handleDisconnect(session, broadcastRoom);
  sessions.delete(session.ws);
  // 比赛中掉线/退出：只把这台车移出比赛（判负），其余车手照常完赛
  if (res && !res.destroyed && res.room.sim && !res.room.sim.ended) {
    const alreadyOut = res.room.sim.hasForfeited(session.id);
    res.room.sim.retirePlayer(session.id);
    if (!alreadyOut) {
      broadcastRoom(res.room, "player_forfeit", {
        sid: session.id,
        nickname: session.player?.nickname || "Player",
      });
    }
    checkRaceEnd(res.room);
  }
  broadcastLobby();
}

export function attachGateway(httpServer) {
  const wss = new WebSocketServer({ server: httpServer, path: SERVER_CONFIG.wsPath });

  wss.on("connection", (ws) => {
    const session = { id: "sid_" + crypto.randomBytes(8).toString("hex"), ws, player: null, lastSeen: Date.now() };
    sessions.set(ws, session);
    ws.isAlive = true;
    ws.on("pong", () => { session.lastSeen = Date.now(); });

    ws.on("message", (raw) => {
      session.lastSeen = Date.now();
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      try { route(session, msg); } catch (e) {
        send(ws, { t: "error", code: "server_error", msg: e.message });
      }
    });

    ws.on("close", () => onClosed(session));
    ws.on("error", () => {});
  });

  attachHeartbeat(wss);
  return wss;
}

function route(session, msg) {
  const ws = session.ws;
  switch (msg.t) {
    case "hello": {
      const { player, created } = registerPlayer(msg.fingerprint, msg.nickname);
      session.player = player;
      send(ws, {
        t: "welcome",
        playerId: player.id,
        sid: session.id,
        online: sessions.size,
        nickname: player.nickname,
        isNew: created,
        protocol: 1,
        tracks: TRACKS.map(t => ({ id: t.id, name: t.name, flag: t.flag, length: t.length, laps: t.laps || null })),
        rtc: rtcClientConfig(),
        leaderboards: Object.fromEntries(
          TRACKS.map(t => [t.id, getLeaderboardView(t.id, { limit: 10 })])
        ),
        rooms: listRooms(),
      });
      broadcastLobby();   // 在线人数变化 → 其他人的大厅同步刷新
            // 建 WebRTC DataChannel（UDP）：信令走 WS，数据通道建好后快照/位姿自动改走 UDP。
            // 建不起来也只是回落 WebSocket，不影响任何功能。
            if (rtcAvailable) {
              session.rtc = createRtcLink(
                session,
                (o) => send(ws, o),
                (m) => { session.lastSeen = Date.now(); route(session, m); },
              );
            }
            break;
    }

    case "room_create": {
      if (!session.player) return send(ws, { t: "error", code: "not_authed" });
      const res = createRoom(session, { trackId: msg.trackId, sameCar: msg.sameCar, fillAI: msg.fillAI });
      if (!res.ok) return send(ws, { t: "error", code: res.reason });
      send(ws, { t: "room_update", room: res.room.view() });
      broadcastLobby();
      break;
    }

    case "room_join": {
      if (!session.player) return send(ws, { t: "error", code: "not_authed" });
      const res = joinRoom(session, msg.roomId);
      if (!res.ok) return send(ws, { t: "error", code: res.reason });
      broadcastRoom(res.room, "room_update", { room: res.room.view() });
      broadcastLobby();
      break;
    }

    case "surrender": {
      // 比赛认输：只退出当前这一场，房间成员身份保留（客户端回到房间等待本场结束）。
      // 真正离开房间请走 room_leave。
      if (!session.player) return;
      const room = findRoomOf(session.id);
      if (!room) return;
      if (room.sim && !room.sim.ended) {
        const humanCount = room.members.size;
        const alreadyOut = room.sim.hasForfeited(session.id);
        room.sim.retirePlayer(session.id);
        if (humanCount > 1 && !alreadyOut) {
          broadcastRoom(room, "player_forfeit", {
            sid: session.id,
            nickname: session.player?.nickname || "Player",
          });
        }
        checkRaceEnd(room);
      }
      // 认输后回到房间不自动准备：是否参加下一局由玩家自己决定
      const member = room.members.get(session.id);
      if (member && session.id !== room.hostId) member.ready = false;
      // 同步房间视图（成员仍在房间里），让客户端立即切换到等待界面
      send(ws, { t: "room_update", room: room.view() });
      broadcastLobby();
      break;
    }

    case "room_leave": {
      if (!session.player) return;
      const room = findRoomOf(session.id);
      if (room) {
        if (room.sim && !room.sim.ended) {
          // 比赛进行中离开房间：只把这台车移出比赛（判负），其他人的比赛完全不受影响。
          // 已认输过的车不再重复广播，避免其他玩家收到两次"认输"提示。
          const humanCount = room.members.size;
          const alreadyOut = room.sim.hasForfeited(session.id);
          room.sim.retirePlayer(session.id);
          if (humanCount > 1 && !alreadyOut) {
            broadcastRoom(room, "player_forfeit", {
              sid: session.id,
              nickname: session.player?.nickname || "Player",
            });
          }
          checkRaceEnd(room);
        }
        const res = leaveRoom(session, room.id);
        send(ws, { t: "room_leave_ok" });
        if (res.ok && !res.destroyed) broadcastRoom(res.room, "room_update", { room: res.room.view() });
      } else {
        send(ws, { t: "room_leave_ok" });
      }
      broadcastLobby();
      break;
    }

    case "room_set": {
      if (!session.player) return send(ws, { t: "error", code: "not_authed" });
      const room = findRoomOf(session.id);
      if (!room) return send(ws, { t: "error", code: "not_in_room" });
      const patch = {};
      if (msg.carId !== undefined && msg.carId !== null) {
        const cid = String(msg.carId).slice(0, 32);
        patch.carId = (cid && cid !== "null") ? cid : null;   // 防 "null" 字符串污染选车状态
      }
      if (msg.ready !== undefined) patch.ready = !!msg.ready;
      if (msg.scriptId !== undefined) patch.scriptId = String(msg.scriptId).slice(0, 48);
      room.setMember(session.id, patch);
      // 房主专属：改规则
      if (session.id === room.hostId) {
        if (msg.sameCar !== undefined) room.sameCar = !!msg.sameCar;
        if (msg.fillAI !== undefined) room.fillAI = !!msg.fillAI;   // 是否需要 AI 补位车
        if (msg.trackId) room.trackId = String(msg.trackId).slice(0, 32);
      }
      broadcastRoom(room, "room_update", { room: room.view() });
      if (msg.trackId !== undefined || msg.fillAI !== undefined) broadcastLobby();
      break;
    }

    case "rtc_answer": {
      // DataChannel 信令：客户端回传的 answer / 后续 trickle candidate
      session.rtc?.handleAnswer(msg.sdp);
      break;
    }

    case "rtc_ice": {
      session.rtc?.handleCandidate(msg.candidate, msg.mid);
      break;
    }

    case "car_state": {
      // 高频消息（30~60Hz）：玩家本地模拟状态上报 → 中继展示
      const room = findRoomOf(session.id);
      if (room?.sim && !room.sim.destroyed) {
        room.sim.setPlayerState(session.id, msg, performance.now());
        // 只打脏标记：由 simLoop 的 8ms 驱动按 16ms 闸门合包广播（见 flushPeerBundle）。
        room._peersDirty = true;
      }
      break;
    }

    case "race_finish": {
      // 玩家本地完赛上报：服务器校验合理性后计入排名与排行榜
      const room = findRoomOf(session.id);
      if (room?.sim && !room.sim.destroyed) {
        room.sim.reportFinish(session.id, msg);
      }
      break;
    }

    case "room_start": {
      if (!session.player) return send(ws, { t: "error", code: "not_authed" });
      const room = findRoomOf(session.id);
      if (!room) return send(ws, { t: "error", code: "not_in_room" });
      if (session.id !== room.hostId) return send(ws, { t: "error", code: "not_host" });
      if (room.state === "racing" || room.state === "countdown") {
        return send(ws, { t: "error", code: "already_racing" });
      }
      // 校验：所有成员已选车；除房主外都必须"准备就绪"（房主随时可开赛）
      const members = [...room.members.values()];
      // 自愈：房主的就绪位可能被旧客户端/异常状态弄脏，开赛前无条件纠正
      const hostMember = room.members.get(room.hostId);
      if (hostMember && !hostMember.ready) hostMember.ready = true;
      if (!members.every(m => m.carId && (m.ready || m.session.id === room.hostId))) {
        const stuck = members
          .filter(m => !(m.carId && (m.ready || m.session.id === room.hostId)))
          .map(m => m.session.player?.nickname || "车手");
        return send(ws, { t: "error", code: "not_all_ready", msg: stuck.join("、") + " 未选车/未就绪" });
      }
      try {
        if (msg.laps) room.laps = Math.max(1, Math.min(50, Math.round(Number(msg.laps))));
        const humans = members.map(m => ({
          sid: m.session.id,
          nickname: m.session.player?.nickname || "Pilot",
          carId: m.carId,
        }));
        room.sim = new RaceSim(room, humans);
        room.state = "countdown";
        ensureSimLoop();
        // 参赛名单顺序 = 客户端发车格顺序（人类在前、AI 补位在后）
        const carInfo = (carId, nickname, fallback) => {
          const cfg = AI_CONFIGS.find(c => c.id === carId) || AI_CONFIGS[0];
          return {
            id: fallback,
            nickname,
            shortName: cfg.shortName,
            color: cfg.color,
            number: cfg.number,
          };
        };
        broadcastRoom(room, "race_start", {
          trackId: room.trackId,
          laps: room.sim.maxLaps,
          sameCar: room.sameCar,
          cars: [
            ...humans.map(h => carInfo(h.carId, h.nickname, h.sid)),
            ...room.sim.aiEntries.map(e => ({
              id: "ai:" + e.car.algorithm,
              nickname: e.car.nickname,
              shortName: e.car.shortName,
              color: e.car.color,
              number: e.car.number,
            })),
          ],
        });
        broadcastLobby();   // 房间状态变为比赛中 → 大厅列表即时刷新
      } catch (e) {
        room.sim = null;
        send(ws, { t: "error", code: "start_failed", msg: e.message });
      }
      break;
    }

    case "ping":
      send(ws, { t: "pong", now: Date.now() });
      break;

    default:
      send(ws, { t: "error", code: "unknown_type", msg: msg.t });
  }
}
