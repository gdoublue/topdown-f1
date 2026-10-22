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
  const px = new Float64Array(M_N);
  const py = new Float64Array(M_N);
  for (let i = 0; i < M_N; i++) {
    px[i] = points[i].x;
    py[i] = points[i].y;
  }

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

  // Warm-start from engine's precomputed racing line for faster & deeper convergence
  const off = new Float64Array(M_N);
  if (!isLinearTrack && typeof lineX !== "undefined" && typeof lineY !== "undefined") {
    for (let i = 0; i < M_N; i++) {
      const bOff = (lineX[i] - px[i]) * nx[i] + (lineY[i] - py[i]) * ny[i];
      off[i] = clamp(bOff * 1.12, -corridorArr[i], corridorArr[i]);
    }
  }

  const levels = isLinearTrack
    ? [{ k: 4, it: 60 }, { k: 1, it: 40 }]
    : [{ k: 8, it: 2600 }, { k: 4, it: 1200 }, { k: 2, it: 480 }, { k: 1, it: 480 }];

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
  for (let i = 0; i < M_N; i++) {
    lx[i] = px[i] + nx[i] * off[i];
    ly[i] = py[i] + ny[i] * off[i];
  }

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

  // Asymmetric curvature envelope: look ahead ~4.2m on corner entry (kb >= ki) for turn-in stability,
  // but release immediately once past the apex (kb < ki) so corner exit is never dragged back!
  let meanDs = 0;
  for (let i = 0; i < M_N; i++) meanDs += dsLine[i];
  meanDs = meanDs / Math.max(1, M_N);
  const kW = Math.max(1, Math.round(4.2 / Math.max(0.5, meanDs)));

  const kmax = new Float64Array(M_N);
  for (let i = 0; i < M_N; i++) {
    const a = stepIndex(i, -1, M_N, closed);
    const b = stepIndex(i, 1, M_N, closed);
    const ka = Math.abs(ks[a]), ki = Math.abs(ks[i]), kb = Math.abs(ks[b]);
    let k = kb >= ki
      ? Math.max(ki, kb, 0.70 * ka + 0.30 * ki)
      : Math.max(ki, kb, 0.22 * ka + 0.78 * ki);
    if (kb >= ki * 0.98) {
      for (let s = 1; s <= kW; s++) {
        const kf = Math.abs(ks[stepIndex(i, s, M_N, closed)]);
        if (kf > k) k = kf;
      }
    }
    kmax[i] = k;
  }

  return { N: M_N, px, py, tx, ty, nx, ny, ds, sCum, dsLine, closed, off, lx, ly, kap: ks, kmax, corridorArr };
}

function computeOptimalSpeedProfile(model, perf, isLowPerf) {
  const M_N = model.N;
  const cornerGripMult = (perf && perf.cornerGripMult != null) ? perf.cornerGripMult : 1.0;
  const brakeMult = (perf && perf.brakeMult != null) ? perf.brakeMult : 1.0;
  const rawLatGrip = (perf && perf.latGrip != null) ? perf.latGrip : PHYS.latGrip;

  const baseGripUtil = isLowPerf
    ? clamp(0.915 + (brakeMult - 0.32) * 0.14, 0.915, 0.968)
    : 0.992;
  const grip = rawLatGrip * Math.min(1.0, baseGripUtil * cornerGripMult);
  const maxOmega = ((perf && perf.maxOmega != null) ? perf.maxOmega : PHYS.maxOmega) * (isLowPerf ? 0.975 : 0.996);
  const vmax = (perf && perf.maxSpeed) ? perf.maxSpeed[0] : PHYS.maxSpeed[0];
  const brakeUtil = isLowPerf
    ? clamp(0.885 + (brakeMult - 0.32) * 0.14, 0.885, 0.945)
    : 0.968;
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
        effBrake = brake * clamp(1.0 - (kHere - 0.0055) * 7.5, 0.92, 1.0);
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

function ensureOptimalModel(car) {
  const perf = car.perf || {};
  const tid = (typeof track !== "undefined" && track.id) ? track.id : N;
  const isLinearTrack = Boolean(typeof track !== "undefined" && track.isLinear);
  const brakeMult = perf.brakeMult != null ? perf.brakeMult : 1.0;
  const latGrip = perf.latGrip != null ? perf.latGrip : PHYS.latGrip;
  const isLowPerf = brakeMult < 0.72 || latGrip < 26.0;

  const cacheKey = `${tid}_${N}_${latGrip}_${perf.maxOmega || 0}_${brakeMult}_${perf.accelMult || 1}_${perf.powerKW || 0}_${perf.cornerGripMult || 1}`;
  const cached = _modelCache.get(cacheKey);
  if (cached && cached.ptsRef === pts) {
    return cached;
  }
  if (_modelCache.size > 16) _modelCache.clear();

  const kerbArr = (typeof track !== "undefined" && track.kerbFlag) ? track.kerbFlag : null;
  const corridorArr = new Float64Array(N);
  const adaptiveLam = new Float64Array(N);

  for (let i = 0; i < N; i++) {
    const halfW = (typeof hw !== "undefined" && hw[i]) ? hw[i] : 7.0;
    const hasKerb = kerbArr && kerbArr[i] === 1;
    // Unlock dynamic apex widening (hw up to 9.5~10m) instead of capping at 4.9m, while keeping 0% grass safety buffer
    const baseCap = Math.min(halfW, 7.5) - (isLowPerf ? (hasKerb ? 2.10 : 2.30) : (hasKerb ? 1.72 : 1.98));
    const apexExtra = Math.max(0, halfW - 7.5) * (isLowPerf ? 0.48 : 0.68);
    const maxSafe = halfW - (isLowPerf ? 2.26 : 1.95);
    corridorArr[i] = clamp(baseCap + apexExtra, 3.1, Math.min(6.4, maxSafe));

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

function sampleModelAtDist(model, startIdx, distM) {
  const M_N = model.N;
  let cur = clampIdx(startIdx, M_N);
  let rem = Math.max(0, distM);
  for (let s = 0; s < M_N; s++) {
    const seg = Math.max(0.2, model.ds[cur]);
    if (rem <= seg || (!model.closed && cur >= M_N - 1)) break;
    rem -= seg;
    cur = stepIndex(cur, 1, M_N, model.closed);
  }
  const next = stepIndex(cur, 1, M_N, model.closed);
  const frac = clamp(rem / Math.max(0.2, model.ds[cur]), 0, 1);
  return {
    cur,
    next,
    frac,
    px: model.px[cur] + (model.px[next] - model.px[cur]) * frac,
    py: model.py[cur] + (model.py[next] - model.py[cur]) * frac,
    nx: model.nx[cur] + (model.nx[next] - model.nx[cur]) * frac,
    ny: model.ny[cur] + (model.ny[next] - model.ny[cur]) * frac,
    off: model.off[cur] + (model.off[next] - model.off[cur]) * frac,
    lim: model.corridorArr[cur] + (model.corridorArr[next] - model.corridorArr[cur]) * frac
  };
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
  const apexReleaseCap = typeof getApexReleaseCap === "function" ? getApexReleaseCap(perf) : null;

  if (car._toState == null || car._toState.trackId !== trackId) {
    car._toState = {
      trackId: trackId,
      extra: 0,
      stuck: 0,
      rev: 0,
      revSteer: 0,
      moved: false,
      inHeavyBrake: false,
      lockedLat: null,
      lockTimer: 0,
      lingering: 0,
      abortCool: 0,
      blockT: 0
    };
  }
  const st = car._toState;

  /* ---- 1) Unstuck & Reverse Recovery ---- */
  if (st.rev > 0) {
    st.rev -= safeDt;
    out.up = false;
    out.brake = 2;
    out.steer = Number.isFinite(st.revSteer) ? st.revSteer : 0;
    out.left = out.steer < -0.02;
    out.right = out.steer > 0.02;
    out.targetX = model.px[idx];
    out.targetY = model.py[idx];
    out.targetSpeed = 0;
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
      st.inHeavyBrake = false;
      out.up = false;
      out.brake = 2;
      out.steer = st.revSteer;
      out.left = out.steer < -0.02;
      out.right = out.steer > 0.02;
      out.targetX = model.px[idx];
      out.targetY = model.py[idx];
      out.targetSpeed = 0;
      return;
    }
  } else if (v > 3.8) {
    st.moved = true;
  }

  /* ---- 2) Corner Phase Recognition (Fusing gemini-driver Phase Logic + Biharmonic Profile) ---- */
  const j1 = stepIndex(idx, 1, M_N, model.closed);
  const j2 = stepIndex(idx, 2, M_N, model.closed);
  const idx12 = advanceIdxByMeters(model, idx, 12);
  const idx24 = advanceIdxByMeters(model, idx, 24);
  const idx64 = advanceIdxByMeters(model, idx, 64);

  const cSigned = (typeof curvS !== "undefined" ? curvS[idx] : model.kap[idx]) || 0;
  const curvHere = Math.max(Math.abs(cSigned), Math.abs(model.kap[idx]));
  const cSign = Math.sign(cSigned || model.kap[idx]);
  const inCorner = curvHere > 0.0065;

  const curv12 = Math.abs(typeof curvS !== "undefined" ? curvS[idx12] : model.kap[idx12]);
  const curv24 = Math.abs(typeof curvS !== "undefined" ? curvS[idx24] : model.kap[idx24]);

  const isExitingCorner = (prof.v[j1] > prof.v[idx] + 0.02) &&
    (Math.abs(model.kap[j1]) <= Math.abs(model.kap[idx]) * 1.03);
  const isPastApex = inCorner && (curv12 < curvHere * 0.94) && (curv24 <= curv12 * 1.05);

  let hasNextReverseCorner = false;
  let hasNextTightCorner = false;
  let nextReverseSign = 0;
  if (inCorner && !track.isLinear) {
    let scanI = idx12;
    for (let s = 0; s < 18 && scanI !== idx64; s++) {
      const futC = (typeof curvS !== "undefined" ? curvS[scanI] : model.kap[scanI]) || 0;
      if (cSign !== 0 && cSign * futC < -0.0052) {
        hasNextReverseCorner = true;
        nextReverseSign = Math.sign(futC);
        break;
      }
      if (s > 3 && Math.abs(futC) > Math.max(curvHere * 0.94, 0.0105)) {
        hasNextTightCorner = true;
      }
      scanI = stepIndex(scanI, 1, M_N, model.closed);
    }
  }

  const isIsolatedExit = (isPastApex || (isExitingCorner && inCorner)) && !hasNextReverseCorner && !hasNextTightCorner;
  const exitProgress = isIsolatedExit ? clamp(1.0 - (curv24 / Math.max(curvHere, 1e-4)), 0.25, 1.0) : 0;

  const carLatNow = latOfCar(car, model);
  const baseLat = model.off[idx];
  const vLatCar = v * (Math.cos(car.angle) * model.nx[idx] + Math.sin(car.angle) * model.ny[idx]);

  /* ---- 3) 360° Perception + Dual-Frame Corner-Entry Anti-Rear-End + 3-Wide Sandwich & Rear TTC ---- */
  let extraTarget = 0;
  let followCap = Infinity;
  let emergency = false;
  let squeezeBailout = false;
  let rearUrgentThreat = false;
  let guardSteer = 0;

  const GAP_ADD = 0.92;
  const INSIDE_BONUS = 2.85;
  const SAFE_SEP = 2.48;
  const ABORT_TIME = 1.45;

  if (otherCars && otherCars.length > 1) {
    const ca = Math.cos(car.angle), sa = Math.sin(car.angle);
    const brake = prof.brake;
    const apex = findNextApex(model, prof, idx, Math.max(95, v * 1.6));
    const sharpCorner = apex ? Math.abs(model.kmax[apex.idx]) > 0.011 : false;

    const nbs = [];
    let directLead = null, directLeadS = Infinity;
    let closePursuer = null;
    let hasLeftAlongside = false, hasRightAlongside = false;
    let leftWallCarLat = Infinity, rightWallCarLat = -Infinity;

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

      const nb = {
        o, sLon, dLat, oIdx, oLat, oPredLat, oBraking, v: oV, oVLat,
        dnNow, dnPred, dnMin, dnMax, oCornerV
      };
      nbs.push(nb);

      if (sLon > -CAR_LEN - 1.2 && sLon < CAR_LEN + 1.8) {
        if (oLat > carLatNow) {
          hasLeftAlongside = true;
          if (oLat < leftWallCarLat) leftWallCarLat = oLat;
        } else {
          hasRightAlongside = true;
          if (oLat > rightWallCarLat) rightWallCarLat = oLat;
        }
      }

      const onSameTube = Math.abs(dLat) < CAR_WID + 0.55 ||
        Math.abs((carLatNow - baseLat) - dnNow) < CAR_WID + 0.55 ||
        (st.extra >= dnMin - (CAR_WID + 0.45) && st.extra <= dnMax + (CAR_WID + 0.45));
      if (sLon > 0 && sLon < 58 && onSameTube && sLon < directLeadS) {
        directLeadS = sLon;
        directLead = nb;
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
        const penetration = (CAR_WID + 1.35) - Math.abs(nb.dLat);
        const push = clamp(penetration / 1.35, 0, 1) * 0.24;
        guardSteer += (nb.dLat >= 0 ? -push : push);
      }
    }

    const HARD_LAT_SEP = CAR_WID + 0.24;
    const limHere = model.corridorArr[idx] + (isLowPerf ? 0.08 : 0.26);
    const minLat = -limHere, maxLat = limHere;

    st.lockTimer = Math.max(0, (st.lockTimer || 0) - safeDt);
    if (st.lockTimer === 0) st.lockedLat = null;

    let bestCand = baseLat;
    if (hasLeftAlongside && hasRightAlongside && (leftWallCarLat - rightWallCarLat) < SAFE_SEP * 2.08) {
      const clearGap = (leftWallCarLat - rightWallCarLat) - CAR_WID;
      bestCand = clamp((leftWallCarLat + rightWallCarLat) * 0.5, minLat, maxLat);
      if (clearGap < CAR_WID + 0.30) squeezeBailout = true;
    } else if (nbs.length > 0) {
      let bestScore = -1e9;
      const canDefend = !!(closePursuer && !directLead && !isExitingCorner && !isIsolatedExit);

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
          if (!leadOnInside && candExtra * inside > 0.05) {
            score += INSIDE_BONUS;
          } else if (leadOnInside && directLead.oBraking && (cLat - directLead.oPredLat) * inside < -1.4) {
            score += INSIDE_BONUS * 0.85;
          }
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
                (nb.oLat < carLatNow && cLat < nb.oLat + HARD_LAT_SEP * 0.8)) {
              score -= 8000;
            }
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
              if (ttc < 2.0) {
                if (latDistCenter < SAFE_SEP) {
                  const urgency = clamp((2.0 - ttc) / 1.5, 0.2, 2.5);
                  const ov = (SAFE_SEP - latDistCenter) / SAFE_SEP;
                  score -= 55 * urgency * ov;
                }
                if (ttc < 1.15 && Math.abs(carLatNow - nb.oLat) < CAR_WID + 0.45) {
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
    }

    if (Math.abs(bestCand - baseLat) > 0.85 &&
        Math.abs(bestCand - (st.lockedLat != null ? st.lockedLat : 999)) > 0.75) {
      st.lockedLat = bestCand;
      st.lockTimer = 1.55;
    }

    st.abortCool = Math.max(0, (st.abortCool || 0) - safeDt);
    if (directLead) {
      const offLine = Math.abs(st.extra) > 1.5;
      const stillBehind = directLead.sLon > 3;
      const notFaster = !(v > directLead.v + 1.8 || prof.v[idx] > directLead.v + 1.8);
      st.lingering = (offLine && stillBehind && notFaster) ? (st.lingering || 0) + safeDt : 0;
      if (st.lingering > ABORT_TIME) {
        st.abortCool = 1.1;
        st.lingering = 0;
      }
    } else {
      st.lingering = 0;
    }
    if (st.abortCool > 0) bestCand = baseLat;

    extraTarget = clamp(bestCand - baseLat, -5.2, 5.2);

    // Full-Range Predictive Anti-Rear-End Envelope
    for (let k = 0; k < nbs.length; k++) {
      const nb = nbs[k];
      if (nb.sLon <= 0) continue;
      const gap = nb.sLon - CAR_LEN;
      const closing = v - nb.v;

      const bodyOverlapNow = Math.abs(nb.dLat) < CAR_WID + 0.36 || Math.abs(carLatNow - nb.oLat) < CAR_WID + 0.36;
      if (gap < 1.15 && closing > 0.4 && Math.abs(nb.dLat) < CAR_WID + 0.32) {
        emergency = true;
      }
      if (bodyOverlapNow && gap < closing * 0.26 + 0.9 && closing > 3.5) {
        emergency = true;
      }

      const targetOverlapTube =
        Math.abs(extraTarget - nb.dnNow) < SAFE_SEP * 0.92 ||
        Math.abs(extraTarget - nb.dnPred) < SAFE_SEP * 0.92 ||
        Math.abs(bestCand - nb.oPredLat) < SAFE_SEP * 0.92 ||
        (apex && nb.sLon < apex.dist + 10 && extraTarget >= nb.dnMin - CAR_WID && extraTarget <= nb.dnMax + CAR_WID);

      const pullOutNotClearYet = bodyOverlapNow && gap < Math.max(3.5, closing * 0.32);

      if (targetOverlapTube || pullOutNotClearYet) {
        const oppBrakeDrop = nb.o.inBrake === 2 ? 2.2 : (nb.oBraking ? 1.1 : 0);
        const oppEffV = Math.max(0, nb.v - oppBrakeDrop);
        const dynamicMargin = GAP_ADD + (nb.oBraking ? 1.1 : 0.28) + (apex && nb.sLon < apex.dist + 15 ? 0.55 : 0);
        const safeGap = Math.max(0.18, gap - dynamicMargin);

        let cap = Math.sqrt(oppEffV * oppEffV + 2 * brake * 0.87 * safeGap);

        if (targetOverlapTube && nb.oCornerV < oppEffV - 1.5 && gap < 48) {
          const cornerQueueGap = Math.max(0.18, gap + 10.5 - dynamicMargin);
          const cornerCap = Math.sqrt(nb.oCornerV * nb.oCornerV + 2 * brake * 0.87 * cornerQueueGap);
          if (cornerCap < cap) cap = cornerCap;
        }

        if (cap < followCap) followCap = cap;
      }
    }
  }

  // Tactical Track-Out & S-Curve Setup Bias when clear of traffic (from gemini-driver)
  let tacticalShift = 0;
  if (Math.abs(extraTarget) < 0.15 && (!otherCars || otherCars.length <= 1 || Math.abs(st.extra) < 0.25)) {
    if (isIsolatedExit && cSign !== 0 && !isLowPerf) {
      const outerAsphalt = -cSign * model.corridorArr[idx24];
      tacticalShift = clamp((outerAsphalt - model.off[idx24]) * (0.32 * exitProgress), -1.1, 1.1);
    } else if (isPastApex && hasNextReverseCorner && nextReverseSign !== 0) {
      const nextOuter = -nextReverseSign * model.corridorArr[idx24] * 0.85;
      tacticalShift = clamp((nextOuter - model.off[idx24]) * 0.24, -0.9, 0.9);
    }
  }

  const rate = rearUrgentThreat ? 9.2 : (Math.abs(extraTarget) > Math.abs(st.extra) ? 8.5 : (isIsolatedExit ? 6.2 : 4.8));
  st.extra += clamp(extraTarget - st.extra, -rate * safeDt, rate * safeDt);

  /* ---- 4) Longitudinal Velocity Profile + Sub-Step Release + Isolated-Exit Speed Boost ---- */
  const dxSeg = car.x - model.px[idx], dySeg = car.y - model.py[idx];
  const sProj = clamp((dxSeg * model.tx[idx] + dySeg * model.ty[idx]) / Math.max(0.5, model.ds[idx]), 0, 1);

  let vt;
  if (prof.v[j1] < prof.v[idx]) {
    vt = prof.v[idx] + (prof.v[j1] - prof.v[idx]) * clamp(sProj + 0.35, 0, 1);
  } else {
    vt = Math.max(prof.v[idx], prof.v[idx] + (prof.v[j1] - prof.v[idx]) * clamp(sProj + 0.68, 0, 1));
    if (isExitingCorner || isIsolatedExit) {
      const headErr = Math.abs(wrapAngle(Math.atan2(model.ty[j1], model.tx[j1]) - car.angle));
      if (headErr < 0.28) {
        vt = Math.max(vt, 0.45 * prof.v[j1] + 0.55 * prof.v[j2]);
      }
      if (isIsolatedExit && apexReleaseCap) {
        vt = Math.max(vt, Math.min(prof.vmax, apexReleaseCap[idx12] * (isLowPerf ? 0.96 : 1.02)));
      }
    }
  }

  const scanCapM = Math.max(240, (v * v) / (2 * brakeFull * 0.5) + 60);
  const scanSteps = Math.min(M_N - 2, Math.max(10, Math.round(scanCapM / Math.max(0.5, model.ds[idx]))));
  let aReq = 0, accD = Math.max(0.1, (1.0 - sProj) * model.dsLine[idx]);
  for (let s = 1; s <= scanSteps; s++) {
    if (s > 1) accD += Math.max(0.2, model.dsLine[stepIndex(idx, s - 1, M_N, model.closed)]);
    const cap = prof.vCornerPure[stepIndex(idx, s, M_N, model.closed)];
    if (cap < v) {
      const need = (v * v - cap * cap) / (2 * accD);
      if (need > aReq) aReq = need;
    }
  }

  const offLineDist = Math.abs(carLatNow - (model.off[idx] + tacticalShift));
  const offDeadband = isLowPerf ? 1.15 : 1.65;
  if (offLineDist > offDeadband && !isExitingCorner && !isIsolatedExit) {
    const offPenaltyScale = isLowPerf ? 1.55 : 0.92;
    vt *= clamp(1 - (offLineDist - offDeadband) * model.kmax[idx] * offPenaltyScale, isLowPerf ? 0.86 : 0.93, 1.0);
  }

  const trackErr = Math.abs(carLatNow - (model.off[idx] + st.extra + tacticalShift));
  if (trackErr > 6.0) vt = Math.min(vt, 24);
  else if (trackErr > 4.2) vt = Math.min(vt, 55);
  else if (trackErr > 2.8) vt = Math.min(vt, 90);

  // Active Boundary Speed-Bleed for Low-Grip / Understeering Cars (0% grass safeguard)
  const hwNow = (typeof hw !== "undefined" && hw[idx]) ? hw[idx] : 7.0;
  const vOutward = Math.sign(carLatNow) * vLatCar;
  const predLatEdge = Math.abs(carLatNow + vLatCar * 0.28);
  const safeEdge = hwNow - (isLowPerf ? 2.28 : 2.04);
  const edgeExcess = predLatEdge - safeEdge;
  if (edgeExcess > 0 && vOutward > -0.3) {
    const edgeUrgency = clamp(edgeExcess / 0.85, 0, 1.5);
    const edgeSpeedCap = Math.max(12.0, prof.vCornerPure[idx] * (1.0 - edgeUrgency * 0.22) - Math.max(0, vOutward) * 2.8);
    if (edgeSpeedCap < vt) vt = edgeSpeedCap;
  }

  if (squeezeBailout) vt = Math.min(vt, v - 2.5);
  if (followCap < vt) vt = followCap;

  /* ---- 5) Phase-Adaptive Dual-Point Continuous Arc-Length Pursuit + PD Tracking ---- */
  const lookNearDist = clamp(
    (isIsolatedExit ? (5.8 + 2.5 * exitProgress) : (isExitingCorner ? 5.3 : 4.8)) +
    v * (isIsolatedExit ? (0.22 + 0.08 * exitProgress) : (isExitingCorner ? 0.20 : 0.175)),
    5.8,
    40.0
  );
  const lookFarDist = clamp(lookNearDist * (isIsolatedExit ? 1.65 : 1.38), 8.5, 58.0);

  const sNear = sampleModelAtDist(model, idx, lookNearDist);
  const sFar = sampleModelAtDist(model, idx, lookFarDist);

  const extraScaleNear = (isExitingCorner || isIsolatedExit) && Math.abs(extraTarget) < 0.2 ? 0.65 : 1.0;
  const limNear = sNear.lim + (isLowPerf ? 0.08 : 0.28);
  const limFar = sFar.lim + (isLowPerf ? 0.08 : 0.28);

  const latNear = clamp(sNear.off + st.extra * extraScaleNear + tacticalShift * 0.65, -limNear, limNear);
  const latFar = clamp(sFar.off + st.extra * extraScaleNear + tacticalShift, -limFar, limFar);

  const txNear = sNear.px + sNear.nx * latNear;
  const tyNear = sNear.py + sNear.ny * latNear;
  const txFar = sFar.px + sFar.nx * latFar;
  const tyFar = sFar.py + sFar.ny * latFar;

  // On isolated corner exit, blend toward the far exit point to unwind steering immediately
  const wFar = isIsolatedExit ? (0.32 + 0.28 * exitProgress) : (inCorner ? 0.14 : 0.25);
  const wNear = 1.0 - wFar;

  const dx = wNear * (txNear - car.x) + wFar * (txFar - car.x);
  const dy = wNear * (tyNear - car.y) + wFar * (tyFar - car.y);
  const tx = car.x + dx;
  const ty = car.y + dy;

  const alpha = wrapAngle(Math.atan2(dy, dx) - car.angle);
  const alphaFar = wrapAngle(Math.atan2(tyFar - car.y, txFar - car.x) - car.angle);
  const dist = Math.max(Math.hypot(dx, dy), 1.0);
  const kappa = (2 * Math.sin(alpha)) / dist;

  /* ---- 6) Hysteresis Braking & True Full-Throttle Exit Launch (Fixing brake=1 throttle block) ---- */
  const heavyTrigger = Math.max(lightA * 1.05, prof.brake * (isLowPerf ? 0.93 : 0.97));
  const isBrakingSeg = prof.v[j1] < prof.v[idx] - 0.12;
  if (aReq > heavyTrigger || (isBrakingSeg && v > vt + 0.52)) {
    st.inHeavyBrake = true;
  } else if (v <= vt + 0.12 && aReq < prof.brake * 0.82) {
    st.inHeavyBrake = false;
  }

  let brakeCmd = 0;
  if (emergency) {
    brakeCmd = 2;
  } else if (rearUrgentThreat && followCap === Infinity && v < vt * 1.03 && aReq < brakeFull * 0.96) {
    brakeCmd = v > vt + 0.4 ? 1 : 0;
  } else if (st.inHeavyBrake) {
    brakeCmd = 2;
  } else if (v > vt + (isExitingCorner ? 0.65 : 0.24) && !isIsolatedExit) {
    brakeCmd = 1;
  } else {
    brakeCmd = 0;
  }

  // Exact Friction-Circle lateral grip reduction on omegaMax (§6.1 & §6.2)
  const plannedLongA = brakeCmd === 2 ? brakeFull : (brakeCmd === 1 ? lightA : 0);
  const effLongA = Math.max(Math.abs(car.accel || 0), plannedLongA * 0.85);
  const usedLong = clamp(effLongA / brakeFull, 0, 1);
  const latFloor = PHYS.frictionLatFloor != null ? PHYS.frictionLatFloor : 0.6;
  const latAvail = latGrip * Math.sqrt(Math.max(latFloor, 1.0 - usedLong * usedLong));
  const surfScale = car.surf === 2 ? 0.74 : 1.0;
  const omegaMax = Math.min(maxOmega, latAvail / Math.max(v, 1.0)) * Math.min(1.0, v / 3.0) * surfScale;

  let steer = omegaMax > 1e-5 ? clamp((v * kappa) / omegaMax, -1, 1) : 0;

  // PD lateral error correction (attenuated during isolated exit track-out so it never fights exit unwind)
  const pdScale = isIsolatedExit ? (1.0 - 0.55 * exitProgress) : 1.0;
  const latErrSigned = carLatNow - (model.off[idx] + st.extra + tacticalShift);
  const latCorr = clamp(-(latErrSigned * 0.10 + vLatCar * 0.068) * pdScale, -0.26, 0.26);
  steer = clamp(steer + latCorr, -1, 1);

  if (edgeExcess > 0) {
    const edgePull = -Math.sign(carLatNow) * clamp(edgeExcess * 0.32, 0, 0.38);
    steer = clamp(steer + edgePull, -1, 1);
  } else {
    steer = clamp(steer + clamp(guardSteer, -0.30, 0.30), -1, 1);
  }

  // Understeer rescue near outer asphalt edge: step down heavy brake (2 -> 1) to recover lateral grip
  if (!emergency && brakeCmd === 2 && Math.abs(steer) > 0.84 && edgeExcess > -0.15 && v < vt + 3.5) {
    brakeCmd = 1;
  }

  // CRITICAL ENGINE RULE (§5): out.up ONLY works when out.brake === 0!
  // When ready for Trail-Braking Launch or Isolated-Exit Full-Throttle Launch, explicitly release brakeCmd = 0!
  const steerMag = Math.abs(steer);
  const earlyExitLaunch = !emergency && !squeezeBailout && brakeCmd === 1 && edgeExcess <= 0 && (
    (isIsolatedExit && Math.abs(alphaFar) < 0.30 && v < vt + 0.55) ||
    (steerMag > 0.10 && steerMag < 0.68 && Math.abs(alpha) < 0.32 && v < vt + 0.45 && aReq < lightA * 0.82)
  );
  if (earlyExitLaunch) {
    brakeCmd = 0;
  }

  // Prevent stationary reverse gear (§5.2)
  if (v < 0.55 && brakeCmd === 2) {
    brakeCmd = 1;
  }

  // Eliminate top-speed throttle duty-cycling: hold full throttle continuously when at vmax on straights
  const isFullSpeedZone = vt >= prof.vmax - 0.08 && aReq < lightA * 0.5;
  const upCmd = Boolean(
    !emergency &&
    !squeezeBailout &&
    brakeCmd === 0 &&
    (isFullSpeedZone ? v <= prof.vmax + 0.5 : v < vt - 0.01)
  );

  out.steer = Number.isFinite(steer) ? steer : 0;
  out.brake = (brakeCmd === 2 || brakeCmd === 1) ? brakeCmd : 0;
  out.up = upCmd;
  out.left = out.steer < -0.02;
  out.right = out.steer > 0.02;
  out.targetX = Number.isFinite(tx) ? tx : model.px[idx];
  out.targetY = Number.isFinite(ty) ? ty : model.py[idx];
  out.targetSpeed = Number.isFinite(vt) ? vt : prof.v[idx];
}