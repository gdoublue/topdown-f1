// 房间：状态机 + 成员管理（P1 骨架：大厅生命周期；P3 接入权威模拟器）
// 状态机: lobby → countdown → racing → finished → (再开) lobby
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
    this.sameCar = opts.sameCar === true;        // 旧字段保留（房间 UI 已不再暴露"同车竞技"）
    this.fillAI = opts.fillAI !== false;         // AI 补位空余发车位；false = 纯玩家对战
    this.maxPlayers = Math.min(opts.maxPlayers || SERVER_CONFIG.maxPlayersPerRoom, SERVER_CONFIG.maxPlayersPerRoom);
    this.members = new Map();                    // sessionId -> { session, carId, ready, scriptId }
    this.createdAt = Date.now();
    this.trackCtx = null;                        // 比赛开始时构建（createTrackContext）
    this.sim = null;                             // RaceSim 实例（开赛时创建）
  }

  addMember(session) {
    if (this.members.size >= this.maxPlayers) return { ok: false, reason: "room_full" };
    if (this.members.has(session.id)) return { ok: false, reason: "already_in" };
    this.members.set(session.id, { session, carId: null, ready: false, scriptId: null });
    return { ok: true };
  }

  removeMember(sessionId) {
    const existed = this.members.delete(sessionId);
    // 房主离开：转移给最早加入的成员
    if (existed && this.hostId === sessionId && this.members.size > 0) {
      this.hostId = this.members.keys().next().value;
    }
    return existed;
  }

  setMember(sessionId, patch) {
    const m = this.members.get(sessionId);
    if (!m) return false;
    Object.assign(m, patch);
    return true;
  }

  isEveryoneReady() {
    return this.members.size > 0 && [...this.members.values()].every(m => m.ready && m.carId);
  }

  view() {
    return {
      id: this.id,
      state: this.state,
      trackId: this.trackId,
      sameCar: this.sameCar,
      fillAI: this.fillAI,
      hostId: this.hostId,
      playerCount: this.members.size,
      maxPlayers: this.maxPlayers,
      players: [...this.members.values()].map(m => ({
        id: m.session.id,
        nickname: m.session.player?.nickname,
        carId: m.carId,
        ready: m.ready,
        hasScript: !!m.scriptId,
      })),
    };
  }
}
