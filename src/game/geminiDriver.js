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
function getApexReleaseCap(perf) {
  let byTrack = _apexCapCache.get(perf);
  if (!byTrack) { byTrack = new Map(); _apexCapCache.set(perf, byTrack); }
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

  _apexCapCache.get(perf).set(currentTrackId, cap);
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

/* ================= 终极进化算法：Super Driver Pro (含后向防追尾预判 + 非最佳路径智能超车博弈) ================= */

export function geminiDriver_v1(car, out, dt, otherCars) {
  const idx = car.nearIdx % N;
  const v = Math.abs(car.speed);
  const perf = car.perf || {};
  const latGrip = perf.latGrip ?? PHYS.latGrip;
  const maxOmega = perf.maxOmega ?? PHYS.maxOmega;
  const cornerCap = getSuperCornerCap(perf);

  // 初始化状态机变量
  if (car._cruiseStuck == null) {
    car._cruiseStuck = 0;
    car._cruiseRev = 0;
    car._cruiseMoved = false;
    car._otState = 0;       // 超车锁定方向: -1(右), 0(无), 1(左)
    car._otTimer = 0;       // 超车方向锁定时长
    car._blockTimer = 0;    // 被前车阻挡计时
    car._latOffset = 0;     // 相对最佳赛车线的横向偏移
  }

  /* ---- 1. 脱困系统：碰撞受困后自动倒车脱身 ---- */
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

  /* ---- 2. 曲率自适应三段前瞻计算 ---- */
  const curvHere = Math.abs(curvS[idx]);
  const inCorner = curvHere > 0.008;
  const cornerIntensity = clamp((curvHere - 0.008) / 0.025, 0, 1); // 0=直道, 1=急弯

  const lookNear = Math.max(8, v * (inCorner ? 0.35 : 0.48));
  const lookFar  = Math.min(95, (inCorner ? 14 : 18) + v * (inCorner ? 0.55 : 0.78));
  const lookMid  = (lookNear + lookFar) * 0.5;

  const iNear = (idx + Math.round(lookNear / DS)) % N;
  const iMid  = (idx + Math.round(lookMid  / DS)) % N;
  const iFar  = (idx + Math.round(lookFar  / DS)) % N;

  // 当前与远端采样点的最佳赛车线基准横向位置与赛道边界
  const baseLatIdx = (lineX[idx] - pts[idx].x) * nor[idx].x + (lineY[idx] - pts[idx].y) * nor[idx].y;
  const baseLatFar = (lineX[iFar] - pts[iFar].x) * nor[iFar].x + (lineY[iFar] - pts[iFar].y) * nor[iFar].y;
  const carLatNow  = (car.x - pts[idx].x) * nor[idx].x + (car.y - pts[idx].y) * nor[idx].y;
  const maxLatFar  = hw[iFar] - 2.15;
  const minLatFar  = -hw[iFar] + 2.15;

  /* ---- 3. 全景交通态势感知：前车锁定 + 左右走廊占用 + 后方追尾预警 (Rear TTC) ---- */
  let leadCar = null, leadGeo = null, minLeadDist = Infinity;
  let rearThreat = null, rearGeo = null, minRearTTC = Infinity;
  let leftCorridorBlocked = false, rightCorridorBlocked = false;
  let guardSteer = 0;

  if (otherCars && otherCars.length > 1) {
    for (let i = 0; i < otherCars.length; i++) {
      const o = otherCars[i];
      if (o === car) continue;

      const oIdx = o.nearIdx % N;
      const forwardSteps = isLinear ? (oIdx - idx) : (oIdx - idx + N) % N;
      const backwardSteps = isLinear ? (idx - oIdx) : (idx - oIdx + N) % N;
      const geo = getCarDistance(car, o);

      // (A) 贴身并排主动防擦碰斥力 (侧面擦碰每帧惩罚 0.985 极重，必须严防)
      if (Math.abs(geo.sLon) < CAR_LENGTH + 2.2 && Math.abs(geo.dLat) < CAR_WIDTH + 1.45) {
        const pushWeight = clamp((CAR_WIDTH + 1.45 - Math.abs(geo.dLat)) / 1.5, 0.2, 1.2);
        guardSteer += (geo.dLat >= 0 ? -0.22 : 0.22) * pushWeight;
      }

      // (B) 探测左右超车走廊（纵向 -5m ~ +38m）是否有第三方车辆占据
      if (geo.sLon > -CAR_LENGTH - 1.0 && geo.sLon < 38 && geo.distCenter < 42) {
        if (geo.dLat > 1.1 && geo.dLat < 4.5) leftCorridorBlocked = true;
        if (geo.dLat < -1.1 && geo.dLat > -4.5) rightCorridorBlocked = true;
      }

      // (C) 锁定最具威胁的前车（前方 0~48m）
      const isAhead = (forwardSteps > 0 && forwardSteps < Math.round(48 / DS))
          || (geo.sLon > -CAR_LENGTH * 0.5 && geo.sLon < 48 && geo.distCenter < 25);
      if (isAhead && geo.sLon > -CAR_LENGTH * 0.6 && geo.sLon < minLeadDist) {
        minLeadDist = geo.sLon;
        leadCar = o;
        leadGeo = geo;
      }

      // (D) ★ 后向追尾威胁探测（后方 0~75m）
      const isBehind = (backwardSteps > 0 && backwardSteps < Math.round(75 / DS))
          || (geo.sLon < -CAR_LENGTH * 0.5 && geo.sLon > -75 && geo.distCenter < 50);
      if (isBehind && geo.sLon < -CAR_LENGTH * 0.5) {
        const rearClosing = o.speed - v; // 后车逼近相对速度
        const rearGap = Math.max(0.2, -geo.sLon - CAR_LENGTH);
        // 预测 1.2 秒内若我方进弯减速，后车的等效逼近速度
        const brakingSoon = cornerCap[iNear] < v - 3.0 ? 8.0 : 0;
        const effectiveClosing = rearClosing + brakingSoon;

        if (effectiveClosing > 1.5 && Math.abs(geo.dLat) < CAR_WIDTH + 1.3) {
          const ttc = rearGap / effectiveClosing;
          if (ttc < minRearTTC) {
            minRearTTC = ttc;
            rearThreat = o;
            rearGeo = geo;
          }
        }
      }
    }
  }

  /* ---- 4. ★ 非最佳路径（Off-Line）智能超车决策与防追尾躲避规划 ---- */
  let desiredLatFar = baseLatFar;
  let shouldSlowForTraffic = false;
  let trafficSpeedCap = Infinity;
  let emergencyBrake = false;
  let rearEvasionActive = false;
  let rearDelayBrake = false;

  if (car._otTimer > 0) {
    car._otTimer -= dt;
    if (car._otTimer <= 0) car._otState = 0;
  }

  // [4.1] 前车超车博弈与非最佳路径评估
  if (leadCar && leadGeo) {
    const lIdx = leadCar.nearIdx % N;
    const leadLat = (leadCar.x - pts[lIdx].x) * nor[lIdx].x + (leadCar.y - pts[lIdx].y) * nor[lIdx].y;
    const safetyMargin = 2.75; // 车宽 2.0m + 0.75m 侧向安全净空

    // 左右候选超车线
    const candLeft  = clamp(leadLat + safetyMargin, minLatFar, maxLatFar);
    const candRight = clamp(leadLat - safetyMargin, minLatFar, maxLatFar);

    // 评估左右通道有效净空与可行性
    const spaceLeft  = ( maxLatFar - leadLat) - (leftCorridorBlocked  ? 99 : 0);
    const spaceRight = (leadLat - minLatFar) - (rightCorridorBlocked ? 99 : 0);
    const canGoLeft  = spaceLeft >= safetyMargin;
    const canGoRight = spaceRight >= safetyMargin;

    // 评估我方是否具备超车速度优势（或被慢车堵住）
    const speedAdv = (v - leadCar.speed) + (cornerCap[idx] - leadCar.speed) * 0.5;
    const isClose = leadGeo.sLon < 24;
    const isBlocked = leadGeo.sLon < 12 && Math.abs(leadGeo.dLat) < CAR_WIDTH + 0.8 && speedAdv > 0.8;
    car._blockTimer = isBlocked ? car._blockTimer + dt : Math.max(0, car._blockTimer - dt * 2);

    // 计算前方弯道方向：>0 左弯（左侧为内线），<0 右弯（右侧为内线）
    const futureCurv = curvS[iFar];
    const isSharpCornerAhead = Math.abs(futureCurv) > 0.014;

    // 非最佳路径（Off-line）综合评分函数：权衡内线晚刹优势、偏离赛车线惩罚、与当前车身横向距离
    let chosenSide = car._otState; // 优先延续已锁定的超车方向
    if (chosenSide === 1 && !canGoLeft) chosenSide = 0;
    if (chosenSide === -1 && !canGoRight) chosenSide = 0;

    if (chosenSide === 0 && (isClose || car._blockTimer > 0.4)) {
      // 评估左线得分
      let scoreLeft = -999;
      if (canGoLeft) {
        const insideBonus = futureCurv > 0.005 ? 3.5 : (futureCurv < -0.005 ? -2.0 : 0); // 弯道内线加分，外线扣分
        const offLineCost = Math.abs(candLeft - baseLatFar) * (isSharpCornerAhead ? 0.55 : 0.20);
        const shiftCost   = Math.abs(candLeft - carLatNow) * 0.35;
        scoreLeft = spaceLeft * 0.4 + insideBonus - offLineCost - shiftCost;
      }
      // 评估右线得分
      let scoreRight = -999;
      if (canGoRight) {
        const insideBonus = futureCurv < -0.005 ? 3.5 : (futureCurv > 0.005 ? -2.0 : 0);
        const offLineCost = Math.abs(candRight - baseLatFar) * (isSharpCornerAhead ? 0.55 : 0.20);
        const shiftCost   = Math.abs(candRight - carLatNow) * 0.35;
        scoreRight = spaceRight * 0.4 + insideBonus - offLineCost - shiftCost;
      }

      // ★ 智能判断：若前方是急弯、我方尚未并排（sLon > 6m）、且最佳路径只有高风险外线，则耐心跟车不强行走外道
      const bestScore = Math.max(scoreLeft, scoreRight);
      const canStickOut = (bestScore > -2.2) || (leadGeo.sLon < 6.0) || (speedAdv > 4.5) || (car._blockTimer > 1.0);

      if (canStickOut && (canGoLeft || canGoRight)) {
        chosenSide = scoreLeft >= scoreRight ? 1 : -1;
        car._otState = chosenSide;
        car._otTimer = 2.2; // 锁定超车通道 2.2 秒，杜绝车头左右摇摆
      }
    }

    if (chosenSide !== 0) {
      desiredLatFar = chosenSide > 0 ? candLeft : candRight;
    } else {
      // 暂不满足非最佳路径超车条件：跟随前车尾流或贴近最佳线伺机而动
      desiredLatFar = clamp(baseLatFar * 0.7 + leadLat * 0.3, minLatFar, maxLatFar);
    }

    // 纵向安全判断：若横向尚未拉开安全净空（< 0.3m）且距离极近，启动跟车控速
    if (leadGeo.gapLateral < 0.30 && leadGeo.sLon > 0 && leadGeo.gapFrontRear < 5.5) {
      shouldSlowForTraffic = true;
      trafficSpeedCap = Math.max(0, leadCar.speed * 0.98);
      if (leadGeo.gapFrontRear < 1.0 && v > leadCar.speed + 0.5) {
        emergencyBrake = true;
      }
    }
  }

  // [4.2] ★ 后方来车防追尾预判与主动避让 (Rear-End Collision Avoidance)
  if (rearThreat && rearGeo && minRearTTC < 2.0) {
    const rIdx = rearThreat.nearIdx % N;
    const rearLat = (rearThreat.x - pts[rIdx].x) * nor[rIdx].x + (rearThreat.y - pts[rIdx].y) * nor[rIdx].y;

    // 判断后车偏左还是偏右，向相反且有赛道空间的侧方闪避 2.5m
    const dodgeLeftLat  = clamp(rearLat + 2.6, minLatFar, maxLatFar);
    const dodgeRightLat = clamp(rearLat - 2.6, minLatFar, maxLatFar);
    const canDodgeLeft  = (maxLatFar - rearLat >= 2.4) && !leftCorridorBlocked;
    const canDodgeRight = (rearLat - minLatFar >= 2.4) && !rightCorridorBlocked;

    if (minRearTTC < 1.8) {
      rearEvasionActive = true;
      if (canDodgeLeft && canDodgeRight) {
        // 优先往离自己当前横向位置更顺手的一侧闪避
        desiredLatFar = (carLatNow >= rearLat) ? dodgeLeftLat : dodgeRightLat;
      } else if (canDodgeLeft) {
        desiredLatFar = dodgeLeftLat;
      } else if (canDodgeRight) {
        desiredLatFar = dodgeRightLat;
      }
    }
    // 若后车撞击在即（TTC < 1.15s）且仍处在同一纵向轨迹上，标记延迟重刹防追尾
    if (minRearTTC < 1.15 && Math.abs(rearGeo.dLat) < CAR_WIDTH + 0.5 && !emergencyBrake) {
      rearDelayBrake = true;
    }
  }

  // 平滑更新车辆横向偏移 `_latOffset`（防追尾闪避时响应加快至 dt*9.5，日常回归 dt*3.8）
  const targetOffset = desiredLatFar - baseLatFar;
  const hasActiveTarget = !!(leadCar || rearEvasionActive);
  const offsetRate = rearEvasionActive ? 9.5 : (hasActiveTarget ? 6.5 : 3.8);
  car._latOffset = (car._latOffset || 0) + (targetOffset - (car._latOffset || 0)) * Math.min(1, dt * offsetRate);

  /* ---- 5. 三前瞻点融合纯追踪转向 ---- */
  const baseLatN = (lineX[iNear] - pts[iNear].x) * nor[iNear].x + (lineY[iNear] - pts[iNear].y) * nor[iNear].y;
  const latN = clamp(baseLatN + car._latOffset, -hw[iNear] + 2.15, hw[iNear] - 2.15);
  const dxN = pts[iNear].x + nor[iNear].x * latN - car.x;
  const dyN = pts[iNear].y + nor[iNear].y * latN - car.y;

  const baseLatM = (lineX[iMid] - pts[iMid].x) * nor[iMid].x + (lineY[iMid] - pts[iMid].y) * nor[iMid].y;
  const latM = clamp(baseLatM + car._latOffset, -hw[iMid] + 2.15, hw[iMid] - 2.15);
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

  const wN = 0.25 + cornerIntensity * 0.25;
  const wF = 0.50 - cornerIntensity * 0.30;
  const wM = 1.0 - wN - wF;
  const alpha = aN * wN + aM * wM + aF * wF;

  const dist = (Math.hypot(dxF, dyF) * wF + Math.hypot(dxM, dyM) * wM + Math.hypot(dxN, dyN) * wN) || 1;
  const kappa = 2 * Math.sin(alpha) / dist;
  const omegaMax = Math.min(latGrip / Math.max(v, 1), maxOmega) * Math.min(1, v / 3);
  let duty = clamp((v * kappa) / (omegaMax || 1), -1, 1);

  if (guardSteer !== 0) duty = clamp(duty + clamp(guardSteer, -0.28, 0.28), -1, 1);

  const steerAlpha = Math.min(1, dt * (inCorner || rearEvasionActive ? 30 : 22));
  out.steer = (out.steer || 0) + (duty - (out.steer || 0)) * steerAlpha;
  out.left = out.steer < -0.05;
  out.right = out.steer > 0.05;

  /* ---- 6. 纵向：含非最佳路径抓地补偿的时间最优闭环刹车规划 ---- */
  const brakeCap = PHYS.brake * (perf.brakeMult ?? 1.0);
  const lightCap = brakeCap * PHYS.lightBrakeFactor;
  const scanCapM = Math.max(320, v * v / (2 * brakeCap) + 80);
  const scanSteps = Math.min(Math.round((v * v / (2 * lightCap) + 80) / DS), Math.round(scanCapM / DS));

  // ★ 非最佳路径（Off-Line）弯速折损系数：偏离最佳赛车线越远且弯道越急，等效转弯半径越小，需适度降低目标极速防推头
  const offLineDist = Math.abs(carLatNow - baseLatIdx);
  const offLinePenalty = offLineDist > 0.8
      ? clamp(1.0 - (offLineDist - 0.8) * curvHere * 1.45, 0.88, 1.0)
      : 1.0;

  let env1 = cornerCap[idx] * offLinePenalty;
  let env2 = cornerCap[idx] * offLinePenalty;
  let aReq = 0;

  for (let s = 1; s <= scanSteps; s++) {
    const j = (idx + s) % N;
    const d = s * DS;
    // 近处 45m 内叠加非最佳路径折损，远处逐渐恢复正常包络
    const localPenalty = s * DS < 45 ? offLinePenalty : 1.0;
    const cap = cornerCap[j] * localPenalty;
    if (cap < v) {
      const req = (v * v - cap * cap) / (2 * d);
      if (req > aReq) aReq = req;
    }
    const r1 = Math.sqrt(cap * cap + 2 * lightCap * d);
    const r2 = Math.sqrt(cap * cap + 2 * brakeCap * 0.98 * d);
    if (r1 < env1) env1 = r1;
    if (r2 < env2) env2 = r2;
  }

  // 出弯直道探测
  let exitStraight = false;
  {
    const scanFrom = Math.round(20 / DS);
    const scanTo   = Math.min(Math.round(60 / DS), N - 1);
    let maxCurv = 0;
    for (let s = scanFrom; s <= scanTo; s++) {
      const c = Math.abs(curvS[(idx + s) % N]);
      if (c > maxCurv) maxCurv = c;
    }
    exitStraight = (maxCurv < 0.005);
  }

  // 前向多车跟车防撞包络约束
  if (otherCars && otherCars.length > 1) {
    for (let i = 0; i < otherCars.length; i++) {
      const o = otherCars[i];
      if (o === car) continue;
      const geo = getCarDistance(car, o);
      if (geo.sLon <= 0 || geo.sLon > 55) continue;
      if (Math.abs(geo.dLat) > CAR_WIDTH + 0.85) continue; // 横向已抽头净空，全油门超越不限速

      const gap = geo.gapFrontRear;
      const closing = v - o.speed;
      if (gap < 1.0 && closing > 0.5 && geo.sLon > 2.0 && Math.abs(geo.dLat) < CAR_WIDTH + 0.35) {
        emergencyBrake = true;
        break;
      }
      const safeGap = Math.max(gap - (car._blockTimer > 1.0 ? 1.15 : 1.7), 0.4);
      const followCap = Math.sqrt(o.speed * o.speed + 2 * brakeCap * 0.90 * safeGap) + closing * 0.12;
      if (followCap < env1) env1 = followCap;
      if (followCap < env2) env2 = followCap;
    }
  }
  if (shouldSlowForTraffic && car._otState === 0 && trafficSpeedCap < env1) {
    env1 = trafficSpeedCap;
    env2 = Math.min(env2, trafficSpeedCap);
  }

  /* ---- 7. 分档制动与油门执行（融合防追尾延迟刹车保护） ---- */
  const steerMag = Math.abs(out.steer);
  const localCap = cornerCap[idx] * offLinePenalty;

  if (emergencyBrake) {
    out.brake = 2;
  } else if (rearDelayBrake && v < env2 * 1.04) {
    // ★ 后方追尾预警激活：只要未突破物理极限包络 env2 的 104%，将重刹降级为轻刹/滑行，带着速度躲入避让线
    out.brake = v > env2 ? 1 : 0;
  } else if (aReq > lightCap * 1.02) {
    out.brake = 2;
  } else if (v > env2 + 0.2) {
    out.brake = 2;
  } else if (v > env1 + 0.15) {
    out.brake = 1;
  } else {
    out.brake = 0;
  }

  // 油门输出：支持 Trail-Braking 油门重叠与防追尾逃逸加速
  if (emergencyBrake) {
    out.up = false;
  } else if (rearDelayBrake && out.brake === 0 && v < env2) {
    // 被后车极限追赶且前方抓地力尚有余量时，补油拉开与后车的相对速度差
    out.up = true;
  } else if (out.brake === 1 && steerMag > 0.15 && steerMag < 0.65
      && v < localCap + 0.5 && Math.abs(alpha) < 0.35) {
    out.up = true;
  } else if (out.brake === 0) {
    const throttleMargin = exitStraight ? 0.0 : 0.05;
    out.up = v < localCap - throttleMargin;
  } else {
    out.up = false;
  }

  out.targetX = targetX;
  out.targetY = targetY;
  out.targetSpeed = env1;
}





/* ================= 终极全向博弈算法：Super Driver Omniverse =================
   核心能力：
   1. 360° 全向车距与车宽刚体包络感知（前、后、左、右、斜向盲区）
   2. 赛道横断面 0.4m 精度光栅扫描：自动寻找能容纳 CAR_WIDTH 的安全超车/闪避走廊
   3. 多车并排“三明治”居中穿针引线 + 关门挤压自动退让（Bailout）
   4. 后方追尾 TTC 预判（仅在侧向无并排车时安全变道闪避，支持延迟刹车防追尾）
   5. 非最佳路径（Off-Line）弯速折损补偿 + 96% 抓地时间最优闭环纵向控制
============================================================================== */

export function geminiDriver_v2(car, out, dt, otherCars) {
  const idx = car.nearIdx % N;
  const v = Math.abs(car.speed);
  const perf = car.perf || {};
  const latGrip = perf.latGrip ?? PHYS.latGrip;
  const maxOmega = perf.maxOmega ?? PHYS.maxOmega;
  const cornerCap = getSuperCornerCap(perf);

  // 初始化持久化状态
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

  /* ---- 2. 曲率自适应三段前瞻与自身横向坐标解算 ---- */
  const curvHere = Math.abs(curvS[idx]);
  const inCorner = curvHere > 0.008;
  const cornerIntensity = clamp((curvHere - 0.008) / 0.025, 0, 1);

  const lookNear = Math.max(8, v * (inCorner ? 0.35 : 0.48));
  const lookFar  = Math.min(92, (inCorner ? 14 : 18) + v * (inCorner ? 0.55 : 0.78));
  const lookMid  = (lookNear + lookFar) * 0.5;

  const iNear = (idx + Math.round(lookNear / DS)) % N;
  const iMid  = (idx + Math.round(lookMid  / DS)) % N;
  const iFar  = (idx + Math.round(lookFar  / DS)) % N;

  // 计算当前位置与远瞻点的最佳赛车线基准横向偏移（相对赛道中心 pts）
  const baseLatIdx = (lineX[idx] - pts[idx].x) * nor[idx].x + (lineY[idx] - pts[idx].y) * nor[idx].y;
  const baseLatFar = (lineX[iFar] - pts[iFar].x) * nor[iFar].x + (lineY[iFar] - pts[iFar].y) * nor[iFar].y;
  const carLatNow  = (car.x - pts[idx].x) * nor[idx].x + (car.y - pts[idx].y) * nor[idx].y;

  // 严格考虑车宽 (CAR_WIDTH ≈ 2.0m) 的赛道沥青边界：留出半车宽 + 安全余量
  const halfW = CAR_WIDTH * 0.5;
  const wallMargin = halfW + 1.15; // 2.15m 边界余量，杜绝蹭路肩
  const maxLatFar = hw[iFar] - wallMargin;
  const minLatFar = -hw[iFar] + wallMargin;

  /* ---- 3. 收集周围 360° 邻车态势（精确映射赛道横向坐标与车宽包络） ---- */
  const neighbors = [];
  let leftWallCarLat = Infinity;   // 左侧贴身并排车的最右边缘（相对中心线）
  let rightWallCarLat = -Infinity; // 右侧贴身并排车的最左边缘（相对中心线）
  let hasLeftAlongside = false;
  let hasRightAlongside = false;
  let rearUrgentThreat = false;
  let directLeadCar = null;
  let directLeadGeo = null;

  // 车宽安全包络定义：两车中心最小安全横向间距 = CAR_WIDTH + 0.55m (约 2.55m)
  const SAFE_LAT_SEP = CAR_WIDTH + 0.55;
  const HARD_LAT_SEP = CAR_WIDTH + 0.22; // 极限刚体防擦碰间距 (约 2.22m)

  if (otherCars && otherCars.length > 1) {
    for (let i = 0; i < otherCars.length; i++) {
      const o = otherCars[i];
      if (o === car) continue;

      const oIdx = o.nearIdx % N;
      const forwardSteps  = isLinear ? (oIdx - idx) : (oIdx - idx + N) % N;
      const backwardSteps = isLinear ? (idx - oIdx) : (idx - oIdx + N) % N;
      const geo = getCarDistance(car, o);

      // 过滤掉距离过远、完全不相干的车
      const isRelevantAhead  = (forwardSteps > 0 && forwardSteps < Math.round(58 / DS)) || (geo.sLon >= 0 && geo.sLon < 58 && geo.distCenter < 45);
      const isRelevantBehind = (backwardSteps > 0 && backwardSteps < Math.round(70 / DS)) || (geo.sLon < 0 && geo.sLon > -70 && geo.distCenter < 50);
      const isAlongsideNow   = Math.abs(geo.sLon) < CAR_LENGTH + 1.8 && geo.distCenter < 16;

      if (!isRelevantAhead && !isRelevantBehind && !isAlongsideNow) continue;

      // 计算对方车辆在赛道中心线法向上的精确横向坐标 oLat
      const oLat = (o.x - pts[oIdx].x) * nor[oIdx].x + (o.y - pts[oIdx].y) * nor[oIdx].y;
      neighbors.push({ car: o, geo, oLat, sLon: geo.sLon });

      // [3.1] 探测左右并排盲区（纵向重叠：-CAR_LENGTH - 1.2m 到 +CAR_LENGTH + 1.8m）
      if (geo.sLon > -CAR_LENGTH - 1.2 && geo.sLon < CAR_LENGTH + 1.8) {
        if (oLat > carLatNow) {
          hasLeftAlongside = true;
          if (oLat < leftWallCarLat) leftWallCarLat = oLat;
        } else {
          hasRightAlongside = true;
          if (oLat > rightWallCarLat) rightWallCarLat = oLat;
        }
      }

      // [3.2] 锁定正前方同车道（横向重叠 < CAR_WIDTH + 0.45m）最近的前车
      if (geo.sLon > 0 && geo.sLon < 48 && Math.abs(oLat - carLatNow) < CAR_WIDTH + 0.45) {
        if (!directLeadCar || geo.sLon < directLeadGeo.sLon) {
          directLeadCar = o;
          directLeadGeo = geo;
        }
      }
    }
  }

  /* ---- 4. ★ 1D 赛道横断面走廊光栅扫描（综合考虑车宽、前后左右来车、防追尾与超车） ---- */
  let chosenLat = baseLatFar;
  let squeezeBailout = false; // 三明治夹击空间不足时的退让减速标志

  if (car._lockTimer > 0) {
    car._lockTimer -= dt;
    if (car._lockTimer <= 0) car._lockedTargetLat = null;
  }

  // 判断是否被前车阻挡
  const isBlockedAhead = !!(directLeadCar && directLeadGeo.sLon < 16 && (v > directLeadCar.speed - 0.5 || cornerCap[idx] > directLeadCar.speed + 1.5));
  car._blockTimer = isBlockedAhead ? car._blockTimer + dt : Math.max(0, car._blockTimer - dt * 2);

  if (neighbors.length === 0) {
    // 周围无车：回归最佳赛车线
    chosenLat = baseLatFar;
    car._lockedTargetLat = null;
  } else if (hasLeftAlongside && hasRightAlongside && (leftWallCarLat - rightWallCarLat) < SAFE_LAT_SEP * 2.1) {
    // ★ 特殊工况 A：左右同时有并排车（三车并排“三明治”夹击）
    const totalGap = leftWallCarLat - rightWallCarLat; // 两车中心距
    const clearGap = totalGap - CAR_WIDTH;             // 扣除两侧半车宽后的净空隙

    if (clearGap >= CAR_WIDTH + 0.32) {
      // 净空足够容纳我方车宽（>= 2.32m）：精准锁定两车正中央穿针引线！
      chosenLat = clamp((leftWallCarLat + rightWallCarLat) * 0.5, minLatFar, maxLatFar);
    } else {
      // 左右两车正在向中间关门挤压，净空已小于我方车宽：居中同时立刻减速退让抽身！
      chosenLat = clamp((leftWallCarLat + rightWallCarLat) * 0.5, minLatFar, maxLatFar);
      squeezeBailout = true;
    }
  } else {
    // ★ 常规多车混战工况：在 [minLatFar, maxLatFar] 之间以 0.4m 步长扫描所有候选横向走廊
    const futureCurv = curvS[iFar];
    const isSharpCornerAhead = Math.abs(futureCurv) > 0.014;
    let bestScore = -1e9;
    let bestCand = baseLatFar;

    // 构建候选集：包含均匀光栅采样点 + 最佳赛车线点 + 当前横向点
    const step = 0.40;
    for (let cand = minLatFar; cand <= maxLatFar + 0.01; cand += step) {
      const cLat = clamp(cand, minLatFar, maxLatFar);
      let score = 0;
      let feasible = true;

      // (1) 基础偏好：贴近最佳赛车线（急弯时偏离最佳赛车线代价更高）
      const offLineDist = Math.abs(cLat - baseLatFar);
      score -= offLineDist * (isSharpCornerAhead ? 1.85 : 0.75);

      // (2) 横向变道平滑度：避免无意义的剧烈横移（若已有锁定通道则给予惯性加分）
      score -= Math.abs(cLat - carLatNow) * 0.65;
      if (car._lockedTargetLat !== null && Math.abs(cLat - car._lockedTargetLat) < 1.0) {
        score += 2.8; // 保持超车/闪避通道稳定性，防止左右摇摆
      }

      // (3) 弯道内线战术加分（存在前车需要超车时，切弯道内线加分）
      if (directLeadCar || car._blockTimer > 0.3) {
        if (futureCurv > 0.005 && cLat > baseLatFar) score += 2.2;  // 左弯切左内线
        if (futureCurv < -0.005 && cLat < baseLatFar) score += 2.2; // 右弯切右内线
      }

      // (4) 遍历周围所有车辆，评估该走廊 cLat 与每台车的车宽包络冲突
      for (let k = 0; k < neighbors.length; k++) {
        const nb = neighbors[k];
        const o = nb.car;
        const sLon = nb.sLon;
        const latDist = Math.abs(cLat - nb.oLat); // 候选通道与该车的横向中心距

        // --- 情况 A：并排与近距离侧向区 (-CAR_LENGTH - 1.5m < sLon < CAR_LENGTH + 2.5m) ---
        if (sLon > -CAR_LENGTH - 1.5 && sLon < CAR_LENGTH + 2.5) {
          if (latDist < HARD_LAT_SEP) {
            // 刚体车宽干涉！选这条线必撞侧面，直接一票否决（或重罚）
            score -= 5000 + (HARD_LAT_SEP - latDist) * 2000;
            feasible = false;
          } else if (latDist < SAFE_LAT_SEP + 0.4) {
            // 贴得较近，施加缓冲排斥力
            score -= (SAFE_LAT_SEP + 0.4 - latDist) * 18.0;
          }
          // 严禁穿过并排车辆到达其另一侧（防止穿模碰撞）
          if ((nb.oLat > carLatNow && cLat > nb.oLat - HARD_LAT_SEP * 0.8) ||
              (nb.oLat < carLatNow && cLat < nb.oLat + HARD_LAT_SEP * 0.8)) {
            score -= 8000;
            feasible = false;
          }
        }

        // --- 情况 B：前方车辆阻挡与超车走廊评估 (sLon >= CAR_LENGTH + 2.5m) ---
        else if (sLon >= CAR_LENGTH + 2.5 && sLon < 48) {
          const closing = v - o.speed + (cornerCap[idx] - o.speed) * 0.4;
          if (latDist < SAFE_LAT_SEP) {
            // 该通道被前车车宽挡住！距离越近、对方越慢，扣分越重
            const proximityWeight = clamp((48 - sLon) / 40, 0.2, 1.5);
            const speedDiffWeight = clamp(closing / 8.0, 0.3, 2.5);
            const overlapRatio    = (SAFE_LAT_SEP - latDist) / SAFE_LAT_SEP;
            score -= 32.0 * proximityWeight * speedDiffWeight * overlapRatio;

            // 若在正前方极近处（< 14m）且速度明显慢，重罚该通道以逼迫抽头变道
            if (sLon < 14 && closing > 1.5) {
              score -= 45.0 * overlapRatio;
            }
          } else if (sLon < 25 && closing > 1.0 && latDist < SAFE_LAT_SEP + 1.2) {
            // 刚好擦着前车安全车宽边缘通过的超车通道：奖励紧凑超车线
            score += 3.5;
          }
        }

        // --- 情况 C：后方来车防追尾预判 (sLon <= -CAR_LENGTH - 1.5m) ---
        else if (sLon <= -CAR_LENGTH - 1.5 && sLon > -70) {
          const rearGap = Math.max(0.2, -sLon - CAR_LENGTH);
          // 考虑我方即将入弯减速时的等效逼近速度
          const myDecelExpected = cornerCap[iNear] < v - 3.0 ? 8.5 : 0;
          const rearClosing = (o.speed - v) + myDecelExpected;

          if (rearClosing > 1.5) {
            const ttc = rearGap / rearClosing;
            if (ttc < 2.0) {
              if (latDist < SAFE_LAT_SEP) {
                // 处于后车追尾弹道内！TTC 越小，该位置越危险
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

    // 若选出的最佳超车/闪避线明显偏离最佳赛车线（> 0.9m），锁定该通道 1.6 秒防抖
    if (Math.abs(chosenLat - baseLatFar) > 0.9 && Math.abs(chosenLat - (car._lockedTargetLat ?? 999)) > 0.8) {
      car._lockedTargetLat = chosenLat;
      car._lockTimer = 1.6;
    }
  }

  /* ---- 5. 横向偏移平滑与贴身防刮擦微调 (Guard Reflex) ---- */
  const targetOffset = chosenLat - baseLatFar;
  // 若有并排挤压或后车紧急追尾，加快变道响应速率 (dt * 9.0)，否则平顺过渡 (dt * 5.8)
  const isEmergencyDodge = rearUrgentThreat || hasLeftAlongside || hasRightAlongside;
  const latRate = isEmergencyDodge ? 9.0 : (neighbors.length > 0 ? 5.8 : 3.6);
  car._latOffset = (car._latOffset || 0) + (targetOffset - (car._latOffset || 0)) * Math.min(1, dt * latRate);

  // 贴身刚体防擦碰实时反射（当左右两车同时夹击时，引力相互抵消自动保持居中）
  let guardSteer = 0;
  for (let k = 0; k < neighbors.length; k++) {
    const geo = neighbors[k].geo;
    if (Math.abs(geo.sLon) < CAR_LENGTH + 1.8 && Math.abs(geo.dLat) < CAR_WIDTH + 1.35) {
      const penetration = (CAR_WIDTH + 1.35) - Math.abs(geo.dLat);
      const push = clamp(penetration / 1.35, 0, 1) * 0.24;
      guardSteer += (geo.dLat >= 0 ? -push : push);
    }
  }

  /* ---- 6. 三前瞻点融合纯追踪转向 ---- */
  const baseLatN = (lineX[iNear] - pts[iNear].x) * nor[iNear].x + (lineY[iNear] - pts[iNear].y) * nor[iNear].y;
  const latN = clamp(baseLatN + car._latOffset, -hw[iNear] + wallMargin, hw[iNear] - wallMargin);
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

  const wN = 0.25 + cornerIntensity * 0.25;
  const wF = 0.50 - cornerIntensity * 0.30;
  const wM = 1.0 - wN - wF;
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

  /* ---- 7. 纵向：时间最优闭环刹车规划 + 非最佳路径弯速折损 + 盒装跟车控制 ---- */
  const brakeCap = PHYS.brake * (perf.brakeMult ?? 1.0);
  const lightCap = brakeCap * PHYS.lightBrakeFactor;
  const scanCapM = Math.max(320, v * v / (2 * brakeCap) + 80);
  const scanSteps = Math.min(Math.round((v * v / (2 * lightCap) + 80) / DS), Math.round(scanCapM / DS));

  // ★ 非最佳路径（Off-Line）弯速折损补偿：偏离最佳赛车线超车/闪避时，适度降低弯心目标极速防推头出界
  const currentOffLine = Math.abs(carLatNow - baseLatIdx);
  const offLinePenalty = currentOffLine > 0.8
      ? clamp(1.0 - (currentOffLine - 0.8) * curvHere * 1.45, 0.88, 1.0)
      : 1.0;

  let env1 = cornerCap[idx] * offLinePenalty;
  let env2 = cornerCap[idx] * offLinePenalty;
  let aReq = 0;

  for (let s = 1; s <= scanSteps; s++) {
    const j = (idx + s) % N;
    const d = s * DS;
    const localPen = d < 45 ? offLinePenalty : 1.0;
    const cap = cornerCap[j] * localPen;
    if (cap < v) {
      const req = (v * v - cap * cap) / (2 * d);
      if (req > aReq) aReq = req;
    }
    const r1 = Math.sqrt(cap * cap + 2 * lightCap * d);
    const r2 = Math.sqrt(cap * cap + 2 * brakeCap * 0.98 * d);
    if (r1 < env1) env1 = r1;
    if (r2 < env2) env2 = r2;
  }

  // 出弯直道探测
  let exitStraight = false;
  {
    const scanFrom = Math.round(20 / DS);
    const scanTo   = Math.min(Math.round(60 / DS), N - 1);
    let maxCurv = 0;
    for (let s = scanFrom; s <= scanTo; s++) {
      const c = Math.abs(curvS[(idx + s) % N]);
      if (c > maxCurv) maxCurv = c;
    }
    exitStraight = (maxCurv < 0.005);
  }

  // ★ 前向与盒装（Boxed-In）防追尾纵向包络约束
  let emergencyBrake = false;
  for (let k = 0; k < neighbors.length; k++) {
    const nb = neighbors[k];
    const o = nb.car;
    const geo = nb.geo;
    if (geo.sLon <= 0 || geo.sLon > 55) continue;

    // 关键：同时检查与前车当前横向距离、以及我方目标超车通道是否与前车重叠
    const latOverlapNow  = Math.abs(geo.dLat) < CAR_WIDTH + 0.55;
    const latOverlapDest = Math.abs(chosenLat - nb.oLat) < CAR_WIDTH + 0.40;

    // 如果当前横向未净空，或者周围被夹住导致无法变道抽头（latOverlapDest 为真），必须严格控速防撞前车
    if (latOverlapNow || latOverlapDest) {
      const gap = geo.gapFrontRear;
      const closing = v - o.speed;

      // 正前方极近距离 (< 1.0m) 紧急制动兜底
      if (gap < 1.0 && closing > 0.5 && geo.sLon > 1.8 && Math.abs(geo.dLat) < CAR_WIDTH + 0.30) {
        emergencyBrake = true;
        break;
      }

      // 动态跟车安全距离：若正在寻机突围，保持 1.25m 紧凑尾流距离；常规保持 1.75m
      const safeGap = Math.max(gap - (car._blockTimer > 0.8 ? 1.25 : 1.75), 0.35);
      const followCap = Math.sqrt(o.speed * o.speed + 2 * brakeCap * 0.90 * safeGap) + closing * 0.12;
      if (followCap < env1) env1 = followCap;
      if (followCap < env2) env2 = followCap;
    }
  }

  // 三明治夹击关门退让：若左右两车向中间挤压且净空小于车宽，轻微降速退后半个车身脱困
  if (squeezeBailout) {
    env1 = Math.min(env1, v - 2.5);
  }

  /* ---- 8. 分档制动与油门执行（融合防后车追尾延迟制动保护） ---- */
  const steerMag = Math.abs(out.steer);
  const localCap = cornerCap[idx] * offLinePenalty;

  if (emergencyBrake) {
    out.brake = 2;
  } else if (rearUrgentThreat && !directLeadCar && v < env2 * 1.04) {
    // ★ 后方追尾预警激活（且正前方无慢车堵路）：在物理极限包络允许范围内推迟重刹，防后车直接顶飞
    out.brake = v > env2 ? 1 : 0;
  } else if (aReq > lightCap * 1.02) {
    out.brake = 2;
  } else if (v > env2 + 0.2) {
    out.brake = 2;
  } else if (v > env1 + 0.15) {
    out.brake = 1;
  } else {
    out.brake = 0;
  }

  // 油门输出控制
  if (emergencyBrake || squeezeBailout) {
    out.up = false;
  } else if (rearUrgentThreat && out.brake === 0 && !directLeadCar && v < env2) {
    out.up = true; // 被后车极限逼近且前方有空间时，全油门逃逸拉开车距
  } else if (out.brake === 1 && steerMag > 0.15 && steerMag < 0.65
      && v < localCap + 0.5 && Math.abs(alpha) < 0.35) {
    out.up = true; // Trail-Braking 出弯油门重叠
  } else if (out.brake === 0) {
    const throttleMargin = exitStraight ? 0.0 : 0.05;
    out.up = v < localCap - throttleMargin;
  } else {
    out.up = false;
  }

  out.targetX = targetX;
  out.targetY = targetY;
  out.targetSpeed = env1;
}
