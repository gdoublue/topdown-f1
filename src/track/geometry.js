// 赛道几何：Catmull-Rom 样条、真实比例缩放、起终点对齐、变宽度、多赛道动态切换
import { MARGIN } from "../config.js";
import { getTrack, DEFAULT_TRACK_ID, TRACKS } from "./tracks.js";

function catmullRom(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  return {
    x: 0.5 * (2 * p1[0] + (-p0[0] + p2[0]) * t
      + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2
      + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
    y: 0.5 * (2 * p1[1] + (-p0[1] + p2[1]) * t
      + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2
      + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3)
  };
}

function buildCenterline(ctrl, sub) {
  const n = ctrl.length, out = [];
  for (let i = 0; i < n; i++) {
    const p0 = ctrl[(i - 1 + n) % n], p1 = ctrl[i];
    const p2 = ctrl[(i + 1) % n], p3 = ctrl[(i + 2) % n];
    for (let j = 0; j < sub; j++) out.push(catmullRom(p0, p1, p2, p3, j / sub));
  }
  return out;
}

// 线性赛道：沿控制点折线等距细分（不闭合、不回绕）
function buildLinearCenterline(ctrl, sub) {
  const out = [];
  for (let i = 0; i < ctrl.length - 1; i++) {
    for (let j = 0; j < sub; j++) {
      const t = j / sub;
      out.push({
        x: ctrl[i][0] + (ctrl[i + 1][0] - ctrl[i][0]) * t,
        y: ctrl[i][1] + (ctrl[i + 1][1] - ctrl[i][1]) * t
      });
    }
  }
  out.push({ x: ctrl[ctrl.length - 1][0], y: ctrl[ctrl.length - 1][1] });
  return out;
}

export let currentTrack = getTrack(DEFAULT_TRACK_ID);
export let currentTrackId = currentTrack.id;
export let LAP_LENGTH = currentTrack.length;
export let HW = currentTrack.hw;
export let HW_WIDE = currentTrack.hwWide;
export let isLinear = !!currentTrack.linear;   // 线性赛道：起点→终点不闭合，单程计赛

export let pts = [];
export let WORLD = { w: 1000, h: 1000 };
export let N = 0;
export let tan = [];
export let nor = [];
export let curv = new Float32Array(0);
export let curvS = new Float32Array(0);
export let kerbFlag = new Uint8Array(0);
export let hw = new Float32Array(0);
export let cumDist = new Float32Array(0);

const trackChangeListeners = [];
export function onTrackChange(fn) {
  trackChangeListeners.push(fn);
}

/* ================= 赛道上下文：构建（纯函数）与激活（挂全局绑定） =================

浏览器沿用全局激活态（行为与旧版完全一致）；服务端多房间场景下，
每个房间持有自己的 ctx（createTrackContext 构建，互不干扰），
tick 前调用 activateContext 切换到房间赛道即可（单线程内逐房间激活是原子的）。
*/

// 构建（不激活）一份赛道上下文快照
export function createTrackContext(trackId = DEFAULT_TRACK_ID) {
  const track = getTrack(trackId);
  const ctxLAP_LENGTH = track.length;
  const ctxHW = track.hw;
  const ctxHW_WIDE = track.hwWide;
  const ctxIsLinear = !!track.linear;

  const raw = ctxIsLinear
    ? buildLinearCenterline(track.ctrl, track.sub || 8)
    : buildCenterline(track.ctrl, track.sub || 8);
  let L0 = 0;
  for (let i = 0; i < raw.length - 1; i++) {
    L0 += Math.hypot(raw[i + 1].x - raw[i].x, raw[i + 1].y - raw[i].y);
  }
  if (!ctxIsLinear) {
    L0 += Math.hypot(raw[0].x - raw[raw.length - 1].x, raw[0].y - raw[raw.length - 1].y);
  }
  // 线性赛道按 1:1 米授权（length = 计时比赛里程，控制点可延长出冲线缓冲区）
  const K = ctxIsLinear ? 1 : ctxLAP_LENGTH / L0;

  let minx = 1e9, miny = 1e9;
  for (const p of raw) {
    if (p.x < minx) minx = p.x;
    if (p.y < miny) miny = p.y;
  }

  const WORLD = {
    w: (Math.max(...raw.map(p => p.x)) - minx) * K + 2 * MARGIN,
    h: (Math.max(...raw.map(p => p.y)) - miny) * K + 2 * MARGIN
  };

  const ptsRaw = raw.map(p => ({
    x: (p.x - minx) * K + MARGIN,
    y: (p.y - miny) * K + MARGIN
  }));

  // 起终点线对齐（如果有 sf 点则旋转到最近点；线性赛道固定从第 0 点出发，不旋转）
  let bi = 0;
  if (!ctxIsLinear && track.sf) {
    const sf = {
      x: (track.sf.x - minx) * K + MARGIN,
      y: (track.sf.y - miny) * K + MARGIN
    };
    let best = Infinity;
    for (let i = 0; i < ptsRaw.length; i++) {
      const dx = ptsRaw[i].x - sf.x, dy = ptsRaw[i].y - sf.y;
      const d = dx * dx + dy * dy;
      if (d < best) { best = d; bi = i; }
    }
  }

  const rotated = ctxIsLinear
    ? ptsRaw
    : ptsRaw.slice(bi).concat(ptsRaw.slice(0, bi)).map(p => ({ x: p.x, y: p.y }));
  const pts = rotated;
  const N = pts.length;

  // 切线与法线（线性赛道端点用单侧差分，不跨首尾回绕）
  const tan = [];
  const nor = [];
  for (let i = 0; i < N; i++) {
    const a = ctxIsLinear ? pts[Math.max(i - 1, 0)] : pts[(i - 1 + N) % N];
    const b = ctxIsLinear ? pts[Math.min(i + 1, N - 1)] : pts[(i + 1) % N];
    let dx = b.x - a.x, dy = b.y - a.y;
    const L = Math.hypot(dx, dy) || 1;
    dx /= L; dy /= L;
    tan.push({ x: dx, y: dy });
    nor.push({ x: -dy, y: dx });
  }

  // 曲率（线性赛道端点曲率自然为 0）
  const curv = new Float32Array(N);
  const curvS = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const a = ctxIsLinear ? pts[Math.max(i - 1, 0)] : pts[(i - 1 + N) % N];
    const b = pts[i];
    const c = ctxIsLinear ? pts[Math.min(i + 1, N - 1)] : pts[(i + 1) % N];
    const v1x = b.x - a.x, v1y = b.y - a.y;
    const v2x = c.x - b.x, v2y = c.y - b.y;
    const l1 = Math.hypot(v1x, v1y), l2 = Math.hypot(v2x, v2y);
    curv[i] = Math.atan2(v1x * v2y - v1y * v2x, v1x * v2x + v1y * v2y) / ((l1 + l2) * 0.5 || 1);
  }
  for (let i = 0; i < N; i++) {
    let s = 0;
    for (let k = -9; k <= 9; k++) {
      const j = ctxIsLinear ? Math.min(Math.max(i + k, 0), N - 1) : (i + k + N) % N;
      s += curv[j];
    }
    curvS[i] = s / 19;
  }

  // 路肩标记：曲率半径 < 110m 的弯道铺设路缘石。
  // 旧阈值 1/46（半径 <46m）比所有真实赛道的最小转弯半径还小
  // （上赛 50m / 蒙扎 37m / 银石 63m / 斯帕 47.5m / 红牛环 51m），
  // 结果全赛道几乎一块路肩都不画。
  const kerbFlag = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    if (Math.abs(curvS[i]) > 1 / 110) kerbFlag[i] = 1;
  }
  const src = kerbFlag.slice();
  for (let i = 0; i < N; i++) {
    if (src[i]) {
      for (let k = -4; k <= 4; k++) kerbFlag[(i + k + N) % N] = 1;
    }
  }

  // 变宽度（最紧弯心前后 ±110m 动态加宽；线性赛道全宽恒定）
  const segLen = ctxLAP_LENGTH / N;
  let iApex = 0;
  for (let i = 0; i < N; i++) {
    if (Math.abs(curvS[i]) > Math.abs(curvS[iApex])) iApex = i;
  }
  const hw = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    if (ctxIsLinear) { hw[i] = ctxHW; continue; }
    const d = Math.min(Math.abs(i - iApex), N - Math.abs(i - iApex)) * segLen;
    const f = Math.max(0, 1 - d / 110);
    const s = f * f * (3 - 2 * f);
    hw[i] = ctxHW + (ctxHW_WIDE - ctxHW) * s;
  }

  // 累计沿赛道中心线物理里程数组 (米，从起终点线 0 开始；线性赛道不回绕)
  const cumDist = new Float32Array(N + 1);
  cumDist[0] = 0;
  for (let i = 0; i < N; i++) {
    const next = ctxIsLinear ? Math.min(i + 1, N - 1) : (i + 1) % N;
    const dx = pts[next].x - pts[i].x;
    const dy = pts[next].y - pts[i].y;
    cumDist[i + 1] = cumDist[i] + Math.hypot(dx, dy);
  }
  if (ctxIsLinear) cumDist[N] = ctxLAP_LENGTH;

  return {
    id: track.id,
    track,
    LAP_LENGTH: ctxLAP_LENGTH,
    HW: ctxHW,
    HW_WIDE: ctxHW_WIDE,
    isLinear: ctxIsLinear,
    WORLD, pts, N, tan, nor, curv, curvS, kerbFlag, hw, cumDist
  };
}

// 激活上下文：挂到全局绑定并通知监听器（AI 走线数据重建等）
export function activateContext(ctx) {
  currentTrack = ctx.track;
  currentTrackId = ctx.id;
  LAP_LENGTH = ctx.LAP_LENGTH;
  HW = ctx.HW;
  HW_WIDE = ctx.HW_WIDE;
  isLinear = ctx.isLinear;
  WORLD = ctx.WORLD;
  pts = ctx.pts;
  N = ctx.N;
  tan = ctx.tan;
  nor = ctx.nor;
  curv = ctx.curv;
  curvS = ctx.curvS;
  kerbFlag = ctx.kerbFlag;
  hw = ctx.hw;
  cumDist = ctx.cumDist;

  // 通知所有监听器
  for (const fn of trackChangeListeners) {
    try { fn(currentTrack); } catch (e) { console.error(e); }
  }

  return currentTrack;
}

export function switchTrack(trackId) {
  return activateContext(createTrackContext(trackId));
}

/* 沿赛道物理距离（米）→ 最近采样下标。
   注意：采样点按 Catmull-Rom 的**参数**均匀，不是按米均匀（直道段距可能是弯道的 2 倍），
   所以不能用 round(米 / DS) —— DS 只是平均间距。这里按 cumDist 二分，误差 ≤1 个采样点。
   环形赛道自动取模；直线冲刺赛道钳制到 0 ~ N-1（cumDist[N] 在直线赛道是计时里程，不可用）。 */
export function indexAtDistance(meters) {
  const n = N;
  if (n <= 0) return 0;
  const m = Number(meters) || 0;
  if (isLinear) {
    const t = Math.max(0, Math.min(cumDist[n - 1], m));
    let lo = 0, hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (cumDist[mid] <= t) lo = mid; else hi = mid - 1;
    }
    return lo;
  }
  const L = LAP_LENGTH || cumDist[n] || 1;
  const t = ((m % L) + L) % L;
  let lo = 0, hi = n;                      // cumDist[0] = 0 … cumDist[N] = L
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (cumDist[mid] <= t) lo = mid; else hi = mid - 1;
  }
  return lo % n;
}

// 模块加载时立即初始化当前赛道
// 尝试从浏览器 URL 读取 track 参数 (如果存在 window)
let initId = DEFAULT_TRACK_ID;
if (typeof window !== "undefined" && window.location) {
  try {
    const p = new URLSearchParams(window.location.search).get("track");
    if (p && TRACKS.some(t => t.id === p)) initId = p;
  } catch (e) {}
}
switchTrack(initId);

/* 路径构建辅助：offset = base * 当地半宽 + delta（米） */
export function addLoop(g, base, delta) {
  delta = delta || 0;
  const last = isLinear ? N - 1 : N;
  for (let i = 0; i <= last; i++) {
    const k = isLinear ? Math.min(i, N - 1) : i % N;
    const off = base * hw[k] + delta;
    const x = pts[k].x + nor[k].x * off;
    const y = pts[k].y + nor[k].y * off;
    if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
  }
  if (!isLinear) g.closePath();
}

export function ringPath(g) {
  g.beginPath();
  if (isLinear) {
    // 线性赛道：沿 +hw 走到终点、再沿 -hw 折返，闭合成一条真正有面积的路面带
    // （旧的 addLoop(1)+addLoop(-1) 是两条开口折线，首尾自动闭合后面积为零，沥青根本填不出来）
    for (let i = 0; i < N; i++) {
      const x = pts[i].x + nor[i].x * hw[i], y = pts[i].y + nor[i].y * hw[i];
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    for (let i = N - 1; i >= 0; i--) {
      g.lineTo(pts[i].x - nor[i].x * hw[i], pts[i].y - nor[i].y * hw[i]);
    }
    g.closePath();
    return;
  }
  addLoop(g, 1);
  addLoop(g, -1);
}

export function centerPath(g) {
  g.beginPath();
  const last = isLinear ? N - 1 : N;
  for (let i = 0; i <= last; i++) {
    const k = isLinear ? Math.min(i, N - 1) : i % N;
    if (i === 0) g.moveTo(pts[k].x, pts[k].y); else g.lineTo(pts[k].x, pts[k].y);
  }
  if (!isLinear) g.closePath();
}
