// F1 赛车 3D 视觉体：2024–2026 地面效应赛车架构，全部程序化曲面放样 + 翼型几何（零外部资源）。
// 车头朝局部 +x；挂载到场景时 rotation.y = -car.angle（2D 画布角度 → three 坐标）。
// 车身几何与 2D 物理包围盒一致（长 5.6m / 宽 2.0m）；轮位与 physics.js 落印坐标严格对齐，
// 刹车印才能精确压在轮胎正下方。车体所有底面保持在 y >= 0.09m，避开 y≈0.058m 的刹车印。
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { CAR_LIVERIES } from "../../car/render.js";
import {
  _up, _one, mergeBucket, loftRings, makeSuperSection, buildSweptAirfoil,
  numberTexture, GROUND, createBrakeGlow, disposeBrakeGlow,
} from "./shared.js";

export const id = "f1";

const WHEEL_R_F = 0.33, WHEEL_R_R = 0.36;
const WHEEL_FRONT_X = 1.75, WHEEL_REAR_X = -1.75;
const WHEEL_FRONT_Z = 0.77, WHEEL_REAR_Z = 0.79;
const WHEEL_FRONT_W = 0.31, WHEEL_REAR_W = 0.42;

/* ================= 车轮与轮胎专用高精细几何 ================= */

// 18 寸倍耐力圆弧胎肩轮胎几何（返回 [胎面, 外侧壁, 内侧壁] 多材质组 BufferGeometry）
function createProfiledTireGeometry(R, W, radialSegs = 36) {
  const hw = W * 0.5;
  const rRim = R * 0.56;       // 18 寸轮毂边缘半径
  const shW = W * 0.14;        // 圆弧胎肩宽度
  const rShoulder = R * 0.945; // 胎肩过渡点半径

  // 1) 胎面（包含圆润胎肩）：带完整 UV 的回转体
  const treadProfile = [
    [-hw, rShoulder],
    [-hw + shW * 0.45, R * 0.985],
    [-hw + shW, R],
    [0, R * 1.003],
    [hw - shW, R],
    [hw - shW * 0.45, R * 0.985],
    [hw, rShoulder],
  ];
  const lathePts = treadProfile.map(([ty, tr]) => new THREE.Vector2(tr, ty));
  const treadGeo = new THREE.LatheGeometry(lathePts, radialSegs);

  // 2) 左右胎壁（从 rRim 到 rShoulder，带微鼓弧度与平面 UV 供倍耐力彩色胎壁贴图映射）
  const makeSidewall = (sideSign) => {
    const g = new THREE.RingGeometry(rRim * 0.96, rShoulder * 1.002, radialSegs, 3);
    const pos = g.attributes.position;
    const uv = g.attributes.uv;
    for (let i = 0; i < pos.count; i++) {
      const px = pos.getX(i), py = pos.getY(i);
      const rad = Math.hypot(px, py);
      const u = Math.max(0, Math.min(1, (rad - rRim) / (rShoulder - rRim)));
      const bulge = Math.sin(u * Math.PI) * 0.014;
      const yPos = sideSign * (hw - shW * 0.18 * (1 - u) + bulge);
      pos.setXYZ(i, px, yPos, -py * sideSign);
      uv.setXY(i, 0.5 + (px / (R * 2.02)), 0.5 + (py / (R * 2.02)));
    }
    g.computeVertexNormals();
    return g;
  };

  const wallPos = makeSidewall(1);
  const wallNeg = makeSidewall(-1);

  const g0 = treadGeo.toNonIndexed();
  const g1 = wallPos.toNonIndexed();
  const g2 = wallNeg.toNonIndexed();
  const merged = mergeGeometries([g0, g1, g2], true);
  g0.dispose(); g1.dispose(); g2.dispose();
  treadGeo.dispose(); wallPos.dispose(); wallNeg.dispose();
  return merged;
}

// 18 寸 F1 空气动力学轮毂导流罩（凹盘 + 导流肋条，法线朝 +z）
function createAeroWheelCoverGeometry(R, W) {
  const rOuter = R * 0.575;
  const hw = W * 0.5;
  const parts = [];
  const pts = [
    new THREE.Vector2(0.015, hw - 0.025),
    new THREE.Vector2(rOuter * 0.24, hw - 0.028),
    new THREE.Vector2(rOuter * 0.52, hw - 0.042),
    new THREE.Vector2(rOuter * 0.82, hw - 0.015),
    new THREE.Vector2(rOuter, hw + 0.005),
    new THREE.Vector2(rOuter * 0.94, hw + 0.008),
    new THREE.Vector2(rOuter * 0.80, hw - 0.022),
  ].reverse();
  const dish = new THREE.LatheGeometry(pts, 28);
  dish.rotateX(Math.PI / 2);
  parts.push(dish);

  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    const rib = new THREE.BoxGeometry(rOuter * 0.56, 0.020, 0.018);
    rib.translate(rOuter * 0.50, 0, hw - 0.018);
    rib.rotateZ(a);
    parts.push(rib);
  }
  return mergeBucket(parts);
}

// 刹车通风盘 + 卡钳 + 碳纤维刹车鼓 + 前轮眉导流翼（挂在转向节 steer 组上，随前轮转向但不随轮胎自转）
function createUprightBrakeGeometry(R, W, isFront, zSgn = 1) {
  const carbonParts = [];
  const discParts = [];
  const caliperParts = [];

  // 内部碳纤维刹车鼓（Cake-tin）封闭轮腔
  const drum = new THREE.CylinderGeometry(R * 0.52, R * 0.50, W * 0.78, 22);
  drum.rotateX(Math.PI / 2);
  drum.translate(0, 0, -zSgn * 0.01);
  carbonParts.push(drum);

  // 刹车通风盘（位于轮毂内侧间隙，重刹时发红光）
  const disc = new THREE.CylinderGeometry(R * 0.46, R * 0.46, 0.032, 24);
  disc.rotateX(Math.PI / 2);
  disc.translate(0, 0, -zSgn * W * 0.24);
  discParts.push(disc);

  // 六活塞制动卡钳
  const cal = new THREE.BoxGeometry(0.13, 0.22, 0.075);
  cal.translate(isFront ? -R * 0.34 : R * 0.34, 0.03, -zSgn * W * 0.24);
  caliperParts.push(cal);

  if (isFront) {
    // 2022–2026 F1 标志性前轮上方导流眉翼（Wheel Wake Deflector / Wheel Brow）
    const browPts = [];
    for (let i = 0; i <= 10; i++) {
      const t = i / 10;
      const ang = 0.25 + t * 1.45;
      const rad = R + 0.028 + t * 0.012;
      const bx = Math.cos(ang) * rad;
      const by = Math.sin(ang) * rad;
      browPts.push([
        [bx - 0.04, by, -zSgn * W * 0.52],
        [bx + 0.04, by + 0.010, -zSgn * W * 0.52],
        [bx + 0.03, by + 0.016, -zSgn * W * 0.14],
        [bx - 0.04, by + 0.005, -zSgn * W * 0.14],
      ]);
    }
    carbonParts.push(loftRings(browPts, true, true, true));
    const strut = new THREE.BoxGeometry(0.11, 0.18, 0.022);
    strut.translate(-0.04, R * 0.72, -zSgn * W * 0.48);
    carbonParts.push(strut);
  } else {
    // 后轮内侧紧凑刹车导管小翼（收纳于轮毂内侧，不超出轮胎后缘）
    for (let k = 0; k < 2; k++) {
      const fin = new THREE.BoxGeometry(0.085, 0.010, 0.065);
      fin.rotateZ(-0.18);
      fin.translate(-0.04, -0.03 + k * 0.055, -zSgn * W * 0.40);
      carbonParts.push(fin);
    }
  }

  return {
    carbon: mergeBucket(carbonParts),
    disc: mergeBucket(discParts),
    caliper: mergeBucket(caliperParts),
  };
}

// 车手流线型 F1 头盔（带尾部气动扰流鸭尾 + 下巴护弓 + 顶通风口）
function createF1HelmetGeometry() {
  const parts = [];
  const dome = new THREE.SphereGeometry(0.145, 22, 16);
  const pos = dome.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    let x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    if (x < 0) {
      x *= 1.24;
      if (y > 0) y += (-x) * 0.08;
    }
    if (y < -0.03) {
      x *= 1.08;
      z *= 0.92;
    }
    pos.setXYZ(i, x, y, z);
  }
  dome.computeVertexNormals();
  parts.push(dome);

  const chin = new THREE.BoxGeometry(0.11, 0.065, 0.17);
  chin.translate(0.095, -0.055, 0);
  parts.push(chin);

  const scoop = new THREE.BoxGeometry(0.08, 0.025, 0.07);
  scoop.rotateZ(-0.25);
  scoop.translate(0.05, 0.135, 0);
  parts.push(scoop);

  return mergeBucket(parts);
}

// 头盔曲面镀膜护目镜（Visor）
function createHelmetVisorGeometry() {
  const g = new THREE.CylinderGeometry(0.149, 0.146, 0.068, 20, 1, true, -Math.PI * 0.38, Math.PI * 0.76);
  g.rotateY(Math.PI / 2);
  g.translate(0.012, 0.012, 0);
  return g;
}

// F1 蝴蝶形碳纤维方向盘（随 car.steer 实时转动）
function createSteeringWheelGeometry() {
  const carbonParts = [];
  const accentParts = [];
  const plate = new THREE.BoxGeometry(0.024, 0.135, 0.25);
  carbonParts.push(plate);
  for (const sgn of [-1, 1]) {
    const grip = new THREE.CylinderGeometry(0.016, 0.016, 0.14, 10);
    grip.translate(0.006, -0.005, sgn * 0.115);
    carbonParts.push(grip);
  }
  const screen = new THREE.BoxGeometry(0.012, 0.065, 0.11);
  screen.translate(-0.014, 0.015, 0);
  accentParts.push(screen);
  const shaft = new THREE.CylinderGeometry(0.018, 0.018, 0.22, 10);
  shaft.rotateZ(Math.PI / 2);
  shaft.translate(0.11, -0.01, 0);
  carbonParts.push(shaft);

  return {
    carbon: mergeBucket(carbonParts),
    screen: mergeBucket(accentParts),
  };
}

const G = {
  tireF: createProfiledTireGeometry(WHEEL_R_F, WHEEL_FRONT_W, 36),
  tireR: createProfiledTireGeometry(WHEEL_R_R, WHEEL_REAR_W, 36),
  coverF: createAeroWheelCoverGeometry(WHEEL_R_F, WHEEL_FRONT_W),
  coverR: createAeroWheelCoverGeometry(WHEEL_R_R, WHEEL_REAR_W),
  rimRingF: new THREE.RingGeometry(WHEEL_R_F * 0.50, WHEEL_R_F * 0.57, 28),
  rimRingR: new THREE.RingGeometry(WHEEL_R_R * 0.50, WHEEL_R_R * 0.57, 28),
  wheelNut: (() => {
    const g = new THREE.CylinderGeometry(0.036, 0.044, 0.032, 8);
    g.rotateX(Math.PI / 2);
    return g;
  })(),
  uprightFP: createUprightBrakeGeometry(WHEEL_R_F, WHEEL_FRONT_W, true, 1),
  uprightFN: createUprightBrakeGeometry(WHEEL_R_F, WHEEL_FRONT_W, true, -1),
  uprightRP: createUprightBrakeGeometry(WHEEL_R_R, WHEEL_REAR_W, false, 1),
  uprightRN: createUprightBrakeGeometry(WHEEL_R_R, WHEEL_REAR_W, false, -1),
  helmet: createF1HelmetGeometry(),
  visor: createHelmetVisorGeometry(),
  steerWheel: createSteeringWheelGeometry(),
  rainLight: new THREE.BoxGeometry(0.045, 0.145, 0.088),
};

/* ================= 程序化 F1 车体（2024–2026 地面效应赛车架构） =================
   形状只构建一次跨车共享（按材质桶合并成静态网格，极致省 draw call）；
   材质逐车独立（支持多色分区涂装、清漆高光、碳纤维编织纹与幽灵车透明度）。
   坐标约定：x 向前（+2.8 车头），y 向上，z 向右；地面 y=0。 */

const NOSE_STATIONS = [
  // [x, yBot, yTop, wBot, wTop, yMidFrac, wMidScale]
  [2.68, 0.195, 0.235, 0.042, 0.034, 0.50, 1.02], // 鼻锥最前尖端
  [2.52, 0.185, 0.275, 0.078, 0.068, 0.48, 1.04], // 前翼吊柱挂载区
  [2.20, 0.185, 0.355, 0.125, 0.112, 0.48, 1.05], // 鼻锥中段
  [1.82, 0.180, 0.445, 0.172, 0.155, 0.50, 1.06], // 前轮轴线隔舱（前悬挂挂载点）
  [1.42, 0.165, 0.515, 0.215, 0.195, 0.52, 1.06], // 驾驶舱前风挡前沿
  [1.02, 0.150, 0.550, 0.255, 0.235, 0.52, 1.08], // 方向盘隔舱
  [0.52, 0.145, 0.555, 0.305, 0.275, 0.50, 1.08], // 座舱中部
  [0.05, 0.145, 0.575, 0.310, 0.265, 0.50, 1.07], // 座舱后沿/头枕区
  [-0.35, 0.145, 0.560, 0.280, 0.210, 0.48, 1.06], // 油箱段
  [-0.95, 0.145, 0.515, 0.230, 0.145, 0.45, 1.05], // 引擎盖中段
  [-1.65, 0.150, 0.440, 0.165, 0.095, 0.45, 1.04], // 可乐瓶收尾段
  [-2.28, 0.165, 0.380, 0.105, 0.062, 0.45, 1.02], // 变速箱尾锥
  [-2.54, 0.200, 0.360, 0.072, 0.050, 0.50, 1.00], // 排气管出口端面
];

function sampleMonocoqueAt(x) {
  if (x >= NOSE_STATIONS[0][0]) return NOSE_STATIONS[0];
  for (let i = 0; i < NOSE_STATIONS.length - 1; i++) {
    const a = NOSE_STATIONS[i], b = NOSE_STATIONS[i + 1];
    if (x <= a[0] && x >= b[0]) {
      const t = (a[0] - x) / Math.max(1e-5, a[0] - b[0]);
      return a.map((va, idx) => va + (b[idx] - va) * t);
    }
  }
  return NOSE_STATIONS[NOSE_STATIONS.length - 1];
}

let f1GeoCache = null;
function f1PartGeometry() {
  if (f1GeoCache) return f1GeoCache;
  const B = { livery: [], dark: [], accent: [], carbon: [], susp: [], metal: [] };

  const push = (name, geo, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) => {
    if (x !== 0 || y !== 0 || z !== 0 || rx !== 0 || ry !== 0 || rz !== 0) {
      const m = new THREE.Matrix4().compose(
        new THREE.Vector3(x, y, z),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)),
        _one,
      );
      geo.applyMatrix4(m);
    }
    B[name].push(geo);
  };

  const box = (name, sx, sy, sz, x, y, z, rx = 0, ry = 0, rz = 0) =>
    push(name, new THREE.BoxGeometry(sx, sy, sz), x, y, z, rx, ry, rz);

  const rod = (name, x1, y1, z1, x2, y2, z2, r = 0.016, scaleX = 1, scaleZ = 1) => {
    const a = new THREE.Vector3(x1, y1, z1);
    const b = new THREE.Vector3(x2, y2, z2).sub(a);
    const len = b.length();
    const g = new THREE.CylinderGeometry(r, r, len, 8);
    if (scaleX !== 1 || scaleZ !== 1) g.scale(scaleX, 1, scaleZ);
    g.applyMatrix4(new THREE.Matrix4().compose(
      new THREE.Vector3(x1, y1, z1).addScaledVector(b, 0.5),
      new THREE.Quaternion().setFromUnitVectors(_up, b.normalize()),
      _one,
    ));
    B[name].push(g);
  };

  const side = (name, shape, depth, bevel, z0 = 0) => {
    const g = new THREE.ExtrudeGeometry(shape, {
      depth, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel,
      bevelSegments: 2, curveSegments: 16,
    });
    g.translate(0, 0, z0 - depth / 2);
    B[name].push(g);
  };

  const plan = (name, shape, depth, bevel, topY) => {
    const g = new THREE.ExtrudeGeometry(shape, {
      depth, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel,
      bevelSegments: 2, curveSegments: 16,
    });
    g.rotateX(Math.PI / 2);
    g.translate(0, topY - bevel, 0);
    B[name].push(g);
  };

  /* ---- 1. 3D 连续放样单体壳 + 垂坠鼻锥 + 引擎盖可乐瓶尾椎 ---- */
  {
    const monoRings = NOSE_STATIONS.map(([x, yBot, yTop, wBot, wTop, yMidFrac, wMidScale]) =>
      makeSuperSection(x, yBot, yTop, wBot, wTop, yMidFrac, wMidScale, 28)
    );
    push("livery", loftRings(monoRings, true, true, true));

    // 鼻锥前端冷却进气孔
    box("carbon", 0.04, 0.022, 0.055, 2.67, 0.215, 0, 0, 0, -0.18);

    // 鼻锥顶部至座舱前沿的车队流线拉花饰条
    const stripeRings = [];
    for (let i = 0; i <= 16; i++) {
      const x = 2.55 - (i / 16) * 1.48;
      const st = sampleMonocoqueAt(x);
      const yTop = st[2] + 0.003;
      const sw = 0.026 + (1 - i / 16) * 0.022;
      stripeRings.push([
        [x, yTop - 0.004, -sw],
        [x, yTop + 0.002, -sw * 0.5],
        [x, yTop + 0.002, sw * 0.5],
        [x, yTop - 0.004, sw],
      ]);
    }
    push("accent", loftRings(stripeRings, true, true, true));

    // 前隔舱皮托管（Pitot Tube）气动传感器与双天线
    rod("metal", 1.72, 0.45, 0, 1.72, 0.555, 0, 0.004);
    rod("metal", 1.72, 0.555, 0, 1.81, 0.555, 0, 0.003);
    for (const sgn of [-1, 1]) {
      rod("carbon", 1.48, 0.50, sgn * 0.06, 1.46, 0.57, sgn * 0.06, 0.003);
    }
  }

  /* ---- 2. 引擎盖高耸背脊 + 进气空箱（Airbox / Roll Hoop）+ T-Cam + 鲨鱼鳍 + 排气系统 ---- */
  {
    const airboxStations = [
      [0.26, 0.50, 0.775, 0.145, 0.115, 0.55, 1.08],
      [0.02, 0.51, 0.785, 0.160, 0.105, 0.52, 1.08],
      [-0.45, 0.48, 0.685, 0.140, 0.068, 0.48, 1.05],
      [-1.05, 0.43, 0.555, 0.115, 0.042, 0.45, 1.04],
      [-1.70, 0.37, 0.455, 0.085, 0.028, 0.45, 1.02],
      [-2.25, 0.33, 0.395, 0.062, 0.022, 0.45, 1.00],
    ];
    const abRings = airboxStations.map(s => makeSuperSection(...s, 20));
    push("livery", loftRings(abRings, true, true, true));

    // 空箱进气口深色内腔 + 中央防滚架竖直分流肋片
    box("carbon", 0.08, 0.18, 0.16, 0.25, 0.655, 0, 0, 0, -0.08);
    box("livery", 0.09, 0.17, 0.016, 0.255, 0.655, 0, 0, 0, -0.08);

    // 鲨鱼鳍导流板（Shark Fin）+ 顶缘车队拉花饰边
    const finShape = new THREE.Shape();
    finShape.moveTo(-0.18, 0.64);
    finShape.lineTo(-0.18, 0.775);
    finShape.quadraticCurveTo(-0.95, 0.745, -1.65, 0.685);
    finShape.lineTo(-1.96, 0.645);
    finShape.lineTo(-1.90, 0.42);
    finShape.lineTo(-0.18, 0.52);
    finShape.closePath();
    side("livery", finShape, 0.016, 0.004, 0);

    rod("accent", -0.19, 0.775, 0, -1.95, 0.648, 0, 0.010);

    // F1 标志性 T 字车载摄像机（T-Cam）
    box("carbon", 0.09, 0.055, 0.022, 0.14, 0.815, 0, 0, 0, -0.15);
    box("carbon", 0.075, 0.024, 0.28, 0.15, 0.848, 0);
    for (const sgn of [-1, 1]) {
      const camPod = new THREE.CylinderGeometry(0.016, 0.016, 0.095, 10);
      camPod.rotateZ(Math.PI / 2);
      push("accent", camPod, 0.16, 0.848, sgn * 0.13);
    }

    // 中央大口径排气管 + 内部黑腔 + 左右双废气门尾管（Wastegate Pipes）
    const exOuter = new THREE.CylinderGeometry(0.052, 0.058, 0.20, 16);
    exOuter.rotateZ(Math.PI / 2);
    push("metal", exOuter, -2.56, 0.355, 0);
    const exInner = new THREE.CylinderGeometry(0.042, 0.042, 0.06, 14);
    exInner.rotateZ(Math.PI / 2);
    push("carbon", exInner, -2.635, 0.355, 0);
    for (const sgn of [-1, 1]) {
      const wg = new THREE.CylinderGeometry(0.020, 0.022, 0.16, 10);
      wg.rotateZ(Math.PI / 2);
      push("metal", wg, -2.55, 0.33, sgn * 0.072);
    }
  }

  /* ---- 3. 3D 下切侧箱（RB20/SF-24 高唇口 + 深下切腰线 + 下洗斜坡 + 可乐瓶收腰 + 散热百叶窗） ---- */
  for (const sgn of [1, -1]) {
    const spStations = [
      // [x, zInner, zOuterTop, zOuterMid, zOuterBot, yBot, yMid, yTop]
      [1.08, 0.22, 0.58, 0.62, 0.44, 0.24, 0.38, 0.495],
      [0.78, 0.22, 0.62, 0.67, 0.45, 0.18, 0.35, 0.505],
      [0.25, 0.21, 0.60, 0.65, 0.48, 0.16, 0.33, 0.480],
      [-0.35, 0.19, 0.53, 0.59, 0.46, 0.155, 0.30, 0.435],
      [-0.95, 0.16, 0.42, 0.48, 0.39, 0.155, 0.27, 0.375],
      [-1.48, 0.12, 0.29, 0.34, 0.28, 0.16, 0.24, 0.320],
      [-1.88, 0.09, 0.18, 0.21, 0.18, 0.17, 0.22, 0.280],
    ];

    const spRings = spStations.map(([x, zi, zt, zm, zb, yb, ym, yt]) => {
      const ring = [
        [x, yt, sgn * zi],
        [x, yt + 0.008, sgn * ((zi + zt) * 0.48)],
        [x, yt - 0.012, sgn * zt],
        [x, ym + (yt - ym) * 0.45, sgn * (zm * 0.98)],
        [x, ym, sgn * zm],
        [x, yb + (ym - yb) * 0.35, sgn * ((zm + zb) * 0.52)],
        [x, yb, sgn * zb],
        [x, yb, sgn * zi],
      ];
      return sgn > 0 ? ring : ring.slice().reverse();
    });
    push("livery", loftRings(spRings, true, true, true));

    // 侧箱侧面涂装色块（还原 2D 涂装的 side 撞色侧板与腰线）
    const sideAccentRings = spStations.slice(0, 5).map(([x, , zt, zm, zb, yb, ym, yt]) => {
      const ring = [
        [x, yt - 0.022, sgn * (zt + 0.004)],
        [x, ym, sgn * (zm + 0.005)],
        [x, yb + 0.045, sgn * ((zm + zb) * 0.52 + 0.004)],
        [x, ym + 0.02, sgn * (zm - 0.02)],
      ];
      return sgn > 0 ? ring : ring.slice().reverse();
    });
    push("dark", loftRings(sideAccentRings, true, true, true));

    // 侧箱进气口深色内腔 + 内部倾斜铝制散热器芯
    box("carbon", 0.09, 0.19, 0.31, 1.055, 0.375, sgn * 0.43);
    box("metal", 0.04, 0.16, 0.26, 0.99, 0.37, sgn * 0.43, 0, sgn * 0.18, -0.25);

    // 侧箱前上唇延伸风刀（Overbite Inlet Lip）
    box("carbon", 0.14, 0.018, 0.34, 1.11, 0.495, sgn * 0.42, 0, -sgn * 0.08, -0.05);

    // 侧箱前外侧竖直涡流发生器（SIS 侧面防撞翼/迎风刀）
    box("carbon", 0.26, 0.22, 0.016, 1.02, 0.28, sgn * 0.625, 0, -sgn * 0.14, 0);
    box("accent", 0.22, 0.022, 0.08, 1.02, 0.39, sgn * 0.60, 0, -sgn * 0.14, 0);

    // 侧箱顶部 6 道鲨鱼鳃散热百叶窗（Cooling Louvers）
    for (let k = 0; k < 6; k++) {
      const lx = 0.35 - k * 0.14;
      const ly = 0.468 - k * 0.011;
      const lz = sgn * (0.37 - k * 0.012);
      box("carbon", 0.045, 0.016, 0.13, lx, ly, lz, 0, -sgn * 0.15, -0.28);
    }
  }

  /* ---- 4. 文丘里地面效应底板（Venturi Floor）+ 导流栅 + 卷边刀锋翼 + 立体多通道扩散器 ---- */
  {
    const floorShape = new THREE.Shape();
    floorShape.moveTo(1.78, -0.18);
    floorShape.lineTo(1.32, -0.24);
    floorShape.lineTo(1.12, -0.66);
    floorShape.lineTo(-1.35, -0.68);
    floorShape.quadraticCurveTo(-1.88, -0.64, -2.05, -0.48);
    floorShape.lineTo(-2.05, 0.48);
    floorShape.quadraticCurveTo(-1.88, 0.64, -1.35, 0.68);
    floorShape.lineTo(1.12, 0.66);
    floorShape.lineTo(1.32, 0.24);
    floorShape.lineTo(1.78, 0.18);
    floorShape.quadraticCurveTo(1.92, 0.00, 1.78, -0.18);
    plan("carbon", floorShape, 0.032, 0.008, 0.142);

    // 前分流器茶盘（T-Tray / Bib）+ 金属防拉杆
    box("carbon", 0.48, 0.020, 0.34, 1.65, 0.108, 0, 0, 0, -0.03);
    rod("metal", 1.78, 0.115, 0, 1.68, 0.21, 0, 0.007);

    // 底板外缘卷边刀锋翼（Floor Edge Wing）+ 金属拉杆 + 边缘拉花色带
    for (const sgn of [1, -1]) {
      box("carbon", 1.85, 0.022, 0.055, -0.10, 0.135, sgn * 0.705, sgn * 0.24, 0, 0);
      box("accent", 1.65, 0.012, 0.022, -0.08, 0.144, sgn * 0.728, sgn * 0.24, 0, 0);
      for (let f = 0; f < 3; f++) {
        const fz = sgn * (0.34 + f * 0.11);
        box("carbon", 0.36, 0.055, 0.012, 1.08 - f * 0.04, 0.135, fz, 0, -sgn * (0.12 + f * 0.06), 0);
      }
      rod("metal", -0.55, 0.22, sgn * 0.46, -0.55, 0.14, sgn * 0.69, 0.005);
      rod("metal", -1.15, 0.20, sgn * 0.40, -1.15, 0.14, sgn * 0.68, 0.005);
    }

    // 3D 弧形膨胀扩散器顶盖（Rear Diffuser）+ 6 道竖直涡流隔板
    const diffRings = [];
    for (let i = 0; i <= 8; i++) {
      const t = i / 8;
      const dx = -1.65 - t * 0.80;
      const dy = 0.132 + Math.pow(t, 1.35) * 0.165;
      const dw = 0.52 - t * 0.04;
      diffRings.push([
        [dx, dy, -dw],
        [dx, dy + 0.022, -dw * 0.96],
        [dx, dy + 0.026, 0],
        [dx, dy + 0.022, dw * 0.96],
        [dx, dy, dw],
        [dx, dy - 0.014, dw],
        [dx, dy - 0.010, 0],
        [dx, dy - 0.014, -dw],
      ]);
    }
    push("carbon", loftRings(diffRings, true, true, true));

    for (const z of [-0.46, -0.30, -0.14, 0.14, 0.30, 0.46]) {
      box("carbon", 0.68, 0.125, 0.014, -2.08, 0.195, z, 0, 0, -0.24);
    }
  }

  /* ---- 5. 座舱内构（下沉式座舱浴盆 + 防撞头枕护颈 + 车手肩部与双手 + 流线型 Halo + 双臂后视镜） ---- */
  {
    box("carbon", 0.78, 0.12, 0.44, 0.52, 0.48, 0);
    const collarShape = new THREE.Shape();
    collarShape.moveTo(0.88, -0.24);
    collarShape.lineTo(0.10, -0.25);
    collarShape.quadraticCurveTo(-0.06, -0.25, -0.06, 0);
    collarShape.quadraticCurveTo(-0.06, 0.25, 0.10, 0.25);
    collarShape.lineTo(0.88, 0.24);
    collarShape.lineTo(0.88, 0.17);
    collarShape.lineTo(0.20, 0.16);
    collarShape.quadraticCurveTo(0.08, 0.16, 0.08, 0);
    collarShape.quadraticCurveTo(0.08, -0.16, 0.20, -0.16);
    collarShape.lineTo(0.88, -0.17);
    collarShape.closePath();
    plan("carbon", collarShape, 0.065, 0.014, 0.595);

    // 座舱前沿风挡导流唇
    box("carbon", 0.09, 0.042, 0.36, 0.92, 0.568, 0, 0, 0, 0.35);

    // 车手身体肩部与前伸握持方向盘的赛车服双臂
    box("dark", 0.26, 0.14, 0.34, 0.44, 0.47, 0, 0, 0, 0.20);
    for (const sgn of [-1, 1]) {
      rod("accent", 0.48, 0.49, sgn * 0.15, 0.72, 0.525, sgn * 0.115, 0.032);
    }

    // 流线型空气动力学 Halo（钛合金骨架 + 碳纤维整流罩 + 顶部回旋镖导流翼）
    const haloCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0.02, 0.585, -0.185),
      new THREE.Vector3(0.24, 0.715, -0.285),
      new THREE.Vector3(0.54, 0.725, -0.265),
      new THREE.Vector3(0.76, 0.655, -0.145),
      new THREE.Vector3(0.85, 0.605, 0),
      new THREE.Vector3(0.76, 0.655, 0.145),
      new THREE.Vector3(0.54, 0.725, 0.265),
      new THREE.Vector3(0.24, 0.715, 0.285),
      new THREE.Vector3(0.02, 0.585, 0.185),
    ]);
    const haloTube = new THREE.TubeGeometry(haloCurve, 52, 0.030, 12, false);
    haloTube.scale(1, 0.78, 1.08);
    haloTube.translate(0, 0.145, 0);
    push("carbon", haloTube);

    rod("carbon", 0.87, 0.515, 0, 0.835, 0.618, 0, 0.026, 1.45, 0.72);
    for (const sgn of [-1, 1]) {
      box("accent", 0.34, 0.012, 0.032, 0.45, 0.732, sgn * 0.255, sgn * 0.15, -sgn * 0.12, -0.05);
    }

    // 双支臂流线型后视镜
    for (const sgn of [1, -1]) {
      box("livery", 0.13, 0.052, 0.145, 0.84, 0.615, sgn * 0.465, 0, -sgn * 0.08, 0);
      box("metal", 0.012, 0.040, 0.125, 0.778, 0.615, sgn * 0.465, 0, -sgn * 0.08, 0);
      rod("carbon", 0.82, 0.545, sgn * 0.25, 0.84, 0.612, sgn * 0.42, 0.010, 1.6, 0.6);
      rod("carbon", 0.86, 0.495, sgn * 0.44, 0.85, 0.595, sgn * 0.46, 0.009, 1.6, 0.6);
    }
  }

  /* ---- 6. 四层三维后掠鸥翼前翼（Swept Gull-Wing Front Wing）+ 外洗曲面端板 + 鹅颈鼻柱 ---- */
  {
    // 1) 主翼（Mainplane）
    push("dark", buildSweptAirfoil(v => {
      const av = Math.abs(v);
      const gull = 0.022 * Math.sin(av * Math.PI * 0.85);
      const sweep = -0.14 * Math.pow(av, 1.45);
      return {
        x: 2.60 + sweep,
        y: 0.112 + gull,
        z: v * 0.90,
        chord: 0.26 * (1 - 0.18 * av),
        thick: 0.11,
        angle: -0.05,
        camber: 0.06,
      };
    }, 30, 14));

    // 2) 第二层翼片（Flap 2）
    push("carbon", buildSweptAirfoil(v => {
      const av = Math.abs(v);
      const gull = 0.024 * Math.sin(av * Math.PI * 0.85);
      const sweep = -0.15 * Math.pow(av, 1.45);
      return {
        x: 2.47 + sweep,
        y: 0.152 + gull,
        z: v * 0.895,
        chord: 0.20 * (1 - 0.15 * av),
        thick: 0.10,
        angle: -0.14,
        camber: 0.08,
      };
    }, 28, 12));

    // 3) 第三层翼片（Flap 3）
    push("livery", buildSweptAirfoil(v => {
      const av = Math.abs(v);
      const gull = 0.022 * Math.sin(av * Math.PI * 0.85);
      const sweep = -0.16 * Math.pow(av, 1.45);
      return {
        x: 2.36 + sweep,
        y: 0.198 + gull,
        z: v * 0.89,
        chord: 0.17 * (1 - 0.15 * av),
        thick: 0.10,
        angle: -0.23,
        camber: 0.09,
      };
    }, 28, 12));

    // 4) 第四层可调主翼片（Upper Flap，中央留出鼻锥通道，涂装高光色 accent）
    for (const sgn of [-1, 1]) {
      push("accent", buildSweptAirfoil(u => {
        const av = 0.16 + (u + 1) * 0.5 * 0.725;
        const gull = 0.018 * Math.sin(av * Math.PI * 0.85);
        const sweep = -0.17 * Math.pow(av, 1.45);
        return {
          x: 2.26 + sweep,
          y: 0.246 + gull,
          z: sgn * av * 0.99,
          chord: 0.145 * (1 - 0.18 * av),
          thick: 0.095,
          angle: -0.32,
          camber: 0.10,
        };
      }, 14, 12));
    }

    // 翼片调节支码、鼻锥挂柱、3D 外洗曲面端板与风刀
    for (const sgn of [1, -1]) {
      for (const zPos of [0.32, 0.58, 0.78]) {
        box("metal", 0.06, 0.035, 0.008, 2.35 - zPos * 0.08, 0.21, sgn * zPos, 0, 0, -0.22);
      }
      box("livery", 0.16, 0.12, 0.022, 2.48, 0.185, sgn * 0.085, 0, 0, 0.18);

      const epShape = new THREE.Shape();
      epShape.moveTo(2.12, 0.105);
      epShape.lineTo(2.62, 0.105);
      epShape.quadraticCurveTo(2.74, 0.105, 2.74, 0.19);
      epShape.quadraticCurveTo(2.72, 0.34, 2.52, 0.365);
      epShape.lineTo(2.18, 0.345);
      epShape.quadraticCurveTo(2.08, 0.32, 2.08, 0.22);
      epShape.closePath();
      side("dark", epShape, 0.018, 0.005, sgn * 0.905);

      box("accent", 0.26, 0.016, 0.055, 2.42, 0.255, sgn * 0.935, sgn * 0.12, -sgn * 0.08, -0.22);
      box("carbon", 0.48, 0.016, 0.065, 2.38, 0.104, sgn * 0.915);
    }
  }

  /* ---- 7. 勺形尾翼（Spoon Rear Wing）+ DRS 上翼片 + 过顶式鹅颈吊柱 + 双层梁翼 + 吸能盒 ---- */
  {
    // 1) 勺形下凹尾翼主翼
    push("dark", buildSweptAirfoil(v => {
      const av = Math.abs(v);
      const spoon = 0.042 * Math.pow(av, 1.6);
      const sweep = -0.04 * av * av;
      return {
        x: -2.42 + sweep,
        y: 0.755 + spoon,
        z: v * 0.595,
        chord: 0.31 * (1 - 0.10 * av),
        thick: 0.13,
        angle: -0.14,
        camber: 0.09,
      };
    }, 24, 14));

    // 2) DRS 可调上翼片
    push("accent", buildSweptAirfoil(v => {
      const av = Math.abs(v);
      const spoon = 0.016 * Math.pow(av, 1.5);
      return {
        x: -2.55,
        y: 0.885 + spoon,
        z: v * 0.592,
        chord: 0.22,
        thick: 0.11,
        angle: -0.32,
        camber: 0.08,
      };
    }, 22, 12));

    // 3) 中央 DRS 作动器整流罩 + 过顶式鹅颈刀锋支架（侧视流线轮廓挤出，精准贴合车尾与主翼上表面）
    box("carbon", 0.14, 0.058, 0.042, -2.46, 0.835, 0, 0, 0, -0.18);
    {
      const neckShape = new THREE.Shape();
      neckShape.moveTo(-1.98, 0.40);
      neckShape.quadraticCurveTo(-2.14, 0.65, -2.26, 0.815);
      neckShape.quadraticCurveTo(-2.36, 0.835, -2.45, 0.775);
      neckShape.lineTo(-2.45, 0.745);
      neckShape.quadraticCurveTo(-2.34, 0.775, -2.28, 0.735);
      neckShape.quadraticCurveTo(-2.18, 0.56, -2.10, 0.37);
      neckShape.closePath();
      for (const sgn of [-1, 1]) {
        side("carbon", neckShape, 0.014, 0.003, sgn * 0.065);
      }
    }

    // 4) 尾翼弧形端板 + 外侧导流条（严格收纳在端板轮廓内，不探出后缘）
    const rwShape = new THREE.Shape();
    rwShape.moveTo(-2.18, 0.44);
    rwShape.quadraticCurveTo(-2.16, 0.82, -2.28, 0.93);
    rwShape.quadraticCurveTo(-2.48, 0.985, -2.68, 0.945);
    rwShape.lineTo(-2.74, 0.90);
    rwShape.lineTo(-2.72, 0.70);
    rwShape.lineTo(-2.56, 0.66);
    rwShape.lineTo(-2.52, 0.44);
    rwShape.closePath();
    for (const sgn of [1, -1]) {
      side("dark", rwShape, 0.018, 0.005, sgn * 0.602);
      box("accent", 0.36, 0.045, 0.008, -2.48, 0.88, sgn * 0.614, 0, 0, -0.08);
      for (let k = 0; k < 3; k++) {
        box("carbon", 0.13, 0.009, 0.008, -2.35 - k * 0.02, 0.58 - k * 0.042, sgn * 0.613, 0, 0, -0.18);
      }
    }

    // 5) 双层梁翼（Dual-Element Beam Wing）
    push("carbon", buildSweptAirfoil(v => ({
      x: -2.38, y: 0.465, z: v * 0.55, chord: 0.18, thick: 0.10, angle: -0.22, camber: 0.08,
    }), 16, 10));
    push("carbon", buildSweptAirfoil(v => ({
      x: -2.48, y: 0.535, z: v * 0.55, chord: 0.15, thick: 0.10, angle: -0.34, camber: 0.09,
    }), 16, 10));

    // 6) 尾部碳纤维防撞吸能盒 + FIA 中央尾灯与端板 LED 嵌入式碳纤维灯框
    box("carbon", 0.34, 0.155, 0.105, -2.46, 0.245, 0, 0, 0, -0.04);
    box("carbon", 0.032, 0.158, 0.098, -2.625, 0.245, 0);
    for (const sgn of [-1, 1]) {
      box("carbon", 0.024, 0.205, 0.024, -2.716, 0.795, sgn * 0.602);
    }
  }

  /* ---- 8. 翼型截面双叉臂悬挂（Aero Wishbones）+ 推拉杆 + 转向横拉杆 + 后传动半轴 ---- */
  const buildCornerSuspension = (zSgn, front) => {
    const r = front ? WHEEL_R_F : WHEEL_R_R;
    const hubZ = (front ? WHEEL_FRONT_Z : WHEEL_REAR_Z) - (front ? 0.13 : 0.16);
    const ax = front ? WHEEL_FRONT_X : WHEEL_REAR_X;
    const ziUp = zSgn * (front ? 0.165 : 0.145);
    const ziLo = zSgn * (front ? 0.185 : 0.165);
    const upY = front ? 0.425 : 0.415;
    const loY = front ? 0.195 : 0.185;

    rod("susp", ax + 0.18, upY, ziUp, ax + 0.02, r + 0.085, zSgn * hubZ, 0.017, 1.85, 0.48);
    rod("susp", ax - 0.18, upY - 0.01, ziUp, ax - 0.02, r + 0.085, zSgn * hubZ, 0.017, 1.85, 0.48);
    rod("susp", ax + 0.17, loY, ziLo, ax + 0.02, r - 0.095, zSgn * hubZ, 0.018, 1.85, 0.48);
    rod("susp", ax - 0.19, loY, ziLo, ax - 0.02, r - 0.095, zSgn * hubZ, 0.018, 1.85, 0.48);

    if (front) {
      rod("susp", ax + 0.08, upY + 0.035, ziUp * 0.92, ax, r - 0.065, zSgn * (hubZ - 0.02), 0.013);
      rod("metal", ax + 0.09, loY + 0.08, ziLo, ax + 0.06, r - 0.02, zSgn * hubZ, 0.011);
    } else {
      rod("susp", ax - 0.12, loY + 0.02, ziLo * 0.90, ax, r + 0.07, zSgn * (hubZ - 0.02), 0.013);
      rod("metal", ax - 0.03, r - 0.01, zSgn * 0.13, ax, r, zSgn * hubZ, 0.022);
    }
  };
  buildCornerSuspension(1, true);
  buildCornerSuspension(-1, true);
  buildCornerSuspension(1, false);
  buildCornerSuspension(-1, false);

  /* ---- 9. 鼻锥曲面车号贴片（精确贴合 3D 放样鼻锥上表面） ---- */
  const numberGeo = (() => {
    const g = new THREE.PlaneGeometry(0.46, 0.24, 14, 8);
    g.rotateZ(Math.PI / 2);
    g.rotateX(-Math.PI / 2);
    const pos = g.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i) + 1.98;
      const z = pos.getZ(i);
      const st = sampleMonocoqueAt(x);
      const yTop = st[2], wTop = Math.max(0.08, st[4]);
      const zn = Math.min(0.95, Math.abs(z) / wTop);
      const drop = (1 - Math.sqrt(1 - zn * zn)) * 0.045;
      pos.setY(i, yTop - drop + 0.005);
      pos.setX(i, x);
    }
    g.computeVertexNormals();
    return g;
  })();

  f1GeoCache = {
    livery: mergeBucket(B.livery),
    dark: mergeBucket(B.dark),
    accent: mergeBucket(B.accent),
    carbon: mergeBucket(B.carbon),
    susp: mergeBucket(B.susp),
    metal: mergeBucket(B.metal),
    number: numberGeo,
  };
  return f1GeoCache;
}

/* ================= 程序化高精贴图 ================= */

// 18 寸倍耐力 P-ZERO 轮胎侧壁：512×512 高清橡胶环纹 + 彩色配方环 + 弧形品牌字
function tireSidewallTexture(compoundColor = "#e1251b") {
  const S = 512;
  const cv = document.createElement("canvas");
  cv.width = S; cv.height = S;
  const c = cv.getContext("2d");
  const cx = S / 2;

  const rg = c.createRadialGradient(cx, cx, S * 0.24, cx, cx, S * 0.50);
  rg.addColorStop(0, "#090a0d");
  rg.addColorStop(0.55, "#15171c");
  rg.addColorStop(0.88, "#101216");
  rg.addColorStop(1, "#0a0b0e");
  c.fillStyle = rg;
  c.fillRect(0, 0, S, S);

  c.strokeStyle = "rgba(255,255,255,0.03)";
  c.lineWidth = 1.5;
  for (let r = S * 0.29; r < S * 0.47; r += 4) {
    c.beginPath(); c.arc(cx, cx, r, 0, Math.PI * 2); c.stroke();
  }

  c.strokeStyle = "rgba(0,0,0,0.45)";
  c.lineWidth = 2.5;
  for (let k = 0; k < 36; k++) {
    const a = (k / 36) * Math.PI * 2;
    c.beginPath();
    c.moveTo(cx + Math.cos(a) * S * 0.29, cx + Math.sin(a) * S * 0.29);
    c.lineTo(cx + Math.cos(a) * S * 0.47, cx + Math.sin(a) * S * 0.47);
    c.stroke();
  }

  c.strokeStyle = "#484e58";
  c.lineWidth = 6;
  c.beginPath(); c.arc(cx, cx, S * 0.278, 0, Math.PI * 2); c.stroke();

  c.strokeStyle = compoundColor;
  c.lineWidth = 14;
  c.lineCap = "round";
  for (let seg = 0; seg < 2; seg++) {
    const baseA = seg * Math.PI;
    c.beginPath();
    c.arc(cx, cx, S * 0.385, baseA + 0.18, baseA + Math.PI - 0.18);
    c.stroke();
  }

  const drawArcText = (str, radius, startAngle, spanAngle, font, color) => {
    c.save();
    c.font = font;
    c.fillStyle = color;
    c.textAlign = "center";
    c.textBaseline = "middle";
    const n = str.length;
    for (let i = 0; i < n; i++) {
      const a = startAngle + ((i + 0.5) / n) * spanAngle;
      c.save();
      c.translate(cx + Math.cos(a) * radius, cx + Math.sin(a) * radius);
      c.rotate(a + Math.PI / 2);
      c.fillText(str[i], 0, 0);
      c.restore();
    }
    c.restore();
  };
  drawArcText("P ZERO", S * 0.34, -0.38, 0.76, "italic 900 28px Arial, sans-serif", "#f2f4f8");
  drawArcText("PIRELLI", S * 0.34, Math.PI - 0.44, 0.88, "bold 26px Arial, sans-serif", "#f5c518");

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

// 胎面：热熔光头胎（Slick Tire）细腻橡胶光泽 + 胎冠磨损微痕
function tireTreadTexture() {
  const S = 256;
  const cv = document.createElement("canvas");
  cv.width = S; cv.height = S;
  const c = cv.getContext("2d");
  const lg = c.createLinearGradient(0, 0, S, 0);
  lg.addColorStop(0, "#0e1014");
  lg.addColorStop(0.18, "#181b21");
  lg.addColorStop(0.5, "#1d2027");
  lg.addColorStop(0.82, "#181b21");
  lg.addColorStop(1, "#0e1014");
  c.fillStyle = lg;
  c.fillRect(0, 0, S, S);
  for (let i = 0; i < 900; i++) {
    c.fillStyle = Math.random() > 0.5 ? "rgba(48,52,60,0.38)" : "rgba(6,7,10,0.42)";
    c.fillRect(Math.random() * S, Math.random() * S, 1 + Math.random() * 3, 4 + Math.random() * 12);
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// 2×2 斜纹碳纤维编织贴图
function carbonWeaveTexture() {
  const S = 64;
  const cv = document.createElement("canvas");
  cv.width = S; cv.height = S;
  const c = cv.getContext("2d");
  c.fillStyle = "#16181e";
  c.fillRect(0, 0, S, S);
  const step = 8;
  for (let y = 0; y < S; y += step) {
    for (let x = 0; x < S; x += step) {
      const odd = ((x / step + y / step) & 1) === 0;
      c.fillStyle = odd ? "#23262f" : "#111318";
      c.fillRect(x, y, step / 2, step);
      c.fillStyle = odd ? "#111318" : "#23262f";
      c.fillRect(x + step / 2, y, step / 2, step);
    }
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(16, 16);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// F1 专用贴图（车底接触阴影与卡车共用，走 shared.js 的 GROUND）
const F1_TEX = {
  sidewall: tireSidewallTexture("#e1251b"),
  tread: tireTreadTexture(),
  carbonWeave: carbonWeaveTexture(),
  contactShadow: GROUND.contactShadow,
  contactShadowGeo: GROUND.contactShadowGeo,
};

// 创建一辆 F1 的 3D 视觉体（形状跨车共享，材质逐车独立）
export function create(car) {
  // 解析车队涂装配色表（兼容 car.customLivery、CAR_LIVERIES[car.livery] 与纯色 car.color）
  const preset = (car && car.livery && CAR_LIVERIES[car.livery]) ? CAR_LIVERIES[car.livery] : null;
  const liv = car && car.customLivery ? { ...(preset || {}), ...car.customLivery } : preset;

  const baseColor = new THREE.Color(car.color || (liv && liv.grad && liv.grad[1]) || "#e02424");
  const darkColor = (liv && liv.side)
    ? new THREE.Color(liv.side)
    : baseColor.clone().multiplyScalar(0.42);
  const accentColor = (liv && liv.wing)
    ? new THREE.Color(liv.wing)
    : baseColor.clone().offsetHSL(0.08, 0.15, 0.22);
  const helmetColor = (liv && liv.helmet)
    ? new THREE.Color(liv.helmet)
    : baseColor.clone().offsetHSL(0.45, 0.18, 0.12);
  const numColorStr = (liv && liv.numColor) || "#f5f6f8";

  // 赛车级清漆 PBR 材质（高光清漆层 + 金属漆颗粒感 + 碳纤维编织纹）
  const livery = new THREE.MeshPhysicalMaterial({
    color: baseColor, metalness: 0.46, roughness: 0.24,
    clearcoat: 0.88, clearcoatRoughness: 0.12,
  });
  const liveryDark = new THREE.MeshPhysicalMaterial({
    color: darkColor, metalness: 0.42, roughness: 0.32,
    clearcoat: 0.60, clearcoatRoughness: 0.18,
  });
  const accentMat = new THREE.MeshPhysicalMaterial({
    color: accentColor, metalness: 0.35, roughness: 0.26,
    clearcoat: 0.80, clearcoatRoughness: 0.14,
  });
  const carbon = new THREE.MeshStandardMaterial({
    color: 0xffffff, map: F1_TEX.carbonWeave, metalness: 0.32, roughness: 0.48,
  });
  const suspMat = new THREE.MeshStandardMaterial({
    color: 0x22262e, metalness: 0.55, roughness: 0.36,
  });
  const metalMat = new THREE.MeshStandardMaterial({
    color: 0xc2cad6, metalness: 0.90, roughness: 0.20,
  });
  const brakeMat = new THREE.MeshStandardMaterial({
    color: 0x48080c, emissive: 0x380306, emissiveIntensity: 0.38, metalness: 0.18, roughness: 0.22,
  });
  const brakeCoreMat = new THREE.MeshBasicMaterial({
    color: 0xffb86c,
    transparent: true,
    opacity: 0.28,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  brakeCoreMat.userData.baseAlpha = 0.28;
  const discMat = new THREE.MeshStandardMaterial({
    color: 0x3b4048, emissive: 0x000000, metalness: 0.78, roughness: 0.34,
  });

  const geo = f1PartGeometry();
  const root = new THREE.Group();
  // 簧上车体独立成组：支持高速加减速俯仰（Pitch）与过弯微侧倾（Roll）物理姿态
  const chassis = new THREE.Group();
  root.add(chassis);

  const bodyMesh = (g, mat, parent = chassis) => {
    const m = new THREE.Mesh(g, mat);
    m.castShadow = true;
    parent.add(m);
    return m;
  };
  bodyMesh(geo.livery, livery);
  bodyMesh(geo.dark, liveryDark);
  bodyMesh(geo.accent, accentMat);
  bodyMesh(geo.carbon, carbon);
  bodyMesh(geo.susp, suspMat);
  bodyMesh(geo.metal, metalMat);

  // 车手头盔 + 镀膜护目镜（放入可随转向微偏头的 headGroup）
  const helmetMat = new THREE.MeshPhysicalMaterial({
    color: helmetColor, metalness: 0.25, roughness: 0.22, clearcoat: 0.9, clearcoatRoughness: 0.1,
  });
  const visorMat = new THREE.MeshPhysicalMaterial({
    color: 0x101520, emissive: accentColor, emissiveIntensity: 0.22,
    metalness: 0.95, roughness: 0.06, clearcoat: 1.0,
  });
  const headGroup = new THREE.Group();
  headGroup.position.set(0.50, 0.605, 0);
  bodyMesh(G.helmet, helmetMat, headGroup);
  bodyMesh(G.visor, visorMat, headGroup);
  chassis.add(headGroup);

  // F1 蝴蝶形方向盘（放入可随转向旋转的 steerWheelGroup）
  const steerScreenMat = new THREE.MeshStandardMaterial({
    color: 0x0aff9d, emissive: 0x00d884, emissiveIntensity: 0.75, roughness: 0.2,
  });
  const steerWheelGroup = new THREE.Group();
  steerWheelGroup.position.set(0.75, 0.545, 0);
  steerWheelGroup.rotation.z = 0.28; // 方向盘朝向车手倾斜角
  bodyMesh(G.steerWheel.carbon, carbon, steerWheelGroup);
  bodyMesh(G.steerWheel.screen, steerScreenMat, steerWheelGroup);
  chassis.add(steerWheelGroup);

  // 尾部 FIA 矩阵雨灯 + 尾翼端板后缘双 LED 刹车灯条（红宝石外灯罩 + 内部高亮度 LED 二极管发光芯 + 贴合灯位光晕与点光源）
  const rainLight = new THREE.Mesh(G.rainLight, brakeMat);
  rainLight.position.set(-2.635, 0.245, 0);
  rainLight.castShadow = true;
  chassis.add(rainLight);
  const rainCore = new THREE.Mesh(new THREE.BoxGeometry(0.014, 0.115, 0.056), brakeCoreMat);
  rainCore.position.set(-2.654, 0.245, 0);
  chassis.add(rainCore);

  const epLensGeo = new THREE.BoxGeometry(0.018, 0.19, 0.016);
  const epCoreGeo = new THREE.BoxGeometry(0.010, 0.172, 0.010);
  for (const sgn of [-1, 1]) {
    const epLed = new THREE.Mesh(epLensGeo, brakeMat);
    epLed.position.set(-2.725, 0.795, sgn * 0.602);
    chassis.add(epLed);
    const epCore = new THREE.Mesh(epCoreGeo, brakeCoreMat);
    epCore.position.set(-2.732, 0.795, sgn * 0.602);
    chassis.add(epCore);
  }

  const brakeGlowObj = createBrakeGlow(chassis, [
    {
      pos: new THREE.Vector3(-2.665, 0.245, 0),
      size: 0.30, coreSize: 0.15, aspectX: 0.92, aspectY: 1.32,
      hasBeam: true, beamRadius: 0.085, beamLength: 0.46,
    },
    {
      pos: new THREE.Vector3(-2.740, 0.795, -0.602),
      size: 0.24, coreSize: 0.11, aspectX: 0.52, aspectY: 1.95,
      hasBeam: true, beamRadius: 0.058, beamLength: 0.34,
    },
    {
      pos: new THREE.Vector3(-2.740, 0.795, 0.602),
      size: 0.24, coreSize: 0.11, aspectX: 0.52, aspectY: 1.95,
      hasBeam: true, beamRadius: 0.058, beamLength: 0.34,
    },
  ], {
    color: 0xff240c,
    coreColor: 0xfff0d0,
    lightPower: 5.2,
    lightDistance: 5.5,
    groundRoot: root,
    poolLength: 2.4,
    idleGlow: 0.10,
  });

  // 中央排气管降挡回火蓝橙尾焰（重刹降挡瞬态爆燃闪烁）
  const flameMat = new THREE.MeshBasicMaterial({
    color: 0xff8822,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  flameMat.userData.baseAlpha = 0;
  const flameGeo = new THREE.ConeGeometry(0.042, 0.34, 8, 1, true);
  flameGeo.rotateZ(Math.PI / 2); // 锥尖朝向 -x（车尾喷射方向）
  const exhaustFlame = new THREE.Mesh(flameGeo, flameMat);
  exhaustFlame.position.set(-2.78, 0.43, 0);
  exhaustFlame.visible = false;
  chassis.add(exhaustFlame);

  // 车底地面效应接触暗影（Contact AO Shadow：锚定四轮接地斑与文丘里底板暗区）
  const aoMat = new THREE.MeshBasicMaterial({
    map: F1_TEX.contactShadow,
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  aoMat.userData.baseAlpha = 0.85;
  const aoShadow = new THREE.Mesh(F1_TEX.contactShadowGeo, aoMat);
  aoShadow.position.y = 0.005;
  aoShadow.renderOrder = 1;
  root.add(aoShadow);

  // 鼻锥车号贴片 + 鲨鱼鳍两侧车号贴片
  const numMat = new THREE.MeshBasicMaterial({
    map: numberTexture(car.number ?? (liv && liv.num) ?? 1, numColorStr),
    transparent: true,
    side: THREE.FrontSide,
  });
  chassis.add(new THREE.Mesh(geo.number, numMat));
  const finNumGeo = new THREE.PlaneGeometry(0.11, 0.16);
  for (const sgn of [1, -1]) {
    const finPlate = new THREE.Mesh(finNumGeo, numMat);
    finPlate.position.set(-1.18, 0.645, sgn * 0.013);
    if (sgn < 0) finPlate.rotation.y = Math.PI;
    chassis.add(finPlate);
  }

  // 四轮总成：steer 组（前轮转向 + 刹车鼓/发光刹车盘/前轮眉翼）→ spin 组（圆肩轮胎 + 18寸轮毂导流罩 + 锁止螺母）
  const tread = F1_TEX.tread, sidewall = F1_TEX.sidewall;
  const wheels = { steer: [], spin: [] };
  const tireMat = new THREE.MeshStandardMaterial({ map: tread, roughness: 0.86, metalness: 0.06 });
  const wallMat = new THREE.MeshStandardMaterial({ map: sidewall, roughness: 0.78, metalness: 0.06 });
  const coverMat = new THREE.MeshStandardMaterial({ color: 0x15181f, metalness: 0.55, roughness: 0.35 });
  const nutMat = new THREE.MeshStandardMaterial({ color: accentColor, metalness: 0.85, roughness: 0.22 });

  const allMats = [
    livery, liveryDark, accentMat, carbon, suspMat, metalMat,
    brakeMat, brakeCoreMat, discMat, helmetMat, visorMat, steerScreenMat, numMat,
    tireMat, wallMat, coverMat, nutMat, aoMat,
  ];

  const mkWheel = (x, z, front) => {
    const r = front ? WHEEL_R_F : WHEEL_R_R;
    const w = front ? WHEEL_FRONT_W : WHEEL_REAR_W;
    const tireGeo = front ? G.tireF : G.tireR;
    const coverGeo = front ? G.coverF : G.coverR;
    const ringGeo = front ? G.rimRingF : G.rimRingR;
    const uprightGeo = front
      ? (z >= 0 ? G.uprightFP : G.uprightFN)
      : (z >= 0 ? G.uprightRP : G.uprightRN);

    const steer = new THREE.Group();
    steer.position.set(x, r, z);

    // 转向节静态组件（刹车鼓、发光刹车盘、卡钳、前轮眉导流翼）：无负向缩放，确保法线全部朝外
    const upright = new THREE.Group();
    const uCarbon = new THREE.Mesh(uprightGeo.carbon, carbon);
    uCarbon.castShadow = true;
    const uDisc = new THREE.Mesh(uprightGeo.disc, discMat);
    const uCal = new THREE.Mesh(uprightGeo.caliper, accentMat);
    upright.add(uCarbon, uDisc, uCal);
    steer.add(upright);

    // 旋转车轮组件
    const spin = new THREE.Group();
    const tire = new THREE.Mesh(tireGeo, [tireMat, wallMat, wallMat]);
    tire.rotation.x = Math.PI / 2;
    tire.castShadow = true;

    // 外侧 18 寸轮毂导流罩 + 车队色装饰环 + 中央锁止螺母
    const outSign = z >= 0 ? 1 : -1;
    const coverOut = new THREE.Mesh(coverGeo, coverMat);
    if (outSign < 0) coverOut.rotation.y = Math.PI;

    const ringOut = new THREE.Mesh(ringGeo, accentMat);
    ringOut.position.z = outSign * (w * 0.5 + 0.009);
    if (outSign < 0) ringOut.rotation.y = Math.PI;

    const nutOut = new THREE.Mesh(G.wheelNut, nutMat);
    nutOut.position.z = outSign * (w * 0.5 - 0.012);

    spin.add(tire, coverOut, ringOut, nutOut);
    steer.add(spin);
    root.add(steer);

    wheels.steer.push({ group: steer, front });
    wheels.spin.push(spin);
  };
  mkWheel(WHEEL_FRONT_X, WHEEL_FRONT_Z, true);
  mkWheel(WHEEL_FRONT_X, -WHEEL_FRONT_Z, true);
  mkWheel(WHEEL_REAR_X, WHEEL_REAR_Z, false);
  mkWheel(WHEEL_REAR_X, -WHEEL_REAR_Z, false);

  root.userData = {
    wheels,
    brakeMat,
    brakeCoreMat,
    brakeGlowObj,
    brakeGlow: 0,
    discMat,
    brakeHeat: 0,
    exhaustFlame,
    flameMat,
    aoShadow,
    kerbLift: 0,
    chassis,
    headGroup,
    steerWheelGroup,
    f1Roll: 0,
    f1Pitch: 0,
    allMats,
    spinAngle: 0,
    lastAlpha: null,
  };
  return root;
}

// 车型专属每帧动画：刹车盘热辐射 / 排气回火尾焰 / 底盘气动姿态 / 车手与方向盘
export function sync(root, car, ctx) {
  const u = root.userData;
  const dt = ctx.dt ?? 0.016;
  const { spd, surf, kerbRumble, ghostA, braking } = ctx;
  // F1 碳陶刹车盘热辐射发光（重刹时升温发亮橙红光，松刹后随气流冷却）
  if (u.discMat) {
    const targetHeat = (braking && spd > 8) ? 1 : 0;
    const rate = targetHeat > u.brakeHeat ? 7.5 : 3.2;
    u.brakeHeat += (targetHeat - u.brakeHeat) * Math.min(1, dt * rate);
    u.discMat.emissive.setRGB(u.brakeHeat * 1.0, u.brakeHeat * 0.22, u.brakeHeat * 0.02);
    u.discMat.emissiveIntensity = u.brakeHeat * 2.4;
  }

  // 排气管高速重刹降挡回火尾焰（Overrun backfire pop）
  if (u.exhaustFlame && u.flameMat) {
    const popActive = braking && spd > 28 && ghostA > 0.5 && Math.sin((car.trackS || 0) * 2.9 + spd * 1.7) > 0.45;
    u.exhaustFlame.visible = popActive;
    if (popActive) {
      const flick = 0.65 + Math.random() * 0.35;
      u.flameMat.opacity = flick * 0.85;
      u.flameMat.color.setRGB(1.0, 0.42 + Math.random() * 0.38, 0.08 + Math.random() * 0.25);
      u.exhaustFlame.scale.set(0.8 + Math.random() * 0.6, 0.85 + Math.random() * 0.3, 0.85 + Math.random() * 0.3);
    }
  }

  // F1 高刚度地面效应底盘动态（高速气动下压力压缩 Aero Squat + 制动俯冲 Dive + 过弯微倾 Roll + 路肩震颤反馈）
  if (u.chassis) {
    const latG = Math.max(0, car.gLat || 0);
    const kerbRollJolt = surf === 1 ? Math.cos((car.trackS || 0) * 6.8) * 0.008 * Math.min(1, spd / 25) : 0;
    const rollTarget = -Math.sign(car.steer || 0) * Math.min(0.028, latG * 0.012) + kerbRollJolt;
    // 高速气动下压力前倾 + 重刹俯冲 / 加速抬头
    const aeroRake = -Math.min(0.005, (spd / 95) * (spd / 95) * 0.005);
    const pitchTarget = Math.max(-0.020, Math.min(0.014, (car.accel || 0) * 0.0012 + aeroRake));
    const k = Math.min(1, dt * 16);
    u.f1Roll += (rollTarget - u.f1Roll) * k;
    u.f1Pitch += (pitchTarget - u.f1Pitch) * k;
    u.chassis.rotation.x = u.f1Roll;
    u.chassis.rotation.z = u.f1Pitch;
    // 大直道极速（如上海 1.17km 大直道 300+km/h）文丘里底板吸地压缩（最高下沉 6.5mm）
    const aeroSquat = Math.min(0.0065, (spd / 90) * (spd / 90) * 0.0065);
    u.chassis.position.y = -aeroSquat - Math.abs(u.f1Roll) * 0.06;

    const steerKick = surf === 1 ? Math.sin((car.trackS || 0) * 9.5) * 0.06 * Math.min(1, spd / 25) : 0;
    if (u.steerWheelGroup) u.steerWheelGroup.rotation.x = -(car.steer || 0) * 1.45 + steerKick;
    if (u.headGroup) {
      u.headGroup.rotation.y = -(car.steer || 0) * 0.42;
      u.headGroup.rotation.x = (car.steer || 0) * 0.12 + kerbRollJolt * 1.8;
    }
  }
}

/* 释放一辆车的独立材质（共享几何、贴图与模板不释放） */
export function dispose(root) {
  (root.userData.allMats || []).forEach(m => m && m.dispose());
  disposeBrakeGlow(root.userData.brakeGlowObj);
  root.userData.brakeGlowObj = null;
}
