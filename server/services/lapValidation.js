// 成绩合理性校验：按赛道和车辆推导理论最短用时。
//
// 环形赛道用人工标定的最短圈速（TRACK_MIN_LAP_MS）。
// 直线加速赛没有弯道，用时完全由该车的纵向加速与极速决定：
// F1 ≈360km/h、小米 SU7 Ultra 350km/h、仰望 U9 496km/h，固定阈值会把
// 高极速电车的合法成绩一刀切误杀，因此按车辆物理配置现场积分出理论下限。
import { TRACKS } from "../../src/track/tracks.js";
import { AI_CONFIGS } from "../../src/game/ai.js";
import { estimateStraightTimeMs } from "../../src/car/physics.js";
import { TRACK_MIN_LAP_MS, DEFAULT_MIN_LAP_MS } from "../config.js";

const trackById = new Map(TRACKS.map(t => [t.id, t]));
const carById = new Map(AI_CONFIGS.map(c => [c.id, c]));

// 客户端物理步长与发车格位置会带来极小差异，理论下限再放宽 4%
const STRAIGHT_SAFETY = 0.96;

// 房间比赛（成绩由客户端本地计时上报，服务器无法重算）的放行系数。
// 只能有一个来源：sim.reportFinish 判"名次是否有效"、leaderboard 判"能否上榜"
// 用同一个系数，否则会出现"比赛里算有效、榜单却判无效"的分裂
// （表现就是房间比赛跑完了，排行榜里查不到这一圈）。
export const RACE_MIN_LAP_SAFETY = 0.9;

// 单人练习允许实时调校（极速最高 560km/h、功率 2400kW、加速倍率 2.2 等），
// 校验必须以该车"可调出的最快形态"为下限，否则合法调校成绩会被误杀。
function maxTunedPerf(perf) {
  const p = { ...perf, maxSpeed: [560 / 3.6, ...(perf.maxSpeed || []).slice(1)] };
  if (perf.powerKW != null) {
    p.powerKW = 2400;
    p.launchAccel = 20;
  } else {
    p.accelMult = 2.2;
    p.highSpeedAccel = 2.0;
  }
  return p;
}

export function minLapMsFor(trackId, carId, { tuned = false } = {}) {
  const track = trackById.get(trackId);
  if (track?.linear) {
    const cfg = carById.get(carId) || AI_CONFIGS[0];
    const perf = tuned ? maxTunedPerf(cfg.perf) : cfg.perf;
    return Math.round(estimateStraightTimeMs(perf, track.length) * STRAIGHT_SAFETY);
  }
  return TRACK_MIN_LAP_MS[trackId] ?? DEFAULT_MIN_LAP_MS;
}
