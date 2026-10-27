// 3D 赛道场景构建：完全程序化生成（零外部资源，无模型/贴图文件）
// 世界坐标映射：2D (x, y) → three.js (x, y0, z)，y 轴向上为高度
// 赛道几何（pts/nor/hw/kerbFlag）直接复用 track/geometry.js 的权威数据，
// 与物理判定（沥青 hw / 路肩 hw+1.5 / 草地）严格一一对应。
import * as THREE from "three";
import {
  pts, N, nor, tan, hw, kerbFlag, cumDist, curvS, isLinear
} from "../track/geometry.js";

export const SKY_HORIZON = 0xbcd9ea;

let maxAniso = 4;
export function setMaxAnisotropy(v) { maxAniso = Math.max(1, v | 0); }

// 确定性伪随机（同一赛道每次重建画面一致）
function hash01(a, b) {
  const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/* ================= 条带几何 =================
   在采样点 i 处取横向偏移 oA(i)、oB(i) 的两列顶点，逐段连成四边形条带。
   绕序自动校正：段的前进方向恒为 +tan，因此当面朝上时必须 oA > oB，
   否则翻转三角剖分（左右侧条带共用同一构建器）。
   UV：u 横向 0→1，v 沿赛道里程每 8m 重复一次（配合沥青纹理）。 */
function ribbonGeometry(idxList, oA, oB, y, colorAt) {
  const segs = idxList.length - 1;
  const pos = new Float32Array(segs * 4 * 3);
  const col = new Float32Array(segs * 4 * 3);
  const uv = new Float32Array(segs * 4 * 2);
  const idx = new Uint32Array(segs * 6);
  let vp = 0, up = 0, ip = 0;
  const pushVert = (i, off, u) => {
    const p = pts[i], n = nor[i];
    pos[vp] = p.x + n.x * off;
    pos[vp + 1] = y;
    pos[vp + 2] = p.y + n.y * off;
    const c = colorAt ? colorAt(i, u) : [1, 1, 1];
    col[vp] = c[0]; col[vp + 1] = c[1]; col[vp + 2] = c[2];
    uv[up] = u;
    uv[up + 1] = (cumDist[i] ?? 0) / 8;
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

function quadSegmentsGeometry(segPairs, oA, oB, y, colorAt) {
  const n = segPairs.length;
  const pos = new Float32Array(n * 4 * 3);
  const col = new Float32Array(n * 4 * 3);
  const uv = new Float32Array(n * 4 * 2);
  const idx = new Uint32Array(n * 6);
  let vp = 0, up = 0, ip = 0;
  const pushVert = (i, off, u) => {
    const p = pts[i], nn = nor[i];
    pos[vp] = p.x + nn.x * off;
    pos[vp + 1] = y;
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
function sampleIndices() {
  const list = [];
  const last = isLinear ? N - 1 : N;
  for (let i = 0; i <= last; i++) list.push(isLinear ? i : i % N);
  return list;
}

/* ================= 沥青路面（颗粒纹理 + 中央“赛车线”磨黑） ================= */
function asphaltTexture() {
  const S = 256;
  const cv = document.createElement("canvas");
  cv.width = S; cv.height = S;
  const c = cv.getContext("2d");
  c.fillStyle = "#43464c";
  c.fillRect(0, 0, S, S);
  // 细颗粒：密集随机点，明暗两档
  for (let i = 0; i < 5200; i++) {
    const x = Math.random() * S, y = Math.random() * S;
    const l = Math.random();
    c.fillStyle = l > 0.55 ? "rgba(88,92,100,0.55)" : "rgba(44,46,52,0.55)";
    const s = 1 + Math.random() * 2;
    c.fillRect(x, y, s, s);
  }
  // 大块深浅斑驳（轮胎胶层/修补痕迹）
  for (let i = 0; i < 14; i++) {
    const x = Math.random() * S, y = Math.random() * S;
    const r = 18 + Math.random() * 46;
    const g = c.createRadialGradient(x, y, 0, x, y, r);
    const dark = Math.random() > 0.5;
    g.addColorStop(0, dark ? "rgba(38,40,46,0.28)" : "rgba(96,100,108,0.2)");
    g.addColorStop(1, "rgba(0,0,0,0)");
    c.fillStyle = g;
    c.fillRect(x - r, y - r, r * 2, r * 2);
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = maxAniso;
  return tex;
}

function buildAsphalt() {
  const list = sampleIndices();
  const geo = ribbonGeometry(
    list,
    i => hw[i],
    i => -hw[i],
    0.05,
    (i, u) => {
      // 中央磨黑的赛车线：u=0.5 最暗，向两侧渐亮
      const groove = 1 - 0.34 * Math.exp(-((u - 0.5) * (u - 0.5)) / 0.02);
      return [groove, groove, groove];
    }
  );
  const mat = new THREE.MeshStandardMaterial({
    map: asphaltTexture(),
    vertexColors: true,
    roughness: 0.96,
    metalness: 0.0,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  return mesh;
}

/* ================= 白色边线（沥青内侧，连续） ================= */
function buildEdgeLines() {
  const list = sampleIndices();
  const group = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({ color: 0xe8eaed });
  for (const side of [1, -1]) {
    const geo = ribbonGeometry(
      list,
      i => side * (hw[i] - 0.18),
      i => side * (hw[i] - 0.48),
      0.085,
      () => [1, 1, 1]
    );
    group.add(new THREE.Mesh(geo, mat));
  }
  return group;
}

/* ================= 红白路缘石（kerbFlag 路段两侧；直线赛道全程） ================= */
function buildKerbs() {
  const group = new THREE.Group();
  // 顶点色按线性空间插值：用 THREE.Color 做 sRGB→线性转换，ACES 下不发白
  const RED = new THREE.Color("#c22a24");
  const WHITE = new THREE.Color("#e8e8e6");
  const colorAt = (i) => {
    const c = Math.floor((cumDist[i] ?? 0) / 2.6) % 2 ? WHITE : RED;
    return [c.r, c.g, c.b];
  };
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, metalness: 0.0 });
  for (const side of [1, -1]) {
    const segPairs = [];
    for (let i = 0; i < N; i++) {
      if (!isLinear && kerbFlag[i] !== 1) continue;
      const next = isLinear ? i + 1 : (i + 1) % N;
      if (isLinear && next >= N) continue;
      segPairs.push([i, next]);
    }
    if (!segPairs.length) continue;
    const geo = quadSegmentsGeometry(
      segPairs,
      i => side * (hw[i] + 1.5),
      i => side * hw[i],
      0.075,
      colorAt
    );
    group.add(new THREE.Mesh(geo, mat));
  }
  return group;
}

/* ================= 起终点线（程序化棋盘格贴图，四角顶点手工对齐） ================= */
function checkerTexture(c1, c2) {
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

function buildStartLine() {
  const group = new THREE.Group();
  const makeLine = (sampleIdx, tint) => {
    const w = hw[sampleIdx] + 1.2;
    const p = pts[sampleIdx], nn = nor[sampleIdx];
    const tx = -nn.y, ty = nn.x;   // 沿赛道方向
    const cx = p.x, cz = p.y;
    const L = 2.6;
    const corners = [
      [cx + nn.x * w + tx * L / 2, cz + nn.y * w + ty * L / 2],
      [cx - nn.x * w + tx * L / 2, cz - nn.y * w + ty * L / 2],
      [cx - nn.x * w - tx * L / 2, cz - nn.y * w - ty * L / 2],
      [cx + nn.x * w - tx * L / 2, cz + nn.y * w - ty * L / 2],
    ];
    const posArr = new Float32Array(12);
    const uvArr = new Float32Array(8);
    corners.forEach((c, i) => {
      posArr[i * 3] = c[0]; posArr[i * 3 + 1] = 0.1; posArr[i * 3 + 2] = c[1];
      uvArr[i * 2] = i === 0 || i === 3 ? 0 : 1;
      uvArr[i * 2 + 1] = i < 2 ? 1 : 0;
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(posArr, 3));
    g.setAttribute("uv", new THREE.BufferAttribute(uvArr, 2));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    g.computeVertexNormals();
    const mat = new THREE.MeshLambertMaterial({ map: checkerTexture("#111318", tint) });
    group.add(new THREE.Mesh(g, mat));
  };
  makeLine(0, "#f2f3f5");
  if (isLinear) makeLine(N - 1, "#ffd166");   // 直线竞速终点线（黄白格）
  return group;
}

/* ================= 草地（修剪条纹 + 噪点，F1 赛场割草纹） ================= */
function grassTexture() {
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

function buildGround() {
  let minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9;
  for (const p of pts) {
    minx = Math.min(minx, p.x); maxx = Math.max(maxx, p.x);
    miny = Math.min(miny, p.y); maxy = Math.max(maxy, p.y);
  }
  const cx = (minx + maxx) / 2, cz = (miny + maxy) / 2;
  const span = Math.max(maxx - minx, maxy - miny);
  const size = span + 2200;
  const tex = grassTexture();
  tex.repeat.set(size / 9, size / 9);
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(size, size),
    new THREE.MeshLambertMaterial({ map: tex })
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(cx, 0, cz);
  mesh.receiveShadow = true;
  return mesh;
}

/* ================= 树木（InstancedMesh，避开路面随机分布） ================= */
function buildTrees() {
  const spots = [];
  const step = 5;
  for (let i = 0; i < N; i += step) {
    for (const side of [1, -1]) {
      if (hash01(i, side) > 0.62) continue;
      const off = hw[i] + 16 + hash01(i, side * 3) * 46;
      const x = pts[i].x + nor[i].x * side * off;
      const z = pts[i].y + nor[i].y * side * off;
      let ok = true;
      for (let j = 0; j < N; j += 6) {
        const dx = pts[j].x - x, dz = pts[j].y - z;
        if (dx * dx + dz * dz < 144) { ok = false; break; }   // 距赛道 <12m 放弃
      }
      if (ok) spots.push([x, z, hash01(i, side * 7)]);
    }
  }
  const count = Math.min(spots.length, 260);
  const foliage = new THREE.InstancedMesh(
    new THREE.ConeGeometry(1, 1, 7),
    new THREE.MeshLambertMaterial({ color: 0xffffff }),
    count
  );
  const trunks = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.22, 0.3, 1, 6),
    new THREE.MeshLambertMaterial({ color: 0x6b4a2e }),
    count
  );
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const greens = [new THREE.Color(0x2f6b33), new THREE.Color(0x3f7d3a), new THREE.Color(0x28582e)];
  for (let k = 0; k < count; k++) {
    const [x, z, r] = spots[k];
    const h = 4.5 + r * 4.5, w = 1.7 + r * 1.3, trunkH = h * 0.22;
    q.setFromAxisAngle(up, r * Math.PI * 2);
    m.compose(new THREE.Vector3(x, trunkH + h / 2, z), q, s.set(w, h, w));
    foliage.setMatrixAt(k, m);
    foliage.setColorAt(k, greens[Math.floor(r * 3) % 3]);
    m.compose(new THREE.Vector3(x, trunkH / 2, z), q, s.set(1, trunkH, 1));
    trunks.setMatrixAt(k, m);
  }
  foliage.castShadow = true;
  trunks.castShadow = true;
  const g = new THREE.Group();
  g.add(foliage, trunks);
  return g;
}

/* ================= 看台（分层退台式，远离赛道，低饱和配色） ================= */
function buildGrandstands() {
  const group = new THREE.Group();
  const seatColors = [0x5a6c86, 0x8a5a5a, 0x8a7a4a];
  const roofColor = 0xc9ced6;
  // 起点直道只在 PIT 对面一侧布置（另一侧是维修区），另外两处各放一座
  const places = isLinear ? [{ idx: Math.floor(N * 0.35), side: -1 }] : [
    { idx: 2, side: -1 },
    { idx: Math.floor(N * 0.18), side: -1 },
    { idx: Math.floor(N * 0.72), side: 1 },
  ];
  places.forEach(({ idx, side }, k) => {
    const p = pts[idx], n = nor[idx];
    const off = hw[idx] + 24;
    const x = p.x + n.x * side * off;
    const z = p.y + n.y * side * off;
    const len = 40 + hash01(idx, side) * 16;
    const stand = new THREE.Group();
    // 三层退台：低→高逐层后退（朝赛道方向看是阶梯座席）
    const tierMat = new THREE.MeshLambertMaterial({ color: seatColors[k % seatColors.length] });
    for (let t = 0; t < 3; t++) {
      const tier = new THREE.Mesh(new THREE.BoxGeometry(len, 2.6, 5), tierMat);
      tier.position.set(0, 1.3 + t * 2.6, t * 2.6 * (side > 0 ? -1 : 1) * -1);
      // 让退台方向背向赛道：每层往远离赛道一侧平移
      tier.position.z = -side * t * 2.6;
      tier.position.y = 1.3 + t * 2.6;
      tier.castShadow = true;
      tier.receiveShadow = true;
      stand.add(tier);
    }
    const roof = new THREE.Mesh(
      new THREE.BoxGeometry(len + 2, 0.4, 8),
      new THREE.MeshLambertMaterial({ color: roofColor })
    );
    roof.position.set(0, 9.4, -side * 3.4);
    roof.castShadow = true;
    stand.add(roof);
    // 背面支撑墙
    const back = new THREE.Mesh(
      new THREE.BoxGeometry(len, 8.8, 0.6),
      new THREE.MeshLambertMaterial({ color: 0x6b7280 })
    );
    back.position.set(0, 4.4, -side * 7.4);
    stand.add(back);
    stand.position.set(x, 0, z);
    // 长边沿赛道方向：局部 +x → tan 方向
    const txv = -n.y, tyv = n.x;
    stand.rotation.y = -Math.atan2(tyv, txv);
    group.add(stand);
  });
  return group;
}

/* ================= 天空穹顶 + 灯光 + 雾 ================= */
export function createSky(scene) {
  const geo = new THREE.SphereGeometry(2400, 24, 12);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      top: { value: new THREE.Color(0x3273b8) },
      bottom: { value: new THREE.Color(SKY_HORIZON) },
    },
    vertexShader: `
      varying vec3 vPos;
      void main() {
        vPos = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform vec3 top; uniform vec3 bottom; varying vec3 vPos;
      void main() {
        float h = clamp(vPos.y / 900.0, 0.0, 1.0);
        gl_FragColor = vec4(mix(bottom, top, pow(h, 0.75)), 1.0);
      }`,
  });
  scene.add(new THREE.Mesh(geo, mat));

  scene.add(new THREE.HemisphereLight(0xcfe4f5, 0x2e4d2b, 1.1));

  const sun = new THREE.DirectionalLight(0xfff2dc, 3.0);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -95;
  sun.shadow.camera.right = 95;
  sun.shadow.camera.top = 95;
  sun.shadow.camera.bottom = -95;
  sun.shadow.camera.near = 20;
  sun.shadow.camera.far = 700;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.02;
  scene.add(sun);
  scene.add(sun.target);
  scene.fog = new THREE.Fog(SKY_HORIZON, 550, 1700);
  return sun;
}

/* ================= 发车龙门架（灯组与 race.lights 联动） ================= */
let gantryLampMats = [];

export function setGantryLights(lit) {
  const n = Math.max(0, Math.min(5, lit | 0));
  for (let k = 0; k < gantryLampMats.length; k++) {
    gantryLampMats[k].emissive.setHex(k < n ? 0xff1a1a : 0x110505);
  }
}

function buildGantry() {
  const group = new THREE.Group();
  const p = pts[0], n0 = nor[0];
  const wSpan = hw[0] + 2.4;
  const dark = new THREE.MeshStandardMaterial({ color: 0x2b2e35, metalness: 0.5, roughness: 0.5 });
  const beam = new THREE.Mesh(new THREE.BoxGeometry(wSpan * 2 + 0.6, 0.85, 0.6), dark);
  beam.position.y = 6.9;
  beam.castShadow = true;
  group.add(beam);
  for (const side of [1, -1]) {
    const pillar = new THREE.Mesh(new THREE.BoxGeometry(0.5, 7.2, 0.5), dark);
    pillar.position.set(side * wSpan, 3.6, 0);
    pillar.castShadow = true;
    group.add(pillar);
  }
  // 5 组发车灯（横排，每组一个发光盒）
  gantryLampMats = [];
  const housing = new THREE.MeshStandardMaterial({ color: 0x101114, roughness: 0.7 });
  for (let k = 0; k < 5; k++) {
    const lampMat = new THREE.MeshStandardMaterial({ color: 0x1a0b0b, emissive: 0x110505, roughness: 0.4 });
    gantryLampMats.push(lampMat);
    const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.34, 0.3), lampMat);
    lamp.position.set((k - 2) * 0.95, 6.25, 0.1);
    group.add(lamp);
    const h = new THREE.Mesh(new THREE.BoxGeometry(0.44, 1.15, 0.4), housing);
    h.position.set((k - 2) * 0.95, 6.35, -0.06);
    group.add(h);
  }
  group.position.set(p.x, 0, p.y);
  group.rotation.y = Math.atan2(-n0.y, n0.x);   // 局部 +x 对准赛道横向
  return group;
}

/* ================= 维修墙 + PIT 房（起点大直道外侧） ================= */
function buildPit() {
  const group = new THREE.Group();
  const i0 = 0, i1 = Math.min(14, N - 1);
  const p0 = pts[i0], p1 = pts[i1];
  const cx = (p0.x + p1.x) / 2, cz = (p0.y + p1.y) / 2;
  const len = Math.hypot(p1.x - p0.x, p1.y - p0.y) + 26;
  const ni = Math.floor((i0 + i1) / 2);
  const wallOff = hw[ni] + 4.2;
  const wallC = {
    x: cx + nor[ni].x * wallOff,
    z: cz + nor[ni].y * wallOff,
  };
  const wall = new THREE.Mesh(
    new THREE.BoxGeometry(len, 1.05, 0.35),
    new THREE.MeshStandardMaterial({ color: 0xd7dade, roughness: 0.85 })
  );
  wall.position.set(wallC.x, 0.55, wallC.z);
  wall.rotation.y = -Math.atan2(tan[ni].y, tan[ni].x);
  wall.castShadow = true;
  group.add(wall);

  const pitOff = hw[ni] + 16;
  const pit = new THREE.Mesh(
    new THREE.BoxGeometry(len * 0.72, 8.5, 13),
    new THREE.MeshStandardMaterial({ color: 0x8f97a3, roughness: 0.8 })
  );
  pit.position.set(cx + nor[ni].x * pitOff, 4.25, cz + nor[ni].y * pitOff);
  pit.rotation.y = -Math.atan2(tan[ni].y, tan[ni].x);
  pit.castShadow = true;
  const pitRoof = new THREE.Mesh(
    new THREE.BoxGeometry(len * 0.72 + 3, 0.6, 16),
    new THREE.MeshStandardMaterial({ color: 0x3a3f47, roughness: 0.7 })
  );
  pitRoof.position.set(pit.position.x, 8.9, pit.position.z);
  pitRoof.rotation.y = pit.rotation.y;
  group.add(pit, pitRoof);
  return group;
}

/* ================= 直道广告板（曲率小处两侧布设） ================= */
function buildBoards() {
  const group = new THREE.Group();
  const colors = [0xd0342c, 0xf2f3f5, 0x2f6db3, 0xf0b429, 0x1d9d74];
  let k = 0;
  for (let i = 0; i < N; i += 3) {
    if (Math.abs(curvS[i]) > 1 / 320 || (i % 42 !== 0)) continue;
    const side = k % 2 === 0 ? 1 : -1;
    const off = hw[i] + 4.6;
    const board = new THREE.Mesh(
      new THREE.BoxGeometry(11, 0.95, 0.18),
      new THREE.MeshStandardMaterial({ color: colors[k % colors.length], roughness: 0.75 })
    );
    board.position.set(
      pts[i].x + nor[i].x * side * off,
      0.5,
      pts[i].y + nor[i].y * side * off
    );
    board.rotation.y = -Math.atan2(tan[i].y, tan[i].x);
    board.castShadow = true;
    group.add(board);
    k++;
    if (k > 40) break;
  }
  return group;
}

/* ================= 云层（白色扁球体云团，纯几何 + 受雾，避免透明精灵的边缘发黑） ================= */
function buildClouds() {
  const group = new THREE.Group();
  const mat = new THREE.MeshLambertMaterial({ color: 0xf4f7fa });
  const geo = new THREE.SphereGeometry(1, 12, 8);
  let minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9;
  for (const p of pts) {
    minx = Math.min(minx, p.x); maxx = Math.max(maxx, p.x);
    miny = Math.min(miny, p.y); maxy = Math.max(maxy, p.y);
  }
  const cx = (minx + maxx) / 2, cz = (miny + maxy) / 2;
  const span = Math.max(maxx - minx, maxy - miny) + 900;
  for (let k = 0; k < 9; k++) {
    const px = cx + (hash01(k, 1) - 0.5) * span;
    const pz = cz + (hash01(k, 3) - 0.5) * span;
    const py = 290 + hash01(k, 2) * 170;
    const cluster = new THREE.Group();
    const blobs = [[0, 0, 0, 55 + hash01(k, 4) * 35], [-0.8, -0.15, 0.2, 38], [0.75, -0.1, -0.25, 42], [0.1, 0.3, -0.4, 30]];
    for (const [ox, oy, oz, s] of blobs) {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(ox * s, oy * s, oz * s);
      m.scale.set(s, s * 0.42, s * 0.72);
      cluster.add(m);
    }
    cluster.position.set(px, py, pz);
    group.add(cluster);
  }
  return group;
}

/* ================= 赛道整组重建（换赛道时调用） ================= */
let trackGroup = null;

export function buildTrackScene(scene) {
  if (trackGroup) {
    scene.remove(trackGroup);
    trackGroup.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        (Array.isArray(o.material) ? o.material : [o.material]).forEach(mm => {
          if (mm.map) mm.map.dispose();
          mm.dispose();
        });
      }
    });
  }
  trackGroup = new THREE.Group();
  trackGroup.add(buildGround());
  trackGroup.add(buildAsphalt());
  trackGroup.add(buildKerbs());
  trackGroup.add(buildEdgeLines());
  trackGroup.add(buildStartLine());
  trackGroup.add(buildTrees());
  trackGroup.add(buildGrandstands());
  trackGroup.add(buildGantry());
  trackGroup.add(buildPit());
  trackGroup.add(buildBoards());
  trackGroup.add(buildClouds());
  scene.add(trackGroup);
  return trackGroup;
}
