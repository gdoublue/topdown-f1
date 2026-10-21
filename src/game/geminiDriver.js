// Gemini Driver：终极进化算法 Super Driver Pro
// 含后向防追尾预判 + 非最佳路径智能超车博弈 + 曲率自适应三段前瞻 + 时间最优闭环刹车规划
//
// 依赖 ai.js 中的赛道数据表与通用工具（弯速表生成、角度归一化），
// 仅在函数调用期使用，不存在模块求值期的循环依赖问题。

import { N, pts, nor, hw, curvS, isLinear, currentTrackId } from "../track/geometry.js";
import { PHYS } from "../config.js";
import { clamp } from "../utils.js";
import { CAR_LENGTH, CAR_WIDTH, getCarDistance } from "../car/physics.js";
// 实时赛道数据（DS / lineX / lineY / rcurvS 在换赛道时会整体重建，import 绑定可拿到最新值）
import { DS, lineX, lineY, rcurvS, wrapAngle, getSuperCornerCap } from "./ai.js";
// perf 视图 → 真 perf（玩家算法传入的是只读视图）
import { perfAliasOf } from "./driverSandbox.js";

// 本模块专属弯速表缓存（按 perf 对象 + 赛道 id 双键区分）。
// 注意：不能复用 ai.js 里的 _superCornerCapCache —— 那张表存的是均匀 30m 窗口的弯速，
// 而这里的 Apex-Release 表是非对称窗口（-2m ~ +10.5m）且做过出弯折损，混用会返回错误的限速表。
const _apexCapCache = new Map();   // perf -> Map(trackId -> cap)

// 换赛道后由 ai.js 的 rebuildAITrack() 调用，清空缓存重建专属速度表
export function resetApexCapCache() {
  _apexCapCache.clear();
}

/* ================= 终极全向极限算法：Super Driver Apex-TrackOut =================
   核心升级：
   1. 破除原版 30m 后向限速锁死：自定义非对称弯速表（-2m ~ +10.5m），过弯心瞬间释放限速，提前 28m 加速
   2. 非连续弯道智能识别：区分“孤立弯道出弯”与“连续 S 弯/复合弯”
   3. 出弯外抛吃路肩 (Track-Out)：非连续弯道过弯心后主动向外侧安全边界 (hw-2.2m) 外抛，放大出弯半径并提前回正方向盘
   4. 全向 360° 车宽刚体光栅扫描：兼顾前后左右来车、三明治并排居中、后车防追尾 TTC 闪避与非最佳路径智能超车
================================================================================ */

// 构建专属“过弯心即释放”的非对称极限速度表（取代原版前后 30m 对称锁死的 buildCarVTarget）
// 同时导出给自动驾驶（玩家自定义算法）调用
export function getApexReleaseCap(perf) {
  // 算法手里是 car.perf 的只读视图，归一化回真 perf，才能和引擎共用同一张表
  const key = perfAliasOf(perf);
  let byTrack = _apexCapCache.get(key);
  if (!byTrack) { byTrack = new Map(); _apexCapCache.set(key, byTrack); }
  let cap = byTrack.get(currentTrackId);
  if (cap) return cap;

  const topSpeed = perf.maxSpeed ? perf.maxSpeed[0] : PHYS.maxSpeed[0];
  const latGrip  = perf.latGrip ?? PHYS.latGrip;
  const maxOmega = perf.maxOmega ?? PHYS.maxOmega;
  const A_LAT    = latGrip * Math.min(1.0, 0.965 * (perf.cornerGripMult ?? 1)); // 压榨 96.5% 极限横向抓地力
  cap = new Float32Array(N);

  // 关键突破：后向仅看 2.0m（半个车身），前向看 10.5m（纯追踪转向提前量）
  // 彻底消除原版 j = -30m 导致的“出弯后 30 米依然维持弯心最低限速”的顽疾！
  const wBack  = Math.max(1, Math.round(2.0 / Math.max(0.1, DS)));
  const wAhead = Math.max(1, Math.round(10.5 / Math.max(0.1, DS)));
  const step15 = Math.max(1, Math.round(15.0 / Math.max(0.1, DS)));
  const step55 = Math.max(1, Math.round(55.0 / Math.max(0.1, DS)));

  for (let i = 0; i < N; i++) {
    let k = 0;
    for (let j = -wBack; j <= wAhead; j++) {
      const c = Math.abs(rcurvS[(i + j + N) % N]);
      if (c > k) k = c;
    }

    // 探测是否为“非连续弯道出弯段”：当前曲率正在减小，且前方 15~55m 无反向 S 弯
    const cHere = rcurvS[i];
    const absHere = Math.abs(cHere);
    const absAhead = Math.abs(rcurvS[(i + step15) % N]);
    let isIsolatedExit = absHere > 0.004 && absAhead < absHere * 0.88;
    if (isIsolatedExit) {
      const cSign = Math.sign(cHere);
      for (let s = step15; s <= step55; s += 2) {
        if (cSign * rcurvS[(i + s) % N] < -0.0055) {
          isIsolatedExit = false; // 前方有反向连续弯道，不额外放宽出弯半径
          break;
        }
      }
    }

    // 若为非连续弯道出弯，允许利用外抛走线（Track-Out）放大等效转弯半径，等效曲率打 0.86 折
    if (isIsolatedExit) k *= 0.86;

    const R = k > 1e-5 ? 1 / k : 1e6;
    const vGrip = Math.sqrt(A_LAT * R);
    const vOmega = k > 1e-5 ? maxOmega / k : Infinity;
    cap[i] = Math.min(topSpeed, vGrip, vOmega);
  }

  byTrack.set(currentTrackId, cap);
  return cap;
}

export function geminiDriver(car, out, dt, otherCars)
{
  const idx = car.nearIdx % N;
  const v = Math.abs(car.speed);
  const perf = car.perf || {};
  const latGrip = perf.latGrip ?? PHYS.latGrip;
  const maxOmega = perf.maxOmega ?? PHYS.maxOmega;
  const cornerCap = getApexReleaseCap(perf);

  // 初始化状态变量
  if (car._cruiseStuck == null) {
    car._cruiseStuck = 0;
    car._cruiseRev = 0;
    car._cruiseMoved = false;
    car._latOffset = 0;
    car._lockedTargetLat = null;
    car._lockTimer = 0;
    car._blockTimer = 0;
  }

  /* ---- 1. 碰撞受困自动倒车脱身 ---- */
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

  /* ---- 2. ★ 弯道相位识别：区分“入弯/弯心”、“非连续弯道出弯 (Track-Out)”与“连续 S 弯” ---- */
  const cSigned = curvS[idx];
  const curvHere = Math.abs(cSigned);
  const cSign = Math.sign(cSigned); // >0 左弯(内侧为+nor, 外侧为-nor); <0 右弯(内侧为-nor, 外侧为+nor)
  const inCorner = curvHere > 0.007;

  // 采样前方 12m、24m 与 20~68m 区间曲率，判断弯道走向
  const step12 = Math.max(1, Math.round(12 / DS));
  const step24 = Math.max(2, Math.round(24 / DS));
  const step68 = Math.max(4, Math.round(68 / DS));
  const curv12 = Math.abs(curvS[(idx + step12) % N]);
  const curv24 = Math.abs(curvS[(idx + step24) % N]);

  // 判断是否已过弯心（曲率正在明显衰减释放）
  const isPastApex = inCorner && (curv12 < curvHere * 0.93) && (curv24 <= curv12 * 1.05);

  // 扫描前方 16m ~ 68m 是否存在连续反向弯道（S弯）或同向二次急弯
  let hasNextReverseCorner = false;
  let hasNextTightCorner = false;
  let nextReverseSign = 0;
  if (inCorner) {
    for (let s = step12; s <= step68; s += 2) {
      const futC = curvS[(idx + s) % N];
      if (cSign !== 0 && cSign * futC < -0.0055) {
        hasNextReverseCorner = true;
        nextReverseSign = Math.sign(futC);
        break;
      }
      if (s > step24 && Math.abs(futC) > Math.max(curvHere * 0.95, 0.011)) {
        hasNextTightCorner = true;
      }
    }
  }

  // ★ 核心标志：非连续弯道出弯（已过弯心 + 前方无反向S弯 + 无二次收紧急弯）
  const isIsolatedExit = isPastApex && !hasNextReverseCorner && !hasNextTightCorner;
  // 出弯释放程度 (0 = 仍在弯心, 1 = 彻底释放出弯)
  const exitProgress = isIsolatedExit ? clamp(1.0 - (curv24 / Math.max(curvHere, 1e-4)), 0.25, 1.0) : 0;

  /* ---- 3. 曲率与出弯相位自适应三段前瞻 ---- */
  const cornerIntensity = clamp((curvHere - 0.007) / 0.025, 0, 1);

  // ★ 若处于非连续弯道出弯：立即拉长近点与远点前瞻，让视线跳过内侧路肩直指加速直道！
  const nearFactor = isIsolatedExit ? (0.35 + 0.16 * exitProgress) : (inCorner ? 0.34 : 0.48);
  const farFactor  = isIsolatedExit ? (0.58 + 0.24 * exitProgress) : (inCorner ? 0.54 : 0.78);
  const lookNear = Math.max(8, v * nearFactor);
  const lookFar  = Math.min(95, (inCorner && !isIsolatedExit ? 14 : 18) + v * farFactor);
  const lookMid  = (lookNear + lookFar) * 0.5;

  const iNear = (idx + Math.round(lookNear / DS)) % N;
  const iMid  = (idx + Math.round(lookMid  / DS)) % N;
  const iFar  = (idx + Math.round(lookFar  / DS)) % N;

  const baseLatIdx = (lineX[idx] - pts[idx].x) * nor[idx].x + (lineY[idx] - pts[idx].y) * nor[idx].y;
  const baseLatFar = (lineX[iFar] - pts[iFar].x) * nor[iFar].x + (lineY[iFar] - pts[iFar].y) * nor[iFar].y;
  const carLatNow  = (car.x - pts[idx].x) * nor[idx].x + (car.y - pts[idx].y) * nor[idx].y;

  // 严格沥青安全边界（与原版一致留 2.15m，不碰减速路肩）
  const wallMargin = 2.15;
  const maxLatFar = hw[iFar] - wallMargin;
  const minLatFar = -hw[iFar] + wallMargin;

  // ★ 计算理想战术基准线 (idealLatFar)：
  // 静态 lineX/Y 仅用到 hw - 3.4m，非连续弯道出弯时主动向外侧（-cSign）外抛吃满剩余的 1.25m 沥青路面！
  let idealLatFar = baseLatFar;
  if (isIsolatedExit && cSign !== 0) {
    const outerAsphaltLimit = -cSign * maxLatFar; // 弯道外侧极限沥青位置
    const trackOutShift = (outerAsphaltLimit - baseLatFar) * (0.55 * exitProgress);
    idealLatFar = clamp(baseLatFar + trackOutShift, minLatFar, maxLatFar);
  } else if (isPastApex && hasNextReverseCorner && nextReverseSign !== 0) {
    // 若前方是连续 S 弯：出第一个弯时不外抛，反而提前贴向下一弯的外侧（即当前弯内侧），拉直 S 弯走线
    const nextEntryOuter = -nextReverseSign * (hw[iFar] - 2.6);
    idealLatFar = clamp(baseLatFar * 0.65 + nextEntryOuter * 0.35, minLatFar, maxLatFar);
  }

  /* ---- 4. 全景 360° 邻车态势感知（含车宽包络、前后左右来车、防追尾 TTC） ---- */
  const neighbors = [];
  let leftWallCarLat = Infinity;
  let rightWallCarLat = -Infinity;
  let hasLeftAlongside = false;
  let hasRightAlongside = false;
  let rearUrgentThreat = false;
  let directLeadCar = null;
  let directLeadGeo = null;

  const SAFE_LAT_SEP = CAR_WIDTH + 0.55; // 安全超车中心距 (~2.55m)
  const HARD_LAT_SEP = CAR_WIDTH + 0.22; // 刚体极限防擦碰中心距 (~2.22m)

  if (otherCars && otherCars.length > 1) {
    for (let i = 0; i < otherCars.length; i++) {
      const o = otherCars[i];
      if (o === car) continue;

      const oIdx = o.nearIdx % N;
      const forwardSteps  = isLinear ? (oIdx - idx) : (oIdx - idx + N) % N;
      const backwardSteps = isLinear ? (idx - oIdx) : (idx - oIdx + N) % N;
      const geo = getCarDistance(car, o);

      const isRelevantAhead  = (forwardSteps > 0 && forwardSteps < Math.round(58 / DS)) || (geo.sLon >= 0 && geo.sLon < 58 && geo.distCenter < 45);
      const isRelevantBehind = (backwardSteps > 0 && backwardSteps < Math.round(70 / DS)) || (geo.sLon < 0 && geo.sLon > -70 && geo.distCenter < 50);
      const isAlongsideNow   = Math.abs(geo.sLon) < CAR_LENGTH + 1.8 && geo.distCenter < 16;

      if (!isRelevantAhead && !isRelevantBehind && !isAlongsideNow) continue;

      const oLat = (o.x - pts[oIdx].x) * nor[oIdx].x + (o.y - pts[oIdx].y) * nor[oIdx].y;
      neighbors.push({ car: o, geo, oLat, sLon: geo.sLon });

      // 探测左右并排盲区
      if (geo.sLon > -CAR_LENGTH - 1.2 && geo.sLon < CAR_LENGTH + 1.8) {
        if (oLat > carLatNow) {
          hasLeftAlongside = true;
          if (oLat < leftWallCarLat) leftWallCarLat = oLat;
        } else {
          hasRightAlongside = true;
          if (oLat > rightWallCarLat) rightWallCarLat = oLat;
        }
      }

      // 锁定正前方同车道最近前车
      if (geo.sLon > 0 && geo.sLon < 48 && Math.abs(oLat - carLatNow) < CAR_WIDTH + 0.45) {
        if (!directLeadCar || geo.sLon < directLeadGeo.sLon) {
          directLeadCar = o;
          directLeadGeo = geo;
        }
      }
    }
  }

  /* ---- 5. 1D 赛道横断面走廊光栅扫描（融合出弯外抛理想线 + 全向车宽避障与超车） ---- */
  let chosenLat = idealLatFar;
  let squeezeBailout = false;

  if (car._lockTimer > 0) {
    car._lockTimer -= dt;
    if (car._lockTimer <= 0) car._lockedTargetLat = null;
  }

  const isBlockedAhead = !!(directLeadCar && directLeadGeo.sLon < 16 && (v > directLeadCar.speed - 0.5 || cornerCap[idx] > directLeadCar.speed + 1.5));
  car._blockTimer = isBlockedAhead ? car._blockTimer + dt : Math.max(0, car._blockTimer - dt * 2);

  if (neighbors.length === 0) {
    // 周围无车干扰：直接走包含 Track-Out 外抛优化的极限理想线！
    chosenLat = idealLatFar;
    car._lockedTargetLat = null;
  } else if (hasLeftAlongside && hasRightAlongside && (leftWallCarLat - rightWallCarLat) < SAFE_LAT_SEP * 2.1) {
    // 三车并排“三明治”夹击居中与关门退让
    const clearGap = (leftWallCarLat - rightWallCarLat) - CAR_WIDTH;
    chosenLat = clamp((leftWallCarLat + rightWallCarLat) * 0.5, minLatFar, maxLatFar);
    if (clearGap < CAR_WIDTH + 0.32) squeezeBailout = true;
  } else {
    const futureCurv = curvS[iFar];
    const isSharpCornerAhead = Math.abs(futureCurv) > 0.014;
    let bestScore = -1e9;
    let bestCand = idealLatFar;

    const step = 0.40;
    for (let cand = minLatFar; cand <= maxLatFar + 0.01; cand += step) {
      const cLat = clamp(cand, minLatFar, maxLatFar);
      let score = 0;

      // (1) 贴近包含出弯外抛的理想战术线 idealLatFar
      const distFromIdeal = Math.abs(cLat - idealLatFar);
      score -= distFromIdeal * (isSharpCornerAhead ? 1.80 : 0.75);

      // (2) 横向变道平滑度与超车通道锁定惯性
      score -= Math.abs(cLat - carLatNow) * 0.60;
      if (car._lockedTargetLat !== null && Math.abs(cLat - car._lockedTargetLat) < 1.0) {
        score += 2.8;
      }

      // (3) 弯道内线超车加分
      if (directLeadCar || car._blockTimer > 0.3) {
        if (futureCurv > 0.005 && cLat > baseLatFar) score += 2.2;
        if (futureCurv < -0.005 && cLat < baseLatFar) score += 2.2;
      }

      // (4) 遍历周围所有邻车评估车宽冲突、前向阻挡与后方追尾风险
      for (let k = 0; k < neighbors.length; k++) {
        const nb = neighbors[k];
        const o = nb.car;
        const sLon = nb.sLon;
        const latDist = Math.abs(cLat - nb.oLat);

        // 并排刚体禁区
        if (sLon > -CAR_LENGTH - 1.5 && sLon < CAR_LENGTH + 2.5) {
          if (latDist < HARD_LAT_SEP) {
            score -= 5000 + (HARD_LAT_SEP - latDist) * 2000;
          } else if (latDist < SAFE_LAT_SEP + 0.4) {
            score -= (SAFE_LAT_SEP + 0.4 - latDist) * 18.0;
          }
          if ((nb.oLat > carLatNow && cLat > nb.oLat - HARD_LAT_SEP * 0.8) ||
              (nb.oLat < carLatNow && cLat < nb.oLat + HARD_LAT_SEP * 0.8)) {
            score -= 8000;
          }
        }
        // 前车阻挡与抽头超车评估
        else if (sLon >= CAR_LENGTH + 2.5 && sLon < 48) {
          const closing = v - o.speed + (cornerCap[idx] - o.speed) * 0.4;
          if (latDist < SAFE_LAT_SEP) {
            const proximityWeight = clamp((48 - sLon) / 40, 0.2, 1.5);
            const speedDiffWeight = clamp(closing / 8.0, 0.3, 2.5);
            const overlapRatio    = (SAFE_LAT_SEP - latDist) / SAFE_LAT_SEP;
            score -= 32.0 * proximityWeight * speedDiffWeight * overlapRatio;
            if (sLon < 14 && closing > 1.5) score -= 45.0 * overlapRatio;
          } else if (sLon < 25 && closing > 1.0 && latDist < SAFE_LAT_SEP + 1.2) {
            score += 3.5;
          }
        }
        // 后车追尾 TTC 预判闪避
        else if (sLon <= -CAR_LENGTH - 1.5 && sLon > -70) {
          const rearGap = Math.max(0.2, -sLon - CAR_LENGTH);
          const myDecelExpected = cornerCap[iNear] < v - 3.0 ? 8.5 : 0;
          const rearClosing = (o.speed - v) + myDecelExpected;
          if (rearClosing > 1.5) {
            const ttc = rearGap / rearClosing;
            if (ttc < 2.0) {
              if (latDist < SAFE_LAT_SEP) {
                const urgency = clamp((2.0 - ttc) / 1.5, 0.2, 2.5);
                const overlap = (SAFE_LAT_SEP - latDist) / SAFE_LAT_SEP;
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
    if (Math.abs(chosenLat - idealLatFar) > 0.9 && Math.abs(chosenLat - (car._lockedTargetLat ?? 999)) > 0.8) {
      car._lockedTargetLat = chosenLat;
      car._lockTimer = 1.6;
    }
  }

  /* ---- 6. 横向偏移更新与三前瞻点融合转向（支持出弯快速回正） ---- */
  const targetOffset = chosenLat - baseLatFar;
  const isEmergencyDodge = rearUrgentThreat || hasLeftAlongside || hasRightAlongside;
  const latRate = isEmergencyDodge ? 9.0 : (isIsolatedExit ? 7.2 : (neighbors.length > 0 ? 5.8 : 4.2));
  car._latOffset = (car._latOffset || 0) + (targetOffset - (car._latOffset || 0)) * Math.min(1, dt * latRate);

  // 并排贴身防刮擦微调
  let guardSteer = 0;
  for (let k = 0; k < neighbors.length; k++) {
    const geo = neighbors[k].geo;
    if (Math.abs(geo.sLon) < CAR_LENGTH + 1.8 && Math.abs(geo.dLat) < CAR_WIDTH + 1.35) {
      const penetration = (CAR_WIDTH + 1.35) - Math.abs(geo.dLat);
      const push = clamp(penetration / 1.35, 0, 1) * 0.24;
      guardSteer += (geo.dLat >= 0 ? -push : push);
    }
  }

  // ★ 出弯时近点与中点按比例施加外抛偏移，避免近点还把车头往内侧路肩拽
  const nearOffsetScale = isIsolatedExit ? (0.55 + 0.45 * (1 - exitProgress)) : 1.0;
  const baseLatN = (lineX[iNear] - pts[iNear].x) * nor[iNear].x + (lineY[iNear] - pts[iNear].y) * nor[iNear].y;
  const latN = clamp(baseLatN + car._latOffset * nearOffsetScale, -hw[iNear] + wallMargin, hw[iNear] - wallMargin);
  const dxN = pts[iNear].x + nor[iNear].x * latN - car.x;
  const dyN = pts[iNear].y + nor[iNear].y * latN - car.y;

  const baseLatM = (lineX[iMid] - pts[iMid].x) * nor[iMid].x + (lineY[iMid] - pts[iMid].y) * nor[iMid].y;
  const latM = clamp(baseLatM + car._latOffset, -hw[iMid] + wallMargin, hw[iMid] - wallMargin);
  const dxM = pts[iMid].x + nor[iMid].x * latM - car.x;
  const dyM = pts[iMid].y + nor[iMid].y * latM - car.y;

  const finalLatF = clamp(baseLatFar + car._latOffset, minLatFar, maxLatFar);
  const targetX = pts[iFar].x + nor[iFar].x * finalLatF;
  const targetY = pts[iFar].y + nor[iFar].y * finalLatF;
  const dxF = targetX - car.x;
  const dyF = targetY - car.y;

  const aN = wrapAngle(Math.atan2(dyN, dxN) - car.angle);
  const aM = wrapAngle(Math.atan2(dyM, dxM) - car.angle);
  const aF = wrapAngle(Math.atan2(dyF, dxF) - car.angle);

  // ★ 核心转向权重切换：
  // 入弯/弯心：偏重近点 (wN=0.50) 死咬 Apex；
  // 非连续弯道出弯 (isIsolatedExit)：迅速将权重转移给远点 (wF 高达 0.60)，立刻回正方向盘顺势外抛加速！
  let wN, wF, wM;
  if (isIsolatedExit) {
    wN = 0.15;
    wF = 0.60;
    wM = 0.25;
  } else {
    wN = 0.25 + cornerIntensity * 0.25;
    wF = 0.50 - cornerIntensity * 0.30;
    wM = 1.0 - wN - wF;
  }
  const alpha = aN * wN + aM * wM + aF * wF;

  const dist = (Math.hypot(dxF, dyF) * wF + Math.hypot(dxM, dyM) * wM + Math.hypot(dxN, dyN) * wN) || 1;
  const kappa = 2 * Math.sin(alpha) / dist;
  const omegaMax = Math.min(latGrip / Math.max(v, 1), maxOmega) * Math.min(1, v / 3);
  let duty = clamp((v * kappa) / (omegaMax || 1), -1, 1);

  if (guardSteer !== 0) duty = clamp(duty + clamp(guardSteer, -0.30, 0.30), -1, 1);

  const steerAlpha = Math.min(1, dt * (inCorner || isEmergencyDodge ? 30 : 22));
  out.steer = (out.steer || 0) + (duty - (out.steer || 0)) * steerAlpha;
  out.left = out.steer < -0.05;
  out.right = out.steer > 0.05;

  /* ---- 7. 纵向：闭环刹车规划 + 智能区分“有害偏离”与“有益出弯外抛” ---- */
  const brakeCap = PHYS.brake * (perf.brakeMult ?? 1.0);
  const lightCap = brakeCap * PHYS.lightBrakeFactor;
  const scanCapM = Math.max(320, v * v / (2 * brakeCap) + 80);
  const scanSteps = Math.min(Math.round((v * v / (2 * lightCap) + 80) / DS), Math.round(scanCapM / DS));

  // ★ 智能区分：如果是为了超车在弯中强行偏离理想线，适度降速防推头；
  // 但如果是在非连续弯道出弯做 Track-Out 外抛，不仅不降速，反而给予 1.06 倍的出弯半径扩容加速增益！
  const deviationFromIdeal = Math.abs(carLatNow - (isIsolatedExit ? idealLatFar : baseLatIdx));
  let pathSpeedMult = 1.0;
  if (isIsolatedExit && neighbors.length === 0) {
    pathSpeedMult = 1.0 + 0.06 * exitProgress; // 出弯外抛等效转弯半径更大，允许更高极速
  } else if (deviationFromIdeal > 0.9) {
    pathSpeedMult = clamp(1.0 - (deviationFromIdeal - 0.9) * curvHere * 1.35, 0.89, 1.0);
  }

  let env1 = cornerCap[idx] * pathSpeedMult;
  let env2 = cornerCap[idx] * pathSpeedMult;
  let aReq = 0;

  for (let s = 1; s <= scanSteps; s++) {
    const j = (idx + s) % N;
    const d = s * DS;
    const localMult = d < 35 ? pathSpeedMult : 1.0;
    const cap = cornerCap[j] * localMult;
    if (cap < v) {
      const req = (v * v - cap * cap) / (2 * d);
      if (req > aReq) aReq = req;
    }
    const r1 = Math.sqrt(cap * cap + 2 * lightCap * d);
    const r2 = Math.sqrt(cap * cap + 2 * brakeCap * 0.98 * d);
    if (r1 < env1) env1 = r1;
    if (r2 < env2) env2 = r2;
  }

  // 前向与盒装防撞速度约束
  let emergencyBrake = false;
  for (let k = 0; k < neighbors.length; k++) {
    const nb = neighbors[k];
    const o = nb.car;
    const geo = nb.geo;
    if (geo.sLon <= 0 || geo.sLon > 55) continue;

    const latOverlapNow  = Math.abs(geo.dLat) < CAR_WIDTH + 0.55;
    const latOverlapDest = Math.abs(chosenLat - nb.oLat) < CAR_WIDTH + 0.40;

    if (latOverlapNow || latOverlapDest) {
      const gap = geo.gapFrontRear;
      const closing = v - o.speed;
      if (gap < 1.0 && closing > 0.5 && geo.sLon > 1.8 && Math.abs(geo.dLat) < CAR_WIDTH + 0.30) {
        emergencyBrake = true;
        break;
      }
      const safeGap = Math.max(gap - (car._blockTimer > 0.8 ? 1.25 : 1.75), 0.35);
      const followCap = Math.sqrt(o.speed * o.speed + 2 * brakeCap * 0.90 * safeGap) + closing * 0.12;
      if (followCap < env1) env1 = followCap;
      if (followCap < env2) env2 = followCap;
    }
  }

  if (squeezeBailout) {
    env1 = Math.min(env1, v - 2.5);
  }

  /* ---- 8. ★ 分档制动与过弯心提前全油门弹射 (Early Apex Full-Throttle Launch) ---- */
  const steerMag = Math.abs(out.steer);
  // 非连续弯道出弯时，提前参考前方 12m 处的释放速度作为油门上限！
  const effectiveCap = isIsolatedExit
      ? Math.max(cornerCap[idx], cornerCap[(idx + step12) % N]) * pathSpeedMult
      : cornerCap[idx] * pathSpeedMult;

  if (emergencyBrake) {
    out.brake = 2;
  } else if (rearUrgentThreat && !directLeadCar && v < env2 * 1.04) {
    out.brake = v > env2 ? 1 : 0;
  } else if (aReq > lightCap * 1.02) {
    out.brake = 2;
  } else if (v > env2 + 0.2) {
    out.brake = 2;
  } else if (v > env1 + 0.15 && !isIsolatedExit) {
    out.brake = 1;
  } else {
    out.brake = 0;
  }

  // ★ 极限制胜油门逻辑：
  if (emergencyBrake || squeezeBailout) {
    out.up = false;
  } else if (isIsolatedExit && out.brake <= 1 && v < env2 && Math.abs(aF) < 0.32) {
    // ★ 非连续弯道已过弯心 + 车头对准出弯远点 (|aF| < 18°)：立刻松开残余轻刹，直接全油门外抛弹射！
    out.brake = 0;
    out.up = true;
  } else if (rearUrgentThreat && out.brake === 0 && !directLeadCar && v < env2) {
    out.up = true;
  } else if (out.brake === 1 && steerMag > 0.12 && steerMag < 0.68
      && v < effectiveCap + 0.6 && Math.abs(alpha) < 0.36) {
    out.up = true; // Trail-Braking 油门重叠
  } else if (out.brake === 0) {
    out.up = v < effectiveCap;
  } else {
    out.up = false;
  }

  out.targetX = targetX;
  out.targetY = targetY;
  out.targetSpeed = env1;
}

