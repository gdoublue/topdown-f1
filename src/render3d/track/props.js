// 赛道通用景物构建器：沥青/边线/路牙/起终点线/地面/树木/看台/龙门架/维修区/广告牌/桥墩/云。
// 全部从 geometry.js 权威数据构建；赛道间差异通过 options（树密度/云数/广告牌配色等）
// 与各赛道 decorate 钩子（track/tracks/<id>.js）注入。
import * as THREE from "three";
import {
  pts, N, nor, tan, hw, kerbFlag, cumDist, curvS, isLinear, roadElev, bridges, indexAtDistance, LAP_LENGTH
} from "../../track/geometry.js";
import {
  hash01, sampleIndices, ribbonGeometry, quadSegmentsGeometry,
  asphaltTexture, grassTexture, checkerTexture, maxAniso, makeGroundSampler
} from "./shared.js";
import { layoutTrees } from "./treeLayout.js";

let groundAt = null;   // 每次 buildTrackScene 重建；buildXXX 里取地面高度用
export function prepareGroundSampler() { groundAt = makeGroundSampler(); return groundAt; }

export function buildGround() {
  let minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9;
  for (const p of pts) {
    minx = Math.min(minx, p.x); maxx = Math.max(maxx, p.x);
    miny = Math.min(miny, p.y); maxy = Math.max(maxy, p.y);
  }
  const cx = (minx + maxx) / 2, cz = (miny + maxy) / 2;
  const span = Math.max(maxx - minx, maxy - miny);
  /* 起伏地面只在赛道范围（外扩 130m，覆盖裙边/树木）用精细网格铺，远景用稀疏网格
     继续跟随 DEM 地形（斯帕 102m 落差时不能再退回 0 平面，否则近处山坡会断成悬崖）。
     同样顶点数下近处单元小一倍 —— ~13m 的大三角形会跨过带横坡的路面，
     从外侧高点斜切到内侧低点，看上去就是草地盖住了弯道内侧。 */
  const near = span + 260;
  const SEG = 256;
  const farSize = span + 2200;
  const strip = (farSize - near) / 2;   // 远景四条带，与精细网格拼成整块草地（不重叠）
  const tex = grassTexture();           // 同一张草皮：UV 按世界尺寸 9m 一格
  const mat = new THREE.MeshLambertMaterial({ map: tex });
  const group = new THREE.Group();
  const addPatch = (w, d, x, z, segX, segY) => {
    const g = new THREE.PlaneGeometry(w, d, segX, segY);
    g.rotateX(-Math.PI / 2);            // 先平铺到 xz 平面，再按世界坐标抬升
    const pos = g.attributes.position;
    const uv = g.attributes.uv;
    for (let i = 0; i < uv.count; i++) {
      uv.setXY(i, (pos.getX(i) + x) / 9, (pos.getZ(i) + z) / 9);  // 世界坐标 UV → 拼缝处纹路连续
    }
    for (let i = 0; i < pos.count; i++) {
      pos.setY(i, groundAt(pos.getX(i) + x, pos.getZ(i) + z));
    }
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, mat);
    m.position.set(x, 0, z);
    m.receiveShadow = true;
    group.add(m);
  };
  addPatch(near, near, cx, cz, SEG, SEG);
  addPatch(farSize, strip, cx, cz - (near + strip) / 2, 40, 12);
  addPatch(farSize, strip, cx, cz + (near + strip) / 2, 40, 12);
  addPatch(strip, near, cx - (near + strip) / 2, cz, 12, 40);
  addPatch(strip, near, cx + (near + strip) / 2, cz, 12, 40);
  return group;
}

/* ================= 树木（InstancedMesh，避开路面随机分布） ================= */
export function buildAsphalt() {
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
export function buildEdgeLines() {
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
export function buildKerbs() {
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
export function buildStartLine() {
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

/* ================= 树木（InstancedMesh，严格避开路面） ================= */
export function buildTrees(opts = {}) {
  const { spots } = layoutTrees(opts);
  const count = spots.length;
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
    const gY = groundAt ? groundAt(x, z) : 0;   // 贴合起伏地形（路堤过渡区）
    const h = 4.5 + r * 4.5, w = 1.7 + r * 1.3, trunkH = h * 0.22;
    q.setFromAxisAngle(up, r * Math.PI * 2);
    m.compose(new THREE.Vector3(x, gY + trunkH + h / 2, z), q, s.set(w, h, w));
    foliage.setMatrixAt(k, m);
    foliage.setColorAt(k, greens[Math.floor(r * 3) % 3]);
    m.compose(new THREE.Vector3(x, gY + trunkH / 2, z), q, s.set(1, trunkH, 1));
    trunks.setMatrixAt(k, m);
  }
  foliage.castShadow = true;
  trunks.castShadow = true;
  const g = new THREE.Group();
  g.add(foliage, trunks);
  return g;
}

/* ================= 看台（分层退台式，远离赛道，低饱和配色） ================= */
export function buildGrandstands() {
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
    stand.position.set(x, groundAt ? groundAt(x, z) : 0, z);
    // 长边沿赛道方向：局部 +x → tan 方向
    const txv = -n.y, tyv = n.x;
    stand.rotation.y = -Math.atan2(tyv, txv);
    group.add(stand);
  });
  return group;
}

/* ================= 天空穹顶 + 灯光 + 雾 ================= */
/* 天穹网格：相机远平面 3200 < 天穹最远壁（2400+赛道对角），必须让天穹跟随相机
   XZ 移动（经典 skybox），否则车开到远离球心的角落、朝球心方向看时远壁被远平面
   裁剪，露出黑色清屏色 —— 即偶发的"多边形黑球"（边界是天穹 24 段棱面与远平面的
   交线）。渐变只依赖局部 y，跟随 XZ 不改变任何视觉。 */
export function buildGantry() {
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
export function buildPit() {
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
  // 真实高程赛道起点直道可能带坡度，维修区整体贴合当地路面高度（不再是固定 y=0）
  const baseY = roadElev(ni, hw[ni] + 4.2);
  wall.position.set(wallC.x, baseY + 0.55, wallC.z);
  wall.rotation.y = -Math.atan2(tan[ni].y, tan[ni].x);
  wall.castShadow = true;
  group.add(wall);

  const pitOff = hw[ni] + 16;
  const pit = new THREE.Mesh(
    new THREE.BoxGeometry(len * 0.72, 8.5, 13),
    new THREE.MeshStandardMaterial({ color: 0x8f97a3, roughness: 0.8 })
  );
  pit.position.set(cx + nor[ni].x * pitOff, baseY + 4.25, cz + nor[ni].y * pitOff);
  pit.rotation.y = -Math.atan2(tan[ni].y, tan[ni].x);
  pit.castShadow = true;
  const pitRoof = new THREE.Mesh(
    new THREE.BoxGeometry(len * 0.72 + 3, 0.6, 16),
    new THREE.MeshStandardMaterial({ color: 0x3a3f47, roughness: 0.7 })
  );
  pitRoof.position.set(pit.position.x, baseY + 8.9, pit.position.z);
  pitRoof.rotation.y = pit.rotation.y;
  group.add(pit, pitRoof);
  return group;
}

/* ================= 直道广告板（曲率小处两侧布设） ================= */
export function buildBoards(opts = {}) {
  const group = new THREE.Group();
  const colors = opts.boardPalette ?? [0xd0342c, 0xf2f3f5, 0x2f6db3, 0xf0b429, 0x1d9d74];
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
      (groundAt ? groundAt(pts[i].x + nor[i].x * side * off, pts[i].y + nor[i].y * side * off) : 0) + 0.5,
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


/* ================= 立交桥墩（geometry.bridges 桥位下方） ================= */
export function buildBridgePiers() {
  const group = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0x9aa0a6, roughness: 0.85, metalness: 0.05 });
  for (const b of bridges) {
    const i = indexAtDistance(b.s);
    const top = roadElev(i, 0) - 0.45;
    if (top < 1.2) continue;              // 地面衔接区不立柱
    for (const side of [1, -1]) {
      const off = side * hw[i] * 0.55;
      const gY = groundAt ? groundAt(pts[i].x + nor[i].x * off, pts[i].y + nor[i].y * off) : 0;
      const hgt = top - gY;
      if (hgt < 1) continue;
      const pier = new THREE.Mesh(new THREE.BoxGeometry(1.5, hgt, 2.4), mat);
      pier.position.set(pts[i].x + nor[i].x * off, gY + hgt / 2, pts[i].y + nor[i].y * off);
      pier.castShadow = true;
      group.add(pier);
    }
  }
  return group;
}

/* ================= 云层（纯几何云团）
   MeshBasicMaterial 不受光照：Lambert 云球底面只吃暗绿地面反光，从下看是黑影；
   纯白无光照 + 受雾，任何角度都是亮白并自然融入地平线 ================= */
export function buildClouds(opts = {}) {
  const group = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({ color: 0xf8fbff });
  const geo = new THREE.SphereGeometry(1, 12, 8);
  let minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9;
  for (const p of pts) {
    minx = Math.min(minx, p.x); maxx = Math.max(maxx, p.x);
    miny = Math.min(miny, p.y); maxy = Math.max(maxy, p.y);
  }
  const cx = (minx + maxx) / 2, cz = (miny + maxy) / 2;
  const span = Math.max(maxx - minx, maxy - miny) + 900;
  for (let k = 0; k < (opts.cloudCount ?? 9); k++) {
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
export let gantryLampMats = [];

export function setGantryLights(lit) {
  const n = Math.max(0, Math.min(5, lit | 0));
  for (let k = 0; k < gantryLampMats.length; k++) {
    gantryLampMats[k].emissive.setHex(k < n ? 0xff1a1a : 0x110505);
  }
}