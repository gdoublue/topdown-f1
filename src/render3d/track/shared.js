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
  const pushVert = (i, off, u, distOverride = null) => {
    const p = pts[i], n = nor[i];
    pos[vp] = p.x + n.x * off;
    pos[vp + 1] = y + roadElev(i, off);   // 纵向起伏 + banking 横坡（弯道外侧更高）
    pos[vp + 2] = p.y + n.y * off;
    const c = colorAt ? colorAt(i, u) : [1, 1, 1];
    col[vp] = c[0]; col[vp + 1] = c[1]; col[vp + 2] = c[2];
    uv[up] = u;
    const curDist = distOverride != null ? distOverride : (cumDist[i] ?? 0);
    uv[up + 1] = curDist / vRepeat;
    vp += 3; up += 2;
  };
  for (let s = 0; s < segs; s++) {
    const i0 = idxList[s], i1 = idxList[s + 1];
    const base = s * 4;
    // 跨起点线闭合段 (N-1 -> 0) 使用累积总里程 cumDist[N]，消除 UV 倒流 Mipmap 阴影暗带
    const dist1 = (!isLinear && i0 === N - 1 && i1 === 0 && cumDist && cumDist.length > N)
      ? cumDist[N]
      : (cumDist[i1] ?? 0);
    pushVert(i0, oA(i0), 0);
    pushVert(i0, oB(i0), 1);
    pushVert(i1, oA(i1), 0, dist1);
    pushVert(i1, oB(i1), 1, dist1);
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

export function quadSegmentsGeometry(segPairs, oA, oB, y, colorAt, vRepeat = 8) {
  const n = segPairs.length;
  const pos = new Float32Array(n * 4 * 3);
  const col = new Float32Array(n * 4 * 3);
  const uv = new Float32Array(n * 4 * 2);
  const idx = new Uint32Array(n * 6);
  let vp = 0, up = 0, ip = 0;
  const pushVert = (i, off, u, distOverride = null) => {
    const p = pts[i], nn = nor[i];
    pos[vp] = p.x + nn.x * off;
    pos[vp + 1] = y + roadElev(i, off);   // 纵向起伏 + banking 横坡（弯道外侧更高）
    pos[vp + 2] = p.y + nn.y * off;
    const c = colorAt ? colorAt(i, u) : [1, 1, 1];
    col[vp] = c[0]; col[vp + 1] = c[1]; col[vp + 2] = c[2];
    uv[up] = u;
    const curDist = distOverride != null ? distOverride : (cumDist[i] ?? 0);
    uv[up + 1] = curDist / vRepeat;
    vp += 3; up += 2;
  };
  for (let s = 0; s < n; s++) {
    const [i0, i1] = segPairs[s];
    const base = s * 4;
    const dist1 = (!isLinear && i0 === N - 1 && i1 === 0 && cumDist && cumDist.length > N)
      ? cumDist[N]
      : (cumDist[i1] ?? 0);
    pushVert(i0, oA(i0), 0);
    pushVert(i0, oB(i0), 1);
    pushVert(i1, oA(i1), 0, dist1);
    pushVert(i1, oB(i1), 1, dist1);
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
/* ================= 高写实沥青贴图系统（参考 Saltline：漫反射 + 切线法线 + 抛光粗糙度） =================
   生成三张严格对齐的高精度贴图：
     1. map：深灰微暖基底、双车辙橡胶胶质沉积深色带、外侧积灰发白、零星矿物骨料微亮点
     2. normalMap：Sobel 梯度碎石骨料微法线凹凸，阳光斜射时碎石立体感极强
     3. roughnessMap：主赛车线橡胶强抛光（0.32~0.46 油润光泽）、外侧干燥粗糙（0.82~0.92）
   返回 { map, normalMap, roughnessMap } */
let _cachedAsphaltTex = null;
export function asphaltTextures() {
  if (_cachedAsphaltTex) return _cachedAsphaltTex;
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

  const normalCv = document.createElement("canvas");
  normalCv.width = S; normalCv.height = S;
  const nc = normalCv.getContext("2d");
  const normalImg = nc.createImageData(S, S);
  const nd = normalImg.data;

  const heightField = new Float32Array(S * S);

  const nLow = latticeNoise(6, 0x9e3779b9);
  const nMid = latticeNoise(24, 0x85ebca6b);
  const nFine = latticeNoise(80, 0xc2b2ae35);

  for (let y = 0; y < S; y++) {
    const v = y / S;
    for (let x = 0; x < S; x++) {
      const u = x / S;
      const fineVal = nFine(u, v);
      const grainRand = Math.random();
      let lum = 0.5
        + (nLow(u, v) - 0.5) * 0.13
        + (nMid(u, v) - 0.5) * 0.17
        + (fineVal - 0.5) * 0.22
        + (grainRand - 0.5) * 0.28;

      // 赛车线与双轮迹橡胶沉积深色带（Rubbered-in Racing Line）
      const bandCenter = Math.exp(-((u - 0.5) * (u - 0.5)) / (2 * 0.11 * 0.11));
      const bandL = Math.exp(-((u - 0.38) * (u - 0.38)) / (2 * 0.048 * 0.048));
      const bandR = Math.exp(-((u - 0.62) * (u - 0.62)) / (2 * 0.048 * 0.048));
      const rubberBand = Math.min(1.0, bandCenter * 0.65 + (bandL + bandR) * 0.60);
      lum -= rubberBand * 0.16;

      // 摊铺机纵向接缝微痕（u ≈ 0.25 / 0.50 / 0.75）
      const seam = Math.exp(-Math.pow((u * 4 - Math.round(u * 4)) * 36, 2));
      lum -= seam * 0.04;

      // 路面最外侧积灰与胎屑（marbles），略微灰白
      const outerDust = Math.min(1, Math.max(0, (Math.abs(u - 0.5) - 0.42) / 0.08));
      lum += outerDust * 0.07;

      // 存入高度场供 Sobel 法线贴图计算
      const idx = y * S + x;
      heightField[idx] = (fineVal * 0.55 + grainRand * 0.45) * 0.8 + (1.0 - rubberBand) * 0.2;

      // 漫反射真实大奖赛沥青基础调色（清晰高辨识度深灰玄武岩与石灰石碎石基底）
      const d = (lum - 0.5) * 38;
      const p = idx * 4;
      const baseR = 76, baseG = 80, baseB = 86;
      cd[p] = Math.min(255, Math.max(0, baseR + d - rubberBand * 24 + outerDust * 15));
      cd[p + 1] = Math.min(255, Math.max(0, baseG + d - rubberBand * 24 + outerDust * 15));
      cd[p + 2] = Math.min(255, Math.max(0, baseB + d - rubberBand * 20 + outerDust * 14));
      cd[p + 3] = 255;

      // 粗糙度：主赛车线橡胶强磨光抛光（0.40~0.46 阳光下产生绝美缎面丝绸高光），外侧干燥多孔（0.84~0.92）
      const baseRoughness = Math.max(0.38, Math.min(0.94, 0.86 + (lum - 0.5) * 0.15 - rubberBand * 0.44));
      const rByte = Math.floor(baseRoughness * 255);
      rd[p] = rByte; rd[p + 1] = rByte; rd[p + 2] = rByte; rd[p + 3] = 255;
    }
  }

  // 零星微观反光石料晶体（Tiny aggregate chips）
  for (let i = 0; i < 14000; i++) {
    const rx = (Math.random() * S) | 0;
    const ry = (Math.random() * S) | 0;
    const p = (ry * S + rx) * 4;
    const lift = 16 + Math.random() * 26;
    cd[p] = Math.min(255, cd[p] + lift);
    cd[p + 1] = Math.min(255, cd[p + 1] + lift);
    cd[p + 2] = Math.min(255, cd[p + 2] + lift);
    // 亮石粒粗糙度低，产生微弱矿物晶体反光
    rd[p] = Math.max(50, rd[p] - 70);
    rd[p + 1] = rd[p]; rd[p + 2] = rd[p];
  }

  // 计算 Sobel 切线空间法线贴图（Normal Map）
  const bumpK = 2.4;
  for (let y = 0; y < S; y++) {
    const yP = (y - 1 + S) % S, yN = (y + 1) % S;
    for (let x = 0; x < S; x++) {
      const xP = (x - 1 + S) % S, xN = (x + 1) % S;
      const dx = (heightField[y * S + xN] - heightField[y * S + xP]) * bumpK;
      const dy = (heightField[yN * S + x] - heightField[yP * S + x]) * bumpK;
      const len = Math.hypot(dx, dy, 1.0);
      const nx = -dx / len;
      const ny = -dy / len;
      const nz = 1.0 / len;

      const p = (y * S + x) * 4;
      nd[p] = Math.floor((nx * 0.5 + 0.5) * 255);
      nd[p + 1] = Math.floor((ny * 0.5 + 0.5) * 255);
      nd[p + 2] = Math.floor((nz * 0.5 + 0.5) * 255);
      nd[p + 3] = 255;
    }
  }

  cc.putImageData(colorImg, 0, 0);
  rc.putImageData(roughImg, 0, 0);
  nc.putImageData(normalImg, 0, 0);

  const map = new THREE.CanvasTexture(colorCv);
  map.wrapS = THREE.ClampToEdgeWrapping;
  map.wrapT = THREE.RepeatWrapping;
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = maxAniso;

  const roughnessMap = new THREE.CanvasTexture(roughCv);
  roughnessMap.wrapS = THREE.ClampToEdgeWrapping;
  roughnessMap.wrapT = THREE.RepeatWrapping;
  roughnessMap.anisotropy = maxAniso;

  const normalMap = new THREE.CanvasTexture(normalCv);
  normalMap.wrapS = THREE.ClampToEdgeWrapping;
  normalMap.wrapT = THREE.RepeatWrapping;
  normalMap.anisotropy = maxAniso;

  _cachedAsphaltTex = { map, normalMap, roughnessMap };
  return _cachedAsphaltTex;
}

/* ================= 高写实草地纹理（漫反射颜色 + 粗糙度贴图） ================= */
export function grassTextures() {
  const S = 512;
  const colCv = document.createElement("canvas");
  colCv.width = S; colCv.height = S;
  const cc = colCv.getContext("2d");

  const roughCv = document.createElement("canvas");
  roughCv.width = S; roughCv.height = S;
  const rc = roughCv.getContext("2d");

  // 8条多层次自然修剪带（交替模拟赛道修剪机压痕）
  const baseTones = ["#3a6b33", "#325c2b", "#3d7036", "#36632f"];
  for (let i = 0; i < 8; i++) {
    cc.fillStyle = baseTones[i % 4];
    cc.fillRect(0, (i * S) / 8, S, S / 8);
    rc.fillStyle = (i % 2 === 0) ? "#dfdfdf" : "#cfcfcf";
    rc.fillRect(0, (i * S) / 8, S, S / 8);
  }

  // 自然草丛纤维细微噪点（6000 丛细叶）
  for (let i = 0; i < 6000; i++) {
    const x = Math.random() * S, y = Math.random() * S;
    const rnd = Math.random();
    if (rnd < 0.35) {
      cc.fillStyle = "rgba(78, 126, 62, 0.45)"; // 嫩草亮绿
    } else if (rnd < 0.7) {
      cc.fillStyle = "rgba(38, 72, 34, 0.5)";   // 深草荫
    } else if (rnd < 0.9) {
      cc.fillStyle = "rgba(102, 118, 58, 0.35)"; // 微黄枯叶
    } else {
      cc.fillStyle = "rgba(68, 52, 38, 0.32)";  // 泥土颗粒
    }
    cc.fillRect(x, y, 1.5 + Math.random() * 2.5, 1 + Math.random() * 2.5);
    rc.fillStyle = "rgba(180, 180, 180, 0.25)";
    rc.fillRect(x, y, 2, 2);
  }

  // 大范围自然土壤与潮湿微斑驳
  for (let i = 0; i < 14; i++) {
    const x = Math.random() * S, y = Math.random() * S;
    const r = 40 + Math.random() * 90;
    const g = cc.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, Math.random() > 0.5 ? "rgba(42, 78, 38, 0.26)" : "rgba(82, 114, 60, 0.22)");
    g.addColorStop(1, "rgba(0, 0, 0, 0)");
    cc.fillStyle = g;
    cc.fillRect(x - r, y - r, r * 2, r * 2);
  }

  const map = new THREE.CanvasTexture(colCv);
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = maxAniso;

  const roughnessMap = new THREE.CanvasTexture(roughCv);
  roughnessMap.wrapS = roughnessMap.wrapT = THREE.RepeatWrapping;
  roughnessMap.anisotropy = maxAniso;

  return { map, roughnessMap };
}

export function grassTexture() {
  return grassTextures().map;
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

/* ================= FIA 红白锯齿路缘石贴图（颜色 + 凹凸） =================
   u=0 为外沿（草地侧），u=1 为内沿（紧贴沥青侧）；v 沿赛道每 2.4m 循环一次（含一红一白两块 1.2m 石块）。
   绘制：
     1. 清晰锐利的红 (#c42420) / 白 (#ecece6) 预制混凝土块，彻底告别旧版顶点色跨 3.7m 的模糊渐变
     2. 每块内部带 3 道 FIA 锯齿阶梯斜面阴影（Rumble strips），产生立体锯齿起伏感
     3. 块间深色水泥伸缩缝 + 内侧（u ∈ 0.65..0.96）真实的 F1 轮胎黑色橡胶碾压擦痕 */
export function kerbTextures() {
  const W = 256, H = 512;
  const colCv = document.createElement("canvas");
  colCv.width = W; colCv.height = H;
  const cc = colCv.getContext("2d");

  const bumpCv = document.createElement("canvas");
  bumpCv.width = W; bumpCv.height = H;
  const bc = bumpCv.getContext("2d");

  const blocks = [
    { base: [198, 36, 32] },     // FIA 路肩红
    { base: [236, 236, 230] },   // 路肩象牙白
  ];

  const colImg = cc.createImageData(W, H);
  const cd = colImg.data;
  const bumpImg = bc.createImageData(W, H);
  const bd = bumpImg.data;

  for (let y = 0; y < H; y++) {
    const blk = y < H / 2 ? blocks[0] : blocks[1];
    const localV = (y % (H / 2)) / (H / 2); // 0..1 within one block
    // 块间水泥横缝（首尾各 2.2%）
    const isJoint = localV < 0.022 || localV > 0.978;
    // 每块内 3 级 FIA 锯齿阶梯波纹（Rumble tooth profile）
    const toothPhase = (localV * 3) % 1;
    const toothShade = isJoint ? -0.35 : (0.08 - toothPhase * 0.16);
    const toothBump = isJoint ? 0.15 : (0.35 + (1 - toothPhase) * 0.55);

    for (let x = 0; x < W; x++) {
      const u = x / W; // 0 = 外沿草地侧, 1 = 内沿沥青侧
      // 内外倒角立面阴影：靠近沥青侧 (u > 0.88) 为斜坡倒角，靠近草地侧 (u < 0.08) 为外沿排水槽
      let bevel = 0;
      if (u > 0.88) bevel = (u - 0.88) / 0.12 * 0.12;
      else if (u < 0.08) bevel = -((0.08 - u) / 0.08) * 0.22;

      // 轮胎压路肩留下的黑色橡胶擦痕（集中在内侧 u=0.58..0.95）
      const scuffZone = Math.exp(-Math.pow((u - 0.80) / 0.14, 2));
      const streak = 0.5 + 0.5 * Math.sin(y * 0.19 + x * 0.07) * Math.cos(y * 0.05 - x * 0.13);
      const rubberScuff = scuffZone * (0.14 + 0.16 * streak);

      const grain = (Math.random() - 0.5) * 14;
      const mult = Math.max(0.25, (1 + toothShade + bevel) * (1 - rubberScuff));

      const p = (y * W + x) * 4;
      if (isJoint) {
        cd[p] = 52 + grain * 0.5;
        cd[p + 1] = 54 + grain * 0.5;
        cd[p + 2] = 58 + grain * 0.5;
      } else {
        cd[p] = Math.min(255, Math.max(0, blk.base[0] * mult + grain));
        cd[p + 1] = Math.min(255, Math.max(0, blk.base[1] * mult + grain));
        cd[p + 2] = Math.min(255, Math.max(0, blk.base[2] * mult + grain));
      }
      cd[p + 3] = 255;

      const bh = Math.min(255, Math.max(0, (toothBump + bevel * 0.5) * 255 + grain * 0.6));
      bd[p] = bh; bd[p + 1] = bh; bd[p + 2] = bh; bd[p + 3] = 255;
    }
  }

  cc.putImageData(colImg, 0, 0);
  bc.putImageData(bumpImg, 0, 0);

  const map = new THREE.CanvasTexture(colCv);
  map.wrapS = THREE.ClampToEdgeWrapping;
  map.wrapT = THREE.RepeatWrapping;
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = maxAniso;

  const bumpMap = new THREE.CanvasTexture(bumpCv);
  bumpMap.wrapS = THREE.ClampToEdgeWrapping;
  bumpMap.wrapT = THREE.RepeatWrapping;
  bumpMap.anisotropy = maxAniso;

  return { map, bumpMap };
}


/* ================= 国际大奖赛风格赞助商广告牌贴图 ================= */
let _cachedBoardTextures = null;
export function boardTextures() {
  if (_cachedBoardTextures) return _cachedBoardTextures;

  const W = 512, H = 64;
  const themes = [
    // 0: 经典 Rolex 绿金奢华风
    (c) => {
      c.fillStyle = "#0a3a22"; c.fillRect(0, 0, W, H);
      c.fillStyle = "#d4af37"; c.fillRect(0, 0, W, 4); c.fillRect(0, H - 4, W, 4);
      c.fillStyle = "#f6c342";
      // 中间金色冠状线条与金字横带
      c.fillRect(W * 0.42, 14, W * 0.16, 6);
      c.fillRect(W * 0.40, 26, W * 0.20, 16);
      c.fillStyle = "#0a3a22";
      c.font = "bold 13px sans-serif";
      c.textAlign = "center";
      c.fillText("PRECISION", W * 0.5, 39);
      // 两侧金黄色速度斜纹
      c.fillStyle = "rgba(212, 175, 55, 0.45)";
      for (let i = 24; i < 140; i += 22) {
        c.beginPath(); c.moveTo(i, 12); c.lineTo(i + 14, 12); c.lineTo(i + 4, H - 12); c.lineTo(i - 10, H - 12); c.fill();
      }
      for (let i = W - 140; i < W - 20; i += 22) {
        c.beginPath(); c.moveTo(i, 12); c.lineTo(i + 14, 12); c.lineTo(i + 4, H - 12); c.lineTo(i - 10, H - 12); c.fill();
      }
    },
    // 1: Pirelli 竞速红黄风
    (c) => {
      c.fillStyle = "#ffd100"; c.fillRect(0, 0, W, H);
      c.fillStyle = "#d01919"; c.fillRect(0, 0, W, 5); c.fillRect(0, H - 5, W, 5);
      c.fillStyle = "#d01919"; c.fillRect(W * 0.32, 12, W * 0.36, 40);
      c.fillStyle = "#ffffff";
      c.font = "italic 900 22px sans-serif";
      c.textAlign = "center";
      c.fillText("RACING GRIP", W * 0.5, 40);
      // 黑色斜纹旗格装饰
      c.fillStyle = "#111111";
      for (let i = 18; i < 120; i += 20) {
        c.beginPath(); c.moveTo(i, 10); c.lineTo(i + 12, 10); c.lineTo(i + 2, H - 10); c.lineTo(i - 10, H - 10); c.fill();
      }
      for (let i = W - 120; i < W - 15; i += 20) {
        c.beginPath(); c.moveTo(i, 10); c.lineTo(i + 12, 10); c.lineTo(i + 2, H - 10); c.lineTo(i - 10, H - 10); c.fill();
      }
    },
    // 2: DHL 动感物流黄红风
    (c) => {
      c.fillStyle = "#ffcc00"; c.fillRect(0, 0, W, H);
      c.fillStyle = "#d40511";
      c.fillRect(0, 0, W, 4); c.fillRect(0, H - 4, W, 4);
      c.beginPath();
      c.moveTo(W * 0.30, 8); c.lineTo(W * 0.70, 8); c.lineTo(W * 0.65, H - 8); c.lineTo(W * 0.25, H - 8);
      c.fill();
      c.fillStyle = "#ffffff";
      c.font = "italic 900 24px sans-serif";
      c.textAlign = "center";
      c.fillText("SPEED EXPRESS", W * 0.48, 41);
    },
    // 3: 航空科技深蓝白羽风
    (c) => {
      c.fillStyle = "#0c2c62"; c.fillRect(0, 0, W, H);
      c.fillStyle = "#00a4e4"; c.fillRect(0, 0, W, 4); c.fillRect(0, H - 4, W, 4);
      c.fillStyle = "#ffffff";
      c.font = "bold 20px sans-serif";
      c.textAlign = "center";
      c.fillText("AERO MOTORS", W * 0.5, 39);
      c.fillStyle = "#00a4e4";
      c.fillRect(W * 0.41, 46, W * 0.18, 4);
      // 科技流线波纹
      c.strokeStyle = "rgba(0, 164, 228, 0.6)";
      c.lineWidth = 3;
      c.beginPath();
      c.moveTo(20, 32); c.lineTo(130, 32); c.lineTo(150, 16);
      c.moveTo(W - 20, 32); c.lineTo(W - 130, 32); c.lineTo(W - 150, 48);
      c.stroke();
    },
    // 4: 碳黑红白竞技煞车风
    (c) => {
      c.fillStyle = "#181a1f"; c.fillRect(0, 0, W, H);
      c.fillStyle = "#e52424"; c.fillRect(0, 0, W, 4); c.fillRect(0, H - 4, W, 4);
      c.fillStyle = "#e52424"; c.fillRect(W * 0.36, 12, W * 0.28, 40);
      c.fillStyle = "#ffffff";
      c.font = "900 21px sans-serif";
      c.textAlign = "center";
      c.fillText("BRAKE TECH", W * 0.5, 39);
      // 黑白终点方格纹
      for (let x = 20; x < 120; x += 16) {
        for (let y = 14; y < H - 14; y += 18) {
          c.fillStyle = (x + y) % 32 === 0 ? "#ffffff" : "#e52424";
          c.fillRect(x, y, 14, 16);
        }
      }
      for (let x = W - 120; x < W - 20; x += 16) {
        for (let y = 14; y < H - 14; y += 18) {
          c.fillStyle = (x + y) % 32 === 0 ? "#ffffff" : "#e52424";
          c.fillRect(x, y, 14, 16);
        }
      }
    }
  ];

  _cachedBoardTextures = themes.map((draw) => {
    const cv = document.createElement("canvas");
    cv.width = W; cv.height = H;
    const ctx = cv.getContext("2d");
    draw(ctx);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = maxAniso;
    return tex;
  });

  return _cachedBoardTextures;
}

/* ================= 看台密集座椅矩阵纹理 ================= */
let _cachedSeatTextures = new Map();
export function grandstandSeatTexture(baseHex = "#5a6c86") {
  if (_cachedSeatTextures.has(baseHex)) return _cachedSeatTextures.get(baseHex);
  const W = 256, H = 128;
  const cv = document.createElement("canvas");
  cv.width = W; cv.height = H;
  const c = cv.getContext("2d");

  // 底色阶梯
  c.fillStyle = "#7b838f";
  c.fillRect(0, 0, W, H);

  // 密集排布的看台座椅（16 列 × 8 排）
  const cols = 16, rows = 8;
  const seatW = W / cols - 3;
  const seatH = H / rows - 4;

  const colorVariants = [baseHex, "#c73232", "#3b6fb6", "#f2b824"];
  const theme = colorVariants[Math.abs(baseHex.split("").reduce((a, b) => a + b.charCodeAt(0), 0)) % colorVariants.length];

  for (let r = 0; r < rows; r++) {
    for (let cl = 0; cl < cols; cl++) {
      if (cl === 7 || cl === 8) {
        // 中间走道楼梯（深灰带黄色走道边缘）
        c.fillStyle = "#505660";
        c.fillRect(cl * (W / cols), r * (H / rows), W / cols, H / rows);
        c.fillStyle = "rgba(255, 210, 0, 0.4)";
        c.fillRect(cl * (W / cols), r * (H / rows) + H / rows - 2, W / cols, 2);
        continue;
      }
      const x = cl * (W / cols) + 1.5;
      const y = r * (H / rows) + 2;

      // 座椅阴影
      c.fillStyle = "#2c3038";
      c.fillRect(x + 1, y + 1, seatW, seatH);

      // 座椅主体靠背
      c.fillStyle = theme;
      c.fillRect(x, y, seatW, seatH * 0.75);

      // 座椅坐垫高光
      c.fillStyle = "rgba(255, 255, 255, 0.25)";
      c.fillRect(x, y + seatH * 0.5, seatW, seatH * 0.25);
    }
  }

  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = maxAniso;
  _cachedSeatTextures.set(baseHex, tex);
  return tex;
}
