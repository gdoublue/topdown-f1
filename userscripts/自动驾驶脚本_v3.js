// =====================================================================
// Topdown F1 · 终极时间最优自动驾驶 V3（路肩利用版）
// V2（防追尾强化）之上，把「走线宽度」改成按引擎真实路面规则计算：
// 宽度自选（含白线与路肩），超车/避让时可合法借道 1.5m 路肩。防追尾层（V2）原样保留。
// 直接粘贴至游戏内置「🤖 自动驾驶」编辑器即可运行。
// =====================================================================
//
// 【引擎的路面规则（读 src/car/physics.js 的 stepCar / stepLongitudinal 得到）】
//
//   路面判定只看**车心**到中心线的距离 d：
//     d <  hw                          → 沥青 surf=0 (极速 100% ，加速 100%)
//     hw ≤ d < hw+1.5（有路缘石）      → 路肩 surf=1 (极速 90%，加速 85%)
//     d ≥ hw+1.5                       → 草地 surf=2 (极速 33.6，加速 60%，转向 ×0.74)
//     无路缘石的路段：hw+0.4 以内仍是沥青，之外直接跳草地
//
//   三个反直觉的结论：
//   1. **路肩不掉抓地**：`omega` 只对 surf===2 乘 0.74，侧向极限与沥青完全相同；
//   2. **路肩不掉刹车**：`strength = PHYS.brake * brakeMult`，与 surf 无关；
//   3. **车身压出白线不算出界**：判定只看车心 → 车心贴着白线内侧 0.05m 时，
//      车身可以有 1m 悬在路肩上，物理上仍是纯沥青。
//
// 【实测：宽度扫描（台架真实物理，法拉利 #16，蒙扎 3 圈最快圈）】
//
//   走廊 4.0m → 1:09.983 ｜ 4.90m → 1:09.933 ｜ 6.00m → 1:09.967 ｜ 6.75m + 压路肩 → 1:10.033
//
//   结论：**路肩不减速，但压路肩也不快**。
//   弯速 v = √(grip/κ) 由赛道几何半径决定，多出来的 1.35m 换到的曲率收益
//   小于「路径变长 + 加速 ×0.85 + 极速 324km/h 上限」的代价。
//   白线附近（4.9~6.0m）才是最优区间，V2 的 4.9 其实已经踩在甜点上。
//
// 【那 V3 把路肩用在哪】
//
//   1. 走线宽度自选：走廊宽度也在 5 条候选线里一起按圈速积分竞速（WIDTH_SCALES），
//      不同赛道自己挑 4.2~6.0m 之间的最优值 → 单车圈速与 V2 持平（7 赛道合计 +0.07s）。
//   2. 超车 / 避让借道：路缘石那 1.5m 横向抓地与刹车都不折减，被挤或需要借位时可以压上去，
//      不会像白线外 0.4m 那样直接掉草地。KERB_ESCAPE = 1.0m。
//      实测混战（7 赛道 × 3 seed）：接触 3 次 → 0 次，平均名次 2.43 → 2.14。
//   3. KERB_USE 开关：想在弯里强行压路肩飙圈速可以打开，实测更慢，仅作对照用。
// =====================================================================
//
// 【V1 为什么一超车就追尾前车】——V2 逐条修掉
//
//   A. 前车识别用的是「车头相对坐标」dLat。
//      一旦自己开始变线，dLat 立刻越过 ±2.48m 阈值 → 前车被「丢失」
//      → followCap（跟车限速）与 emergency（紧急刹车）同时失效 → 满油门顶上前车。
//      （根因：坐标跟着车头走，弯中车头与赛道切线差一大截，判定更飘。）
//
//   B. 跟车限速的生效条件是「目标横向位置 bestCand 与前车横向重叠」。
//      而变线超车恰恰让两者**不**重叠 → 超车那一瞬间限速被完全解除，
//      正好是最危险的时候把安全机制关掉了。
//
//   C. 「进攻豁免」把安全净空再扣 0.28m、刹车系数只按 0.88 计
//      → 等于主动放弃刹停余量，只为多抢那零点几秒。
//
//   D. 变线回线不看被超车辆：刚超完车就往内线切，正好切到对方头前 → 被顶回来。
//
// 【V2 的做法】
//
//   1. 感知改用「赛道切向 / 法向」坐标：dLon = 纵向（沿赛道切线）、dLat = 横向（沿赛道法向）。
//      弯中不再失真，判定与车头姿态无关。
//   2. 跟车限速与「选哪条线」**彻底解绑**：
//      只要前车还在「我当前所在的横向走廊」或「我即将扫过的横向走廊」里，
//      就必须满足「此刻还能刹停」的速度上限；横向真正净空（> 2.75m）之后才解除限速。
//   3. 取消进攻豁免：刹车按 75% 利用率规划，净空余量按闭合速度追加
//      （≈ 在线对局 80ms 快照延迟折算），保证「刹得住」。
//   4. 并排纪律：纵向重叠时不许顶人；非紧急只用轻刹，避免自己被后车追尾。
//   5. 回线安全：被超车辆还在身后 9m 内时，不许往它的横向位置切。
//   6. 真正的紧急判定：按「需要的减速度 vs 可用刹车」判断，而不是 v1 的 gap<0.95m
//      （0.95m 在 360km/h 下只有 0.1s 反应时间，根本刹不住）。
//
// =====================================================================

const CAR_LEN = typeof CAR_LENGTH !== 'undefined' ? CAR_LENGTH : 5.6;
const CAR_WID = typeof CAR_WIDTH !== 'undefined' ? CAR_WIDTH : 2.0;

/* ===== V3 走线宽度档位（唯一需要调的几个数） =====
 * ASPHALT_EDGE     车心与白线的间隙（米）。车身可以悬在路肩上，物理仍算沥青。
 * KERB_USE         是否允许在弯里把车心踩上路肩。
 * KERB_EDGE        有路缘石时车心最多越过白线多少米（路肩带宽 1.5m）。
 * KERB_CURV_ON     曲率达到多少开始踩路肩（1/110 ≈ 半径 110m，与 kerbFlag 铺设阈值一致）
 * KERB_CURV_FULL   曲率达到多少踩满
 */
const ASPHALT_EDGE = 1.00;
const KERB_USE = false;        // 正常走线是否踩路肩（实测更慢，默认关；见文件头实测数据）
const KERB_EDGE = 0.90;
const KERB_CURV_ON = 1 / 110;
const KERB_CURV_FULL = 1 / 45;
const WIDTH_SCALES = [1.0, 0.86, 0.72];   // 走廊宽度候选（含 1.0 = 吃满白线/路肩）
const KERB_ESCAPE = 1.00;      // 超车/避让时允许把车心踩进路肩多少米（路肩带宽 1.5m）

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

/** 2. 欧拉-拉格朗日双调和方程松弛求解器（V3：逐点**非对称**走廊 cLo/cHi + 逐点混合比 cLam） */
function optimizeBiharmonicLine(off, cx, cy, cnx, cny, M, closed, cLo, cHi, iters, relax, cLam) {
    const XL = new Float64Array(M), YL = new Float64Array(M);
    for (let i = 0; i < M; i++) {
        XL[i] = cx[i] + cnx[i] * off[i];
        YL[i] = cy[i] + cny[i] * off[i];
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
            if (nv < cLo[i]) nv = cLo[i];
            else if (nv > cHi[i]) nv = cHi[i];
            off[i] = nv;
            XL[i] = cx[i] + cnx[i] * nv;
            YL[i] = cy[i] + cny[i] * nv;
        }
    }
}

/** 3. 多尺度赛道模型构建（V3：逐点非对称走廊 latLo/latHi + 路肩感知 + 真实赛车线弧长 dsLine） */
function buildOptimalTrackModel(points, latLoArr, latHiArr, blendMode) {
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
        const cLo = new Float64Array(M), cHi = new Float64Array(M);
        const cidx = new Int32Array(M);

        for (let j = 0; j < M; j++) {
            let idx = Math.round(j * stride);
            idx = closed ? ((idx % M_N) + M_N) % M_N : clamp(idx, 0, M_N - 1);
            cidx[j] = idx;
            cx[j] = px[idx]; cy[j] = py[idx];
            cLo[j] = latLoArr[idx];
            cHi[j] = latHiArr[idx];
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
        optimizeBiharmonicLine(cOff, cx, cy, cnx, cny, M, closed, cLo, cHi, levels[li].it, 0.55, cLam);

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

    // V3 路面感知：车心越过白线、且该点铺了路缘石 → 这一点按「路肩」物理算（极速 90% / 加速 85%）
    const kerbArr = (typeof track !== 'undefined' && track.kerbFlag) ? track.kerbFlag : null;
    const onKerb = new Uint8Array(M_N);
    for (let i = 0; i < M_N; i++) {
        const hwI = (typeof hw !== 'undefined' && hw[i] != null) ? hw[i] : 7.0;
        const hasKerb = kerbArr ? kerbArr[i] === 1 : false;
        onKerb[i] = (hasKerb && Math.abs(off[i]) > hwI - 1e-6) ? 1 : 0;
    }

    return {
        N: M_N, px, py, tx, ty, nx, ny, ds, dsLine, closed, off, lx, ly,
        kap: ks, kmax, onKerb, latLo: latLoArr, latHi: latHiArr,
        corridorArr: latHiArr   // 兼容旧字段（对称近似，仅用于粗略上限）
    };
}

/** 4. 双向时间最优速度包络求解（99.2% 抓地极限 + 真实赛车线弧长传播） */
function computeOptimalSpeedProfile(model, perf, gripUtil) {
    const M_N = model.N;
    const gUtil = gripUtil != null ? gripUtil : 0.992;
    const grip = (perf.latGrip != null ? perf.latGrip : PHYS.latGrip) * gUtil;
    const maxOmega = (perf.maxOmega != null ? perf.maxOmega : PHYS.maxOmega) * 0.996;
    const vmax = perf.maxSpeed ? perf.maxSpeed[0] : PHYS.maxSpeed[0];
    // V3：车心落在路肩上的采样点，用路肩极速（90m/s）+ 路肩加速系数（0.85）
    const vmaxKerb = perf.maxSpeed ? perf.maxSpeed[1] : PHYS.maxSpeed[1];
    const kerbAccel = PHYS.accelKerbFactor != null ? PHYS.accelKerbFactor : 0.85;
    const onKerb = model.onKerb;
    const brake = PHYS.brake * (perf.brakeMult != null ? perf.brakeMult : 1.0) * 0.968;

    const v = new Float64Array(M_N);
    for (let i = 0; i < M_N; i++) {
        const k = model.kmax[i];
        let c = (onKerb && onKerb[i]) ? vmaxKerb : vmax;
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
            // V3：路肩点加速 ×0.85（与引擎 stepLongitudinal 的 accelKerbFactor 一致）
            const a = calcAccelAt(perf, v[i]) * ((onKerb && onKerb[i]) ? kerbAccel : 1);
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
    const latLo = new Float64Array(N);
    const latHi = new Float64Array(N);
    const adaptiveLam = new Float64Array(N);

    // —— V3 走廊：按引擎「车心口径」的路面规则算可用宽度 ——
    //   沥青：d < hw（有路缘石）；d < hw + 0.4（无路缘石，再往外直接草地）
    //   路肩：hw ≤ d < hw + 1.5（横向抓地与刹车都不折减，只损失 15% 加速与极速上限）
    for (let i = 0; i < N; i++) {
        const halfW = (typeof hw !== 'undefined' && hw[i] != null) ? hw[i] : 7.0;
        const hasKerb = kerbArr ? kerbArr[i] === 1 : false;
        const cAbs = (typeof curvS !== 'undefined') ? Math.abs(curvS[i]) : 0;

        // 纯沥青可用半宽：留够跟踪误差余量（无路缘石的路段外面是悬崖式草地，必须保守）
        const asphaltLim = halfW - ASPHALT_EDGE;
        // 曲率强度：半径 ≤110m 开始踩路肩，到 KERB_CURV_FULL 踩满
        const w = clamp((cAbs - KERB_CURV_ON) / (KERB_CURV_FULL - KERB_CURV_ON), 0, 1);
        const lim = (KERB_USE && hasKerb)
            ? asphaltLim + (halfW + KERB_EDGE - asphaltLim) * w
            : asphaltLim;
        latLo[i] = -lim;
        latHi[i] = lim;

        // 构造第 5 条“曲率自适应混合线”：持续大曲率长弯偏向 0.76 贴内线，急弯/S弯保持 1.0 最小曲率
        adaptiveLam[i] = cAbs > 0.015 ? 0.76 : (cAbs > 0.008 ? 0.88 : 1.0);
    }

    const candidates = [1.0, 0.88, 0.76, 0.66, adaptiveLam];
    let bestModel = null, bestProfile = null;
    let bestLam = 1.0;

    for (let c = 0; c < candidates.length; c++) {
        const m = buildOptimalTrackModel(pts, latLo, latHi, candidates[c]);
        const pr = computeOptimalSpeedProfile(m, perf, 0.992);
        if (!bestProfile || pr.lapTime < bestProfile.lapTime) {
            bestModel = m;
            bestProfile = pr;
            bestLam = candidates[c];
        }
    }

    // ★ V3 第二轮：宽度也参与竞速。走廊是「上限」不是「目标」——
    //   加宽会同时付出路径变长的代价，所以到底该不该吃满白线 / 该不该踩路肩，
    //   交给真正的圈速积分来判，而不是拍脑袋写死。
    for (let s = 0; s < WIDTH_SCALES.length; s++) {
        const k = WIDTH_SCALES[s];
        if (k >= 1) continue;
        const lo = new Float64Array(N), hi = new Float64Array(N);
        for (let i = 0; i < N; i++) { lo[i] = latLo[i] * k; hi[i] = latHi[i] * k; }
        const m = buildOptimalTrackModel(pts, lo, hi, bestLam);
        const pr = computeOptimalSpeedProfile(m, perf, 0.992);
        if (pr.lapTime < bestProfile.lapTime) {
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

/* =======================================================================
 * 6. 主入口函数 driver
 * ===================================================================== */
const driver = function timeOptimalDriverV2(car, out, dt, otherCars) {
    const { model, prof } = ensureOptimalModel(car);
    const M_N = model.N;
    const idx = ((car.nearIdx | 0) % M_N + M_N) % M_N;
    const v = Math.abs(car.speed);
    const perf = car.perf || {};

    // 建线自检（每次重建模型只打一条）：走线宽度 / 路肩点数 / 模型预测圈速
    if (car._v3Log !== _cachedModel) {
        car._v3Log = _cachedModel;
        let mn = 1e9, mx = -1e9, kb = 0;
        for (let i = 0; i < M_N; i++) {
            if (model.off[i] < mn) mn = model.off[i];
            if (model.off[i] > mx) mx = model.off[i];
            if (model.onKerb[i]) kb++;
        }
        console.log("v3 建线: 走线 off=[" + mn.toFixed(2) + "," + mx.toFixed(2) + "]"
            + " 路肩点=" + kb + "/" + M_N + " 预测圈速=" + prof.lapTime.toFixed(2) + "s");
    }

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

    /* ---- 2) V2 交通安全层：跟车 / 超车 / 防追尾（本次重写的核心） ---- */

    // —— V2 安全参数 ——
    const SAFE_LAT = CAR_WID + 0.75;      // 2.75m：舒适横向净空（中心距），低于此值算「还在一条道」
    const HARD_LAT = CAR_WID + 0.22;      // 2.22m：刚体极限，低于此值有擦碰风险
    const BRAKE_USE = 0.75;               // 规划用刹车利用率（留反应 + 路面余量）
    const GAP_BASE = 0.45;                // 基础净空余量（米）
    const GAP_PER_CLOSE = 0.10;           // 每 1m/s 闭合速度追加的余量（≈ 在线 80ms 快照延迟）
    const HEADWAY_T = 1.25;               // 跟车时距（秒）
    const AHEAD_H = 78;                   // 前向感知距离（米）
    const BEHIND_H = 55;                  // 后向感知距离（米）

    let extraTarget = 0;
    let followCap = Infinity;
    let emergency = false;
    let guardSteer = 0;
    let sideRisk = false;        // 纵向重叠且横向很近 → 只能轻刹，不能重刹（防被后车追尾）
    let leadGap = Infinity;      // 当前主前车净空（调试用）
    let leadV = 0;

    // 赛道切向 / 法向（Frenet 系）：弯中判定不再随车头姿态漂移
    const txI = model.tx[idx], tyI = model.ty[idx];
    const nxI = model.nx[idx], nyI = model.ny[idx];
    const carLatNow = latOfCar(car, model);
    const baseLat = model.off[idx];
    const planOffNow = (baseLat + st.extra) - carLatNow;   // 当前计划的横向位移（相对我的当前位置）

    if (otherCars && otherCars.length > 1) {
        const brakeAvail = prof.brake * BRAKE_USE;          // 规划用可用刹车（m/s²）
        const apex = findNextApex(model, prof, idx, 135);
        const sharpCorner = apex ? Math.abs(model.kmax[apex.idx]) > 0.012 : false;

        /* --- 2.1 全向感知：赛道切向 / 法向坐标 --- */
        const nbs = [];
        let directLead = null, directLeadS = Infinity;
        let closePursuer = null;      // 后方威胁追击者

        for (let i = 0; i < otherCars.length; i++) {
            const o = otherCars[i];
            if (!o || o === car) continue;
            const relX = o.x - car.x, relY = o.y - car.y;
            const dLon = relX * txI + relY * tyI;      // 纵向：沿赛道切线
            const dLat = relX * nxI + relY * nyI;      // 横向：沿赛道法向
            const dist = Math.hypot(relX, relY);
            if (dist > 95 || dLon > AHEAD_H || dLon < -BEHIND_H) continue;

            const oSpeed = o.speed || 0;
            const oC = Math.cos(o.angle), oS = Math.sin(o.angle);
            const nb = {
                o, dLon, dLat, dist,
                v: Math.abs(oSpeed),
                vLat: oSpeed * (oC * nxI + oS * nyI),          // 对方横向速度（法向分量）
                braking: (o.inBrake > 0) || ((o.accel || 0) < -4.0)
            };
            // 预测：闭合时间内对方会挪到哪
            const predT = clamp(dLon / Math.max(v, 18), 0.12, 0.75);
            nb.predLat = dLat + nb.vLat * predT;
            nb.gap = dLon - CAR_LEN;                            // 保险杠净空（负 = 已纵向重叠）
            nb.sepNow = Math.abs(dLat);
            nb.sepPred = Math.abs(nb.predLat);
            nb.sepPlan = Math.abs(dLat - planOffNow);
            // 「横扫」：我的计划路径会从对方身上压过去
            nb.cross = (dLat > 0 && planOffNow > dLat) || (dLat < 0 && planOffNow < dLat);
            nb.sepMin = nb.cross ? 0 : Math.min(nb.sepNow, nb.sepPred, nb.sepPlan);
            nb.latAbs = carLatNow + dLat;                      // 对方在我这帧的绝对横向
            nbs.push(nb);

            // 正前方同车道最近前车（只用于「被堵住」的判定）
            if (dLon > CAR_LEN && dLon < 50 && nb.sepNow < SAFE_LAT && dLon < directLeadS) {
                directLeadS = dLon;
                directLead = nb;
            }
            // 后方 22m 内的追击者
            if (dLon < -CAR_LEN * 0.85 && dLon > -22 && (nb.v > v - 1.0 || dLon > -14)) {
                if (!closePursuer || dLon > closePursuer.dLon) closePursuer = nb;
            }
        }

        const blocked = !!(directLead && directLead.dLon < 17 && (v > directLead.v - 0.5
            || prof.v[idx] > directLead.v + 1.4 || directLead.braking));
        st.blockT = blocked ? (st.blockT || 0) + dt : Math.max(0, (st.blockT || 0) - dt * 2);

        // 贴身防刮擦单帧反射
        for (let k = 0; k < nbs.length; k++) {
            const nb = nbs[k];
            if (Math.abs(nb.dLon) < CAR_LEN + 1.8 && nb.sepNow < CAR_WID + 1.35) {
                const penetration = (CAR_WID + 1.35) - nb.sepNow;
                const push = clamp(penetration / 1.35, 0, 1) * 0.24;
                guardSteer += (nb.dLat >= 0 ? -push : push);
            }
        }

        /* --- 2.2 选线：在走廊内搜索最优横向位置（新增「横扫冲突」「切到后车前」惩罚） --- */
        // V3：走廊非对称（基础线可能已贴到某一侧），并且给超车/避让留出「路肩逃逸空间」：
        //     路缘石那 1.5m 横向抓地与刹车都不折减，被挤或需要借位时压上去完全合法。
        const hwHere = (typeof hw !== 'undefined' && hw[idx] != null) ? hw[idx] : 7.0;
        const kerbHere = !!(typeof track !== 'undefined' && track.kerbFlag && track.kerbFlag[idx] === 1);
        const escLim = kerbHere ? (hwHere + KERB_ESCAPE) : (hwHere - ASPHALT_EDGE);
        const minLat = Math.min(baseLat, -escLim + 0.10);
        const maxLat = Math.max(baseLat, escLim - 0.10);

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
                    const leadOnInside = (directLead.latAbs * inside) > 1.2;
                    if (!leadOnInside && (cLat - baseLat) * inside > 0.05) {
                        score += 2.8;
                    } else if (leadOnInside && directLead.braking && (cLat - directLead.latAbs) * inside < -1.4) {
                        score += 2.8 * 0.85; // 前车封死内线且早刹 -> 走外线准备出弯反切
                    }
                }

                // (B) 零圈速损失后车防守：入弯前封内线，直道微幅影子卡位（出弯绝不防守）
                if (canDefend) {
                    if (apex && apex.dist < 65 && closePursuer.dLon > -18) {
                        const inside = -Math.sign(apex.off);
                        const defLat = clamp(baseLat + inside * 1.85, minLat, maxLat);
                        const dDef = Math.abs(cLat - defLat);
                        if (dDef < 1.6) score += (1.6 - dDef) * 1.8;
                    } else if (!sharpCorner && closePursuer.dLon > -15 && Math.abs(closePursuer.latAbs - baseLat) < 2.1) {
                        const dShadow = Math.abs(cLat - closePursuer.latAbs);
                        if (dShadow < 1.3) score += (1.3 - dShadow) * 1.9;
                    }
                }

                // (C) 逐车冲突评分（全部用赛道坐标）
                for (let k = 0; k < nbs.length; k++) {
                    const nb = nbs[k];
                    const latDist = Math.abs(cLat - nb.latAbs);
                    const dLon = nb.dLon;

                    if (dLon > -CAR_LEN - 1.5 && dLon < CAR_LEN + 2.5) {
                        // 纵向重叠区：并排 / 顶尾
                        if (latDist < HARD_LAT) score -= 5000 + (HARD_LAT - latDist) * 2000;
                        else if (latDist < SAFE_LAT + 0.4) score -= (SAFE_LAT + 0.4 - latDist) * 18;
                        if ((nb.latAbs > carLatNow && cLat > nb.latAbs - HARD_LAT * 0.8) ||
                            (nb.latAbs < carLatNow && cLat < nb.latAbs + HARD_LAT * 0.8)) score -= 8000;
                    } else if (dLon >= CAR_LEN + 2.5 && dLon < 50) {
                        // 前方：阻挡与抽头超车评估
                        const closing = v - nb.v + (prof.v[idx] - nb.v) * 0.42 + (nb.braking ? 4.2 : 0);
                        if (latDist < SAFE_LAT) {
                            const pw = clamp((50 - dLon) / 40, 0.2, 1.5);
                            const sw = clamp(closing / 8, 0.3, 2.5);
                            const ov = (SAFE_LAT - latDist) / SAFE_LAT;
                            score -= 33 * pw * sw * ov;
                            if (dLon < 14 && closing > 1.3) score -= 46 * ov;
                        } else if (dLon < 26 && closing > 0.9 && latDist < SAFE_LAT + 1.25) {
                            score += 3.6;
                        }
                    } else if (dLon <= -CAR_LEN - 1.5 && dLon > -60) {
                        // 后方：被追尾风险 + 「别切到刚超的车前面」
                        const rearGap = Math.max(0.2, -dLon - CAR_LEN);
                        const myDecel = prof.v[idx] < v - 3 ? 8.5 : 0;
                        const rearClosing = (nb.v - v) + myDecel;
                        if (rearClosing > 1.5) {
                            const ttc = rearGap / rearClosing;
                            if (ttc < 2.0 && latDist < SAFE_LAT) {
                                const urgency = clamp((2.0 - ttc) / 1.5, 0.2, 2.5);
                                const ov = (SAFE_LAT - latDist) / SAFE_LAT;
                                score -= 55 * urgency * ov;
                            }
                        }
                        // V2 新增：刚被超的车还在身后 9m 内 → 不许回线插到它头前
                        if (rearGap < 9 && latDist < SAFE_LAT) {
                            score -= 26 * (1 - rearGap / 9) * (0.4 + 0.6 * Math.max(0, rearClosing) / 3);
                        }
                    }

                    // V2 新增：横扫冲突 —— 我要走的横向路径会从对方身上压过去
                    if (dLon > CAR_LEN && dLon < 60) {
                        const sweepLo = Math.min(carLatNow, cLat), sweepHi = Math.max(carLatNow, cLat);
                        if (nb.latAbs > sweepLo - HARD_LAT && nb.latAbs < sweepHi + HARD_LAT) {
                            const near = clamp((50 - dLon) / 40, 0.2, 1.5);
                            score -= 40 * near;
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
            const stillBehind = directLead.dLon > CAR_LEN;   // 车头还在对方车尾之后 = 还没超过去
            const notFaster = !(v > directLead.v + 1.8 || prof.v[idx] > directLead.v + 1.8);
            st.lingering = (offLine && stillBehind && notFaster) ? (st.lingering || 0) + dt : 0;
            if (st.lingering > 1.45) { st.abortCool = 1.1; st.lingering = 0; }
        } else {
            st.lingering = 0;
        }
        if (st.abortCool > 0) bestCand = baseLat;

        extraTarget = clamp(bestCand - baseLat, -5.2, 5.2);

        /* --- 2.3 ★ 跟车限速（V2 核心：与选线彻底解绑） ---
         * 规则：只要「前车还在我当前位置的横向走廊」或「我即将扫过的横向走廊」里，
         *       我的速度就必须低到「此刻还能刹停」的程度。
         *       横向真正净空（> SAFE_LAT）之后才解除限速 —— 这才是安全的超车节奏。
         */
        const planOffNew = bestCand - carLatNow;
        for (let k = 0; k < nbs.length; k++) {
            const nb = nbs[k];

            // --- 2.3a 追尾风险：对方车头还在我车头前面 ---
            if (nb.dLon > CAR_LEN) {
                const sepPlan = Math.abs(nb.dLat - planOffNew);
                const cross = (nb.dLat > 0 && planOffNew > nb.dLat) || (nb.dLat < 0 && planOffNew < nb.dLat);
                const sepMin = cross ? 0 : Math.min(nb.sepNow, nb.sepPred, sepPlan);
                if (sepMin < SAFE_LAT) {
                    const closing = Math.max(0, v - nb.v);
                    const vLead = Math.max(0, nb.v - (nb.braking ? 2.0 : 0));   // 对方随时可能刹
                    const margin = GAP_BASE + closing * GAP_PER_CLOSE;          // 反应 + 快照延迟余量
                    const gapE = Math.max(0, nb.gap - margin);
                    // 运动学上限：此刻还能刹到对方速度的极限速度
                    const vKin = Math.sqrt(vLead * vLead + 2 * brakeAvail * gapE);
                    // 时距上限：保持 1.25s 车头时距
                    const vHead = vLead + Math.max(0, nb.gap) / HEADWAY_T;
                    let cap = Math.min(vKin, vHead);
                    if (nb.gap < 0.9) cap = Math.min(cap, vLead);
                    if (cap < followCap) {
                        followCap = cap;
                        leadGap = nb.gap;
                        leadV = nb.v;
                    }
                    // 真正的紧急判定：需要的减速度超过可用刹车（V1 只看 gap<0.95m，太晚）
                    if (nb.gap > 0.2 && nb.gap < 40) {
                        const vL2 = Math.max(0, nb.v);
                        const aReq = (v * v - vL2 * vL2) / (2 * nb.gap);
                        if (aReq > prof.brake * 0.92) emergency = true;
                    }
                }
            }
            // --- 2.3b 纵向重叠：横向还压着就不许顶人 ---
            else if (nb.dLon > -CAR_LEN - 0.6 && nb.sepNow < HARD_LAT + 0.35) {
                const cap = Math.max(0, nb.v);          // 不许比他还快地顶上去
                if (cap < followCap) followCap = cap;
                sideRisk = true;
                // 已经压上去了还在往前冲 → 全力刹车
                if (nb.gap < 0.2 && v > nb.v + 2.0) emergency = true;
            }
        }
    }

    // 横向偏移平滑（抽头 8.5m/s 极速变线，回线 4.8m/s 顺滑归位）
    const rate = Math.abs(extraTarget) > Math.abs(st.extra) ? 8.5 : 4.8;
    st.extra += clamp(extraTarget - st.extra, -rate * dt, rate * dt);

    /* ---- 3) 转向：连续弧长插值纯追踪（与 V1 一致） ---- */
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
    // V3：前瞻点用非对称走廊夹紧；超车偏移允许借到路肩上（KERB_ESCAPE）
    const hwLook = (typeof hw !== 'undefined' && hw[cur] != null) ? hw[cur] : 7.0;
    const kerbLook = !!(typeof track !== 'undefined' && track.kerbFlag && track.kerbFlag[cur] === 1);
    const escLook = kerbLook ? (hwLook + KERB_ESCAPE) : (hwLook - ASPHALT_EDGE);
    const loLook = Math.min(offLook, -escLook + 0.10);
    const hiLook = Math.max(offLook, escLook - 0.10);

    // 出弯加速时减弱附加偏移对远点的拉扯，更快回归最优出弯线
    const extraScale = isExitingCorner && Math.abs(extraTarget) < 0.2 ? 0.65 : 1.0;
    const latTarget = clamp(offLook + st.extra * extraScale, loLook, hiLook);
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

    /* ---- 4) 纵向：亚步长连续速度包络 + 过弯心超前释放 + V2 跟车限速 ---- */
    const dxSeg = car.x - model.px[idx], dySeg = car.y - model.py[idx];
    const sProj = clamp((dxSeg * model.tx[idx] + dySeg * model.ty[idx]) / Math.max(0.5, model.ds[idx]), 0, 1);

    let vt;
    if (prof.v[j1] < prof.v[idx]) {
        // 刹车入弯段：按车辆在当前采样段内的真实进度平滑过渡到下一采样点限速
        vt = prof.v[idx] + (prof.v[j1] - prof.v[idx]) * clamp(sProj + 0.35, 0, 1);
    } else {
        // 出弯加速段：立刻超前读取前方释放速度
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

    // ★ V2：跟车限速在这里生效（V1 同样位置，但 V1 的限速在变线超车时会被解除）
    if (followCap < vt) vt = followCap;

    if (emergency) {
        out.brake = 2;
        out.up = false;
    } else if (v > vt + 0.58) {
        // V2：并排重叠时不用重刹（重刹容易让后车追上我），非紧急一律轻刹
        out.brake = sideRisk ? 1 : 2;
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

    // 稀疏调试日志（每 5 秒一条，热路径不受影响）
    st.dbg = (st.dbg || 0) + 1;
    if (st.dbg % 300 === 0 && leadGap < Infinity) {
        console.log("v2 跟车: v=" + v.toFixed(1) + " 前车=" + leadV.toFixed(1)
            + " 净空=" + leadGap.toFixed(1) + "m 限速=" + followCap.toFixed(1)
            + " 偏移=" + st.extra.toFixed(2));
    }
};
