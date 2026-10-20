// ==UserScript==
// @name         Topdown F1 · 最优自动驾驶 (AI Autopilot)
// @namespace    https://gdoublue.github.io/topdown-f1/
// @version      1.0.0
// @description  为 https://gdoublue.github.io/topdown-f1/ 提供时间最优自动驾驶：最小曲率赛车线 + 抓地/转向极限弯速表 + 双向速度包络 + 纯追踪转向 + 自动超车
// @author       autopilot
// @match        https://gdoublue.github.io/topdown-f1/*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

(function () {
  'use strict';
  // 防重复注入（Tampermonkey 偶发重载 / 手动多次 eval 时避免叠加面板与双重 tick）
  if (window.__f1ai_loaded) return;
  window.__f1ai_loaded = true;

  /* =====================================================================
   *  算法总览（时间最优）
   *  本作物理模型没有"驱动/转向联合摩擦损失"：
   *    · 转向角速度 ω = min(maxOmega, latGrip / v) * steer
   *    · 纵向制动 61.6 * brakeMult，油门按 accelCurve 衰减
   *  因此时间最优解可以严格分解为：
   *    1) 在赛道走廊内求最小曲率赛车线（投影梯度 / 拉普拉斯松弛）
   *    2) 弯速上限 v = min(vmax, sqrt(aLat/κ), maxOmega/κ)
   *    3) 沿赛车线做"后向刹车传播 + 前向加速传播"，得到逐点最大可行速度包络
   *    4) 实时用纯追踪生成转向（在线上时纯追踪曲率精确等于路径曲率），
   *       纵向按包络 bang-bang 给油/刹车
   * ===================================================================== */

  // ======================= CORE START =======================
  const CAR_LEN = 5.6;           // 车身长（米），与游戏 physics.js 一致
  const CAR_WID = 2.0;           // 车身宽（米）
  const PHYS = {
    accelCurve: [[0, 11.6], [28, 11.0], [56, 8.5], [78.4, 5.5], [100, 1.5]],
    brake: 61.6,
    lightBrakeFactor: 0.45,
    latGrip: 45,
    maxOmega: 3.4,
    maxSpeed: [100, 90, 33.6]
  };

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function wrapAngle(a) {
    while (a > Math.PI) a -= Math.PI * 2;
    while (a < -Math.PI) a += Math.PI * 2;
    return a;
  }

  /**
   * 进攻强度档位（0 稳 / 1 均 / 2 猛）：
   *   gapAdd      : 跟车净空余量（越小贴得越近、刹车越晚）
   *   insideBonus : 入弯内线超车加分（越大越倾向切内线强吃）
   *   safeSep     : 与前车的安全横向中心距（越小越敢贴车并排）
   *   abort       : 超车未成形的放弃时限（越短越果断回线，避免并排缠斗）
   */
  const AGGR_PRESETS = [
    { id: 0, label: '稳', gapAdd: 1.3, insideBonus: 1.6, safeSep: 2.75, abort: 2.4 },
    { id: 1, label: '均', gapAdd: 1.0, insideBonus: 2.2, safeSep: 2.55, abort: 1.8 },
    { id: 2, label: '猛', gapAdd: 0.7, insideBonus: 3.0, safeSep: 2.40, abort: 1.2 }
  ];

  /** 满油门纵向加速度：与游戏 physics.js 的 accelAt / evAccelAt 保持一致 */
  function accelAt(perf, v) {
    if (perf.powerKW != null) {
      const P = perf.powerKW * 1000;
      const m = perf.massKg != null ? perf.massKg : 2200;
      const vmaxNat = perf.naturalVmax != null ? perf.naturalVmax
        : (perf.maxSpeed ? perf.maxSpeed[0] : PHYS.maxSpeed[0]);
      const k = P / (m * vmaxNat * vmaxNat * vmaxNat);
      let a = P / (m * Math.max(v, 2)) - k * v * v;
      a = Math.min(a, perf.launchAccel != null ? perf.launchAccel : 14.0);
      return Math.max(a, 0);
    }
    const c = PHYS.accelCurve;
    let a = c[c.length - 1][1];
    for (let i = 1; i < c.length; i++) {
      if (v <= c[i][0]) {
        const v0 = c[i - 1][0], a0 = c[i - 1][1];
        a = a0 + (c[i][1] - a0) * (v - v0) / (c[i][0] - v0);
        break;
      }
    }
    if (v > c[c.length - 1][0]) a *= (perf.highSpeedAccel != null ? perf.highSpeedAccel : 1.0);
    return a * (perf.accelMult != null ? perf.accelMult : 1.0);
  }

  /**
   * 走廊约束下最小化弯曲能量 Σ|p[i-1]-2p[i]+p[i+1]|²
   * 欧拉-拉格朗日方程：6p_i = 4(p[i-1]+p[i+1]) - (p[i-2]+p[i+2])
   * 就地 Gauss-Seidel 迭代 + 走廊投影（off 为相对中心线法向的偏移）
   */
  function optimizeLine(off, cx, cy, cnx, cny, M, closed, corridor, iters, relax, blend) {
    const lam = blend != null ? blend : 1;
    const XL = new Float64Array(M), YL = new Float64Array(M);
    for (let i = 0; i < M; i++) {
      XL[i] = cx[i] + cnx[i] * off[i];
      YL[i] = cy[i] + cny[i] * off[i];
    }
    const at = (i) => closed ? ((i % M) + M) % M : clamp(i, 0, M - 1);
    for (let it = 0; it < iters; it++) {
      for (let i = 0; i < M; i++) {
        const a1 = at(i - 1), a2 = at(i - 2), b1 = at(i + 1), b2 = at(i + 2);
        const txx = (4 * (XL[a1] + XL[b1]) - (XL[a2] + XL[b2])) / 6;
        const tyy = (4 * (YL[a1] + YL[b1]) - (YL[a2] + YL[b2])) / 6;
        // λ=1 最小曲率（外-内-外）；λ=0 最短走线（贴内侧，适合 180° 长弯）
        const moB = (txx - cx[i]) * cnx[i] + (tyy - cy[i]) * cny[i];
        const mx = 0.5 * (XL[a1] + XL[b1]), my = 0.5 * (YL[a1] + YL[b1]);
        const moM = (mx - cx[i]) * cnx[i] + (my - cy[i]) * cny[i];
        const mo = lam * moB + (1 - lam) * moM;
        const prev = off[i];
        let nv = prev + relax * (mo - prev);
        if (nv < -corridor) nv = -corridor;
        else if (nv > corridor) nv = corridor;
        off[i] = nv;
        XL[i] = cx[i] + cnx[i] * nv;
        YL[i] = cy[i] + cny[i] * nv;
      }
    }
  }

  /**
   * 由中心线点集构建赛道模型：
   *   px/py 中心线、tx/ty 切线、nx/ny 法线、ds 逐段长度
   *   off 最小曲率赛车线的横向偏移、lx/ly 赛车线、kmax 弯速用曲率
   */
  function buildTrackModel(points, opts) {
    opts = opts || {};
    const corridor = opts.corridor != null ? opts.corridor : 3.9;
    const fineIters = opts.iters != null ? opts.iters : 600;
    const blend = opts.blend != null ? opts.blend : 1;
    const N = points.length;
    const px = new Float64Array(N), py = new Float64Array(N);
    for (let i = 0; i < N; i++) { px[i] = points[i].x; py[i] = points[i].y; }

    // 闭合判定：首尾相邻视为环形赛道（本作环形赛道首尾间距 ≤ 1 段）
    const closed = Math.hypot(px[0] - px[N - 1], py[0] - py[N - 1]) < 60;

    const ds = new Float64Array(N);
    const cum = new Float64Array(N + 1);
    for (let i = 0; i < N; i++) {
      const j = i + 1 < N ? i + 1 : (closed ? 0 : N - 1);
      ds[i] = i + 1 < N ? Math.hypot(px[j] - px[i], py[j] - py[i]) : (closed ? Math.hypot(px[0] - px[i], py[0] - py[i]) : 0);
      cum[i + 1] = cum[i] + ds[i];
    }
    const total = cum[N];

    const tx = new Float64Array(N), ty = new Float64Array(N);
    const nx = new Float64Array(N), ny = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const a = closed ? (i - 1 + N) % N : Math.max(0, i - 1);
      const b = closed ? (i + 1) % N : Math.min(N - 1, i + 1);
      let dx = px[b] - px[a], dy = py[b] - py[a];
      const L = Math.hypot(dx, dy) || 1;
      dx /= L; dy /= L;
      tx[i] = dx; ty[i] = dy;
      nx[i] = -dy; ny[i] = dx;        // 左法线
    }

    // ---- 1) 最小曲率赛车线：多尺度（粗→细）投影梯度下降 ----
    // 双调和迭代的长波收敛极慢（约 O(N²) 次），直接在原始采样上迭代 1000+ 次
    // 只能用到 1m 左右的走线宽度。这里先在 1/8、1/4、1/2 采样上求长波解，
    // 再逐级插值回原分辨率精修，几十毫秒即可收敛到完整走廊宽度。
    // （若改用普通邻点中点，收敛到的是"最短路径/弹性带"，会贴内侧且曲率更大，反而更慢）
    const off = new Float64Array(N);
    const lx = new Float64Array(N), ly = new Float64Array(N);
    const levels = [
      { k: 8, it: 6000 },
      { k: 4, it: 2000 },
      { k: 2, it: 600 },
      { k: 1, it: fineIters }
    ];
    for (let li = 0; li < levels.length; li++) {
      const k = levels[li].k;
      const M = k === 1 ? N : Math.max(24, Math.floor(N / k));
      if (M < 24 || (k > 1 && M >= N)) continue;
      const stride = N / M;
      const cx = new Float64Array(M), cy = new Float64Array(M);
      const cnx = new Float64Array(M), cny = new Float64Array(M);
      const cidx = new Int32Array(M);
      for (let j = 0; j < M; j++) {
        let idx = Math.round(j * stride);
        idx = closed ? ((idx % N) + N) % N : clamp(idx, 0, N - 1);
        cidx[j] = idx;
        cx[j] = px[idx]; cy[j] = py[idx];
      }
      for (let j = 0; j < M; j++) {
        const a = closed ? (j - 1 + M) % M : Math.max(0, j - 1);
        const b = closed ? (j + 1) % M : Math.min(M - 1, j + 1);
        const dx = cx[b] - cx[a], dy = cy[b] - cy[a];
        const L = Math.hypot(dx, dy) || 1;
        cnx[j] = -dy / L; cny[j] = dx / L;
      }

      const cOff = new Float64Array(M);
      for (let j = 0; j < M; j++) cOff[j] = off[cidx[j]];
      optimizeLine(cOff, cx, cy, cnx, cny, M, closed, corridor, levels[li].it, 0.55, blend);

      if (k === 1) {
        for (let i = 0; i < N; i++) off[i] = cOff[i];
      } else {
        for (let i = 0; i < N; i++) {
          const t = i / stride;
          const j0 = Math.floor(t);
          const f = t - j0;
          const a = closed ? (j0 % M) : Math.min(j0, M - 1);
          const b = closed ? ((j0 + 1) % M) : Math.min(j0 + 1, M - 1);
          off[i] = cOff[a] + (cOff[b] - cOff[a]) * f;
        }
      }
    }

    for (let i = 0; i < N; i++) {
      lx[i] = px[i] + nx[i] * off[i];
      ly[i] = py[i] + ny[i] * off[i];
    }

    // ---- 2) 赛车线曲率（Menger 曲率，取小邻域最大值做安全包络） ----
    const kap = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const a = closed ? (i - 1 + N) % N : Math.max(0, i - 1);
      const b = closed ? (i + 1) % N : Math.min(N - 1, i + 1);
      const v1x = lx[i] - lx[a], v1y = ly[i] - ly[a];
      const v2x = lx[b] - lx[i], v2y = ly[b] - ly[i];
      const v3x = lx[b] - lx[a], v3y = ly[b] - ly[a];
      const cross = v1x * v2y - v1y * v2x;
      const l1 = Math.hypot(v1x, v1y);
      const l2 = Math.hypot(v2x, v2y);
      const l3 = Math.hypot(v3x, v3y);
      const den = l1 * l2 * l3;
      kap[i] = den > 1e-9 ? (2 * cross) / den : 0;
    }
    const ks = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const a = closed ? (i - 1 + N) % N : Math.max(0, i - 1);
      const b = closed ? (i + 1) % N : Math.min(N - 1, i + 1);
      ks[i] = 0.25 * kap[a] + 0.5 * kap[i] + 0.25 * kap[b];
    }
    const kmax = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const a = closed ? (i - 1 + N) % N : Math.max(0, i - 1);
      const b = closed ? (i + 1) % N : Math.min(N - 1, i + 1);
      kmax[i] = Math.max(Math.abs(ks[a]), Math.abs(ks[i]), Math.abs(ks[b]));
    }

    return {
      N, px, py, tx, ty, nx, ny, ds, cum, total, closed,
      off, lx, ly, kap: ks, kmax, corridor,
      ptsRef: points
    };
  }

  /**
   * 时间最优速度包络：
   *   弯速上限 → 后向刹车传播（可循环多遍）→ 前向加速传播
   * 返回单位 m/s 的逐点最大可行速度。
   */
  function computeSpeedProfile(model, perf, gripUtil) {
    const N = model.N;
    const grip = (perf.latGrip != null ? perf.latGrip : PHYS.latGrip) * (gripUtil != null ? gripUtil : 0.975);
    const maxOmega = (perf.maxOmega != null ? perf.maxOmega : PHYS.maxOmega) * 0.995;
    const vmax = perf.maxSpeed ? perf.maxSpeed[0] : PHYS.maxSpeed[0];
    const brake = PHYS.brake * (perf.brakeMult != null ? perf.brakeMult : 1.0) * 0.96;

    const v = new Float64Array(N);
    for (let i = 0; i < N; i++) {
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
      // 后向：必须在刹车点前把速度收下来
      for (let i = N - 1; i >= 0; i--) {
        const j = i + 1 < N ? i + 1 : (model.closed ? 0 : -1);
        if (j < 0) continue;
        const d = model.ds[i];
        if (d <= 0) continue;
        const lim = Math.sqrt(v[j] * v[j] + 2 * brake * d);
        if (lim < v[i]) v[i] = lim;
      }
      // 前向：引擎能推到多快
      for (let i = 0; i < N; i++) {
        const j = i + 1 < N ? i + 1 : (model.closed ? 0 : -1);
        if (j < 0) continue;
        const d = model.ds[i];
        if (d <= 0) continue;
        const a = accelAt(perf, v[i]);
        const lim = Math.sqrt(v[i] * v[i] + 2 * a * d);
        if (lim < v[j]) v[j] = lim;
      }
    }

    let lapTime = 0;
    for (let i = 0; i < N; i++) lapTime += model.ds[i] / Math.max(v[i], 5);
    return { v, lapTime, vmax, brake, gripUtil: gripUtil != null ? gripUtil : 0.975 };
  }

  /** 自动驾驶内部状态（每辆车一份） */
  function createDriveState() {
    return {
      extra: 0,          // 超车/防守附加横向偏移（米，左正右负，相对中心线）
      stuck: 0,
      rev: 0,
      moved: false,
      lockedLat: null,   // 锁定的目标横向位置（米，相对中心线）
      lockTimer: 0,      // 车道锁定时长
      lingering: 0,      // 抽头后仍卡在前车身后的连续时长
      abortCool: 0,      // 放弃超车后的冷却时间
      blockT: 0          // 被前车压制时长（>1.2s 升级进攻）
    };
  }

  /** 车相对中心线的带符号横向偏移（米，左正右负） */
  function latOf(o, model) {
    const i = ((o.nearIdx | 0) % model.N + model.N) % model.N;
    return (o.x - model.px[i]) * model.nx[i] + (o.y - model.py[i]) * model.ny[i];
  }

  /**
   * 找前方 maxDist 米内的下一个弯心（速度包络最低点），返回 { idx, dist, off }
   * off 在弯道处指向弯外侧（最小曲率线取外圈），因此弯内侧 = -sign(off)。
   */
  function findNextApex(model, prof, idx, maxDist) {
    const N = model.N;
    let bestV = Infinity, best = null, acc = 0;
    for (let k = 1; k < N; k++) {
      acc += model.ds[(idx + k - 1) % N];
      if (acc > maxDist) break;
      const j = (idx + k) % N;
      if (prof.v[j] < bestV) { bestV = prof.v[j]; best = { idx: j, dist: acc, off: model.off[j] }; }
    }
    if (!best || bestV > prof.vmax * 0.82) return null;   // 前方基本无实质弯道
    return best;
  }

  /**
   * 单帧决策：返回 { up, brake, steer }
   * car      : 游戏车辆对象（x,y,angle,speed,nearIdx,perf）
   * model    : buildTrackModel 结果
   * prof     : computeSpeedProfile 结果
   * others   : 全部车辆数组（含自己）
   */
  function stepAutopilot(car, model, prof, others, dt, opts, st) {
    opts = opts || {};
    const N = model.N;
    const out = { up: false, brake: 0, steer: 0 };
    const idx = ((car.nearIdx | 0) % N + N) % N;
    const v = Math.abs(car.speed);
    const perf = car.perf || {};
    const A = AGGR_PRESETS[((opts.aggr != null ? opts.aggr : 1) | 0)] || AGGR_PRESETS[1];

    if (!st) st = createDriveState();
    st.extra = st.extra || 0;

    // ---------- 受困倒车脱身 ----------
    if (st.rev > 0) {
      st.rev -= dt;
      out.brake = 2;
      return out;
    }
    if (st.moved) {
      if (v < 1.0) st.stuck += dt;
      else st.stuck = Math.max(0, st.stuck - dt * 2);
      if (st.stuck > 2.0) { st.rev = 0.8; st.stuck = 0; out.brake = 2; return out; }
    } else if (v > 4) {
      st.moved = true;
    }

    // ---------- 1) 超车/避撞：全向邻车光栅扫描选线 + 跟车限速 ----------
    let extraTarget = 0;
    let followCap = Infinity;
    let emergency = false;
    let guardSteer = 0;

    if (others && others.length > 1) {
      const ca = Math.cos(car.angle), sa = Math.sin(car.angle);
      const brake = prof.brake;
      const carLatNow = latOf(car, model);
      const baseLat = model.off[idx];          // 我们赛车线（理想线）在当前点的横向
      const apex = findNextApex(model, prof, idx, 130);
      const sharpCorner = apex ? Math.abs(model.kmax[apex.idx]) > 0.012 : false;

      // 全向邻车感知（车宽包络、前后左右、追尾 TTC）
      const nbs = [];
      let directLead = null, directLeadS = Infinity;
      for (let i = 0; i < others.length; i++) {
        const o = others[i];
        if (!o || o === car) continue;
        const dx = o.x - car.x, dy = o.y - car.y;
        const sLon = dx * ca + dy * sa;              // >0 前方
        const dLat = -dx * sa + dy * ca;             // >0 左侧
        if (Math.abs(sLon) > 70) continue;
        const nb = { o, sLon, dLat, oLat: latOf(o, model), v: Math.abs(o.speed || 0) };
        nbs.push(nb);
        if (sLon > 0 && sLon < 48 && Math.abs(dLat) < CAR_WID + 0.45 && sLon < directLeadS) {
          directLeadS = sLon; directLead = nb;
        }
      }

      // 被前车压制计时（>1.2s 时跟车贴得更近，准备强攻）
      const blocked = !!(directLead && directLead.sLon < 16 && Math.abs(directLead.dLat) < CAR_WID + 0.5
        && (v > directLead.v - 0.5 || prof.v[idx] > directLead.v + 1.5));
      st.blockT = blocked ? (st.blockT || 0) + dt : Math.max(0, (st.blockT || 0) - dt * 2);

      // 贴身防刮擦反射（叠加到转向，不改变选线结果，用于单帧级快速反应）
      for (let k = 0; k < nbs.length; k++) {
        const nb = nbs[k];
        if (Math.abs(nb.sLon) < CAR_LEN + 1.8 && Math.abs(nb.dLat) < CAR_WID + 1.35) {
          const penetration = (CAR_WID + 1.35) - Math.abs(nb.dLat);
          const push = clamp(penetration / 1.35, 0, 1) * 0.24;
          guardSteer += (nb.dLat >= 0 ? -push : push);
        }
      }

      const HARD_LAT_SEP = CAR_WID + 0.22;      // ~2.22m 极限防擦碰中心距
      const safeSep = A.safeSep;
      const minLat = -4.8, maxLat = 4.8;

      // ===== 赛道横断面光栅扫描：在所有横向位置中挑最优 =====
      // 综合：贴近理想线 / 横向平滑 / 车道锁定 / 弯道内线超车加分 / 逐车车宽冲突 / 后车追尾 TTC 避让
      st.lockTimer = Math.max(0, (st.lockTimer || 0) - dt);
      if (st.lockTimer === 0) st.lockedLat = null;

      let bestCand = baseLat;
      if (nbs.length > 0) {
        let bestScore = -1e9;
        for (let c = minLat; c <= maxLat + 0.001; c += 0.4) {
          const cLat = clamp(c, minLat, maxLat);
          let score = 0;
          score -= Math.abs(cLat - baseLat) * (sharpCorner ? 1.8 : 0.75);   // 离线代价（急弯更贵）
          score -= Math.abs(cLat - carLatNow) * 0.6;                          // 横向平滑
          if (st.lockedLat !== null && Math.abs(cLat - st.lockedLat) < 1.0) score += 2.8; // 车道锁定惯性
          if (directLead && apex) {                                          // 入弯内线超车加分
            const inside = -Math.sign(apex.off);
            if ((cLat - baseLat) * inside > 0.05) score += A.insideBonus;
          }
          for (let k = 0; k < nbs.length; k++) {
            const nb = nbs[k];
            const latDist = Math.abs(cLat - nb.oLat);
            if (nb.sLon > -CAR_LEN - 1.5 && nb.sLon < CAR_LEN + 2.5) {
              // 并排刚体禁区：占位必撞 → 重罚；贴身 → 缓冲斥力；禁穿模
              if (latDist < HARD_LAT_SEP) score -= 5000 + (HARD_LAT_SEP - latDist) * 2000;
              else if (latDist < safeSep + 0.4) score -= (safeSep + 0.4 - latDist) * 18;
              if ((nb.oLat > carLatNow && cLat > nb.oLat - HARD_LAT_SEP * 0.8) ||
                  (nb.oLat < carLatNow && cLat < nb.oLat + HARD_LAT_SEP * 0.8)) score -= 8000;
            } else if (nb.sLon >= CAR_LEN + 2.5 && nb.sLon < 48) {
              // 前车阻挡 / 超车走廊评估
              const closing = v - nb.v + (prof.v[idx] - nb.v) * 0.4;
              if (latDist < safeSep) {
                const pw = clamp((48 - nb.sLon) / 40, 0.2, 1.5);
                const sw = clamp(closing / 8, 0.3, 2.5);
                const ov = (safeSep - latDist) / safeSep;
                score -= 32 * pw * sw * ov;
                if (nb.sLon < 14 && closing > 1.5) score -= 45 * ov;
              } else if (nb.sLon < 25 && closing > 1.0 && latDist < safeSep + 1.2) {
                score += 3.5;  // 紧贴前车安全边界的紧凑超车线
              }
            } else if (nb.sLon <= -CAR_LEN - 1.5 && nb.sLon > -70) {
              // 后车追尾 TTC 预判避让
              const rearGap = Math.max(0.2, -nb.sLon - CAR_LEN);
              const myDecel = prof.v[idx] < v - 3 ? 8.5 : 0;
              const rearClosing = (nb.v - v) + myDecel;
              if (rearClosing > 1.5) {
                const ttc = rearGap / rearClosing;
                if (ttc < 2.0 && latDist < safeSep) {
                  const urgency = clamp((2.0 - ttc) / 1.5, 0.2, 2.5);
                  const ov = (safeSep - latDist) / safeSep;
                  score -= 55 * urgency * ov;
                }
              }
            }
          }
          if (score > bestScore) { bestScore = score; bestCand = cLat; }
        }
      }

      // 车道锁定：明显偏离理想线时锁 1.6s 防抖，避免左右摇摆
      if (Math.abs(bestCand - baseLat) > 0.9
        && Math.abs(bestCand - (st.lockedLat != null ? st.lockedLat : 999)) > 0.8) {
        st.lockedLat = bestCand; st.lockTimer = 1.6;
      }

      // 缠斗超时放弃：抽头后持续 A.abort 秒仍卡在前车 3m 外且无速度优势 → 强制回线 + 冷却
      st.abortCool = Math.max(0, (st.abortCool || 0) - dt);
      if (directLead) {
        const offLine = Math.abs(st.extra) > 1.5;
        const stillBehind = directLead.sLon > 3;
        const notFaster = !(v > directLead.v + 2 || prof.v[idx] > directLead.v + 2);
        st.lingering = (offLine && stillBehind && notFaster) ? (st.lingering || 0) + dt : 0;
        if (st.lingering > A.abort) { st.abortCool = 1.2; st.lingering = 0; }
      } else {
        st.lingering = 0;
      }
      if (st.abortCool > 0) bestCand = baseLat;   // 冷却期回线

      extraTarget = clamp(bestCand - baseLat, -5.2, 5.2);

      // ===== 跟车限速 + 紧急制动 =====
      if (directLead) {
        const gap = directLead.sLon - CAR_LEN;
        const closing = v - directLead.v;
        if (gap < 1.0 && closing > 0.5 && Math.abs(directLead.dLat) < CAR_WID + 0.3) emergency = true;
        const attacking = (st.blockT || 0) > 1.2;
        // 选中的车道仍与前车横向重叠时才跟车限速；已抽头到净空车道则全油门
        const latOverlap = Math.abs(bestCand - directLead.oLat) < safeSep;
        if (latOverlap && directLead.sLon > 0 && gap < 9) {
          const safeGap = Math.max(gap - (attacking ? A.gapAdd - 0.3 : A.gapAdd), 0.25);
          const cap = Math.sqrt(directLead.v * directLead.v + 2 * brake * 0.85 * safeGap)
            + Math.max(0, closing) * 0.12;
          if (cap < followCap) followCap = cap;
        }
      }
    }

    // 偏移平滑（抽头 8m/s，回线 4.5m/s），避免来回摆头
    const rate = Math.abs(extraTarget) > Math.abs(st.extra) ? 8.0 : 4.5;
    const dExtra = clamp(extraTarget - st.extra, -rate * dt, rate * dt);
    st.extra += dExtra;

    // ---------- 2) 转向：纯追踪（在线上时曲率精确）+ 前瞻随速度伸缩 ----------
    const look = clamp(7.5 + v * 0.38, 8.5, 58);
    const stepIdx = Math.max(1, Math.round(look / Math.max(0.5, model.ds[idx])));
    const j = model.closed ? (idx + stepIdx) % N : Math.min(idx + stepIdx, N - 1);

    // 目标点 = 赛车线 + 超车偏移（相对中心线夹到沥青内）
    let latTarget = model.off[j] + st.extra;
    latTarget = clamp(latTarget, -5.0, 5.0);
    const tx = model.px[j] + model.nx[j] * latTarget;
    const ty = model.py[j] + model.ny[j] * latTarget;

    const alpha = wrapAngle(Math.atan2(ty - car.y, tx - car.x) - car.angle);
    const dist = Math.hypot(tx - car.x, ty - car.y) || 1;
    const kappa = (2 * Math.sin(alpha)) / Math.max(dist, 1);

    const latGrip = perf.latGrip != null ? perf.latGrip : PHYS.latGrip;
    const maxOmega = perf.maxOmega != null ? perf.maxOmega : PHYS.maxOmega;
    const omegaMax = Math.min(maxOmega, latGrip / Math.max(v, 1)) * Math.min(1, v / 3);

    let steer = 0;
    if (omegaMax > 1e-5) steer = clamp((v * kappa) / omegaMax, -1, 1);
    steer = clamp(steer + clamp(guardSteer, -0.30, 0.30), -1, 1);  // 贴身防刮擦反射
    out.steer = steer;

    // ---------- 3) 纵向：速度包络 bang-bang ----------
    const j1 = model.closed ? (idx + 1) % N : Math.min(idx + 1, N - 1);
    let vt = Math.min(prof.v[idx], prof.v[j1]);

    // 离线（超车/闪避偏离赛车线）弯速折损：偏离越远、弯越急，越要降速防推头
    const offLineDist = Math.abs(latOf(car, model) - model.off[idx]);
    if (offLineDist > 0.9) {
      vt *= clamp(1 - (offLineDist - 0.9) * model.kmax[idx] * 1.35, 0.89, 1.0);
    }

    // 跟踪误差安全降速：相对"当前指令横向位置（赛车线 + 超车偏移）"的偏差，
    // 不能用相对中心线的偏差——优化走线本身就有 ±4m 的合法偏移。
    const eLat = (car.x - model.px[idx]) * model.nx[idx] + (car.y - model.py[idx]) * model.ny[idx];
    const trackErr = Math.abs(eLat - (model.off[idx] + st.extra));
    if (trackErr > 6.0) vt = Math.min(vt, 24);
    else if (trackErr > 4.2) vt = Math.min(vt, 55);
    else if (trackErr > 2.8) vt = Math.min(vt, 90);

    if (followCap < vt) vt = followCap;
    if (opts.speedScale) vt *= opts.speedScale;

    if (emergency) {
      out.brake = 2;
      out.up = false;
    } else if (v > vt + 0.6) {
      out.brake = 2;
    } else if (v > vt + 0.12) {
      out.brake = 1;
    } else if (v < vt - 0.05) {
      out.up = true;
    }
    return out;
  }
  // ======================= CORE END =======================

  /* ===================== 浏览器接入层 ===================== */
  const LS_KEY = 'f1ai_ap_v1';
  const settings = Object.assign({ enabled: true, grip: 99, corridor: 3.8, aggr: 1 }, readSettings());
  function readSettings() {
    try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}') || {}; } catch (e) { return {}; }
  }
  function saveSettings() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(settings)); } catch (e) {}
  }

  const params = { gripUtil: settings.grip / 100, corridor: settings.corridor };

  let gp = null, model = null, profile = null, profAge = 0;
  let playerCar = null;
  const driveState = createDriveState();
  let ctrl = { up: false, brake: 0, steer: 0, left: false, right: false };
  let origDesc = null;
  let hookInstalled = false;
  let lastPtsRef = null;
  let lastPerf = null;
  let trackId = null;
  let ptsSourceLocked = false;   // 切换过赛道后 __gp.pts 快照已过期，禁止再用它覆盖模型
  let rebuildBusy = false;
  let switchBusy = false;
  let frameCount = 0;

  // ---------- 面板 ----------
  const styleEl = document.createElement('style');
  styleEl.textContent = `
  #f1aiPanel{position:fixed;left:16px;top:338px;width:206px;z-index:30;
    background:linear-gradient(180deg,rgba(8,14,22,.94),rgba(6,10,16,.9));
    border:1px solid rgba(90,220,255,.28);border-radius:10px;padding:8px 10px 9px;
    font-family:ui-monospace,Consolas,monospace;color:#cfe6f5;font-size:11px;
    box-shadow:0 8px 26px rgba(0,0,0,.55);backdrop-filter:blur(6px);user-select:none}
  #f1aiPanel .hd{display:flex;align-items:center;gap:6px;padding-bottom:6px;
    border-bottom:1px solid rgba(90,220,255,.16);margin-bottom:6px}
  #f1aiPanel .hd b{font-size:11px;letter-spacing:.1em;color:#7ef1ff}
  #f1aiPanel .hd small{color:#6f8ba3;font-size:9px;margin-left:auto}
  #f1aiPanel .dot{width:7px;height:7px;border-radius:50%;background:#3f5668;box-shadow:0 0 0 0 rgba(80,255,190,.5)}
  #f1aiPanel.on .dot{background:#3dffb0;box-shadow:0 0 10px rgba(80,255,190,.85)}
  #f1aiPanel .row{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:5px;color:#8aa6bd}
  #f1aiPanel .row b{color:#f2f7ff;font-weight:600;font-variant-numeric:tabular-nums}
  #f1aiPanel .row b.hi{color:#ffd166}
  #f1aiPanel .row b.good{color:#4dffc0}
  #f1aiPanel .btns{display:flex;gap:6px;margin-top:8px}
  #f1aiPanel button{flex:1;cursor:pointer;font-family:inherit;font-size:10px;letter-spacing:.08em;
    color:#bfe9ff;background:rgba(30,80,110,.35);border:1px solid rgba(90,220,255,.35);
    border-radius:6px;padding:5px 0}
  #f1aiPanel button:hover{background:rgba(40,120,160,.45)}
  #f1aiPanel button.off{color:#ff9a8a;border-color:rgba(255,120,100,.45);background:rgba(110,40,32,.3)}
  #f1aiPanel .seg{display:flex;gap:3px}
  #f1aiPanel .seg button{flex:1;padding:3px 0;font-size:10px}
  #f1aiPanel .seg button.on{color:#06121c;background:#2fd7ff;border-color:#2fd7ff;font-weight:700}
  #f1aiPanel input[type=range]{width:88px;accent-color:#2fd7ff;height:12px}
  #f1aiPanel .foot{margin-top:7px;color:#5f7a90;font-size:9px;line-height:1.5;letter-spacing:.03em}
  `;
  document.head.appendChild(styleEl);

  const panel = document.createElement('div');
  panel.id = 'f1aiPanel';
  panel.innerHTML = `
    <div class="hd"><span class="dot"></span><b>AI AUTOPILOT</b><small>TIME-OPTIMAL</small></div>
    <div class="row"><span>状态</span><b id="f1aiState">等待游戏</b></div>
    <div class="row"><span>目标 / 实际</span><b id="f1aiSpeed" class="hi">-- / --</b></div>
    <div class="row"><span>横向误差</span><b id="f1aiErr">--</b></div>
    <div class="row"><span>理论圈速</span><b id="f1aiLap">--</b></div>
    <div class="row"><span>抓地极限</span><input id="f1aiGrip" type="range" min="88" max="100" step="1" value="${settings.grip}"></div>
    <div class="row"><span>走线宽度</span><input id="f1aiWide" type="range" min="34" max="50" step="1" value="${Math.round(settings.corridor * 10)}"></div>
    <div class="row"><span>进攻强度</span><span class="seg" id="f1aiAggr">
      <button data-v="0">稳</button><button data-v="1">均</button><button data-v="2">猛</button>
    </span></div>
    <div class="btns"><button id="f1aiToggle">ON</button><button id="f1aiRebuild">重算走线</button></div>
    <div class="foot">F8 开关 · 进攻强度: 猛=更早抽头+更贴+更快放弃缠斗（碰撞风险↑），稳=保守</div>
  `;
  document.body.appendChild(panel);

  const ui = {
    state: panel.querySelector('#f1aiState'),
    speed: panel.querySelector('#f1aiSpeed'),
    err: panel.querySelector('#f1aiErr'),
    lap: panel.querySelector('#f1aiLap'),
    grip: panel.querySelector('#f1aiGrip'),
    wide: panel.querySelector('#f1aiWide'),
    toggle: panel.querySelector('#f1aiToggle'),
    rebuild: panel.querySelector('#f1aiRebuild')
  };

  function syncToggleUI() {
    panel.classList.toggle('on', !!settings.enabled);
    ui.toggle.textContent = settings.enabled ? 'ON' : 'OFF';
    ui.toggle.classList.toggle('off', !settings.enabled);
  }
  syncToggleUI();

  ui.toggle.addEventListener('click', () => {
    settings.enabled = !settings.enabled;
    saveSettings(); syncToggleUI();
  });
  ui.grip.addEventListener('input', () => {
    settings.grip = Number(ui.grip.value) || 99;
    params.gripUtil = settings.grip / 100;
    saveSettings();
    if (model && playerCar) profile = computeSpeedProfile(model, playerCar.perf || {}, params.gripUtil);
  });
  ui.grip.addEventListener('change', () => {
    // 松手后按新抓地水平重新选择走线族（3 条候选线预测圈速可能变化）
    if (lastPtsRef) rebuild(lastPtsRef, playerCar && playerCar.perf);
  });
  ui.wide.addEventListener('change', () => {
    settings.corridor = Number(ui.wide.value) / 10;
    params.corridor = settings.corridor;
    saveSettings();
    if (lastPtsRef) rebuild(lastPtsRef, playerCar && playerCar.perf);
  });
  ui.rebuild.addEventListener('click', () => {
    if (lastPtsRef) rebuild(lastPtsRef, playerCar && playerCar.perf);
  });

  const aggrBtns = Array.prototype.slice.call(panel.querySelectorAll('#f1aiAggr button'));
  function syncAggrUI() {
    aggrBtns.forEach(b => b.classList.toggle('on', Number(b.dataset.v) === settings.aggr));
  }
  syncAggrUI();
  aggrBtns.forEach(b => b.addEventListener('click', () => {
    settings.aggr = Number(b.dataset.v);
    saveSettings(); syncAggrUI();
  }));

  window.addEventListener('keydown', (e) => {
    if (e.key === 'F8') {
      e.preventDefault();
      settings.enabled = !settings.enabled;
      saveSettings(); syncToggleUI();
    }
  }, true);

  // ---------- 接管输入 ----------
  function installInputHook(input) {
    if (hookInstalled) return;
    const keys = ['up', 'brake', 'left', 'right'];
    origDesc = {};
    try {
      for (const k of keys) {
        const d = Object.getOwnPropertyDescriptor(input, k);
        if (d && d.get) origDesc[k] = d.get;
      }
      for (const k of keys) {
        Object.defineProperty(input, k, {
          configurable: true,
          enumerable: true,
          get() { return ctrl[k]; }
        });
      }
      // 数值转向：物理层优先使用 input.steer（比左右按键更精确）
      try {
        Object.defineProperty(input, 'steer', {
          configurable: true,
          enumerable: true,
          get() { return ctrl.steer; }
        });
      } catch (e) {
        // 退化为左右按键：ctrl.left/right 已按 0.02 阈值同步
      }
      hookInstalled = true;
    } catch (e) {
      hookInstalled = false;
      if (ui.state) ui.state.textContent = '输入接口不兼容';
    }
  }

  function releaseToKeyboard() {
    if (!origDesc) { ctrl.up = false; ctrl.brake = 0; ctrl.steer = 0; return; }
    ctrl.up = !!origDesc.up.call(gp.input);
    ctrl.brake = origDesc.brake.call(gp.input);
    const L = !!origDesc.left.call(gp.input);
    const R = !!origDesc.right.call(gp.input);
    ctrl.left = L; ctrl.right = R;
    ctrl.steer = (R ? 1 : 0) - (L ? 1 : 0);
  }

  // ---------- 赛道模型构建 ----------
  // 走线不是一个固定答案：普通弯"外-内-外"最小曲率最快，
  // 但 180° 长弯（体育场环道）贴内侧的最短走线更快。
  // 这里同时生成 3 条候选线，用速度包络给出的预测圈速自动选优。
  const LINE_CANDIDATES = [1.0, 0.85, 0.7];

  function rebuild(points, perf) {
    if (!points || !points.length) return;
    rebuildBusy = true;
    try {
      const pf = perf || {};
      let bestModel = null, bestProfile = null;
      for (let i = 0; i < LINE_CANDIDATES.length; i++) {
        const m = buildTrackModel(points, { corridor: params.corridor, blend: LINE_CANDIDATES[i] });
        const pr = computeSpeedProfile(m, pf, params.gripUtil);
        if (!bestProfile || pr.lapTime < bestProfile.lapTime) { bestModel = m; bestProfile = pr; }
      }
      model = bestModel;
      profile = bestProfile;
      lastPtsRef = points;
      driveState.extra = 0; driveState.stuck = 0; driveState.rev = 0;
      driveState.moved = false;
      driveState.lockedLat = null; driveState.lockTimer = 0;
      driveState.blockT = 0; driveState.lingering = 0; driveState.abortCool = 0;
    } catch (e) {
      model = null; profile = null;
      if (ui.state) ui.state.textContent = '建模失败';
    } finally {
      rebuildBusy = false;
    }
  }

  // ---------- 切换赛道：__gp.pts 是快照，需从同源 iframe 取新几何 ----------
  function fetchTrackPts(id) {
    return new Promise((resolve) => {
      const f = document.createElement('iframe');
      f.setAttribute('aria-hidden', 'true');
      f.style.cssText = 'position:fixed;left:-9999px;top:0;width:2px;height:2px;opacity:0;pointer-events:none;border:0';
      f.src = location.origin + location.pathname + '?track=' + encodeURIComponent(id);
      let done = false;
      const finish = (arr) => {
        if (done) return;
        done = true;
        try { f.remove(); } catch (e) {}
        resolve(arr);
      };
      f.onload = () => {
        let n = 0;
        const iv = setInterval(() => {
          try {
            const w = f.contentWindow;
            const g = w && w.__gp;
            if (g && g.pts && g.pts.length) {
              clearInterval(iv);
              finish(g.pts.map(p => ({ x: p.x, y: p.y })));
            } else if (++n > 100) {
              clearInterval(iv); finish(null);
            }
          } catch (e) { clearInterval(iv); finish(null); }
        }, 100);
      };
      document.body.appendChild(f);
      setTimeout(() => finish(null), 12000);
    });
  }

  async function onTrackChanged(id) {
    if (switchBusy) return;
    switchBusy = true;
    if (ui.state) ui.state.textContent = '切换赛道…';
    try {
      const pts = await fetchTrackPts(id);
      if (pts && pts.length) {
        rebuild(pts, playerCar && playerCar.perf);
      } else {
        model = null; profile = null;
        if (ui.state) ui.state.textContent = '请刷新页面';
      }
    } finally {
      switchBusy = false;
    }
  }

  // ---------- 主循环（注册在游戏 rAF 之后，晚一帧生效） ----------
  function tick() {
    requestAnimationFrame(tick);
    if (!gp) return;

    // 赛道切换检测（applyTrack 会写入 ?track=）
    let tid = 'default';
    try { tid = new URLSearchParams(location.search).get('track') || 'default'; } catch (e) {}
    if (tid !== trackId) {
      trackId = tid;
      ptsSourceLocked = true;   // 从这里开始 __gp.pts 不再跟随 switchTrack 更新
      if (lastPtsRef) onTrackChanged(tid === 'default' ? '' : tid);
    }

    // 首次加载：__gp.pts 才是权威几何
    if (!ptsSourceLocked && gp.pts && gp.pts !== lastPtsRef && !rebuildBusy) {
      rebuild(gp.pts, (gp.cars && (gp.cars.find(c => c.isPlayer) || gp.cars[0]) || {}).perf);
    }

    const cars = gp.cars;
    if (!cars || !cars.length) return;
    playerCar = cars.find(c => c.isPlayer) || cars[0];

    if (!hookInstalled) installInputHook(gp.input);

    // 玩家选车后性能对象才确定：按该车性能重新选一次走线族（不同车的最优走线可能不同）
    if (playerCar && playerCar.perf && playerCar.perf !== lastPerf && !rebuildBusy) {
      lastPerf = playerCar.perf;
      if (lastPtsRef) rebuild(lastPtsRef, lastPerf);
    }

    // 调校面板会原地改 perf：周期性重建速度包络
    profAge++;
    if (model && profile && profAge % 30 === 0) {
      profile = computeSpeedProfile(model, playerCar.perf || {}, params.gripUtil);
    }

    // 倒计时阶段（含 R 重开 / 换赛道后的重置）清空内部状态，避免上一局受困计数误触发倒车
    if (gp.race && gp.race.state === 'countdown') {
      driveState.extra = 0; driveState.stuck = 0; driveState.rev = 0;
      driveState.moved = false;
      driveState.lockedLat = null; driveState.lockTimer = 0;
      driveState.blockT = 0; driveState.lingering = 0; driveState.abortCool = 0;
    }

    const racing = gp.started && gp.race && gp.race.state === 'racing';
    const spectate = gp.mode === 'spectate';

    if (!settings.enabled) {
      releaseToKeyboard();
      ui.state.textContent = '手动驾驶';
      updateHud(0);
      return;
    }
    if (spectate) {
      ctrl.up = false; ctrl.brake = 0; ctrl.steer = 0; ctrl.left = ctrl.right = false;
      ui.state.textContent = '观战模式';
      return;
    }
    if (!racing || !model || !profile || rebuildBusy || switchBusy) {
      ctrl.up = false; ctrl.brake = 0; ctrl.steer = 0; ctrl.left = ctrl.right = false;
      ui.state.textContent = (rebuildBusy || switchBusy) ? '建模中…' : (model ? '等待发车' : '建模中…');
      return;
    }

    const dt = 1 / 60;
    const out = stepAutopilot(playerCar, model, profile, cars, dt, { aggr: settings.aggr }, driveState);
    ctrl.up = out.up;
    ctrl.brake = out.brake;
    ctrl.steer = out.steer;
    ctrl.left = out.steer < -0.02;
    ctrl.right = out.steer > 0.02;

    frameCount++;
    if (frameCount % 6 === 0) updateHud(out.steer);
  }

  function updateHud(steer) {
    if (!playerCar || !model || !profile) return;
    const N = model.N;
    const idx = ((playerCar.nearIdx | 0) % N + N) % N;
    const v = Math.abs(playerCar.speed);
    const vt = profile.v[idx];
    ui.state.textContent = settings.enabled ? '自动驾驶中' : '手动驾驶';
    ui.state.className = settings.enabled ? 'good' : '';
    ui.speed.textContent = `${Math.round(vt * 3.6)} / ${Math.round(v * 3.6)} km/h`;
    const eLat = (playerCar.x - model.px[idx]) * model.nx[idx] + (playerCar.y - model.py[idx]) * model.ny[idx];
    const trackErr = eLat - (model.off[idx] + driveState.extra);
    ui.err.textContent = `${trackErr >= 0 ? 'L' : 'R'} ${Math.abs(trackErr).toFixed(2)} m`;
    ui.lap.textContent = fmtLap(profile.lapTime);
  }

  function fmtLap(t) {
    if (!isFinite(t) || t <= 0) return '--';
    const m = Math.floor(t / 60);
    const s = t - m * 60;
    return `${m}:${s < 10 ? '0' : ''}${s.toFixed(2)}`;
  }

  function boot() {
    gp = window.__gp;
    if (!gp || !gp.pts || !gp.pts.length) return;
    trackId = new URLSearchParams(location.search).get('track') || 'default';
    const car = gp.cars && (gp.cars.find(c => c.isPlayer) || gp.cars[0]);
    rebuild(gp.pts, car && car.perf);
    requestAnimationFrame(tick);
  }

  // 等待游戏模块挂载 __gp
  let waited = 0;
  const waiter = setInterval(() => {
    if (window.__gp && window.__gp.pts && window.__gp.pts.length) {
      clearInterval(waiter);
      boot();
    } else if (++waited > 300) {
      clearInterval(waiter);
      ui.state.textContent = '未找到游戏接口';
    }
  }, 200);
})();
