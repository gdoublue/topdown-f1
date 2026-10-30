// 赛道通用景物构建器：沥青/边线/路牙/起终点线/地面/树木/看台/龙门架/维修区/广告牌/桥墩/云。
// 全部从 geometry.js 权威数据构建；赛道间差异通过 options（树密度/云数/广告牌配色等）
// 与各赛道 decorate 钩子（track/tracks/<id>.js）注入。
import * as THREE from "three";
import {
  pts, N, nor, tan, hw, kerbFlag, cumDist, curvS, isLinear, roadElev, roadAt, grade as roadGrade, bridges, indexAtDistance, LAP_LENGTH
} from "../../track/geometry.js";
import {
  hash01, sampleIndices, ribbonGeometry, quadSegmentsGeometry,
  asphaltTextures, grassTexture, checkerTexture, kerbTextures, maxAniso, makeGroundSampler
} from "./shared.js";
import { layoutTrees } from "./treeLayout.js";

let groundAt = null;   // 每次 buildTrackScene 重建；buildXXX 里取地面高度用
let _nearGridY = null; // 近处 256×256 精细草地网格顶点高度缓存（供车辆/镜头精确三角形插值）
let _nearCx = 0, _nearCz = 0, _nearSpan = 1, _nearSeg = 256;

export function prepareGroundSampler() { groundAt = makeGroundSampler(); return groundAt; }

/* 精确采样 3D 草地三角形网格在世界坐标 (x, z) 处的实际渲染高度：
   与 THREE.PlaneGeometry(near, near, SEG, SEG) 的三角剖分（fx + fz <= 1 左上三角 / > 1 右下三角）
   100% 同构，确保赛车冲出赛道进入草坪时轮胎严格贴合草地网格表面，绝不陷入草坪以下。 */
export function sampleGroundMeshY(x, z) {
  if (_nearGridY) {
    const u = ((x - _nearCx) / _nearSpan + 0.5) * _nearSeg;
    const v = ((z - _nearCz) / _nearSpan + 0.5) * _nearSeg;
    if (u >= 0 && u < _nearSeg && v >= 0 && v < _nearSeg) {
      const ix = u | 0, iz = v | 0;
      const fx = u - ix, fz = v - iz;
      const row = _nearSeg + 1;
      const base = iz * row + ix;
      const y00 = _nearGridY[base];
      const y10 = _nearGridY[base + 1];
      const y01 = _nearGridY[base + row];
      const y11 = _nearGridY[base + row + 1];
      if (fx + fz <= 1) {
        return y00 + fx * (y10 - y00) + fz * (y01 - y00);
      }
      return y11 + (1 - fx) * (y01 - y11) + (1 - fz) * (y10 - y11);
    }
  }
  return groundAt ? groundAt(x, z) : 0;
}

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
  _nearCx = cx; _nearCz = cz; _nearSpan = near; _nearSeg = SEG;
  _nearGridY = new Float32Array((SEG + 1) * (SEG + 1));

  const farSize = span + 2200;
  const strip = (farSize - near) / 2;   // 远景四条带，与精细网格拼成整块草地（不重叠）
  const tex = grassTexture();           // 同一张草皮：UV 按世界尺寸 9m 一格
  const mat = new THREE.MeshLambertMaterial({ map: tex });
  const group = new THREE.Group();
  const addPatch = (w, d, x, z, segX, segY, isNear = false) => {
    const g = new THREE.PlaneGeometry(w, d, segX, segY);
    g.rotateX(-Math.PI / 2);            // 先平铺到 xz 平面，再按世界坐标抬升
    const pos = g.attributes.position;
    const uv = g.attributes.uv;
    for (let i = 0; i < uv.count; i++) {
      uv.setXY(i, (pos.getX(i) + x) / 9, (pos.getZ(i) + z) / 9);  // 世界坐标 UV → 拼缝处纹路连续
    }
    for (let i = 0; i < pos.count; i++) {
      const wy = groundAt(pos.getX(i) + x, pos.getZ(i) + z);
      pos.setY(i, wy);
      if (isNear) _nearGridY[i] = wy;
    }
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, mat);
    m.position.set(x, 0, z);
    m.receiveShadow = true;
    group.add(m);
  };
  addPatch(near, near, cx, cz, SEG, SEG, true);
  addPatch(farSize, strip, cx, cz - (near + strip) / 2, 40, 12);
  addPatch(farSize, strip, cx, cz + (near + strip) / 2, 40, 12);
  addPatch(strip, near, cx - (near + strip) / 2, cz, 12, 40);
  addPatch(strip, near, cx + (near + strip) / 2, cz, 12, 40);
  return group;
}

/* ================= 沥青路面 =================
   条带只有左右两列顶点，顶点色做不出"中间暗、两边亮"的赛车线（插值到边缘都是 1），
   旧的 groove 顶点色实际是空操作 —— 车辙/积灰/骨料全部改由贴图承担：
   u 横向铺满整幅路宽（车辙正好压在中线），v 沿赛道每 16m 循环，颗粒不被拉长。
   材质用 map + roughnessMap：骨料处更涩、车辙被磨光更亮，阳光下有轻微反光变化。 */
export function buildAsphalt() {
  const list = sampleIndices();
  const geo = ribbonGeometry(
    list,
    i => hw[i],
    i => -hw[i],
    0.05,
    null,
    16
  );
  const tex = asphaltTextures();
  const mat = new THREE.MeshStandardMaterial({
    map: tex.map,
    roughnessMap: tex.roughnessMap,
    roughness: 1.0,          // 实际粗糙度全部由 roughnessMap 给（约 0.48~0.95）
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
  // 紧贴 0.05m 沥青表面（+4mm），配合 polygonOffset 杜绝悬空感与深度闪烁
  const mat = new THREE.MeshStandardMaterial({
    color: 0xdce0e5,
    roughness: 0.80,
    metalness: 0.0,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
  for (const side of [1, -1]) {
    const geo = ribbonGeometry(
      list,
      i => side * (hw[i] - 0.16),
      i => side * (hw[i] - 0.46),
      0.054,
      () => [1, 1, 1]
    );
    const line = new THREE.Mesh(geo, mat);
    line.receiveShadow = true;     // 树影/看台影落在路面上时，白线也要跟着变暗
    group.add(line);
  }
  return group;
}

/* ================= 红白路缘石（kerbFlag 路段两侧；直线赛道全程） =================
   使用高分辨率 FIA 锯齿阶梯贴图 + 凹凸贴图（每 2.4m 重复一红一白两块预制路肩石），
   消除旧版跨采样段顶点色线性插值造成的红白模糊渐变，并呈现橡胶碾压痕迹与锯齿立面。 */
export function buildKerbs() {
  const group = new THREE.Group();
  const kTex = kerbTextures();
  const mat = new THREE.MeshStandardMaterial({
    map: kTex.map,
    bumpMap: kTex.bumpMap,
    bumpScale: 0.024,
    roughness: 0.68,
    metalness: 0.0,
  });
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
      i => side * (hw[i] + 1.55),
      i => side * hw[i],
      0.068,
      null,
      2.4
    );
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  return group;
}

/* ================= 起终点方格线 + FIA F1 标准发车格白框 =================
   严格跟随赛道在起终点处的真实高程（如上海赛道起点高程 +2.38m）、纵向坡度与横坡，
   修复旧版固定 y=0.1 导致起跑线在上海等带高程赛道埋入地下不可见的问题。 */
export function buildStartLine() {
  const group = new THREE.Group();
  const makeLine = (sampleIdx, tint) => {
    const w = hw[sampleIdx] + 0.2;
    const p = pts[sampleIdx], nn = nor[sampleIdx];
    const tx = -nn.y, ty = nn.x;   // 沿赛道方向
    const cx = p.x, cz = p.y;
    const L = 2.4;
    const gSlope = (roadGrade && roadGrade[sampleIdx]) || 0;
    const cornerDefs = [
      { lat: w, along: L / 2, u: 0, v: 1 },
      { lat: -w, along: L / 2, u: 1, v: 1 },
      { lat: -w, along: -L / 2, u: 1, v: 0 },
      { lat: w, along: -L / 2, u: 0, v: 0 },
    ];
    const posArr = new Float32Array(12);
    const uvArr = new Float32Array(8);
    cornerDefs.forEach((c, i) => {
      posArr[i * 3] = cx + nn.x * c.lat + tx * c.along;
      posArr[i * 3 + 1] = roadElev(sampleIdx, c.lat) + gSlope * c.along + 0.056;
      posArr[i * 3 + 2] = cz + nn.y * c.lat + ty * c.along;
      uvArr[i * 2] = c.u;
      uvArr[i * 2 + 1] = c.v;
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(posArr, 3));
    g.setAttribute("uv", new THREE.BufferAttribute(uvArr, 2));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    g.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({
      map: checkerTexture("#111318", tint),
      roughness: 0.78,
      metalness: 0.0,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    const m = new THREE.Mesh(g, mat);
    m.receiveShadow = true;
    group.add(m);
  };
  makeLine(0, "#f2f3f5");
  if (isLinear) makeLine(N - 1, "#ffd166");   // 直线竞速终点线（黄白格）

  // 环形赛道绘制 10 个交错 FIA F1 发车格（与 physics.js 中 POLE_OFFSET_M=12, GRID_INTERVAL_M=8, lateral=±1.7 完全对齐）
  if (!isLinear && LAP_LENGTH > 200) {
    const gridPosArr = [];
    const gridColArr = [];
    const gridIdxArr = [];
    const white = [0.92, 0.94, 0.96];
    const yellow = [0.96, 0.78, 0.18];
    let vCount = 0;

    const pushBoxQuad = (sCenter, latCenter, a0, a1, l0, l1, col) => {
      const sA = (sCenter + a0 + LAP_LENGTH) % LAP_LENGTH;
      const sB = (sCenter + a1 + LAP_LENGTH) % LAP_LENGTH;
      const profA = roadAt(sA), profB = roadAt(sB);
      const iA = profA.i, iB = profB.i;
      const pA = pts[iA], nA = nor[iA], tA = tan[iA];
      const pB = pts[iB], nB = nor[iB], tB = tan[iB];
      const dSA = sA - cumDist[iA], dSB = sB - cumDist[iB];
      const cxA = pA.x + tA.x * dSA, czA = pA.y + tA.y * dSA;
      const cxB = pB.x + tB.x * dSB, czB = pB.y + tB.y * dSB;
      const latL = latCenter + l0, latR = latCenter + l1;
      const yAL = profA.y + profA.bank * latL + 0.055;
      const yAR = profA.y + profA.bank * latR + 0.055;
      const yBL = profB.y + profB.bank * latL + 0.055;
      const yBR = profB.y + profB.bank * latR + 0.055;

      gridPosArr.push(
        cxA + nA.x * latL, yAL, czA + nA.y * latL,
        cxA + nA.x * latR, yAR, czA + nA.y * latR,
        cxB + nB.x * latR, yBR, czB + nB.y * latR,
        cxB + nB.x * latL, yBL, czB + nB.y * latL
      );
      for (let k = 0; k < 4; k++) gridColArr.push(col[0], col[1], col[2]);
      gridIdxArr.push(vCount, vCount + 1, vCount + 2, vCount, vCount + 2, vCount + 3);
      vCount += 4;
    };

    for (let g = 0; g < 10; g++) {
      const sSlot = (LAP_LENGTH - (12 + g * 8) + LAP_LENGTH) % LAP_LENGTH;
      const lat = g % 2 === 0 ? 1.7 : -1.7;
      const bw = 1.18, frontX = 2.95, sideLen = 2.6, lineW = 0.14;
      // 前沿白框横线 + 左右侧翼线（U 型发车框）
      pushBoxQuad(sSlot, lat, frontX - lineW, frontX, -bw, bw, white);
      pushBoxQuad(sSlot, lat, frontX - sideLen, frontX, -bw, -bw + lineW, white);
      pushBoxQuad(sSlot, lat, frontX - sideLen, frontX, bw - lineW, bw, white);
      // 前轮对位黄线（FIA 真实发车格前轮停车参考线）
      pushBoxQuad(sSlot, lat, 1.70, 1.82, -bw - 0.22, -bw + 0.35, yellow);
      pushBoxQuad(sSlot, lat, 1.70, 1.82, bw - 0.35, bw + 0.22, yellow);
    }

    const gGeo = new THREE.BufferGeometry();
    gGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(gridPosArr), 3));
    gGeo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(gridColArr), 3));
    gGeo.setIndex(gridIdxArr);
    gGeo.computeVertexNormals();
    const gMat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.80,
      metalness: 0.0,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    const gridMesh = new THREE.Mesh(gGeo, gMat);
    gridMesh.receiveShadow = true;
    group.add(gridMesh);
  }

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
      tier.position.set(0, 1.3 + t * 2.6, -side * t * 2.6);
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

/* ================= 起跑发车龙门架（5 组 FIA 红灯 + 横跨桁架） =================
   整体高度对齐起点路面 roadElev(0, 0)，立柱向下延伸 1.2m 扎入路肩，
   修复在上海赛道（起点路面 +2.38m）等带高程赛道中龙门架下沉 2.38m 的问题。 */
export function buildGantry() {
  const group = new THREE.Group();
  const p = pts[0], n0 = nor[0];
  const wSpan = hw[0] + 2.4;
  const dark = new THREE.MeshStandardMaterial({ color: 0x252830, metalness: 0.55, roughness: 0.45 });
  const beam = new THREE.Mesh(new THREE.BoxGeometry(wSpan * 2 + 0.8, 0.9, 0.7), dark);
  beam.position.y = 7.1;
  beam.castShadow = true;
  group.add(beam);
  for (const side of [1, -1]) {
    const pillar = new THREE.Mesh(new THREE.BoxGeometry(0.52, 8.4, 0.52), dark);
    pillar.position.set(side * wSpan, 3.2, 0);
    pillar.castShadow = true;
    group.add(pillar);
  }
  // 5 组发车灯（横排，每组一个发光盒）
  gantryLampMats = [];
  const housing = new THREE.MeshStandardMaterial({ color: 0x101114, roughness: 0.7 });
  for (let k = 0; k < 5; k++) {
    const lampMat = new THREE.MeshStandardMaterial({ color: 0x1a0b0b, emissive: 0x110505, roughness: 0.35 });
    gantryLampMats.push(lampMat);
    const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.36, 0.32), lampMat);
    lamp.position.set((k - 2) * 0.95, 6.45, 0.12);
    group.add(lamp);
    const h = new THREE.Mesh(new THREE.BoxGeometry(0.46, 1.18, 0.42), housing);
    h.position.set((k - 2) * 0.95, 6.55, -0.05);
    group.add(h);
  }
  group.position.set(p.x, roadElev(0, 0), p.y);
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
