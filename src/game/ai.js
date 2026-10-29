// 自动驾驶算法集合：支持多车同场竞技与多算法对比
// 包含：
// 1. Apex Hunter（新一代算法：双前瞻曲率融合 + 循迹刹车 Trail-Braking + Apex 弹射出弯）
// 2. Vector Pursuit（动态向量流纯追踪）
// 3. Classic Baseline（完整保留原基准算法）
// 4. Smooth Cruiser Pro（时间最优闭环纵向规划 + 双前瞻融合转向 + 主动防撞脱困）

import { N, pts, nor, hw, tan, curvS, cumDist, onTrackChange, LAP_LENGTH, isLinear, currentTrackId, bank, grade } from "../track/geometry.js";
import { PHYS } from "../config.js";
import { clamp } from "../utils.js";
import { CAR_LENGTH, CAR_WIDTH, getCarDistance } from "../car/physics.js";
// Super Driver Pro（原 geminiDriver）已拆分到独立模块
import { geminiDriver, resetApexCapCache } from "./geminiDriver.js";
// 算法沙箱：driveAI 统一给 driver 传只读视图（玩家改不到游戏数值）
import { driverCarView, driverCarsView, perfAliasOf, DRIVER_THIS } from "./driverSandbox.js";

export let DS = LAP_LENGTH / Math.max(1, N);              // 采样点间距（米）

/* ================= 1. 赛车线：严格沥青走廊（杜绝蹭路肩减速带） ================= */
export let lineX = new Float32Array(0);
export let lineY = new Float32Array(0);
export let lineYaw = new Float32Array(0);
let corridor = new Float32Array(0);

/* ================= 2. 赛车线曲率 ================= */
export let rcurv = new Float32Array(0);
export let rcurvS = new Float32Array(0);
export let vTarget = new Float32Array(0);
const _cruiseCornerCapCache = new Map();   // Smooth Cruiser 弯速表缓存：按 perf 对象区分（不同车性能各自建表）
const _superCornerCapCache = new Map();    // superDriver 弯速表缓存（更高抓地利用率）

/* ================= 3. 目标速度表生成器（适配各车性能，支持 per-car 调优） ================= */
// opts: gripFactor 弯中抓地利用率（默认 0.78）、brakeFactor 刹车规划系数（默认 0.58）、
//       noBrakePlan=true 时跳过反向刹车传播（返回纯弯中极限速度表）
// data: 可选注入 { N, DS, rcurvS }（服务端上下文构建用）；缺省读全局激活赛道
export function buildCarVTarget(perf = {}, opts = {}, data = null) {
  const _N = data ? data.N : N;
  const _DS = data ? data.DS : DS;
  const _rcurvS = data ? data.rcurvS : rcurvS;
  const _bank = data ? data.bank : bank;
  const _grade = data ? data.grade : grade;
  const topSpeed = perf.maxSpeed ? perf.maxSpeed[0] : PHYS.maxSpeed[0];
  const latGrip = perf.latGrip ?? PHYS.latGrip;
  const maxOmega = perf.maxOmega ?? PHYS.maxOmega;
  const brakePlan = PHYS.brake * (perf.brakeMult ?? 1.0) * (opts.brakeFactor ?? 0.58);
  const A_LAT = latGrip
    * Math.min(1.0, (opts.gripFactor ?? 0.78) * (perf.cornerGripMult ?? 1));
  const vt = new Float32Array(_N);

  // 逐点有效侧向能力 / 制动能力：
  //  · 横坡（bank）与曲率同向（弯内侧低）时，重力提供 g·sinφ 的横向分量 → 弯速更高；
  //    同时法向载荷按 cosφ 略降。
  //  · 纵向坡度：下坡（grade<0）重力抵消制动，规划减速度变小 → 刹车点自动提前；
  //    上坡反之。线性赛道（grade 全 0）与原行为完全一致。
  const aLatArr = new Float32Array(_N);
  const brakeArr = new Float32Array(_N);
  for (let i = 0; i < _N; i++) {
    const b = _bank && _bank.length ? (_bank[i] || 0) : 0;
    const cosPhi = 1 / Math.sqrt(1 + b * b);
    aLatArr[i] = A_LAT * cosPhi + 9.81 * Math.abs(b) * cosPhi;
    const gHere = _grade && _grade.length ? (_grade[i] || 0) : 0;
    brakeArr[i] = Math.max(brakePlan * 0.3, brakePlan + 9.81 * gHere);
  }

  const w = Math.max(1, Math.round(30 / Math.max(0.1, _DS)));
  for (let i = 0; i < _N; i++) {
    let k = 0;
    for (let j = -w; j <= w; j++) {
      const c = Math.abs(_rcurvS[(i + j + _N) % _N]);
      if (c > k) k = c;
    }
    const R = k > 1e-5 ? 1 / k : 1e6;
    // 弯道极限速度：横向抓地上限 + 低速转向角速度上限（发卡弯）
    const vGrip = Math.sqrt(aLatArr[i] * R);
    const vOmega = k > 1e-5 ? maxOmega / k : Infinity;
    vt[i] = Math.min(topSpeed, vGrip, vOmega);
  }

  if (!opts.noBrakePlan) {
    // 反向传播刹车规划
    for (let pass = 0; pass < 2; pass++) {
      for (let i = _N - 1; i >= 0; i--) {
        const j = (i + 1) % _N;
        const v = Math.sqrt(vt[j] * vt[j] + 2 * brakeArr[j] * _DS);
        if (v < vt[i]) vt[i] = v;
      }
    }
  }
  return vt;
}

// 实时性能调校后调用：立即重建该车的目标速度表，并清掉按 perf 对象缓存的弯速表
// （三个 Cache 都以 perf 对象为键，原地改值不会失效，必须显式清除）
export function refreshCarPerf(car) {
  if (!car || !car.perf) return;
  car.vTarget = buildCarVTarget(car.perf);
  _cruiseCornerCapCache.delete(car.perf);
  _superCornerCapCache.delete(car.perf);
  resetApexCapCache();
}

/* ================= 3.5 AI 走线数据：按赛道上下文构建（纯函数 + 缓存） =================

服务端多房间场景：每条赛道的走线数据只计算一次（900 次平滑迭代较重），
按 trackId 缓存 bundle；激活新赛道时 rebuildAITrack 只是"换引用"，成本 O(1)。
*/
const _aiDataCache = new Map();      // trackId -> { DS, lineX, lineY, lineYaw, rcurv, rcurvS, vTarget }

// 依据赛道上下文构建全套 AI 走线数据（不修改任何模块状态，可安全并发调用）
export function buildAIData(ctx) {
  const hit = _aiDataCache.get(ctx.id);
  if (hit) return hit;

  const cN = ctx.N, cPts = ctx.pts, cNor = ctx.nor, cHw = ctx.hw;
  const cLinear = ctx.isLinear;
  // 线性赛道的沥青可能延伸到冲线缓冲区之后（如 dragstrip），
  // 点间距必须按真实折线长度计算，否则 AI 的前瞻/扫描距离会整体失真
  const cDS = cLinear
    ? ctx.cumDist[cN - 1] / Math.max(1, cN - 1)
    : ctx.LAP_LENGTH / cN;

  const cLineX = new Float32Array(cN);
  const cLineY = new Float32Array(cN);
  const cLineYaw = new Float32Array(cN);
  const corridor = new Float32Array(cN);

  for (let i = 0; i < cN; i++) {
    cLineX[i] = cPts[i].x;
    cLineY[i] = cPts[i].y;
    corridor[i] = Math.max(0, cHw[i] - 3.4);
  }

  for (let it = 0; it < 900; it++) {
    for (let i = 0; i < cN; i++) {
      const a = (i - 1 + cN) % cN, b = (i + 1) % cN;
      const mx = (cLineX[a] + cLineX[b]) * 0.5;
      const my = (cLineY[a] + cLineY[b]) * 0.5;
      const off = clamp((mx - cPts[i].x) * cNor[i].x + (my - cPts[i].y) * cNor[i].y,
        -corridor[i], corridor[i]);
      cLineX[i] = cPts[i].x + cNor[i].x * off;
      cLineY[i] = cPts[i].y + cNor[i].y * off;
    }
  }

  for (let i = 0; i < cN; i++) {
    const b = (i + 1) % cN;
    cLineYaw[i] = Math.atan2(cLineY[b] - cLineY[i], cLineX[b] - cLineX[i]);
  }

  const cRcurv = new Float32Array(cN);
  for (let i = 0; i < cN; i++) {
    const a = (i - 1 + cN) % cN, b = (i + 1) % cN;
    const v1x = cLineX[i] - cLineX[a], v1y = cLineY[i] - cLineY[a];
    const v2x = cLineX[b] - cLineX[i], v2y = cLineY[b] - cLineY[i];
    const l1 = Math.hypot(v1x, v1y), l2 = Math.hypot(v2x, v2y);
    cRcurv[i] = Math.atan2(v1x * v2y - v1y * v2x, v1x * v2x + v1y * v2y)
      / ((l1 + l2) * 0.5 || 1);
  }

  const cRcurvS = new Float32Array(cN);
  for (let i = 0; i < cN; i++) {
    let s = 0;
    for (let k = -5; k <= 5; k++) s += cRcurv[(i + k + cN) % cN];
    cRcurvS[i] = s / 11;
  }

  const bundle = {
    DS: cDS, lineX: cLineX, lineY: cLineY, lineYaw: cLineYaw, rcurv: cRcurv, rcurvS: cRcurvS,
    vTarget: buildCarVTarget({}, {}, {
      N: cN, DS: cDS, rcurvS: cRcurvS, bank: ctx.bank, grade: ctx.grade
    }),
  };
  _aiDataCache.set(ctx.id, bundle);
  return bundle;
}

export function rebuildAITrack() {
  if (N <= 0) return;
  const b = buildAIData({
    id: currentTrackId, N, pts, nor, hw, cumDist, LAP_LENGTH, isLinear, bank, grade
  });
  DS = b.DS;
  lineX = b.lineX;
  lineY = b.lineY;
  lineYaw = b.lineYaw;
  rcurv = b.rcurv;
  rcurvS = b.rcurvS;
  vTarget = b.vTarget;
  // 弯速表缓存均为 "perf + 赛道 id" 双键，切换赛道无需清空（多房间/多赛道安全）
}

// 自动响应赛道切换
onTrackChange(rebuildAITrack);
rebuildAITrack();

export function createAIInput() {
  return {
    up: false, brake: 0, left: false, right: false,
    steer: 0, _pwm: 0, _stuck: 0,
    targetX: 0, targetY: 0, targetSpeed: 0
  };
}

export const AI_RESTART_DELAY = 4500;

export function wrapAngle(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

/* ================= 4. 多车前车探测、抽头避让与自动超车系统 ================= */
export function evaluateTrafficAndOvertake(car, otherCars, ti, dt) {
  const result = {
    targetX: lineX[ti],
    targetY: lineY[ti],
    shouldSlow: false,
    speedCap: Infinity,
    steerBias: 0,
    emergencyBrake: false,
    isOvertaking: false
  };

  if (!otherCars || otherCars.length <= 1) {
    if (car._latOffset) car._latOffset *= Math.max(0, 1 - dt * 4);
    return result;
  }

  const idx = car.nearIdx % N;
  const baseLat = (lineX[ti] - pts[ti].x) * nor[ti].x + (lineY[ti] - pts[ti].y) * nor[ti].y;
  const maxLat = hw[ti] - 2.2;
  const minLat = -hw[ti] + 2.2;

  let targetLead = null;
  let minTrackDist = Infinity;
  let leadGeo = null;

  for (let i = 0; i < otherCars.length; i++) {
    const o = otherCars[i];
    if (o === car) continue;

    // 计算沿赛道中心线的前方采样点步数与米数
    // 线性赛道不回绕：负数即在后方（否则首尾车会互相误判为近距离前车）
    const oIdx = o.nearIdx % N;
    const forwardSteps = isLinear
      ? oIdx - idx
      : (oIdx - idx + N) % N;
    const geo = getCarDistance(car, o);

    // 探测前方 0~35 米内或前后 6 米内并排的赛车
    const isAheadOnTrack = (forwardSteps > 0 && forwardSteps < Math.round(35 / DS));
    const isAlongside = (Math.abs(geo.sLon) < CAR_LENGTH + 1.2 && geo.distCenter < 12);

    if (isAheadOnTrack || isAlongside) {
      if (geo.sLon > -CAR_LENGTH && geo.distCenter < minTrackDist) {
        minTrackDist = geo.distCenter;
        targetLead = o;
        leadGeo = geo;
      }
    }
  }

  if (targetLead && leadGeo) {
    const leadIdx = targetLead.nearIdx % N;
    const leadLat = (targetLead.x - pts[leadIdx].x) * nor[leadIdx].x + (targetLead.y - pts[leadIdx].y) * nor[leadIdx].y;

    // 超车走线规划：至少与前车拉开 2.7 米横向净空 (车宽 2.0m + 0.7m 侧向安全余量)
    const candLeft = leadLat + 2.7;
    const candRight = leadLat - 2.7;
    const canLeft = (candLeft <= maxLat);
    const canRight = (candRight >= minLat);

    let chosenLat = baseLat;
    if (canLeft && canRight) {
      // 两侧空间均充裕时：弯道优先切入内线晚刹超车，直道依前车走线切空档
      const c = curvS[ti];
      if (c > 0.006) {
        chosenLat = candLeft;  // 左弯切左侧内线
      } else if (c < -0.006) {
        chosenLat = candRight; // 右弯切右侧内线
      } else {
        // 直道根据前车偏向选择空间更大的一侧
        chosenLat = (leadGeo.dLat >= 0) ? candRight : candLeft;
      }
    } else if (canLeft) {
      chosenLat = candLeft;
    } else if (canRight) {
      chosenLat = candRight;
    } else {
      chosenLat = (maxLat - leadLat > leadLat - minLat) ? maxLat : minLat;
    }

    const targetOvertakeLat = clamp(chosenLat, minLat, maxLat);
    const desiredOffset = targetOvertakeLat - baseLat;
    car._latOffset = (car._latOffset || 0) + (desiredOffset - (car._latOffset || 0)) * Math.min(1, dt * 6.0);

    // 速度与刹车判定
    const lateralClear = leadGeo.gapLateral >= 0.25;
    const isVeryClose = leadGeo.gapFrontRear < 5.0;

    if (!lateralClear && isVeryClose && leadGeo.sLon > 0) {
      // 同车道尾随过近：控速防撞
      result.shouldSlow = true;
      result.speedCap = Math.max(0, targetLead.speed * 0.97);
      if (leadGeo.gapFrontRear < 1.0 && car.speed > targetLead.speed) {
        result.emergencyBrake = true;
      }
    } else {
      // 侧向已抽头或已在前方：完全解除限速，全油门超越
      result.shouldSlow = false;
      result.speedCap = Infinity;
    }

    // 并排时的车体防挤碰微调
    if (Math.abs(leadGeo.sLon) < CAR_LENGTH && leadGeo.gapLateral < 0.25) {
      result.steerBias = (leadGeo.dLat > 0 ? -0.14 : 0.14) * Math.max(0, (0.25 - leadGeo.gapLateral) / 0.25);
    }
  } else {
    // 前方无车阻挡：平滑回归最佳赛车线
    car._latOffset = (car._latOffset || 0) * Math.max(0, 1 - dt * 3.5);
  }

  const finalLat = clamp(baseLat + (car._latOffset || 0), minLat, maxLat);
  result.targetX = pts[ti].x + nor[ti].x * finalLat;
  result.targetY = pts[ti].y + nor[ti].y * finalLat;
  result.isOvertaking = Math.abs(car._latOffset || 0) > 0.6;

  return result;
}
/* ================= 算法 1：Apex Hunter (新一代双前瞻曲率融合 + 循迹刹车 Trail-Braking) ================= */
export function driveApexHunter(car, out, dt, otherCars) {
  const idx = car.nearIdx % N;
  const v = Math.abs(car.speed);
  const perf = car.perf || {};
  const latGrip = perf.latGrip ?? PHYS.latGrip;
  const maxOmega = perf.maxOmega ?? PHYS.maxOmega;
  const vtTable = car.vTarget || vTarget;

  // 双前瞻融合：近程前瞻纠偏贴紧路线，远程前瞻提前预瞄弯道曲率
  const lookNear = Math.max(9, v * 0.45);
  const lookFar = Math.min(88, 16 + v * 0.75);

  const iNear = (idx + Math.round(lookNear / DS)) % N;
  const iFar = (idx + Math.round(lookFar / DS)) % N;

  const tr = evaluateTrafficAndOvertake(car, otherCars, iFar, dt);

  const baseLatN = (lineX[iNear] - pts[iNear].x) * nor[iNear].x + (lineY[iNear] - pts[iNear].y) * nor[iNear].y;
  const latN = clamp(baseLatN + (car._latOffset || 0), -hw[iNear] + 2.2, hw[iNear] - 2.2);
  const dxN = pts[iNear].x + nor[iNear].x * latN - car.x;
  const dyN = pts[iNear].y + nor[iNear].y * latN - car.y;

  const dxF = tr.targetX - car.x, dyF = tr.targetY - car.y;

  const aN = wrapAngle(Math.atan2(dyN, dxN) - car.angle);
  const aF = wrapAngle(Math.atan2(dyF, dxF) - car.angle);

  // 融合权重
  const alpha = aF * 0.58 + aN * 0.42;
  const dist = (Math.hypot(dxF, dyF) + Math.hypot(dxN, dyN)) * 0.5 || 1;

  const kappa = 2 * Math.sin(alpha) / dist;
  const omegaMax = Math.min(latGrip / Math.max(v, 1), maxOmega) * Math.min(1, v / 3);
  const dutyRaw = Math.max(-1, Math.min(1, (v * kappa) / (omegaMax || 1)));

  const duty = clamp(dutyRaw + tr.steerBias, -1, 1);

  out.steer = (out.steer || 0) + (duty - (out.steer || 0)) * Math.min(1, dt * 26);
  out.left = out.steer < -0.05;
  out.right = out.steer > 0.05;

  // 循迹刹车 (Trail-Braking) 控制
  const iAhead = (idx + Math.round(12 / DS)) % N;
  let vt = Math.min(vtTable[idx], vtTable[iAhead]);
  if (tr.shouldSlow && tr.speedCap < vt) {
    vt = tr.speedCap;
  }

  const gap = v - vt;
  const steerMag = Math.abs(out.steer);

  if (tr.emergencyBrake) {
    out.brake = 2;
  } else if (gap > 4.5) {
    out.brake = 2; // 入弯前重刹
  } else if (gap > 0.8) {
    // 循迹刹车：转弯加大时逐步释放刹车，靠前轴载荷切入 Apex
    out.brake = steerMag > 0.6 ? 1 : (gap > 2.0 ? 2 : 1);
  } else {
    out.brake = 0;
  }

  // Apex 提前出弯弹射
  if (tr.emergencyBrake) {
    out.up = false;
  } else if (Math.abs(alpha) < 0.22 && gap < 1.0 && !tr.shouldSlow) {
    out.up = true;
    out.brake = 0;
  } else {
    out.up = out.brake === 0 && gap < -0.3;
  }

  out.targetX = tr.targetX;
  out.targetY = tr.targetY;
  out.targetSpeed = vt;
}

/* ================= 算法 2：Verstappen Pursuit / Apex Predator (维斯塔潘激进极限制胜流) ================= */
export function driveVectorPursuit(car, out, dt, otherCars) {
  const idx = car.nearIdx % N;
  const v = Math.abs(car.speed);
  const perf = car.perf || {};
  const latGrip = perf.latGrip ?? PHYS.latGrip;
  const maxOmega = perf.maxOmega ?? PHYS.maxOmega;
  const vtTable = car.vTarget || vTarget;

  // 维斯塔潘自适应激进前瞻：直道长距离预瞄高尾速，弯道紧致贴紧 Apex 走线
  const isCurving = Math.abs(curvS[idx]) > 0.008;
  const look = clamp(11 + v * (isCurving ? 0.48 : 0.68), 10, 88);
  const ti = Math.floor((idx + look / DS) % N);
  const tr = evaluateTrafficAndOvertake(car, otherCars, ti, dt);

  const dx = tr.targetX - car.x, dy = tr.targetY - car.y;
  const dist = Math.hypot(dx, dy) || 1;
  const alpha = wrapAngle(Math.atan2(dy, dx) - car.angle);

  const kappa = 2 * Math.sin(alpha) / Math.max(dist, 1);
  const omegaMax = Math.min(maxOmega, latGrip / Math.max(v, 1)) * Math.min(1, v / 3);
  const omegaDes = clamp(v * kappa, -omegaMax, omegaMax);
  const dutyRaw = omegaMax > 1e-4 ? omegaDes / omegaMax : 0;

  const duty = clamp(dutyRaw + tr.steerBias, -1, 1);

  // 极度敏锐的方向盘转角响应速度 (dt * 26)
  out.steer = (out.steer || 0) + (duty - (out.steer || 0)) * Math.min(1, dt * 26);
  out.left = out.steer < -0.04;
  out.right = out.steer > 0.04;

  // 维斯塔潘式极限定点晚刹车
  let vt = vtTable[idx];
  if (tr.shouldSlow && tr.speedCap < vt) {
    vt = tr.speedCap;
  }

  const gap = v - vt;
  const steerMag = Math.abs(out.steer);

  if (tr.emergencyBrake) {
    out.brake = 2;
  } else if (gap > 4.8) {
    out.brake = 2; // 入弯极限重刹
  } else if (gap > 1.2) {
    // 循迹刹车 (Trail-Braking)：进弯切入时随方向盘转角逐步释放刹车，靠前轴载荷咬住内线弯心
    out.brake = steerMag > 0.5 ? 1 : (gap > 3.0 ? 2 : 1);
  } else {
    out.brake = 0;
  }

  // 维斯塔潘标志性激进出弯开油 (Early Apex Launch)：
  // 车头对准弯道出口 (alpha 小)，果断全油门弹射出弯
  if (tr.emergencyBrake) {
    out.up = false;
  } else if (Math.abs(alpha) < 0.24 && gap < 1.2 && !tr.shouldSlow) {
    out.up = true;
    out.brake = 0;
  } else {
    out.up = out.brake === 0 && gap < 0.2;
  }

  out.targetX = tr.targetX;
  out.targetY = tr.targetY;
  out.targetSpeed = vt;
}

/* ================= 算法 3：Classic Baseline (完整保留原经典基准算法) ================= */
export function driveClassicBaseline(car, out, dt, otherCars) {
  const idx = car.nearIdx % N;
  const v = Math.abs(car.speed);
  const perf = car.perf || {};
  const latGrip = perf.latGrip ?? PHYS.latGrip;
  const maxOmega = perf.maxOmega ?? PHYS.maxOmega;
  const vtTable = car.vTarget || vTarget;

  // 原始离散纯追踪 + PWM 转向特征
  const look = clamp(9 + v * 0.62, 9, 85);
  const ti = (idx + Math.round(look / DS)) % N;
  const tr = evaluateTrafficAndOvertake(car, otherCars, ti, dt);

  const dx = tr.targetX - car.x, dy = tr.targetY - car.y;
  const dist = Math.hypot(dx, dy) || 1;
  const alpha = wrapAngle(Math.atan2(dy, dx) - car.angle);

  const kappa = 2 * Math.sin(alpha) / Math.max(dist, 1);
  const omegaMax = Math.min(maxOmega, latGrip / Math.max(v, 1)) * Math.min(1, v / 3);
  const omegaDes = clamp(v * kappa, -omegaMax, omegaMax);
  const duty = clamp((omegaMax > 1e-4 ? omegaDes / omegaMax : 0) + tr.steerBias, -1, 1);

  // 原始 PWM
  out._pwm += Math.abs(duty);
  const fire = out._pwm >= 1;
  if (fire) out._pwm -= 1;
  const steer = fire && Math.abs(duty) > 0.005;
  out.left = steer && duty < 0;
  out.right = steer && duty > 0;
  out.steer = duty;

  // 原始分段纵向控制
  const i2 = (idx + Math.round(10 / DS)) % N;
  let vt = Math.min(vtTable[idx], vtTable[i2]);
  if (tr.shouldSlow && tr.speedCap < vt) {
    vt = tr.speedCap;
  }

  const gap = v - vt;
  if (tr.emergencyBrake) {
    out.brake = 2;
  } else if (gap > 5) {
    out.brake = 2;
  } else if (gap > 1.2) {
    out.brake = 1;
  } else {
    out.brake = 0;
  }

  if (out.brake === 0 && Math.abs(duty) > 0.92 && gap > -2) out.brake = 1;
  out.up = !tr.emergencyBrake && out.brake === 0 && gap < -0.4;

  out.targetX = tr.targetX;
  out.targetY = tr.targetY;
  out.targetSpeed = vt;
}

/* ================= 算法 4：Smooth Cruiser Pro（时间最优闭环纵向规划 + 双前瞻融合转向 + 主动防撞脱困） ================= */

// 双键缓存读取：perf 对象 + 当前赛道 id（服务端多赛道上下文切换互不污染）
// perfAliasOf：算法手里拿到的是 car.perf 的只读视图，这里归一化回真 perf，
// 保证"算法查表"和"引擎查表"共用同一张表（否则每辆车会建两张，调校后也不刷新）
function trackCacheGet(cache, perf, build) {
  const key = perfAliasOf(perf);
  let byTrack = cache.get(key);
  if (!byTrack) { byTrack = new Map(); cache.set(key, byTrack); }
  let cap = byTrack.get(currentTrackId);
  if (!cap) { cap = build(); byTrack.set(currentTrackId, cap); }
  return cap;
}

// Smooth Cruiser Pro 弯中极限速度表：不含刹车传播的纯弯速上限，配合逐帧闭环刹车规划使用。
// 按 perf 对象缓存（F1/电车各自建表），避免不同性能车辆串用同一张弯速表
function getCruiseCornerCap(perf) {
  return trackCacheGet(_cruiseCornerCapCache, perf, () => buildCarVTarget(perf, {
    gripFactor: 0.92,     // 弯中抓地利用率 92%（满舵仍留 8% 余量纠偏）
    brakeFactor: 0.92,
    noBrakePlan: true
  }));
}

// superDriver 专用弯速表：更高抓地利用率（96%），仅留 4% 余量做微小纠偏
// 物理模型无驱动/转向联合摩擦损失，可以更激进地吃满抓地极限
export function getSuperCornerCap(perf) {
  return trackCacheGet(_superCornerCapCache, perf, () => buildCarVTarget(perf, {
    gripFactor: 0.96,     // ★ 弯中抓地利用率 96%（仅 4% 余量 → 每个弯快 1-2 km/h）
    brakeFactor: 0.95,    // ★ 刹车规划利用率 95%
    noBrakePlan: true
  }));
}

export function driveSmoothCruiser(car, out, dt, otherCars) {
  const idx = car.nearIdx % N;
  const v = Math.abs(car.speed);
  const perf = car.perf || {};
  const latGrip = perf.latGrip ?? PHYS.latGrip;
  const maxOmega = perf.maxOmega ?? PHYS.maxOmega;
  const cornerCap = getCruiseCornerCap(perf);

  if (car._cruiseStuck == null) {
    car._cruiseStuck = 0; car._cruiseRev = 0; car._cruiseMoved = false;
    car._cruiseOTSide = 0; car._cruiseOTUntil = 0; car._cruiseBlockT = 0;
  }

  /* ---- 脱困：碰撞受困后自动倒车脱身 ---- */
  if (car._cruiseRev > 0) {
    car._cruiseRev -= dt;
    out.up = false; out.brake = 2; out.steer = 0; out.left = false; out.right = false;
    if (car._cruiseRev <= 0) car._cruiseStuck = 0;
    return;
  }
  if (v > 3) car._cruiseMoved = true;
  // 只在曾起步成功后才有"受困"概念，避免发车倒计时误判
  if (car._cruiseMoved) {
    if (v < 1.5) car._cruiseStuck += dt;
    else car._cruiseStuck = Math.max(0, car._cruiseStuck - dt * 2);
    if (car._cruiseStuck > 2.5) { car._cruiseRev = 0.9; return; }
  }

  /* ---- 转向：双前瞻融合纯追踪（近点贴线纠偏 + 远点战术走线/超车目标） ---- */
  const lookNear = Math.max(10, v * 0.45);
  const lookFar = Math.min(88, 16 + v * 0.75);
  const iNear = (idx + Math.round(lookNear / DS)) % N;
  const iFar = (idx + Math.round(lookFar / DS)) % N;
  const tr = evaluateTrafficAndOvertake(car, otherCars, iFar, dt);

  /* ---- 超车状态机：竞争目标锁定 + 抽头方向锁定 + 被堵升级进攻 ---- */
  let rival = null, rivalGeo = null;
  if (otherCars && otherCars.length > 1) {
    for (let i = 0; i < otherCars.length; i++) {
      const o = otherCars[i];
      if (o === car) continue;
      const geo = getCarDistance(car, o);
      if (geo.sLon > -CAR_LENGTH && geo.sLon < 60 && geo.distCenter < 40) {
        if (!rival || geo.sLon < rivalGeo.sLon) { rival = o; rivalGeo = geo; }
      }
    }
  }
  // 方向锁定 2.5s：抽头一旦成形，远点目标换侧也不再跟着摇摆，坚决完成这一次超车
  if (car._cruiseOTUntil > 0) {
    car._cruiseOTUntil -= dt;
    if (car._cruiseOTUntil <= 0) car._cruiseOTSide = 0;
  }
  const otOffset = car._latOffset || 0;
  if (!car._cruiseOTSide && rival && Math.abs(otOffset) > 0.8) {
    car._cruiseOTSide = Math.sign(otOffset);
    car._cruiseOTUntil = 2.5;
  }
  // 被堵判定：正前方贴着一辆明显慢于我弯速潜力的车
  const blocked = !!(rival && rivalGeo.sLon > 2.0 && rivalGeo.gapFrontRear < 8
    && Math.abs(rivalGeo.dLat) < CAR_WIDTH + 1.2
    && cornerCap[idx] > rival.speed + 2.0);
  car._cruiseBlockT = blocked ? (car._cruiseBlockT || 0) + dt
    : Math.max(0, (car._cruiseBlockT || 0) - dt * 2);
  const attacking = (car._cruiseBlockT || 0) > 1.2;

  const baseLatN = (lineX[iNear] - pts[iNear].x) * nor[iNear].x + (lineY[iNear] - pts[iNear].y) * nor[iNear].y;
  const latN = clamp(baseLatN + (car._latOffset || 0), -hw[iNear] + 2.2, hw[iNear] - 2.2);
  const dxN = pts[iNear].x + nor[iNear].x * latN - car.x;
  const dyN = pts[iNear].y + nor[iNear].y * latN - car.y;
  const dxF = tr.targetX - car.x, dyF = tr.targetY - car.y;

  const aN = wrapAngle(Math.atan2(dyN, dxN) - car.angle);
  const aF = wrapAngle(Math.atan2(dyF, dxF) - car.angle);

  // 融合权重偏近点：转向响应慢的底盘需要更强的贴线闭环来抑制走线漂移
  const alpha = aF * 0.55 + aN * 0.45;
  const dist = (Math.hypot(dxF, dyF) + Math.hypot(dxN, dyN)) * 0.5 || 1;
  const kappa = 2 * Math.sin(alpha) / dist;
  const omegaMax = Math.min(latGrip / Math.max(v, 1), maxOmega) * Math.min(1, v / 3);
  let duty = clamp((v * kappa) / (omegaMax || 1), -1, 1);

  /* ---- 主动侧向防撞（第二道防线）：与任意车并排过近时向空侧弹开 ---- */
  let guard = 0, sideSqueeze = false;
  if (otherCars && otherCars.length > 1) {
    for (let i = 0; i < otherCars.length; i++) {
      const o = otherCars[i];
      if (o === car) continue;
      const geo = getCarDistance(car, o);
      if (Math.abs(geo.sLon) < CAR_LENGTH + 2.0 && Math.abs(geo.dLat) < CAR_WIDTH + 1.4) {
        if (geo.gapLateral < 0.55) sideSqueeze = true;
        guard += geo.dLat >= 0 ? -1 : 1;   // 对方在我左侧 → 向右让
      }
    }
  }
  if (guard !== 0) duty = clamp(duty + Math.sign(guard) * 0.20, -1, 1);
  duty = clamp(duty + tr.steerBias, -1, 1);

  out.steer = (out.steer || 0) + (duty - (out.steer || 0)) * Math.min(1, dt * 24);
  out.left = out.steer < -0.05;
  out.right = out.steer > 0.05;

  /* ---- 纵向：时间最优闭环刹车规划 ----
     逐帧扫描前方可达速度包络：对前方每个弯中限速点 j，
     求恰好能以可用减速度减速到该限速的当前最大车速，取最小值。
     等价于"最晚刹车点"的连续解，比离散步长的查表规划更贴近时间最优。 */
  // 当前坡度修正：下坡（grade<0）重力抵消制动 → 规划/兜底减速度变小（刹车点提前）；
  // 上坡相反。坡度只影响纵向能力，横向抓地仍由 cornerCap 的 bank 项处理。
  const baseBrake = PHYS.brake * (perf.brakeMult ?? 1.0);  // 真实重刹减速度 ≈66.5 m/s²（全场最强）
  const brakeCap = Math.max(baseBrake * 0.5, baseBrake + 9.81 * (grade[idx] || 0));
  const lightCap = brakeCap * PHYS.lightBrakeFactor;      // 轻刹减速度 ≈29.9 m/s²
  // 预瞄窗口自适应：极速越高、制动越弱的车需要看得越远
  // （Vmax 496km/h 的电车从尾速刹到弯速需 460m+，固定 320m 会导致高速末段刹车规划失真）
  const scanCapM = Math.max(320, v * v / (2 * brakeCap) + 80);
  const scanSteps = Math.min(Math.round((v * v / (2 * lightCap) + 80) / DS), Math.round(scanCapM / DS));
  // env1：轻刹可持续包络（在其上做 coast/轻刹 duty-cycle 调制，等效任意所需减速度）
  // env2：全刹物理极限包络（安全兜底线）
  let env1 = cornerCap[idx], env2 = cornerCap[idx], aReq = 0;
  for (let s = 1; s <= scanSteps; s += (s < 40 ? 1 : 2)) {
    const j = (idx + s) % N;
    const d = s * DS;
    const cap = cornerCap[j];
    if (cap < v) {
      const req = (v * v - cap * cap) / (2 * d);
      if (req > aReq) aReq = req;
    }
    const r1 = Math.sqrt(cap * cap + 2 * lightCap * d);
    // 全刹兜底包络按【目标点】坡度修正：跑到下坡段时制动能力下降，包络自然收窄
    const brakeJ = Math.max(baseBrake * 0.5, baseBrake + 9.81 * (grade[j] || 0));
    const r2 = Math.sqrt(cap * cap + 2 * brakeJ * 0.98 * d);
    if (r1 < env1) env1 = r1;
    if (r2 < env2) env2 = r2;
  }

  /* ---- 晚刹强攻（Dive Pass）：已抽头到并排位、入弯贴身时，
     凭借全场最强刹车直接按物理极限包络晚刹，从内线/外线强行完成超越。
     注意：本物理模型侧面擦蹭惩罚极重（每帧 speed*0.985），混战中易两败俱伤，默认关闭 ---- */
  const DIVE_ENABLE = false;
  const dive = DIVE_ENABLE && !!(rival && rivalGeo.sLon < 14 && rivalGeo.sLon > -3
    && Math.abs(car._latOffset || 0) > 1.2 && Math.abs(rivalGeo.dLat) > 2.4);
  // 晚刹包络：物理极限与"当前弯速上限 +3%"取小，防止入弯过快推头
  const envGo = dive ? Math.min(env2, cornerCap[idx] * 1.03) : env1;

  /* ---- 跟车与避撞速度约束：按净空隙 + 相对速度解算精确跟随上限 ---- */
  let emergency = tr.emergencyBrake;
  if (otherCars && otherCars.length > 1) {
    for (let i = 0; i < otherCars.length; i++) {
      const o = otherCars[i];
      if (o === car) continue;
      const geo = getCarDistance(car, o);
      if (geo.sLon <= 0 || geo.sLon > 55) continue;
      if (Math.abs(geo.dLat) > CAR_WIDTH + 0.9) continue;  // 横向已净空：抽头超车全油门，不设限
      const gap = geo.gapFrontRear;
      const closing = v - o.speed;
      // 紧急制动仅针对正前方无横向净空的追尾风险（并排有 0.35m 侧隙时不触发，交由侧向防线）
      if (gap < 1.0 && closing > 0.5 && geo.sLon > 2.0
        && Math.abs(geo.dLat) < CAR_WIDTH + 0.35) { emergency = true; break; }
      // 恰好能在前车车尾前收刹到前车速度的最大允许车速（进攻模式贴得更近换超车动能）
      const safeGap = Math.max(gap - (attacking ? 1.2 : 1.8), 0.4);
      const followCap = Math.sqrt(o.speed * o.speed + 2 * brakeCap * 0.90 * safeGap)
        + closing * 0.12;
      if (followCap < env1) env1 = followCap;
      if (followCap < env2) env2 = followCap;
    }
  }
  // 被堵跟车限速：已承诺超车（方向锁定中）时解除，保持进攻节奏
  if (tr.shouldSlow && !car._cruiseOTSide && tr.speedCap < env1) {
    env1 = tr.speedCap;
    env2 = Math.min(env2, tr.speedCap);
  }

  /* ---- 分档执行：双包络 Bang-Bang + 轻刹 duty-cycle 调制 ---- */
  if (emergency) {
    out.brake = 2;
  } else if (!dive && aReq > lightCap * 1.05) {
    out.brake = 2;                                        // 轻刹已不足以维持最优刹车线 → 直接重刹
  } else if (v > env2 + 0.3) {
    out.brake = 2;                                        // 逼近物理极限包络：安全兜底重刹
  } else if (v > envGo + 0.2) {
    out.brake = 1;                                        // 包络上的调制：与滑行交替等效所需减速度
  } else {
    out.brake = 0;                                        // 滑行/滑行与油门交替
  }
  // 并排擦蹭惩罚极重（每帧 speed*0.985），宁可转向分离也不收油损失动能：
  // 挤压时由侧向防线（guard）与超车目标（tr）共同完成走线分离，不额外刹车
  // 本物理模型无驱动/转向联合摩擦损失：只要未触及当前弯速上限即全油门（含弯中），时间最优
  out.up = !emergency && out.brake === 0 && v < cornerCap[idx] - 0.2;

  out.targetX = tr.targetX;
  out.targetY = tr.targetY;
  out.targetSpeed = env1;
}

export function superDriver(car, out, dt, otherCars) {
  const idx = car.nearIdx % N;
  const v = Math.abs(car.speed);
  const perf = car.perf || {};
  const latGrip = perf.latGrip ?? PHYS.latGrip;
  const maxOmega = perf.maxOmega ?? PHYS.maxOmega;
  const cornerCap = getSuperCornerCap(perf);

  if (car._cruiseStuck == null) {
    car._cruiseStuck = 0; car._cruiseRev = 0; car._cruiseMoved = false;
    car._cruiseOTSide = 0; car._cruiseOTUntil = 0; car._cruiseBlockT = 0;
  }

  /* ---- 脱困：碰撞受困后自动倒车脱身 ---- */
  if (car._cruiseRev > 0) {
    car._cruiseRev -= dt;
    out.up = false; out.brake = 2; out.steer = 0; out.left = false; out.right = false;
    if (car._cruiseRev <= 0) car._cruiseStuck = 0;
    return;
  }
  if (v > 3) car._cruiseMoved = true;
  if (car._cruiseMoved) {
    if (v < 1.5) car._cruiseStuck += dt;
    else car._cruiseStuck = Math.max(0, car._cruiseStuck - dt * 2);
    if (car._cruiseStuck > 2.5) { car._cruiseRev = 0.9; return; }
  }

  /* ---- ★ 转向：曲率自适应三段前瞻融合 ---- */
  // 当前位置曲率强度 → 弯中缩短近点前瞻紧贴赛车线，直道拉长远点前瞻平滑预判
  const curvHere = Math.abs(curvS[idx]);
  const inCorner = curvHere > 0.008;
  const cornerIntensity = clamp((curvHere - 0.008) / 0.025, 0, 1); // 0=直道 1=急弯

  // 近点前瞻：弯中缩短（更紧贴 Apex），直道拉长（平滑无振荡）
  const lookNear = Math.max(8, v * (inCorner ? 0.35 : 0.50));
  // 远点前瞻：弯中缩短（避免看太远切线偏移），直道拉长（入弯预判）
  const lookFar  = Math.min(95, (inCorner ? 14 : 18) + v * (inCorner ? 0.55 : 0.80));
  // 中段前瞻：弯心到出弯过渡段（平滑出弯曲率变化）
  const lookMid  = (lookNear + lookFar) * 0.5;

  const iNear = (idx + Math.round(lookNear / DS)) % N;
  const iFar  = (idx + Math.round(lookFar  / DS)) % N;
  const iMid  = (idx + Math.round(lookMid  / DS)) % N;
  const tr = evaluateTrafficAndOvertake(car, otherCars, iFar, dt);

  /* ---- 超车状态机：竞争目标锁定 + 抽头方向锁定 + 被堵升级进攻 ---- */
  let rival = null, rivalGeo = null;
  if (otherCars && otherCars.length > 1) {
    for (let i = 0; i < otherCars.length; i++) {
      const o = otherCars[i];
      if (o === car) continue;
      const geo = getCarDistance(car, o);
      if (geo.sLon > -CAR_LENGTH && geo.sLon < 60 && geo.distCenter < 40) {
        if (!rival || geo.sLon < rivalGeo.sLon) { rival = o; rivalGeo = geo; }
      }
    }
  }
  if (car._cruiseOTUntil > 0) {
    car._cruiseOTUntil -= dt;
    if (car._cruiseOTUntil <= 0) car._cruiseOTSide = 0;
  }
  const otOffset = car._latOffset || 0;
  if (!car._cruiseOTSide && rival && Math.abs(otOffset) > 0.8) {
    car._cruiseOTSide = Math.sign(otOffset);
    car._cruiseOTUntil = 2.5;
  }
  const blocked = !!(rival && rivalGeo.sLon > 2.0 && rivalGeo.gapFrontRear < 8
    && Math.abs(rivalGeo.dLat) < CAR_WIDTH + 1.2
    && cornerCap[idx] > rival.speed + 2.0);
  car._cruiseBlockT = blocked ? (car._cruiseBlockT || 0) + dt
    : Math.max(0, (car._cruiseBlockT || 0) - dt * 2);
  const attacking = (car._cruiseBlockT || 0) > 1.2;

  /* ---- ★ 三点融合纯追踪转向 ---- */
  const baseLatN = (lineX[iNear] - pts[iNear].x) * nor[iNear].x + (lineY[iNear] - pts[iNear].y) * nor[iNear].y;
  const latN = clamp(baseLatN + (car._latOffset || 0), -hw[iNear] + 2.2, hw[iNear] - 2.2);
  const dxN = pts[iNear].x + nor[iNear].x * latN - car.x;
  const dyN = pts[iNear].y + nor[iNear].y * latN - car.y;

  // 中段追踪点：赛车线 + 侧向偏移（超车时有效）
  const baseLatM = (lineX[iMid] - pts[iMid].x) * nor[iMid].x + (lineY[iMid] - pts[iMid].y) * nor[iMid].y;
  const latM = clamp(baseLatM + (car._latOffset || 0), -hw[iMid] + 2.2, hw[iMid] - 2.2);
  const dxM = pts[iMid].x + nor[iMid].x * latM - car.x;
  const dyM = pts[iMid].y + nor[iMid].y * latM - car.y;

  const dxF = tr.targetX - car.x, dyF = tr.targetY - car.y;

  const aN = wrapAngle(Math.atan2(dyN, dxN) - car.angle);
  const aM = wrapAngle(Math.atan2(dyM, dxM) - car.angle);
  const aF = wrapAngle(Math.atan2(dyF, dxF) - car.angle);

  // ★ 自适应融合权重：弯中偏重近点（紧贴 Apex），直道偏重远点（平滑预判入弯）
  //   弯中：near 0.50 + mid 0.30 + far 0.20 → 紧贴弯心，快速纠偏
  //   直道：near 0.25 + mid 0.25 + far 0.50 → 远距预瞄，提前入弯
  const wN = 0.25 + cornerIntensity * 0.25;   // 0.25 ~ 0.50
  const wF = 0.50 - cornerIntensity * 0.30;   // 0.50 ~ 0.20
  const wM = 1.0 - wN - wF;                   // 0.25 ~ 0.30
  const alpha = aN * wN + aM * wM + aF * wF;

  const dist = (Math.hypot(dxF, dyF) * wF + Math.hypot(dxM, dyM) * wM + Math.hypot(dxN, dyN) * wN) || 1;
  const kappa = 2 * Math.sin(alpha) / dist;
  const omegaMax = Math.min(latGrip / Math.max(v, 1), maxOmega) * Math.min(1, v / 3);
  let duty = clamp((v * kappa) / (omegaMax || 1), -1, 1);

  /* ---- 主动侧向防撞（第二道防线）：与任意车并排过近时向空侧弹开 ---- */
  let guard = 0, sideSqueeze = false;
  if (otherCars && otherCars.length > 1) {
    for (let i = 0; i < otherCars.length; i++) {
      const o = otherCars[i];
      if (o === car) continue;
      const geo = getCarDistance(car, o);
      if (Math.abs(geo.sLon) < CAR_LENGTH + 2.0 && Math.abs(geo.dLat) < CAR_WIDTH + 1.4) {
        if (geo.gapLateral < 0.55) sideSqueeze = true;
        guard += geo.dLat >= 0 ? -1 : 1;
      }
    }
  }
  if (guard !== 0) duty = clamp(duty + Math.sign(guard) * 0.20, -1, 1);
  duty = clamp(duty + tr.steerBias, -1, 1);

  // ★ 更快的方向盘响应：弯中 dt*30 极速跟手，直道 dt*22 平滑防振荡
  const steerAlpha = Math.min(1, dt * (inCorner ? 30 : 22));
  out.steer = (out.steer || 0) + (duty - (out.steer || 0)) * steerAlpha;
  out.left = out.steer < -0.05;
  out.right = out.steer > 0.05;

  /* ---- 纵向：时间最优闭环刹车规划 ---- */
  const baseBrake = PHYS.brake * (perf.brakeMult ?? 1.0);
  // 坡度修正：下坡可用制动变小、上坡叠加重力制动（与 Smooth Cruiser 同口径）
  const brakeCap = Math.max(baseBrake * 0.5, baseBrake + 9.81 * (grade[idx] || 0));
  const lightCap = brakeCap * PHYS.lightBrakeFactor;
  const scanCapM = Math.max(320, v * v / (2 * brakeCap) + 80);
  const scanSteps = Math.min(Math.round((v * v / (2 * lightCap) + 80) / DS), Math.round(scanCapM / DS));

  let env1 = cornerCap[idx], env2 = cornerCap[idx], aReq = 0;
  // ★ 更精细的扫描步进：全程逐步扫描，不跳步，确保不遗漏弯心最低速度点
  for (let s = 1; s <= scanSteps; s++) {
    const j = (idx + s) % N;
    const d = s * DS;
    const cap = cornerCap[j];
    if (cap < v) {
      const req = (v * v - cap * cap) / (2 * d);
      if (req > aReq) aReq = req;
    }
    const r1 = Math.sqrt(cap * cap + 2 * lightCap * d);
    // 全刹兜底包络按【目标点】坡度修正：跑到下坡段时制动能力下降，包络自然收窄
    const brakeJ = Math.max(baseBrake * 0.5, baseBrake + 9.81 * (grade[j] || 0));
    const r2 = Math.sqrt(cap * cap + 2 * brakeJ * 0.98 * d);
    if (r1 < env1) env1 = r1;
    if (r2 < env2) env2 = r2;
  }

  /* ---- ★ 前方出弯直道探测：弯道出口后跟长直道时更激进地提前开油 ---- */
  // 扫描前方 20~60m 区间的曲率：若曲率趋零，说明即将进入直道，可以更早更猛地给油
  let exitStraight = false;
  {
    const scanFrom = Math.round(20 / DS);
    const scanTo   = Math.min(Math.round(60 / DS), N - 1);
    let maxCurv = 0;
    for (let s = scanFrom; s <= scanTo; s++) {
      const c = Math.abs(curvS[(idx + s) % N]);
      if (c > maxCurv) maxCurv = c;
    }
    exitStraight = (maxCurv < 0.005);  // 前方基本是直道
  }

  const DIVE_ENABLE = false;
  const dive = DIVE_ENABLE && !!(rival && rivalGeo.sLon < 14 && rivalGeo.sLon > -3
    && Math.abs(car._latOffset || 0) > 1.2 && Math.abs(rivalGeo.dLat) > 2.4);
  const envGo = dive ? Math.min(env2, cornerCap[idx] * 1.03) : env1;

  /* ---- 跟车与避撞速度约束 ---- */
  let emergency = tr.emergencyBrake;
  if (otherCars && otherCars.length > 1) {
    for (let i = 0; i < otherCars.length; i++) {
      const o = otherCars[i];
      if (o === car) continue;
      const geo = getCarDistance(car, o);
      if (geo.sLon <= 0 || geo.sLon > 55) continue;
      if (Math.abs(geo.dLat) > CAR_WIDTH + 0.9) continue;
      const gap = geo.gapFrontRear;
      const closing = v - o.speed;
      if (gap < 1.0 && closing > 0.5 && geo.sLon > 2.0
        && Math.abs(geo.dLat) < CAR_WIDTH + 0.35) { emergency = true; break; }
      const safeGap = Math.max(gap - (attacking ? 1.2 : 1.8), 0.4);
      const followCap = Math.sqrt(o.speed * o.speed + 2 * brakeCap * 0.90 * safeGap)
        + closing * 0.12;
      if (followCap < env1) env1 = followCap;
      if (followCap < env2) env2 = followCap;
    }
  }
  if (tr.shouldSlow && !car._cruiseOTSide && tr.speedCap < env1) {
    env1 = tr.speedCap;
    env2 = Math.min(env2, tr.speedCap);
  }

  /* ---- ★ 分档执行：更激进的晚刹阈值 + Trail-Braking 出弯油门重叠 ---- */
  const steerMag = Math.abs(out.steer);
  if (emergency) {
    out.brake = 2;
  } else if (!dive && aReq > lightCap * 1.02) {
    // ★ 阈值从 1.05 降到 1.02：更晚才切换到重刹，多利用轻刹调制的精度优势
    out.brake = 2;
  } else if (v > env2 + 0.2) {
    // ★ 安全兜底余量从 0.3 缩到 0.2：更贴近物理极限
    out.brake = 2;
  } else if (v > envGo + 0.15) {
    // ★ 轻刹入口余量从 0.2 缩到 0.15：更晚进入轻刹区间
    out.brake = 1;
  } else {
    out.brake = 0;
  }

  /* ---- ★ 油门策略：Trail-Braking 出弯 + 弯中全油门 + 出弯直道弹射 ---- */
  if (emergency) {
    out.up = false;
  } else if (out.brake === 1 && steerMag > 0.15 && steerMag < 0.65
    && v < cornerCap[idx] + 0.5 && Math.abs(alpha) < 0.35) {
    // ★ Trail-Braking 出弯油门重叠：轻刹 + 中等转向 + 车头已基本指向出弯方向
    // → 同时给油！前轴载荷转移中利用剩余抓地力加速，比等刹车释放再给油更快
    out.up = true;
  } else if (out.brake === 0) {
    // ★ 弯中全油门余量从 0.2 缩到 0.05：物理模型无驱动/转向联合摩擦损失，极限利用
    // 出弯直道探测到时完全不留余量（cornerCap 已有 4% 安全系数）
    const throttleMargin = exitStraight ? 0.0 : 0.05;
    out.up = v < cornerCap[idx] - throttleMargin;
  } else {
    out.up = false;
  }

  out.targetX = tr.targetX;
  out.targetY = tr.targetY;
  out.targetSpeed = env1;
}
/* ================= 赛车真实性能与算法配置表 ================= */
export const AI_CONFIGS = [
  {
    id: "apex-hunter",
    name: "法拉利 #16 (SF-24 · 机械抓地与弯道出弯之王)",
    shortName: "法拉利 #16",
    team: "法拉利",
    model: "SF-24",
    color: "#ff3b3b",
    livery: "ferrari",
    number: "16",
    driverName: "勒克莱尔 (LEC #16)",
    driverShort: "勒克莱尔",
    driverCode: "LEC",
    driver: geminiDriver,
    perf: {
      maxSpeed: [100.0, 90.0, 33.6],
      latGrip: 48.2,
      maxOmega: 3.75,
      accelMult: 1.05,
      brakeMult: 1.03,
      steerRate: 13.5
    }
  },
  {
    id: "vector-pursuit",
    name: "红牛 #1 (RB20 · DRS大直线极速与高速弯之王)",
    shortName: "红牛 #1",
    team: "红牛",
    model: "RB20",
    color: "#00b4d8",
    livery: "redbull",
    number: "1",
    driverName: "维斯塔潘 (VER #1)",
    driverShort: "维斯塔潘",
    driverCode: "VER",
    driver: geminiDriver,
    perf: {
      maxSpeed: [101.5, 92.0, 34.0],
      latGrip: 47.6,
      maxOmega: 3.60,
      accelMult: 1.03,
      brakeMult: 1.04,
      steerRate: 13.8
    }
  },
  {
    id: "classic-baseline",
    name: "阿斯顿 #14 (AMR24 · 高下压力弯道粘地/原基准)",
    shortName: "阿斯顿 #14",
    team: "阿斯顿·马丁",
    model: "AMR24",
    color: "#10b981",
    livery: "aston",
    number: "14",
    driverName: "阿隆索 (ALO #14)",
    driverShort: "阿隆索",
    driverCode: "ALO",
    driver: geminiDriver,
    perf: {
      maxSpeed: [100.3, 87.5, 33.0],
      latGrip: 47.2,
      maxOmega: 3.55,
      accelMult: 0.99,
      brakeMult: 0.98,
      steerRate: 11.0
    }
  },
  {
    id: "mercedes-w15",
    name: "梅奔 #44 (W15 · 深刹时间最优与主动防撞)",
    shortName: "梅奔 #44",
    team: "梅赛德斯",
    model: "W15",
    color: "#e2e8f0",
    livery: "mercedes",
    number: "44",
    driverName: "汉密尔顿 (HAM #44)",
    driverShort: "汉密尔顿",
    driverCode: "HAM",
    driver: geminiDriver,
    perf: {
      maxSpeed: [103.2, 92.8, 33.6],
      latGrip: 46.0,
      maxOmega: 3.30,
      accelMult: 1.00,
      brakeMult: 1.08,
      steerRate: 10.5
    }
  },
    {
    id: "AiMotor",
    name: "Ai Motor",
    shortName: "ai",
    team: "Ai Motor",
    model: "Cyber",
    color: "#a855f7",        // 排位榜色条 / 小地图点位：紫色（原本白色，和梅奔撞色）
    livery: "cyber",
    number: "55",
    driverName: "Ai (AIM #55)",
    driverShort: "Ai",
    driverCode: "AIM",
    driver: geminiDriver,
    perf: {
      maxSpeed: [101.5, 91.8, 33.6],
      latGrip: 47.0,
      maxOmega: 3.40,
      accelMult: 1.02,
      brakeMult: 1.08,
      steerRate: 13.5
    }
  },
  {
    id: "smooth-cruiser",
    name: "小米 SU8 Ultra #7 (1548PS · 三电机弹射与碳陶瓷深刹)",
    shortName: "SU8 Ultra #7",
    team: "小米",
    model: "SU8 Ultra",
    color: "#f5c518",
    livery: "su7ultra",
    number: "7",
    driverName: "小米车手 (XIAO #7)",
    driverShort: "小米车手",
    driverCode: "XIAO",
    driver: geminiDriver,
    perf: {
      maxSpeed: [133.2, 88.0, 63.6],
      latGrip: 16.2,
      maxOmega: 3.50,
      powerKW: 1740,
      massKg: 2300,
      launchAccel: 14.2,
      brakeMult: 0.29,
      steerRate: 9.5
    }
  },
    {
    id: "yangwang-u9x",
    name: "仰望 U9 Xtreme #9 (3000Ps · 1200V 四电机极速之王)",
    shortName: "U9X #9",
    team: "仰望",
    model: "U9 Xtreme",
    color: "#f59e0b",
    livery: "yangwang",
    number: "9",
    driverName: "仰望车手 (U9X #9)",
    driverShort: "仰望车手",
    driverCode: "U9X",
    driver: geminiDriver,
    perf: {
      maxSpeed: [137.8, 124.0, 33.6],
      latGrip: 17.0,
      maxOmega: 2.60,
      powerKW: 1600,
      massKg: 2475,
      launchAccel: 14.6,
      brakeMult: 0.32,
      steerRate: 9.5
    }
  },
  {
    // 车模移植自外部「3D 车辆物理模拟器」的越野卡车（TRAIL RIG）：
    // 高底盘 + 大行程悬挂 + 球状越野胎，直道上不慢但大抓地/低横摆极限，
    // 弯道必须早刹；草地极速远高于 F1，冲线后/脱困更从容。
    id: "trail-rig",
    name: "越野卡车 #23 (TRAIL RIG · 4×4 高底盘全地形)",
    shortName: "越野卡车 #23",
    team: "越野工坊",
    model: "TRAIL RIG",
    color: "#c2551d",
    livery: "offroad",
    number: "23",
    driverName: "越野手 (TRK #23)",
    driverShort: "越野手",
    driverCode: "TRK",
    driver: geminiDriver,
    perf: {
      maxSpeed: [63.0, 52.0, 38.0],
      latGrip: 16.8,
      maxOmega: 2.90,
      powerKW: 340,
      massKg: 1950,
      launchAccel: 9.8,
      brakeMult: 0.45,
      steerRate: 8.2
    }
  }
];

/* ================= 发车位生成：支持在 AI_CONFIGS 中用 gridPos 指定杆位 ================= */
// 用法：配置项加 gridPos: 0 即锁定 P1 杆位（0 起始编号），未指定 gridPos 的车随机/顺序填入剩余格位。
// 返回 carGrid：carGrid[车辆索引] = 发车格位（0 = 杆位）。自动适配任意车辆数，并处理重复指定的冲突。
export function buildGridSlots(configs, random = true) {
  const n = configs.length;
  const slots = Array(n).fill(-1);            // slots[格位] = 车辆索引，-1 为空格

  // 1. 指定杆位优先占用（重复指定时后来者放弃，回落到随机池）
  configs.forEach((cfg, i) => {
    const g = Number(cfg.gridPos);
    if (Number.isInteger(g) && g >= 0 && g < n && slots[g] === -1) slots[g] = i;
  });

  // 2. 剩余车辆填入剩余格位（随机洗牌或按配置顺序）
  const freeCars = [];
  configs.forEach((_, i) => { if (!slots.includes(i)) freeCars.push(i); });
  const freeSlots = [];
  for (let s = 0; s < n; s++) if (slots[s] === -1) freeSlots.push(s);
  if (random) {
    for (let i = freeSlots.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [freeSlots[i], freeSlots[j]] = [freeSlots[j], freeSlots[i]];
    }
  }
  freeSlots.forEach((s, k) => { slots[s] = freeCars[k]; });

  // 3. 反转映射：车辆索引 → 格位
  const carGrid = Array(n).fill(0);
  slots.forEach((ci, s) => { carGrid[ci] = s; });
  return carGrid;
}

/* ================= 车辆配置统一装配（唯一入口） =================
   main.js / ai-sim.mjs / benchmark-10.mjs 全部通过它装配赛车，
   涂装、车号、性能、算法等字段只在此处映射一次，新增字段不用改三处调用方。 */
export function applyCarConfig(car, cfg) {
  car.id = cfg.id;
  car.name = cfg.name;
  car.shortName = cfg.shortName;
  car.team = cfg.team;
  car.model = cfg.model;
  car.livery = cfg.livery;          // 车身涂装 → src/car/render.js 的 CAR_LIVERIES
  car.color = cfg.color;            // 主题色 → 小地图 / HUD 排位条 / 遥测
  car.number = cfg.number;
  car.driverName = cfg.driverName;
  car.driverShort = cfg.driverShort;
  car.driverCode = cfg.driverCode;
  car.algorithm = cfg.id;
  car.driver = cfg.driver;
  // 每辆车持有自己的性能副本：调校（TUNE）只作用于本车，不污染全局 AI_CONFIGS，
  // 也不会出现"多辆同款车共享同一份 perf，改一辆全变"的问题
  car.perf = { ...cfg.perf };
  if (cfg.perf.maxSpeed) car.perf.maxSpeed = [...cfg.perf.maxSpeed];
  car.vTarget = buildCarVTarget(car.perf);
  return car;
}

// 所有算法调用的唯一入口：这里把 car / otherCars 换成只读视图再交给 driver。
// 内置算法同样走这条路（它们只写 car._xxx），所以玩家代码与内置代码看到的世界完全一致。
// this 用空对象：裸调用会让非严格模式函数的 this 变成全局对象（= 把 window 递过去）。
export function driveAI(car, out, dt, otherCars) {
  // 兜底算法统一为 geminiDriver（AI_CONFIGS 里的所有车都已使用它）
  const driver = car.driver || (AI_CONFIGS.find(c => c.id === car.algorithm)?.driver) || geminiDriver;
  driver.call(DRIVER_THIS, driverCarView(car), out, dt, driverCarsView(otherCars));
}
