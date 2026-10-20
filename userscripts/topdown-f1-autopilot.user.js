// 入口函数：ApexPredator 动态攻防自动驾驶算法
const driver = function apexPredatorDriver(car, out, dt, otherCars) {
  const isLinear = !!(typeof track !== 'undefined' && track.isLinear);
  const stepIdx = (base, step) => isLinear
      ? clamp(base + step, 0, N - 1)
      : (((base + step) % N) + N) % N;

  const idx = car.nearIdx % N;
  const v = Math.abs(car.speed);
  const perf = car.perf || {};
  const latGrip = perf.latGrip ?? PHYS.latGrip;
  const maxOmega = perf.maxOmega ?? PHYS.maxOmega;
  const cornerCap = getSuperCornerCap(perf);
  const hasKerbArr = (typeof track !== 'undefined' && track.kerbFlag) ? track.kerbFlag : null;

  /* ==== 0. 状态记忆初始化 ==== */
  if (car._apInit == null) {
    car._apInit = true;
    car._stuckT = 0;
    car._revT = 0;
    car._moved = false;
    car._tacLat = 0;         // 平滑后的战术横向偏移（相对于中心线）
    car._otSide = 0;         // 超车锁定方向 (-1左 / +1右)
    car._otLockT = 0;        // 超车方向锁定时长
    car._blockT = 0;         // 被前车阻挡累计时间
    car._defendMode = false; // 当前是否处于防守状态
  }

  /* ==== 1. 脱困逻辑：碰撞受困快速倒车回正 ==== */
  if (car._revT > 0) {
    car._revT -= dt;
    out.up = false;
    out.brake = 2;
    // 倒车时反向打轮帮助车头摆回赛道切线方向
    const tanAngle = Math.atan2(nor[idx].x, -nor[idx].y);
    const headingErr = wrapAngle(tanAngle - car.angle);
    out.steer = clamp(-headingErr * 2.0, -1, 1);
    out.left = out.steer < -0.05;
    out.right = out.steer > 0.05;
    if (car._revT <= 0) car._stuckT = 0;
    return;
  }
  if (v > 3.0) car._moved = true;
  if (car._moved) {
    if (v < 1.5) car._stuckT += dt;
    else car._stuckT = Math.max(0, car._stuckT - dt * 2.5);
    if (car._stuckT > 2.0) {
      car._revT = 0.85;
      return;
    }
  }

  /* ==== 2. 自身横向状态与赛道几何特征提取 ==== */
  const getRaceLat = (i) => (lineX[i] - pts[i].x) * nor[i].x + (lineY[i] - pts[i].y) * nor[i].y;
  const getSafeHalfWidth = (i, margin) => {
    const kerbBonus = (hasKerbArr && hasKerbArr[i] === 1) ? 0.65 : 0.0;
    return Math.max(1.5, hw[i] + kerbBonus - margin);
  };

  // 本车当前相对于中心线的横向偏移与横向速度（向右为正）
  const myLat = (car.x - pts[idx].x) * nor[idx].x + (car.y - pts[idx].y) * nor[idx].y;
  const myVLat = car.speed * (Math.cos(car.angle) * nor[idx].x + Math.sin(car.angle) * nor[idx].y);
  const myRaceLat = getRaceLat(idx);

  // 当前与前方曲率分析：识别入弯、弯心、非连续弯道出弯与S弯
  const curvRaw = curvS[idx];
  const curvHere = Math.abs(curvRaw);
  const inCorner = curvHere > 0.0075;
  const cornerIntensity = clamp((curvHere - 0.0075) / 0.024, 0, 1);

  // 扫描前方 12m ~ 70m 的弯道趋势
  let maxCurvAhead = 0;
  let dominantCurvSum = 0;
  let curv15 = 0, curv30 = 0, curv50 = 0;
  const step15 = Math.max(1, Math.round(15 / DS));
  const step30 = Math.max(2, Math.round(30 / DS));
  const step50 = Math.max(3, Math.round(50 / DS));
  const step70 = Math.max(4, Math.round(70 / DS));

  for (let s = 1; s <= step70; s++) {
    const c = curvS[stepIdx(idx, s)];
    const absC = Math.abs(c);
    if (absC > maxCurvAhead) maxCurvAhead = absC;
    if (s >= Math.round(10 / DS) && s <= step50) dominantCurvSum += c;
    if (s === step15) curv15 = c;
    if (s === step30) curv30 = c;
    if (s === step50) curv50 = c;
  }

  // 下一个弯道的内线符号：+1 表示右弯（右侧 +off 为内线），-1 表示左弯（左侧 -off 为内线）
  const nextCornerSign = Math.abs(dominantCurvSum) > 0.02 ? Math.sign(dominantCurvSum) : (curvHere > 0.006 ? Math.sign(curvRaw) : 0);

  // ★ 非连续弯道出弯判定：当前在弯中，前方 15~30m 曲率显著衰减，且没有紧接高强度反向急弯
  const isReversingSharp = (curvRaw * curv30 < 0) && Math.abs(curv30) > 0.011;
  const nonContExit = inCorner && !isReversingSharp && (
      (Math.abs(curv15) < curvHere * 0.78 && Math.abs(curv30) < curvHere * 0.55) ||
      (Math.abs(curv15) < 0.0055 && Math.abs(curv30) < 0.0045)
  );
  // 纯直道出弯判定
  const exitStraight = !isReversingSharp && Math.abs(curv15) < 0.005 && Math.abs(curv30) < 0.004 && Math.abs(curv50) < 0.0045;

  /* ==== 3. 全场态势感知：前车意图预判 + 后车威胁扫描 ==== */
  const lookNear = Math.max(7.5, v * (inCorner ? 0.33 : 0.46));
  const lookFar  = Math.min(92, (inCorner ? 14 : 18) + v * (inCorner ? 0.52 : 0.76));
  const lookMid  = (lookNear + lookFar) * 0.48;

  const iNear = stepIdx(idx, Math.round(lookNear / DS));
  const iMid  = stepIdx(idx, Math.round(lookMid  / DS));
  const iFar  = stepIdx(idx, Math.round(lookFar  / DS));

  // 先调用内置交通函数作为远端兜底参考
  const tr = evaluateTrafficAndOvertake(car, otherCars, iFar, dt);

  const aheadCars = [];
  let leadThreat = null;     // 同车道正前方最危险的前车
  let closestAhead = null;   // 前方最近的前车（无论横向）
  let pursuer = null;        // 后方最具威胁的追击车
  let pursuerScore = -1e9;
  let sideGuard = 0;         // 并排贴身防撞推力
  let sideSqueeze = false;

  if (otherCars && otherCars.length > 1) {
    for (let i = 0; i < otherCars.length; i++) {
      const o = otherCars[i];
      if (o === car) continue;
      const geo = getCarDistance(car, o);
      if (geo.distCenter > 85) continue;

      const oIdx = (o.nearIdx || 0) % N;
      const oLat = (o.x - pts[oIdx].x) * nor[oIdx].x + (o.y - pts[oIdx].y) * nor[oIdx].y;
      const oVLat = o.speed * (Math.cos(o.angle) * nor[oIdx].x + Math.sin(o.angle) * nor[oIdx].y);

      // 预判对手在未来 0.45 秒后的横向位置（结合横向速度与对手方向盘输入 o.inSteer）
      const predHorizon = clamp(Math.abs(geo.sLon) / Math.max(v, 12), 0.18, 0.65);
      const oPredLat = oLat + oVLat * predHorizon + (o.inSteer || 0) * 1.45 * predHorizon;

      // 预判对手减速度（读取刹车灯 o.inBrake 与物理加速度 o.accel）
      const oBrakeDecel = o.inBrake === 2 ? PHYS.brake * 0.85
          : (o.inBrake === 1 ? PHYS.brake * PHYS.lightBrakeFactor * 0.85 : 0);
      const oEffDecel = Math.max(oBrakeDecel, -(o.accel || 0));

      const info = { car: o, geo, oLat, oVLat, oPredLat, oEffDecel };

      // A. 贴身并排检测（车身纵向重叠区域）
      if (Math.abs(geo.sLon) < CAR_LENGTH + 1.6 && Math.abs(geo.dLat) < CAR_WIDTH + 1.45) {
        if (geo.gapLateral < 0.65) sideSqueeze = true;
        // 距离越近，侧向避让推力越强
        const pushMag = clamp(1.2 - geo.gapLateral * 0.5, 0.25, 1.0);
        sideGuard += (geo.dLat >= 0 ? -1 : 1) * pushMag;
      }

      // B. 前方车辆收集（含半个车身并排的前车）
      if (geo.sLon >= -CAR_LENGTH * 0.65 && geo.sLon < 72) {
        aheadCars.push(info);
        if (!closestAhead || geo.sLon < closestAhead.geo.sLon) {
          closestAhead = info;
        }
        // 判断是否在我们的行进走廊上构成纵向阻挡
        const latDiffPred = Math.abs(oPredLat - (myLat + myVLat * 0.25));
        if (geo.sLon > 0 && (Math.abs(geo.dLat) < CAR_WIDTH + 0.95 || latDiffPred < CAR_WIDTH + 0.85)) {
          if (!leadThreat || geo.sLon < leadThreat.geo.sLon) {
            leadThreat = info;
          }
        }
      }

      // C. 后方追击车辆评估（用于智能防守）
      if (geo.sLon < -CAR_LENGTH * 0.55 && geo.sLon > -38) {
        const closing = o.speed - v; // 正值表示后车比我们快
        // 追击威胁分：距离越近、相对速度越快、或正处于入弯刹车区前，威胁越高
        const distScore = (38 + geo.sLon) * 1.8;
        const speedScore = closing * 5.5;
        const cornerBonus = (maxCurvAhead > 0.008 && geo.sLon > -22) ? 18 : 0;
        const score = distScore + speedScore + cornerBonus;
        if (score > pursuerScore && (closing > -3.0 || geo.sLon > -16)) {
          pursuerScore = score;
          pursuer = info;
        }
      }
    }
  }

  /* ==== 4. 动态博弈状态机：进攻选线 vs 后车防守 vs 最优赛车线 ==== */
  const raceLatMid = getRaceLat(iMid);
  const safeLimMid = getSafeHalfWidth(iMid, 1.65);

  if (car._otLockT > 0) {
    car._otLockT -= dt;
    if (car._otLockT <= 0) car._otSide = 0;
  }

  // 判断是否受阻或具备进攻机会
  const wantAttack = !!(closestAhead && (
      (leadThreat && leadThreat.geo.sLon < 42 && (
          cornerCap[idx] > leadThreat.car.speed + 1.0 ||
          leadThreat.car.inBrake > 0 ||
          v > leadThreat.car.speed + 1.2
      )) ||
      (closestAhead.geo.sLon < 22 && closestAhead.geo.sLon > -CAR_LENGTH * 0.5)
  ));

  const isBlockedNow = !!(leadThreat && leadThreat.geo.sLon < 16 && leadThreat.geo.gapFrontRear < 9.5);
  car._blockT = isBlockedNow ? car._blockT + dt : Math.max(0, car._blockT - dt * 2.0);
  const aggressiveAttack = car._blockT > 0.45 || (leadThreat && leadThreat.car.inBrake > 0 && leadThreat.geo.sLon < 25);

  let desiredLatMid = raceLatMid; // 默认走最优赛车线
  car._defendMode = false;

  if (wantAttack && aheadCars.length > 0) {
    /* ---- ★ 进攻模式：7 走廊评分器（自动寻找内线晚刹 / 交叉线抽头空当） ---- */
    let bestScore = -1e9;
    let bestCandLat = raceLatMid;

    // 构造 7 条候选横向轨迹：含最优赛车线、赛道中心、左右内线极值、以及过渡走廊
    const candidates = [
      raceLatMid,
      0,
      clamp(raceLatMid - 2.6, -safeLimMid, safeLimMid),
      clamp(raceLatMid + 2.6, -safeLimMid, safeLimMid),
      clamp(raceLatMid - 4.8, -safeLimMid, safeLimMid),
      clamp(raceLatMid + 4.8, -safeLimMid, safeLimMid),
      nextCornerSign !== 0 ? nextCornerSign * (safeLimMid - 0.3) : -raceLatMid
    ];

    for (let c = 0; c < candidates.length; c++) {
      const candLat = clamp(candidates[c], -safeLimMid, safeLimMid);
      let score = 0;

      // 1) 偏离最优赛车线的代价（弯中代价高防推头，直道/入弯前代价低鼓励大胆抽头）
      const lineWeight = inCorner ? 2.4 : 0.85;
      score -= Math.abs(candLat - raceLatMid) * lineWeight;

      // 2) 与当前车身横向位置的平滑度代价（防止瞬移式剧烈变线损失速度）
      score -= Math.abs(candLat - myLat) * 0.55;

      // 3) 历史超车方向锁定奖励（防止在对手车尾左右摇摆）
      const sideSign = Math.sign(candLat - (closestAhead ? closestAhead.oPredLat : raceLatMid));
      if (car._otSide !== 0 && sideSign === car._otSide) {
        score += 4.5;
      }

      // 4) 弯道战术奖励：内线插刀（Dive-Bomb） vs 外切内交叉线（Switchback）
      if (nextCornerSign !== 0 && closestAhead) {
        const oppOnInside = (closestAhead.oPredLat * nextCornerSign) > 1.2;
        const candSide = Math.sign(candLat - closestAhead.oPredLat);
        if (!oppOnInside && candSide === nextCornerSign) {
          // 前车未封死内线 → 强烈偏好抢占入弯内线！
          score += 5.5;
        } else if (oppOnInside && closestAhead.car.inBrake > 0 && candSide === -nextCornerSign) {
          // 前车死守内线且提前踩刹车 → 走外线准备交叉线反切（Switchback）！
          score += 4.2;
        }
      }

      // 5) 遍历前方所有车辆，评估该走廊的净空安全度与通行效率
      for (let k = 0; k < aheadCars.length; k++) {
        const item = aheadCars[k];
        const lon = item.geo.sLon;
        if (lon > 55) continue;

        // 考虑前车当前位置与预判位置的包络区间
        const minOppLat = Math.min(item.oLat, item.oPredLat);
        const maxOppLat = Math.max(item.oLat, item.oPredLat);
        const distToEnvelope = candLat < minOppLat
            ? (minOppLat - candLat)
            : (candLat > maxOppLat ? (candLat - maxOppLat) : 0);

        const safePassWidth = CAR_WIDTH + 1.25; // 2.0m车宽 + 1.25m净空余量
        if (distToEnvelope < safePassWidth) {
          // 走廊被该前车阻挡：距离越近、前车越慢或正在踩刹车，惩罚越重
          const proxFactor = clamp((55 - Math.max(0, lon)) / 50, 0.2, 1.5);
          const closingPen = Math.max(0, v - item.car.speed + (item.car.inBrake > 0 ? 6 : 0)) * 1.4;
          const overlapPen = (safePassWidth - distToEnvelope) * (14.0 + closingPen) * proxFactor;
          score -= overlapPen;
        } else {
          // 走廊畅通：额外给予净空奖励
          score += Math.min(distToEnvelope - safePassWidth, 2.0) * 1.2;
        }
      }

      if (score > bestScore) {
        bestScore = score;
        bestCandLat = candLat;
      }
    }

    desiredLatMid = bestCandLat;
    // 更新超车方向锁
    if (closestAhead && Math.abs(desiredLatMid - closestAhead.oPredLat) > 1.1) {
      car._otSide = Math.sign(desiredLatMid - closestAhead.oPredLat);
      car._otLockT = 1.6;
    }
  } else if (
      pursuer &&
      (!leadThreat || leadThreat.geo.sLon > 35) &&
      !(inCorner && v < cornerCap[idx] * 0.98 && nonContExit) // 出弯加速段不牺牲出弯线
  ) {
    /* ---- ★ 防守模式：后视镜卡位 + 入弯前封死内线 ---- */
    car._defendMode = true;
    const pGeo = pursuer.geo;
    const pPredLat = clamp(pursuer.oPredLat, -safeLimMid, safeLimMid);

    if (pGeo.sLon > -CAR_LENGTH - 0.5) {
      // 规则 1：后车车头已经插到并排位置 → 严禁强行关门自杀，保持安全横向间距并抢占有利线
      const safeSideDist = CAR_WIDTH + 1.05;
      if (Math.abs(myLat - pursuer.oLat) < safeSideDist) {
        desiredLatMid = clamp(
            pursuer.oLat + (myLat >= pursuer.oLat ? safeSideDist : -safeSideDist),
            -safeLimMid,
            safeLimMid
        );
      } else {
        desiredLatMid = myLat;
      }
    } else if (nextCornerSign !== 0 && maxCurvAhead > 0.0075) {
      // 规则 2：即将入弯 → 封锁内线！把内线与路肩的距离压缩到小于 1 个车宽（约 2.4m），让后车无法插刀
      const insideWallLat = nextCornerSign * safeLimMid;
      // 守在内线外侧约 1.6m 处：既封死内线通道，又比贴死路缘拥有更大的入弯半径
      const blockInsideLat = insideWallLat - nextCornerSign * 1.4;
      // 若后车正在往内线抽头，立即切向内线封堵；若后车在外线，则居中偏内兼顾入弯角度
      const blendToInside = (pPredLat * nextCornerSign > -0.5) ? 0.85 : 0.55;
      desiredLatMid = clamp(
          raceLatMid * (1 - blendToInside) + blockInsideLat * blendToInside,
          -safeLimMid,
          safeLimMid
      );
    } else {
      // 规则 3：直道巡航被追击 → 影子防守（跟随对手预判横向位置卡住尾流与抽头路线）
      const maxDefendDev = 3.6; // 最大偏离赛车线距离，避免直道画龙损失极速
      const shadowLat = clamp(pPredLat, raceLatMid - maxDefendDev, raceLatMid + maxDefendDev);
      desiredLatMid = clamp(shadowLat, -safeLimMid, safeLimMid);
    }
  }

  // 将目标横向偏移换算为相对于最优赛车线的战术偏移量，并做速率限制平滑
  const rawTacOffset = desiredLatMid - raceLatMid;
  const offsetRate = wantAttack ? 11.0 : (car._defendMode ? 7.5 : 5.0);
  car._tacLat += clamp(rawTacOffset - car._tacLat, -offsetRate * dt, offsetRate * dt);
  const activeLatOffset = car._tacLat;

  /* ==== 5. 曲率自适应三点融合追踪转向 ==== */
  const safeNear = getSafeHalfWidth(iNear, 1.55);
  const safeMid  = safeLimMid;
  const safeFar  = getSafeHalfWidth(iFar, 1.65);

  // 近、中、远三点目标世界坐标计算（出弯直道时远点迅速回归最优线以获得最大出弯半径）
  const farOffsetDecay = nonContExit ? 0.35 : (car._defendMode ? 0.65 : 0.85);
  const latN = clamp(getRaceLat(iNear) + activeLatOffset, -safeNear, safeNear);
  const latM = clamp(raceLatMid + activeLatOffset, -safeMid, safeMid);
  const latF = clamp(getRaceLat(iFar) + activeLatOffset * farOffsetDecay, -safeFar, safeFar);

  const txN = pts[iNear].x + nor[iNear].x * latN;
  const tyN = pts[iNear].y + nor[iNear].y * latN;
  const txM = pts[iMid].x  + nor[iMid].x  * latM;
  const tyM = pts[iMid].y  + nor[iMid].y  * latM;
  const txF = pts[iFar].x  + nor[iFar].x  * latF;
  const tyF = pts[iFar].y  + nor[iFar].y  * latF;

  const dxN = txN - car.x, dyN = tyN - car.y;
  const dxM = txM - car.x, dyM = tyM - car.y;
  const dxF = txF - car.x, dyF = tyF - car.y;

  const aN = wrapAngle(Math.atan2(dyN, dxN) - car.angle);
  const aM = wrapAngle(Math.atan2(dyM, dxM) - car.angle);
  const aF = wrapAngle(Math.atan2(dyF, dxF) - car.angle);

  // 自适应融合权重：非连续弯道出弯时加大中远点权重，提前拉直车头准备全油门
  let wN = 0.25 + cornerIntensity * 0.26;
  let wF = 0.48 - cornerIntensity * 0.28;
  if (nonContExit) {
    wN = Math.max(0.20, wN - 0.12);
    wF = Math.min(0.55, wF + 0.15);
  }
  const wM = 1.0 - wN - wF;
  const alpha = aN * wN + aM * wM + aF * wF;

  const dist = (Math.hypot(dxF, dyF) * wF + Math.hypot(dxM, dyM) * wM + Math.hypot(dxN, dyN) * wN) || 1;
  const kappa = 2 * Math.sin(alpha) / dist;
  const omegaMax = Math.min(latGrip / Math.max(v, 1), maxOmega) * Math.min(1, v / 3);
  let duty = clamp((v * kappa) / (omegaMax || 1), -1, 1);

  // 叠加并排贴身防撞保护
  if (sideGuard !== 0) {
    duty = clamp(duty + clamp(sideGuard * 0.22, -0.35, 0.35), -1, 1);
  }

  // 方向盘平滑滤波：弯中与攻防变线时极速响应，纯直道巡航时抑制高频抖动
  const steerResp = (inCorner || wantAttack || sideGuard !== 0) ? 32 : 22;
  const steerAlpha = Math.min(1, dt * steerResp);
  out.steer = (out.steer || 0) + (duty - (out.steer || 0)) * steerAlpha;
  out.left = out.steer < -0.05;
  out.right = out.steer > 0.05;

  /* ==== 6. 纵向控制：预判防追尾 + 晚刹插刀 + 非连续弯道提前开油 ==== */
  const brakeCap = PHYS.brake * (perf.brakeMult ?? 1.0);
  const lightCap = brakeCap * PHYS.lightBrakeFactor;
  const scanCapM = Math.max(320, (v * v) / (2 * brakeCap) + 80);
  const scanSteps = Math.min(
      Math.round(((v * v) / (2 * lightCap) + 80) / DS),
      Math.round(scanCapM / DS)
  );

  // 若大幅偏离最优赛车线（例如内线晚刹超车或强行防守），弯心曲率半径会变小，需动态折算安全弯速
  const offLineDist = Math.abs(activeLatOffset);
  const linePenalty = (offLineDist > 1.8 && maxCurvAhead > 0.010)
      ? clamp(1.0 - (offLineDist - 1.8) * 0.018, 0.92, 1.0)
      : 1.0;

  let env1 = cornerCap[idx] * linePenalty;
  let env2 = cornerCap[idx] * linePenalty;
  let aReq = 0;

  for (let s = 1; s <= scanSteps; s++) {
    const j = stepIdx(idx, s);
    const d = s * DS;
    // 远端恢复到最优线速度，近端应用偏移折算
    const localPen = s * DS < 35 ? linePenalty : 1.0;
    const cap = cornerCap[j] * localPen;
    if (cap < v) {
      const req = (v * v - cap * cap) / (2 * d);
      if (req > aReq) aReq = req;
    }
    const r1 = Math.sqrt(cap * cap + 2 * lightCap * d);
    const r2 = Math.sqrt(cap * cap + 2 * brakeCap * 0.985 * d);
    if (r1 < env1) env1 = r1;
    if (r2 < env2) env2 = r2;
  }

  // ★ 晚刹插刀（Dive-Bomb）激活条件：处于进攻状态、已与前车横向错开进入超车走廊
  const canDiveBomb = !!(wantAttack && closestAhead &&
      closestAhead.geo.sLon < 24 && closestAhead.geo.sLon > -2 &&
      Math.abs(myLat - closestAhead.oPredLat) > CAR_WIDTH + 0.35);

  const envGo = canDiveBomb ? Math.min(env2, cornerCap[idx] * 1.02) : env1;

  /* ---- ★ 前车预判防追尾与跟车限速 ---- */
  let emergency = false;
  for (let k = 0; k < aheadCars.length; k++) {
    const item = aheadCars[k];
    const geo = item.geo;
    if (geo.sLon <= 0 || geo.sLon > 58) continue;

    // 关键改进：如果本车已经抽头进入畅通的超车线（横向错开大于车宽+余量），直接无视前车限速全速超越！
    const latClearance = Math.abs((myLat + myVLat * 0.2) - item.oPredLat);
    if (latClearance > CAR_WIDTH + 0.55 && Math.abs(geo.dLat) > CAR_WIDTH + 0.45) {
      continue;
    }

    const gap = geo.gapFrontRear;
    const closing = v - item.car.speed;

    // 紧急防撞触发：净间距极小且存在追尾速度差
    if (gap < 1.15 && closing > 0.4 && Math.abs(geo.dLat) < CAR_WIDTH + 0.35) {
      emergency = true;
      break;
    }

    // 结合前车刹车灯（inBrake）超前折算前车 0.14 秒后的有效速度，防止前车急刹导致追尾
    const lookAheadT = item.car.inBrake > 0 ? 0.14 : 0.05;
    const predOppSpeed = Math.max(0, item.car.speed - item.oEffDecel * lookAheadT);
    const reserveGap = aggressiveAttack ? 1.05 : 1.65;
    const safeGap = Math.max(gap - reserveGap, 0.35);

    const followCap = Math.sqrt(predOppSpeed * predOppSpeed + 2 * brakeCap * 0.92 * safeGap);
    if (followCap < env1) env1 = followCap;
    if (followCap < env2) env2 = followCap;
  }

  /* ---- ★ 刹车与油门分档输出（严格遵循 brake > 0 时 up 无效的物理铁律） ---- */
  const steerMag = Math.abs(out.steer);
  // 摩擦圆保护：大角度转向时重刹会砍掉 23% 横向抓地，弯中大转向优先用 1 档轻刹维持循迹性
  const heavySteerInCorner = inCorner && steerMag > 0.52 && v < cornerCap[idx] + 3.5;

  if (emergency) {
    out.brake = 2;
  } else if (!canDiveBomb && aReq > lightCap * 1.03 && !heavySteerInCorner) {
    out.brake = 2;
  } else if (v > env2 + 0.18) {
    out.brake = heavySteerInCorner && v < env2 + 1.8 ? 1 : 2;
  } else if (v > envGo + 0.12) {
    out.brake = 1;
  } else {
    out.brake = 0;
  }

  // ★ 非连续弯道与出弯直道激进提前开油：
  // 只要无需重刹、车头已基本对准出弯方向（|alpha| 小），且前方曲率正在快速衰减，立即释放轻刹并全油门弹射！
  const readyToLaunch = !emergency && out.brake <= 1 && (
      (nonContExit && Math.abs(alpha) < 0.26 && v < cornerCap[idx] + 0.85) ||
      (exitStraight && Math.abs(alpha) < 0.32 && v < cornerCap[iNear] + 1.2)
  );

  if (readyToLaunch) {
    out.brake = 0; // 必须先将 brake 清零，out.up 才能在物理引擎中生效！
    out.up = true;
  } else if (out.brake === 0) {
    // 弯中与直道全油门控制：出弯直道与进攻/防守状态不留速度余量，吃满 100% 驱动力
    const throttleMargin = (exitStraight || nonContExit || wantAttack || car._defendMode) ? -0.15 : 0.03;
    out.up = (v < cornerCap[idx] - throttleMargin) && !(sideSqueeze && v > cornerCap[idx] * 0.98);
  } else {
    out.up = false;
  }

  // 写入调试可视化探针（开启视图工具「AI 探测线」可见当前动态攻防目标点）
  out.targetX = txM;
  out.targetY = tyM;
  out.targetSpeed = env1;
};
