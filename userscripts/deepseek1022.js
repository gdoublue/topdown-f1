/* ============================================================================
 * AGGRESSIVE DRIVER — 融合 1022_pm 最优规划 + gemini 出弯外抛
 * - 激进：99.3% 抓地利用 / 98.5% 制动利用 / 走廊贴路肩 / 过弯心立刻全油门
 * - 安全：走廊硬夹紧 + PD 修正 + 边界超速渗出（保证不出赛道）
 * ============================================================================ */

const CAR_LEN = typeof CAR_LENGTH !== "undefined" ? CAR_LENGTH : 5.6;
const CAR_WID = typeof CAR_WIDTH !== "undefined" ? CAR_WIDTH : 2.0;
const _modelCache = new Map();

function clampIdx(i, len) {
    if (!Number.isFinite(i)) return 0;
    const idx = i | 0;
    if (idx < 0) return 0;
    if (idx >= len) return len - 1;
    return idx;
}

function stepIndex(i, delta, len, closed) {
    if (!closed) return clamp(i + delta, 0, len - 1);
    const m = (i + delta) % len;
    return m < 0 ? m + len : m;
}

function calcAccelAt(perf, v) {
    if (perf && perf.powerKW != null) {
        const P = perf.powerKW * 1000;
        const m = perf.massKg != null ? perf.massKg : 2200;
        const vmaxNat = perf.naturalVmax != null
            ? perf.naturalVmax
            : (perf.maxSpeed ? perf.maxSpeed[0] : PHYS.maxSpeed[0]);
        const k = P / Math.max(1, m * vmaxNat * vmaxNat * vmaxNat);
        let a = P / (m * Math.max(v, 2)) - k * v * v;
        a = Math.min(a, perf.launchAccel != null ? perf.launchAccel : 14.0);
        return Math.max(a, 0);
    }
    const c = PHYS.accelCurve || [[0, 11.6], [28, 11.0], [56, 8.5], [78.4, 5.5], [100, 1.5]];
    let a = c[c.length - 1][1];
    for (let i = 1; i < c.length; i++) {
        if (v <= c[i][0]) {
            const v0 = c[i - 1][0], a0 = c[i - 1][1];
            a = a0 + (c[i][1] - a0) * (v - v0) / Math.max(1e-4, c[i][0] - v0);
            break;
        }
    }
    if (v > c[c.length - 1][0]) {
        a *= (perf && perf.highSpeedAccel != null ? perf.highSpeedAccel : 1.0);
    }
    return a * (perf && perf.accelMult != null ? perf.accelMult : 1.0);
}

function optimizeBiharmonicLine(off, cx, cy, cnx, cny, M, closed, cCorridor, iters, relax, cLam) {
    const XL = new Float64Array(M);
    const YL = new Float64Array(M);
    for (let i = 0; i < M; i++) {
        XL[i] = cx[i] + cnx[i] * off[i];
        YL[i] = cy[i] + cny[i] * off[i];
    }
    const isArrayLam = typeof cLam !== "number";
    for (let it = 0; it < iters; it++) {
        for (let i = 0; i < M; i++) {
            const a1 = stepIndex(i, -1, M, closed);
            const a2 = stepIndex(i, -2, M, closed);
            const b1 = stepIndex(i, 1, M, closed);
            const b2 = stepIndex(i, 2, M, closed);
            const txx = (4 * (XL[a1] + XL[b1]) - (XL[a2] + XL[b2])) / 6;
            const tyy = (4 * (YL[a1] + YL[b1]) - (YL[a2] + YL[b2])) / 6;
            const moB = (txx - cx[i]) * cnx[i] + (tyy - cy[i]) * cny[i];
            const mx = 0.5 * (XL[a1] + XL[b1]);
            const my = 0.5 * (YL[a1] + YL[b1]);
            const moM = (mx - cx[i]) * cnx[i] + (my - cy[i]) * cny[i];
            const lam = isArrayLam ? cLam[i] : cLam;
            const mo = lam * moB + (1 - lam) * moM;
            const prev = off[i];
            const lim = cCorridor[i];
            const nv = clamp(prev + relax * (mo - prev), -lim, lim);
            off[i] = nv;
            XL[i] = cx[i] + cnx[i] * nv;
            YL[i] = cy[i] + cny[i] * nv;
        }
    }
}

function buildOptimalTrackModel(points, corridorArr, blendMode, isLinearTrack) {
    const M_N = points.length;
    const px = new Float64Array(M_N), py = new Float64Array(M_N);
    for (let i = 0; i < M_N; i++) { px[i] = points[i].x; py[i] = points[i].y; }

    const closed = !isLinearTrack;
    const ds = new Float64Array(M_N);
    const sCum = new Float64Array(M_N + 1);
    for (let i = 0; i < M_N; i++) {
        const j = i + 1 < M_N ? i + 1 : (closed ? 0 : M_N - 1);
        ds[i] = (i + 1 < M_N || closed) ? Math.hypot(px[j] - px[i], py[j] - py[i]) : 0;
        sCum[i + 1] = sCum[i] + ds[i];
    }

    const tx = new Float64Array(M_N), ty = new Float64Array(M_N);
    const nx = new Float64Array(M_N), ny = new Float64Array(M_N);
    for (let i = 0; i < M_N; i++) {
        const a = stepIndex(i, -1, M_N, closed);
        const b = stepIndex(i, 1, M_N, closed);
        let dx = px[b] - px[a], dy = py[b] - py[a];
        const L = Math.hypot(dx, dy) || 1;
        dx /= L; dy /= L;
        tx[i] = dx; ty[i] = dy;
        nx[i] = -dy; ny[i] = dx;
    }

    const off = new Float64Array(M_N);
    const levels = isLinearTrack
        ? [{ k: 4, it: 80 }, { k: 1, it: 60 }]
        : [{ k: 8, it: 3800 }, { k: 4, it: 1400 }, { k: 2, it: 500 }, { k: 1, it: 500 }];

    for (let li = 0; li < levels.length; li++) {
        const k = levels[li].k;
        const M = k === 1 ? M_N : Math.max(24, Math.floor(M_N / k));
        if (M < 24 || (k > 1 && M >= M_N)) continue;
        const stride = M_N / M;
        const cx = new Float64Array(M), cy = new Float64Array(M);
        const cnx = new Float64Array(M), cny = new Float64Array(M);
        const cCorr = new Float64Array(M);
        const cidx = new Int32Array(M);
        for (let j = 0; j < M; j++) {
            const idx = stepIndex(Math.round(j * stride), 0, M_N, closed);
            cidx[j] = idx;
            cx[j] = px[idx]; cy[j] = py[idx];
            cCorr[j] = corridorArr[idx];
        }
        for (let j = 0; j < M; j++) {
            const a = stepIndex(j, -1, M, closed);
            const b = stepIndex(j, 1, M, closed);
            const dx = cx[b] - cx[a], dy = cy[b] - cy[a];
            const L = Math.hypot(dx, dy) || 1;
            cnx[j] = -dy / L; cny[j] = dx / L;
        }
        let cLam = blendMode;
        if (typeof blendMode !== "number") {
            cLam = new Float64Array(M);
            for (let j = 0; j < M; j++) cLam[j] = blendMode[cidx[j]];
        }
        const cOff = new Float64Array(M);
        for (let j = 0; j < M; j++) cOff[j] = off[cidx[j]];
        optimizeBiharmonicLine(cOff, cx, cy, cnx, cny, M, closed, cCorr, levels[li].it, 0.56, cLam);

        if (k === 1) {
            for (let i = 0; i < M_N; i++) off[i] = cOff[i];
        } else {
            for (let i = 0; i < M_N; i++) {
                const t = i / stride;
                const j0 = Math.floor(t);
                const f = t - j0;
                const a = stepIndex(j0, 0, M, closed);
                const b = stepIndex(j0, 1, M, closed);
                off[i] = cOff[a] + (cOff[b] - cOff[a]) * f;
            }
        }
    }

    const lx = new Float64Array(M_N), ly = new Float64Array(M_N);
    for (let i = 0; i < M_N; i++) { lx[i] = px[i] + nx[i] * off[i]; ly[i] = py[i] + ny[i] * off[i]; }

    const dsLine = new Float64Array(M_N);
    for (let i = 0; i < M_N; i++) {
        const j = i + 1 < M_N ? i + 1 : (closed ? 0 : M_N - 1);
        dsLine[i] = (i + 1 < M_N || closed) ? Math.hypot(lx[j] - lx[i], ly[j] - ly[i]) : 0;
    }

    const kap = new Float64Array(M_N);
    for (let i = 0; i < M_N; i++) {
        const a = stepIndex(i, -1, M_N, closed);
        const b = stepIndex(i, 1, M_N, closed);
        const v1x = lx[i] - lx[a], v1y = ly[i] - ly[a];
        const v2x = lx[b] - lx[i], v2y = ly[b] - ly[i];
        const v3x = lx[b] - lx[a], v3y = ly[b] - ly[a];
        const cross = v1x * v2y - v1y * v2x;
        const den = Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y) * Math.hypot(v3x, v3y);
        kap[i] = den > 1e-9 ? (2 * cross) / den : 0;
    }
    const ks = new Float64Array(M_N);
    for (let i = 0; i < M_N; i++) {
        const a = stepIndex(i, -1, M_N, closed);
        const b = stepIndex(i, 1, M_N, closed);
        ks[i] = 0.25 * kap[a] + 0.5 * kap[i] + 0.25 * kap[b];
    }

    let meanDs = 0;
    for (let i = 0; i < M_N; i++) meanDs += dsLine[i];
    meanDs = meanDs / Math.max(1, M_N);
    const kW = Math.max(1, Math.round(5.0 / Math.max(0.5, meanDs)));

    const kmax = new Float64Array(M_N);
    for (let i = 0; i < M_N; i++) {
        const a = stepIndex(i, -1, M_N, closed);
        const b = stepIndex(i, 1, M_N, closed);
        const ka = Math.abs(ks[a]), ki = Math.abs(ks[i]), kb = Math.abs(ks[b]);
        let k = kb >= ki
            ? Math.max(ki, kb, 0.7 * ka + 0.3 * ki)
            : Math.max(ki, kb, 0.35 * ka + 0.65 * ki);
        for (let s = 1; s <= kW; s++) {
            const kf = Math.abs(ks[stepIndex(i, s, M_N, closed)]);
            if (kf > k) k = kf;
        }
        kmax[i] = k;
    }

    return { N: M_N, px, py, tx, ty, nx, ny, ds, sCum, dsLine, closed, off, lx, ly, kap: ks, kmax, corridorArr };
}

/* ★ 激进版速度剖面：99.3% 抓地 / 98.5% 制动利用率 */
function computeOptimalSpeedProfile(model, perf, isLowPerf) {
    const M_N = model.N;
    const cornerGripMult = (perf && perf.cornerGripMult != null) ? perf.cornerGripMult : 1.0;
    const brakeMult = (perf && perf.brakeMult != null) ? perf.brakeMult : 1.0;
    const rawLatGrip = (perf && perf.latGrip != null) ? perf.latGrip : PHYS.latGrip;

    const baseGripUtil = isLowPerf
        ? clamp(0.945 + (brakeMult - 0.32) * 0.10, 0.945, 0.975)
        : 0.993;                                       // 激进：0.992 → 0.993
    const grip = rawLatGrip * Math.min(1.0, baseGripUtil * cornerGripMult);
    const maxOmega = ((perf && perf.maxOmega != null) ? perf.maxOmega : PHYS.maxOmega) * (isLowPerf ? 0.982 : 0.997);
    const vmax = (perf && perf.maxSpeed) ? perf.maxSpeed[0] : PHYS.maxSpeed[0];
    const brakeUtil = isLowPerf
        ? clamp(0.925 + (brakeMult - 0.32) * 0.08, 0.925, 0.955)
        : 0.985;                                       // 激进：0.968 → 0.985（更晚刹车）
    const brake = Math.max(1.0, PHYS.brake * brakeMult * brakeUtil);

    const v = new Float64Array(M_N);
    const vCornerPure = new Float64Array(M_N);
    for (let i = 0; i < M_N; i++) {
        const k = model.kmax[i];
        let c = vmax;
        if (k > 1e-6) {
            const vGrip = Math.sqrt(grip / k);
            const vOmega = maxOmega / k;
            if (vGrip < c) c = vGrip;
            if (vOmega < c) c = vOmega;
        }
        v[i] = c;
        vCornerPure[i] = c;
    }

    const passes = model.closed ? 3 : 2;
    for (let pass = 0; pass < passes; pass++) {
        for (let i = M_N - 1; i >= 0; i--) {
            const j = i + 1 < M_N ? i + 1 : (model.closed ? 0 : -1);
            if (j < 0) continue;
            const d = model.dsLine[i];
            if (d <= 0) continue;
            const kHere = model.kmax[i];
            let effBrake = brake;
            if (isLowPerf && kHere > 0.0025) {
                effBrake = brake * clamp(1.0 - (kHere - 0.0025) * 28.0, 0.72, 1.0);
            } else if (kHere > 0.0055) {
                effBrake = brake * clamp(1.0 - (kHere - 0.0055) * 8.0, 0.91, 1.0);
            }
            const lim = Math.sqrt(v[j] * v[j] + 2 * effBrake * d);
            if (lim < v[i]) {
                v[i] = lim;
                if (isLowPerf && kHere > 0.0032 && lim < vCornerPure[i] - 0.8) {
                    const fcCap = vCornerPure[i] * clamp(0.94 - (kHere - 0.0032) * 8.0, 0.86, 0.94);
                    v[i] = Math.min(v[i], Math.max(v[j], fcCap));
                }
            }
        }
        for (let i = 0; i < M_N; i++) {
            const j = i + 1 < M_N ? i + 1 : (model.closed ? 0 : -1);
            if (j < 0) continue;
            const d = model.dsLine[i];
            if (d <= 0) continue;
            const a = calcAccelAt(perf, v[i]);
            const lim = Math.sqrt(v[i] * v[i] + 2 * a * d);
            if (lim < v[j]) v[j] = lim;
        }
    }

    let lapTime = 0;
    for (let i = 0; i < M_N; i++) lapTime += model.dsLine[i] / Math.max(v[i], 5);
    return { v, vCornerPure, lapTime, vmax, brake };
}

/* ★ 激进版走廊：贴近路肩 */
function ensureOptimalModel(car) {
    const perf = car.perf || {};
    const tid = (typeof track !== "undefined" && track.id) ? track.id : N;
    const isLinearTrack = Boolean(typeof track !== "undefined" && track.isLinear);
    const brakeMult = perf.brakeMult != null ? perf.brakeMult : 1.0;
    const latGrip = perf.latGrip != null ? perf.latGrip : PHYS.latGrip;
    const isLowPerf = brakeMult < 0.72 || latGrip < 26.0;

    const cacheKey = `${tid}_${N}_${latGrip}_${perf.maxOmega || 0}_${brakeMult}_${perf.accelMult || 1}_${perf.powerKW || 0}_${perf.cornerGripMult || 1}_AGG`;
    const cached = _modelCache.get(cacheKey);
    if (cached && cached.ptsRef === pts) return cached;
    if (_modelCache.size > 16) _modelCache.clear();

    const kerbArr = (typeof track !== "undefined" && track.kerbFlag) ? track.kerbFlag : null;
    const corridorArr = new Float64Array(N);
    const adaptiveLam = new Float64Array(N);

    for (let i = 0; i < N; i++) {
        const halfW = (typeof hw !== "undefined" && hw[i]) ? hw[i] : 7.0;
        const hasKerb = kerbArr && kerbArr[i] === 1;
        if (isLowPerf) {
            // 激进：2.12/2.32 → 1.90/2.10
            corridorArr[i] = clamp(halfW - (hasKerb ? 1.90 : 2.10), 3.2, 4.5);
        } else {
            // 激进：1.72/1.98 → 1.55/1.75（仍保留 ≥0.55m 车身边缘余量）
            corridorArr[i] = clamp(halfW - (hasKerb ? 1.55 : 1.75), 3.8, 5.3);
        }
        const cAbs = (typeof curvS !== "undefined") ? Math.abs(curvS[i]) : 0;
        adaptiveLam[i] = cAbs > 0.015 ? 0.76 : (cAbs > 0.008 ? 0.88 : 1.0);
    }

    const candidates = isLinearTrack ? [1.0] : [1.0, 0.88, 0.76, 0.66, adaptiveLam];
    let bestModel = null, bestProfile = null;
    for (let c = 0; c < candidates.length; c++) {
        const m = buildOptimalTrackModel(pts, corridorArr, candidates[c], isLinearTrack);
        const pr = computeOptimalSpeedProfile(m, perf, isLowPerf);
        if (!bestProfile || pr.lapTime < bestProfile.lapTime) {
            bestModel = m;
            bestProfile = pr;
        }
    }

    const entry = { model: bestModel, prof: bestProfile, ptsRef: pts, trackId: tid, isLowPerf };
    _modelCache.set(cacheKey, entry);
    return entry;
}

function latOfCar(o, model) {
    const i = clampIdx(o.nearIdx != null ? o.nearIdx : 0, model.N);
    return (o.x - model.px[i]) * model.nx[i] + (o.y - model.py[i]) * model.ny[i];
}

function advanceIdxByMeters(model, startIdx, distM) {
    const M_N = model.N;
    let cur = clampIdx(startIdx, M_N);
    let rem = Math.max(0, distM);
    for (let s = 0; s < M_N; s++) {
        const seg = Math.max(0.2, model.ds[cur]);
        if (rem <= seg || (!model.closed && cur >= M_N - 1)) break;
        rem -= seg;
        cur = stepIndex(cur, 1, M_N, model.closed);
    }
    return cur;
}

function findNextApex(model, prof, idx, maxDist) {
    const M_N = model.N;
    let bestV = Infinity, best = null, acc = 0;
    for (let k = 1; k < M_N; k++) {
        const prev = stepIndex(idx, k - 1, M_N, model.closed);
        if (!model.closed && prev >= M_N - 1) break;
        acc += model.ds[prev];
        if (acc > maxDist) break;
        const j = stepIndex(idx, k, M_N, model.closed);
        if (prof.v[j] < bestV) {
            bestV = prof.v[j];
            best = { idx: j, dist: acc, off: model.off[j], v: bestV };
        }
    }
    if (!best || bestV > prof.vmax * 0.86) return null;
    return best;
}

/* ============================================================================
 * 主驱动
 * ============================================================================ */
function driver(car, out, dt, otherCars) {
    const safeDt = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.05) : 1 / 60;
    const { model, prof, trackId, isLowPerf } = ensureOptimalModel(car);
    const M_N = model.N;
    const idx = clampIdx(car.nearIdx != null ? car.nearIdx : track.idxAt(car.trackS || 0), M_N);
    const v = Number.isFinite(car.speed) ? Math.abs(car.speed) : 0;
    const perf = car.perf || {};
    const latGrip = perf.latGrip != null ? perf.latGrip : PHYS.latGrip;
    const maxOmega = perf.maxOmega != null ? perf.maxOmega : PHYS.maxOmega;
    const brakeFull = Math.max(1.0, PHYS.brake * (perf.brakeMult != null ? perf.brakeMult : 1.0));
    const lightA = brakeFull * PHYS.lightBrakeFactor;

    if (car._toState == null || car._toState.trackId !== trackId) {
        car._toState = {
            trackId, extra: 0, stuck: 0, rev: 0, revSteer: 0, moved: false,
            lockedLat: null, lockTimer: 0, lingering: 0, abortCool: 0, blockT: 0,
            lastExit: 0
        };
    }
    const st = car._toState;

    /* ---- 1) 脱困倒车 ---- */
    if (st.rev > 0) {
        st.rev -= safeDt;
        out.up = false; out.brake = 2;
        out.steer = Number.isFinite(st.revSteer) ? st.revSteer : 0;
        out.left = out.steer < -0.02;
        out.right = out.steer > 0.02;
        out.targetX = model.px[idx]; out.targetY = model.py[idx]; out.targetSpeed = 0;
        return;
    }
    if (st.moved && !car.finished) {
        if (v < 1.1) st.stuck += safeDt;
        else st.stuck = Math.max(0, st.stuck - safeDt * 2.2);
        if (st.stuck > 1.9) {
            const eNow = latOfCar(car, model);
            st.rev = 0.82;
            st.revSteer = clamp(Math.sign(eNow) * 0.65, -1, 1);
            st.stuck = 0;
            out.up = false; out.brake = 2; out.steer = st.revSteer;
            out.left = out.steer < -0.02; out.right = out.steer > 0.02;
            out.targetX = model.px[idx]; out.targetY = model.py[idx]; out.targetSpeed = 0;
            return;
        }
    } else if (v > 3.8) {
        st.moved = true;
    }

    const j1 = stepIndex(idx, 1, M_N, model.closed);
    const j2 = stepIndex(idx, 2, M_N, model.closed);
    const isExitingCornerPlan = (prof.v[j1] > prof.v[idx] + 0.03) &&
        (Math.abs(model.kap[j1]) <= Math.abs(model.kap[idx]) * 1.03);

    /* ---- 2) ★ 弯道相位识别（gemini 方法，用于激进出弯） ---- */
    const tIdx = ((idx % N) + N) % N;
    const dsLocal = (typeof DS !== "undefined" && DS > 0.1) ? DS : Math.max(0.5, model.ds[idx] || 1.0);
    const cSigned = (typeof curvS !== "undefined" && curvS[tIdx] != null) ? curvS[tIdx] : model.kap[idx];
    const curvHere = Math.abs(cSigned);
    const cSign = Math.sign(cSigned);
    const inCorner = curvHere > 0.007;

    const step12 = Math.max(1, Math.round(12 / dsLocal));
    const step24 = Math.max(2, Math.round(24 / dsLocal));
    const step68 = Math.max(4, Math.round(68 / dsLocal));
    const curvAt = (k) => {
        const q = (tIdx + k) % N;
        return (typeof curvS !== "undefined" && curvS[q] != null) ? curvS[q] : model.kap[q % M_N];
    };
    const curv12 = Math.abs(curvAt(step12));
    const curv24 = Math.abs(curvAt(step24));
    const isPastApex = inCorner && (curv12 < curvHere * 0.93) && (curv24 <= curv12 * 1.05);

    let hasNextReverseCorner = false, hasNextTightCorner = false, nextReverseSign = 0;
    if (inCorner) {
        for (let s = step12; s <= step68; s += 2) {
            const futC = curvAt(s);
            if (cSign !== 0 && cSign * futC < -0.0055) {
                hasNextReverseCorner = true; nextReverseSign = Math.sign(futC); break;
            }
            if (s > step24 && Math.abs(futC) > Math.max(curvHere * 0.95, 0.011)) {
                hasNextTightCorner = true;
            }
        }
    }
    const isIsolatedExit = isPastApex && !hasNextReverseCorner && !hasNextTightCorner;
    const exitProgress = isIsolatedExit ? clamp(1.0 - (curv24 / Math.max(curvHere, 1e-4)), 0.25, 1.0) : 0;
    st.lastExit = exitProgress;

    const carLatNow = latOfCar(car, model);
    const baseLat = model.off[idx];
    const vLatCar = v * (Math.cos(car.angle) * model.nx[idx] + Math.sin(car.angle) * model.ny[idx]);

    /* ---- 3) 全向感知（保留 1022_pm 双帧预测） ---- */
    let extraTarget = 0, followCap = Infinity, emergency = false, guardSteer = 0;
    let directLead = null, directLeadS = Infinity, closePursuer = null;
    const GAP_ADD = 0.75;                 // 激进：0.95 → 0.75（跟得更近）
    const SAFE_SEP = 2.42;                // 激进：2.48 → 2.42
    const INSIDE_BONUS = 3.2;             // 激进：2.8 → 3.2
    const ABORT_TIME = 1.6;

    if (otherCars && otherCars.length > 1) {
        const ca = Math.cos(car.angle), sa = Math.sin(car.angle);
        const apex = findNextApex(model, prof, idx, Math.max(95, v * 1.6));
        const sharpCorner = apex ? Math.abs(model.kmax[apex.idx]) > 0.011 : false;

        const nbs = [];
        for (let i = 0; i < otherCars.length; i++) {
            const o = otherCars[i];
            if (!o || o === car) continue;
            const geo = (typeof getCarDistance === "function") ? getCarDistance(car, o) : null;
            const dx = o.x - car.x, dy = o.y - car.y;
            const sLon = (geo && Number.isFinite(geo.sLon)) ? geo.sLon : (dx * ca + dy * sa);
            const dLat = (geo && Number.isFinite(geo.dLat)) ? geo.dLat : (-dx * sa + dy * ca);
            if (sLon < -70 || sLon > Math.max(72, v * 1.65)) continue;

            const oIdx = clampIdx(o.nearIdx != null ? o.nearIdx : 0, M_N);
            const oLat = latOfCar(o, model);
            const oV = Math.abs(o.speed || 0);
            const oVLat = (o.speed || 0) * (Math.cos(o.angle) * model.nx[oIdx] + Math.sin(o.angle) * model.ny[oIdx]);
            const predT = clamp(Math.abs(sLon) / Math.max(v, 15), 0.12, 0.42);
            const oPredLat = oLat + oVLat * predT + (o.inSteer || 0) * 0.85 * predT;
            const oBraking = (o.inBrake > 0) || ((o.accel || 0) < -4.5);

            const dnNow = oLat - model.off[oIdx];
            const dnPred = oPredLat - model.off[oIdx];
            const oFutureIdx = advanceIdxByMeters(model, oIdx, clamp(oV * 0.45, 6, 26));
            const dnFutureCenter = clamp(oPredLat, -model.corridorArr[oFutureIdx], model.corridorArr[oFutureIdx]) - model.off[oFutureIdx];
            const dnConv = (apex && sLon > 0 && sLon < apex.dist + 15) ? dnPred * 0.35 : dnPred;
            const dnMin = Math.min(dnNow, dnPred, dnConv, (apex && sLon < apex.dist + 12) ? dnFutureCenter : dnPred);
            const dnMax = Math.max(dnNow, dnPred, dnConv, (apex && sLon < apex.dist + 12) ? dnFutureCenter : dnPred);

            const oIdxAhead1 = advanceIdxByMeters(model, oIdx, 12);
            const oIdxAhead2 = advanceIdxByMeters(model, oIdx, 26);
            const oCornerV = Math.min(prof.v[oIdx], prof.v[oIdxAhead1], prof.v[oIdxAhead2]) * 0.89;

            const nb = { o, sLon, dLat, oIdx, oLat, oPredLat, oBraking, v: oV, oVLat, dnNow, dnPred, dnMin, dnMax, oCornerV };
            nbs.push(nb);

            const onSameTube = Math.abs(dLat) < CAR_WID + 0.55 ||
                Math.abs((carLatNow - baseLat) - dnNow) < CAR_WID + 0.55 ||
                (st.extra >= dnMin - (CAR_WID + 0.45) && st.extra <= dnMax + (CAR_WID + 0.45));
            if (sLon > 0 && sLon < 58 && onSameTube && sLon < directLeadS) {
                directLeadS = sLon; directLead = nb;
            }
            if (sLon <= -CAR_LEN * 0.85 && sLon > -20 && (oV > v - 1.0 || sLon > -12)) {
                if (!closePursuer || sLon > closePursuer.sLon) closePursuer = nb;
            }
        }

        const blocked = !!(directLead && directLead.sLon < 20 &&
            (v > directLead.v - 0.5 || prof.v[idx] > directLead.v + 1.2 || directLead.oBraking));
        st.blockT = blocked ? (st.blockT || 0) + safeDt : Math.max(0, (st.blockT || 0) - safeDt * 2);

        for (let k = 0; k < nbs.length; k++) {
            const nb = nbs[k];
            if (Math.abs(nb.sLon) < CAR_LEN + 1.8 && Math.abs(nb.dLat) < CAR_WID + 1.35) {
                const pen = (CAR_WID + 1.35) - Math.abs(nb.dLat);
                const push = clamp(pen / 1.35, 0, 1) * 0.24;
                guardSteer += (nb.dLat >= 0 ? -push : push);
            }
        }

        const HARD_LAT_SEP = CAR_WID + 0.24;
        const limHere = model.corridorArr[idx] + (isLowPerf ? 0.10 : 0.30);
        const minLat = -limHere, maxLat = limHere;

        st.lockTimer = Math.max(0, (st.lockTimer || 0) - safeDt);
        if (st.lockTimer === 0) st.lockedLat = null;

        let bestCand = baseLat;
        if (nbs.length > 0) {
            let bestScore = -1e9;
            const canDefend = !!(closePursuer && !directLead && !isExitingCornerPlan);

            for (let c = minLat; c <= maxLat + 0.001; c += 0.36) {
                const cLat = clamp(c, minLat, maxLat);
                const candExtra = cLat - baseLat;
                let score = 0;
                score -= Math.abs(candExtra) * (sharpCorner ? 1.65 : 0.72);
                score -= Math.abs(cLat - carLatNow) * 0.58;
                if (st.lockedLat !== null && Math.abs(cLat - st.lockedLat) < 1.0) score += 2.85;

                if (directLead && apex) {
                    const inside = -Math.sign(apex.off);
                    const leadOnInside = (directLead.oPredLat * inside) > 1.2;
                    if (!leadOnInside && candExtra * inside > 0.05) score += INSIDE_BONUS;
                    else if (leadOnInside && directLead.oBraking && (cLat - directLead.oPredLat) * inside < -1.4) score += INSIDE_BONUS * 0.85;
                }
                if (canDefend) {
                    if (apex && apex.dist < 65 && closePursuer.sLon > -18) {
                        const inside = -Math.sign(apex.off);
                        const defLat = clamp(baseLat + inside * 1.85, minLat, maxLat);
                        const dDef = Math.abs(cLat - defLat);
                        if (dDef < 1.6) score += (1.6 - dDef) * 1.8;
                    } else if (!sharpCorner && closePursuer.sLon > -15 && Math.abs(closePursuer.oPredLat - baseLat) < 2.1) {
                        const dShadow = Math.abs(cLat - closePursuer.oPredLat);
                        if (dShadow < 1.3) score += (1.3 - dShadow) * 1.9;
                    }
                }
                for (let k = 0; k < nbs.length; k++) {
                    const nb = nbs[k];
                    const latDistCenter = Math.min(Math.abs(cLat - nb.oLat), 0.75 * Math.abs(cLat - nb.oPredLat) + 0.25 * Math.abs(cLat - nb.oLat));
                    const latDistTube = Math.min(Math.abs(candExtra - nb.dnNow), Math.abs(candExtra - nb.dnPred));
                    const inEntrySweep = candExtra >= nb.dnMin - (CAR_WID + 0.35) && candExtra <= nb.dnMax + (CAR_WID + 0.35);
                    if (nb.sLon > -CAR_LEN - 1.5 && nb.sLon < CAR_LEN + 2.5) {
                        const nearDist = Math.min(Math.abs(cLat - nb.oLat), Math.abs(candExtra - nb.dnNow));
                        if (nearDist < HARD_LAT_SEP) score -= 5000 + (HARD_LAT_SEP - nearDist) * 2000;
                        else if (nearDist < SAFE_SEP + 0.4) score -= (SAFE_SEP + 0.4 - nearDist) * 18;
                        if ((nb.oLat > carLatNow && cLat > nb.oLat - HARD_LAT_SEP * 0.8) ||
                            (nb.oLat < carLatNow && cLat < nb.oLat + HARD_LAT_SEP * 0.8)) score -= 8000;
                    } else if (nb.sLon >= CAR_LEN + 2.5 && nb.sLon < 56) {
                        const brakeBonus = nb.oBraking ? 5.0 : (nb.oCornerV < nb.v - 3.0 ? 3.5 : 0);
                        const closing = v - nb.v + (prof.v[idx] - nb.v) * 0.45 + brakeBonus;
                        const effLatDist = Math.min(latDistCenter, latDistTube);
                        if (effLatDist < SAFE_SEP || (inEntrySweep && closing > 0.5)) {
                            const pw = clamp((56 - nb.sLon) / 42, 0.25, 1.65);
                            const sw = clamp(closing / 7.5, 0.35, 2.8);
                            const ov = clamp((SAFE_SEP - Math.min(effLatDist, SAFE_SEP * 0.85)) / SAFE_SEP, 0.2, 1.0);
                            score -= 38 * pw * sw * ov;
                            if (nb.sLon < 16 && closing > 1.0) score -= 52 * ov;
                        } else if (nb.sLon < 28 && closing > 0.8 && effLatDist < SAFE_SEP + 1.35) {
                            score += 3.6;
                        }
                    } else if (nb.sLon <= -CAR_LEN - 1.5 && nb.sLon > -70) {
                        const rearGap = Math.max(0.2, -nb.sLon - CAR_LEN);
                        const myDecel = prof.v[idx] < v - 3 ? 8.5 : 0;
                        const rearClosing = (nb.v - v) + myDecel;
                        if (rearClosing > 1.5) {
                            const ttc = rearGap / rearClosing;
                            if (ttc < 2.0 && latDistCenter < SAFE_SEP) {
                                const urgency = clamp((2.0 - ttc) / 1.5, 0.2, 2.5);
                                const ov = (SAFE_SEP - latDistCenter) / SAFE_SEP;
                                score -= 55 * urgency * ov;
                            }
                        }
                    }
                }
                if (score > bestScore) { bestScore = score; bestCand = cLat; }
            }
        }

        // ★ 激进出弯外抛（仅当没有直接前车阻挡时）
        if (isIsolatedExit && cSign !== 0 && !directLead) {
            const outerSign = -cSign;
            const edge = limHere * 0.92;
            const desired = outerSign * edge;
            const blend = 0.45 * exitProgress;
            bestCand = clamp(bestCand * (1 - blend) + desired * blend, minLat, maxLat);
        }

        if (Math.abs(bestCand - baseLat) > 0.85 && Math.abs(bestCand - (st.lockedLat != null ? st.lockedLat : 999)) > 0.75) {
            st.lockedLat = bestCand; st.lockTimer = 1.55;
        }

        st.abortCool = Math.max(0, (st.abortCool || 0) - safeDt);
        if (directLead) {
            const offLine = Math.abs(st.extra) > 1.5;
            const stillBehind = directLead.sLon > 3;
            const notFaster = !(v > directLead.v + 1.8 || prof.v[idx] > directLead.v + 1.8);
            st.lingering = (offLine && stillBehind && notFaster) ? (st.lingering || 0) + safeDt : 0;
            if (st.lingering > ABORT_TIME) { st.abortCool = 1.1; st.lingering = 0; }
        } else { st.lingering = 0; }
        if (st.abortCool > 0) bestCand = baseLat;

        extraTarget = clamp(bestCand - baseLat, -5.2, 5.2);

        // 全范围预测式防追尾速度包络
        for (let k = 0; k < nbs.length; k++) {
            const nb = nbs[k];
            if (nb.sLon <= 0) continue;
            const gap = nb.sLon - CAR_LEN;
            const closing = v - nb.v;
            const bodyOverlapNow = Math.abs(nb.dLat) < CAR_WID + 0.36 || Math.abs(carLatNow - nb.oLat) < CAR_WID + 0.36;
            if (gap < 1.15 && closing > 0.4 && Math.abs(nb.dLat) < CAR_WID + 0.32) emergency = true;
            if (bodyOverlapNow && gap < closing * 0.26 + 0.9 && closing > 3.5) emergency = true;

            const targetOverlapTube =
                Math.abs(extraTarget - nb.dnNow) < SAFE_SEP * 0.92 ||
                Math.abs(extraTarget - nb.dnPred) < SAFE_SEP * 0.92 ||
                Math.abs(bestCand - nb.oPredLat) < SAFE_SEP * 0.92 ||
                (apex && nb.sLon < apex.dist + 10 && extraTarget >= nb.dnMin - CAR_WID && extraTarget <= nb.dnMax + CAR_WID);
            const pullOutNotClearYet = bodyOverlapNow && gap < Math.max(3.6, closing * 0.32);

            if (targetOverlapTube || pullOutNotClearYet) {
                const oppBrakeDrop = nb.o.inBrake === 2 ? 2.2 : (nb.oBraking ? 1.1 : 0);
                const oppEffV = Math.max(0, nb.v - oppBrakeDrop);
                const dynMargin = GAP_ADD + (nb.oBraking ? 1.1 : 0.3) + (apex && nb.sLon < apex.dist + 15 ? 0.6 : 0);
                const safeGap = Math.max(0.18, gap - dynMargin);
                let cap = Math.sqrt(oppEffV * oppEffV + 2 * brakeFull * 0.88 * safeGap);
                if (targetOverlapTube && nb.oCornerV < oppEffV - 1.5 && gap < 48) {
                    const cqGap = Math.max(0.18, gap + 10.5 - dynMargin);
                    const cc = Math.sqrt(nb.oCornerV * nb.oCornerV + 2 * brakeFull * 0.88 * cqGap);
                    if (cc < cap) cap = cc;
                }
                if (cap < followCap) followCap = cap;
            }
        }
    }

    const rate = Math.abs(extraTarget) > Math.abs(st.extra) ? 9.0 : 5.2;
    st.extra += clamp(extraTarget - st.extra, -rate * safeDt, rate * safeDt);

    /* ---- 4) 纵向目标速度（★ 出口速度提升） ---- */
    const dxSeg = car.x - model.px[idx], dySeg = car.y - model.py[idx];
    const sProj = clamp((dxSeg * model.tx[idx] + dySeg * model.ty[idx]) / Math.max(0.5, model.ds[idx]), 0, 1);

    let vt;
    if (prof.v[j1] < prof.v[idx]) {
        vt = prof.v[idx] + (prof.v[j1] - prof.v[idx]) * clamp(sProj + 0.35, 0, 1);
    } else {
        vt = Math.max(prof.v[idx], prof.v[idx] + (prof.v[j1] - prof.v[idx]) * clamp(sProj + 0.65, 0, 1));
        if (isExitingCornerPlan || isIsolatedExit) {
            const headErr = Math.abs(wrapAngle(Math.atan2(model.ty[j1], model.tx[j1]) - car.angle));
            if (headErr < 0.25) vt = Math.max(vt, 0.55 * prof.v[j1] + 0.45 * prof.v[j2]);
        }
    }
    if (isIsolatedExit) vt *= 1.0 + 0.05 * exitProgress;   // ★ 出口 1.05x 提速（保守，靠边界渗出兜底）

    const scanCapM = Math.max(240, (v * v) / (2 * brakeFull * 0.5) + 60);
    const scanSteps = Math.min(M_N - 2, Math.max(10, Math.round(scanCapM / Math.max(0.5, model.ds[idx]))));
    let aReq = 0, accD = 0;
    for (let s = 1; s <= scanSteps; s++) {
        accD += Math.max(0.2, model.dsLine[stepIndex(idx, s - 1, M_N, model.closed)]);
        const cap = prof.vCornerPure[stepIndex(idx, s, M_N, model.closed)];
        if (cap < v) {
            const need = (v * v - cap * cap) / (2 * accD);
            if (need > aReq) aReq = need;
        }
    }

    const offLineDist = Math.abs(carLatNow - model.off[idx]);
    const offDeadband = isLowPerf ? 1.20 : 1.70;
    if (offLineDist > offDeadband && !isExitingCornerPlan) {
        const offPen = isLowPerf ? 1.55 : 0.95;
        vt *= clamp(1 - (offLineDist - offDeadband) * model.kmax[idx] * offPen, isLowPerf ? 0.86 : 0.93, 1.0);
    }

    const trackErr = Math.abs(carLatNow - (model.off[idx] + st.extra));
    if (trackErr > 6.0) vt = Math.min(vt, 24);
    else if (trackErr > 4.2) vt = Math.min(vt, 55);
    else if (trackErr > 2.8) vt = Math.min(vt, 90);

    // ★ 边界速度渗出（最后防线：保证不出赛道）
    const hwNow = (typeof hw !== "undefined" && hw[idx]) ? hw[idx] : 7.0;
    const vOutward = Math.sign(carLatNow) * vLatCar;
    const predLatEdge = Math.abs(carLatNow + vLatCar * 0.28);
    const safeEdge = hwNow - (isLowPerf ? 2.20 : 1.95);
    const edgeExcess = predLatEdge - safeEdge;
    if (edgeExcess > 0 && vOutward > -0.3) {
        const urgency = clamp(edgeExcess / 0.85, 0, 1.5);
        const cap = Math.max(12.0, prof.vCornerPure[idx] * (1.0 - urgency * 0.24) - Math.max(0, vOutward) * 2.8);
        if (cap < vt) vt = cap;
    }

    if (followCap < vt) vt = followCap;

    /* ---- 5) 纯追踪 + 摩擦圆修正 ---- */
    const exitingForLook = isExitingCornerPlan || isIsolatedExit;
    const look = clamp((exitingForLook ? 5.0 : 4.5) + v * (exitingForLook ? 0.19 : 0.16), 5.0, 33);

    let rem = look, cur = idx;
    for (let step = 0; step < M_N; step++) {
        const segLen = Math.max(0.2, model.ds[cur]);
        if (rem <= segLen || (!model.closed && cur >= M_N - 1)) break;
        rem -= segLen; cur = stepIndex(cur, 1, M_N, model.closed);
    }
    const nextCur = stepIndex(cur, 1, M_N, model.closed);
    const frac = clamp(rem / Math.max(0.2, model.ds[cur]), 0, 1);

    const pxLook = model.px[cur] + (model.px[nextCur] - model.px[cur]) * frac;
    const pyLook = model.py[cur] + (model.py[nextCur] - model.py[cur]) * frac;
    const nxLook = model.nx[cur] + (model.nx[nextCur] - model.nx[cur]) * frac;
    const nyLook = model.ny[cur] + (model.ny[nextCur] - model.ny[cur]) * frac;
    const offLook = model.off[cur] + (model.off[nextCur] - model.off[cur]) * frac;
    const limLook = model.corridorArr[cur] + (isLowPerf ? 0.10 : 0.32);

    const extraScale = isIsolatedExit && Math.abs(extraTarget) < 0.2 ? 0.65 : 1.0;
    const latTarget = clamp(offLook + st.extra * extraScale, -limLook, limLook);
    const tx = pxLook + nxLook * latTarget;
    const ty = pyLook + nyLook * latTarget;

    const alpha = wrapAngle(Math.atan2(ty - car.y, tx - car.x) - car.angle);
    const dist = Math.max(Math.hypot(tx - car.x, ty - car.y), 1.0);
    const kappa = (2 * Math.sin(alpha)) / dist;

    /* ---- 6) 制动 & 油门（★ 激进出弯弹射） ---- */
    const heavyTh = Math.max(lightA * 1.02, brakeFull * 1.00);
    let brakeCmd = 0;
    if (emergency) brakeCmd = 2;
    else if (aReq > heavyTh) brakeCmd = 2;
    else if (v > vt + 0.90 && !isExitingCornerPlan) brakeCmd = 1;

    const plannedLongA = brakeCmd === 2 ? brakeFull : (brakeCmd === 1 ? lightA : 0);
    const effLongA = Math.max(Math.abs(car.accel || 0), plannedLongA * 0.85);
    const usedLong = clamp(effLongA / brakeFull, 0, 1);
    const latFloor = PHYS.frictionLatFloor != null ? PHYS.frictionLatFloor : 0.6;
    const latAvail = latGrip * Math.sqrt(Math.max(latFloor, 1.0 - usedLong * usedLong));
    const surfScale = car.surf === 2 ? 0.74 : 1.0;
    const omegaMax = Math.min(maxOmega, latAvail / Math.max(v, 1.0)) * Math.min(1.0, v / 3.0) * surfScale;

    let steer = omegaMax > 1e-5 ? clamp((v * kappa) / omegaMax, -1, 1) : 0;

    // 横向误差 PD（防漂出赛道）
    const latErrSigned = carLatNow - (model.off[idx] + st.extra);
    const latCorr = clamp(-(latErrSigned * 0.12 + vLatCar * 0.08), -0.32, 0.32);
    steer = clamp(steer + latCorr, -1, 1);

    if (edgeExcess > 0) {
        const pull = -Math.sign(carLatNow) * clamp(edgeExcess * 0.35, 0, 0.42);
        steer = clamp(steer + pull, -1, 1);
    } else {
        steer = clamp(steer + clamp(guardSteer, -0.30, 0.30), -1, 1);
    }

    // 边角打滑急救：把重刹降为轻刹
    if (!emergency && brakeCmd === 2 && Math.abs(steer) > 0.84 && edgeExcess > -0.15 && v < vt + 3.5) {
        brakeCmd = 1;
    }
    if (v < 0.55 && brakeCmd === 2) brakeCmd = 1;

    // Trail-Braking 油门重叠（激进阈值）
    const trailOpen = brakeCmd === 1 && Math.abs(steer) > 0.10 && Math.abs(steer) < 0.70
        && Math.abs(alpha) < 0.36 && v < vt + 0.8;

    // ★★ 过弯心全油门弹射（gemini 核心，车头已指向出弯方向时）
    let upCmd = Boolean(!emergency && (brakeCmd === 0 ? v < vt - 0.02 : trailOpen));
    if (isIsolatedExit && brakeCmd <= 1 && v < vt * 1.02 && Math.abs(alpha) < 0.30) {
        brakeCmd = 0;
        upCmd = true;
    }

    out.steer = Number.isFinite(steer) ? steer : 0;
    out.brake = (brakeCmd === 2 || brakeCmd === 1) ? brakeCmd : 0;
    out.up = upCmd;
    out.left = out.steer < -0.02;
    out.right = out.steer > 0.02;
    out.targetX = Number.isFinite(tx) ? tx : model.px[idx];
    out.targetY = Number.isFinite(ty) ? ty : model.py[idx];
    out.targetSpeed = Number.isFinite(vt) ? vt : prof.v[idx];
}
