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
  const dt = ctx.dt ?? 0.016;
  const braking = ctx.braking ?? isBraking(car, ctx.spd);
  const target = braking ? 1 : 0;
  // LED 刹车灯物理响应：点亮极快（约 40ms 满亮），松刹带轻微余晖衰减
  const rate = target > (u.brakeGlow || 0) ? 24 : 11;
  u.brakeGlow = (u.brakeGlow || 0) + (target - (u.brakeGlow || 0)) * Math.min(1, dt * rate);
  const g = u.brakeGlow;

  if (u.brakeMat) {
    // 常态保留微弱暗红尾灯底色；制动时由深红升至炽白橙红灯芯，抵抗 ACES 色调映射压暗
    u.brakeMat.color.setRGB(0.28 + 0.72 * g, 0.03 + 0.22 * g, 0.04 + 0.08 * g);
    u.brakeMat.emissive.setRGB(0.22 + 0.78 * g, 0.01 + 0.25 * g, 0.02 + 0.06 * g);
    u.brakeMat.emissiveIntensity = 0.38 + g * 5.8;
  }
  if (u.brakeCoreMat) {
    // 灯罩内部高亮度 LED 二极管发光芯（制动时呈现炽热黄白光核）
    u.brakeCoreMat.color.setRGB(0.55 + 0.45 * g, 0.08 + 0.68 * g, 0.06 + 0.36 * g);
    u.brakeCoreMat.opacity = (0.28 + g * 0.72) * (ctx.ghostA ?? 1);
  }
  if (u.brakeGlowObj) {
    updateBrakeGlow(u.brakeGlowObj, g, ctx.ghostA ?? 1);
  }
  return braking;
}

/* ================= 刹车灯光学系统（灯芯炙热光核 + 贴合灯带光晕 + 灯位点光源 + 地面投射光斑） =================
   真实车灯点亮需要三层物理视觉：
   1. 灯体自身亮起：紧贴灯罩表面的高亮度炽白-橙黄 LED 灯芯光核（Core）与沿灯具轮廓分布的深红光学微晕（Halo）；
   2. 光源从灯发出：锚定在左右/中央灯壳正后方的近距点光源（照射后保险杠、扩散器与尾翼端板反光）+ 向后发散的体积光锥；
   3. 车后路面洒光：紧随车尾地面投射的双束扇形深红尾灯光池（Ground Light Pool）。 */

let _coreTex = null;
function brakeCoreTexture() {
  if (_coreTex) return _coreTex;
  const S = 128;
  const cv = document.createElement("canvas");
  cv.width = S; cv.height = S;
  const c = cv.getContext("2d");
  const g = c.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0, "rgba(255,255,252,1)");
  g.addColorStop(0.22, "rgba(255,232,185,0.95)");
  g.addColorStop(0.48, "rgba(255,115,40,0.62)");
  g.addColorStop(0.76, "rgba(245,28,8,0.18)");
  g.addColorStop(1, "rgba(180,0,0,0)");
  c.fillStyle = g;
  c.fillRect(0, 0, S, S);
  _coreTex = new THREE.CanvasTexture(cv);
  _coreTex.colorSpace = THREE.SRGBColorSpace;
  return _coreTex;
}

let _haloTex = null;
function brakeHaloTexture() {
  if (_haloTex) return _haloTex;
  const S = 128;
  const cv = document.createElement("canvas");
  cv.width = S; cv.height = S;
  const c = cv.getContext("2d");
  // 主径向深红灯罩辉光
  const g = c.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0, "rgba(255,175,120,0.88)");
  g.addColorStop(0.24, "rgba(255,64,22,0.58)");
  g.addColorStop(0.55, "rgba(235,18,8,0.24)");
  g.addColorStop(0.82, "rgba(190,6,4,0.06)");
  g.addColorStop(1, "rgba(140,0,0,0)");
  c.fillStyle = g;
  c.fillRect(0, 0, S, S);

  // 叠加细微水平变形镜头衍射光束（Anamorphic Lens Streak），贴合现代横向 LED 尾灯光学质感
  c.save();
  c.translate(S / 2, S / 2);
  c.scale(1.0, 0.22);
  const sg = c.createRadialGradient(0, 0, 0, 0, 0, S * 0.48);
  sg.addColorStop(0, "rgba(255,220,180,0.45)");
  sg.addColorStop(0.45, "rgba(255,60,20,0.22)");
  sg.addColorStop(1, "rgba(200,0,0,0)");
  c.fillStyle = sg;
  c.beginPath();
  c.arc(0, 0, S * 0.48, 0, Math.PI * 2);
  c.fill();
  c.restore();

  _haloTex = new THREE.CanvasTexture(cv);
  _haloTex.colorSpace = THREE.SRGBColorSpace;
  return _haloTex;
}

let _groundPoolTex = null;
function brakeGroundPoolTexture() {
  if (_groundPoolTex) return _groundPoolTex;
  const W = 256, H = 256;
  const cv = document.createElement("canvas");
  cv.width = W; cv.height = H;
  const c = cv.getContext("2d");
  // UV 约定：PlaneGeometry 旋转后 u(x轴) 对应车辆前后方向，v(y轴) 对应车辆左右方向(z)
  // 在左侧(v=0.26)、中央(v=0.50)、右侧(v=0.74)绘制向车尾方向扩散的扇形红光投射束
  const drawBeam = (vy, rx, ry, alpha) => {
    c.save();
    c.translate(W * 0.72, H * vy);
    c.scale(rx, ry);
    const rg = c.createRadialGradient(0, 0, 0, -W * 0.14, 0, W * 0.46);
    rg.addColorStop(0, `rgba(255,75,25,${alpha})`);
    rg.addColorStop(0.32, `rgba(240,22,8,${(alpha * 0.65).toFixed(3)})`);
    rg.addColorStop(0.68, `rgba(195,8,4,${(alpha * 0.25).toFixed(3)})`);
    rg.addColorStop(1, "rgba(140,0,0,0)");
    c.fillStyle = rg;
    c.beginPath();
    c.arc(0, 0, W * 0.48, 0, Math.PI * 2);
    c.fill();
    c.restore();
  };
  drawBeam(0.26, 1.15, 0.58, 0.52);
  drawBeam(0.74, 1.15, 0.58, 0.52);
  drawBeam(0.50, 0.95, 0.52, 0.34);

  _groundPoolTex = new THREE.CanvasTexture(cv);
  _groundPoolTex.colorSpace = THREE.SRGBColorSpace;
  return _groundPoolTex;
}

// 从 glTF 车尾灯网格采样真实的 3D 灯带/灯组表面轮廓发光点（保证光源严格贴在 3D 灯具表面而非悬空大圆球）
export function sampleRearLampEmitters(meshes, fallbackBox, {
  count = 8,
  back = 0.015,
  aspectX = 1.45,
  aspectY = 0.85,
  size = 0.30,
  coreSize = 0.14,
} = {}) {
  const pts = [];
  const v = new THREE.Vector3();
  for (const mesh of meshes || []) {
    if (!mesh || !mesh.geometry || !mesh.geometry.attributes.position) continue;
    const pos = mesh.geometry.attributes.position;
    const step = Math.max(1, Math.floor(pos.count / 600));
    for (let i = 0; i < pos.count; i += step) {
      v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      if (v.x < -0.5 && v.y > 0.22 && v.y < 1.35) {
        pts.push(v.clone());
      }
    }
  }

  if (pts.length >= 4) {
    let minZ = Infinity, maxZ = -Infinity;
    for (const p of pts) {
      if (p.z < minZ) minZ = p.z;
      if (p.z > maxZ) maxZ = p.z;
    }
    const spanZ = Math.max(0.2, maxZ - minZ);
    const bins = Array.from({ length: count }, () => []);
    for (const p of pts) {
      const idx = Math.min(count - 1, Math.max(0, Math.floor(((p.z - minZ) / spanZ) * count)));
      bins[idx].push(p);
    }
    const emitters = [];
    for (let b = 0; b < count; b++) {
      const bucket = bins[b];
      if (!bucket.length) continue;
      // 取该横向切片中最靠车尾外侧（x 最小）的前 35% 顶点均值，精确贴合尾灯外透镜表面
      bucket.sort((a, c) => a.x - c.x);
      const take = Math.max(1, Math.ceil(bucket.length * 0.35));
      let sx = 0, sy = 0, sz = 0;
      for (let i = 0; i < take; i++) {
        sx += bucket[i].x;
        sy += bucket[i].y;
        sz += bucket[i].z;
      }
      const ex = sx / take - back;
      const ey = sy / take;
      const ez = sz / take;
      const isOuter = b <= 1 || b >= count - 2;
      emitters.push({
        pos: new THREE.Vector3(ex, ey, ez),
        size: isOuter ? size * 1.12 : size,
        coreSize: isOuter ? coreSize * 1.12 : coreSize,
        aspectX,
        aspectY,
        hasBeam: isOuter,
      });
    }
    if (emitters.length) return emitters;
  }

  return glowPositions(fallbackBox, { back }).map(p => ({
    pos: p, size, coreSize, aspectX, aspectY, hasBeam: true,
  }));
}

// 车灯包围盒 → 灯面发光点位（供无顶点网格或兜底使用）
export function glowPositions(box, { back = 0.02, splitWidth = 0.85 } = {}) {
  if (!box || box.isEmpty()) return [];
  const c = box.getCenter(new THREE.Vector3());
  const w = Math.abs(box.max.z - box.min.z);
  const x = box.min.x - back;           // 紧贴灯面外侧
  if (w > splitWidth) {
    return [
      new THREE.Vector3(x, c.y, box.min.z + w * 0.22),
      new THREE.Vector3(x, c.y, box.max.z - w * 0.22),
    ];
  }
  return [new THREE.Vector3(x, c.y, c.z)];
}

export function createBrakeGlow(parent, rawPositions, opts = {}) {
  const haloColor = opts.color ?? 0xff2a10;
  const coreColor = opts.coreColor ?? 0xfff2d6;
  const defaultSize = opts.size ?? 0.34;
  const defaultCoreSize = opts.coreSize ?? defaultSize * 0.44;
  const coreTex = brakeCoreTexture();
  const haloTex = brakeHaloTexture();

  const items = (rawPositions || []).map(item => {
    if (item && item.isVector3) {
      return {
        pos: item.clone(),
        size: defaultSize,
        coreSize: defaultCoreSize,
        aspectX: opts.aspectX ?? 1.25,
        aspectY: opts.aspectY ?? 0.9,
        hasBeam: true,
      };
    }
    return {
      pos: item.pos.clone(),
      size: item.size ?? defaultSize,
      coreSize: item.coreSize ?? defaultCoreSize,
      aspectX: item.aspectX ?? opts.aspectX ?? 1.25,
      aspectY: item.aspectY ?? opts.aspectY ?? 0.9,
      hasBeam: item.hasBeam ?? false,
      beamRadius: item.beamRadius ?? 0.09,
      beamLength: item.beamLength ?? 0.42,
    };
  });

  const coreSprites = [];
  const haloSprites = [];
  const beamMeshes = [];

  for (const it of items) {
    // 1) 紧贴灯面的高亮度白橙色 LED 发光核（让人眼看清光是灯芯亮起来）
    const cMat = new THREE.SpriteMaterial({
      map: coreTex,
      color: coreColor,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
    });
    const cSp = new THREE.Sprite(cMat);
    cSp.position.copy(it.pos);
    cSp.scale.set(it.coreSize * it.aspectX, it.coreSize * it.aspectY, 1);
    cSp.renderOrder = 3;
    parent.add(cSp);
    coreSprites.push({ sprite: cSp, baseW: it.coreSize * it.aspectX, baseH: it.coreSize * it.aspectY });

    // 2) 包裹灯罩边缘的深红光学光晕（严格控制尺寸，绝不变成悬空大红球）
    const hMat = new THREE.SpriteMaterial({
      map: haloTex,
      color: haloColor,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
    });
    const hSp = new THREE.Sprite(hMat);
    hSp.position.copy(it.pos);
    hSp.position.x -= 0.008;
    hSp.scale.set(it.size * it.aspectX, it.size * it.aspectY, 1);
    hSp.renderOrder = 2;
    parent.add(hSp);
    haloSprites.push({ sprite: hSp, baseW: it.size * it.aspectX, baseH: it.size * it.aspectY });

    // 3) 从灯面往车后（-X）射出的柔和立体体积光锥（表现光线从灯罩向外发散）
    if (it.hasBeam) {
      const bGeo = new THREE.ConeGeometry(it.beamRadius, it.beamLength, 14, 1, true);
      // Cone 默认尖端在 +Y，开口在 -Y：旋转 -PI/2 绕 Z 轴使尖端在 +X（灯芯）、开口朝 -X（车后发散）
      bGeo.rotateZ(-Math.PI / 2);
      bGeo.translate(-it.beamLength * 0.5, 0, 0);
      const bMat = new THREE.MeshBasicMaterial({
        color: haloColor,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const bMesh = new THREE.Mesh(bGeo, bMat);
      bMesh.position.copy(it.pos);
      bMesh.visible = false;
      bMesh.renderOrder = 2;
      parent.add(bMesh);
      beamMeshes.push(bMesh);
    }
  }

  // 4) 锚定在左右车灯真实位置的点光源（照亮灯框周围的车尾保险杠、扩散器与地面）
  const lights = [];
  if (opts.light !== false && items.length) {
    const sortedZ = [...items].sort((a, b) => a.pos.z - b.pos.z);
    const leftAnchor = sortedZ[0].pos;
    const rightAnchor = sortedZ[sortedZ.length - 1].pos;
    const anchors = Math.abs(rightAnchor.z - leftAnchor.z) > 0.32
      ? [leftAnchor, rightAnchor]
      : [leftAnchor];
    const perLightPower = (opts.lightPower ?? 4.8) / anchors.length;
    const dist = opts.lightDistance ?? 5.2;
    for (const a of anchors) {
      const pt = new THREE.PointLight(haloColor, 0, dist, 2);
      pt.position.set(a.x - (opts.lightBack ?? 0.08), Math.max(0.28, a.y), a.z);
      parent.add(pt);
      lights.push({ light: pt, maxPower: perLightPower });
    }
  }

  // 5) 车尾地面扇形红光投射斑（随刹车灯同步把深红扇形光束洒在车后柏油路面上）
  let groundPool = null;
  if (opts.groundPool !== false && items.length) {
    let minX = Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const it of items) {
      if (it.pos.x < minX) minX = it.pos.x;
      if (it.pos.z < minZ) minZ = it.pos.z;
      if (it.pos.z > maxZ) maxZ = it.pos.z;
    }
    const poolW = Math.max(1.55, (maxZ - minZ) + 1.15);
    const poolLen = opts.poolLength ?? 2.35;
    const poolGeo = new THREE.PlaneGeometry(poolLen, poolW);
    poolGeo.rotateX(-Math.PI / 2);
    const poolMat = new THREE.MeshBasicMaterial({
      map: brakeGroundPoolTexture(),
      color: 0xff2208,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
    });
    groundPool = new THREE.Mesh(poolGeo, poolMat);
    groundPool.position.set(minX - poolLen * 0.42, 0.008, (minZ + maxZ) * 0.5);
    groundPool.renderOrder = 2;
    groundPool.visible = false;
    (opts.groundRoot || parent).add(groundPool);
  }

  return {
    coreSprites,
    haloSprites,
    beamMeshes,
    lights,
    groundPool,
    idleGlow: opts.idleGlow ?? 0.08, // 尾灯行车微亮底光
  };
}

// k：0~1 的制动强度（已含淡入淡出插值）；dim：幽灵/淘汰透明度
export function updateBrakeGlow(glow, k, dim = 1) {
  if (!glow) return;
  const alphaDim = Math.max(0, Math.min(1, dim));
  const brakeK = Math.max(0, Math.min(1, k));
  // 常态行车时保留极轻微的尾灯微光，踩下刹车时爆发炽亮灯芯与光晕
  const vCore = (glow.idleGlow * 0.5 + brakeK * (1 - glow.idleGlow * 0.5)) * alphaDim;
  const vHalo = (glow.idleGlow * 0.25 + brakeK * (1 - glow.idleGlow * 0.25)) * alphaDim;

  for (const c of glow.coreSprites) {
    c.sprite.visible = vCore > 0.015;
    c.sprite.material.opacity = Math.min(1, vCore * 0.96);
    const s = 0.86 + brakeK * 0.32;
    c.sprite.scale.set(c.baseW * s, c.baseH * s, 1);
  }
  for (const h of glow.haloSprites) {
    h.sprite.visible = vHalo > 0.015;
    h.sprite.material.opacity = Math.min(0.9, vHalo * 0.78);
    const s = 0.85 + brakeK * 0.38;
    h.sprite.scale.set(h.baseW * s, h.baseH * s, 1);
  }
  for (const b of glow.beamMeshes) {
    b.visible = brakeK * alphaDim > 0.03;
    b.material.opacity = brakeK * alphaDim * 0.22;
    const lenScale = 0.75 + brakeK * 0.45;
    b.scale.set(lenScale, 0.88 + brakeK * 0.24, 0.88 + brakeK * 0.24);
  }
  for (const l of glow.lights) {
    l.light.intensity = (glow.idleGlow * 0.12 + brakeK) * alphaDim * l.maxPower;
  }
  if (glow.groundPool) {
    const pOpacity = brakeK * alphaDim * 0.62;
    glow.groundPool.visible = pOpacity > 0.015;
    glow.groundPool.material.opacity = pOpacity;
  }
}

export function disposeBrakeGlow(glow) {
  if (!glow) return;
  for (const c of glow.coreSprites) {
    c.sprite.material.dispose();
    c.sprite.removeFromParent();
  }
  for (const h of glow.haloSprites) {
    h.sprite.material.dispose();
    h.sprite.removeFromParent();
  }
  for (const b of glow.beamMeshes) {
    b.geometry.dispose();
    b.material.dispose();
    b.removeFromParent();
  }
  for (const l of glow.lights) {
    l.light.removeFromParent();
  }
  if (glow.groundPool) {
    glow.groundPool.geometry.dispose();
    glow.groundPool.material.dispose();
    glow.groundPool.removeFromParent();
  }
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
