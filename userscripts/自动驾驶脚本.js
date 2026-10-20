// =====================================================================
// Topdown F1 · 终极时间最优自动驾驶 (Biharmonic Time-Optimal + 攻防博弈增强版)
// 直接粘贴至游戏内置「🤖 自动驾驶」编辑器即可运行
// =====================================================================

const CAR_LEN = typeof CAR_LENGTH !== 'undefined' ? CAR_LENGTH : 5.6;
const CAR_WID = typeof CAR_WIDTH !== 'undefined' ? CAR_WIDTH : 2.0;

/** 1. 满油门纵向加速度精确模型（兼容燃油车曲线与电车功率模型） */
function calcAccelAt(perf, v) {
    if (perf && perf.powerKW != null) {
        const P = perf.powerKW * 1000;
        const m = perf.massKg != null ? perf.massKg : 2200;
        const vmaxNat = perf.naturalVmax != null ? perf.naturalVmax
            : (perf.maxSpeed ? perf.maxSpeed[0] : PHYS.maxSpeed[0]);
        const k = P / (m * vmaxNat * vmaxNat * vmaxNat);
        let a = P / (m * Math.max(v, 2)) - k * v * v;
        a = Math.min(a, perf.launchAccel != null ? perf.launchAccel : 14.0);
        return Math.max(a, 0);
    }
    const c = PHYS.accelCurve || [[0, 11.6], [28, 11.0], [56, 8.5], [78.4, 5.5], [100, 1.5]];
    let a = c[c.length - 1][1];
    for (let i = 1; i < c.length; i++) {
        if (v <= c[i][0]) {
            const v0 = c[i - 1][0], a0 = c[i - 1][1];
            a = a0 + (c[i][1] - a0) * (v - v0) / (c[i][0] - v0);
            break;
        }
    }
    if (v > c[c.length - 1][0]) a *= (perf && perf.highSpeedAccel != null ? perf.highSpeedAccel : 1.0);
    return a * (perf && perf.accelMult != null ? perf.accelMult : 1.0);
}

/** 2. 欧拉-拉格朗日双调和方程松弛求解器（支持逐点动态路宽走廊 cCorridor 与逐点混合比 cLam） */
function optimizeBiharmonicLine(off, cx, cy, cnx, cny, M, closed, cCorridor, iters, relax, cLam) {
    const XL = new Float64Array(M), YL = new Float64Array(M);
    for (let i = 0; i < M; i++) {
        XL[i] = cx[i] + cnx[i] * off[i];
        Y_INIT: YL[i] = cy[i] + cny[i] * off[i];
    }
    const at = (i) => closed ? ((i % M) + M) % M : clamp(i, 0, M - 1);
    const isArrayLam = typeof cLam !== 'number';

    for (let it = 0; it < iters; it++) {
        for (let i = 0; i < M; i++) {
            const a1 = at(i - 1), a2 = at(i - 2), b1 = at(i + 1), b2 = at(i + 2);
            // 最小曲率项（四阶差分：外-内-外）
            const txx = (4 * (XL[a1] + XL[b1]) - (XL[a2] + XL[b2])) / 6;
            const tyy = (4 * (YL[a1] + YL[b1]) - (YL[a2] + YL[b2])) / 6;
            const moB = (txx - cx[i]) * cnx[i] + (tyy - cy[i]) * cny[i];

            // 最短路径项（二阶中点：贴内侧）
            const mx = 0.5 * (XL[a1] + XL[b1]), my = 0.5 * (YL[a1] + YL[b1]);
            const moM = (mx - cx[i]) * cnx[i] + (my - cy[i]) * cny[i];

            const lam = isArrayLam ? cLam[i] : cLam;
            const mo = lam * moB + (1 - lam) * moM;
            const prev = off[i];
            let nv = prev + relax * (mo - prev);
            const lim = cCorridor[i];
            if (nv < -lim) nv = -lim;
            else if (nv > lim) nv = lim;
            off[i] = nv;
            XL[i] = cx[i] + cnx[i] * nv;
            YL[i] = cy[i] + cny[i] * nv;
        }
    }
}

/** 3. 多尺度赛道模型构建（融合逐点 hw[i]、路缘石 kerbFlag 与真实赛车线弧长 dsLine） */
function buildOptimalTrackModel(points, corridorArr, blendMode) {
    const M_N = points.length;
    const px = new Float64Array(M_N), py = new Float64Array(M_N);
    for (let i = 0; i < M_N; i++) { px[i] = points[i].x; py[i] = points[i].y; }

    const closed = (typeof track !== 'undefined' && track.isLinear != null)
        ? !track.isLinear
        : (Math.hypot(px[0] - px[M_N - 1], py[0] - py[M_N - 1]) < 60);

    const ds = new Float64Array(M_N);
    for (let i = 0; i < M_N; i++) {
        const j = i + 1 < M_N ? i + 1 : (closed ? 0 : M_N - 1);
        ds[i] = (i + 1 < M_N || closed) ? Math.hypot(px[j] - px[i], py[j] - py[i]) : 0;
    }

    const tx = new Float64Array(M_N), ty = new Float64Array(M_N);
    const nx = new Float64Array(M_N), ny = new Float64Array(M_N);
    for (let i = 0; i < M_N; i++) {
        const a = closed ? (i - 1 + M_N) % M_N : Math.max(0, i - 1);
        const b = closed ? (i + 1) % M_N : Math.min(M_N - 1, i + 1);
        let dx = px[b] - px[a], dy = py[b] - py[a];
        const L = Math.hypot(dx, dy) || 1;
        dx /= L; dy /= L;
        tx[i] = dx; ty[i] = dy;
        nx[i] = -dy; ny[i] = dx;
    }

    // 多尺度（8 -> 4 -> 2 -> 1）投影梯度松弛
    const off = new Float64Array(M_N);
    const levels = [
        { k: 8, it: 5500 },
        { k: 4, it: 1800 },
        { k: 2, it: 600 },
        { k: 1, it: 600 }
    ];

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
            let idx = Math.round(j * stride);
            idx = closed ? ((idx % M_N) + M_N) % M_N : clamp(idx, 0, M_N - 1);
            cidx[j] = idx;
            cx[j] = px[idx]; cy[j] = py[idx];
            cCorr[j] = corridorArr[idx];
        }
        for (let j = 0; j < M; j++) {
            const a = closed ? (j - 1 + M) % M : Math.max(0, j - 1);
            const b = closed ? (j + 1) % M : Math.min(M - 1, j + 1);
            const dx = cx[b] - cx[a], dy = cy[b] - cy[a];
            const L = Math.hypot(dx, dy) || 1;
            cnx[j] = -dy / L; cny[j] = dx / L;
        }

        let cLam = blendMode;
        if (typeof blendMode !== 'number') {
            cLam = new Float64Array(M);
            for (let j = 0; j < M; j++) cLam[j] = blendMode[cidx[j]];
        }

        const cOff = new Float64Array(M);
        for (let j = 0; j < M; j++) cOff[j] = off[cidx[j]];
        optimizeBiharmonicLine(cOff, cx, cy, cnx, cny, M, closed, cCorr, levels[li].it, 0.55, cLam);

        if (k === 1) {
            for (let i = 0; i < M_N; i++) off[i] = cOff[i];
        } else {
            for (let i = 0; i < M_N; i++) {
                const t = i / stride;
                const j0 = Math.floor(t);
                const f = t - j0;
                const a = closed ? (j0 % M) : Math.min(j0, M - 1);
                const b = closed ? ((j0 + 1) % M) : Math.min(j0 + 1, M - 1);
                off[i] = cOff[a] + (cOff[b] - cOff[a]) * f;
            }
        }
    }

    const lx = new Float64Array(M_N), ly = new Float64Array(M_N);
    for (let i = 0; i < M_N; i++) {
        lx[i] = px[i] + nx[i] * off[i];
        ly[i] = py[i] + ny[i] * off[i];
    }

    // 计算赛车线真实逐段弧长 dsLine（修复中心线 ds 在急弯内侧与切线过渡区的长度失真）
    const dsLine = new Float64Array(M_N);
    for (let i = 0; i < M_N; i++) {
        const j = i + 1 < M_N ? i + 1 : (closed ? 0 : M_N - 1);
        dsLine[i] = (i + 1 < M_N || closed) ? Math.hypot(lx[j] - lx[i], ly[j] - ly[i]) : 0;
    }

    // Menger 曲率计算与方向自适应包络（入弯预留安全包络，出弯立即释放曲率限制）
    const kap = new Float64Array(M_N);
    for (let i = 0; i < M_N; i++) {
        const a = closed ? (i - 1 + M_N) % M_N : Math.max(0, i - 1);
        const b = closed ? (i + 1) % M_N : Math.min(M_N - 1, i + 1);
        const v1x = lx[i] - lx[a], v1y = ly[i] - ly[a];
        const v2x = lx[b] - lx[i], v2y = ly[b] - ly[i];
        const v3x = lx[b] - lx[a], v3y = ly[b] - ly[a];
        const cross = v1x * v2y - v1y * v2x;
        const den = Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y) * Math.hypot(v3x, v3y);
        kap[i] = den > 1e-9 ? (2 * cross) / den : 0;
    }
    const ks = new Float64Array(M_N);
    for (let i = 0; i < M_N; i++) {
        const a = closed ? (i - 1 + M_N) % M_N : Math.max(0, i - 1);
        const b = closed ? (i + 1) % M_N : Math.min(M_N - 1, i + 1);
        ks[i] = 0.25 * kap[a] + 0.5 * kap[i] + 0.25 * kap[b];
    }
    const kmax = new Float64Array(M_N);
    for (let i = 0; i < M_N; i++) {
        const a = closed ? (i - 1 + M_N) % M_N : Math.max(0, i - 1);
        const b = closed ? (i + 1) % M_N : Math.min(M_N - 1, i + 1);
        const ka = Math.abs(ks[a]), ki = Math.abs(ks[i]), kb = Math.abs(ks[b]);
        // 入弯段 (kb >= ki) 严格取前方峰值防冲出；出弯段 (ki < ka 且 kb < ki) 减弱后方拖累以提前开油
        kmax[i] = kb >= ki ? Math.max(ki, kb, 0.7 * ka + 0.3 * ki) : Math.max(ki, kb, 0.35 * ka + 0.65 * ki);
    }

    return { N: M_N, px, py, tx, ty, nx, ny, ds, dsLine, closed, off, lx, ly, kap: ks, kmax, corridorArr };
}

/** 4. 双向时间最优速度包络求解（99.2% 抓地极限 + 真实赛车线弧长传播） */
function computeOptimalSpeedProfile(model, perf, gripUtil) {
    const M_N = model.N;
    const gUtil = gripUtil != null ? gripUtil : 0.992;
    const grip = (perf.latGrip != null ? perf.latGrip : PHYS.latGrip) * gUtil;
    const maxOmega = (perf.maxOmega != null ? perf.maxOmega : PHYS.maxOmega) * 0.996;
    const vmax = perf.maxSpeed ? perf.maxSpeed[0] : PHYS.maxSpeed[0];
    const brake = PHYS.brake * (perf.brakeMult != null ? perf.brakeMult : 1.0) * 0.968;

    const v = new Float64Array(M_N);
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
    }

    for (let pass = 0; pass < 3; pass++) {
        // 后向刹车传播（使用真实走线弧长 dsLine）
        for (let i = M_N - 1; i >= 0; i--) {
            const j = i + 1 < M_N ? i + 1 : (model.closed ? 0 : -1);
            if (j < 0) continue;
            const d = model.dsLine[i];
            if (d <= 0) continue;
            const lim = Math.sqrt(v[j] * v[j] + 2 * brake * d);
            if (lim < v[i]) v[i] = lim;
        }
        // 前向加速传播
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
    return { v, lapTime, vmax, brake };
}

/** 5. 构建并缓存全场最快走线族（5 候选线竞速选优） */
let _cachedTrackPts = null;
let _cachedTrackId = null;
let _cachedPerfKey = '';
let _cachedModel = null;
let _cachedProfile = null;

function ensureOptimalModel(car) {
    const perf = car.perf || {};
    const tid = (typeof track !== 'undefined' && track.id) ? track.id : N;
    const perfKey = `${perf.latGrip || 0}_${perf.maxOmega || 0}_${perf.brakeMult || 1}_${perf.accelMult || 1}_${perf.powerKW || 0}`;

    if (_cachedModel && _cachedProfile && _cachedTrackPts === pts && _cachedTrackId === tid && _cachedPerfKey === perfKey) {
        return { model: _cachedModel, prof: _cachedProfile };
    }

    const kerbArr = (typeof track !== 'undefined' && track.kerbFlag) ? track.kerbFlag : null;
    const corridorArr = new Float64Array(N);
    const adaptiveLam = new Float64Array(N);

    for (let i = 0; i < N; i++) {
        const halfW = (typeof hw !== 'undefined' && hw[i]) ? hw[i] : 7.0;
        const hasKerb = kerbArr && kerbArr[i] === 1;
        // 有红白路缘石的弯道放宽走廊至 hw - 1.72m，普通沥青留 1.98m 安全余量（比固定 3.8m 宽得多）
        corridorArr[i] = clamp(halfW - (hasKerb ? 1.72 : 1.98), 3.5, 4.9);

        // 构造第 5 条“曲率自适应混合线”：持续大曲率长弯偏向 0.74 贴内线，急弯/S弯保持 1.0 最小曲率
        const cAbs = (typeof curvS !== 'undefined') ? Math.abs(curvS[i]) : 0;
        adaptiveLam[i] = cAbs > 0.015 ? 0.76 : (cAbs > 0.008 ? 0.88 : 1.0);
    }

    const candidates = [1.0, 0.88, 0.76, 0.66, adaptiveLam];
    let bestModel = null, bestProfile = null;

    for (let c = 0; c < candidates.length; c++) {
        const m = buildOptimalTrackModel(pts, corridorArr, candidates[c]);
        const pr = computeOptimalSpeedProfile(m, perf, 0.992);
        if (!bestProfile || pr.lapTime < bestProfile.lapTime) {
            bestModel = m;
            bestProfile = pr;
        }
    }

    _cachedTrackPts = pts;
    _cachedTrackId = tid;
    _cachedPerfKey = perfKey;
    _cachedModel = bestModel;
    _cachedProfile = bestProfile;
    return { model: bestModel, prof: bestProfile };
}

function latOfCar(o, model) {
    const i = ((o.nearIdx | 0) % model.N + model.N) % model.N;
    return (o.x - model.px[i]) * model.nx[i] + (o.y - model.py[i]) * model.ny[i];
}

function findNextApex(model, prof, idx, maxDist) {
    const M_N = model.N;
    let bestV = Infinity, best = null, acc = 0;
    for (let k = 1; k < M_N; k++) {
        acc += model.ds[(idx + k - 1) % M_N];
        if (acc > maxDist) break;
        const j = (idx + k) % M_N;
        if (prof.v[j] < bestV) {
            bestV = prof.v[j];
            best = { idx: j, dist: acc, off: model.off[j] };
        }
    }
    if (!best || bestV > prof.vmax * 0.84) return null;
    return best;
}

/** 6. 主入口函数 driver */
const driver = function timeOptimalDriver(car, out, dt, otherCars) {
    const { model, prof } = ensureOptimalModel(car);
    const M_N = model.N;
    const idx = ((car.nearIdx | 0) % M_N + M_N) % M_N;
    const v = Math.abs(car.speed);
    const perf = car.perf || {};

    if (!car._toState || car._toState.trackId !== _cachedTrackId) {
        car._toState = {
            trackId: _cachedTrackId,
            extra: 0,
            stuck: 0,
            rev: 0,
            moved: false,
            lockedLat: null,
            lockTimer: 0,
            lingering: 0,
            abortCool: 0,
            blockT: 0
        };
    }
    const st = car._toState;

    /* ---- 1) 碰撞受困倒车脱身 ---- */
    if (st.rev > 0) {
        st.rev -= dt;
        out.up = false; out.brake = 2; out.steer = 0; out.left = false; out.right = false;
        return;
    }
    if (st.moved) {
        if (v < 1.0) st.stuck += dt;
        else st.stuck = Math.max(0, st.stuck - dt * 2.2);
        if (st.stuck > 1.9) {
            st.rev = 0.8; st.stuck = 0;
            out.up = false; out.brake = 2; out.steer = 0;
            return;
        }
    } else if (v > 4) {
        st.moved = true;
    }

    // 判断当前是否处于弯心后的出弯加速释放段
    const j1 = model.closed ? (idx + 1) % M_N : Math.min(idx + 1, M_N - 1);
    const j2 = model.closed ? (idx + 2) % M_N : Math.min(idx + 2, M_N - 1);
    const isExitingCorner = (prof.v[j1] > prof.v[idx] + 0.03) && (Math.abs(model.kap[j1]) <= Math.abs(model.kap[idx]) * 1.03);

    /* ---- 2) 全向邻车感知 + 前车预判进攻 + 零损后车防守 ---- */
    let extraTarget = 0;
    let followCap = Infinity;
    let emergency = false;
    let guardSteer = 0;

    // 采用“猛/均”自适应进攻参数：跟车净空 0.82m，内线超车奖励 +2.8，安全中心距 2.46m
    const GAP_ADD = 0.82;
    const INSIDE_BONUS = 2.8;
    const SAFE_SEP = 2.46;
    const ABORT_TIME = 1.45;

    if (otherCars && otherCars.length > 1) {
        const ca = Math.cos(car.angle), sa = Math.sin(car.angle);
        const brake = prof.brake;
        const carLatNow = latOfCar(car, model);
        const baseLat = model.off[idx];
        const apex = findNextApex(model, prof, idx, 135);
        const sharpCorner = apex ? Math.abs(model.kmax[apex.idx]) > 0.012 : false;

        const nbs = [];
        let directLead = null, directLeadS = Infinity;
        let closePursuer = null; // 后方 20m 内威胁追击者

        for (let i = 0; i < otherCars.length; i++) {
            const o = otherCars[i];
            if (!o || o === car) continue;
            const dx = o.x - car.x, dy = o.y - car.y;
            const sLon = dx * ca + dy * sa;
            const dLat = -dx * sa + dy * ca;
            if (Math.abs(sLon) > 70) continue;

            const oIdx = ((o.nearIdx | 0) % M_N + M_N) % M_N;
            const oLat = latOfCar(o, model);
            const oV = Math.abs(o.speed || 0);
            // 预判对手 0.30s 后的横向位置（结合横向速度与对手方向盘输入 o.inSteer）
            const oVLat = (o.speed || 0) * (Math.cos(o.angle) * model.nx[oIdx] + Math.sin(o.angle) * model.ny[oIdx]);
            const predT = clamp(Math.abs(sLon) / Math.max(v, 15), 0.12, 0.38);
            const oPredLat = oLat + oVLat * predT + (o.inSteer || 0) * 0.85 * predT;
            const oBraking = (o.inBrake > 0) || ((o.accel || 0) < -5.5);

            const nb = { o, sLon, dLat, oLat, oPredLat, oBraking, v: oV };
            nbs.push(nb);

            if (sLon > 0 && sLon < 48 && Math.abs(dLat) < CAR_WID + 0.48 && sLon < directLeadS) {
                directLeadS = sLon;
                directLead = nb;
            }
            if (sLon <= -CAR_LEN * 0.85 && sLon > -20 && (oV > v - 1.0 || sLon > -12)) {
                if (!closePursuer || sLon > closePursuer.sLon) closePursuer = nb;
            }
        }

        const blocked = !!(directLead && directLead.sLon < 17 && Math.abs(directLead.dLat) < CAR_WID + 0.52
            && (v > directLead.v - 0.5 || prof.v[idx] > directLead.v + 1.4 || directLead.oBraking));
        st.blockT = blocked ? (st.blockT || 0) + dt : Math.max(0, (st.blockT || 0) - dt * 2);

        // 贴身防刮擦单帧反射
        for (let k = 0; k < nbs.length; k++) {
            const nb = nbs[k];
            if (Math.abs(nb.sLon) < CAR_LEN + 1.8 && Math.abs(nb.dLat) < CAR_WID + 1.35) {
                const penetration = (CAR_WID + 1.35) - Math.abs(nb.dLat);
                const push = clamp(penetration / 1.35, 0, 1) * 0.24;
                guardSteer += (nb.dLat >= 0 ? -push : push);
            }
        }

        const HARD_LAT_SEP = CAR_WID + 0.22;
        const limHere = model.corridorArr[idx] + 0.35;
        const minLat = -limHere, maxLat = limHere;

        st.lockTimer = Math.max(0, (st.lockTimer || 0) - dt);
        if (st.lockTimer === 0) st.lockedLat = null;

        let bestCand = baseLat;
        if (nbs.length > 0) {
            let bestScore = -1e9;
            const canDefend = !!(closePursuer && !directLead && !isExitingCorner);

            for (let c = minLat; c <= maxLat + 0.001; c += 0.36) {
                const cLat = clamp(c, minLat, maxLat);
                let score = 0;
                score -= Math.abs(cLat - baseLat) * (sharpCorner ? 1.75 : 0.72);
                score -= Math.abs(cLat - carLatNow) * 0.58;
                if (st.lockedLat !== null && Math.abs(cLat - st.lockedLat) < 1.0) score += 2.85;

                // (A) 弯道进攻：抢内线插刀 vs 外切内交叉线
                if (directLead && apex) {
                    const inside = -Math.sign(apex.off);
                    const leadOnInside = (directLead.oPredLat * inside) > 1.2;
                    if (!leadOnInside && (cLat - baseLat) * inside > 0.05) {
                        score += INSIDE_BONUS;
                    } else if (leadOnInside && directLead.oBraking && (cLat - directLead.oPredLat) * inside < -1.4) {
                        score += INSIDE_BONUS * 0.85; // 前车封死内线且早刹 -> 走外线准备出弯反切
                    }
                }

                // (B) 零圈速损失后车防守：入弯前封内线，直道微幅影子卡位（出弯绝不防守）
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

                // (C) 逐车碰撞与阻挡评分
                for (let k = 0; k < nbs.length; k++) {
                    const nb = nbs[k];
                    const latDistNow = Math.abs(cLat - nb.oLat);
                    const latDistPred = Math.abs(cLat - nb.oPredLat);
                    const latDist = Math.min(latDistNow, 0.75 * latDistPred + 0.25 * latDistNow);

                    if (nb.sLon > -CAR_LEN - 1.5 && nb.sLon < CAR_LEN + 2.5) {
                        if (latDistNow < HARD_LAT_SEP) score -= 5000 + (HARD_LAT_SEP - latDistNow) * 2000;
                        else if (latDist < SAFE_SEP + 0.4) score -= (SAFE_SEP + 0.4 - latDist) * 18;
                        if ((nb.oLat > carLatNow && cLat > nb.oLat - HARD_LAT_SEP * 0.8) ||
                            (nb.oLat < carLatNow && cLat < nb.oLat + HARD_LAT_SEP * 0.8)) score -= 8000;
                    } else if (nb.sLon >= CAR_LEN + 2.5 && nb.sLon < 48) {
                        const brakeBonus = nb.oBraking ? 4.2 : 0;
                        const closing = v - nb.v + (prof.v[idx] - nb.v) * 0.42 + brakeBonus;
                        if (latDist < SAFE_SEP) {
                            const pw = clamp((48 - nb.sLon) / 40, 0.2, 1.5);
                            const sw = clamp(closing / 8, 0.3, 2.5);
                            const ov = (SAFE_SEP - latDist) / SAFE_SEP;
                            score -= 33 * pw * sw * ov;
                            if (nb.sLon < 14 && closing > 1.3) score -= 46 * ov;
                        } else if (nb.sLon < 26 && closing > 0.9 && latDist < SAFE_SEP + 1.25) {
                            score += 3.6;
                        }
                    } else if (nb.sLon <= -CAR_LEN - 1.5 && nb.sLon > -70) {
                        const rearGap = Math.max(0.2, -nb.sLon - CAR_LEN);
                        const myDecel = prof.v[idx] < v - 3 ? 8.5 : 0;
                        const rearClosing = (nb.v - v) + myDecel;
                        if (rearClosing > 1.5) {
                            const ttc = rearGap / rearClosing;
                            if (ttc < 2.0 && latDist < SAFE_SEP) {
                                const urgency = clamp((2.0 - ttc) / 1.5, 0.2, 2.5);
                                const ov = (SAFE_SEP - latDist) / SAFE_SEP;
                                score -= 55 * urgency * ov;
                            }
                        }
                    }
                }
                if (score > bestScore) { bestScore = score; bestCand = cLat; }
            }
        }

        if (Math.abs(bestCand - baseLat) > 0.85
            && Math.abs(bestCand - (st.lockedLat != null ? st.lockedLat : 999)) > 0.75) {
            st.lockedLat = bestCand; st.lockTimer = 1.55;
        }

        // 缠斗超时果断回线，避免并排掉速
        st.abortCool = Math.max(0, (st.abortCool || 0) - dt);
        if (directLead) {
            const offLine = Math.abs(st.extra) > 1.5;
            const stillBehind = directLead.sLon > 3;
            const notFaster = !(v > directLead.v + 1.8 || prof.v[idx] > directLead.v + 1.8);
            st.lingering = (offLine && stillBehind && notFaster) ? (st.lingering || 0) + dt : 0;
            if (st.lingering > ABORT_TIME) { st.abortCool = 1.1; st.lingering = 0; }
        } else {
            st.lingering = 0;
        }
        if (st.abortCool > 0) bestCand = baseLat;

        extraTarget = clamp(bestCand - baseLat, -5.2, 5.2);

        // 跟车限速 + 抽头净空豁免
        if (directLead) {
            const gap = directLead.sLon - CAR_LEN;
            const closing = v - directLead.v;
            if (gap < 0.95 && closing > 0.5 && Math.abs(directLead.dLat) < CAR_WID + 0.28) emergency = true;
            const attacking = (st.blockT || 0) > 1.0;
            const latOverlap = Math.abs(bestCand - directLead.oPredLat) < SAFE_SEP * 0.94;
            if (latOverlap && directLead.sLon > 0 && gap < 9.5) {
                const oppEffV = Math.max(0, directLead.v - (directLead.oBraking ? 1.2 : 0));
                const safeGap = Math.max(gap - (attacking ? GAP_ADD - 0.28 : GAP_ADD), 0.22);
                const cap = Math.sqrt(oppEffV * oppEffV + 2 * brake * 0.88 * safeGap)
                    + Math.max(0, closing) * 0.12;
                if (cap < followCap) followCap = cap;
            }
        }
    }

    // 横向偏移平滑（抽头 8.5m/s 极速变线，回线 4.8m/s 顺滑归位）
    const rate = Math.abs(extraTarget) > Math.abs(st.extra) ? 8.5 : 4.8;
    st.extra += clamp(extraTarget - st.extra, -rate * dt, rate * dt);

    /* ---- 3) 转向：连续弧长插值纯追踪（彻底消除离散下标跳变抖动） ---- */
    const look = clamp((isExitingCorner ? 8.0 : 7.4) + v * (isExitingCorner ? 0.41 : 0.375), 8.2, 58);

    // 沿中心线精确步进 look 米并进行浮点线性插值
    let rem = look, cur = idx;
    for (let step = 0; step < M_N; step++) {
        const segLen = Math.max(0.2, model.ds[cur]);
        if (rem <= segLen || (!model.closed && cur >= M_N - 1)) break;
        rem -= segLen;
        cur = model.closed ? (cur + 1) % M_N : Math.min(cur + 1, M_N - 1);
    }
    const nextCur = model.closed ? (cur + 1) % M_N : Math.min(cur + 1, M_N - 1);
    const frac = clamp(rem / Math.max(0.2, model.ds[cur]), 0, 1);

    const pxLook = model.px[cur] + (model.px[nextCur] - model.px[cur]) * frac;
    const pyLook = model.py[cur] + (model.py[nextCur] - model.py[cur]) * frac;
    const nxLook = model.nx[cur] + (model.nx[nextCur] - model.nx[cur]) * frac;
    const nyLook = model.ny[cur] + (model.ny[nextCur] - model.ny[cur]) * frac;
    const offLook = model.off[cur] + (model.off[nextCur] - model.off[cur]) * frac;
    const limLook = model.corridorArr[cur] + 0.35;

    // 出弯加速时减弱附加偏移对远点的拉扯，更快回归最优出弯线
    const extraScale = isExitingCorner && Math.abs(extraTarget) < 0.2 ? 0.65 : 1.0;
    const latTarget = clamp(offLook + st.extra * extraScale, -limLook, limLook);
    const tx = pxLook + nxLook * latTarget;
    const ty = pyLook + nyLook * latTarget;

    const alpha = wrapAngle(Math.atan2(ty - car.y, tx - car.x) - car.angle);
    const dist = Math.hypot(tx - car.x, ty - car.y) || 1;
    const kappa = (2 * Math.sin(alpha)) / Math.max(dist, 1);

    const latGrip = perf.latGrip != null ? perf.latGrip : PHYS.latGrip;
    const maxOmega = perf.maxOmega != null ? perf.maxOmega : PHYS.maxOmega;
    const omegaMax = Math.min(maxOmega, latGrip / Math.max(v, 1)) * Math.min(1, v / 3);

    let steer = 0;
    if (omegaMax > 1e-5) steer = clamp((v * kappa) / omegaMax, -1, 1);
    steer = clamp(steer + clamp(guardSteer, -0.30, 0.30), -1, 1);

    out.steer = steer;
    out.left = steer < -0.02;
    out.right = steer > 0.02;

    /* ---- 4) 纵向：亚步长连续速度包络 + 过弯心超前释放 Bang-Bang 控制 ---- */
    const dxSeg = car.x - model.px[idx], dySeg = car.y - model.py[idx];
    const sProj = clamp((dxSeg * model.tx[idx] + dySeg * model.ty[idx]) / Math.max(0.5, model.ds[idx]), 0, 1);

    let vt;
    if (prof.v[j1] < prof.v[idx]) {
        // 刹车入弯段：按车辆在当前采样段内的真实进度平滑过渡到下一采样点限速
        vt = prof.v[idx] + (prof.v[j1] - prof.v[idx]) * clamp(sProj + 0.35, 0, 1);
    } else {
        // 出弯加速段：废除原版 Math.min 枷锁，立刻超前读取前方释放速度！
        vt = Math.max(prof.v[idx], prof.v[idx] + (prof.v[j1] - prof.v[idx]) * clamp(sProj + 0.65, 0, 1));
        if (isExitingCorner && Math.abs(alpha) < 0.25) {
            vt = Math.max(vt, 0.5 * prof.v[j1] + 0.5 * prof.v[j2]);
        }
    }

    // 超车偏离理想线弯速折损（仅在入弯/弯心段折损，出弯段不折损）
    const offLineDist = Math.abs(latOfCar(car, model) - model.off[idx]);
    if (offLineDist > 0.95 && !isExitingCorner) {
        vt *= clamp(1 - (offLineDist - 0.95) * model.kmax[idx] * 1.30, 0.90, 1.0);
    }

    // 极端跟踪误差安全兜底
    const eLat = (car.x - model.px[idx]) * model.nx[idx] + (car.y - model.py[idx]) * model.ny[idx];
    const trackErr = Math.abs(eLat - (model.off[idx] + st.extra));
    if (trackErr > 6.0) vt = Math.min(vt, 24);
    else if (trackErr > 4.2) vt = Math.min(vt, 55);
    else if (trackErr > 2.8) vt = Math.min(vt, 90);

    if (followCap < vt) vt = followCap;

    if (emergency) {
        out.brake = 2;
        out.up = false;
    } else if (v > vt + 0.58) {
        out.brake = 2;
        out.up = false;
    } else if (v > vt + 0.12 && !(isExitingCorner && Math.abs(alpha) < 0.24 && v < vt + 0.35)) {
        out.brake = 1;
        out.up = false;
    } else {
        out.brake = 0;
        out.up = v < vt - 0.02;
    }

    out.targetX = tx;
    out.targetY = ty;
    out.targetSpeed = vt;
};
