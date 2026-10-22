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

// 圈数：0 = 跟随赛道默认；1~50 为房主指定
function clampLaps(v) {
  const n = Math.round(Number(v) || 0);
  return n <= 0 ? 0 : Math.max(1, Math.min(50, n));
}

// 聊天记录：全局一份、每个房间一份，各保留最近 10 条，新连上/刚进房时补发
const CHAT_HISTORY_MAX = 10;
const globalChatHistory = [];

function rememberChat(bucket, entry) {
  bucket.push(entry);
  while (bucket.length > CHAT_HISTORY_MAX) bucket.shift();
}

function sendRoomHistory(ws, room) {
  send(ws, { t: "chat_history", scope: "room", items: room.chatHistory || [] });
}

// ================= 观赛（比赛中进房的玩家） =================
// 观赛者不占发车位、不参加本场比赛，但和普通成员一样收房间视图 / 聊天 / 快照，
// 因此直接留在 room.members 里带 spectating 标记（见 core/room.js）。

// 房间内的系统提示：谁加入观赛 / 谁离开观赛（走聊天频道，客户端按 sys 样式渲染）
function announceWatch(room, session, joined) {
  const nickname = session?.player?.nickname || "车手";
  const left = room.spectatorCount();
  const text = joined
    ? `👀 ${nickname} 加入观赛（当前 ${left} 人观战）`
    : `🚪 ${nickname} 离开观赛${left > 0 ? `（剩余 ${left} 人观战）` : ""}`;
  const entry = {
    scope: "room",
    sys: true,
    from: { sid: "system", nickname: "观赛" },
    text,
    ts: Date.now(),
  };
  rememberChat(room.chatHistory, entry);
  broadcastRoom(room, "chat", entry);
}

// 参赛名单（= race_start 载荷）：开赛时广播给全员，比赛中进房的观赛者也要补发一份，
// 否则客户端拿不到车辆列表，画面上什么都没有。
function raceStartPayload(room, spectate = false) {
  const sim = room.sim;
  const rows = [];
  for (const g of sim.ghosts.values()) {
    if (g.gone) continue;
    const cfg = AI_CONFIGS.find(c => c.id === g.carId) || AI_CONFIGS[0];
    rows.push({ id: g.sid, nickname: g.nickname, shortName: cfg.shortName, color: cfg.color, number: cfg.number });
  }
  for (const e of sim.aiEntries) {
    rows.push({
      id: "ai:" + e.car.algorithm,
      nickname: e.car.nickname,
      shortName: e.car.shortName,
      color: e.car.color,
      number: e.car.number,
    });
  }
  return {
    trackId: room.trackId,
    laps: sim.maxLaps,
    sameCar: room.sameCar,
    spectate: !!spectate,
    cars: rows,
  };
}

// ================= 开赛核心（房主手动开赛 / AFK 自动开赛共用） =================
// 返回 { ok } 或 { ok:false, code, msg }，由调用方决定是回 error 还是只记日志。
function startRaceCore(room, lapsOpt) {
  if (room.state === "racing" || room.state === "countdown") return { ok: false, code: "already_racing" };
  // 校验：观赛者不参与（不在参赛名单里，也不该挡住开赛）；
  //      参赛车手必须已选车，除房主外都必须"准备就绪"（房主随时可开赛）
  const members = room.racers();
  if (!members.length) return { ok: false, code: "not_all_ready", msg: "房间里还没有参赛车手" };
  // 自愈：房主的就绪位可能被旧客户端/异常状态弄脏，开赛前无条件纠正
  const hostMember = room.members.get(room.hostId);
  if (hostMember && !hostMember.spectating && !hostMember.ready) hostMember.ready = true;
  if (!members.every(m => m.carId && (m.ready || m.session.id === room.hostId))) {
    const stuck = members
      .filter(m => !(m.carId && (m.ready || m.session.id === room.hostId)))
      .map(m => m.session.player?.nickname || "车手");
    return { ok: false, code: "not_all_ready", msg: stuck.join("、") + " 未选车/未就绪" };
  }
  try {
    // 圈数：客户端显式传了就用它，否则沿用房间设置（0 → 赛道默认）
    room.laps = clampLaps(lapsOpt !== undefined ? lapsOpt : room.laps);
    const humans = members.map(m => ({
      sid: m.session.id,
      nickname: m.session.player?.nickname || "Pilot",
      carId: m.carId,
    }));
    room.sim = new RaceSim(room, humans);
    room.state = "countdown";
    room.autoStartAt = 0;          // 已经开了：自动开赛倒计时作废
    ensureSimLoop();
    // 参赛名单顺序 = 客户端发车格顺序（人类在前、AI 补位在后）
    broadcastRoom(room, "race_start", raceStartPayload(room, false));
    broadcastLobby();   // 房间状态变为比赛中 → 大厅列表即时刷新
    return { ok: true };
  } catch (e) {
    room.sim = null;
    room.state = "lobby";
    return { ok: false, code: "start_failed", msg: e.message };
  }
}

// ================= 房间自动化（AFK 兜底） =================
//  · 非房主 15 秒不准备 → 自动就绪（并且自动补一台空闲车，否则照样挡住开赛）
//  · 全员就绪 5 秒房主还没点"开始" → 自动开赛
// 用统一的 1s 维护节拍判定，而不是给每个成员各挂一个定时器：
// 成员离开 / 房间销毁时不会有悬空定时器，重复广播也不会出现。
const AUTO_READY_MS = 15000;
const AUTO_START_MS = 5000;
// 一场比赛刚结束时先静默一段（客户端结算大屏 30s 后自动回房间）：
// 否则玩家还在看成绩，下一局就被自动开起来。
const AUTO_HOLD_AFTER_RACE_MS = 30000;
let roomLoopStarted = false;

function ensureRoomLoop() {
  if (roomLoopStarted) return;
  roomLoopStarted = true;
  const timer = setInterval(maintainRooms, 1000);
  timer.unref?.();
}

// 自动就绪时给一台还没人用的车（服务端不知道客户端下拉默认选了哪台）
function pickIdleCar(room) {
  const used = new Set(room.racers().map(m => m.carId).filter(Boolean));
  return (AI_CONFIGS.find(c => !used.has(c.id)) || AI_CONFIGS[0]).id;
}

function autoReadyMember(room, member) {
  if (!member.carId) member.carId = pickIdleCar(room);
  member.ready = true;
  member.notReadySince = 0;
  broadcastRoom(room, "room_update", { room: room.view() });
  broadcastLobby();
  console.log(`[room] ${room.id} 15 秒未准备 → 自动就绪：${member.session.player?.nickname || "车手"}`);
}

function maintainRooms() {
  const now = Date.now();
  for (const room of _rooms.values()) {
    if (room.state !== "lobby") continue;
    if (now < (room.autoHoldUntil || 0)) continue;   // 结算静默期
    // 1) 非房主车手 15 秒不准备 → 自动就绪
    for (const m of room.members.values()) {
      if (m.ready || m.spectating || m.session.id === room.hostId) { m.notReadySince = 0; continue; }
      if (!m.notReadySince) m.notReadySince = now;
      else if (now - m.notReadySince >= AUTO_READY_MS) autoReadyMember(room, m);
    }
    // 2) 全员就绪 5 秒 → 房主还没点就开始
    if (room.isEveryoneReady()) {
      if (!room.autoStartAt) {
        room.autoStartAt = now + AUTO_START_MS;
        broadcastRoom(room, "room_update", { room: room.view() });   // 客户端显示"5 秒后自动开始"
      } else if (now >= room.autoStartAt) {
        room.autoStartAt = 0;
        const res = startRaceCore(room);
        if (!res.ok) {
          console.warn("[room] 自动开赛失败:", res.code, res.msg || "");
          room.autoStartAt = now + AUTO_START_MS;   // 5 秒后重试，不刷屏
        }
      }
    } else if (room.autoStartAt) {
      room.autoStartAt = 0;   // 有人取消了就绪：倒计时作废
      broadcastRoom(room, "room_update", { room: room.view() });
    }
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
        // 用 racerCount 而不是 members.size：观赛者不是参赛车，不能把"单人局"算成双人局。
        if (!sim.ended && sim.race.state === "racing" && room.racerCount() < 2 && sim.humansAllDone()) {
          sim.fastForwardToEnd(now);
        }
        checkRaceEnd(room);
        if (sim.ended) continue;   // 终局后停止广播快照（避免空转占用带宽）
        // 每 tick 广播快照（幽灵模型：无需输入 ack）
        // 所有人收到的是同一份内容，只序列化一次：
        // 原来每个成员都 JSON.stringify 一遍（8 人房 = 每秒 240 次大对象序列化），
        // 而客户端从未读取过 `you` 字段（自车 id 来自 welcome 的 sid），直接省掉。
        const payload = JSON.stringify(sim.snapshot(now));
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
  // 下一局重新确认就绪：否则"全员就绪 + 5s 自动开赛"会在结算大屏期间直接开下一局。
  // 房主照旧免就绪，并给结算大屏留出静默期（客户端的 30s 自动返回房间）。
  room.autoStartAt = 0;
  room.autoHoldUntil = Date.now() + AUTO_HOLD_AFTER_RACE_MS;
  for (const m of room.members.values()) {
    m.ready = m.session.id === room.hostId && !m.spectating;
    m.notReadySince = 0;
  }
  broadcastRoom(room, "room_update", { room: room.view() });
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
  // 观赛者掉线：房间里的"离开观赛"提示同样要发（他没有车，不需要判负）
  if (res && !res.destroyed && res.wasSpectating) announceWatch(res.room, session, false);
  // 比赛中掉线/退出：只把这台车移出比赛（判负），其余车手照常完赛
  if (res && !res.destroyed && res.room.sim && !res.room.sim.ended) {
    const ghost = res.room.sim.ghosts.get(session.id);
    if (ghost && !ghost.gone) {
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
  ensureRoomLoop();   // 房间自动化：15s 自动就绪 / 全员就绪 5s 自动开赛
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
      // 刚连上：补发最近的全局聊天记录（含发送时间）
      send(ws, { t: "chat_history", scope: "global", items: globalChatHistory });
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
      sendRoomHistory(ws, res.room);
      broadcastLobby();
      break;
    }

    case "room_join": {
      if (!session.player) return send(ws, { t: "error", code: "not_authed" });
      const res = joinRoom(session, msg.roomId, { spectate: msg.spectate === true });
      if (!res.ok) return send(ws, { t: "error", code: res.reason });
      broadcastRoom(res.room, "room_update", { room: res.room.view() });
      sendRoomHistory(ws, res.room);   // 刚进房：补发房间最近聊天
      if (res.spectating) {
        // 比赛进行中进房 = 观赛：通知房间"谁进来看了"，
        // 并把本局的参赛名单补发给这个客户端（它错过了 race_start），才能立刻渲染实时画面
        announceWatch(res.room, session, true);
        if (res.room.sim && !res.room.sim.destroyed) {
          send(ws, { t: "race_start", ...raceStartPayload(res.room, true) });
        }
      }
      broadcastLobby();
      break;
    }

    // 进入 / 退出观赛（比赛进行中才有效）：
    //   on=true  → 观测视角（不占发车位，不参加本场比赛）
    //   on=false → 回到普通成员身份，可以选车准备下一局
    case "room_spectate": {
      if (!session.player) return send(ws, { t: "error", code: "not_authed" });
      const room = findRoomOf(session.id);
      if (!room) return send(ws, { t: "error", code: "not_in_room" });
      const member = room.members.get(session.id);
      if (!member) return send(ws, { t: "error", code: "not_in_room" });
      if (msg.on !== false) {
        if (!member.spectating && !room.isRacing()) {
          return send(ws, { t: "error", code: "not_racing" });
        }
        if (!member.spectating) {
          // 正在跑的车手转观赛 = 放弃本场比赛（判负），房间成员身份保留
          const ghost = room.sim?.ghosts.get(session.id);
          if (room.sim && !room.sim.ended && ghost && !ghost.gone) {
            const humanCount = room.racerCount();
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
          room.setSpectating(session.id, true);
          broadcastRoom(room, "room_update", { room: room.view() });
          announceWatch(room, session, true);
        }
        // 已经在观赛：只补发名单（重连 / 重新进入观赛画面都走这里）
        if (room.sim && !room.sim.destroyed) {
          send(ws, { t: "race_start", ...raceStartPayload(room, true) });
        }
        broadcastLobby();
        break;
      }
      if (!member.spectating) return send(ws, { t: "room_update", room: room.view() });
      room.setSpectating(session.id, false);
      broadcastRoom(room, "room_update", { room: room.view() });
      announceWatch(room, session, false);
      broadcastLobby();
      break;
    }

    case "surrender": {
      // 比赛认输：只退出当前这一场，房间成员身份保留（客户端回到房间等待本场结束）。
      // 真正离开房间请走 room_leave。
      if (!session.player) return;
      const room = findRoomOf(session.id);
      if (!room) return;
      // 观赛者不在参赛名单里：认输消息不能为一个"不存在的车"广播出去
      const ghost = room.sim?.ghosts.get(session.id);
      if (room.sim && !room.sim.ended && ghost && !ghost.gone) {
        const humanCount = room.racerCount();
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
        const ghost = room.sim?.ghosts.get(session.id);
        if (room.sim && !room.sim.ended && ghost && !ghost.gone) {
          // 比赛进行中离开房间：只把这台车移出比赛（判负），其他人的比赛完全不受影响。
          // 已认输过的车不再重复广播，避免其他玩家收到两次"认输"提示。
          // 观赛者没有车在赛道上 → 整段跳过（不产生假认输提示）。
          const humanCount = room.racerCount();
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
        if (res.ok && !res.destroyed) {
          if (res.wasSpectating) announceWatch(res.room, session, false);
          broadcastRoom(res.room, "room_update", { room: res.room.view() });
        }
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
        // 圈数也进房间状态：非房主要能提前看到房主的设定（不只是开赛时才知道）
        if (msg.laps !== undefined) room.laps = clampLaps(msg.laps);
      }
      broadcastRoom(room, "room_update", { room: room.view() });
      if (msg.trackId !== undefined || msg.fillAI !== undefined || msg.laps !== undefined) broadcastLobby();
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
      const res = startRaceCore(room, msg.laps);
      if (!res.ok) return send(ws, { t: "error", code: res.code, msg: res.msg });
      break;
    }

    // 聊天：scope=global 广播给所有在线会话；scope=room 只发给同房间成员。
    // 大厅里的客户端只能发 global，房间/比赛中可以二选一。
    case "chat": {
      if (!session.player) return send(ws, { t: "error", code: "not_authed" });
      const text = String(msg.text || "").replace(/\s+/g, " ").trim().slice(0, 120);
      if (!text) return;
      const now = Date.now();
      // 限流：最多 2 条/秒。超频不静默丢弃，回一条提示让客户端告诉玩家
      if (now - (session.lastChatAt || 0) < 500) return send(ws, { t: "chat_slow" });
      session.lastChatAt = now;
      const from = { sid: session.id, nickname: session.player?.nickname || "车手" };
      if (msg.scope === "room") {
        const room = findRoomOf(session.id);
        if (!room) return send(ws, { t: "error", code: "not_in_room" });
        const entry = { scope: "room", from, text, ts: now };
        rememberChat(room.chatHistory, entry);
        broadcastRoom(room, "chat", entry);
      } else {
        const entry = { scope: "global", from, text, ts: now };
        rememberChat(globalChatHistory, entry);
        const payload = JSON.stringify({ t: "chat", ...entry });
        for (const s of sessions.values()) {
          if (s.ws.readyState === 1) s.ws.send(payload);
        }
      }
      break;
    }

    // 客户端主动要历史：切换「全局 / 房间」频道、面板重新显示时补齐最近记录
    case "chat_history_req": {
      if (!session.player) return send(ws, { t: "error", code: "not_authed" });
      if (msg.scope === "room") {
        const room = findRoomOf(session.id);
        // 不在房间就给空历史（不要走 error，否则客户端会弹一条红色提示条）
        if (!room) return send(ws, { t: "chat_history", scope: "room", items: [] });
        return sendRoomHistory(ws, room);
      }
      send(ws, { t: "chat_history", scope: "global", items: globalChatHistory });
      break;
    }

    case "ping":
      // ts 原样回传（客户端算 RTT）；perf 是服务器单调时钟，
      // 客户端用 min RTT 样本算出"服务器 perf → 本机 perf"的偏移，用于发车时刻严格对齐。
      send(ws, { t: "pong", ts: msg.ts, now: Date.now(), perf: Math.round(performance.now() * 100) / 100 });
      break;

    default:
      send(ws, { t: "error", code: "unknown_type", msg: msg.t });
  }
}
