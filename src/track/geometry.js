// 赛道几何：Catmull-Rom 样条、真实比例缩放、起终点对齐、变宽度
import { LAP_LENGTH, HW, HW_WIDE, MARGIN } from "../config.js";
import { CTRL } from "./data.js";

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

/* 缩放到真实比例：全圈长 = LAP_LENGTH 米（1 单位 = 1 米） */
const raw = buildCenterline(CTRL, 6);
let L0 = 0;
for (let i = 0; i < raw.length; i++) {
  L0 += Math.hypot(raw[(i + 1) % raw.length].x - raw[i].x, raw[(i + 1) % raw.length].y - raw[i].y);
}
const K = LAP_LENGTH / L0;

let minx = 1e9, miny = 1e9;
for (const p of raw) { minx = Math.min(minx, p.x); miny = Math.min(miny, p.y); }

// 官方地图格子旗线：旧世界坐标 (470.5, 319.6)（SVG(438,323) 经映射）
const SF_OLD = { x: 470.5, y: 319.6 };

export const pts = raw.map(p => ({
  x: (p.x - minx) * K + MARGIN,
  y: (p.y - miny) * K + MARGIN
}));
export const WORLD = {
  w: (Math.max(...raw.map(p => p.x)) - minx) * K + 2 * MARGIN,
  h: (Math.max(...raw.map(p => p.y)) - miny) * K + 2 * MARGIN
};

// 旋转采样数组，使 0 号采样 = 官方起终点线（行车方向不变，驶向 1 号弯）
(function alignStartLine() {
  const sf = { x: (SF_OLD.x - minx) * K + MARGIN, y: (SF_OLD.y - miny) * K + MARGIN };
  let best = Infinity, bi = 0;
  for (let i = 0; i < pts.length; i++) {
    const dx = pts[i].x - sf.x, dy = pts[i].y - sf.y;
    const d = dx * dx + dy * dy;
    if (d < best) { best = d; bi = i; }
  }
  const rotated = pts.slice(bi).concat(pts.slice(0, bi));
  for (let i = 0; i < pts.length; i++) { pts[i].x = rotated[i].x; pts[i].y = rotated[i].y; }
})();

export const N = pts.length;

// 切线 / 法线
export const tan = [];
export const nor = [];
for (let i = 0; i < N; i++) {
  const a = pts[(i - 1 + N) % N], b = pts[(i + 1) % N];
  let dx = b.x - a.x, dy = b.y - a.y;
  const L = Math.hypot(dx, dy) || 1;
  dx /= L; dy /= L;
  tan.push({ x: dx, y: dy });
  nor.push({ x: -dy, y: dx });
}

// 有符号曲率（1/m）
export const curv = new Float32Array(N);
export const curvS = new Float32Array(N);
for (let i = 0; i < N; i++) {
  const a = pts[(i - 1 + N) % N], b = pts[i], c = pts[(i + 1) % N];
  const v1x = b.x - a.x, v1y = b.y - a.y;
  const v2x = c.x - b.x, v2y = c.y - b.y;
  const l1 = Math.hypot(v1x, v1y), l2 = Math.hypot(v2x, v2y);
  curv[i] = Math.atan2(v1x * v2y - v1y * v2x, v1x * v2x + v1y * v2y)
    / ((l1 + l2) * 0.5 || 1);
}
for (let i = 0; i < N; i++) {
  let s = 0;
  for (let k = -9; k <= 9; k++) s += curv[(i + k + N) % N];
  curvS[i] = s / 19;
}

// 路肩标记：弯道处向两侧膨胀
export const kerbFlag = new Uint8Array(N);
for (let i = 0; i < N; i++) {
  if (Math.abs(curvS[i]) > 1 / 46) kerbFlag[i] = 1;
}
(function dilate() {
  const src = kerbFlag.slice();
  for (let i = 0; i < N; i++) {
    if (src[i]) for (let k = -4; k <= 4; k++) kerbFlag[(i + k + N) % N] = 1;
  }
})();

/* 变宽度：常规 14m，T14/T15 弯心（最紧弯）前后 ±110m 加宽到 20m */
const segLen = LAP_LENGTH / N;
let iApex = 0;
for (let i = 0; i < N; i++) {
  if (Math.abs(curvS[i]) > Math.abs(curvS[iApex])) iApex = i;
}
export const hw = new Float32Array(N);
for (let i = 0; i < N; i++) {
  const d = Math.min(Math.abs(i - iApex), N - Math.abs(i - iApex)) * segLen;
  const f = Math.max(0, 1 - d / 110);
  const s = f * f * (3 - 2 * f);            // smoothstep 过渡
  hw[i] = HW + (HW_WIDE - HW) * s;
}

/* 路径构建辅助：offset = base * 当地半宽 + delta（米） */
export function addLoop(g, base, delta) {
  delta = delta || 0;
  for (let i = 0; i <= N; i++) {
    const k = i % N;
    const off = base * hw[k] + delta;
    const x = pts[k].x + nor[k].x * off;
    const y = pts[k].y + nor[k].y * off;
    if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
  }
  g.closePath();
}

export function ringPath(g) {
  g.beginPath();
  addLoop(g, 1);
  addLoop(g, -1);
}

export function centerPath(g) {
  g.beginPath();
  for (let i = 0; i <= N; i++) {
    const k = i % N;
    if (i === 0) g.moveTo(pts[k].x, pts[k].y); else g.lineTo(pts[k].x, pts[k].y);
  }
  g.closePath();
}
