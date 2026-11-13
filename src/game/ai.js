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

  const aLatArr = new Float32Array(_N);
  const brakeArr = new Float32Array(_N);
  for (let i = 0; i < _N; i++) {
    const b = _bank && _bank.length ? (_bank[i] || 0) : 0;
    const cosPhi = 1 / Math.sqrt(1 + b * b);
    const cSign = Math.sign(_rcurvS[i] || 0);
    // 3D 赛道横坡（banking）：只有弯内侧向下的碗状横坡才提供额外向心力分量；反向外倾横坡（off-camber）削弱抓地
    const bankGrip = cSign !== 0 ? (-cSign * b * 9.81 * cosPhi) : 0;
    let latEff = Math.max(A_LAT * 0.5, A_LAT * cosPhi + bankGrip);

    // 3D 赛道坡顶失重（crest unweighting）：纵向坡度从上坡急转下坡时法向载荷下降
    if (_grade && _grade.length) {
      const gNow = _grade[i] || 0;
      const gNext = _grade[(i + 1) % _N] || 0;
      const dGrade = (gNext - gNow) / Math.max(0.5, _DS);
      if (dGrade < -0.0008) {
        const unweightFactor = clamp(1 + dGrade * 50, 0.75, 1.0);
        latEff *= unweightFactor;
      }
    }

    aLatArr[i] = latEff;
    const gHere = _grade && _grade.length ? (_grade[i] || 0) : 0;
    brakeArr[i] = Math.max(brakePlan * 0.3, brakePlan + 9.81 * gHere);
  }

  const w = Math.max(1, Math.round(30 / Math.max(0.1, _DS)));
  // ★ 突破性非对称窗口：后向仅看 2.2m（半个车身），前向看 10.5m
  // 彻底消除出弯后长期压制弯速的顽疾，过弯心瞬间释放极速！
  const wBack = opts.apexRelease ? Math.max(1, Math.round(2.2 / Math.max(0.1, _DS))) : w;
  const wAhead = opts.apexRelease ? Math.max(1, Math.round(10.5 / Math.max(0.1, _DS))) : w;
  const step15 = Math.max(1, Math.round(15.0 / Math.max(0.1, _DS)));
  const step55 = Math.max(1, Math.round(55.0 / Math.max(0.1, _DS)));

  for (let i = 0; i < _N; i++) {
    let k = 0;
    for (let j = -wBack; j <= wAhead; j++) {
      const c = Math.abs(_rcurvS[(i + j + _N) % _N]);
      if (c > k) k = c;
    }

    if (opts.apexRelease && k > 1e-5) {
      const cHere = _rcurvS[i];
      const absHere = Math.abs(cHere);
      const absAhead = Math.abs(_rcurvS[(i + step15) % _N]);
      let isIsolatedExit = absHere > 0.004 && absAhead < absHere * 0.88;
      if (isIsolatedExit) {
        const cSign = Math.sign(cHere);
        for (let s = step15; s <= step55; s += 2) {
          if (cSign * _rcurvS[(i + s) % _N] < -0.0055) {
            isIsolatedExit = false;
            break;
          }
        }
      }
      if (isIsolatedExit) k *= 0.86; // 真实 F1 Track-Out 外抛，放大出弯半径，曲率打 0.86 折
    }

    const R = k > 1e-5 ? 1 / k : 1e6;
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
  const corridorIn = new Float32Array(cN);   // 向弯心一侧的最大偏移（受局部半径限制）
  const insideSign = new Int8Array(cN);

  // 中心线原始（3 点、未平滑）曲率：平滑曲率会掩盖发夹弯的真实尖点，
  // 走线向弯心偏移一旦接近当地半径，曲线收缩会把相邻点折到曲率圆心上
  // （相邻点重合 → 曲率爆炸 → 弯速≈0，车停在弯前，像撞到一堵透明墙）。
  const rawK = new Float32Array(cN);
  for (let i = 0; i < cN; i++) {
    const a = (i - 1 + cN) % cN, b = (i + 1) % cN;
    const v1x = cPts[i].x - cPts[a].x, v1y = cPts[i].y - cPts[a].y;
    const v2x = cPts[b].x - cPts[i].x, v2y = cPts[b].y - cPts[i].y;
    const l1 = Math.hypot(v1x, v1y), l2 = Math.hypot(v2x, v2y);
    rawK[i] = Math.atan2(v1x * v2y - v1y * v2x, v1x * v2x + v1y * v2y)
      / ((l1 + l2) * 0.5 || 1);
  }

  for (let i = 0; i < cN; i++) {
    cLineX[i] = cPts[i].x;
    cLineY[i] = cPts[i].y;
    corridor[i] = Math.max(0, cHw[i] - 3.4);
    // 局部半径取邻域最小值（±2 点 ≈ ±7m），单点噪声不能放过尖点
    let minR = Infinity;
    for (let d = -2; d <= 2; d++) {
      const k = Math.abs(rawK[(i + d + cN) % cN]);
      const r = k > 1e-5 ? 1 / k : 1e6;
      if (r < minR) minR = r;
    }
    corridorIn[i] = Math.max(0, Math.min(corridor[i], minR * 0.6));
    insideSign[i] = Math.sign(rawK[i]) || 0;
  }

  for (let it = 0; it < 900; it++) {
    for (let i = 0; i < cN; i++) {
      const a = (i - 1 + cN) % cN, b = (i + 1) % cN;
      const mx = (cLineX[a] + cLineX[b]) * 0.5;
      const my = (cLineY[a] + cLineY[b]) * 0.5;
      let off = (mx - cPts[i].x) * cNor[i].x + (my - cPts[i].y) * cNor[i].y;
      if (insideSign[i] > 0) off = clamp(off, -corridor[i], corridorIn[i]);
      else if (insideSign[i] < 0) off = clamp(off, -corridorIn[i], corridor[i]);
      else off = clamp(off, -corridor[i], corridor[i]);
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

// superDriver 专属 F1 外-内-外 (Out-In-Out) 走线与等弧长去噪曲率表缓存（按赛道 id 缓存）
const _superF1TrackCache = new Map();

function buildSuperF1Track() {
  const hit = _superF1TrackCache.get(currentTrackId);
  if (hit) return hit;

  const cN = N, cPts = pts, cNor = nor, cHw = hw, cCum = cumDist, cLin = isLinear;
  const totalLen = cLin ? cCum[cN - 1] : (cCum[cN] || LAP_LENGTH);
  const targetStep = 3.5;
  const M = Math.max(64, Math.round(totalLen / targetStep));
  const uDS = totalLen / M;

  const uPtsX = new Float32Array(M);
  const uPtsY = new Float32Array(M);
  const uNorX = new Float32Array(M);
  const uNorY = new Float32Array(M);
  const uHw = new Float32Array(M);

  // 1. 将非均匀参数采样赛道重采样到严格等弧长网格 (uDS ≈ 3.5m)，彻底消除采样密度不均导致的曲率伪峰与过平滑
  let seg = 0;
  for (let m = 0; m < M; m++) {
    const s = m * uDS;
    while (seg < cN - 1 && cCum[seg + 1] < s) seg++;
    const s0 = cCum[seg], s1 = cCum[seg + 1];
    const t = s1 > s0 ? clamp((s - s0) / (s1 - s0), 0, 1) : 0;
    const next = cLin ? Math.min(seg + 1, cN - 1) : (seg + 1) % cN;
    uPtsX[m] = cPts[seg].x + (cPts[next].x - cPts[seg].x) * t;
    uPtsY[m] = cPts[seg].y + (cPts[next].y - cPts[seg].y) * t;
    let nx = cNor[seg].x + (cNor[next].x - cNor[seg].x) * t;
    let ny = cNor[seg].y + (cNor[next].y - cNor[seg].y) * t;
    const nl = Math.hypot(nx, ny) || 1;
    uNorX[m] = nx / nl;
    uNorY[m] = ny / nl;
    uHw[m] = cHw[seg] + (cHw[next] - cHw[seg]) * t;
  }

  // 2. 等弧长网格中心线曲率 uK 与局部平滑曲率 uKS (±10.5m)
  const uK = new Float32Array(M);
  for (let m = 0; m < M; m++) {
    const a = cLin ? Math.max(0, m - 1) : (m - 1 + M) % M;
    const b = cLin ? Math.min(M - 1, m + 1) : (m + 1) % M;
    const v1x = uPtsX[m] - uPtsX[a], v1y = uPtsY[m] - uPtsY[a];
    const v2x = uPtsX[b] - uPtsX[m], v2y = uPtsY[b] - uPtsY[m];
    const l1 = Math.hypot(v1x, v1y), l2 = Math.hypot(v2x, v2y);
    uK[m] = Math.atan2(v1x * v2y - v1y * v2x, v1x * v2x + v1y * v2y) / ((l1 + l2) * 0.5 || 1);
  }

  const uKS = new Float32Array(M);
  for (let m = 0; m < M; m++) {
    let sum = 0;
    for (let k = -3; k <= 3; k++) {
      const j = cLin ? clamp(m + k, 0, M - 1) : (m + k + M) % M;
      sum += uK[j];
    }
    uKS[m] = sum / 7;
  }

  // 3. 安全沥青走廊与发夹弯防内折约束 (minR * 0.60 覆盖整个弯心 ±17.5m，杜绝发夹弯内-外-内反凹)
  const uCorrOut = new Float32Array(M);
  const uCorrIn = new Float32Array(M);
  for (let m = 0; m < M; m++) {
    uCorrOut[m] = Math.max(0, uHw[m] - 2.4);
    let minR = Infinity;
    for (let k = -5; k <= 5; k++) {
      const j = cLin ? clamp(m + k, 0, M - 1) : (m + k + M) % M;
      const c = Math.max(Math.abs(uK[j]), Math.abs(uKS[j]));
      const r = c > 1e-5 ? 1 / c : 1e6;
      if (r < minR) minR = r;
    }
    uCorrIn[m] = Math.max(0, Math.min(uHw[m] - 2.8, minR * 0.60));
  }

  // 4. 构建 F1 外-内-外 (Out-In-Out) 相位走廊门限 [uLo[m], uHi[m]]：
  //    · 入弯前制动与准备区 (距入弯 16m ~ 98m)：引导向弯道外侧路肩 (-signAhead)，例如左转先靠右路肩、右转先靠左路肩
  //    · 弯中切入与晚弯心区 (Turn-In -> Late Apex)：完全敞开内侧走廊至 +sign * uCorrIn，让 2D 曲线自然切向内侧路肩
  //    · 独立弯道出弯外抛区 (距出弯 16m ~ 68m 且前方无反向 S 弯)：引导向弯道外侧路肩 (-signBehind) 外抛开油
  const K_CORNER = 0.0055;
  const uLo = new Float32Array(M);
  const uHi = new Float32Array(M);
  for (let m = 0; m < M; m++) {
    const k = uKS[m];
    if (k > 0.002) {
      uLo[m] = -uCorrOut[m];
      uHi[m] = uCorrIn[m];
    } else if (k < -0.002) {
      uLo[m] = -uCorrIn[m];
      uHi[m] = uCorrOut[m];
    } else {
      uLo[m] = -uCorrOut[m];
      uHi[m] = uCorrOut[m];
    }
  }

  const gateTarget = new Float32Array(M);
  const gateWeight = new Float32Array(M);
  const uEntryOutsideSign = new Int8Array(M);

  for (let m = 0; m < M; m++) {
    if (Math.abs(uKS[m]) > K_CORNER) continue;

    let stepsAhead = Infinity, signAhead = 0, peakAhead = 0;
    for (let s = 1; s <= 34; s++) {
      const j = cLin ? Math.min(M - 1, m + s) : (m + s) % M;
      const kj = uKS[j];
      if (Math.abs(kj) > K_CORNER) {
        if (stepsAhead === Infinity) {
          stepsAhead = s;
          signAhead = Math.sign(kj);
        }
        if (Math.sign(kj) === signAhead) {
          if (Math.abs(kj) > peakAhead) peakAhead = Math.abs(kj);
        } else {
          break;
        }
      } else if (stepsAhead !== Infinity && s > stepsAhead + 3) {
        break;
      }
    }

    let stepsBehind = Infinity, signBehind = 0, peakBehind = 0;
    for (let s = 1; s <= 24; s++) {
      const j = cLin ? Math.max(0, m - s) : (m - s + M) % M;
      const kj = uKS[j];
      if (Math.abs(kj) > K_CORNER) {
        if (stepsBehind === Infinity) {
          stepsBehind = s;
          signBehind = Math.sign(kj);
        }
        if (Math.sign(kj) === signBehind) {
          if (Math.abs(kj) > peakBehind) peakBehind = Math.abs(kj);
        } else {
          break;
        }
      } else if (stepsBehind !== Infinity && s > stepsBehind + 3) {
        break;
      }
    }

    const dAhead = stepsAhead * uDS;
    const dBehind = stepsBehind * uDS;
    let gSign = 0, gStr = 0;

    // 入弯外线靠边准备：距入弯点 16m ~ 98m 提前贴向弯道外侧路肩 (-signAhead)
    if (dAhead >= 16 && dAhead <= 98 && signAhead !== 0 && peakAhead > 0.0070) {
      const cScale = clamp((peakAhead - 0.0055) / 0.015, 0.40, 1.0);
      let env = 1.0;
      if (dAhead < 28) env = (dAhead - 14) / 14;
      else if (dAhead > 65) env = 1.0 - (dAhead - 65) / 35;
      gSign = -signAhead;
      gStr = clamp(env * cScale * 0.86, 0, 0.86);
      if (dAhead >= 16 && dAhead <= 85) {
        uEntryOutsideSign[m] = -signAhead;
      }
    }

    // 出弯外抛 Track-Out：距出弯 16m ~ 68m（且无紧邻反向弯冲突）顺势推向外侧路肩 (-signBehind)
    if (dBehind >= 16 && dBehind <= 68 && signBehind !== 0 && peakBehind > 0.0070 && (dAhead > 65 || signAhead === signBehind)) {
      const cScale = clamp((peakBehind - 0.0055) / 0.015, 0.40, 1.0);
      let env = 1.0;
      if (dBehind < 26) env = (dBehind - 14) / 12;
      else if (dBehind > 44) env = 1.0 - (dBehind - 44) / 26;
      const str = clamp(env * cScale * 0.80, 0, 0.80);
      if (str > gStr) {
        gSign = -signBehind;
        gStr = str;
      }
    }

    if (gSign !== 0 && gStr > 0.05) {
      gateTarget[m] = gSign * uCorrOut[m] * gStr;
      gateWeight[m] = gStr;
    }
  }

  for (let m = 0; m < M; m++) {
    let wSum = 0, tSum = 0;
    for (let k = -2; k <= 2; k++) {
      const j = cLin ? clamp(m + k, 0, M - 1) : (m + k + M) % M;
      wSum += gateWeight[j];
      tSum += gateTarget[j];
    }
    const wAvg = wSum / 5;
    const tAvg = tSum / 5;
    if (wAvg > 0.10 && Math.abs(uKS[m]) <= K_CORNER) {
      if (tAvg > 0) {
        uLo[m] = Math.max(uLo[m], Math.min(uHi[m] - 0.4, tAvg));
      } else if (tAvg < 0) {
        uHi[m] = Math.min(uHi[m], Math.max(uLo[m] + 0.4, tAvg));
      }
    }
  }

  // 5. 等弧长网格 2D 最小曲率松弛求解：自然形成“外侧 Turn-In -> 内侧 Apex -> 外侧 Track-Out”大半径圆弧
  const uX = new Float32Array(M);
  const uY = new Float32Array(M);
  const uLat = new Float32Array(M);
  for (let m = 0; m < M; m++) {
    uLat[m] = 0.5 * (uLo[m] + uHi[m]);
    uX[m] = uPtsX[m] + uNorX[m] * uLat[m];
    uY[m] = uPtsY[m] + uNorY[m] * uLat[m];
  }

  for (let it = 0; it < 800; it++) {
    for (let m = 0; m < M; m++) {
      const a = cLin ? Math.max(0, m - 1) : (m - 1 + M) % M;
      const b = cLin ? Math.min(M - 1, m + 1) : (m + 1) % M;
      const mx = 0.5 * (uX[a] + uX[b]);
      const my = 0.5 * (uY[a] + uY[b]);
      let off = (mx - uPtsX[m]) * uNorX[m] + (my - uPtsY[m]) * uNorY[m];
      off = clamp(off, uLo[m], uHi[m]);
      uLat[m] = off;
      uX[m] = uPtsX[m] + uNorX[m] * off;
      uY[m] = uPtsY[m] + uNorY[m] * off;
    }
  }

  // 6. 计算等弧长 F1 走线曲率 uLineKS，并对紧凑 S 弯/减速弯 (Chicane) 翻身过渡点做曲率桥接保护
  const uLineK = new Float32Array(M);
  for (let m = 0; m < M; m++) {
    const a = cLin ? Math.max(0, m - 1) : (m - 1 + M) % M;
    const b = cLin ? Math.min(M - 1, m + 1) : (m + 1) % M;
    const v1x = uX[m] - uX[a], v1y = uY[m] - uY[a];
    const v2x = uX[b] - uX[m], v2y = uY[b] - uY[m];
    const l1 = Math.hypot(v1x, v1y), l2 = Math.hypot(v2x, v2y);
    uLineK[m] = Math.atan2(v1x * v2y - v1y * v2x, v1x * v2x + v1y * v2y) / ((l1 + l2) * 0.5 || 1);
  }

  const uLineKS = new Float32Array(M);
  for (let m = 0; m < M; m++) {
    let sum = 0;
    for (let k = -4; k <= 4; k++) {
      const j = cLin ? clamp(m + k, 0, M - 1) : (m + k + M) % M;
      sum += uLineK[j];
    }
    uLineKS[m] = sum / 9;
  }

  const uLineKBridge = new Float32Array(uLineKS);
  for (let m = 0; m < M; m++) {
    let maxPosB = 0, maxNegB = 0, maxPosA = 0, maxNegA = 0;
    for (let s = 1; s <= 8; s++) {
      const jb = cLin ? clamp(m - s, 0, M - 1) : (m - s + M) % M;
      const ja = cLin ? clamp(m + s, 0, M - 1) : (m + s) % M;
      const kb = uLineKS[jb], ka = uLineKS[ja];
      if (kb > maxPosB) maxPosB = kb;
      if (-kb > maxNegB) maxNegB = -kb;
      if (ka > maxPosA) maxPosA = ka;
      if (-ka > maxNegA) maxNegA = -ka;
    }
    const chicane1 = (maxPosB > 0.014 && maxNegA > 0.014) ? Math.min(maxPosB, maxNegA) : 0;
    const chicane2 = (maxNegB > 0.014 && maxPosA > 0.014) ? Math.min(maxNegB, maxPosA) : 0;
    const bridgeMag = Math.max(chicane1, chicane2) * 0.85;
    if (bridgeMag > Math.abs(uLineKBridge[m])) {
      uLineKBridge[m] = (Math.sign(uLineKS[m]) || 1) * bridgeMag;
    }
  }

  // 7. 映射回原始赛道采样点 i = 0..cN-1
  const f1Lat = new Float32Array(cN);
  const f1X = new Float32Array(cN);
  const f1Y = new Float32Array(cN);
  const f1CurvS = new Float32Array(cN);
  const f1CenterK = new Float32Array(cN);
  const entryOutsideSign = new Int8Array(cN);

  for (let i = 0; i < cN; i++) {
    const s = cCum[i];
    const fm = s / uDS;
    const m0 = cLin ? clamp(Math.floor(fm), 0, M - 1) : (Math.floor(fm) % M + M) % M;
    const m1 = cLin ? Math.min(M - 1, m0 + 1) : (m0 + 1) % M;
    const t = fm - Math.floor(fm);
    const lat = uLat[m0] + (uLat[m1] - uLat[m0]) * t;
    f1Lat[i] = lat;
    f1X[i] = cPts[i].x + cNor[i].x * lat;
    f1Y[i] = cPts[i].y + cNor[i].y * lat;
    const ck = uKS[m0] + (uKS[m1] - uKS[m0]) * t;
    f1CenterK[i] = ck;
    const fk = uLineKBridge[m0] + (uLineKBridge[m1] - uLineKBridge[m0]) * t;
    const rk = rcurvS[i];
    if (Math.abs(curvS[i]) < 0.0045 && Math.abs(ck) < 0.0065) {
      f1CurvS[i] = rk;
    } else if (rk * fk <= 0 && Math.abs(fk) < 0.012) {
      f1CurvS[i] = rk;
    } else {
      f1CurvS[i] = fk;
    }
    entryOutsideSign[i] = uEntryOutsideSign[m0];
  }

  // 8. 构建 O(1) 半米精度物理里程 -> 采样点索引查找表
  const lutLen = Math.ceil(totalLen * 2) + 2;
  const sToIdx = new Int32Array(lutLen);
  let p = 0;
  for (let k = 0; k < lutLen; k++) {
    const s = k * 0.5;
    while (p < cN - 1 && cCum[p + 1] < s) p++;
    if (p < cN - 1 && (s - cCum[p]) > (cCum[p + 1] - s)) {
      sToIdx[k] = p + 1;
    } else {
      sToIdx[k] = p;
    }
  }

  const bundle = { f1Lat, f1X, f1Y, f1CurvS, f1CenterK, entryOutsideSign, sToIdx, totalLen, lutLen };
  _superF1TrackCache.set(currentTrackId, bundle);
  return bundle;
}

function advanceByMeters(f1, idx, deltaMeters) {
  let s = cumDist[idx] + deltaMeters;
  if (isLinear) {
    s = clamp(s, 0, f1.totalLen);
  } else {
    s = ((s % f1.totalLen) + f1.totalLen) % f1.totalLen;
  }
  const k = clamp(Math.round(s * 2), 0, f1.lutLen - 1);
  return f1.sToIdx[k];
}

// superDriver 专用弯速表：结合 F1 外-内-外宽半径走线曲率与摩擦圆纵向/横向耦合裕度
export function getSuperCornerCap(perf) {
  return trackCacheGet(_superCornerCapCache, perf, () => {
    const f1 = buildSuperF1Track();
    const bm = (perf && perf.brakeMult) ?? 1.0;
    // 兼顾摩擦圆特性：大马力低制动倍率车型（如电车 brakeMult<0.6）加速与制动占用更多摩擦圆纵向分量
    const gf = bm >= 0.90 ? 0.968 : clamp(0.855 + (bm - 0.28) * 0.18, 0.855, 0.95);
    return buildCarVTarget(perf, {
      gripFactor: gf,
      brakeFactor: 0.95,
      noBrakePlan: true,
      apexRelease: true      // ★ F1 真实赛车手 Apex-Release：过弯心即释放限速，提前开油！
    }, {
      N, DS, rcurvS: f1.f1CurvS, bank, grade
    });
  });
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
  const brakeMult = perf.brakeMult ?? 1.0;
  const f1 = buildSuperF1Track();
  const cornerCap = getSuperCornerCap(perf);

  if (car._cruiseStuck == null) {
    car._cruiseStuck = 0; car._cruiseRev = 0; car._cruiseMoved = false;
    car._cruiseOTSide = 0; car._cruiseOTUntil = 0; car._cruiseBlockT = 0;
    car._latOffset = 0; car._lockedTargetLat = null; car._lockTimer = 0;
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
    if (car._cruiseStuck > 2.2) { car._cruiseRev = 0.85; return; }
  }

  /* ---- 1. F1 真实弯道相位识别（基于真实米制弧长与去畸变中心线曲率）：
        入弯前外侧路肩靠边 (Out) -> 晚切弯心路肩 (In) -> 出弯外抛 (Out) 与连续 S 弯拉直 ---- */
  const centerK = f1.f1CenterK;
  const cSigned = centerK[idx];
  const curvHere = Math.abs(cSigned);
  const cSign = Math.sign(cSigned); // >0 左弯 (内侧为+nor左, 外侧为-nor右); <0 右弯 (内侧为-nor右, 外侧为+nor左)
  const inCorner = curvHere > 0.0065;

  const i12 = advanceByMeters(f1, idx, 12);
  const i24 = advanceByMeters(f1, idx, 24);
  const curv12 = Math.abs(centerK[i12]);
  const curv24 = Math.abs(centerK[i24]);

  // 判断是否已越过弯心 Apex（曲率明显回落释放）
  const isPastApex = inCorner && (curv12 < curvHere * 0.93) && (curv24 <= curv12 * 1.05);

  // 探测前方 10~68m 是否有连续反向弯（S 弯/减速弯）或同向二次收紧急弯
  let hasNextReverseCorner = false;
  let nextReverseSign = 0;
  let hasNextTightCorner = false;
  if (inCorner) {
    for (let d = 10; d <= 68; d += 5) {
      const futC = centerK[advanceByMeters(f1, idx, d)];
      if (cSign !== 0 && cSign * futC < -0.0055) {
        hasNextReverseCorner = true;
        nextReverseSign = Math.sign(futC);
        break;
      }
      if (d > 20 && Math.abs(futC) > Math.max(curvHere * 0.95, 0.011)) {
        hasNextTightCorner = true;
      }
    }
  }

  // 独立非连续弯道出弯相位（过弯心 + 前方无反向弯）
  const isIsolatedExit = isPastApex && !hasNextReverseCorner && !hasNextTightCorner;
  const exitProgress = isIsolatedExit ? clamp(1.0 - (curv24 / Math.max(curvHere, 1e-4)), 0.25, 1.0) : 0;

  /* ---- 2. F1 车手视线前瞻控制：
        · 净空模式入弯前准备区 (inEntrySetup)：锁定外侧路肩制动线与 Turn-In 点，绝不提前切入内线；
        · 混战模式入弯前 (hasPackCornerDefense)：自动切换 F1 防守/抢内线意识，提前卡住弯道内侧封死对手超车路线；
        · 弯心区 (inCorner)：紧盯内侧 Apex 路缘石；
        · 出弯区 (isIsolatedExit)：视线拉长直指外侧出弯路肩开油点 ---- */
  const sHere = cumDist[idx];
  const carLatNow = (car.x - pts[idx].x) * nor[idx].x + (car.y - pts[idx].y) * nor[idx].y;
  const carLonFine = (car.x - pts[idx].x) * tan[idx].x + (car.y - pts[idx].y) * tan[idx].y;

  // 探测前方 420m 内即将到来的首个显著弯道方向与距离（用于混战发车及长直道提前卡内线防守/抢位）
  let upcomingSign = inCorner ? cSign : 0;
  let distToCorner = inCorner ? 0 : Infinity;
  let upcomingPeakK = curvHere;
  if (!inCorner) {
    for (let d = 8; d <= 420; d += 10) {
      const kc = centerK[advanceByMeters(f1, idx, d)];
      if (Math.abs(kc) > 0.0060) {
        if (upcomingSign === 0) {
          upcomingSign = Math.sign(kc);
          distToCorner = d;
        }
        if (Math.sign(kc) === upcomingSign && Math.abs(kc) > upcomingPeakK) {
          upcomingPeakK = Math.abs(kc);
        } else if (Math.sign(kc) !== upcomingSign && d > distToCorner + 16) {
          break;
        }
      } else if (upcomingSign !== 0 && d > distToCorner + 24) {
        break;
      }
    }
  }

  // 快速扫描周围 [-55m, +48m] 是否存在近身混战对手（决定走“排位赛外-内-外线”还是“F1 混战卡内线防守/进攻线”）
  let hasClosePackRival = false;
  let hasCloseRearRival = false;
  if (otherCars && otherCars.length > 1) {
    for (let i = 0; i < otherCars.length; i++) {
      const o = otherCars[i];
      if (o === car || o.finished) continue;
      const oIdx = o.nearIdx % N;
      const oLonFine = (o.x - pts[oIdx].x) * tan[oIdx].x + (o.y - pts[oIdx].y) * tan[oIdx].y;
      let sTrk = (cumDist[oIdx] + oLonFine) - (sHere + carLonFine);
      if (!isLinear) {
        if (sTrk > f1.totalLen * 0.5) sTrk -= f1.totalLen;
        else if (sTrk < -f1.totalLen * 0.5) sTrk += f1.totalLen;
      }
      if (sTrk > -25 && sTrk < 16) {
        hasClosePackRival = true;
        if (sTrk > -22 && sTrk < 6) hasCloseRearRival = true;
      }
    }
  }

  const hasPackCornerDefense = hasClosePackRival && !inCorner && upcomingSign !== 0 && upcomingPeakK > 0.011 && distToCorner <= 280;

  const cornerIntensity = clamp((curvHere - 0.0065) / 0.025, 0, 1);
  const entryOutSign = f1.entryOutsideSign[idx];
  // 混战近身博弈时取消外线摆动准备（防止拉向外侧路肩时被后车/并排车趁虚切入内线卡位）
  const inEntrySetup = !hasPackCornerDefense && !inCorner && entryOutSign !== 0;

  const nearFactor = isIsolatedExit ? (0.35 + 0.16 * exitProgress) : (inCorner ? 0.33 : (inEntrySetup ? 0.34 : 0.46));
  const farFactor  = isIsolatedExit ? (0.58 + 0.24 * exitProgress) : (inCorner ? 0.52 : (inEntrySetup ? 0.50 : 0.76));
  const lookNear = Math.max(8, v * nearFactor);
  let lookFar    = Math.min(92, (inCorner && !isIsolatedExit ? 14 : 16) + v * farFactor);

  // ★ F1 入弯外线定力：仅在净空无后车威胁时，锁住外侧 Turn-In 点走标准外-内-外
  if (inEntrySetup) {
    const iTestFar = advanceByMeters(f1, idx, lookFar);
    if (f1.f1Lat[iTestFar] * entryOutSign < -0.5) {
      lookFar = clamp(lookNear * 1.65, 14, 34);
    }
  }
  const lookMid = (lookNear + lookFar) * 0.5;

  const iNear = advanceByMeters(f1, idx, lookNear);
  const iMid  = advanceByMeters(f1, idx, lookMid);
  const iFar  = advanceByMeters(f1, idx, lookFar);

  /* ---- 3. F1 外-内-外 (Out-In-Out) 与混战内线卡位战术线合成 ---- */
  const wallMargin = 2.15;
  const maxLatN = Math.max(0.5, hw[iNear] - wallMargin);
  const maxLatM = Math.max(0.5, hw[iMid] - wallMargin);
  const maxLatF = Math.max(0.5, hw[iFar] - wallMargin);

  let idealLatN = f1.f1Lat[iNear];
  let idealLatM = f1.f1Lat[iMid];
  let idealLatF = f1.f1Lat[iFar];

  if (hasPackCornerDefense) {
    // ★ F1 混战内线防守与抢位意识：当身后或身旁有对手跟进且前方即将入弯时，
    // 绝不拉向外侧路肩开门揖盗，而是主动切向弯道内侧 (+upcomingSign) 提前封死内线走廊！
    // 注意：仅修正弯心之前的入弯前瞻点（lookDist <= distToCorner + 12），绝不篡改已越过弯心的出弯/反打前瞻点！
    const isHairpinAhead = upcomingPeakK > 0.020;
    const defUrgency = clamp(1.0 - (distToCorner - 20) / (isHairpinAhead ? 210 : 180), 0.35, 1.0);
    const defRatio = hasCloseRearRival
      ? ((isHairpinAhead ? 0.50 : 0.42) + 0.38 * defUrgency)
      : (0.36 + 0.34 * defUrgency);
    const edgeBuf = isHairpinAhead ? 0.35 : 0.60;
    const defLatN = upcomingSign * Math.min(maxLatN - edgeBuf, maxLatN * defRatio);
    const defLatM = upcomingSign * Math.min(maxLatM - edgeBuf, maxLatM * (defRatio + 0.05));
    const defLatF = upcomingSign * Math.min(maxLatF - edgeBuf, maxLatF * (defRatio + 0.10));
    if (lookNear <= distToCorner + 12 && idealLatN * upcomingSign < defLatN * upcomingSign) idealLatN = defLatN;
    if (lookMid  <= distToCorner + 12 && idealLatM * upcomingSign < defLatM * upcomingSign) idealLatM = defLatM;
    if (lookFar  <= distToCorner + 12 && idealLatF * upcomingSign < defLatF * upcomingSign) idealLatF = defLatF;
  } else if (isIsolatedExit && cSign !== 0) {
    // 独立弯道出弯：顺势向赛道外侧（-cSign）外抛 Track-Out 吃满沥青走廊，放大出弯半径
    const outerAsphaltF = -cSign * maxLatF;
    const outerAsphaltM = -cSign * maxLatM;
    idealLatF = clamp(idealLatF + (outerAsphaltF - idealLatF) * (0.45 * exitProgress), -maxLatF, maxLatF);
    idealLatM = clamp(idealLatM + (outerAsphaltM - idealLatM) * (0.25 * exitProgress), -maxLatM, maxLatM);
  } else if (isPastApex && hasNextReverseCorner && nextReverseSign !== 0) {
    // 连续 S 弯：牺牲第一弯外抛，直接贴向下一弯的外侧路肩，为下一弯入弯做准备
    const nextEntryOuter = -nextReverseSign * (hw[iFar] - 2.5);
    idealLatF = clamp(idealLatF * 0.65 + nextEntryOuter * 0.35, -maxLatF, maxLatF);
  }

  /* ---- 4. 全景 360° 邻车态势感知与 1D 走廊超车博弈（遇慢车提前变道侧超、不踩刹车） ---- */
  const neighbors = [];
  let leftWallCarLat = Infinity;
  let rightWallCarLat = -Infinity;
  let hasLeftAlongside = false;
  let hasRightAlongside = false;
  let rearUrgentThreat = false;
  let directLeadCar = null;
  let directLeadGeo = null;
  let directLeadNb = null;

  const SAFE_LAT_SEP = CAR_WIDTH + 0.55;
  const HARD_LAT_SEP = CAR_WIDTH + 0.22;

  let minCapAhead = cornerCap[idx];
  for (let d = 12; d <= 110; d += 14) {
    const c = cornerCap[advanceByMeters(f1, idx, d)];
    if (c < minCapAhead) minCapAhead = c;
  }
  const inBrakingZone = minCapAhead < v - 3.5 || car.braking;

  if (otherCars && otherCars.length > 1) {
    for (let i = 0; i < otherCars.length; i++) {
      const o = otherCars[i];
      if (o === car || o.finished) continue;
      const geo = getCarDistance(car, o);
      const oIdx = o.nearIdx % N;
      const oLat = (o.x - pts[oIdx].x) * nor[oIdx].x + (o.y - pts[oIdx].y) * nor[oIdx].y;
      const oLonFine = (o.x - pts[oIdx].x) * tan[oIdx].x + (o.y - pts[oIdx].y) * tan[oIdx].y;

      // 沿赛道曲线弧长距离（解决弯道与长距离下笛卡尔投影失真，支持提前 105m 发现慢车）
      let sTrack = (cumDist[oIdx] + oLonFine) - (sHere + carLonFine);
      if (!isLinear) {
        if (sTrack > f1.totalLen * 0.5) sTrack -= f1.totalLen;
        else if (sTrack < -f1.totalLen * 0.5) sTrack += f1.totalLen;
      }
      // 近距离（<20m）使用精确包围盒纵向距离，中远距离使用沿赛道弧长距离
      const sLon = (Math.abs(sTrack) < 20 && geo.distCenter < 22) ? geo.sLon : sTrack;

      // 真实超车速差评估：
      // 仅当真正处于需要减速的弯道制动区 (inBrakingZone) 时，前车因更靠近弯心 (领先 sLon 米)，其正常制动包络速度比本车低 Δv_brake；
      // 在全油门高速环道或直道巡航时 (minCapAhead >= v)，前车正常速度即等于 v，任何低于 v 的前车均为可超越慢车！
      const capAtO = cornerCap[oIdx];
      const baseBrakeHere = PHYS.brake * brakeMult;
      const vNormalAtO = (inBrakingZone && sLon > 0)
        ? Math.max(minCapAhead, Math.min(capAtO, Math.sqrt(Math.max(0, v * v - 2 * baseBrakeHere * 0.88 * sLon))))
        : v;
      const isCappedSlowCar = (o.maxSpeed && car.maxSpeed && o.maxSpeed < car.maxSpeed - 3.0 && o.speed >= o.maxSpeed * 0.90 && v >= o.speed - 0.5);
      const slowAnomaly = isCappedSlowCar ? (car.maxSpeed - o.maxSpeed) * 0.40 : 0;
      const relClosing = Math.max(0, vNormalAtO - o.speed) + Math.max(0, slowAnomaly);
      const aheadHorizon = clamp(62 + relClosing * 1.45, 62, 108);

      const isRelevantAhead  = sLon >= 0 && sLon < aheadHorizon && geo.distCenter < aheadHorizon + 12;
      const isRelevantBehind = sLon < 0 && sLon > -70 && geo.distCenter < 55;
      const isAlongsideNow   = Math.abs(geo.sLon) < CAR_LENGTH + 1.8 && geo.distCenter < 16;
      if (!isRelevantAhead && !isRelevantBehind && !isAlongsideNow) continue;

      // 预测前车横向漂移趋势，预判其占道区间 [minOcc, maxOcc]
      const oHeadingErr = wrapAngle(o.angle - Math.atan2(tan[oIdx].y, tan[oIdx].x));
      const oLatVel = o.speed * Math.sin(oHeadingErr);
      const tReach = sLon > CAR_LENGTH
        ? clamp(sLon / Math.max(relClosing, 8.0), 0, 1.15)
        : (sLon > -CAR_LENGTH - 1.5 ? 0.38 : 0);
      const oMaxLat = Math.max(0.5, hw[oIdx] - wallMargin);
      const oClampLat = Math.max(oMaxLat, Math.abs(oLat));
      const driftScale = (v > 78 && curvHere < 0.012) ? 0.82 : 0.50;
      const oPredLat = clamp(oLat + oLatVel * tReach * driftScale, -oClampLat, oClampLat);
      const minOcc = Math.min(oLat, oPredLat);
      const maxOcc = Math.max(oLat, oPredLat);
      const leftCorridorRoom  = oMaxLat - maxOcc;
      const rightCorridorRoom = minOcc - (-oMaxLat);

      const nb = {
        car: o, geo, oIdx, oLat, oPredLat, minOcc, maxOcc,
        leftCorridorRoom, rightCorridorRoom,
        sLon, sTrack, relClosing, aheadHorizon
      };
      neighbors.push(nb);

      if (Math.abs(geo.sLon) < CAR_LENGTH * 0.85) {
        if (oLat > carLatNow) {
          hasLeftAlongside = true;
          if (oLat < leftWallCarLat) leftWallCarLat = oLat;
        } else {
          hasRightAlongside = true;
          if (oLat > rightWallCarLat) rightWallCarLat = oLat;
        }
      }

      if (sLon > 0 && sLon < 72 && Math.abs(oLat - carLatNow) < CAR_WIDTH + 0.65) {
        if (!directLeadCar || sLon < directLeadNb.sLon) {
          directLeadCar = o;
          directLeadGeo = geo;
          directLeadNb = nb;
        }
      }
    }
  }

  let chosenLat = idealLatF;
  let squeezeBailout = false;
  let hasActiveTrafficInteraction = false;

  if (car._lockTimer > 0) {
    car._lockTimer -= dt;
    if (car._lockTimer <= 0) car._lockedTargetLat = null;
  }

  const isBlockedAhead = !!(directLeadCar && directLeadNb.sLon < 36 && (v > directLeadCar.speed - 0.3 || cornerCap[idx] > directLeadCar.speed + 1.2));
  car._cruiseBlockT = isBlockedAhead ? (car._cruiseBlockT || 0) + dt : Math.max(0, (car._cruiseBlockT || 0) - dt * 2);
  const attacking = (car._cruiseBlockT || 0) > 0.35 || !!(directLeadCar && directLeadNb.relClosing > 2.5);

  if (neighbors.length === 0) {
    chosenLat = idealLatF;
    car._lockedTargetLat = null;
    car._latOffset = (car._latOffset || 0) * Math.max(0, 1 - dt * 5.0);
  } else {
    if (hasLeftAlongside && hasRightAlongside && (leftWallCarLat - rightWallCarLat) < SAFE_LAT_SEP * 2.0) {
      hasActiveTrafficInteraction = true;
      const clearGap = (leftWallCarLat - rightWallCarLat) - CAR_WIDTH;
      chosenLat = clamp((leftWallCarLat + rightWallCarLat) * 0.5, -maxLatF, maxLatF);
      if (clearGap < CAR_WIDTH + 0.15 && v > 22) squeezeBailout = true;
    } else {
      const futureCurv = centerK[iFar];
      const isSharpCornerAhead = Math.abs(futureCurv) > 0.014;
      const activeCornerK = Math.max(curvHere, Math.abs(centerK[iNear]), Math.abs(centerK[iMid]));
      const activeCornerSign = Math.sign(
        Math.abs(centerK[iNear]) >= curvHere ? centerK[iNear] : (cSigned || centerK[iMid])
      );
      const safeOvertakeMaxF = Math.max(0.5, hw[iFar] - 2.35);

      // 判定周围是否存在真正需要博弈的邻车（前方慢车、贴身并排车、或后方高速逼近车）：
      // 若所有邻车仅处于安全跟车距离外（无超车/并排/防追尾需求），直接锁定纯净 F1 理想线，消除离散采样滞后
      let hasSlowerObstacleAhead = false;
      for (let k = 0; k < neighbors.length; k++) {
        const nb = neighbors[k];
        if (nb.sLon > -CAR_LENGTH * 0.55 && nb.sLon < CAR_LENGTH + 2.2) {
          hasActiveTrafficInteraction = true;
        }
        if (nb.sLon >= -CAR_LENGTH * 0.55 && nb.sLon < nb.aheadHorizon) {
          const closing = nb.relClosing + (nb.car.braking && !car.braking && distToCorner > 110 ? 3.0 : 0);
          const isHeldUp = nb.sLon < CAR_LENGTH + 3.5 && v > 32 && nb.car.speed < cornerCap[nb.oIdx] * 0.82 && v >= nb.car.speed - 0.5;
          if ((nb.sLon < CAR_LENGTH + 2.2 && Math.abs(carLatNow - nb.oLat) < CAR_WIDTH + 1.2) ||
              (curvHere > 0.012 ? (closing > 3.2 || isHeldUp) : (closing > 0.85 || isHeldUp))) {
            hasSlowerObstacleAhead = true;
            hasActiveTrafficInteraction = true;
          }
        } else if (nb.sLon <= -CAR_LENGTH * 0.55 && nb.sLon > -70) {
          const rearGap = Math.max(0.2, -nb.sLon - CAR_LENGTH);
          const myDecelExpected = cornerCap[iNear] < v - 3.0 ? 8.5 : 0;
          const rearClosing = (nb.car.speed - v) + myDecelExpected;
          if (rearClosing > 1.5 && (rearGap / rearClosing) < 2.0) {
            hasActiveTrafficInteraction = true;
          }
        }
      }
      if (!hasSlowerObstacleAhead || inCorner) {
        car._lockedTargetLat = null;
        car._lockTimer = 0;
      }

      if (!hasActiveTrafficInteraction) {
        chosenLat = idealLatF;
      } else {
        let bestScore = -1e9;
        let bestCand = idealLatF;

        for (let cand = -maxLatF; cand <= maxLatF + 0.01; cand += 0.40) {
          const cLat = clamp(cand, -maxLatF, maxLatF);
          let score = 0;

          const distFromIdeal = Math.abs(cLat - idealLatF);
          score -= distFromIdeal * (isSharpCornerAhead ? 2.20 : 1.35);
          score -= Math.abs(cLat - carLatNow) * 0.32;

          // 安全底线 1：超车偏离理想线时严禁贴近外侧草地白线边缘
          if (Math.abs(cLat) > safeOvertakeMaxF && Math.abs(cLat) > Math.abs(idealLatF) + 0.20) {
            score -= (Math.abs(cLat) - safeOvertakeMaxF) * 55.0;
          }
          // 安全底线 2：急弯/中速弯中仅当候选点真正落入弯道外侧半幅（cLat * activeCornerSign < -1.2）时惩罚盲目外抛
          if (activeCornerK > 0.0085 && activeCornerSign !== 0 && cLat * activeCornerSign < -1.2) {
            const outsideShift = Math.max(0, (idealLatF - cLat) * activeCornerSign);
            if (outsideShift > 0.8) {
              score -= outsideShift * clamp((activeCornerK - 0.007) * 420, 2.0, 14.0);
            }
          }

          if (car._lockedTargetLat !== null && Math.abs(cLat - car._lockedTargetLat) < 1.0) {
            score += 3.2;
          }

          // F1 混战弯前内线卡位保护：idealLatF 已包含内线防守偏移，此处仅禁止候选点反向拉往外侧路肩
          if (hasPackCornerDefense && upcomingSign !== 0 && distToCorner > 22) {
            if (cLat * upcomingSign < -0.5) {
              score -= Math.abs(cLat) * 4.5;
            }
          } else if (attacking && !inCorner && directLeadNb && directLeadNb.sLon < 24 && directLeadNb.relClosing > 1.2) {
            if (futureCurv > 0.006 && cLat > idealLatF) score += 1.4;
            if (futureCurv < -0.006 && cLat < idealLatF) score += 1.4;
          }

          for (let k = 0; k < neighbors.length; k++) {
            const nb = neighbors[k];
            const o = nb.car;
            const sLon = nb.sLon;
            const latDistNow = Math.abs(cLat - nb.oLat);
            const latDistSwept = cLat < nb.minOcc ? (nb.minOcc - cLat) : (cLat > nb.maxOcc ? (cLat - nb.maxOcc) : 0);

            if (sLon > -CAR_LENGTH * 0.55 && sLon < CAR_LENGTH + 2.2) {
              if (latDistNow < HARD_LAT_SEP) {
                score -= 5000 + (HARD_LAT_SEP - latDistNow) * 2000;
              } else if (latDistNow < SAFE_LAT_SEP + 0.4) {
                score -= (SAFE_LAT_SEP + 0.4 - latDistNow) * 18.0;
              }
              if ((nb.oLat > carLatNow && cLat > nb.oLat - HARD_LAT_SEP * 0.8) ||
                  (nb.oLat < carLatNow && cLat < nb.oLat + HARD_LAT_SEP * 0.8)) {
                score -= 8000;
              }
            } else if (sLon >= CAR_LENGTH + 2.2 && sLon < nb.aheadHorizon) {
              const closing = nb.relClosing + (o.braking && !car.braking && distToCorner > 110 ? 3.0 : 0);
              // 仅当真正对前车构成超车态势（存在真实正速差 closing > 0.85，或已被显著低于赛道极速的慢车压制车尾）时才排斥前车尾流；
              // 若在发车加速或入弯制动区跟随同速 F1 前车（closing ≈ 0），绝不产生虚假排斥墙把本车推向弯道外侧！
              const isHeldUpBySlow = sLon < CAR_LENGTH + 3.5 && v > 32 && o.speed < cornerCap[nb.oIdx] * 0.82 && v >= o.speed - 0.5;
              const isSlowerAhead = curvHere > 0.012
                ? (closing > 3.2 || isHeldUpBySlow)
                : (closing > 0.85 || isHeldUpBySlow);
              if (isSlowerAhead) {
                // 严禁钻入宽度不足一车的死胡同窄缝（防超车被挤上草地）
                if (cLat >= nb.oLat && nb.leftCorridorRoom < CAR_WIDTH + 0.32 && nb.rightCorridorRoom >= CAR_WIDTH + 0.45) {
                  score -= 650.0;
                } else if (cLat <= nb.oLat && nb.rightCorridorRoom < CAR_WIDTH + 0.32 && nb.leftCorridorRoom >= CAR_WIDTH + 0.45) {
                  score -= 650.0;
                }

                // 高速满抓地弯道（如环道极速巡航）：向弯道外侧松舵变道无需额外向心力，若外侧宽敞则优先选外侧超车
                if (curvHere * v * v > latGrip * 0.75 && cSign !== 0) {
                  const isOuterSide = (cSign > 0 && cLat < nb.oLat && nb.rightCorridorRoom >= CAR_WIDTH + 0.8) ||
                                      (cSign < 0 && cLat > nb.oLat && nb.leftCorridorRoom >= CAR_WIDTH + 0.8);
                  if (isOuterSide) score += 4.5;
                }

                const avoidWidth = SAFE_LAT_SEP + 0.45;
                const ttcAhead = sLon / Math.max(closing, 1.0);
                if (latDistSwept < avoidWidth && (ttcAhead < 3.6 || sLon < 46)) {
                  const urgency = clamp((3.8 - Math.min(ttcAhead, 3.6)) / 2.4, 0.45, 2.6)
                    * clamp((nb.aheadHorizon - sLon) / 48, 0.35, 2.0);
                  const overlapRatio = (avoidWidth - latDistSwept) / avoidWidth;
                  // 强尾流排斥势场：只要前方有慢车，立竿见影排斥尾流区，果断选侧边通道
                  score -= (28.0 + 260.0 * overlapRatio) * urgency;
                  if (sLon < 24 && closing > 0.8) score -= 320.0 * overlapRatio;
                } else if (latDistSwept >= avoidWidth && latDistSwept < avoidWidth + 1.65 && (ttcAhead < 3.6 || sLon < 46)) {
                  // 贴边超车黄金走廊奖励：紧贴安全间距外侧顺畅通过，避免多余大角度横摆
                  score += 7.5 * clamp(closing / 5.0, 0.5, 2.0);
                }
              }
            } else if (sLon <= -CAR_LENGTH - 1.5 && sLon > -70) {
              const rearGap = Math.max(0.2, -sLon - CAR_LENGTH);
              const myDecelExpected = cornerCap[iNear] < v - 3.0 ? 8.5 : 0;
              const rearClosing = (o.speed - v) + myDecelExpected;
              if (rearClosing > 1.5) {
                const ttc = rearGap / rearClosing;
                if (ttc < 2.0) {
                  if (latDistNow < SAFE_LAT_SEP) {
                    const urgency = clamp((2.0 - ttc) / 1.5, 0.2, 2.5);
                    const overlap = (SAFE_LAT_SEP - latDistNow) / SAFE_LAT_SEP;
                    score -= 55.0 * urgency * overlap;
                  }
                  if (ttc < 1.15 && Math.abs(carLatNow - nb.oLat) < CAR_WIDTH + 0.45) {
                    rearUrgentThreat = true;
                  }
                }
              }
            }
          }

          if (score > bestScore) {
            bestScore = score;
            bestCand = cLat;
          }
        }

        chosenLat = bestCand;
        if (hasSlowerObstacleAhead && !inCorner && Math.abs(chosenLat - idealLatF) > 0.85 && Math.abs(chosenLat - (car._lockedTargetLat ?? 999)) > 0.75) {
          car._lockedTargetLat = chosenLat;
          car._lockTimer = 1.6;
        }
      }
    }

    const targetOffset = chosenLat - idealLatF;
    const isActivelyOvertaking = !!(directLeadNb && directLeadNb.sLon < 50 && directLeadNb.relClosing > 1.2);
    const isEmergencyDodge = rearUrgentThreat || hasLeftAlongside || hasRightAlongside || (isActivelyOvertaking && directLeadNb.sLon < 28);
    const latRate = isEmergencyDodge ? 10.5 : (isActivelyOvertaking ? 8.2 : 5.8);
    car._latOffset = (car._latOffset || 0) + (targetOffset - (car._latOffset || 0)) * Math.min(1, dt * latRate);
  }

  const nearOffsetScale = isIsolatedExit ? (0.55 + 0.45 * (1 - exitProgress)) : 1.0;
  const activeCornerK = Math.max(curvHere, Math.abs(centerK[iNear]), Math.abs(centerK[iMid]));
  const activeCornerSign = Math.sign(
    Math.abs(centerK[iNear]) >= curvHere ? centerK[iNear] : (cSigned || centerK[iMid])
  );
  const activeLatG = v * v * activeCornerK;
  // 超车安全横向边界：前车规划变道留 2.15m 余量，贴身并排让位允许用到 hw - 1.55m（车身半宽 1.0m，仍距草地 0.55m）
  const safeMaxN = neighbors.length > 0 ? Math.max(0.5, hw[iNear] - 2.15) : maxLatN;
  const safeMaxM = neighbors.length > 0 ? Math.max(0.5, hw[iMid]  - 2.15) : maxLatM;
  const safeMaxF = neighbors.length > 0 ? Math.max(0.5, hw[iFar]  - 2.15) : maxLatF;
  const asideMaxN = Math.max(0.5, hw[iNear] - 1.55);
  const asideMaxM = Math.max(0.5, hw[iMid]  - 1.55);
  const asideMaxF = Math.max(0.5, hw[iFar]  - 1.55);
  const limN = Math.max(safeMaxN, Math.min(maxLatN, Math.abs(idealLatN) + 0.25));
  const limM = Math.max(safeMaxM, Math.min(maxLatM, Math.abs(idealLatM) + 0.25));
  const limF = Math.max(safeMaxF, Math.min(maxLatF, Math.abs(idealLatF) + 0.25));

  let latN = clamp(idealLatN + (car._latOffset || 0) * nearOffsetScale, -limN, limN);
  let latM = clamp(idealLatM + (car._latOffset || 0), -limM, limM);
  let latF = clamp(idealLatF + (car._latOffset || 0), -limF, limF);

  // ★ 侧向超车走廊全前瞻贯通：当前方存在明显慢车或贴身并排邻车时，确保近/中/远三点全部推向安全超车侧
  let overtakingClose = false;
  let minOvertakeSLon = Infinity;
  let lowN = -limN, highN = limN;
  let lowM = -limM, highM = limM;
  let lowF = -limF, highF = limF;
  let hasBoundN = false, hasBoundF = false;
  for (let k = 0; k < neighbors.length; k++) {
    const nb = neighbors[k];
    const o = nb.car;
    if (nb.sLon <= -CAR_LENGTH * 0.50 || nb.sLon > Math.max(64, lookFar + 16)) continue;
    const closing = nb.relClosing + (o.braking && !car.braking && distToCorner > 110 ? 2.8 : 0);
    // 仅当真正对前车构成超车态势（存在真实超额速差或已进入贴身并排区），才强制推开三前瞻点；
    // 急弯或入弯制动区跟随同速 F1 时绝不把目标点往外侧强推（防止发夹弯被挤去外圈损失 30m 路程）
    const isAlongsideClose = nb.sLon < CAR_LENGTH + 2.2
      && (Math.abs(carLatNow - nb.oLat) < CAR_WIDTH + 1.55 || Math.abs(latN - nb.oLat) < CAR_WIDTH + 1.35);
    const shouldForcePass = isAlongsideClose || (nb.sLon >= CAR_LENGTH + 2.2 && (curvHere > 0.012 ? closing > 3.5 : closing > 1.3));
    if (!shouldForcePass) continue;

    // 判定超车侧（+1 为左侧/内侧，-1 为右侧/外侧）：
    // 若纵向距离已贴近（< CAR_LENGTH + 5.5m），严禁横跨车头变向；但若前车远于 1.8m 车尾净空且当前侧已无超车空间，则切换至宽敞侧或放弃强推
    let passDir;
    if (nb.sLon < CAR_LENGTH + 5.5) {
      passDir = (carLatNow >= nb.oLat) ? 1 : -1;
    } else {
      passDir = (chosenLat >= nb.oLat) ? 1 : -1;
      if (passDir > 0 && nb.leftCorridorRoom < CAR_WIDTH + 0.45 && nb.rightCorridorRoom >= CAR_WIDTH + 0.55) {
        passDir = -1;
      } else if (passDir < 0 && nb.rightCorridorRoom < CAR_WIDTH + 0.45 && nb.leftCorridorRoom >= CAR_WIDTH + 0.55) {
        passDir = 1;
      }
    }

    // 已经明确领先（nb.sLon < -1.35m）时，绝不允许后车在弯道中把本车从弯心往外圈挤开
    if (nb.sLon < -1.35 && activeCornerK > 0.008 && activeCornerSign !== 0 && passDir * activeCornerSign < 0) {
      continue;
    }

    // 高速大半径弧线（v > 75m/s）外侧超车时补偿纯追踪长弦内偏量，贴身并排时加大横向安全净空防擦挂
    const isHighSpeedSweep = v > 75 && curvHere < 0.012;
    const tightAlongsideExtra = (isAlongsideClose && Math.abs(nb.sLon) < CAR_LENGTH * 0.90 && curvHere > 0.012) ? 0.25 : 0;
    const curveExtra = ((isHighSpeedSweep && cSign * passDir < 0) ? clamp(curvHere * 135, 0, 1.05) : 0) + tightAlongsideExtra;
    const reqClear = CAR_WIDTH + (isAlongsideClose ? 0.75 : 0.58) + curveExtra;
    const boundLat = passDir > 0 ? (nb.maxOcc + reqClear) : (nb.minOcc - reqClear);

    const passSideRoom = passDir > 0 ? nb.leftCorridorRoom : nb.rightCorridorRoom;
    // 安全底线：若未进入并排区（sLon > CAR_LENGTH + 1.2）且：（1）超车侧剩余路面宽度不足安全余量，或（2）在急弯中试图被推到弯道外侧半幅边缘硬超，则放弃强推
    const isUnsafeOutsideCornerPass = activeCornerK > 0.0085 && activeCornerSign !== 0 && (passDir * activeCornerSign < 0)
      && (boundLat * activeCornerSign < -1.8)
      && !(closing > 9.0 && v < cornerCap[idx] * 0.78 && passSideRoom >= CAR_WIDTH + 1.6);
    if (nb.sLon > CAR_LENGTH + 1.2 && (passSideRoom < CAR_WIDTH + 0.45 || isUnsafeOutsideCornerPass)) {
      continue;
    }

    // 高横向 G 弯道中，若前车距离极近且需大跨度横移变线（如前车群突然关门），严禁强拽近点猛打方向防高速失控飞出弯外
    if (nb.sLon > CAR_LENGTH + 1.2 && activeLatG > latGrip * 0.42 && Math.abs(carLatNow - boundLat) > 2.2 && nb.sLon < v * 0.30) {
      continue;
    }

    const curMaxN = isAlongsideClose ? asideMaxN : safeMaxN;
    const curMaxM = isAlongsideClose ? asideMaxM : safeMaxM;
    const curMaxF = isAlongsideClose ? asideMaxF : safeMaxF;

    if (nb.sLon >= -0.5 && nb.sLon < lookFar + 18) {
      hasBoundF = true;
      if (passDir > 0) {
        lowF = Math.max(lowF, clamp(boundLat, -curMaxF, curMaxF));
        lowM = Math.max(lowM, clamp(boundLat, -curMaxM, curMaxM));
      } else {
        highF = Math.min(highF, clamp(boundLat, -curMaxF, curMaxF));
        highM = Math.min(highM, clamp(boundLat, -curMaxM, curMaxM));
      }
    }
    if (nb.sLon < lookMid + 22) {
      hasBoundN = true;
      if (passDir > 0) {
        lowN = Math.max(lowN, clamp(boundLat, -curMaxN, curMaxN));
      } else {
        highN = Math.min(highN, clamp(boundLat, -curMaxN, curMaxN));
      }
      // 仅在低横向 G 的直道或缓弯启用近锚点收缩快速变道，高 G 弯或急弯中绝不猛拽车头防失控冲出弯外
      if (activeCornerK < 0.0068 && activeLatG < latGrip * 0.35 && nb.sLon < 44 && Math.abs(carLatNow - nb.oLat) < CAR_WIDTH + 0.75) {
        overtakingClose = true;
        if (nb.sLon < minOvertakeSLon) minOvertakeSLon = nb.sLon;
      }
    }
  }
  if (hasBoundF) {
    latF = lowF <= highF ? clamp(latF, lowF, highF) : clamp((lowF + highF) * 0.5, -asideMaxF, asideMaxF);
    latM = lowM <= highM ? clamp(latM, lowM, highM) : clamp((lowM + highM) * 0.5, -asideMaxM, asideMaxM);
  }
  if (hasBoundN) {
    latN = lowN <= highN ? clamp(latN, lowN, highN) : clamp((lowN + highN) * 0.5, -asideMaxN, asideMaxN);
  }

  // 高横向 G 负荷弯道中限制近点向弯道外侧的单步突变幅度，杜绝高速弯中反打满舵失控
  if (activeLatG > latGrip * 0.38 && activeCornerSign !== 0) {
    if (activeCornerSign > 0 && latN < carLatNow - 2.1) latN = carLatNow - 2.1;
    if (activeCornerSign < 0 && latN > carLatNow + 2.1) latN = carLatNow + 2.1;
  }

  // 当近距离变道超越明显慢车时，将近前瞻锚点收缩至慢车车尾前方（0.70 * sLon），确保在到达慢车前即完成横向变道
  const iSteerNear = (overtakingClose && minOvertakeSLon < lookNear)
    ? advanceByMeters(f1, idx, clamp(minOvertakeSLon * 0.70, 8, lookNear))
    : iNear;

  const dxN = pts[iSteerNear].x + nor[iSteerNear].x * latN - car.x;
  const dyN = pts[iSteerNear].y + nor[iSteerNear].y * latN - car.y;
  const dxM = pts[iMid].x + nor[iMid].x * latM - car.x;
  const dyM = pts[iMid].y + nor[iMid].y * latM - car.y;
  const targetX = pts[iFar].x + nor[iFar].x * latF;
  const targetY = pts[iFar].y + nor[iFar].y * latF;
  const dxF = targetX - car.x;
  const dyF = targetY - car.y;

  const aN = wrapAngle(Math.atan2(dyN, dxN) - car.angle);
  const aM = wrapAngle(Math.atan2(dyM, dxM) - car.angle);
  const aF = wrapAngle(Math.atan2(dyF, dxF) - car.angle);

  // 转向融合权重：弯前外线准备区、近距变道超车与弯心偏重近/中点精确走线，出弯直道偏重远点提前回正方向盘
  const wN = (inEntrySetup || overtakingClose) ? 0.48 : (0.25 + cornerIntensity * 0.25);
  const wF = (inEntrySetup || overtakingClose) ? 0.18 : (0.50 - cornerIntensity * 0.30);
  const wM = 1.0 - wN - wF;
  const alpha = aN * wN + aM * wM + aF * wF;

  const dist = (Math.hypot(dxF, dyF) * wF + Math.hypot(dxM, dyM) * wM + Math.hypot(dxN, dyN) * wN) || 1;
  const kappa = 2 * Math.sin(alpha) / dist;
  // 循迹刹车摩擦圆转向补偿：制动中可用横向抓地力略降，提前放大目标转向角防入弯推头
  const effGrip = latGrip * (car.braking ? 0.94 : 1.0);
  const omegaMax = Math.min(effGrip / Math.max(v, 1), maxOmega) * Math.min(1, v / 3);
  let duty = clamp((v * kappa) / (omegaMax || 1), -1, 1);

  /* ---- 主动侧向防撞（第二道防线，含赛道边界防推入草地约束） ---- */
  let guardSteer = 0;
  const guardWidth = (v > 78 && curvHere < 0.012) ? (CAR_WIDTH + 1.55) : (CAR_WIDTH + 1.42);
  for (let k = 0; k < neighbors.length; k++) {
    const geo = neighbors[k].geo;
    if (Math.abs(geo.sLon) < CAR_LENGTH + 2.4 && Math.abs(geo.dLat) < guardWidth) {
      const pushSign = geo.dLat >= 0 ? -1 : 1;
      const edgeRoom = (hw[idx] - 1.65) - carLatNow * pushSign;
      const edgeScale = clamp(edgeRoom / 1.35, 0, 1);
      const isCloseDoor = Math.abs(geo.dLat) < CAR_WIDTH + 0.55;
      const cornerOutScale = (!isCloseDoor && inCorner && cSign !== 0 && pushSign * cSign < 0) ? 0.55 : 1.0;
      const penetration = guardWidth - Math.abs(geo.dLat);
      const push = clamp(penetration / 1.35, 0, 1) * (isCloseDoor ? 0.45 : 0.28) * edgeScale * cornerOutScale;
      guardSteer += pushSign * push;
    }
  }
  if (guardSteer !== 0) duty = clamp(duty + clamp(guardSteer, -0.42, 0.42), -1, 1);

  /* ---- 实时赛道边界防冲出物理底线护栏 (Safety Bottom-Line Shield) ---- */
  const trackHeading = Math.atan2(tan[idx].y, tan[idx].x);
  const headingErr = wrapAngle(car.angle - trackHeading);
  const vLat = v * Math.sin(headingErr);
  const centrifOut = (inCorner && cSigned !== 0) ? (-cSigned * v * v * 0.0055) : 0;
  const predLat = carLatNow + vLat * 0.36 + centrifOut;
  const safeTrackEdge = hw[idx] - 1.55;
  const hasCloseDoorRival = neighbors.some((nb) => nb.sLon > -CAR_LENGTH * 0.55 && nb.sLon < CAR_LENGTH * 1.8 && Math.abs(nb.oLat - carLatNow) < CAR_WIDTH * 2.2);
  const f1Tol = hasCloseDoorRival ? 0.16 : 0.28;
  const edgeTrig = hasCloseDoorRival ? (hw[idx] - 1.72) : (hw[idx] - 1.65);
  const isBeyondF1Line = Math.abs(carLatNow) > Math.abs(f1.f1Lat[idx]) + f1Tol || Math.abs(carLatNow) > edgeTrig;
  let boundaryEmergency = false;
  if (neighbors.length > 0 && isBeyondF1Line && (Math.abs(carLatNow) > hw[idx] - 1.75 || Math.abs(predLat) > safeTrackEdge)) {
    const outSide = Math.sign(Math.abs(predLat) > Math.abs(carLatNow) ? predLat : carLatNow);
    const excessEdge = Math.max(Math.abs(predLat) - safeTrackEdge, Math.abs(carLatNow) - (hw[idx] - 1.75));
    const recoverPull = clamp(excessEdge * 0.55, 0.15, 0.85);
    if (outSide > 0) duty = Math.max(duty - recoverPull, -1.0);
    else if (outSide < 0) duty = Math.min(duty + recoverPull, 1.0);
    if (v > 26 && (Math.abs(carLatNow) > hw[idx] - 1.25 || Math.abs(predLat) > hw[idx] - 0.85)) {
      boundaryEmergency = true;
    }
  }

  const steerAlpha = Math.min(1, dt * (inCorner || neighbors.length > 0 ? 32 : 22));
  out.steer = (out.steer || 0) + (duty - (out.steer || 0)) * steerAlpha;
  out.left = out.steer < -0.05;
  out.right = out.steer > 0.05;

  /* ---- 5. 3D 纵向控制：基于真实物理弧长的闭环刹车包络 + 坡度补偿 + 偏离理想线真实曲率限速 ---- */
  const baseBrake = PHYS.brake * brakeMult;
  const gNow = (grade && grade[idx]) || 0;
  const brakeCap = Math.max(baseBrake * 0.45, baseBrake + 9.81 * gNow);
  const lightCap = brakeCap * PHYS.lightBrakeFactor;

  const scanDistance = Math.max(340, v * v / (2 * lightCap) + 95);

  // 当近距离超车或并排博弈真正迫使本车偏离 F1 切弯理想线 (f1Lat) 时，无法享受切 S 弯拉直后的小曲率 (f1CurvS)，
  // 仅在切弯拉直路段（真实曲率显著大于 f1CurvS）或被挤向弯道外侧时平滑过渡至真实曲率物理极速，绝不在普通跟车时无故减速！
  let hasCloseTrafficDisplacing = false;
  for (let k = 0; k < neighbors.length; k++) {
    const nb = neighbors[k];
    if (nb.sLon > -CAR_LENGTH * 0.35 && nb.sLon < 18 && (nb.relClosing > 1.0 || nb.sLon < CAR_LENGTH + 2.2)) {
      hasCloseTrafficDisplacing = true;
      break;
    }
  }
  const lineDisp = hasCloseTrafficDisplacing
    ? Math.max(Math.abs(latN - f1.f1Lat[iNear]), Math.abs(latM - f1.f1Lat[iMid]) * 0.85)
    : 0;
  const offLineRatio = clamp((lineDisp - 1.35) / 2.20, 0, 1);
  const onOutsideOfTurn = activeCornerSign !== 0 && ((carLatNow - idealLatN) * activeCornerSign < -1.3 || (latN - idealLatN) * activeCornerSign < -1.3);

  const kRawHere = Math.max(curvHere, Math.abs(rcurvS[idx]) * 1.05);
  const isCutChicaneHere = (kRawHere > Math.abs(f1.f1CurvS[idx]) * 1.24 || (onOutsideOfTurn && kRawHere > 0.0115)) && kRawHere > 0.0105;
  const vSafeHere = (offLineRatio > 0 && isCutChicaneHere)
    ? Math.sqrt((latGrip * 0.86) / kRawHere)
    : cornerCap[idx];
  const effectiveCapHere = cornerCap[idx] - (cornerCap[idx] - Math.min(cornerCap[idx], vSafeHere)) * offLineRatio;

  let env1 = effectiveCapHere;
  let env2 = effectiveCapHere;
  let aReq = 0;

  for (let s = 1; s < N; s++) {
    const j = isLinear ? Math.min(idx + s, N - 1) : (idx + s) % N;
    if (isLinear && j === idx) break;
    let d = cumDist[j] - sHere;
    if (!isLinear && d <= 0) d += f1.totalLen;
    if (d <= 0) continue;
    if (d > scanDistance) break;

    let cap = cornerCap[j];
    if (offLineRatio > 0 && d < 115) {
      const kRawJ = Math.max(Math.abs(centerK[j]), Math.abs(rcurvS[j]) * 1.05);
      const isCutChicaneJ = (kRawJ > Math.abs(f1.f1CurvS[j]) * 1.24 || (onOutsideOfTurn && kRawJ > 0.0115)) && kRawJ > 0.0105;
      if (isCutChicaneJ) {
        const distDecay = clamp(1.0 - (d - 38) / 88, 0.30, 1.0);
        const vSafeJ = Math.sqrt((latGrip * 0.86) / kRawJ);
        cap = cap - (cap - Math.min(cap, vSafeJ)) * (offLineRatio * distDecay);
      }
    }
    if (cap < v) {
      const req = (v * v - cap * cap) / (2 * d);
      if (req > aReq) aReq = req;
    }
    const gJ = (grade && grade[j]) || 0;
    const gAvg = 0.55 * gNow + 0.45 * gJ;
    const effBrakeJ = Math.max(baseBrake * 0.45, baseBrake + 9.81 * gAvg);
    const effLightJ = effBrakeJ * PHYS.lightBrakeFactor;
    const r1 = Math.sqrt(cap * cap + 2 * effLightJ * d);
    const r2 = Math.sqrt(cap * cap + 2 * effBrakeJ * 0.98 * d);
    if (r1 < env1) env1 = r1;
    if (r2 < env2) env2 = r2;
  }

  // 出弯直道探测
  let exitStraight = false;
  {
    let maxCurv = 0;
    for (let d = 18; d <= 60; d += 6) {
      const c = Math.abs(centerK[advanceByMeters(f1, idx, d)]);
      if (c > maxCurv) maxCurv = c;
    }
    exitStraight = (maxCurv < 0.005);
  }

  /* ---- 跟车与侧向不刹车超车控制（安全底线优先：弯中无安全内线绝不强冲外圈） ---- */
  let emergency = false;
  for (let k = 0; k < neighbors.length; k++) {
    const nb = neighbors[k];
    const o = nb.car;
    const geo = nb.geo;
    if (nb.sLon <= 0 || nb.sLon > 55) continue;

    const latSepTrack = Math.abs(carLatNow - nb.oLat);
    const latOverlapNow  = (Math.abs(geo.dLat) < CAR_WIDTH + 0.25 && latSepTrack < CAR_WIDTH + 0.25)
      || (nb.sLon < CAR_LENGTH + 4.2 && Math.abs(geo.dLat) < CAR_WIDTH + 0.12);
    const steeringIntoNb = nb.sLon < CAR_LENGTH + 4.5 && Math.abs(geo.dLat) < CAR_WIDTH + 0.15
      && (latN - carLatNow) * (nb.oLat - carLatNow) > 0.2;
    const latOverlapDest = (Math.abs(latF - nb.oLat) < CAR_WIDTH + 0.30 && Math.abs(latN - nb.oLat) < CAR_WIDTH + 0.30) || steeringIntoNb;
    const cornerPathConflict = activeCornerK > 0.0095 && nb.sLon > CAR_LENGTH + 0.5 && nb.sLon < 22
      && (Math.abs(latN - nb.oPredLat) < CAR_WIDTH + 0.18 || Math.abs(latM - nb.oPredLat) < CAR_WIDTH + 0.18);

    // 判断拟超车侧是否有真实、安全的沥青超车走廊：
    const passSide = (latF >= nb.oLat) ? 1 : -1;
    const passSideRoom = passSide > 0 ? nb.leftCorridorRoom : nb.rightCorridorRoom;
    const latToClear = Math.max(0, (CAR_WIDTH + 0.14) - Math.min(Math.abs(geo.dLat), latSepTrack));
    const gap = nb.sLon - CAR_LENGTH;
    const isRiskyCornerPass = (activeCornerK > 0.0090 && (passSide * activeCornerSign < 0) && (latF * activeCornerSign < -1.5 || passSideRoom < CAR_WIDTH + 0.75))
      || (activeLatG > latGrip * 0.45 && latToClear > 0.55 && gap < v * 0.22);
    const hasSideSpace = passSideRoom >= CAR_WIDTH + 0.48 && !isRiskyCornerPass;
    const canPassOnSide = (!latOverlapDest && hasSideSpace) && (gap > 0.85 + latToClear * 1.05);

    if ((latOverlapNow || cornerPathConflict) && !canPassOnSide) {
      const closing = v - o.speed;
      if (gap < 1.15 && closing > 0.5 && geo.sLon > 1.5 && Math.abs(geo.dLat) < CAR_WIDTH + 0.25) {
        emergency = true;
        break;
      }
      const leadEffSpeed = Math.max(0, o.speed - (o.braking ? 1.8 : 0));
      const safeGap = Math.max(gap - (attacking ? 1.4 : 2.0), 0.1);
      const followCap1 = Math.sqrt(leadEffSpeed * leadEffSpeed + 2 * lightCap * 0.95 * safeGap);
      const followCap2 = Math.sqrt(leadEffSpeed * leadEffSpeed + 2 * brakeCap * 0.88 * safeGap);
      if (followCap1 < env1) env1 = followCap1;
      if (followCap2 < env2) env2 = followCap2;
    }
  }
  if (squeezeBailout) {
    env1 = Math.min(env1, Math.max(20, v - 2.0));
  }

  /* ---- 6. F1 极限晚刹、循迹轻刹 (Trail-Braking) 与过弯心全油门弹射 ---- */
  const steerMag = Math.abs(out.steer);
  const effectiveCap = effectiveCapHere;

  if (emergency) {
    out.brake = 2;
  } else if (rearUrgentThreat && !directLeadCar && v < env2 * 1.04) {
    out.brake = v > env2 ? 1 : 0;
  } else if (aReq > lightCap * 1.04) {
    out.brake = 2; // 直道末端极限晚刹
  } else if (v > env2 + 0.25) {
    out.brake = 2;
  } else if (v > env1 + 0.18 || boundaryEmergency) {
    out.brake = 1; // 弯前循迹轻刹过渡或边界防出草点刹
  } else {
    out.brake = 0;
  }

  if (emergency || squeezeBailout || boundaryEmergency) {
    out.up = false;
  } else if (brakeMult < 0.60 && Math.abs(duty) > 0.85 && v > effectiveCap * 0.86) {
    // 大马力低制动倍率电车摩擦圆保护：满舵接近极限时瞬时松油，立刻恢复 100% 横向抓地力防推头出草
    out.up = false;
  } else if (rearUrgentThreat && out.brake === 0 && !directLeadCar && v < env2) {
    out.up = true;
  } else if (out.brake === 1 && steerMag > 0.12 && steerMag < 0.65
    && v < effectiveCap + 0.6 && Math.abs(alpha) < 0.38) {
    // ★ Trail-Braking 提前给油重叠：轻刹中车头一指向出弯即开油门！
    out.up = true;
  } else if (out.brake === 0) {
    const throttleMargin = (isIsolatedExit || exitStraight) ? -0.30 : 0.05;
    out.up = v < effectiveCap - throttleMargin;
  } else {
    out.up = false;
  }

  out.targetX = targetX;
  out.targetY = targetY;
  out.targetSpeed = env1;
}
/* ================= 赛车真实性能与算法配置表：已拆到 ./carConfigs.js ================= */
// 这里保留同名导出，历史调用方（main.js / netrace.js / server / scripts）无需改动。
import { AI_CONFIGS } from "./carConfigs.js";
export { AI_CONFIGS };

/* ================= 按需参赛车型 =================
   两种"玩家不选就别出场"的车：
   · heavyModel：小米 SU8 / 仰望 U9X 的真车模（各 ~5MB：glTF + webp 贴图），
     无条件加载会拖慢开局，模型随之不下载；
   · pickOnly：越野卡车（TRAIL RIG），车慢又占发车位，不选它就别让它来凑数。
   规则一致：玩家没选 → 电脑阵容里也不出现；玩家选了 → 同队 2 台（AI 的车 + 玩家车）。 */
export function isHeavyModelCar(cfg) {
  return !!(cfg && cfg.heavyModel);
}

export function isPickOnlyCar(cfg) {
  return !!(cfg && (cfg.heavyModel || cfg.pickOnly));
}

// 按玩家选择过滤阵容：playerCarId 对应的按需车型保留（玩家自己要开），其余剔除
export function rosterForPlayer(configs, playerCarId) {
  return configs.filter(c => !isPickOnlyCar(c) || c.id === playerCarId);
}

/* ================= 同队二号车（vs 模式每款车出 2 台） =================
   同一车型的两台车不能挂同一个车手名，否则计时塔/结算里会出现两行同名车手。
   配置项用 driver2 描述第二台的号码与车手；这里返回浅拷贝（不动 AI_CONFIGS 本体），
   perf / 涂装 / 车队等其余字段与一号车完全一致。没配 driver2 的车型退回一号车手。
   驾驶算法也不再和一号车统一：二号车改用 superDriver，
   同队双车会跑出两种驾驶风格 —— 算法实现就在本模块，配置表里放函数会形成循环依赖。 */
export function secondSeatConfig(cfg) {
  const d2 = cfg && cfg.driver2;
  if (!d2) return cfg;
  return {
    ...cfg,
    number: d2.number ?? cfg.number,
    driverName: d2.driverName ?? cfg.driverName,
    driverShort: d2.driverShort ?? cfg.driverShort,
    driverCode: d2.driverCode ?? cfg.driverCode,
    driver: d2.driver || superDriver,
    seat: 2                       // 计时塔标号：2 = 二号车
  };
}

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
  car.seat = cfg.seat ?? 0;         // 1 = 一号车 / 2 = 二号车（0 = 无同队双车，如观战/在线）
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
