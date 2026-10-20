// 排行榜服务：每赛道最快圈 / 最短总时，按玩家身份记录
// 成绩来源两种：
//  - "online_race"  在线房间比赛 → 服务器权威模拟产出，直接可信
//  - "solo_practice" 在线单人练习 → 客户端上报，需通过合理性校验
import crypto from "node:crypto";
import { loadDb, saveDb } from "../db/store.js";
import { TRACK_MIN_LAP_MS, DEFAULT_MIN_LAP_MS } from "../config.js";

export function submitLapRecord({ playerId, trackId, carId, bestLapMs, totalMs, laps, source }) {
  const db = loadDb();
  bestLapMs = Math.round(Number(bestLapMs) || 0);
  totalMs = Math.round(Number(totalMs) || 0);
  laps = Math.max(1, Math.round(Number(laps) || 1));

  // ---- 合理性校验（防止客户端乱报成绩）----
  const minLap = TRACK_MIN_LAP_MS[trackId] ?? DEFAULT_MIN_LAP_MS;
  const validated =
    bestLapMs >= minLap &&                                    // 不可能快于理论最短圈
    bestLapMs < 60 * 60 * 1000 &&                             // 不可能慢于 1 小时
    (source === "online_race" || totalMs >= laps * minLap);   // 总时 >= 圈数 × 最短圈

  const record = {
    id: "lap_" + crypto.randomBytes(8).toString("hex"),
    playerId,
    trackId,
    carId: String(carId || "unknown"),
    bestLapMs,
    totalMs,
    laps,
    source,                       // online_race | solo_practice
    validated: validated ? 1 : 0,
    createdAt: Date.now(),
  };
  db.lapRecords.push(record);
  saveDb();
  return record;
}

// 每玩家只保留最好一条 → 生成榜单（默认按最快单圈）
export function getLeaderboard(trackId, { limit = 20, sortBy = "bestLapMs" } = {}) {
  const db = loadDb();
  const best = new Map();   // playerId -> record
  for (const r of db.lapRecords) {
    if (r.trackId !== trackId || !r.validated) continue;
    const cur = best.get(r.playerId);
    if (!cur || r[sortBy] < cur[sortBy]) best.set(r.playerId, r);
  }
  return [...best.values()]
    .sort((a, b) => a[sortBy] - b[sortBy])
    .slice(0, limit);
}

// 榜单附加玩家昵称后输出给客户端
export function getLeaderboardView(trackId, opts) {
  const db = loadDb();
  return getLeaderboard(trackId, opts).map((r, i) => {
    const p = db.players.find(x => x.id === r.playerId);
    return {
      rank: i + 1,
      nickname: p ? p.nickname : "???",
      carId: r.carId,
      bestLapMs: r.bestLapMs,
      totalMs: r.totalMs,
      laps: r.laps,
      source: r.source,
      createdAt: r.createdAt,
    };
  });
}
