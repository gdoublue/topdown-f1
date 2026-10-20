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
import { submitLapRecord, getLeaderboardView } from "../services/leaderboard.js";
import { TRACKS } from "../../src/track/tracks.js";
import { AI_CONFIGS } from "../../src/game/ai.js";

const sessions = new Map();   // ws -> session

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
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
        const snap = sim.snapshot();
        for (const m of room.members.values()) {
          if (m.session.ws.readyState !== 1) continue;
          m.session.ws.send(JSON.stringify({ ...snap, you: m.session.id }));
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
        playerId, trackId: room.trackId, carId: member.carId || "unknown",
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
  const res = handleDisconnect(session, broadcastRoom);
  sessions.delete(session.ws);
  // 比赛中掉线/退出：只把这台车移出比赛（判负），其余车手照常完赛
  if (res && !res.destroyed && res.room.sim && !res.room.sim.ended) {
    res.room.sim.retirePlayer(session.id);
    broadcastRoom(res.room, "player_forfeit", {
      sid: session.id,
      nickname: session.player?.nickname || "Player",
    });
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
        leaderboards: Object.fromEntries(
          TRACKS.map(t => [t.id, getLeaderboardView(t.id, { limit: 10 })])
        ),
        rooms: listRooms(),
      });
      broadcastLobby();   // 在线人数变化 → 其他人的大厅同步刷新
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

    case "surrender":
    case "room_leave": {
      if (!session.player) return;
      const room = findRoomOf(session.id);
      if (room) {
        if (room.sim && !room.sim.ended) {
          // 比赛进行中退出：只把这台车移出比赛（判负），其他人的比赛完全不受影响
          const humanCount = room.members.size;
          room.sim.retirePlayer(session.id);
          if (humanCount > 1) {
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
      if (msg.carId !== undefined) patch.carId = String(msg.carId).slice(0, 32);
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

    case "car_state": {
      // 高频消息（~30Hz）：玩家本地模拟状态上报 → 中继展示
      const room = findRoomOf(session.id);
      if (room?.sim && !room.sim.destroyed) {
        room.sim.setPlayerState(session.id, msg, performance.now());
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
      // 校验：所有成员已选车并就绪
      const members = [...room.members.values()];
      if (!members.every(m => m.carId && m.ready)) {
        return send(ws, { t: "error", code: "not_all_ready" });
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
