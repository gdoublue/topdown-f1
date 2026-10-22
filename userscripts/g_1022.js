let _cachedTrackId = null;
let _cachedTrackN = -1;
let _cachedPtsRef = null;
let _optOff = null;
let _optX = null;
let _optY = null;
let _baseOff = null;

function clampIdx(i) {
    if (!Number.isFinite(i)) return 0;
    const idx = i | 0;
    if (idx < 0) return 0;
    if (idx >= N) return N - 1;
    return idx;
}

function stepIdx(i, delta) {
    if (track && track.isLinear) {
        return clamp(i + delta, 0, N - 1);
    }
    const m = (i + delta) % N;
    return m < 0 ? m + N : m;
}

function ensureTrackGeometry() {
    const tid = track ? track.id : null;
    if (_optX !== null && _cachedTrackId === tid && _cachedTrackN === N && _cachedPtsRef === pts) {
        return;
    }
    _cachedTrackId = tid;
    _cachedTrackN = N;
    _cachedPtsRef = pts;

    _baseOff = new Float32Array(N);
    _optOff = new Float32Array(N);
    _optX = new Float32Array(N);
    _optY = new Float32Array(N);
    const lim = new Float32Array(N);
    const tmp = new Float32Array(N);

    for (let i = 0; i < N; i++) {
        const dx = lineX[i] - pts[i].x;
        const dy = lineY[i] - pts[i].y;
        const bOff = dx * nor[i].x + dy * nor[i].y;
        const maxLat = Math.max(1.2, hw[i] - 2.22);
        lim[i] = maxLat;
        _baseOff[i] = clamp(bOff, -maxLat, maxLat);

        // Push slightly deeper into the safe asphalt margin (hw - 2.22 vs built-in hw - 3.4)
        const k = curvS[i] || 0;
        const apexBias = Math.abs(k) > 0.005 ? Math.sign(k) * Math.min(0.65, Math.abs(k) * 42) : 0;
        _optOff[i] = clamp(_baseOff[i] * 1.12 + apexBias, -maxLat, maxLat);
    }

    const iters = track && track.isLinear ? 12 : 48;
    for (let it = 0; it < iters; it++) {
        for (let i = 0; i < N; i++) {
            const im2 = stepIdx(i, -2);
            const im1 = stepIdx(i, -1);
            const ip1 = stepIdx(i, 1);
            const ip2 = stepIdx(i, 2);

            const xm1 = pts[im1].x + nor[im1].x * _optOff[im1];
            const ym1 = pts[im1].y + nor[im1].y * _optOff[im1];
            const xp1 = pts[ip1].x + nor[ip1].x * _optOff[ip1];
            const yp1 = pts[ip1].y + nor[ip1].y * _optOff[ip1];
            const xm2 = pts[im2].x + nor[im2].x * _optOff[im2];
            const ym2 = pts[im2].y + nor[im2].y * _optOff[im2];
            const xp2 = pts[ip2].x + nor[ip2].x * _optOff[ip2];
            const yp2 = pts[ip2].y + nor[ip2].y * _optOff[ip2];

            const targetX = 0.64 * (xm1 + xp1) - 0.14 * (xm2 + xp2);
            const targetY = 0.64 * (ym1 + yp1) - 0.14 * (ym2 + yp2);
            const proj = (targetX - pts[i].x) * nor[i].x + (targetY - pts[i].y) * nor[i].y;

            const blended = 0.72 * proj + 0.28 * _baseOff[i];
            tmp[i] = clamp(blended, -lim[i], lim[i]);
        }
        for (let i = 0; i < N; i++) {
            _optOff[i] = tmp[i];
        }
    }

    for (let i = 0; i < N; i++) {
        // Blend with precomputed line so getApexReleaseCap timing remains perfectly aligned
        const finalOff = clamp(0.62 * _optOff[i] + 0.38 * _baseOff[i], -lim[i], lim[i]);
        _optOff[i] = finalOff;
        _optX[i] = pts[i].x + nor[i].x * finalOff;
        _optY[i] = pts[i].y + nor[i].y * finalOff;
    }
}

function getPointWithOffset(idx, extraOffset) {
    const i = clampIdx(idx);
    const maxLat = Math.max(1.0, hw[i] - 2.22);
    const totalOff = clamp(_optOff[i] + extraOffset, -maxLat, maxLat);
    return {
        x: pts[i].x + nor[i].x * totalOff,
        y: pts[i].y + nor[i].y * totalOff,
        off: totalOff
    };
}

function driver(car, out, dt, otherCars) {
    ensureTrackGeometry();

    const safeDt = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.05) : 1 / 60;
    const v = Number.isFinite(car.speed) ? Math.abs(car.speed) : 0;
    const perf = car.perf || {};
    const latGrip = perf.latGrip ?? PHYS.latGrip;
    const maxOmega = perf.maxOmega ?? PHYS.maxOmega;
    const brakeMult = perf.brakeMult ?? 1.0;
    const brakeA = Math.max(1.0, PHYS.brake * brakeMult);
    const lightA = brakeA * PHYS.lightBrakeFactor;
    const maxAsphaltV = (perf.maxSpeed && perf.maxSpeed[0]) ? perf.maxSpeed[0] : PHYS.maxSpeed[0];

    if (car._ai == null) {
        car._ai = {
            stuck: 0,
            rev: 0,
            revSteer: 0,
            moved: false,
            inBrakeZone: false,
            latOffset: 0,
            targetLatOffset: 0,
            lockTimer: 0,
            lastSteer: 0,
            wasUp: false
        };
    }
    const st = car._ai;

    // ---- 0) Unstuck & Reverse Recovery ----
    if (st.rev > 0) {
        st.rev -= safeDt;
        out.up = false;
        out.brake = 2;
        out.steer = Number.isFinite(st.revSteer) ? st.revSteer : 0;
        out.left = out.steer < -0.05;
        out.right = out.steer > 0.05;
        out.targetX = car.x;
        out.targetY = car.y;
        out.targetSpeed = 0;
        return;
    }
    if (v > 3.5) st.moved = true;
    if (st.moved && !car.finished) {
        st.stuck = v < 1.4 ? st.stuck + safeDt : Math.max(0, st.stuck - safeDt * 2.2);
        if (st.stuck > 2.1) {
            const ni = clampIdx(car.nearIdx ?? track.idxAt(car.trackS));
            const nCar = (car.x - pts[ni].x) * nor[ni].x + (car.y - pts[ni].y) * nor[ni].y;
            st.rev = 0.85;
            st.revSteer = clamp(Math.sign(nCar) * 0.65, -1, 1);
            st.stuck = 0;
            st.inBrakeZone = false;
            out.up = false;
            out.brake = 2;
            out.steer = st.revSteer;
            out.left = out.steer < -0.05;
            out.right = out.steer > 0.05;
            out.targetX = pts[ni].x;
            out.targetY = pts[ni].y;
            out.targetSpeed = 0;
            return;
        }
    }

    const nowS = Number.isFinite(car.trackS) ? car.trackS : 0;
    const idxNow = clampIdx(track.idxAt(nowS));
    const nCar = (car.x - pts[idxNow].x) * nor[idxNow].x + (car.y - pts[idxNow].y) * nor[idxNow].y;
    const vLatCar = v * (Math.cos(car.angle) * nor[idxNow].x + Math.sin(car.angle) * nor[idxNow].y);

    // ---- 1) Corner Speed Cap Table (Single consistent source per §8.2 & §10.9) ----
    const cap = getApexReleaseCap(perf);

    const capNow = cap[idxNow];

    // ---- 1.5) 每辆车的制动 / 转向极限：全部由 perf 现场推导，不按车型写死系数 ----
    // 同一组公式对 F1（满刹 63 m/s²、横向 48 m/s²）和 U9X（满刹 19.7、横向 17）同时成立，
    // 车型差异只体现在 aMax / latMax 上，因此不会再出现"整类车被统一保守处理"。
    const aMax = brakeA;                                    // 满刹纵向极限（= PHYS.brake × brakeMult）
    const latMax = Math.max(latGrip, 1e-3);
    const A_PLAN = aMax * 0.98;                             // 制动规划利用率（实测 0.98 最快且全赛道 0 草地）
    // 摩擦圆：要以速度 c 通过曲率为 k 的弯（横向需求 c²·k），纵向还能拿出多少制动力
    // a_lon = a_plan · √(1 − min(1, (c²k / latMax)²))，底线 PHYS.frictionLatFloor
    const fricFactor = (c, k) => {
        const r = (c * c * Math.abs(k)) / latMax;
        return Math.sqrt(Math.max(PHYS.frictionLatFloor, 1 - Math.min(1, r * r)));
    };
    // 循迹刹车的"最后几米"= 重刹→转向的交接距离，随速度缩放（固定 5.5m 在 300km/h 时等于没有）
    const trailDistWindow = clamp(v * 0.13, 4.0, 14.0);

    // ---- 2) Forward High-Resolution Braking Envelope Scan ----
    const maxScanM = Math.min(track.length * 0.6, (v * v) / (2 * A_PLAN * 0.7) + 55);
    let envLight = capNow;
    let envHeavy = capNow;
    let maxAReq = 0;
    let maxCurvAhead = Math.abs(curvS[idxNow] || 0);
    let hasChicaneReversal = false;
    const signNow = Math.abs(curvS[idxNow]) > 0.0035 ? Math.sign(curvS[idxNow]) : 0;

    let d = 2.5;
    while (d <= maxScanM) {
        const idxD = clampIdx(track.idxAt(nowS + d));
        const kD = curvS[idxD] || 0;
        const absKD = Math.abs(kD);
        if (d <= Math.max(22, v * 0.55)) {
            if (absKD > maxCurvAhead) maxCurvAhead = absKD;
            if (signNow !== 0 && absKD > 0.004 && Math.sign(kD) !== signNow) {
                hasChicaneReversal = true;
            }
        }

        const c = cap[idxD];
        // 摩擦圆只作用在"循迹段"（最后 dTrail 米，此时车已经带转向角）：
        //   直道段 → 全力制动 A_PLAN；循迹段 → 按该点横向需求 (c²κ/latMax) 打折
        // 之前把折减套在整段刹车距离上是错的（会把 500m 的高速刹车区也一起打折 → 过于保守），
        // 这一步同时取代了原先按 isWeakBrake 分档的 fcPenalty / 0.965 常数折减。
        const fric = fricFactor(c, kD);
        const aHeavyTrail = A_PLAN * fric;
        const aSoftTrail = lightA * fric;

        const dEff = Math.max(0.08, d - v * safeDt * 0.55);
        const dTrail = Math.min(dEff, trailDistWindow);
        const dMain = Math.max(0, dEff - dTrail);

        // 远端全力制动 + 最后 dTrail 米的循迹制动（envLight 更松 → 分档到轻刹）
        const rLight = Math.sqrt(Math.max(0, c * c + 2 * A_PLAN * dMain + 2 * aSoftTrail * dTrail));
        const rHeavy = Math.sqrt(Math.max(0, c * c + 2 * A_PLAN * dMain + 2 * aHeavyTrail * dTrail));

        if (rLight < envLight) envLight = rLight;
        if (rHeavy < envHeavy) envHeavy = rHeavy;

        if (v > c) {
            const aNeed = (v * v - c * c) / (2 * Math.max(1.2, dEff));
            if (aNeed > maxAReq) maxAReq = aNeed;
        }

        d += d < 36 ? 2.8 : (d < 95 ? 5.0 : 8.0);
    }

    // ---- 3) Predictive Corner-Entry Traffic, Corridor Scoring & Anti-Rear-End System ----
    let emergency = false;
    let sideGuardSteer = 0;

    // Upcoming corner entry index for trajectory convergence prediction
    const entryLookM = clamp(12 + v * 0.45, 14, 58);
    const idxEntry = clampIdx(track.idxAt(nowS + entryLookM));
    const kEntry = curvS[idxEntry] || 0;
    const isApproachingCorner = cap[idxEntry] < v + 6.0 || Math.abs(kEntry) > 0.0045 || maxCurvAhead > 0.0045;

    if (otherCars && otherCars.length > 1) {
        const threats = [];
        const maxTrafficScan = Math.max(68, v * 1.65);

        for (let i = 0; i < otherCars.length; i++) {
            const o = otherCars[i];
            if (!o || o === car) continue;
            const geo = getCarDistance(car, o);
            if (!geo || !Number.isFinite(geo.sLon) || !Number.isFinite(geo.dLat)) continue;
            if (geo.sLon < -7.5 || geo.sLon > maxTrafficScan) continue;

            const oS = Number.isFinite(o.trackS) ? o.trackS : nowS + geo.sLon;
            const oIdx = clampIdx(o.nearIdx ?? track.idxAt(oS));
            const nO = (o.x - pts[oIdx].x) * nor[oIdx].x + (o.y - pts[oIdx].y) * nor[oIdx].y;
            const dnO = nO - _optOff[oIdx];
            const oV = Number.isFinite(o.speed) ? Math.abs(o.speed) : 0;
            const vnO = oV * (Math.cos(o.angle) * nor[oIdx].x + Math.sin(o.angle) * nor[oIdx].y);

            // Predict opponent's lateral range from current position into the corner entry:
            // Opponents outside the racing line converge toward _optOff (dn -> 0) as they enter a corner!
            const convFactor = isApproachingCorner ? 0.30 : 0.70;
            const predDn1 = dnO + clamp(vnO * 0.35, -1.8, 1.8);
            const predDn2 = dnO * convFactor;
            const minPredDn = Math.min(dnO, predDn1, predDn2);
            const maxPredDn = Math.max(dnO, predDn1, predDn2);

            threats.push({
                o,
                geo,
                oS,
                oIdx,
                nO,
                dnO,
                oV,
                vnO,
                minPredDn,
                maxPredDn
            });

            // Side-by-side anti-rubbing repulsion (§4: rubbing costs 26% speed/sec)
            if (Math.abs(geo.sLon) < CAR_LENGTH + 1.4 && Math.abs(geo.dLat) < CAR_WIDTH + 1.05) {
                const pushDir = geo.dLat >= 0 ? -1 : 1; // geo.dLat > 0 means opponent is on our right -> steer left
                const urgency = clamp((CAR_WIDTH + 1.05 - Math.abs(geo.dLat)) / 1.2, 0, 1);
                sideGuardSteer += pushDir * urgency * 0.16;
            }
        }

        // 3a) Proactive Lateral Corridor Scoring (avoids blocked optimal corner-entry lines)
        if (threats.length > 0) {
            const maxCorridor = Math.max(0.8, hw[idxEntry] - 2.35 - Math.abs(_optOff[idxEntry]) * 0.35);
            const cands = [0, -1.2, 1.2, -2.4, 2.4, -3.6, 3.6, -4.8, 4.8];
            let bestScore = -1e9;
            let bestOff = 0;

            // 前方同车道压着一台明显更慢的车 → 主动抽头，而不是收油跟着它走
            // （"直道上莫名其妙减速"的根因：不抽头 → 跟车限速生效 → envLight/envHeavy 压低）
            let slowAhead = null;
            for (let t = 0; t < threats.length; t++) {
                const th = threats[t];
                if (th.geo.sLon <= CAR_LENGTH + 1.5 || th.geo.sLon > 46) continue;
                if (Math.abs(th.dnO) > CAR_WIDTH + 1.0) continue;      // 横向已错开：不挡路
                if (th.oV > v - 1.0) continue;                          // 不比我慢：不需要超
                if (!slowAhead || th.geo.sLon < slowAhead.geo.sLon) slowAhead = th;
            }
            const escapeSide = slowAhead ? (slowAhead.dnO >= 0 ? -1 : 1) : 0;

            for (let cIdx = 0; cIdx < cands.length; cIdx++) {
                const cand = clamp(cands[cIdx], -maxCorridor, maxCorridor);
                // Check physical asphalt validity at near and entry indices
                const absNear = Math.abs(_optOff[idxNow] + cand);
                const absEntry = Math.abs(_optOff[idxEntry] + cand);
                if (absNear > hw[idxNow] - 2.20 || absEntry > hw[idxEntry] - 2.20) continue;

                let score = -Math.abs(cand) * 1.35; // Prefer optimal racing line when clear
                score -= Math.abs(cand - st.latOffset) * (st.lockTimer > 0 ? 1.8 : 0.75); // Smoothness hysteresis

                // Slight inside-line preference when approaching a corner
                if (Math.abs(kEntry) > 0.004) {
                    score += Math.sign(kEntry) * cand * 0.45;
                }

                // 被慢车堵住时：奖励离开原线，且强烈奖励往空出来的一侧抽头
                if (slowAhead) {
                    score += Math.abs(cand) * 0.9;
                    if (Math.sign(cand) === escapeSide) {
                        score += 2.6 * Math.min(1, Math.abs(cand) / 2.0);
                    } else if (cand !== 0) {
                        score -= 0.9 * Math.abs(cand);
                    }
                }

                for (let t = 0; t < threats.length; t++) {
                    const th = threats[t];
                    const sLon = th.geo.sLon;

                    // Side-by-side forbidden zone
                    if (sLon > -CAR_LENGTH - 1.2 && sLon < CAR_LENGTH + 2.5) {
                        const latDiffNow = Math.abs(cand - th.dnO);
                        if (latDiffNow < CAR_WIDTH + 0.95) {
                            score -= 120.0 * (CAR_WIDTH + 1.05 - latDiffNow);
                        }
                    } else if (sLon >= CAR_LENGTH + 2.5) {
                        const closing = Math.max(0, v - th.oV);
                        const ttc = sLon / Math.max(closing + 4.0, 4.0);
                        if (ttc < 3.2 || sLon < 42) {
                            // Check both current lane and predicted corner-entry convergence footprint
                            const inEntrySweep = cand >= th.minPredDn - (CAR_WIDTH + 0.65) &&
                                cand <= th.maxPredDn + (CAR_WIDTH + 0.65);
                            const distToCurr = Math.abs(cand - th.dnO);
                            const distToEntry = Math.abs(cand - th.dnO * (isApproachingCorner ? 0.35 : 0.8));
                            const effLatDist = Math.min(distToCurr, distToEntry);

                            if (inEntrySweep || effLatDist < CAR_WIDTH + 0.75) {
                                const weight = clamp(45.0 / Math.max(sLon, 4.0), 0.6, 8.0) * (isApproachingCorner ? 1.45 : 1.0);
                                score -= weight * (CAR_WIDTH + 1.2 - Math.min(effLatDist, CAR_WIDTH + 1.1));
                            }
                        }
                    }
                }

                if (score > bestScore) {
                    bestScore = score;
                    bestOff = cand;
                }
            }

            if (Math.abs(bestOff - st.targetLatOffset) > 0.8) {
                st.targetLatOffset = bestOff;
                st.lockTimer = 1.1;
            } else {
                st.targetLatOffset = bestOff;
            }
        } else {
            st.targetLatOffset = 0;
        }

        // 3b) Predictive Anti-Rear-End Longitudinal Speed Envelope
        // Evaluates both current lane overlap AND future corner-entry path convergence!
        const plannedOffNow = st.latOffset;
        const plannedOffEntry = 0.55 * st.latOffset + 0.45 * st.targetLatOffset;

        for (let t = 0; t < threats.length; t++) {
            const th = threats[t];
            const geo = th.geo;
            if (geo.sLon <= 0) continue;

            // 1. Direct physical overlap in vehicle frame
            const relLatVel = th.vnO - vLatCar;
            const predDLat = geo.dLat + relLatVel * clamp(geo.sLon / Math.max(v, 10), 0.1, 0.75);
            const directOverlap = Math.abs(geo.dLat) < CAR_WIDTH + 0.78 || Math.abs(predDLat) < CAR_WIDTH + 0.68;

            // 2. Corner-Entry Path Convergence Overlap:
            // Even if currently offset on the straight, will our corner entry line and opponent's corner entry line intersect?
            const timeToReachO = geo.sLon / Math.max(v, 8.0);
            const willNotPassBeforeCorner = (geo.sLon + (th.oV - v) * Math.min(timeToReachO, 1.4)) > -(CAR_LENGTH + 1.5);
            const entryCorridorOverlap =
                plannedOffEntry >= th.minPredDn - (CAR_WIDTH + 0.55) &&
                plannedOffEntry <= th.maxPredDn + (CAR_WIDTH + 0.55);
            const currCorridorOverlap = Math.abs(plannedOffNow - th.dnO) < CAR_WIDTH + 0.70;

            const convergenceHazard = isApproachingCorner &&
                geo.sLon < Math.max(52, v * 1.15) &&
                willNotPassBeforeCorner &&
                (entryCorridorOverlap || currCorridorOverlap);

            if (!directOverlap && !convergenceHazard) continue;

            // 横向"通道净空"：规划走线（含走廊侧移）与对手还差多少才完全错开。
            // 0 = 完全重叠（必须跟车），1 = 已完全错开（可以全油门通过）。
            // 直道上"明明有地方超车却先减速"就是这里没有考虑规划侧移造成的。
            const latClearPlan = Math.abs(plannedOffEntry - th.dnO) - CAR_WIDTH;
            const passFactor = clamp(latClearPlan / 1.5, 0, 1);

            // Emergency anti-rear-end brake check（通道已经打开时不触发，交给限速平滑收敛）
            if (passFactor < 0.45) {
                if (directOverlap && geo.gapFrontRear < 1.6 && v > th.oV + 0.4 && Math.abs(geo.dLat) < CAR_WIDTH + 0.48) {
                    emergency = true;
                }
                if (directOverlap && geo.gapFrontRear < (v - th.oV) * 0.28 + 1.1 && v > th.oV + 3.5 && Math.abs(geo.dLat) < CAR_WIDTH + 0.42) {
                    emergency = true;
                }
            }

            // Estimate opponent's conservative speed considering active braking and upcoming corner cap
            let oEffV = th.oV;
            if (th.o.inBrake === 2) {
                oEffV = Math.max(0, oEffV - brakeA * 0.22);
            } else if (th.o.inBrake === 1 || th.o.inUp === false) {
                oEffV = Math.max(0, oEffV - brakeA * 0.08);
            }

            // Opponent's upcoming corner speed (opponents often use conservative 78%~90% grip lines)
            const oCornerCap = Math.min(
                cap[th.oIdx],
                cap[clampIdx(track.idxAt(th.oS + 10))],
                cap[clampIdx(track.idxAt(th.oS + 22))]
            ) * 0.92;

            const brakeMargin = th.o.inBrake > 0 ? 3.0 : 2.1;
            // 通道打开多少，就允许贴多近：passFactor=1 时不再预留刹车余量（可以直接超过去）
            const safeGapNow = Math.max(0.15, geo.gapFrontRear - brakeMargin * (1 - passFactor * 0.9));
            const followDecel = brakeA * (isApproachingCorner ? 0.80 : 0.86);

            // Direct following speed cap (NO positive closing-speed bonus so we never overshoot into rear bumper!)
            let followCap = Math.sqrt(Math.max(0, oEffV * oEffV + 2 * followDecel * safeGapNow));

            // Corner-entry queue prediction: if opponent is entering or about to enter a corner on our line,
            // they will decelerate to oCornerCap and occupy the track ahead of the apex!
            if (oCornerCap < oEffV + 2.0) {
                const distOToApex = 12.0;
                const queueGap = Math.max(0.15, geo.gapFrontRear + distOToApex - 3.2);
                const cornerEntryFollowCap = Math.sqrt(Math.max(0, oCornerCap * oCornerCap + 2 * followDecel * queueGap));
                if (cornerEntryFollowCap < followCap) {
                    followCap = cornerEntryFollowCap;
                }
            }

            if (followCap < envLight) envLight = followCap;
            if (followCap + 0.6 < envHeavy) envHeavy = followCap + 0.6;
        }
    } else {
        st.targetLatOffset = 0;
    }

    // Smooth lateral offset transition
    if (st.lockTimer > 0) st.lockTimer = Math.max(0, st.lockTimer - safeDt);
    const latRate = Math.abs(st.targetLatOffset) > Math.abs(st.latOffset) ? 3.8 : 2.4;
    const maxStepLat = latRate * safeDt;
    st.latOffset = clamp(
        st.latOffset + clamp(st.targetLatOffset - st.latOffset, -maxStepLat, maxStepLat),
        -Math.max(0.5, hw[idxNow] - 2.25),
        Math.max(0.5, hw[idxNow] - 2.25)
    );

    // ---- 4) Curvature- & Chicane-Adaptive 3-Point Pure Pursuit + Boundary Guard ----
    const kSeverity = clamp(maxCurvAhead / 0.016, 0, 1);
    const chicaneFactor = hasChicaneReversal ? 0.72 : 1.0;

    const dNear = clamp((5.5 + v * 0.15) * chicaneFactor, 5.5, 17.0);
    const dMid = clamp((9.5 + v * 0.28) * (1 - 0.22 * kSeverity) * chicaneFactor, 9.0, 31.0);
    const dFar = clamp((14.5 + v * 0.44) * (1 - 0.32 * kSeverity) * chicaneFactor, 13.0, 48.0);

    const pNear = getPointWithOffset(track.idxAt(nowS + dNear), st.latOffset);
    const pMid = getPointWithOffset(track.idxAt(nowS + dMid), st.latOffset * 0.85);
    const pFar = getPointWithOffset(track.idxAt(nowS + dFar), st.latOffset * 0.65);

    const wNear = hasChicaneReversal ? 0.52 : (0.22 + 0.30 * kSeverity);
    const wMid = hasChicaneReversal ? 0.36 : 0.44;
    // 权重必须严格归一（0.08 下限会让三者之和变成 1.04）
    const wFar = Math.max(0, 1.0 - wNear - wMid);
    const wSum = wNear + wMid + wFar || 1;

    // 相对向量合成：绝不能用世界绝对坐标做加权平均（权重误差 × 坐标量级 = 几十米偏移）
    const aimX = car.x + (wNear * (pNear.x - car.x) + wMid * (pMid.x - car.x) + wFar * (pFar.x - car.x)) / wSum;
    const aimY = car.y + (wNear * (pNear.y - car.y) + wMid * (pMid.y - car.y) + wFar * (pFar.y - car.y)) / wSum;

    const dx = aimX - car.x;
    const dy = aimY - car.y;
    const dist = Math.max(Math.hypot(dx, dy), 1.0);
    const alpha = wrapAngle(Math.atan2(dy, dx) - car.angle);
    const kappa = (2 * Math.sin(alpha)) / dist;

    // Effective yaw rate ceiling considering surface and low-speed scaling (§6.1)
    // 摩擦圆：纵向已吃掉的抓地会挤占横向，重刹时只剩 77.5%（§6.2），
    // 只按名义 latGrip 折算会把转向上限高估 29%，导致入弯推头冲出赛道
    const surfScale = car.surf === 2 ? 0.74 : 1.0;
    const usedLong = Math.min(1, Math.abs(car.accel || 0) / Math.max(1, brakeA));
    const latAvail = latGrip * Math.sqrt(Math.max(PHYS.frictionLatFloor, 1 - usedLong * usedLong));
    const omegaMax = Math.min(maxOmega, latAvail / Math.max(v, 1.0)) * Math.min(1.0, v / 3.0) * surfScale;
    let steer = clamp((v * kappa) / Math.max(omegaMax, 1e-4), -1, 1);

    // Active Asphalt Boundary Guard (0% grass protection)
    const predNCar = nCar + vLatCar * 0.26;
    const safeWall = hw[idxNow] - 2.12;
    if (Math.abs(predNCar) > safeWall) {
        const excess = Math.abs(predNCar) - safeWall;
        const guardPull = -Math.sign(predNCar) * clamp(excess * 0.42, 0, 0.45);
        steer = clamp(steer + guardPull, -1, 1);
    } else {
        steer = clamp(steer + sideGuardSteer, -1, 1);
    }

    // Startup straight-line traction protection (§10.18)
    if (v < 2.2) {
        steer *= clamp(v / 2.2, 0.2, 1.0);
    }

    // ---- 5) Hysteresis Braking & Full-Throttle Exit Control ----
    if (v > envHeavy + 0.12 || maxAReq >= A_PLAN * 0.92) {
        st.inBrakeZone = true;
    } else if (v <= envLight - 0.10 && maxAReq < lightA * 0.60) {
        st.inBrakeZone = false;
    }

    let brakeOut = 0;
    if (emergency) {
        brakeOut = 2;
        st.inBrakeZone = true;
    } else if (v > envHeavy + 0.18 || (st.inBrakeZone && maxAReq >= A_PLAN * 0.66)) {
        brakeOut = 2;
    } else if (v > envLight + 0.08 || (st.inBrakeZone && v > envLight - 0.05)) {
        brakeOut = 1;
    } else {
        brakeOut = 0;
    }

    // Friction-circle understeer rescue: if near outer asphalt boundary at heavy steering lock,
    // step down heavy brake (2 -> 1) so lateral grip recovers from 77.5% to 87.4% (§6.2)
    if (!emergency && brakeOut === 2 && Math.abs(steer) > 0.86 && Math.abs(predNCar) > hw[idxNow] - 2.38) {
        brakeOut = 1;
    }

    // 边界速度救援：方向已经打满、而 0.55s 后的横向预测位置仍要出白线 —— 此时唯一有效的输入是降速。
    // 可用横摆角速度 ∝ 1/v，把速度收下来才能把最小转弯半径收回来；
    // 继续维持速度只会以最大锁角直着刮上草地（U9X 这类 1.7g 车最容易踩这个坑）。
    const predN2 = nCar + vLatCar * 0.55;
    if (!emergency && v > 10 && Math.abs(steer) > 0.90) {
        if (Math.abs(predN2) > hw[idxNow] - 0.5) {
            brakeOut = 2;
        } else if (Math.abs(predN2) > hw[idxNow] - 1.6 && brakeOut === 0) {
            brakeOut = 1;
        }
    }

    // Never hold brake === 2 when nearly stationary to prevent accidental reverse (§5.2 & §10.4)
    if (v < 0.55 && brakeOut === 2) {
        brakeOut = 1;
    }

    // Apex release throttle logic: full throttle whenever brake === 0 and within safe cornering cap
    const exitLookIdx = clampIdx(track.idxAt(nowS + Math.min(8.5, 2.0 + v * 0.08)));
    const capExit = Math.max(capNow, Math.min(cap[exitLookIdx], envLight));
    // 油门死区：贴着限速时逐帧 on/off 会让加速度在 +1.6 / −4.2 之间反复跳（速度表看着像在掉速）
    const upCeil = Math.min(maxAsphaltV, capExit);
    const upOut = Boolean(brakeOut === 0 && v < upCeil + (st.wasUp ? 0.20 : -0.02));
    st.wasUp = upOut;

    st.lastSteer = Number.isFinite(steer) ? steer : 0;
    out.steer = st.lastSteer;
    out.brake = (brakeOut === 2 || brakeOut === 1) ? brakeOut : 0;
    out.up = upOut;
    out.left = out.steer < -0.05;
    out.right = out.steer > 0.05;
    out.targetX = Number.isFinite(aimX) ? aimX : lineX[idxNow];
    out.targetY = Number.isFinite(aimY) ? aimY : lineY[idxNow];
    out.targetSpeed = Number.isFinite(envLight) ? envLight : capNow;
}
