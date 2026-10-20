// 全局配置：真实比例（1 世界单位 = 1 米）
// 上海国际赛车场：单圈 5451.24 m，T13→T14 直线 1175 m，
// 赛道宽常规 14m、T14/T15 弯心加宽到 20m；赛车宽 2m、长 5.6m（1:7）

export const LAP_LENGTH = 5451.24;   // 单圈总长（米）
export const HW = 7;                 // 常规半宽（14m 路面）
export const HW_WIDE = 10;           // T14/T15 弯心半宽（20m 路面）
export const M = 1;                  // 1 单位 = 1 米（赛车渲染用）
export const MARGIN = 80;            // 世界边界到赛道的草地边距（米）

export const TOTAL_LAPS = 3;

// 玩家自定义比赛圈数（0 = 未选择，使用各赛道推荐圈数）
// 有效圈数 = RACE_LAPS || 赛道.laps || TOTAL_LAPS
export let RACE_LAPS = 0;
export function setRaceLaps(n) {
  n = Math.round(Number(n) || 0);
  RACE_LAPS = Math.max(0, Math.min(50, n));
  return RACE_LAPS;
}
export function effectiveLaps(trackLaps) {
  return RACE_LAPS || trackLaps || TOTAL_LAPS;
}

export const ZOOM_HI = 13;           // 镜头近景（低速）：视野约 92m
export const ZOOM_LO = 9;            // 镜头远景（高速）：视野约 133m

// 物理参数（单位：米、米/秒）
export const PHYS = {
  maxSpeed: [100, 90, 33.6],         // 沥青 / 路肩 / 草地（360 / 324 / 121 km/h）
  // 满油门加速度曲线（m/s²，随速度衰减）：0→100km/h ≈ 2.4s，极速 360km/h
  accelCurve: [[0, 11.6], [28, 11.0], [56, 8.5], [78.4, 5.5], [100, 1.5]],
  accelKerbFactor: 0.85,
  accelGrassFactor: 0.6,
  grassDrag: 0.4,
  brake: 61.6,                       // 重刹（L）≈6.3g
  lightBrakeFactor: 0.45,            // 轻刹（K）= 重刹的 45%
  reverseAccel: 16.8,
  maxReverse: 15.4,                  // 倒挡极速 ≈55km/h（真实 F1 倒挡水平；121km/h 倒车不合理）
  coastDecel: 2.24,                  // 松油门引擎制动 ≈0.23g
  coastDrag: 0.02,
  grassCoastExtra: 11.2,
  latGrip: 45,                       // 最大侧向抓地 ≈4.6g → 过弯极限速度 = sqrt(latGrip * 半径)
  // 摩擦圆残余系数（平方项下限）：满刹车时仍保留 sqrt(0.6)≈77% 横向抓地。
  // 取 1 是纯圆（满刹完全无法转向，键盘操作过于苛刻），0 是关闭摩擦圆。
  // 实测（ai-sim 上赛 3 圈）：0.6 时全场圈速与无摩擦圆基线相差 <0.5s，0.35 会让
  // 最吃满抓地的 gemini 车慢 4.7s，故取 0.6 兼顾手感与公平。
  frictionLatFloor: 0.6,
  maxOmega: 3.4,                     // 低速最大转向角速度 rad/s
  skidG: 9.81                        // 轮胎印阈值：纵向加速度超过 1g（锁胎/烧胎）留印
};
