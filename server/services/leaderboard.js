// 排行榜服务：每赛道最快圈 / 最短总时，按玩家身份记录
// 成绩来源两种：
//  - "online_race"  在线房间比赛 → 服务器权威模拟产出，直接可信
//  - "solo_practice" 在线单人练习 → 客户端上报，需通过合理性校验
import crypto from "node:crypto";
import { loadDb, saveDb } from "../db/store.js";
import { minLapMsFor, RACE_MIN_LAP_SAFETY } from "./lapValidation.js";

export function submitLapRecord({ playerId, trackId, carId, bestLapMs, totalMs, laps, source }) {
  const db = loadDb();
  bestLapMs = Math.round(Number(bestLapMs) || 0);
  totalMs = Math.round(Number(totalMs) || 0);
  laps = Math.max(1, Math.round(Number(laps) || 1));

  // ---- 合理性校验（防止客户端乱报成绩）----
  // 单人练习的车允许调校，阈值按可调出的最快形态计算；在线对战的车由客户端锁死调校
  const isRace = source === "online_race";
  // 房间比赛的成绩在 sim.reportFinish 里已经按 RACE_MIN_LAP_SAFETY 放行过一次，
  // 这里必须用同一个下限，否则"比赛判定有效"的成绩会在上榜前被二次判死。
  const minLap = Math.round(minLapMsFor(trackId, carId, { tuned: !isRace })
    * (isRace ? RACE_MIN_LAP_SAFETY : 1));
  const validated =
    bestLapMs >= minLap &&                                    // 不可能快于理论最短圈
    bestLapMs < 60 * 60 * 1000 &&                             // 不可能慢于 1 小时
    (isRace || totalMs >= laps * minLap);                     // 总时 >= 圈数 × 最短圈

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

// 每条成绩独立上榜（同一玩家同一赛道多次跑不合并），默认按最快单圈排序
export function getLeaderboard(trackId, { limit = 20, sortBy = "bestLapMs" } = {}) {
  const db = loadDb();
  return db.lapRecords
    .filter(r => r.trackId === trackId && r.validated)
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
