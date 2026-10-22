// 房间：状态机 + 成员管理（P1 骨架：大厅生命周期；P3 接入权威模拟器）
// 状态机: lobby → countdown → racing → finished → (再开) lobby
//
// 观赛身份（spectating）：比赛进行中进房的玩家自动以观赛身份加入 ——
//   · 仍然放在 members 里：房间视图 / 聊天 / 快照 / 位姿广播全都能照常收到
//   · 但不占发车位、不参加本场比赛（isEveryoneReady / 开赛校验 / 参赛名单一律只看 non-spectator）
//   · 客户端据此切到"观赛视角"，可选择任意一辆赛车观看实时画面
import crypto from "node:crypto";
import { SERVER_CONFIG } from "../config.js";
import { createTrackContext } from "../../src/track/geometry.js";

let roomSeq = 0;

export class Room {
  constructor(host, opts = {}) {
    this.id = "R" + (++roomSeq).toString(36).toUpperCase() + "_" + crypto.randomBytes(2).toString("hex");
    this.hostId = host.id;
    this.state = "lobby";
    this.trackId = opts.trackId || "shanghai";
    this.laps = 0;                               // 房主指定的圈数（0 = 赛道默认），开赛前对全员可见
    this.sameCar = opts.sameCar === true;        // 旧字段保留（房间 UI 已不再暴露"同车竞技"）
    this.fillAI = opts.fillAI !== false;         // AI 补位空余发车位；false = 纯玩家对战
    this.maxPlayers = Math.min(opts.maxPlayers || SERVER_CONFIG.maxPlayersPerRoom, SERVER_CONFIG.maxPlayersPerRoom);
    this.maxSpectators = Math.min(
      opts.maxSpectators || SERVER_CONFIG.maxSpectatorsPerRoom,
      SERVER_CONFIG.maxSpectatorsPerRoom
    );
    this.members = new Map();                    // sessionId -> { session, carId, ready, scriptId, spectating, notReadySince }
    this.chatHistory = [];                       // 房间聊天记录（最近 10 条，进房时补发）
    this.createdAt = Date.now();
    this.autoStartAt = 0;                        // 全员就绪后的自动开赛时刻（Date.now，0 = 没有在倒计时）
    this.autoHoldUntil = 0;                      // 静默期：刚打完一局时先不自动就绪/自动开赛
    this.trackCtx = null;                        // 比赛开始时构建（createTrackContext）
    this.sim = null;                             // RaceSim 实例（开赛时创建）
  }

  // 比赛进行中（倒计时 / 正赛）：此时进房只能观赛，不能占发车位
  isRacing() {
    return this.state === "racing" || this.state === "countdown";
  }

  racers() {
    return [...this.members.values()].filter(m => !m.spectating);
  }

  spectators() {
    return [...this.members.values()].filter(m => m.spectating);
  }

  racerCount() {
    let n = 0;
    for (const m of this.members.values()) if (!m.spectating) n++;
    return n;
  }

  spectatorCount() {
    return this.members.size - this.racerCount();
  }

  // opts.spectate：客户端显式要求观赛；比赛进行中则自动按观赛处理
  addMember(session, opts = {}) {
    if (this.members.has(session.id)) return { ok: false, reason: "already_in" };
    const spectating = opts.spectate === true || this.isRacing();
    if (spectating) {
      // 观赛不占发车位：赛满 8 人也能进来看；单独限一个观赛上限防刷
      if (this.spectatorCount() >= this.maxSpectators) return { ok: false, reason: "spectator_full" };
      this.members.set(session.id, { session, carId: null, ready: false, scriptId: null, spectating: true, notReadySince: 0 });
      return { ok: true, spectating: true };
    }
    if (this.racerCount() >= this.maxPlayers) return { ok: false, reason: "room_full" };
    // 房主不需要"准备就绪"：进场即视为已就绪，随时可以开赛
    const isHost = this.hostId === session.id;
    this.members.set(session.id, {
      session, carId: null, ready: isHost, scriptId: null, spectating: false,
      notReadySince: 0,   // 未准备起始时刻：15 秒后由网关自动置为就绪
    });
    return { ok: true, spectating: false };
  }

  removeMember(sessionId) {
    const existed = this.members.delete(sessionId);
    // 房主离开：转移给最早加入的车手（全是观赛者时退而取最早成员；新房东同样免准备就绪）
    if (existed && this.hostId === sessionId && this.members.size > 0) {
      this.hostId = this.racers()[0]?.session.id || this.members.keys().next().value;
      const next = this.members.get(this.hostId);
      if (next) next.ready = true;
    }
    return existed;
  }

  setMember(sessionId, patch) {
    const m = this.members.get(sessionId);
    if (!m) return false;
    Object.assign(m, patch);
    return true;
  }

  // 切换观赛身份：on = true 进入观赛，false = 回到"可参加下一局"的普通成员
  setSpectating(sessionId, on) {
    const m = this.members.get(sessionId);
    if (!m) return null;
    m.spectating = !!on;
    m.ready = false;              // 身份变了，就绪位必须重新确认
    if (on) m.carId = null;       // 观赛不占车：留给下一局重新选车
    return m;
  }

  // 房主免准备就绪：只要求房主选好车、其他人选车 + 就绪（观赛者完全不参与校验）
  isEveryoneReady() {
    const racers = this.racers();
    return racers.length > 0 && racers
      .every(m => !!m.carId && (m.session.id === this.hostId || m.ready));
  }

  // 自动开赛的资格（两条都要满足）：
  //  1) 房里除房主外至少还有一名【参赛车手】—— 单人房不自动开始（想单跑由房主自己点）
  //  2) 所有参赛车手（房主只需选好车）全部就绪 —— 见 isEveryoneReady()
  // 观赛者不是参赛车手，既不占发车位，也不算"准备的人"。
  canAutoStart() {
    const hasOtherRacer = this.racers().some(m => m.session.id !== this.hostId);
    return hasOtherRacer && this.isEveryoneReady();
  }

  view() {
    return {
      id: this.id,
      state: this.state,
      trackId: this.trackId,
      laps: this.laps,
      sameCar: this.sameCar,
      fillAI: this.fillAI,
      hostId: this.hostId,
      playerCount: this.racerCount(),
      maxPlayers: this.maxPlayers,
      spectatorCount: this.spectatorCount(),
      maxSpectators: this.maxSpectators,
      // 全员就绪后房主还有多少毫秒才自动开赛（0 = 没有在倒计时）
      autoStartInMs: this.autoStartAt ? Math.max(0, this.autoStartAt - Date.now()) : 0,
      autoHoldInMs: this.autoHoldUntil ? Math.max(0, this.autoHoldUntil - Date.now()) : 0,
      players: [...this.members.values()].map(m => ({
        id: m.session.id,
        nickname: m.session.player?.nickname,
        carId: m.carId,
        ready: m.ready,
        spectating: !!m.spectating,
        hasScript: !!m.scriptId,
      })),
    };
  }
}
