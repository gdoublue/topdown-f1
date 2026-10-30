// 3D 车辆通用件：几何工厂、程序化贴图、车底接触阴影、与车型无关的姿态同步管线。
// 车型模块（f1.js / su7.js / offroad.js）只依赖本文件，彼此不互相引用；
// 新增车型只需建 car/<id>.js 并在 car/index.js 的注册表里登记。
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { roadAt } from "../../track/geometry.js";
import { sampleGroundMeshY } from "../track/props.js";

export const _up = new THREE.Vector3(0, 1, 0);
export const _one = new THREE.Vector3(1, 1, 1);

// 把某材质桶里的几何合并成一个网格几何（全部转非索引再合并，确保属性一致）
export function mergeBucket(bucket) {
  if (!bucket.length) return new THREE.BufferGeometry();
  const nonIndexed = bucket.map(g => {
    const gi = g.index ? g.toNonIndexed() : g;
    if (!gi.attributes.normal) gi.computeVertexNormals();
    if (gi.attributes.uv) gi.deleteAttribute("uv");
    return gi;
  });
  const merged = mergeGeometries(nonIndexed, false);
  nonIndexed.forEach(g => g.dispose());
  return merged;
}

/* ================= 通用曲面放样与翼型生成工具 ================= */

// 多截面 3D 放样（Lofting）：给定一系列截面 Ring（每个截面是长度为 M 的 [x,y,z] 点数组），
// 沿截面序列生成平滑网格（支持闭合环、自动外法线校准与两端封口）
export function loftRings(rawRings, closedRing = true, capStart = false, capEnd = false) {
  const S = rawRings.length;
  const M = rawRings[0].length;

  // 自动检测闭合管的环绕方向，确保法线 100% 朝向管体外侧
  let rings = rawRings;
  if (closedRing && S >= 2 && M >= 3) {
    let orientSum = 0;
    for (let i = 0; i < S - 1; i++) {
      const r0 = rawRings[i], r1 = rawRings[i + 1];
      let cx = 0, cy = 0, cz = 0;
      for (let j = 0; j < M; j++) {
        cx += r0[j][0] + r1[j][0];
        cy += r0[j][1] + r1[j][1];
        cz += r0[j][2] + r1[j][2];
      }
      const inv = 1 / (2 * M);
      cx *= inv; cy *= inv; cz *= inv;
      for (let j = 0; j < M; j++) {
        const j1 = (j + 1) % M;
        const p00 = r0[j], p01 = r0[j1], p10 = r1[j];
        const ux = p10[0] - p00[0], uy = p10[1] - p00[1], uz = p10[2] - p00[2];
        const vx = p01[0] - p00[0], vy = p01[1] - p00[1], vz = p01[2] - p00[2];
        const nx = uy * vz - uz * vy;
        const ny = uz * vx - ux * vz;
        const nz = ux * vy - uy * vx;
        const rx = p00[0] - cx, ry = p00[1] - cy, rz = p00[2] - cz;
        orientSum += nx * rx + ny * ry + nz * rz;
      }
    }
    if (orientSum < 0) {
      rings = rawRings.map(r => r.slice().reverse());
    }
  }

  const pos = [];
  const pushTri = (a, b, c) => {
    pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
  };

  for (let i = 0; i < S - 1; i++) {
    const r0 = rings[i], r1 = rings[i + 1];
    const limit = closedRing ? M : M - 1;
    for (let j = 0; j < limit; j++) {
      const j1 = (j + 1) % M;
      const p00 = r0[j], p01 = r0[j1];
      const p10 = r1[j], p11 = r1[j1];
      pushTri(p00, p10, p11);
      pushTri(p00, p11, p01);
    }
  }

  if (capStart && closedRing) {
    const r0 = rings[0];
    const c = r0.reduce((acc, p) => [acc[0] + p[0] / M, acc[1] + p[1] / M, acc[2] + p[2] / M], [0, 0, 0]);
    for (let j = 0; j < M; j++) pushTri(c, r0[(j + 1) % M], r0[j]);
  }
  if (capEnd && closedRing) {
    const rN = rings[S - 1];
    const c = rN.reduce((acc, p) => [acc[0] + p[0] / M, acc[1] + p[1] / M, acc[2] + p[2] / M], [0, 0, 0]);
    for (let j = 0; j < M; j++) pushTri(c, rN[j], rN[(j + 1) % M]);
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

// 生成圆角梯形/超椭圆横截面（用于单体壳、鼻锥、引擎盖）
export function makeSuperSection(x, yBot, yTop, wBot, wTop, yMidFrac = 0.45, wMidScale = 1.06, segs = 24) {
  const pts = [];
  const h = Math.max(0.004, yTop - yBot);
  for (let i = 0; i < segs; i++) {
    const a = (i / segs) * Math.PI * 2; // 0 = 顶中, π/2 = 右(+z), π = 底中, 3π/2 = 左(-z)
    const ca = Math.cos(a), sa = Math.sin(a);
    const ny = Math.sign(ca) * Math.pow(Math.abs(ca), 0.78);
    const u = 0.5 + 0.5 * ny;
    const y = yBot + u * h;

    const baseW = wBot + (wTop - wBot) * u;
    const waistBell = Math.sin(u * Math.PI);
    const w = baseW * (1 + (wMidScale - 1) * waistBell);
    const nz = Math.sign(sa) * Math.pow(Math.abs(sa), 0.82);
    const z = nz * w;
    pts.push([x, y, z]);
  }
  return pts;
}

// 3D 翼型（后掠 + 鸥翼起伏 + 弯度攻角）：用于前翼四层翼片、尾翼勺形主翼、DRS 翼、梁翼
export function buildSweptAirfoil(spanFn, spanSegs = 28, profileSegs = 14) {
  const rings = [];
  for (let i = 0; i <= spanSegs; i++) {
    const v = -1 + (2 * i) / spanSegs;
    const { x, y, z, chord, thick, angle = 0, camber = 0.08 } = spanFn(v);
    const ca = Math.cos(angle), sa = Math.sin(angle);
    const ring = [];
    for (let j = 0; j < profileSegs; j++) {
      const theta = (j / profileSegs) * Math.PI * 2;
      const s = 0.5 * (1 - Math.cos(theta));
      const upper = theta < Math.PI ? 1 : -1;
      const yt = 5 * thick * (0.2969 * Math.sqrt(s) - 0.1260 * s - 0.3516 * s * s + 0.2843 * s * s * s - 0.1015 * s * s * s * s);
      const yc = -camber * chord * 4 * s * (1 - s);
      const lx = (0.5 - s) * chord;
      const ly = yc + upper * yt * chord;
      const wx = x + lx * ca - ly * sa;
      const wy = y + lx * sa + ly * ca;
      ring.push([wx, wy, z]);
    }
    rings.push(ring);
  }
  return loftRings(rings, true, true, true);
}

// 车号贴图（鼻锥上，按号码+颜色缓存共享）
const numTexCache = new Map();
export function numberTexture(num, fillColor = "#f5f6f8") {
  const key = String(num ?? "") + ":" + fillColor;
  let tex = numTexCache.get(key);
  if (tex) return tex;
  const cv = document.createElement("canvas");
  cv.width = 200; cv.height = 384;
  const c = cv.getContext("2d");
  c.clearRect(0, 0, 200, 384);
  c.textAlign = "center";
  c.textBaseline = "middle";
  const str = String(num ?? "1");
  const fs = Math.min(280, (0.92 * 200) / (0.62 * Math.max(1, str.length)), (0.62 * 384) / 0.72);
  c.font = `italic 900 ${fs}px Arial, sans-serif`;
  c.fillStyle = fillColor;
  c.strokeStyle = "#0b0d12";
  c.lineWidth = fs * 0.11;
  c.lineJoin = "round";
  c.strokeText(str, 100, 192);
  c.fillText(str, 100, 192);
  tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  numTexCache.set(key, tex);
  return tex;
}

/* 车底地面效应接触暗影贴图（Contact AO Shadow）：
   绘制文丘里底板暗区 + 前后翼投影 + 四个轮胎接地斑（Contact Patch）深色核心，
   紧贴沥青表面渲染，彻底消除侧向阳光下底盘与轮胎的"悬浮感"。 */
export function contactShadowTexture() {
  const W = 256, H = 128;
  const cv = document.createElement("canvas");
  cv.width = W; cv.height = H;
  const c = cv.getContext("2d");
  c.clearRect(0, 0, W, H);

  const blob = (cx, cy, rx, ry, alpha) => {
    c.save();
    c.translate(cx, cy);
    c.scale(rx, ry);
    const g = c.createRadialGradient(0, 0, 0, 0, 0, 1);
    g.addColorStop(0, `rgba(4, 6, 10, ${alpha})`);
    g.addColorStop(0.55, `rgba(6, 8, 12, ${(alpha * 0.68).toFixed(3)})`);
    g.addColorStop(1, "rgba(6, 8, 12, 0)");
    c.fillStyle = g;
    c.beginPath();
    c.arc(0, 0, 1, 0, Math.PI * 2);
    c.fill();
    c.restore();
  };

  // 主底板与侧箱文丘里通道核心暗影（x: -2.0..+1.3m）
  blob(W * 0.45, H * 0.5, W * 0.36, H * 0.35, 0.78);
  // 鼻锥与前翼下方柔和暗影（x: +1.5..+2.6m）
  blob(W * 0.80, H * 0.5, W * 0.16, H * 0.40, 0.46);
  // 尾部扩散器下方暗影（x: -2.5..-1.6m）
  blob(W * 0.17, H * 0.5, W * 0.15, H * 0.30, 0.55);

  // 四轮接地斑（Tire Contact Patches）高浓度遮蔽黑斑
  const fx = W * (0.5 + 1.75 / 5.7), rx = W * (0.5 - 1.75 / 5.7);
  const fz = H * (0.355), rz = H * (0.365);
  blob(fx, H * 0.5 - fz, W * 0.085, H * 0.13, 0.88);
  blob(fx, H * 0.5 + fz, W * 0.085, H * 0.13, 0.88);
  blob(rx, H * 0.5 - rz, W * 0.095, H * 0.15, 0.90);
  blob(rx, H * 0.5 + rz, W * 0.095, H * 0.15, 0.90);

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// 车底接触暗影贴图与平面（F1 与越野卡车共用）
export const GROUND = {
  contactShadow: contactShadowTexture(),
  contactShadowGeo: (() => {
    const g = new THREE.PlaneGeometry(5.7, 2.22);
    g.rotateX(-Math.PI / 2);
    return g;
  })(),
};

/* ================= 车型无关的姿态管线 ================= */

// 每帧基础同步：贴地采样 / 路肩抬升 / 草地高度 / 车身朝向 / 幽灵透明度。
// 返回 ctx 供各车型模块继续做专属动画（刹车盘、悬挂、车模节点等）。
export function syncCarPose(root, car, dt) {
  const spd = Math.abs(car.speed || 0);
  const surf = car.surf ?? 0;

  // 双轴多点纵向坡度与拱顶/凹谷桥接采样（上海 T1-T2 爬坡顶 +11.24m 等变坡处防止长鼻锥/扩散器穿模）
  let roadY = car.roadY || 0;
  let roadPitch = car.roadPitch || 0;
  let roadRoll = car.roadRoll || 0;
  if (car.trackS != null && surf !== 2 && Math.abs(roadPitch) > 0.0005) {
    const pF = roadAt(car.trackS + 1.75);
    const pR = roadAt(car.trackS - 1.75);
    if (pF && pR) {
      const axleMidY = 0.5 * (pF.y + pR.y);
      const bankPart = roadY - (roadAt(car.trackS).y || 0);
      roadY = Math.max(roadY, axleMidY + bankPart);
      roadPitch = (pF.y - pR.y) / 3.5;
    }
  }

  // 沥青表面在 roadElev + 0.050m，路缘石在 roadElev + 0.068m：
  // 基准抬升 +0.046m 使四轮正好落在 0.050m 沥青面上（带 4mm 真实受载接地扁平量，不再陷入地下 5cm）
  const u = root.userData;
  const stepDt = Math.min(dt || 0.016, 0.05);
  const targetKerbLift = surf === 1 ? 0.016 : 0;
  u.kerbLift = (u.kerbLift || 0) + (targetKerbLift - (u.kerbLift || 0)) * Math.min(1, stepDt * 22);

  // 冲出赛道进入草坪 (surf === 2) 时：直接采样 3D 草地三角形网格的精确高度与法向坡度，
  // 既可平滑贴合草坪起伏，又通过 Math.max 硬下限保证车身与四轮 100% 绝不陷入草地网格以下
  const gCenter = sampleGroundMeshY(car.x, car.y);
  const targetOffTrack = surf === 2 ? 1 : 0;
  u.offTrackBlend = (u.offTrackBlend || 0)
    + (targetOffTrack - (u.offTrackBlend || 0)) * Math.min(1, stepDt * (surf === 2 ? 6.5 : 14));

  let baseY = roadY + 0.046 + u.kerbLift;
  if (u.offTrackBlend > 0.001) {
    const ca = Math.cos(car.angle || 0), sa = Math.sin(car.angle || 0);
    const gFront = sampleGroundMeshY(car.x + ca * 1.75, car.y + sa * 1.75);
    const gRear = sampleGroundMeshY(car.x - ca * 1.75, car.y - sa * 1.75);
    const gLeft = sampleGroundMeshY(car.x - sa * 0.80, car.y + ca * 0.80);
    const gRight = sampleGroundMeshY(car.x + sa * 0.80, car.y - ca * 0.80);
    const grassTop = Math.max(gCenter, 0.5 * (gFront + gRear), 0.5 * (gLeft + gRight));
    const grassPitch = (gFront - gRear) / 3.5;
    const grassRoll = (gLeft - gRight) / 1.6;
    const b = u.offTrackBlend;
    baseY = Math.max(grassTop + 0.024, baseY * (1 - b) + (grassTop + 0.028) * b);
    roadPitch = roadPitch * (1 - b) + grassPitch * b;
    roadRoll = roadRoll * (1 - b) + grassRoll * b;
  } else {
    baseY = Math.max(baseY, gCenter + 0.020);
  }

  // 压上 FIA 锯齿路缘石（每块 1.2m）时的高频悬挂跳动与震颤
  const kerbRumble = surf === 1
    ? Math.sin((car.trackS || 0) * 5.24) * 0.0048 * Math.min(1, spd / 22)
    : 0;
  const grassShake = car.shake > 0.2 ? Math.random() * car.shake * 0.01 : 0;

  const finalY = baseY + kerbRumble + grassShake;
  car.visY = finalY;
  root.position.set(car.x, finalY, car.y);
  // 赛道纵向剖面姿态（YXZ 欧拉：yaw ∘ pitch ∘ roll，小角近似）：
  //   rotation.z = 沿车头坡度 → 正 = 车头上仰（Rz 正把 +x（车头）抬向 +y）
  //   rotation.x = -横坡 → roadRoll>0 表示 +nor 侧（车身局部 +z）更高，需负 rx 抬起 +z
  root.rotation.order = "YXZ";
  root.rotation.z = Math.atan(roadPitch);
  root.rotation.x = -Math.atan(roadRoll);
  root.rotation.y = -car.angle;

  const ghostA = car.retired || car.ghostHidden ? 0 : (car.ghostAlpha == null ? 1 : Math.max(0, car.ghostAlpha));

  // 保持车底接触暗影紧贴沥青/路肩表层，不随悬挂跳动悬空
  if (u.aoShadow) {
    u.aoShadow.position.y = Math.max(0.002, 0.006 - u.kerbLift * 0.5 - kerbRumble);
  }
  return { spd, surf, dt, stepDt, ghostA, kerbRumble };
}

// 四轮滚动与转向（F1 / 越野卡车共用；SU7 用车模节点自转，不经过这里）
export function syncWheels(root, car, ctx) {
  const u = root.userData;
  const spd = ctx.spd;
  const dt = ctx.dt ?? 0.016;
  const FALLBACK_WHEEL_R = 0.36;   // 未声明 wheelR 时按 F1 后胎半径计
  const spin = (spd * dt) / (u.wheelR || FALLBACK_WHEEL_R) * (car.speed < 0 ? 1 : -1);
  u.spinAngle = (u.spinAngle + spin) % (Math.PI * 2);
  for (const s of u.wheels.spin) s.rotation.z = u.spinAngle;
  // car.steer 经物理平滑后实际范围 ±0.55，视觉增益放大到满舵 ±27°
  const steerVis = -car.steer * 0.85;
  for (const s of u.wheels.steer) if (s.front) s.group.rotation.y = steerVis;
}

// 制动判定：程序化车型的刹车灯与 glTF 车模的尾灯共用同一套逻辑
export function isBraking(car, spd) {
  return !!(car.braking || (car.inBrake > 0 && spd > 0.5));
}

// 刹车灯（F1 尾灯/雨灯、卡车尾灯共用）；glTF 车模的灯材质由各自模块处理
export function syncBrakeLights(root, car, ctx) {
  const u = root.userData;
  const braking = ctx.braking ?? isBraking(car, ctx.spd);
  if (!u.brakeMat) return braking;
  u.brakeMat.emissive.setHex(braking ? 0xff1e1e : 0x000000);
  u.brakeMat.emissiveIntensity = braking ? 2.2 : 0;
  return braking;
}

/* ================= 刹车灯辉光（叠加 Sprite 光晕 + 车尾点光源） =================
   模型的自发光在 ACES 色调映射下很容易被压暗，单靠 emissiveIntensity 提不亮；
   这里补一层不受色调映射影响的加法混合光晕，再用一个红色点光源把光洒到路面。 */

let _glowTex = null;
function brakeGlowTexture() {
  if (_glowTex) return _glowTex;
  const S = 128;
  const cv = document.createElement("canvas");
  cv.width = S; cv.height = S;
  const c = cv.getContext("2d");
  const g = c.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.18, "rgba(255,224,200,0.92)");
  g.addColorStop(0.42, "rgba(255,110,60,0.42)");
  g.addColorStop(0.72, "rgba(255,50,20,0.14)");
  g.addColorStop(1, "rgba(255,30,10,0)");
  c.fillStyle = g;
  c.fillRect(0, 0, S, S);
  _glowTex = new THREE.CanvasTexture(cv);
  _glowTex.colorSpace = THREE.SRGBColorSpace;
  return _glowTex;
}

// 车灯位置 → 光晕点位：贯穿式宽灯带取左右各一处，普通灯组取中心一处
export function glowPositions(box, { back = 0.06, splitWidth = 0.9 } = {}) {
  if (!box || box.isEmpty()) return [];
  const c = box.getCenter(new THREE.Vector3());
  const w = Math.abs(box.max.z - box.min.z);
  const x = box.min.x - back;           // 灯面外侧（车尾方向）
  if (w > splitWidth) {
    return [
      new THREE.Vector3(x, c.y, box.min.z + w * 0.24),
      new THREE.Vector3(x, c.y, box.max.z - w * 0.24),
    ];
  }
  return [new THREE.Vector3(x, c.y, c.z)];
}

export function createBrakeGlow(root, positions, opts = {}) {
  const color = opts.color ?? 0xff3a12;
  const baseSize = opts.size ?? 1.05;
  const tex = brakeGlowTexture();
  const sprites = positions.map(p => {
    const mat = new THREE.SpriteMaterial({
      map: tex, color, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const sp = new THREE.Sprite(mat);
    sp.position.copy(p);
    sp.scale.setScalar(baseSize);
    sp.visible = false;
    root.add(sp);
    return sp;
  });

  let light = null;
  if (opts.light !== false && positions.length) {
    light = new THREE.PointLight(color, 0, opts.lightDistance ?? 8, 2);
    const c = new THREE.Vector3();
    for (const p of positions) c.add(p);
    c.multiplyScalar(1 / positions.length);
    c.x -= opts.lightBack ?? 0.3;              // 光源略微退到灯面之后
    c.y = Math.max(0.35, c.y);
    light.position.copy(c);
    root.add(light);
  }

  // 点光源强度按物理单位（坎德拉）：本场景主平行光为 3.0，刹车灯洒地取 4~5 即可见而不刺眼
  return { sprites, light, baseSize, lightPower: opts.lightPower ?? 4.5 };
}

// k：0~1 的制动强度（已含淡入淡出插值）；dim：幽灵/淘汰透明度
export function updateBrakeGlow(glow, k, dim = 1) {
  if (!glow) return;
  const v = Math.max(0, Math.min(1, k)) * Math.max(0, Math.min(1, dim));
  for (const sp of glow.sprites) {
    sp.visible = v > 0.01;
    sp.material.opacity = v;
    sp.scale.setScalar(glow.baseSize * (1 + v * 0.7));
  }
  if (glow.light) glow.light.intensity = v * glow.lightPower;
}

export function disposeBrakeGlow(glow) {
  if (!glow) return;
  for (const sp of glow.sprites) {
    sp.material.dispose();
    sp.removeFromParent();
  }
  if (glow.light) glow.light.removeFromParent();
}

// 幽灵车 / 淘汰车透明度：glTF 车模走独立材质列表，程序化车型走 allMats
export function applyGhost(root, ghostA) {
  const u = root.userData;
  if (u.isGlb) {
    if (!u.glbReady || ghostA === u.lastAlpha) return;
    root.visible = ghostA > 0.02;
    for (const m of u.mats || []) {
      m.transparent = ghostA < 0.999;
      m.opacity = ghostA;
    }
    u.lastAlpha = ghostA;
    return;
  }
  if (ghostA === u.lastAlpha) return;
  root.visible = ghostA > 0.02;
  for (const m of u.allMats || []) {
    const base = m.userData.baseAlpha ?? 1;
    m.transparent = ghostA < 0.999 || base < 1;
    m.opacity = ghostA * base;
  }
  u.lastAlpha = ghostA;
}
