// 赛道 3D 渲染共享件：几何工厂（ribbon/quad）、程序化贴图、确定噪声、采样带。
// 被 track/props.js 与各赛道个性化模块（track/tracks/<id>.js）共用；
// 赛道权威数据一律 import 自 src/track/geometry.js（与物理判定同源）。
import * as THREE from "three";
import {
  pts, N, nor, tan, hw, cumDist, curvS, isLinear, roadElev, bridges, indexAtDistance,
  LAP_LENGTH, h as roadH, bank as roadBank, grade as roadGrade, terrainAt
} from "../../track/geometry.js";

export let maxAniso = 4;
export function setMaxAnisotropy(v) { maxAniso = Math.max(1, v | 0); }

export function hash01(a, b) {
  const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/* ================= 条带几何 =================
   在采样点 i 处取横向偏移 oA(i)、oB(i) 的两列顶点，逐段连成四边形条带。
   绕序自动校正：段的前进方向恒为 +tan，因此当面朝上时必须 oA > oB，
   否则翻转三角剖分（左右侧条带共用同一构建器）。
   UV：u 横向 0→1，v 沿赛道里程每 vRepeat 米（默认 8m）重复一次（配合沥青纹理）。 */
export function ribbonGeometry(idxList, oA, oB, y, colorAt, vRepeat = 8) {
  const segs = idxList.length - 1;
  const pos = new Float32Array(segs * 4 * 3);
  const col = new Float32Array(segs * 4 * 3);
  const uv = new Float32Array(segs * 4 * 2);
  const idx = new Uint32Array(segs * 6);
  let vp = 0, up = 0, ip = 0;
  const pushVert = (i, off, u) => {
    const p = pts[i], n = nor[i];
    pos[vp] = p.x + n.x * off;
    pos[vp + 1] = y + roadElev(i, off);   // 纵向起伏 + banking 横坡（弯道外侧更高）
    pos[vp + 2] = p.y + n.y * off;
    const c = colorAt ? colorAt(i, u) : [1, 1, 1];
    col[vp] = c[0]; col[vp + 1] = c[1]; col[vp + 2] = c[2];
    uv[up] = u;
    uv[up + 1] = (cumDist[i] ?? 0) / vRepeat;
    vp += 3; up += 2;
  };
  for (let s = 0; s < segs; s++) {
    const i0 = idxList[s], i1 = idxList[s + 1];
    const base = s * 4;
    pushVert(i0, oA(i0), 0);
    pushVert(i0, oB(i0), 1);
    pushVert(i1, oA(i1), 0);
    pushVert(i1, oB(i1), 1);
    const flip = oB(i0) > oA(i0);
    if (!flip) {
      idx[ip++] = base; idx[ip++] = base + 2; idx[ip++] = base + 3;
      idx[ip++] = base; idx[ip++] = base + 3; idx[ip++] = base + 1;
    } else {
      idx[ip++] = base; idx[ip++] = base + 3; idx[ip++] = base + 2;
      idx[ip++] = base; idx[ip++] = base + 1; idx[ip++] = base + 3;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeVertexNormals();
  return g;
}

export function quadSegmentsGeometry(segPairs, oA, oB, y, colorAt) {
  const n = segPairs.length;
  const pos = new Float32Array(n * 4 * 3);
  const col = new Float32Array(n * 4 * 3);
  const uv = new Float32Array(n * 4 * 2);
  const idx = new Uint32Array(n * 6);
  let vp = 0, up = 0, ip = 0;
  const pushVert = (i, off, u) => {
    const p = pts[i], nn = nor[i];
    pos[vp] = p.x + nn.x * off;
    pos[vp + 1] = y + roadElev(i, off);   // 纵向起伏 + banking 横坡（弯道外侧更高）
    pos[vp + 2] = p.y + nn.y * off;
    const c = colorAt ? colorAt(i, u) : [1, 1, 1];
    col[vp] = c[0]; col[vp + 1] = c[1]; col[vp + 2] = c[2];
    uv[up] = u;
    uv[up + 1] = (cumDist[i] ?? 0) / 8;
    vp += 3; up += 2;
  };
  for (let s = 0; s < n; s++) {
    const [i0, i1] = segPairs[s];
    const base = s * 4;
    pushVert(i0, oA(i0), 0);
    pushVert(i0, oB(i0), 1);
    pushVert(i1, oA(i1), 0);
    pushVert(i1, oB(i1), 1);
    const flip = oB(i0) > oA(i0);
    if (!flip) {
      idx[ip++] = base; idx[ip++] = base + 2; idx[ip++] = base + 3;
      idx[ip++] = base; idx[ip++] = base + 3; idx[ip++] = base + 1;
    } else {
      idx[ip++] = base; idx[ip++] = base + 3; idx[ip++] = base + 2;
      idx[ip++] = base; idx[ip++] = base + 1; idx[ip++] = base + 3;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeVertexNormals();
  return g;
}

// 采样下标序列：闭环首尾相接，直线不回绕
export function sampleIndices() {
  const list = [];
  const last = isLinear ? N - 1 : N;
  for (let i = 0; i <= last; i++) list.push(isLinear ? i : i % N);
  return list;
}

/* 可平铺值噪声：size×size 随机格点 + 平滑双线性插值，边界回绕 → 贴图无缝。
   沥青用它做"多尺度"细节：一层噪声只负责一个尺度，合成后才像真实路面。 */
function latticeNoise(size, seed) {
  const a = new Float32Array(size * size);
  let s = seed >>> 0;
  for (let i = 0; i < a.length; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    a[i] = s / 4294967296;
  }
  return (x, y) => {
    const fx = x * size, fy = y * size;
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const tx = fx - x0, ty = fy - y0;
    const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
    const i0 = ((x0 % size) + size) % size, i1 = (i0 + 1) % size;
    const j0 = ((y0 % size) + size) % size, j1 = (j0 + 1) % size;
    const v00 = a[j0 * size + i0], v10 = a[j0 * size + i1];
    const v01 = a[j1 * size + i0], v11 = a[j1 * size + i1];
    return (v00 + (v10 - v00) * sx) * (1 - sy) + (v01 + (v11 - v01) * sx) * sy;
  };
}

/* ================= 沥青贴图（颜色 + 粗糙度） =================
   旧版 256px 贴图靠十几个大半径径向渐变做"斑驳"，平铺到路面上就是一块块深色云团，
   远看/俯视都像洒了一路影子。新版改成多尺度值噪声叠加：
     低频 = 含油量/压实度差异，中频 = 补丁与摊铺接缝，高频 = 骨料团，像素级 = 砂粒；
   再在 u=0.5（正好是路面中线）叠一条柔和的中央车辙，两端积灰略发白。
   同时输出粗糙度贴图：骨料处更涩、车辙被轮胎磨光更亮一点，阳光下有轻微反光变化。
   返回 { map, roughnessMap } —— u 横向 0..1 铺满整幅路宽，v 沿赛道每 16m 循环一次。 */
export function asphaltTextures() {
  const S = 512;
  const colorCv = document.createElement("canvas");
  colorCv.width = S; colorCv.height = S;
  const cc = colorCv.getContext("2d");
  const colorImg = cc.createImageData(S, S);
  const cd = colorImg.data;

  const roughCv = document.createElement("canvas");
  roughCv.width = S; roughCv.height = S;
  const rc = roughCv.getContext("2d");
  const roughImg = rc.createImageData(S, S);
  const rd = roughImg.data;

  const nLow = latticeNoise(6, 0x9e3779b9);
  const nMid = latticeNoise(24, 0x85ebca6b);
  const nFine = latticeNoise(80, 0xc2b2ae35);

  for (let y = 0; y < S; y++) {
    const v = y / S;
    for (let x = 0; x < S; x++) {
      const u = x / S;
      // 多尺度灰度（0.5 为中心）：越靠后的项频率越高、越细
      let lum = 0.5
        + (nLow(u, v) - 0.5) * 0.14
        + (nMid(u, v) - 0.5) * 0.18
        + (nFine(u, v) - 0.5) * 0.22
        + (Math.random() - 0.5) * 0.30;
      // 中央车辙：橡胶沉积 + 骨料被磨平（σ≈6% 路宽，约 ±0.8m 的两条轮迹合成一条柔带）
      const band = Math.exp(-((u - 0.5) * (u - 0.5)) / (2 * 0.06 * 0.06));
      lum -= band * 0.13;
      // 路面最外侧（靠近白线/路肩）积灰，略微发白
      lum += Math.min(1, Math.max(0, (Math.abs(u - 0.5) - 0.43) / 0.07)) * 0.05;

      const d = (lum - 0.5) * 36;
      const p = (y * S + x) * 4;
      cd[p] = 59 + d;
      cd[p + 1] = 62 + d;
      cd[p + 2] = 69 + d;
      cd[p + 3] = 255;

      // 车辙处只轻微抛光（差值太大时中央会被高光反成一条亮带，反而不像沥青）
      const rv = Math.max(0, Math.min(1, 0.84 + (lum - 0.5) * 0.18 - band * 0.07));
      const r = rv * 255;
      rd[p] = r; rd[p + 1] = r; rd[p + 2] = r; rd[p + 3] = 255;
    }
  }

  // 零星亮骨料：1px 的反光碎石，近看才有，远看被 mipmap 平均掉
  for (let i = 0; i < 12000; i++) {
    const p = (((Math.random() * S) | 0) * S + ((Math.random() * S) | 0)) * 4;
    const lift = 12 + Math.random() * 26;
    cd[p] += lift; cd[p + 1] += lift; cd[p + 2] += lift;
  }

  cc.putImageData(colorImg, 0, 0);
  rc.putImageData(roughImg, 0, 0);

  const map = new THREE.CanvasTexture(colorCv);
  map.wrapS = THREE.ClampToEdgeWrapping;
  map.wrapT = THREE.RepeatWrapping;
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = maxAniso;

  const roughnessMap = new THREE.CanvasTexture(roughCv);
  roughnessMap.wrapS = THREE.ClampToEdgeWrapping;
  roughnessMap.wrapT = THREE.RepeatWrapping;
  roughnessMap.anisotropy = maxAniso;

  return { map, roughnessMap };
}

export function grassTexture() {
  const S = 512;
  const cv = document.createElement("canvas");
  cv.width = S; cv.height = S;
  const c = cv.getContext("2d");
  // 四条明暗修剪带（每带 128px → 9m 平铺下约 2.2m 一条）
  const bands = ["#41743a", "#396833", "#41743a", "#396833"];
  for (let i = 0; i < 4; i++) {
    c.fillStyle = bands[i];
    c.fillRect(0, i * S / 4, S, S / 4);
  }
  // 草叶噪点
  for (let i = 0; i < 5200; i++) {
    const x = Math.random() * S, y = Math.random() * S;
    c.fillStyle = Math.random() > 0.5 ? "rgba(96,138,72,0.4)" : "rgba(48,88,46,0.4)";
    c.fillRect(x, y, 2 + Math.random() * 3, 1 + Math.random() * 2);
  }
  // 大块自然斑驳
  for (let i = 0; i < 10; i++) {
    const x = Math.random() * S, y = Math.random() * S;
    const r = 30 + Math.random() * 70;
    const g = c.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, Math.random() > 0.5 ? "rgba(58,102,52,0.3)" : "rgba(88,128,70,0.25)");
    g.addColorStop(1, "rgba(0,0,0,0)");
    c.fillStyle = g;
    c.fillRect(x - r, y - r, r * 2, r * 2);
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = maxAniso;
  return tex;
}

/* 地形高度采样：DEM 基底 + 赛道走廊。
   距中心线 ≤ hw+7 内恒为路面 -0.35（草肩，完整覆盖路缘），再用 40m smoothstep
   过渡到真实地形基面（无 DEM 的赛道基面为 0）。
   实测斯帕有 102m 落差：只有让草地跟随真实地势，才不会在 Les Combes/Paul Frère
   之间出现 40m 高的路堤悬崖。近邻路段按弧长分簇、只跟随最近的一条，
   避免不同高程的并行路段互相抬升把桥洞/路面填死。
   坡度上限 1.5:1 随距离放宽，保证陡峭切坡也不会从外侧斜切盖住沥青。 */
export function makeGroundSampler() {
  const CELL = 60, STRIDE = 2;
  const grid = new Map();
  for (let i = 0; i < N; i += STRIDE) {
    const k = Math.floor(pts[i].x / CELL) + "_" + Math.floor(pts[i].y / CELL);
    let a = grid.get(k);
    if (!a) { a = []; grid.set(k, a); }
    a.push(i);
  }
  const inBridgeZone = (i) => {
    for (let b = 0; b < bridges.length; b++) {
      let ds = Math.abs(cumDist[i] - bridges[b].s);
      if (!isLinear) ds = Math.min(ds, LAP_LENGTH - ds);
      if (ds < 145) return true;      // 桥面隆起台地区（W=190 的主体段）
    }
    return false;
  };
  // 同一条路段的判定按「沿赛道弧长差」而非 2D 距离：立交处上下层几乎重合，
  // 2D 距离会把桥面与桥洞样本并进同一簇，导致桥洞被填成桥面高度的草墙。
  const alongGap = (a, b) => {
    let d = Math.abs(cumDist[a] - cumDist[b]);
    if (!isLinear) d = Math.min(d, LAP_LENGTH - d);
    return d;
  };
  const FALL = 40;   // 草肩外 → 地形基面的过渡宽度（米）
  return (x, z) => {
    const base = terrainAt ? terrainAt(x, z) : 0;   // 真实地势（无 DEM 时为 0 平面）
    const gx = Math.floor(x / CELL), gz = Math.floor(z / CELL);
    const cand = [];
    for (let ox = -1; ox <= 1; ox++) {
      for (let oz = -1; oz <= 1; oz++) {
        const cell = grid.get((gx + ox) + "_" + (gz + oz));
        if (!cell) continue;
        for (let c = 0; c < cell.length; c++) {
          const i = cell[c];
          const dx = pts[i].x - x, dz = pts[i].y - z;
          const d2 = dx * dx + dz * dz;
          if (d2 < 3600) cand.push([d2, i]);   // 半径 60m 内
        }
      }
    }
    if (cand.length === 0) return base;
    cand.sort((a, b) => a[0] - b[0]);
    // 按路段分簇（样点弧长相差 <120m 归为同一路段）；桥面分支在有地面分支可依时剔除，
    // 保证立交桥洞下方地面跟随下层道路而不是隆起填死涵洞。
    const clusters = [];
    for (const [d2, i] of cand) {
      let placed = false;
      for (const cl of clusters) {
        for (const j of cl.pts) {
          if (alongGap(i, j) < 120) { cl.pts.push(i); placed = true; break; }
        }
        if (placed) break;
      }
      if (!placed) clusters.push({ pts: [i], bridge: inBridgeZone(i) });
    }
    let live = clusters.filter(cl => !(cl.bridge && clusters.length > 1));
    if (live.length === 0) live = clusters.slice(0, 1);
    // 跟随最近路段（pts[0] 是该簇最近样点）：并行路段高程差很大时以近者为准，
    // 避免远侧高地把低处路面周围的草地整体抬高。
    let i = live[0].pts[0], d = Infinity, dx = 0, dz = 0;
    for (const cl of live) {
      const k = cl.pts[0];
      const ex = x - pts[k].x, ez = z - pts[k].y;
      const e = Math.sqrt(ex * ex + ez * ez);
      if (e < d) { d = e; i = k; dx = ex; dz = ez; }
    }
    const dLat = dx * nor[i].x + dz * nor[i].y;
    // 网格每 2 个采样点取 1 个，最近样点可能沿赛道偏出 10~20m；
    // 用纵向坡度把基准高度校正回目标位置，否则陡坡/立交引道上草地会高出路面。
    const dLong = dx * tan[i].x + dz * tan[i].y;
    const inner = hw[i] + 1.5;
    const baseY = roadH[i] + roadGrade[i] * Math.max(-40, Math.min(40, dLong));
    const roadY = baseY + roadBank[i] * Math.max(-inner, Math.min(inner, dLat));
    // 平地草肩到 hw+7：比沥青/路缘外沿再宽 4.5m 以上，网格三角形怎么跨都低于路面。
    const shoulder = hw[i] + 7;
    const t = Math.max(0, Math.min(1, (d - shoulder) / FALL));
    const fall = t * t * (3 - 2 * t);
    const y = (roadY - 0.35) * (1 - fall) + base * fall;
    const cap = roadY - 0.35 + Math.max(0, d - shoulder) * 1.5;
    return Math.min(y, cap);
  };
}
export function checkerTexture(c1, c2) {
  const cv = document.createElement("canvas");
  cv.width = 160; cv.height = 32;
  const c = cv.getContext("2d");
  for (let y = 0; y < 2; y++) {
    for (let x = 0; x < 10; x++) {
      c.fillStyle = (x + y) % 2 ? c1 : c2;
      c.fillRect(x * 16, y * 16, 16, 16);
    }
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.NearestFilter;
  return tex;
}
