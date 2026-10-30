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
export let h = new Float32Array(0);      // 中心线高度（米，相对起终点；非 DEM 赛道 ≥0）
export let bank = new Float32Array(0);   // 横坡角（弧度，>0 = +nor 侧更高；由曲率导出 → 弯道外高内低）
export let grade = new Float32Array(0);  // 纵向坡度 dh/ds（沿行进方向，+ = 上坡）
export let bridges = [];                 // 立交桥位 [{ s: 弧长, h: 桥面高 }]（track3d 画桥墩用）
export let terrainAt = null;             // 周边 DEM 地形采样 (x,z)=>y；无地形数据的赛道为 null

const trackChangeListeners = [];
export function onTrackChange(fn) {
  trackChangeListeners.push(fn);
}

/* ================= 赛道上下文：构建（纯函数）与激活（挂全局绑定） =================

浏览器沿用全局激活态（行为与旧版完全一致）；服务端多房间场景下，
每个房间持有自己的 ctx（createTrackContext 构建，互不干扰），
tick 前调用 activateContext 切换到房间赛道即可（单线程内逐房间激活是原子的）。
*/

/* 每赛道周边 DEM 地形网格 → 世界坐标双线性采样器。
   数据存本地米制（x 东 / y 北、相对起终点高程），这里按与 pts 相同的
   平移缩放（minx/miny/K/MARGIN）映射到世界坐标；超出网格按边缘值钳制。 */
function makeTerrainSampler(td, minx, miny, K) {
  if (!td || !Array.isArray(td.h) || td.nx < 2 || td.ny < 2) return null;
  const x0 = (td.x0 - minx) * K + MARGIN;
  const y0 = (td.y0 - miny) * K + MARGIN;
  const dx = td.cell * K, dy = td.cell * K;
  const nx = td.nx, ny = td.ny, hh = td.h;
  return (x, z) => {
    let fx = (x - x0) / dx, fz = (z - y0) / dy;
    fx = fx < 0 ? 0 : fx > nx - 1 ? nx - 1 : fx;
    fz = fz < 0 ? 0 : fz > ny - 1 ? ny - 1 : fz;
    const ix = Math.min(nx - 2, Math.floor(fx)), iz = Math.min(ny - 2, Math.floor(fz));
    const tx = fx - ix, tz = fz - iz;
    const a = hh[iz * nx + ix], b = hh[iz * nx + ix + 1];
    const c = hh[(iz + 1) * nx + ix], d = hh[(iz + 1) * nx + ix + 1];
    return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
  };
}

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

  /* ================= 纵向剖面：规律的起伏 + 弯道外高（banking） =================
     剖面全部建立在弧长 cumDist 上（采样点按参数均匀、非等距，不能按下标换算）。
     高度 = 整数谐波正弦叠加（环形自动闭合、C∞ 连续），并乘发车区渐入窗：
     起终点前后 TAPER_M 内高度与横坡一起压回 0，与维修区/龙门架/看台所在的地面衔接。
     高度下限 0.6m·taper —— 赛道始终不低于草地，用裙边（embankment）过渡到地面。
     bank = -bankK·curvS：curvS>0 时弯心在 +nor 侧 → 外侧（-nor）更高，即真实
     赛道的 superelevation；线性冲刺道与低起伏赛道自然趋零。
     横坡以「弯心侧边缘」为支点抬高整幅路面（见下方 LIFT 注释）：只有外缘上升，
     内缘保持中心线高度 —— 否则内缘会沉到草地基线（0）以下，被起伏地面网格盖住。 */
  const hAmp = track.hills ?? 3.2;
  const bankK = track.bankK ?? 8.0;      // R50 发卡 → 7.4° 横坡；R200 弯 → 2.3°
  const bankMax = track.bankMax ?? 0.13;
  const TAPER_M = 350;
  const hArr = new Float32Array(N);
  const bankArr = new Float32Array(N);
  const gradeArr = new Float32Array(N);
  const taperArr = new Float32Array(N).fill(1);   // 发车区渐入窗（h 与 bank 共用）
  if (!ctxIsLinear) {
    const L = ctxLAP_LENGTH;
    for (let i = 0; i < N; i++) {
      const d = Math.min(cumDist[i], L - cumDist[i]);
      const f = Math.min(1, d / TAPER_M);
      taperArr[i] = f * f * (3 - 2 * f);
    }
  }
  // 真实海拔剖面（赛道定义里带 elev 时）：控制点键控 + Catmull-Rom 平滑，
  // 数据已按起终点归一化（elev[0]=0）。真实赛道不乘发车区渐入窗 ——
  // 起终点附近本来就是真实坡道，压平反而失真；h(0)=0 由数据保证。
  if (Array.isArray(track.elev) && track.elev.length > 1 && !ctxIsLinear) {
    const ev = track.elev, nK = ev.length, sub = track.sub || 8;
    for (let i = 0; i < N; i++) {
      const q = i / sub;
      const k = Math.floor(q), f = q - k;
      const p0 = ev[(k - 1 + nK) % nK], p1 = ev[k % nK];
      const p2 = ev[(k + 1) % nK], p3 = ev[(k + 2) % nK];
      hArr[i] = 0.5 * (2 * p1 + (-p0 + p2) * f
        + (2 * p0 - 5 * p1 + 4 * p2 - p3) * f * f
        + (-p0 + 3 * p1 - 3 * p2 + p3) * f * f * f);
    }
  } else if (hAmp > 0 && !ctxIsLinear) {
    const L = ctxLAP_LENGTH;
    // 波长按赛道长度等比缩放；k 取整数保证首尾闭合
    const k1 = 2;
    const k2 = Math.max(3, Math.round(6 * L / 5451));
    const k3 = Math.max(5, Math.round(14 * L / 5451));
    for (let i = 0; i < N; i++) {
      const s = cumDist[i];
      const w = 0.50 * Math.sin(2 * Math.PI * k1 * s / L)
        + 0.34 * Math.sin(2 * Math.PI * k2 * s / L + 1.7)
        + 0.16 * Math.sin(2 * Math.PI * k3 * s / L + 4.2);   // ∈ [-1, 1]
      hArr[i] = taperArr[i] * (0.6 + (hAmp - 0.6) * (w + 1) * 0.5);
    }
  }

  /* ---- 交叉 / 贴邻路段 → 立交桥面隆起 ----
     非邻接路段（采样间隔 ≥50 点）平面净距 <30m 视为交叉/贴邻：
     对后到分支施加平滑隆起，净空 = clamp((30 - 净距)·0.55, 0, 7.5)，
     真自交（净距≈0）→ 7.5m 立交；≥2m 才值得建。隆起分支避开发车渐入区，
     与已接受桥位重叠（±380m）时保留更高者。track3d 用 bridges 画桥墩。 */
  const bridges = [];
  {
    const CLEAR = 30, GAP_I = 50;
    const found = [];
    for (let i = 0; i < N; i++) {
      for (let j = i + GAP_I; j < N; j++) {
        const dx = pts[j].x - pts[i].x, dy = pts[j].y - pts[i].y;
        const d2 = dx * dx + dy * dy;
        if (d2 > CLEAR * CLEAR) continue;
        const idxGap = Math.min(j - i, N - (j - i));
        if (idxGap < GAP_I) continue;
        let dup = false;
        for (const f of found) {
          if (Math.abs(f.sA - cumDist[i]) < 120 && Math.abs(f.sB - cumDist[j]) < 120) {
            if (d2 < f.d2) { f.d2 = d2; f.i = i; f.j = j; f.sA = cumDist[i]; f.sB = cumDist[j]; }
            dup = true; break;
          }
        }
        if (!dup) found.push({ i, j, d2, sA: cumDist[i], sB: cumDist[j] });
      }
    }
    for (const f of found) {
      const d = Math.sqrt(f.d2);
      const lift = Math.min(7.5, (CLEAR - d) * 0.55);
      if (lift < 2) continue;
      let s = f.sB;
      if (Math.min(s, ctxLAP_LENGTH - s) < TAPER_M + 60) {
        s = f.sA;
        if (Math.min(s, ctxLAP_LENGTH - s) < TAPER_M + 60) continue;
      }
      if (bridges.some(b => Math.abs(b.s - s) < 380)) continue;
      bridges.push({ s, h: lift });
    }
    // 桥面隆起：±W 平滑台地（smoothstep），叠加到谐波剖面上
    const W = 190;
    for (const b of bridges) {
      for (let i = 0; i < N; i++) {
        let ds = Math.abs(cumDist[i] - b.s);
        if (!ctxIsLinear) ds = Math.min(ds, ctxLAP_LENGTH - ds);
        if (ds >= W) continue;
        const t = 1 - ds / W;
        hArr[i] += b.h * t * t * (3 - 2 * t);
      }
    }
  }
  // 横坡：符号曲率直接导出，再 13 点平滑让进弯渐入/出弯渐出无棱角
  for (let i = 0; i < N; i++) {
    const b = -curvS[i] * bankK;
    bankArr[i] = b < -bankMax ? -bankMax : b > bankMax ? bankMax : b;
  }
  const bankSm = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    let s = 0;
    for (let k = -6; k <= 6; k++) {
      const j = ctxIsLinear ? Math.min(Math.max(i + k, 0), N - 1) : (i + k + N) % N;
      s += bankArr[j];
    }
    bankSm[i] = (s / 13) * taperArr[i];   // 发车区压平，与 h 同一渐入窗
  }
  /* ---- 弯道内缘抬升（LIFT）----
     横坡让内缘比中心线低 |bank|·hw。若中心线本身接近草地基线（0），
     内缘就会沉到 0 以下，起伏地面的三角形会从外侧高点斜切过整条下沉路面，
     草地直接盖在弯道内侧上。因此把整幅路面抬高 |bank|·hw，
     使内缘恰好回到原中心线高度（≥0.6m·taper）：只有弯道外侧升高，
     任何路面点都不低于草地基线。 */
  for (let i = 0; i < N; i++) {
    hArr[i] += Math.abs(bankSm[i]) * hw[i];
  }
  // 纵向坡度：中心差分（抬升后再算；用相邻采样点的真实弧长间距，线性赛道端点单侧差分）
  for (let i = 0; i < N; i++) {
    const a = ctxIsLinear ? Math.max(i - 1, 0) : (i - 1 + N) % N;
    const b = ctxIsLinear ? Math.min(i + 1, N - 1) : (i + 1) % N;
    let ds = cumDist[b] - cumDist[a];
    if (!ctxIsLinear && ds < 0) ds += ctxLAP_LENGTH;   // 跨起终点线：cumDist 回绕
    ds = Math.max(0.5, ds);
    gradeArr[i] = (hArr[b] - hArr[a]) / ds;
  }

  return {
    id: track.id,
    track,
    LAP_LENGTH: ctxLAP_LENGTH,
    HW: ctxHW,
    HW_WIDE: ctxHW_WIDE,
    isLinear: ctxIsLinear,
    WORLD, pts, N, tan, nor, curv, curvS, kerbFlag, hw, cumDist,
    h: hArr, bank: bankSm, grade: gradeArr, bridges,
    terrainAt: makeTerrainSampler(track.terrain, minx, miny, K)
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
  h = ctx.h;
  bank = ctx.bank;
  grade = ctx.grade;
  bridges = ctx.bridges;
  terrainAt = ctx.terrainAt;

  // 通知所有监听器
  for (const fn of trackChangeListeners) {
    try { fn(currentTrack); } catch (e) { console.error(e); }
  }

  return currentTrack;
}

export function switchTrack(trackId) {
  return activateContext(createTrackContext(trackId));
}

/* ============ 纵向剖面采样（物理 / 渲染 / 特效共用的权威入口） ============ */

// 弧长 s → { i, f, y, grade, bank }：中心线高度与坡度/横坡的弧长线性插值。
// y 为中心线高度；横向偏移处的路面高度 = y + bank·dLat（调用方叠加，见 roadElev）。
export function roadAt(s) {
  const i = indexAtDistance(s);
  const j = isLinear ? Math.min(i + 1, N - 1) : (i + 1) % N;
  let ds = cumDist[j] - cumDist[i];
  if (!isLinear && ds <= 0) ds += LAP_LENGTH;         // 最后一段跨起终点线
  ds = Math.max(0.5, ds);
  const f = Math.max(0, Math.min(1, ((Number(s) || 0) - cumDist[i]) / ds));
  return {
    i, f,
    y: h[i] * (1 - f) + h[j] * f,
    grade: grade[i] * (1 - f) + grade[j] * f,
    bank: bank[i] * (1 - f) + bank[j] * f
  };
}

// 采样点 i、横向偏移 off（沿 +nor，米）处的路面高度。track3d 顶点抬升统一走这里。
export function roadElev(i, off) {
  return h[i] + bank[i] * off;
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
