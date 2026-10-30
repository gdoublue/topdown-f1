// 赛车物理：加减速、转向（抓地极限模型）、路面判定、轮胎印与粒子
import { PHYS } from "../config.js";
import { WORLD, pts, N, nor, tan, hw, cumDist, LAP_LENGTH, isLinear, kerbFlag, roadAt, terrainAt } from "../track/geometry.js";
import { clamp } from "../utils.js";

// 沿赛道中心线计算发车格精确坐标：
// 环形赛道：从起终点线向后方回退 distMeters；线性赛道：从起点向前推进（直线竞速并排同线发车）
function getGridSlotGeometry(distMeters, lateralOff, forward = false) {
  let accumulated = 0;
  let curr = 0; // 起终点线点 pts[0]
  const maxSteps = N;

  for (let step = 0; step < maxSteps; step++) {
    const next = forward
      ? Math.min(curr + 1, N - 1)
      : (curr - 1 + N) % N;
    const segLen = Math.hypot(pts[next].x - pts[curr].x, pts[next].y - pts[curr].y);
    if (accumulated + segLen >= distMeters) {
      const remain = distMeters - accumulated;
      const t = segLen > 1e-4 ? remain / segLen : 0;
      // 在 curr 和 next 之间平滑线性插值
      const cx = pts[curr].x + (pts[next].x - pts[curr].x) * t;
      const cy = pts[curr].y + (pts[next].y - pts[curr].y) * t;
      const tx = tan[curr].x * t + tan[next].x * (1 - t);
      const ty = tan[curr].y * t + tan[next].y * (1 - t);
      const tmag = Math.hypot(tx, ty) || 1;
      const nx = -ty / tmag;
      const ny = tx / tmag;

      return {
        x: cx + nx * lateralOff,
        y: cy + ny * lateralOff,
        angle: Math.atan2(ty, tx),
        idx: forward ? next : curr
      };
    }
    accumulated += segLen;
    curr = next;
    if (forward && curr >= N - 1) break;
  }

  // 兜底返回起终点线附近
  const fallbackIdx = forward ? Math.min(N - 2, 2) : (N - 2 + N) % N;
  return {
    x: pts[fallbackIdx].x + nor[fallbackIdx].x * lateralOff,
    y: pts[fallbackIdx].y + nor[fallbackIdx].y * lateralOff,
    angle: Math.atan2(tan[fallbackIdx].y, tan[fallbackIdx].x),
    idx: fallbackIdx
  };
}

export function createCar(gridPos = 0) {
  // 模拟真实 FIA F1 发车规格：
  // 杆位 (P1) 距离起跑线 12 米，后续每格前后交错距离为精确 8 米（真实 1x1 棋盘式格位，整套发车格纵向仅 24 米）
  // 左右横向错开 ±1.7 米，确保所有赛道（包括 7km 斯帕）发车时所有赛车在视野内紧凑同框呈现实况
  const POLE_OFFSET_M = 12.0;
  const GRID_INTERVAL_M = 8.0;
  const distBehindStart = POLE_OFFSET_M + gridPos * GRID_INTERVAL_M;

  let slot, raceDist0, trackS0;
  if (isLinear) {
    // 直线竞速：所有车同一基准线并排发车（公平冲刺），横向成对等距展开。
    // 车道间距 2.8m（车宽 2.0m + 0.8m 侧向间隙），并按当前沥青半宽收边，避免车辆摆出路面
    const laneGap = 2.8;
    const laneEdge = hw[0] - 1.6;
    const side = gridPos % 2 === 0 ? 1 : -1;
    const lateralOff = clamp(side * (laneGap * 0.5 + Math.floor(gridPos / 2) * laneGap),
      -laneEdge, laneEdge);
    slot = getGridSlotGeometry(POLE_OFFSET_M, lateralOff, true);
    raceDist0 = 0;
    trackS0 = POLE_OFFSET_M;
  } else {
    const lateralOff = (gridPos % 2 === 0 ? 1.7 : -1.7);
    slot = getGridSlotGeometry(distBehindStart, lateralOff);
    raceDist0 = -distBehindStart;
    trackS0 = (LAP_LENGTH - distBehindStart + LAP_LENGTH) % LAP_LENGTH;
  }

  const car = {
    x: slot.x,
    y: slot.y,
    angle: slot.angle,
    speed: 0, steer: 0,
    idx: slot.idx, nearIdx: slot.idx,
    prevSpeed: 0, accel: 0,
    braking: false, shake: 0,
    // 上一步的原始控制量（供对手算法 / 刹车灯 / 遥测读取）
    inUp: false, inBrake: 0, inSteer: 0,
    gLon: 0, gLat: 0, gTotal: 0,
    gridPos,
    raceDist: raceDist0,
    trackS: trackS0,
    skidI: 0,           // 轮胎印强度状态（起印/收印渐变，0 = 无）
    prevWheels: null,
    slideV: 0           // 草坡侧滑速度（m/s，+ = 车身左侧；仅离路陡坡生效）
  };
  // 停车状态也要有路面高度/坡度：roadY 平时由 stepCar 每帧刷新，
  // 但发车倒计时期间物理不推进，缺了它车体在 3D 里会停在 y=0，
  // 被有海拔的赛道（上海起跑区 +2.3m、斯帕更高）整台埋进沥青路面里。
  updateRoadProfile(car);
  return car;
}

function distToSegmentSquared(px, py, ax, ay, bx, by) {
  const abx = bx - ax, aby = by - ay;
  const apx = px - ax, apy = py - ay;
  const len2 = abx * abx + aby * aby;
  if (len2 < 1e-6) return apx * apx + apy * apy;
  let t = (apx * abx + apy * aby) / len2;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const qx = ax + t * abx - px;
  const qy = ay + t * aby - py;
  return qx * qx + qy * qy;
}

export function nearestIndex(x, y, hintIdx = -1) {
  const idxAt = (i) => isLinear
    ? Math.min(Math.max(i, 0), N - 1)
    : ((i % N) + N) % N;

  let bi = hintIdx;
  if (hintIdx >= 0 && hintIdx < N) {
    const WIN = 20;
    let best = Infinity;
    for (let offset = -WIN; offset <= WIN; offset++) {
      const i = idxAt(hintIdx + offset);
      const dx = pts[i].x - x, dy = pts[i].y - y;
      const d = dx * dx + dy * dy;
      if (d < best) { best = d; bi = i; }
    }
    if (best >= 3600) bi = -1;
  }

  if (bi < 0 || bi >= N) {
    let best = Infinity, found = 0;
    for (let i = 0; i < N; i++) {
      const dx = pts[i].x - x, dy = pts[i].y - y;
      const d = dx * dx + dy * dy;
      if (d < best) { best = d; found = i; }
    }
    bi = found;
  }

  // 严格线段正交几何投影：求解到赛道中心线的最短垂直距离与精确沿赛道物理米数 s
  const prevI = idxAt(bi - 1);
  const nextI = idxAt(bi + 1);
  const dPrev = distToSegmentSquared(x, y, pts[prevI].x, pts[prevI].y, pts[bi].x, pts[bi].y);
  const dNext = distToSegmentSquared(x, y, pts[bi].x, pts[bi].y, pts[nextI].x, pts[nextI].y);
  const dExact = Math.sqrt(Math.min(dPrev, dNext));

  let segIdx = bi, segT = 0;
  if (dPrev < dNext) {
    segIdx = prevI;
    const abx = pts[bi].x - pts[prevI].x, aby = pts[bi].y - pts[prevI].y;
    const apx = x - pts[prevI].x, apy = y - pts[prevI].y;
    const len2 = abx * abx + aby * aby;
    segT = len2 > 1e-4 ? clamp((apx * abx + apy * aby) / len2, 0, 1) : 0;
  } else {
    segIdx = bi;
    const abx = pts[nextI].x - pts[bi].x, aby = pts[nextI].y - pts[bi].y;
    const apx = x - pts[bi].x, apy = y - pts[bi].y;
    const len2 = abx * abx + aby * aby;
    segT = len2 > 1e-4 ? clamp((apx * abx + apy * aby) / len2, 0, 1) : 0;
  }

  let s = 0;
  if (cumDist && cumDist.length > segIdx + 1) {
    const segDist = (cumDist[segIdx + 1] - cumDist[segIdx]) * segT;
    s = isLinear
      ? cumDist[segIdx] + segDist
      : (cumDist[segIdx] + segDist) % (LAP_LENGTH || 5000);
  }

  return { i: bi, d: dExact, s };
}

// 满油门加速度（m/s²，随速度查表衰减，路肩/草地按系数折减）
// highBoost：超过基准曲线末段（100 m/s）后的高速推力系数，
// 模拟大功率电车功率限制特性 a = P/(m·v)（普通 F1 取 1 保持原曲线）
function accelAt(v, surf, mult = 1.0, highBoost = 1.0) {
  const c = PHYS.accelCurve;
  let a = c[c.length - 1][1];
  for (let i = 1; i < c.length; i++) {
    if (v <= c[i][0]) {
      const v0 = c[i - 1][0], a0 = c[i - 1][1];
      a = a0 + (c[i][1] - a0) * (v - v0) / (c[i][0] - v0);
      break;
    }
  }
  if (v > c[c.length - 1][0]) a *= highBoost;
  if (surf === 1) a *= PHYS.accelKerbFactor;
  else if (surf === 2) a *= PHYS.accelGrassFactor;
  return a * mult;
}

// 纵向物理（油门/刹车/滑行），支持每辆赛车专属性能配置
// 电动车功率限制加速模型：a = min(起步抓地极限, P/(m·v) − 风阻)
// 风阻系数由标称极速反推（极速处 a = 0），功率差距在高速段自然指数级拉开（3000Ps vs 1500Ps）
function evAccelAt(perf, v, surf) {
  const P = perf.powerKW * 1000;
  const m = perf.massKg ?? 2200;
  // 风阻标定用自然极速（无电子限速时空气阻力与功率平衡的速度）；电子限速只作硬封顶
  const vmax = perf.naturalVmax ?? (perf.maxSpeed ? perf.maxSpeed[0] : PHYS.maxSpeed[0]);
  const k = P / (m * vmax * vmax * vmax);            // 风阻/质量系数（a=0 at 自然极速）
  let a = P / (m * Math.max(v, 2)) - k * v * v;      // v≥2 防低速发散（起步由抓地极限接管）
  a = Math.min(a, perf.launchAccel ?? 14.0);         // 四四驱弹射的起步抓地极限
  if (surf === 1) a *= PHYS.accelKerbFactor;
  else if (surf === 2) a *= PHYS.accelGrassFactor;
  return Math.max(a, 0);
}

// 直线赛理论最快用时（毫秒）：静止起步、全油门、无转向，按该车纵向物理积分。
// 各车型极速差距很大（F1 ≈360km/h，U9 ≈496km/h），固定时间阈值会把高极速
// 电车的合法成绩判成作弊；成绩校验以这里的物理下限为基准。
export function estimateStraightTimeMs(perf, distance) {
  perf = perf || {};
  const dt = 1 / 120;
  const maxSpeed = perf.maxSpeed ? perf.maxSpeed[0] : PHYS.maxSpeed[0];
  const accelMult = perf.accelMult ?? 1.0;
  const highBoost = perf.highSpeedAccel ?? 1.0;
  let v = 0, s = 0, t = 0;
  while (s < distance && t < 3600) {
    const a = perf.powerKW != null
      ? evAccelAt(perf, v, 0)
      : accelAt(v, 0, accelMult, highBoost);
    v += a * dt;
    if (v > maxSpeed) v = Math.max(maxSpeed, v - 120 * dt);
    s += v * dt;
    t += dt;
  }
  return t * 1000;
}

/* ============ 赛道纵向剖面（P1 起伏 / banking） ============
   由 trackS 弧长采样中心线高度/坡度/横坡，叠加横向偏移的 banking 分量。
   写入 car.roadY（渲染高度）、car.roadPitch（沿车头等效坡度，+ = 上坡）、
   car.roadRoll（等效横坡，+ = 车身 +nor 侧更高）。
   出界后与地面采样器同口径：草肩 (hw+7) 内保持路面高度，40m 内落到
   真实 DEM 地形；无地形数据的赛道落到 0。 */
export function updateRoadProfile(car) {
  if (car.trackS == null) { car.roadY = 0; car.roadPitch = 0; car.roadRoll = 0; return car; }
  const prof = roadAt(car.trackS);
  const i = prof.i;
  const dx = car.x - pts[i].x, dy = car.y - pts[i].y;
  const dLat = dx * nor[i].x + dy * nor[i].y;
  const edge = (hw[i] ?? 7) + 2;
  const aLat = Math.abs(dLat);
  const roadY = prof.y + prof.bank * Math.max(-edge, Math.min(edge, dLat));
  const dth = Math.cos(car.angle - Math.atan2(tan[i].y, tan[i].x));
  // 出界后与 3D 地面采样器 (makeGroundSampler) 完全同口径：
  // 草肩 (hw+7) 内保持路面高度，再经 40m smoothstep 平滑过渡到真实 DEM 地形（无 DEM 赛道落到 0）
  const shoulder = (hw[i] ?? 7) + 7;
  let t = (aLat - shoulder) / 40;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const fall = t * t * (3 - 2 * t);
  if (!terrainAt) {
    car.roadY = roadY * (1 - fall);
    car.roadPitch = prof.grade * dth * (1 - fall);
    car.roadRoll = prof.bank * dth * (1 - fall);
    return car;
  }
  const tY = terrainAt(car.x, car.y);
  car.roadY = roadY * (1 - fall) + tY * fall;
  // 离路后附加地形坡度（视觉俯仰/侧倾）；在路面上完全跳过地形采样
  let gF = 0, gL = 0;
  if (fall > 0) {
    const ca = Math.cos(car.angle), sa = Math.sin(car.angle);
    gF = (terrainAt(car.x + ca * 5, car.y + sa * 5) - terrainAt(car.x - ca * 5, car.y - sa * 5)) / 10;
    gL = (terrainAt(car.x - sa * 3, car.y + ca * 3) - terrainAt(car.x + sa * 3, car.y - ca * 3)) / 6;
  }
  car.roadPitch = prof.grade * dth * (1 - fall) + gF * fall;
  car.roadRoll = prof.bank * dth * (1 - fall) + gL * fall;
  return car;
}

export function stepLongitudinal(car, dt, input, surf) {
  const perf = car.perf || {};
  const maxSpeed = perf.maxSpeed ? perf.maxSpeed[surf] : PHYS.maxSpeed[surf];
  const accelMult = perf.accelMult ?? 1.0;
  const brakeMult = perf.brakeMult ?? 1.0;
  const up = input.up;
  const brake = input.brake;      // 0 无 / 1 轻刹 / 2 重刹（优先级高于油门）

  const prev = car.speed;
  car.braking = false;
  if (up && brake === 0) {
    // 电车（配置 powerKW）走功率限制模型；F1 走经验衰减曲线
    const a = perf.powerKW != null
      ? evAccelAt(perf, Math.max(0, car.speed), surf)
      : accelAt(Math.max(0, car.speed), surf, accelMult, perf.highSpeedAccel ?? 1.0);
    car.speed += a * dt;
    if (surf === 2) car.speed -= car.speed * PHYS.grassDrag * dt;
  } else if (brake > 0) {
    const baseBrake = PHYS.brake * brakeMult;
    const strength = brake === 2 ? baseBrake : baseBrake * PHYS.lightBrakeFactor;
    if (car.speed > 1) {
      car.speed -= strength * dt;
      car.braking = true;
    } else if (brake === 2) {
      // 重刹停稳后倒车；轻刹只保持停止
      car.speed -= PHYS.reverseAccel * dt;
      if (car.speed < -PHYS.maxReverse) car.speed = -PHYS.maxReverse;
    } else {
      car.speed = Math.max(0, car.speed - strength * dt);
    }
  } else {
    // 松油门滑行：引擎制动 + 速度阻尼（草地额外阻力）
    const dec = PHYS.coastDecel + Math.abs(car.speed) * PHYS.coastDrag
      + (surf === 2 ? PHYS.grassCoastExtra : 0);
    const dv = dec * dt;
    if (Math.abs(car.speed) <= dv) car.speed = 0;
    else car.speed -= Math.sign(car.speed) * dv;
  }

  // 坡度重力（P2）：roadPitch = 沿车头方向的等效坡度（+ = 上坡），上坡减速/下坡加速。
  // 解析式赛道 ≤4% → ±0.4 m/s²；斯帕真实 DEM 最大 ~15% → ±1.5 m/s²，
  // 下坡制动距离明显变长（AI 的刹车规划已按 grade 同步修正）。
  car.speed -= 9.81 * (car.roadPitch || 0) * dt;

  if (car.speed > maxSpeed) car.speed = Math.max(maxSpeed, car.speed - 120 * dt);

  // 实际纵向加速度（m/s²，轮胎印判定用）
  car.accel = dt > 0 ? (car.speed - prev) / dt : 0;
}

// ================= 完赛巡航 =================
// 冲线后不再急刹停车：只松油门靠引擎制动平滑降速，落到随机巡航速度（60~100km/h）后匀速巡航。
// - AI 车：沿用 AI 的转向与弯前点刹（保证过弯不冲出赛道），仅把油门/目标速度压到巡航值
// - 玩家车：无 AI 输入时沿赛道中心线纯追踪自行巡航
export const FINISH_CRUISE_KMH_MIN = 60;
export const FINISH_CRUISE_KMH_MAX = 100;
const CRUISE_STEER_GAIN = 1.8;                     // 航向误差 → 方向盘 duty 增益

// 每辆车在本场比赛中抽取一次巡航速度（60~100km/h 随机），完赛期间保持不变
function getCruiseSpeed(car) {
  if (car._cruiseV == null) {
    const kmh = FINISH_CRUISE_KMH_MIN
      + Math.random() * (FINISH_CRUISE_KMH_MAX - FINISH_CRUISE_KMH_MIN);
    car._cruiseV = kmh / 3.6;
  }
  return car._cruiseV;
}

export function finishedCarInput(car, aiCtrl) {
  const i = car.nearIdx ?? 0;
  const v = Math.abs(car.speed);
  const cruiseV = getCruiseSpeed(car);

  if (aiCtrl && typeof aiCtrl.steer === "number") {
    // ---- AI 车：转向与弯道刹车交给 AI，纵向只做"慢慢降到巡航速度"的收敛 ----
    const brake = aiCtrl.brake || 0;
    const up = brake === 0 && v < cruiseV;   // 高于巡航速度只滑行，靠引擎制动降速
    return { up, brake, steer: aiCtrl.steer };
  }

  // ---- 玩家车：沿中心线纯追踪（前瞻随车速加长，弯道自动提前切向） ----
  const ds = isLinear
    ? cumDist[N - 1] / Math.max(1, N - 1)
    : LAP_LENGTH / Math.max(1, N);
  const look = Math.max(8, v * 0.85);
  const step = Math.max(1, Math.round(look / Math.max(0.1, ds)));
  const j = isLinear ? Math.min(i + step, N - 1) : (i + step) % N;
  let hErr = Math.atan2(pts[j].y - car.y, pts[j].x - car.x) - car.angle;
  while (hErr > Math.PI) hErr -= Math.PI * 2;
  while (hErr < -Math.PI) hErr += Math.PI * 2;
  const steer = clamp(hErr * CRUISE_STEER_GAIN, -1, 1);

  // 极高速时用轻刹（45% 制动力）先把尾速收下来，避免以 300km/h 滑行冲出弯道；
  // 接近巡航速度后改为纯滑行，平顺收油到巡航速度
  const brake = v > cruiseV * 1.8 ? 1 : 0;
  return { up: v < cruiseV && brake === 0, brake, steer };
}

export function stepCar(car, dt, input, fx) {
  // 记录本步原始控制量：对手算法可据此判断前车是否在刹车 / 给油（模拟真实赛道信息），
  // 渲染层也用它点亮刹车灯；在线对战由服务器快照中继。
  car.inUp = !!input.up;
  car.inBrake = input.brake | 0;
  car.inSteer = typeof input.steer === "number"
    ? clamp(input.steer, -1, 1)
    : (input.right ? 1 : 0) - (input.left ? 1 : 0);

  const near = nearestIndex(car.x, car.y, car.nearIdx);
  const d = near.d;
  const hwHere = hw[near.i];
  // 0 沥青 1 路肩 2 草地：判定与画面严格对应
  // · 白线以内：沥青
  // · 只有画了红白路缘石的路段（kerbFlag，直线冲刺赛道全程）才有路肩带，宽 1.5m
  // · 其余位置出白线 0.4m 容差后立刻是草地（不再有"说不出是什么"的过渡带）
  const kerbHere = isLinear || kerbFlag[near.i] === 1;
  let surf;
  if (d < hwHere) surf = 0;
  else if (kerbHere) surf = d < hwHere + 1.5 ? 1 : 2;
  else surf = d < hwHere + 0.4 ? 0 : 2;
  car.surf = surf;   // 供 HUD 判断是否冲出赛道

  stepLongitudinal(car, dt, input, surf);

  const perf = car.perf || {};
  const latGrip = perf.latGrip ?? PHYS.latGrip;
  const maxOmega = perf.maxOmega ?? PHYS.maxOmega;
  const steerRate = perf.steerRate ?? 11;

  const spd = Math.abs(car.speed);
  const steerIn = typeof input.steer === "number"
    ? clamp(input.steer, -1, 1)
    : (input.right ? 1 : 0) - (input.left ? 1 : 0);

  // 摩擦圆（椭圆）：纵向已经消耗的抓地会挤占横向可用抓地
  //   (a_lon / a_lonMax)² + (a_lat / a_latMax)² ≤ 1
  // 满油/滑行的纵向加速度远小于制动，所以主要惩罚"边重刹边满舵"，
  // 轻刹（45%）仍保留 ~89% 横向抓地，不会破坏循迹刹车手感。
  const longMax = PHYS.brake * (perf.brakeMult ?? 1);
  const usedLong = Math.min(1, Math.abs(car.accel) / Math.max(1, longMax));
  const latFriction = latGrip * Math.sqrt(Math.max(PHYS.frictionLatFloor, 1 - usedLong * usedLong));

  // 弯道横坡（banking）：路面沿车侧倾斜时，重力有一个沿路面向下的分量。
  // 赛道横坡由曲率导出（弯内侧低），正常过弯时重力指向转向侧 → 帮助过弯；
  // 反打方向时则与转向相反 → 抓地减损。等效横向能力 = latGrip·cosφ − s·g·roadRoll：
  //   φ 为横坡角（roadRoll = tanφ），s = ±1 为当前转向侧（倒车时取反）。
  // roadRoll 已含车头与赛道切线的夹角余弦，可直接当作"沿车身左侧的坡度"。
  // 离路（草地）不叠加：那里已由地形坡度驱动侧滑，避免重复计算。
  const bankSlope = surf === 2 ? 0 : clamp(car.roadRoll || 0, -0.28, 0.28);
  const bankCos = 1 / Math.sqrt(1 + bankSlope * bankSlope);
  const steerSide = (steerIn >= 0 ? 1 : -1) * (car.speed < -1 ? -1 : 1);
  const latAvail = Math.max(
    latGrip * 0.5,
    latFriction * bankCos - steerSide * 9.81 * bankSlope
  );

  // 抓地极限转向：最大侧向加速度 latAvail → ω = latAvail / v（低速另有上限）
  // 必须有速度才能转向：0→3 m/s 线性生效，原地无法转向
  const omega = Math.min(maxOmega, latAvail / Math.max(spd, 1))
    * Math.min(1, spd / 3)
    * (surf === 2 ? 0.74 : 1);
  car.angle += steerIn * omega * dt * (car.speed < -1 ? -1 : 1);
  car.steer += (steerIn * 0.55 - car.steer) * Math.min(1, dt * steerRate);

  // 实时 G 值遥测计算 (1G = 9.81 m/s²)
  const curGLon = car.accel / 9.81;
  const curGLat = (spd * Math.abs(steerIn * omega)) / 9.81;
  const curGTotal = Math.hypot(curGLon, curGLat);
  car.gLon = (car.gLon || 0) + (curGLon - (car.gLon || 0)) * Math.min(1, dt * 16);
  car.gLat = (car.gLat || 0) + (curGLat - (car.gLat || 0)) * Math.min(1, dt * 16);
  car.gTotal = (car.gTotal || 0) + (curGTotal - (car.gTotal || 0)) * Math.min(1, dt * 16);

  // 草坡侧滑：横向坡度（roadRoll）超过草地静摩擦时，车辆沿下坡方向滑移；
  // 沥青/路肩抓地远大于坡度分量，不做侧滑。滑移只是位置偏移，不改变车头朝向。
  if (surf === 2) {
    const slope = car.roadRoll || 0;
    const drive = -9.81 * slope;                        // 沿车身左侧的重力分量
    const hold = PHYS.grassSideFriction * 9.81;         // 草地静摩擦能顶住的最大坡度分量
    if (Math.abs(drive) > hold) {
      car.slideV = (car.slideV || 0) + (drive - Math.sign(drive) * hold) * dt;
    } else {
      car.slideV = (car.slideV || 0) * Math.max(0, 1 - dt * 8);
    }
    car.slideV = clamp(car.slideV, -6, 6);
  } else {
    car.slideV = (car.slideV || 0) * Math.max(0, 1 - dt * 8);
  }

  car.x += Math.cos(car.angle) * car.speed * dt - Math.sin(car.angle) * (car.slideV || 0) * dt;
  car.y += Math.sin(car.angle) * car.speed * dt + Math.cos(car.angle) * (car.slideV || 0) * dt;
  car.x = clamp(car.x, 10, WORLD.w - 10);
  car.y = clamp(car.y, 10, WORLD.h - 10);

  // 严格更新赛道连续物理米数里程（米，彻底消除发车与弯道处离散索引跳变颠倒）
  const nearNow = nearestIndex(car.x, car.y, near.i);
  car.nearIdx = nearNow.i;
  car.trackS = nearNow.s;
  updateRoadProfile(car);   // roadY / roadPitch / roadRoll（下一帧坡度重力与本帧渲染用）

  if (isLinear) {
    // 线性赛道：里程就是沿直线的物理进度，无圈数/半程概念
    car.raceDist = Math.max(nearNow.s, car.raceDist || 0);
  } else {
    let effLap = car.lap || 1;
    let s = nearNow.s;
    const lapLen = LAP_LENGTH || 5000;
    if (effLap === 1 && !car.half && s > lapLen * 0.7) {
      s -= lapLen; // 发车格线后方阶段为负里程
    } else if (car.half && s < lapLen * 0.3) {
      // 已经物理越过起终点线，但 updateCarLap 尚未执行圈数跃迁
      effLap += 1;
    }
    car.raceDist = (effLap - 1) * lapLen + s;
  }

  /* 四轮独立精确几何位置 + 阿克曼半径差（前/后轴转弯半径不同 → 四条独立痕迹） */
  const cosA = Math.cos(car.angle), sinA = Math.sin(car.angle);
  const pxPerp = -sinA, pyPerp = cosA;              // 车身法向（+ 侧）
  const HALF_BASE = 1.75;                           // 半轴距（前/后轴各距车身中心 1.75m）
  const TRACK_F = 0.77, TRACK_R = 0.79;             // 前/后半轮距

  const yawRate = car.steer * omega * (car.speed < -1 ? -1 : 1);   // 有符号横摆角速度
  const turnSign = yawRate >= 0 ? 1 : -1;                          // 转向侧
  const kappa = spd > 3 ? Math.abs(yawRate) / spd : 0;             // 路径曲率
  // 前后轴半径差：R_front = hypot(R, L) → ΔR ≈ L²·κ/2，弯越急差距越大
  const radiusGap = clamp(0.5 * (2 * HALF_BASE) * (2 * HALF_BASE) * kappa, 0, 0.45);
  // 逼近附着极限后轮胎向外滑：前轴推头外滑明显，后轴收向弯内（两者进一步拉开）
  const slip = clamp((Math.abs(car.gLat) - 2.0) / 2.6, 0, 1);
  const outDir = -turnSign;                                        // 弯外方向（+ 法向为正）
  const offF = outDir * clamp(radiusGap + slip * 0.40, 0, 0.45);   // 前轴：半径更大 → 偏弯外
  const offR = -outDir * clamp(radiusGap + slip * 0.10, 0, 0.28);  // 后轴：半径更小 → 偏弯内

  const fxBase = cosA * HALF_BASE, fyBase = sinA * HALF_BASE;
  const latFL = TRACK_F + offF, latFR = -TRACK_F + offF;
  const latRL = TRACK_R + offR, latRR = -TRACK_R + offR;
  // 各轮所在路面的高度：中心高度 + 纵向坡度 × 前后轴距 + 横坡 × 轮距
  // （roadPitch / roadRoll 已是沿车头/车侧方向的等效坡度，前后轮差在 14% 坡上约 0.5m）
  const wY = (along, lat) => car.roadY + (car.roadPitch || 0) * along + (car.roadRoll || 0) * lat;
  const fl = { x: car.x + fxBase + pxPerp * latFL, y: car.y + fyBase + pyPerp * latFL, h: wY(HALF_BASE, latFL) };
  const fr = { x: car.x + fxBase + pxPerp * latFR, y: car.y + fyBase + pyPerp * latFR, h: wY(HALF_BASE, latFR) };
  const rl = { x: car.x - fxBase + pxPerp * latRL, y: car.y - fyBase + pyPerp * latRL, h: wY(-HALF_BASE, latRL) };
  const rr = { x: car.x - fxBase + pxPerp * latRR, y: car.y - fyBase + pyPerp * latRR, h: wY(-HALF_BASE, latRR) };

  /* 四轮独立物理滑移与热惯性留印系统：
     1. 纵/横耦合摩擦圆（Trail Braking / 点刹入弯）：直道需重刹（≥54% 制动极限）才锁胎；
        弯中横向载荷已占用抓地力时，锁胎阈值随侧向 G 自动降低（最低至 32%），因此入弯点刹（轻刹 45%）也会真实触发内侧前轮优先抱死留印。
     2. 载荷转移（Weight Transfer）：制动+转向时重心前移且压向弯外，弯内侧前轮因垂向卸载最先锁死留深印，
        重刹到底时四轮全面抱死；极限侧滑搓胎时则由重载的弯外侧前后轮主导留印。
     3. 滑移热惯性迟滞（Hysteresis ~85ms）+ 首尾梭形包络：过滤 1~3 帧的临界抖动（杜绝碎麻点），
        同时让真实的人为点刹呈现“浅入→深印→浅出”的连续梭形（纺锤形）轮胎印。 */
  const wTarget = { fl: 0, fr: 0, rl: 0, rr: 0 };
  if (car.prevWheels && surf !== 2 && spd > 3.5) {
    const brakeCap = PHYS.brake * (perf.brakeMult ?? 1);
    const latLimitG = Math.max(0.5, latGrip / 9.81);
    const latRatio = clamp((car.gLat || 0) / latLimitG, 0, 1.15);
    const steerMag = clamp(Math.abs(car.steer || 0) / 0.32, 0, 1);
    // turnSign > 0（右转）时 fl/rl 为弯内侧轮、fr/rr 为弯外侧轮
    const flIsInside = turnSign >= 0;

    if (car.braking) {
      // 弯中带刹（循迹刹车/点刹）时横向力已消耗摩擦圆，纵向起印阈值随之下降
      const lockDecel = brakeCap * (0.54 - 0.22 * clamp(latRatio, 0, 1));
      if (car.accel < -lockDecel) {
        const over = clamp((-car.accel - lockDecel) / Math.max(1, brakeCap - lockDecel), 0, 1);
        const baseI = (0.24 + 0.68 * over) * (0.80 + 0.20 * Math.min(1, spd / 42));
        // 弯内前轮卸载最易抱死；弯外前轮与后轮随制动加深逐步加入锁胎
        const inFront = baseI * (1.0 + 0.16 * steerMag);
        const outFront = baseI * clamp((over - 0.16 * steerMag) / Math.max(0.2, 1 - 0.16 * steerMag), 0, 1);
        const inRear = baseI * 0.84 * clamp((over - 0.08 * steerMag) / 0.92, 0, 1);
        const outRear = baseI * 0.80 * clamp((over - 0.20 * steerMag) / 0.80, 0, 1);
        wTarget.fl = clamp(flIsInside ? inFront : outFront, 0, 1);
        wTarget.fr = clamp(flIsInside ? outFront : inFront, 0, 1);
        wTarget.rl = clamp(flIsInside ? inRear : outRear, 0, 1);
        wTarget.rr = clamp(flIsInside ? outRear : inRear, 0, 1);
      }
    }

    // 极限侧滑搓胎：横向载荷 ≥ 侧向极限 93%，且有带刹减速或压路肩负载时，重载的弯外侧车轮留下搓胎印
    if (wTarget.fl === 0 && wTarget.fr === 0 && Math.abs(car.steer) > 0.20 && spd > 9) {
      const extraLoad = car.braking || car.accel < -brakeCap * 0.26 || surf === 1;
      if (extraLoad && latRatio > 0.93) {
        const scrubI = clamp((latRatio - 0.93) / 0.16, 0.12, 0.38);
        const outF = scrubI * 0.88, inF = scrubI * 0.38;
        const outR = scrubI * 1.00, inR = scrubI * 0.45;
        wTarget.fl = flIsInside ? inF : outF;
        wTarget.fr = flIsInside ? outF : inF;
        wTarget.rl = flIsInside ? inR : outR;
        wTarget.rr = flIsInside ? outR : inR;
      }
    }
  }

  if (!car.wSkid) {
    car.wSkid = { fl: 0, fr: 0, rl: 0, rr: 0 };
    car.wHold = { fl: 0, fr: 0, rl: 0, rr: 0 };
    car.wPeak = { fl: 0, fr: 0, rl: 0, rr: 0 };
  }
  const wSkid = car.wSkid, wHold = car.wHold, wPeak = car.wPeak;
  const curWheels = { fl, fr, rl, rr };
  let maxWheelSkid = 0;

  for (const k of ["fl", "fr", "rl", "rr"]) {
    const rawT = wTarget[k];
    if (rawT > 0) {
      wHold[k] = 0.085; // 85ms 热迟滞窗口：桥接 1~4 帧的阈值微抖，防止印迹碎裂成麻点
      wPeak[k] = rawT;
    } else if (wHold[k] > 0) {
      wHold[k] = Math.max(0, wHold[k] - dt);
    }
    const effTarget = rawT > 0
      ? rawT
      : (wHold[k] > 0 ? wPeak[k] * (wHold[k] / 0.085) * 0.72 : 0);

    const prevI = wSkid[k] || 0;
    // 起印升温快（~45ms），松刹回滚平滑（~95ms），天然形成两端尖、中间深的梭形点刹印
    let nextI = effTarget > prevI
      ? prevI + (effTarget - prevI) * Math.min(1, dt / 0.045)
      : prevI + (effTarget - prevI) * Math.min(1, dt / 0.095);
    if (nextI < 0.025 && effTarget === 0) nextI = 0;
    wSkid[k] = nextI;
    if (nextI > maxWheelSkid) maxWheelSkid = nextI;

    // 只要上一帧或本帧有滑移（prevI > 0 或 nextI > 0），就补全过渡段（确保收印末端平滑归零）
    if ((nextI > 0 || prevI > 0) && car.prevWheels && surf !== 2 && spd > 1) {
      const w = (k === "fl" || k === "fr") ? 0.32 : 0.42;
      const pw = car.prevWheels[k];
      const cw = curWheels[k];
      fx.addSkid(pw, cw, nextI, w, pw.h, cw.h, prevI);
    }
  }
  car.skidI = maxWheelSkid;
  car.prevWheels = curWheels;

  /* 草地尘土与抖动（横向侧滑时即使车速不高也会扬尘） */
  if (surf === 2 && (spd > 8 || Math.abs(car.slideV || 0) > 1.5)) {
    car.shake = Math.min(5, Math.max(spd * 0.06, Math.abs(car.slideV || 0) * 0.25));
    const a = Math.random() * Math.PI * 2, r = 0.8 + Math.random() * 1.4;
    fx.addDust(
      car.x - Math.cos(car.angle) * 2.2 + Math.cos(a) * r,
      car.y - Math.sin(car.angle) * 2.2 + Math.sin(a) * r,
      -Math.cos(car.angle) * 9 + Math.cos(a) * 7,
      -Math.sin(car.angle) * 9 + Math.sin(a) * 7,
      car.roadY || 0
    );
  } else {
    car.shake *= Math.pow(0.02, dt);
  }
}

// 赛车物理包围盒几何尺寸：长 5.6m、宽 2.0m（车头距中心 +2.8m，车尾 -2.8m）
export const CAR_LENGTH = 5.6;
export const CAR_WIDTH = 2.0;

/**
 * 计算两车之间的真实间距与车头车尾净空隙
 * @param {object} carA 观察车（后车视角）
 * @param {object} carB 目标车（前车视角）
 */
export function getCarDistance(carA, carB) {
  const dx = carB.x - carA.x;
  const dy = carB.y - carA.y;

  // 统一到"两车平均航向"坐标系：交换 A/B 时 sLon / dLat 严格取反，
  // 追尾 / 侧碰的判定不再取决于数组顺序。
  // （旧版把两车都投影到 carA 的航向，斜向接触时可能把后车判成前车，
  //   导致被追尾的一方反而承担 45% 的动量损失）
  let fx = Math.cos(carA.angle) + Math.cos(carB.angle);
  let fy = Math.sin(carA.angle) + Math.sin(carB.angle);
  const fl = Math.hypot(fx, fy);
  if (fl < 0.35) {
    // 近乎对头 / 对尾泊车：平均航向退化，退回 carA 航向（此时前后关系本就模糊）
    fx = Math.cos(carA.angle);
    fy = Math.sin(carA.angle);
  } else {
    fx /= fl;
    fy /= fl;
  }

  const sLon = dx * fx + dy * fy;   // 纵向距离：>0 表示 carB 在 carA 前方
  const dLat = -dx * fy + dy * fx;  // 侧向距离：垂直偏移

  // 车头到车尾真实净空隙（扣除各自 2.8m 车身半长，共 5.6m）
  const gapFrontRear = Math.abs(sLon) - CAR_LENGTH;
  // 车侧真实净侧隙（扣除各自 1.0m 车身半宽，共 2.0m）
  const gapLateral = Math.abs(dLat) - CAR_WIDTH;

  return { sLon, dLat, gapFrontRear, gapLateral, distCenter: Math.hypot(dx, dy) };
}

/**
 * 多车物理碰撞分离处理：防止车头穿透前车车尾、防止侧面穿模重叠
 *
 * 公平性原则（服务端权威模拟与单机共用）：
 * 1. 分离方向取两车中心连线（几何对称），不沿任何一方的车头方向推——
 *    避免攻击者把前车"顶"向自己的行进方向
 * 2. 前后接触（追尾）：后车承担全部动量损失；被撞车速度严格不变——
 *    旧版给前车加速 +25% 速度差，弯中被顶会超过弯道抓地极限滑出赛道，
 *    形成"后车弯中快速撞前车 → 前车上草地减速 → 被超越"的恶意超车漏洞
 * 3. 侧面并排：双方对称轻微摩擦
 */
export function resolveCarCollisions(cars) {
  if (!cars || cars.length <= 1) return;
  for (let i = 0; i < cars.length; i++) {
    for (let j = i + 1; j < cars.length; j++) {
      const a = cars[i];
      const b = cars[j];
      // 完赛车幽灵化：不参与碰撞，避免已冲线的车在赛道上堵住仍在跑的车
      if (a.finished || b.finished) continue;
      const geo = getCarDistance(a, b);

      // 只有在车长与车宽包围盒均重叠时发生接触
      if (geo.gapFrontRear >= 0 || geo.gapLateral >= 0) continue;

      // 分离方向：两车中心连线单位向量（对双方完全对称）
      const dx = b.x - a.x, dy = b.y - a.y;
      const dist = Math.hypot(dx, dy) || 1;
      const nx = dx / dist, ny = dy / dist;

      // 分离量：沿中心连线的较小穿透分量，比例递减保证收敛；上限防止单帧过冲
      const pen = Math.min(-geo.gapFrontRear, -geo.gapLateral);
      const push = Math.min(0.6, Math.max(0.04, pen * 0.6)) * 0.5;
      b.x += nx * push;
      b.y += ny * push;
      a.x -= nx * push;
      a.y -= ny * push;

      if (Math.abs(geo.sLon) >= Math.abs(geo.dLat)) {
        // 前后接触（追尾/顶撞）：动量损失全部由更快的一方（后车）承担
        const rearIsA = geo.sLon >= 0;   // sLon>0: b 在 a 前方 → a 是后车
        const rear = rearIsA ? a : b;
        const front = rearIsA ? b : a;
        if (rear.speed > front.speed) {
          const diff = rear.speed - front.speed;
          rear.speed -= diff * 0.45;
          // front.speed 保持不变：被追尾不加速（弯中不会超极限滑出）、不减速
        }
      } else {
        // 侧面并排擦碰：双方对称轻微摩擦阻尼
        a.speed *= 0.995;
        b.speed *= 0.995;
      }
    }
  }
}
