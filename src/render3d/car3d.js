// 程序化 F1 赛车 3D 网格：全部用 three.js 基础几何拼装（F1 车型零外部资源）
// 小米 SU8 Ultra（livery === "su7ultra"）使用真实 SU7 车模：
// public/models/su7/（EXT_meshopt glTF，来源 github.com/Yechuanjie/xiaomi-su7）
// 车头朝局部 +x；挂载到场景时 rotation.y = -car.angle（2D 画布角度 → three 坐标）
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";

// 车身几何与 2D 物理包围盒一致：长 5.6m（车头 +2.8 / 车尾 -2.8）、宽 2.0m。
// 轮位与 physics.js 落印坐标严格对齐（HALF_BASE 1.75 / TRACK_F 0.77 / TRACK_R 0.79），
// 刹车印才能精确压在轮胎正下方。
const WHEEL_R_F = 0.33, WHEEL_R_R = 0.36;
const WHEEL_FRONT_X = 1.75, WHEEL_REAR_X = -1.75;
const WHEEL_FRONT_Z = 0.77, WHEEL_REAR_Z = 0.79;
const WHEEL_FRONT_W = 0.31, WHEEL_REAR_W = 0.42;

/* ================= 共享几何（所有车复用，只读） ================= */
const G = {
  tireF: new THREE.CylinderGeometry(WHEEL_R_F, WHEEL_R_F, WHEEL_FRONT_W, 22),
  tireR: new THREE.CylinderGeometry(WHEEL_R_R, WHEEL_R_R, WHEEL_REAR_W, 22),
  rim: new THREE.CylinderGeometry(WHEEL_R_F * 0.55, WHEEL_R_F * 0.55, 0.03, 14),
  helmet: new THREE.SphereGeometry(0.15, 16, 12),
  rainLight: new THREE.BoxGeometry(0.05, 0.14, 0.13),
};

/* ================= 程序化 F1 车体 =================
   形状只构建一次跨车共享（按材质合并成 4 个静态网格，省 draw call）；
   材质逐车独立（换色 / 幽灵透明度互不影响）。
   坐标约定：x 向前（+2.8 车头），y 向上，z 向右；地面 y=0。 */

// 鼻锥母线（半径, 沿轴距）：车鼻尖 x=2.62 → 底 x=1.20，车头下压姿态
const NOSE_PROFILE = [
  [0.050, 0.00], [0.090, 0.18], [0.150, 0.50], [0.200, 0.85], [0.235, 1.15], [0.250, 1.42],
];
function noseRadiusAt(x) {
  for (let i = 0; i < NOSE_PROFILE.length - 1; i++) {
    const [r0, t0] = NOSE_PROFILE[i], [r1, t1] = NOSE_PROFILE[i + 1];
    const x0 = 2.62 - t0, x1 = 2.62 - t1;
    if (x <= x0 && x >= x1) return r0 + (r1 - r0) * ((x0 - x) / (x0 - x1));
  }
  return 0.25;
}

// 把某材质桶里的几何合并成一个网格几何（全部转非索引再合并）
function mergeBucket(bucket) {
  const nonIndexed = bucket.map(g => (g.index ? g.toNonIndexed() : g));
  const merged = mergeGeometries(nonIndexed, false);
  nonIndexed.forEach(g => g.dispose());
  return merged;
}

const _up = new THREE.Vector3(0, 1, 0);
const _one = new THREE.Vector3(1, 1, 1);

let f1GeoCache = null;
function f1PartGeometry() {
  if (f1GeoCache) return f1GeoCache;
  const B = { livery: [], dark: [], carbon: [], susp: [] };

  // 平移+欧拉角变换后放入材质桶（geo 视为临时对象，转换后被释放）
  const push = (name, geo, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) => {
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(x, y, z),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)),
      _one,
    );
    geo.applyMatrix4(m);
    B[name].push(geo);
  };
  // 板/翼：BoxGeometry（弦长 x、厚 y、展长 z），攻角统一绕 z 轴（翼展方向）
  const wing = (name, cx, th, span, x, y, z, rz = 0) =>
    push(name, new THREE.BoxGeometry(cx, th, span), x, y, z, 0, 0, rz);
  // 连杆：两点之间拉一根圆柱（悬挂 / 鹅颈支架 / 后视镜杆）
  const rod = (name, x1, y1, z1, x2, y2, z2, r = 0.016) => {
    const a = new THREE.Vector3(x1, y1, z1);
    const b = new THREE.Vector3(x2, y2, z2).sub(a);
    const len = b.length();
    const g = new THREE.CylinderGeometry(r, r, len, 6);
    g.applyMatrix4(new THREE.Matrix4().compose(
      new THREE.Vector3(x1, y1, z1).addScaledVector(b, 0.5),
      new THREE.Quaternion().setFromUnitVectors(_up, b.normalize()),
      _one,
    ));
    B[name].push(g);
  };
  // 侧视轮廓挤出（x 长、y 高，沿 z 挤出后居中）
  const side = (name, shape, depth, bevel, z0 = 0) => {
    const g = new THREE.ExtrudeGeometry(shape, {
      depth, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel,
      bevelSegments: 2, curveSegments: 14,
    });
    g.translate(0, 0, z0 - depth / 2);
    B[name].push(g);
  };
  // 俯视轮廓挤出（x 长、y=侧向，rotateX 后厚度落到 y 轴）
  const plan = (name, shape, depth, bevel, topY) => {
    const g = new THREE.ExtrudeGeometry(shape, {
      depth, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel,
      bevelSegments: 2, curveSegments: 14,
    });
    g.rotateX(Math.PI / 2);              // 挤出方向 +z → -y
    g.translate(0, topY - bevel, 0);     // topY 为顶面高度
    B[name].push(g);
  };

  /* ---- 底板 + 扩散器 ---- */
  {
    const s = new THREE.Shape();
    s.moveTo(1.60, -0.24);
    s.lineTo(0.70, -0.62);
    s.lineTo(-1.30, -0.64);
    s.quadraticCurveTo(-1.90, -0.60, -2.00, -0.44);
    s.lineTo(-2.00, 0.44);
    s.quadraticCurveTo(-1.90, 0.60, -1.30, 0.64);
    s.lineTo(0.70, 0.62);
    s.lineTo(1.60, 0.24);
    s.quadraticCurveTo(1.70, 0.00, 1.60, -0.24);
    plan("carbon", s, 0.045, 0.012, 0.142);
  }
  wing("carbon", 0.55, 0.035, 0.94, -2.02, 0.160, 0, -0.30);   // 扩散器斜板
  for (const z of [0, 0.26, -0.26, 0.42, -0.42])
    wing("carbon", 0.50, 0.13, 0.014, -2.06, 0.205, z, -0.30); // 扩散器竖直隔条

  /* ---- 中央车体：座舱浴盆（俯视轮廓，尾部收窄让位给变速箱锥体） ---- */
  {
    const s = new THREE.Shape();
    s.moveTo(1.30, -0.18);
    s.quadraticCurveTo(0.90, -0.30, 0.20, -0.44);
    s.lineTo(-1.20, -0.46);
    s.quadraticCurveTo(-1.85, -0.43, -2.05, -0.30);
    s.lineTo(-2.05, 0.30);
    s.quadraticCurveTo(-1.85, 0.43, -1.20, 0.46);
    s.lineTo(0.20, 0.44);
    s.quadraticCurveTo(0.90, 0.30, 1.30, 0.18);
    s.quadraticCurveTo(1.44, 0.00, 1.30, -0.18);
    plan("livery", s, 0.30, 0.05, 0.52);   // 顶面 0.52，底面 0.12
  }
  /* ---- 变速箱锥体（车尾收细，外露吸能箱与之衔接） ---- */
  {
    const s = new THREE.Shape();
    s.moveTo(-1.55, 0.13);
    s.lineTo(-1.55, 0.50);
    s.quadraticCurveTo(-2.10, 0.46, -2.45, 0.36);
    s.lineTo(-2.58, 0.33);
    s.lineTo(-2.58, 0.13);
    s.closePath();
    side("livery", s, 0.28, 0.04, 0);
  }

  /* ---- 鼻锥（回转体，车头下压）---- */
  {
    // 母线必须按 y 升序排布，否则 LatheGeometry 法线朝内
    const pts = NOSE_PROFILE.slice().reverse().map(([r, t]) => new THREE.Vector2(r, -t));
    const g = new THREE.LatheGeometry(pts, 28);
    g.rotateZ(-Math.PI / 2);              // 回转轴 +y → +x，鼻尖在 x=0
    push("livery", g, 2.62, 0.30, 0);
  }

  /* ---- 侧箱（左右各一，侧视轮廓）+ 进气口 ---- */
  for (const sgn of [1, -1]) {
    const s = new THREE.Shape();
    s.moveTo(1.02, 0.15);
    s.lineTo(1.02, 0.42);
    s.quadraticCurveTo(0.50, 0.47, -0.10, 0.455);
    s.quadraticCurveTo(-1.00, 0.43, -1.55, 0.33);
    s.lineTo(-1.55, 0.15);
    s.closePath();
    side("livery", s, 0.22, 0.04, sgn * 0.43);
    push("carbon", new THREE.BoxGeometry(0.10, 0.20, 0.20), 1.03, 0.31, sgn * 0.43);
    // 车轮前方的导流板
    push("carbon", new THREE.BoxGeometry(0.28, 0.16, 0.016), 0.98, 0.26, sgn * 0.52, 0, -sgn * 0.12, 0);
  }

  /* ---- 引擎盖背脊 + 鲨鱼鳍 + 进气口 + T 字摄像机 + 排气 ---- */
  {
    const s = new THREE.Shape();
    s.moveTo(0.70, 0.28);
    s.quadraticCurveTo(0.62, 0.52, 0.30, 0.585);
    s.quadraticCurveTo(-0.60, 0.60, -1.20, 0.52);
    s.quadraticCurveTo(-1.90, 0.42, -2.30, 0.33);
    s.lineTo(-2.30, 0.26);
    s.closePath();
    side("livery", s, 0.24, 0.05, 0);
  }
  {
    const s = new THREE.Shape();
    s.moveTo(-1.00, 0.40);
    s.lineTo(-1.00, 0.50);
    s.quadraticCurveTo(-1.60, 0.60, -2.10, 0.56);
    s.lineTo(-2.28, 0.52);
    s.lineTo(-2.28, 0.36);
    s.closePath();
    side("livery", s, 0.018, 0.006, 0);
  }
  push("carbon", new THREE.BoxGeometry(0.14, 0.10, 0.24), 0.28, 0.60, 0);   // 空箱进气口
  push("carbon", new THREE.BoxGeometry(0.10, 0.055, 0.22), 0.30, 0.645, 0); // T-cam
  {
    const ex = new THREE.CylinderGeometry(0.042, 0.052, 0.18, 10);
    ex.rotateZ(Math.PI / 2);              // 轴向 → x
    push("carbon", ex, -2.62, 0.335, 0);
  }

  /* ---- 座舱：开口、头枕、头盔护目镜 ---- */
  push("carbon", new THREE.BoxGeometry(0.68, 0.02, 0.50), 0.55, 0.525, 0);
  push("carbon", new THREE.BoxGeometry(0.30, 0.16, 0.48), 0.30, 0.53, 0);
  push("carbon", new THREE.BoxGeometry(0.10, 0.06, 0.20), 0.645, 0.60, 0);

  /* ---- Halo（管状环 + 前柱） ---- */
  {
    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(-0.22, 0.58, -0.19),
      new THREE.Vector3(0.08, 0.72, -0.37),
      new THREE.Vector3(0.42, 0.745, -0.37),
      new THREE.Vector3(0.68, 0.65, -0.21),
      new THREE.Vector3(0.80, 0.545, 0),
      new THREE.Vector3(0.68, 0.65, 0.21),
      new THREE.Vector3(0.42, 0.745, 0.37),
      new THREE.Vector3(0.08, 0.72, 0.37),
      new THREE.Vector3(-0.22, 0.58, 0.19),
    ]);
    push("carbon", new THREE.TubeGeometry(curve, 48, 0.036, 10));
    rod("carbon", 0.82, 0.47, 0, 0.78, 0.60, 0, 0.028);
  }

  /* ---- 后视镜 ---- */
  for (const sgn of [1, -1]) {
    push("livery", new THREE.BoxGeometry(0.10, 0.055, 0.13), 0.92, 0.56, sgn * 0.46);
    rod("carbon", 0.86, 0.50, sgn * 0.36, 0.92, 0.56, sgn * 0.45, 0.012);
  }

  /* ---- 前翼：主翼 + 双层翼片 + 端板 + 引流板 + 鼻锥吊耳 ---- */
  wing("dark", 0.36, 0.035, 1.78, 2.54, 0.115, 0, -0.06);
  wing("carbon", 0.30, 0.032, 1.56, 2.415, 0.205, 0, -0.17);
  wing("carbon", 0.24, 0.030, 1.26, 2.30, 0.290, 0, -0.27);
  {
    const s = new THREE.Shape();
    s.moveTo(2.30, 0.09);
    s.quadraticCurveTo(2.30, 0.055, 2.38, 0.055);
    s.lineTo(2.72, 0.055);
    s.quadraticCurveTo(2.82, 0.055, 2.82, 0.14);
    s.lineTo(2.82, 0.24);
    s.quadraticCurveTo(2.82, 0.30, 2.72, 0.30);
    s.lineTo(2.40, 0.30);
    s.quadraticCurveTo(2.30, 0.30, 2.30, 0.22);
    s.closePath();
    side("dark", s, 0.016, 0.005, 0.892);
    side("dark", s, 0.016, 0.005, -0.892);
  }
  for (const sgn of [1, -1])
    wing("carbon", 0.24, 0.018, 0.05, 2.52, 0.300, sgn * 0.925, -0.20);
  for (const sgn of [1, -1])
    push("livery", new THREE.BoxGeometry(0.05, 0.14, 0.035), 2.56, 0.185, sgn * 0.10, 0, 0, 0.15);

  /* ---- 尾翼：端板 + 主翼 + DRS 翼 + 鹅颈吊架 + 梁翼 + 吸能箱 ----
     攻角 = 绕 z 轴（翼展方向）负角：后缘（-x）抬高产生下压力。
     旧版误用 rotation.x 导致翼片一侧翘起（"尾翼歪了"）。
     端板为 F1 经典弧线轮廓：前缘上掠、顶缘随翼片起伏、尾部下切。 */
  {
    const s = new THREE.Shape();
    s.moveTo(-1.98, 0.40);
    s.quadraticCurveTo(-1.97, 0.80, -2.14, 0.88);
    s.quadraticCurveTo(-2.40, 0.97, -2.68, 0.92);
    s.lineTo(-2.80, 0.86);
    s.lineTo(-2.80, 0.66);
    s.quadraticCurveTo(-2.68, 0.58, -2.45, 0.57);
    s.lineTo(-2.10, 0.47);
    s.closePath();
    side("dark", s, 0.016, 0.005, 0.607);
    side("dark", s, 0.016, 0.005, -0.607);
  }
  wing("dark", 0.34, 0.040, 1.24, -2.44, 0.780, 0, -0.12);   // 主翼
  wing("dark", 0.24, 0.035, 1.24, -2.56, 0.895, 0, -0.28);   // DRS 翼
  wing("carbon", 0.10, 0.045, 0.14, -2.47, 0.820, 0);        // DRS 作动筒
  for (const sgn of [1, -1])
    rod("carbon", -2.08, 0.34, sgn * 0.16, -2.40, 0.755, sgn * 0.16, 0.032); // 鹅颈
  wing("carbon", 0.22, 0.030, 1.14, -2.42, 0.500, 0, -0.26); // 梁翼
  push("carbon", new THREE.BoxGeometry(0.30, 0.14, 0.12), -2.42, 0.38, 0);  // 尾部吸能箱

  /* ---- 悬挂：每轮双叉臂（上下各两根）+ 推杆 ---- */
  const arm = (zSgn, front) => {
    const r = front ? WHEEL_R_F : WHEEL_R_R;
    const hubZ = (front ? WHEEL_FRONT_Z : WHEEL_REAR_Z) - 0.14;
    const ax = front ? WHEEL_FRONT_X : WHEEL_REAR_X;
    const zi = zSgn * (front ? 0.19 : 0.23);
    const upY = front ? 0.44 : 0.46, loY = front ? 0.17 : 0.18;
    rod("susp", ax - 0.14, upY, zi, ax, r + 0.06, zSgn * hubZ, 0.021);
    rod("susp", ax + 0.14, upY, zi, ax, r + 0.06, zSgn * hubZ, 0.021);
    rod("susp", ax - 0.14, loY, zi, ax, r - 0.09, zSgn * hubZ, 0.021);
    rod("susp", ax + 0.14, loY, zi, ax, r - 0.09, zSgn * hubZ, 0.021);
    rod("susp", ax + zSgn * 0.16, upY + 0.02, zi + zSgn * 0.02, ax - 0.01, r - 0.07, zSgn * (hubZ - 0.02), 0.018);
  };
  arm(1, true); arm(-1, true);
  arm(1, false); arm(-1, false);

  /* ---- 鼻锥车号（沿鼻锥曲面弯折的贴片） ---- */
  const numberGeo = (() => {
    const g = new THREE.PlaneGeometry(0.46, 0.24, 12, 6);
    g.rotateZ(Math.PI / 2);    // 贴图上方向 → -x（从车头前上方读正）
    g.rotateX(-Math.PI / 2);   // 平铺，法线朝 +y
    const pos = g.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i) + 2.00, z = pos.getZ(i);
      const r = noseRadiusAt(x);
      pos.setY(i, 0.30 + Math.sqrt(Math.max(0.0004, r * r - z * z)) + 0.004);
      pos.setX(i, x);
    }
    g.computeVertexNormals();
    return g;
  })();

  f1GeoCache = {
    livery: mergeBucket(B.livery),
    dark: mergeBucket(B.dark),
    carbon: mergeBucket(B.carbon),
    susp: mergeBucket(B.susp),
    number: numberGeo,
  };
  return f1GeoCache;
}

/* ================= 程序化贴图 ================= */
// 轮胎侧壁：黑底 + 轮辋圈 + 彩色配方环 + 弧形品牌字（零外部资源）
function tireSidewallTexture() {
  const S = 256;
  const cv = document.createElement("canvas");
  cv.width = S; cv.height = S;
  const c = cv.getContext("2d");
  c.fillStyle = "#0c0d10";
  c.fillRect(0, 0, S, S);
  const cx = S / 2;
  c.strokeStyle = "#3a3d44";
  c.lineWidth = 5;
  c.beginPath(); c.arc(cx, cx, S * 0.27, 0, Math.PI * 2); c.stroke();   // 轮辋圈
  c.strokeStyle = "#c2382f";                                            // 红色软胎配方环
  c.lineWidth = 10;
  c.beginPath(); c.arc(cx, cx, S * 0.40, 0, Math.PI * 2); c.stroke();
  c.fillStyle = "#e8e9ee";
  c.font = "bold 22px Arial, sans-serif";
  c.textAlign = "center";
  c.textBaseline = "middle";
  for (let k = 0; k < 4; k++) {                                         // 品牌字沿弧排布
    const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
    c.save();
    c.translate(cx + Math.cos(a) * S * 0.345, cx + Math.sin(a) * S * 0.345);
    c.rotate(a + Math.PI / 2);
    c.fillText("P Z E R O".split(" ")[k % 5] ?? "", 0, 0);
    c.restore();
  }
  c.strokeStyle = "#1a1b1f";
  c.lineWidth = 3;
  for (let k = 0; k < 16; k++) {                                        // 细放射纹
    const a = (k / 16) * Math.PI * 2;
    c.beginPath();
    c.moveTo(cx + Math.cos(a) * S * 0.30, cx + Math.sin(a) * S * 0.30);
    c.lineTo(cx + Math.cos(a) * S * 0.47, cx + Math.sin(a) * S * 0.47);
    c.stroke();
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

// 胎面：暗色颗粒
function tireTreadTexture() {
  const S = 128;
  const cv = document.createElement("canvas");
  cv.width = S; cv.height = S;
  const c = cv.getContext("2d");
  c.fillStyle = "#131418";
  c.fillRect(0, 0, S, S);
  for (let i = 0; i < 500; i++) {
    c.fillStyle = Math.random() > 0.5 ? "rgba(40,42,48,0.5)" : "rgba(8,9,12,0.5)";
    c.fillRect(Math.random() * S, Math.random() * S, 2 + Math.random() * 4, 1 + Math.random() * 2);
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// 车号贴图（鼻锥上，按号码缓存共享）。画布比例与弯折贴片一致（宽:高 = 0.24:0.46），
// 数字沿车身方向竖排（从车头前上方读正）
const numTexCache = new Map();
function numberTexture(num) {
  const key = String(num ?? "");
  let tex = numTexCache.get(key);
  if (tex) return tex;
  const cv = document.createElement("canvas");
  cv.width = 200; cv.height = 384;
  const c = cv.getContext("2d");
  c.clearRect(0, 0, 200, 384);
  c.textAlign = "center";
  c.textBaseline = "middle";
  // 字号自适应：数字串最宽占 92%，字高（cap≈0.72×字号）不超过画布高 62%
  const fs = Math.min(280, (0.92 * 200) / (0.62 * Math.max(1, key.length)), (0.62 * 384) / 0.72);
  c.font = `bold ${fs}px Arial, sans-serif`;
  c.fillStyle = "#f5f6f8";
  c.strokeStyle = "#101216";
  c.lineWidth = fs * 0.10;
  c.lineJoin = "round";
  c.strokeText(key, 100, 192);
  c.fillText(key, 100, 192);
  tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  numTexCache.set(key, tex);
  return tex;
}

const SHARED = {
  sidewall: tireSidewallTexture(),
  tread: tireTreadTexture(),
};

/* ================= 小米 SU7 真实车模（仅 su7ultra 涂装使用） =================
   public/models/su7/sm_car.gltf（EXT_meshopt + webp 贴图）。
   参考实现确认：车头朝 +x，车轮节点名 Wheel*，其子节点绕本地 z 自转，
   "body"/"body.001" 为车漆面（可换色），模型单位经包围盒归一化。 */
let su7TemplatePromise = null;

function su7ModelUrl() {
  return new URL("models/su7/sm_car.gltf", document.baseURI).href;
}

function normalizeSu7Template(root) {
  // 包围盒归一化：车长 → 5.05m（SU7 实车 4997mm），落地面 y=0，中心对齐原点
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const k = 5.05 / Math.max(0.01, size.x);
  root.scale.setScalar(k);
  box.setFromObject(root);
  const center = box.getCenter(new THREE.Vector3());
  root.position.set(-center.x, -box.min.y, -center.z);
  const wrapped = new THREE.Group();
  wrapped.add(root);
  const parts = { spinNodes: [], bodyMats: [], allMats: [] };
  wrapped.traverse(o => {
    if (o.isMesh) {
      o.castShadow = true;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        m.aoMap = null;                 // 模型无 UV2，参考实现同样置空
        parts.allMats.push(m);
        if (o.name === "body" || o.name === "body.001") parts.bodyMats.push(m);
      }
    }
    if (/^Wheel/.test(o.name)) parts.spinNodes.push(...o.children);
  });
  wrapped.userData.parts = parts;
  return wrapped;
}

function getSu7Template() {
  if (!su7TemplatePromise) {
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    su7TemplatePromise = loader.loadAsync(su7ModelUrl()).then(gltf =>
      normalizeSu7Template(gltf.scene)
    ).catch(err => {
      console.warn("[render3d] SU7 模型加载失败，回退程序化车体", err);
      su7TemplatePromise = null;
      throw err;
    });
  }
  return su7TemplatePromise;
}

// 把模板克隆成一台可独立换色/变透明的实例（材质逐实例克隆，避免幽灵透明度串扰）
function buildSu7Instance(template, car) {
  const inst = template.clone(true);
  const parts = { spinNodes: [], mats: [] };
  inst.traverse(o => {
    if (o.isMesh) {
      o.material = Array.isArray(o.material) ? o.material.map(m => m.clone()) : o.material.clone();
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        parts.mats.push(m);
        // 车漆面 = 名为 Car_body 的材质（外壳多网格共享）；按材质名换色，灼烈黄与 2D 涂装一致
        if (m.name === "Car_body") m.color.set(car.color || "#f5c518");
      }
    }
    if (/^Wheel/.test(o.name)) parts.spinNodes.push(...o.children);
  });
  inst.userData.parts = parts;
  return inst;
}

export function isSu7Car(car) {
  return !!car && car.livery === "su7ultra";
}

/* SU7 真实车模实例：模板异步加载（Meshopt 解码），加载完成前显示灼烈黄占位盒 */
function createSu7Mesh(car) {
  const root = new THREE.Group();
  root.userData = {
    isGlb: true, glbReady: false, spinNodes: [], mats: [],
    spinAngle: 0, lastAlpha: null,
  };
  const placeholder = new THREE.Mesh(
    new THREE.BoxGeometry(5.0, 1.4, 1.96),
    new THREE.MeshStandardMaterial({ color: 0xf5c518, roughness: 0.35, metalness: 0.5 })
  );
  placeholder.position.y = 0.7;
  placeholder.castShadow = true;
  placeholder.name = "placeholder";
  root.add(placeholder);
  getSu7Template().then(tpl => {
    const inst = buildSu7Instance(tpl, car);
    root.add(inst);
    root.userData.glbReady = true;
    root.userData.spinNodes = inst.userData.parts.spinNodes;
    root.userData.mats = inst.userData.parts.mats;
    root.userData.lastAlpha = null;
    const ph = root.getObjectByName("placeholder");
    if (ph) {
      root.remove(ph);
      ph.geometry.dispose();
      ph.material.dispose();
    }
  }).catch(() => { /* 占位盒保留 */ });
  return root;
}

/* ================= 越野卡车 TRAIL RIG（livery === "offroad"） =================
   车体移植自外部「3D 车辆物理模拟器」的程序化越野车：梯形大梁、方盒子车身、
   防滚架、车顶灯排、涉水喉、备胎、螺旋弹簧与大块花纹越野胎（零外部资源）。
   坐标沿用本项目约定：x 向前（+2.7 车头）、y 向上、z 向右（车身右侧）；
   轮位与 physics.js 的落印坐标对齐（±1.75 / ±0.8x），刹车印才能压在轮胎正下方。 */
const TRUCK = {
  wheelRF: 0.42, wheelRR: 0.44,
  frontX: 1.75, rearX: -1.75,
  frontZ: 0.82, rearZ: 0.84,
  frontW: 0.34, rearW: 0.36,
};

export function isOffroadCar(car) {
  return !!car && car.livery === "offroad";
}

// 越野胎：圆柱顶点按 4 段一组向外挤出，交错排布成块状花纹（移植自模拟器）
function knobbyTyreGeometry(R, W, lugs) {
  const g = new THREE.CylinderGeometry(R, R, W, lugs * 4, 5, true);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const ang = Math.atan2(z, x);
    const seg = Math.round((ang + Math.PI) / (2 * Math.PI) * (lugs * 4));
    const row = Math.round((y / W + 0.5) * 5);
    const stag = (row % 2) * 2;
    const knob = ((seg + stag) % 4 < 2) ? 1 : 0;
    let sc = 1 + knob * 0.06;
    if (row === 0 || row === 5) sc *= 0.90;        // 圆化胎肩
    p.setX(i, x * sc); p.setZ(i, z * sc);
  }
  g.computeVertexNormals();
  g.rotateX(Math.PI / 2);                          // 轴向 → z（车身横向）
  return g;
}

// 螺旋弹簧：沿螺旋线生成管状几何（与模拟器的程序化弹簧同构，本项目只做静态展示）
function coilSpringGeometry(height, coilR = 0.058, wireR = 0.011, turns = 6) {
  const steps = turns * 18;
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const a = t * turns * Math.PI * 2;
    pts.push(new THREE.Vector3(Math.cos(a) * coilR, t * height, Math.sin(a) * coilR));
  }
  return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), steps, wireR, 6, false);
}

function truckRod(push, name, x1, y1, z1, x2, y2, z2, r = 0.028) {
  const a = new THREE.Vector3(x1, y1, z1);
  const b = new THREE.Vector3(x2, y2, z2).sub(a);
  const len = b.length();
  const g = new THREE.CylinderGeometry(r, r, len, 8);
  g.applyMatrix4(new THREE.Matrix4().compose(
    new THREE.Vector3(x1, y1, z1).addScaledVector(b, 0.5),
    new THREE.Quaternion().setFromUnitVectors(_up, b.normalize()),
    _one,
  ));
  push(name, g);
}

let truckGeoCache = null;
function truckPartGeometry() {
  if (truckGeoCache) return truckGeoCache;
  const B = { paint: [], paint2: [], dark: [], steel: [], glass: [], lamp: [], tail: [], rubber: [] };
  const push = (name, geo, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) => {
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(x, y, z),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)),
      _one,
    );
    geo.applyMatrix4(m);
    B[name].push(geo);
  };
  const box = (name, sx, sy, sz, x, y, z, rx = 0, ry = 0, rz = 0) =>
    push(name, new THREE.BoxGeometry(sx, sy, sz), x, y, z, rx, ry, rz);
  const rod = (name, x1, y1, z1, x2, y2, z2, r) =>
    truckRod(push, name, x1, y1, z1, x2, y2, z2, r);

  /* ---- 梯形大梁 + 横梁 + 前后防撞梁 + 前护板 ---- */
  for (const z of [-0.62, 0.62]) box("dark", 4.90, 0.14, 0.16, 0, 0.46, z);
  for (const x of [-1.90, -0.70, 0.60, 1.90]) box("dark", 0.14, 0.12, 1.30, x, 0.46, 0);
  box("dark", 0.16, 0.24, 1.96, 2.56, 0.72, 0);
  box("dark", 0.14, 0.22, 1.90, -2.40, 0.70, 0);
  box("steel", 1.10, 0.06, 1.10, 2.00, 0.38, 0);

  /* ---- 后货厢 + 驾驶舱 + 车顶 + 前机盖 ---- */
  box("paint2", 1.85, 0.52, 1.92, -1.30, 0.82, 0);
  box("dark", 1.86, 0.06, 1.94, -1.30, 1.09, 0);          // 厢口围板
  box("paint", 2.55, 0.40, 1.86, 0.55, 0.76, 0);
  box("paint", 1.45, 0.62, 1.78, 0.85, 1.14, 0);
  box("paint2", 1.38, 0.09, 1.66, 0.82, 1.50, 0);
  box("paint", 1.00, 0.26, 1.70, 1.95, 0.94, 0);

  /* ---- 前风挡 / 侧窗 / 后窗 ---- */
  push("glass", new THREE.BoxGeometry(0.05, 0.50, 1.50), 1.60, 1.16, 0, 0, 0, 0.34);
  for (const z of [-0.895, 0.895]) push("glass", new THREE.BoxGeometry(0.95, 0.30, 0.04), 0.92, 1.24, z);
  push("glass", new THREE.BoxGeometry(0.04, 0.30, 1.46), 0.13, 1.24, 0, 0, 0, -0.22);

  /* ---- 进气格栅 + 大灯 + 尾灯 ---- */
  box("dark", 0.06, 0.30, 1.30, 2.44, 0.96, 0);
  for (const z of [-0.62, 0.62]) {
    push("dark", new THREE.CylinderGeometry(0.165, 0.165, 0.05, 20), 2.45, 1.02, z, 0, 0, Math.PI / 2);
    push("lamp", new THREE.CylinderGeometry(0.14, 0.14, 0.07, 20), 2.48, 1.02, z, 0, 0, Math.PI / 2);
    box("tail", 0.05, 0.16, 0.26, -2.34, 0.96, z * 1.15);
  }

  /* ---- 轮眉 + 挡泥板 + 侧踏板 ---- */
  for (const x of [TRUCK.frontX, TRUCK.rearX]) {
    for (const z of [-1, 1]) {
      box("paint2", 1.06, 0.10, 0.34, x, 0.94, z * 1.00);
      box("paint2", 1.06, 0.18, 0.05, x, 0.82, z * 1.16);
      box("dark", 0.48, 0.24, 0.04, x - 0.55, 0.58, z * 1.04);
    }
  }
  for (const z of [-1.02, 1.02]) box("dark", 3.30, 0.10, 0.10, 0, 0.56, z);

  /* ---- 防滚架（座舱后方 → 货厢） + 车顶行李架 + 灯排 ---- */
  for (const z of [-0.78, 0.78]) {
    rod("steel", 0.18, 0.92, z, 0.20, 1.52, z * 0.97, 0.035);
    rod("steel", 0.18, 1.52, z * 0.97, -0.65, 1.18, z, 0.030);
  }
  rod("steel", 0.19, 1.52, -0.76, 0.19, 1.52, 0.76, 0.030);
  box("dark", 1.20, 0.05, 1.52, 0.82, 1.575, 0);
  for (const z of [-0.79, 0.79]) box("dark", 1.20, 0.09, 0.06, 0.82, 1.60, z);
  box("dark", 0.10, 0.12, 1.10, 1.40, 1.66, 0);
  for (let i = 0; i < 4; i++) {
    push("lamp", new THREE.CylinderGeometry(0.05, 0.05, 0.05, 12), 1.46, 1.66, -0.36 + i * 0.24, 0, 0, Math.PI / 2);
  }

  /* ---- 前灯护杠 + 涉水喉 + 排气 ---- */
  for (const z of [-0.82, 0.82]) rod("steel", 2.58, 0.62, z, 2.58, 1.16, z, 0.030);
  rod("steel", 2.58, 1.16, -0.82, 2.58, 1.16, 0.82, 0.030);
  rod("dark", 1.52, 0.98, 0.97, 1.52, 1.70, 0.97, 0.052);
  rod("dark", 1.52, 1.70, 0.97, 1.28, 1.70, 0.97, 0.052);
  rod("steel", -2.05, 0.55, 0.42, -2.42, 0.80, 0.55, 0.045);

  /* ---- 备胎（货厢上平放） + 固定带 ---- */
  push("rubber", new THREE.CylinderGeometry(0.42, 0.42, 0.30, 20), -1.45, 1.28, 0);
  push("steel", new THREE.CylinderGeometry(0.26, 0.26, 0.34, 16), -1.45, 1.28, 0);
  box("dark", 0.55, 0.05, 0.10, -1.45, 1.44, 0);

  /* ---- 前后桥（横向车轴，随车轮视觉定位） ---- */
  push("steel", new THREE.CylinderGeometry(0.06, 0.06, 1.68, 10),
    TRUCK.frontX, TRUCK.wheelRF, 0, Math.PI / 2, 0, 0);
  push("steel", new THREE.CylinderGeometry(0.06, 0.06, 1.72, 10),
    TRUCK.rearX, TRUCK.wheelRR, 0, Math.PI / 2, 0, 0);

  truckGeoCache = {
    paint: mergeBucket(B.paint),
    paint2: mergeBucket(B.paint2),
    dark: mergeBucket(B.dark),
    steel: mergeBucket(B.steel),
    glass: mergeBucket(B.glass),
    lamp: mergeBucket(B.lamp),
    tail: mergeBucket(B.tail),
    rubber: mergeBucket(B.rubber),
    coil: coilSpringGeometry(0.50),
  };
  return truckGeoCache;
}

// 单只越野车轮：块状花纹胎 + 胎侧 + 轮辋 + 辐条 + 轮毂盖（axis = z）
const truckWheelGeoCache = new Map();
function truckWheelGeometry(R, W) {
  const key = R + ":" + W;
  let hit = truckWheelGeoCache.get(key);
  if (hit) return hit;
  const side = new THREE.CylinderGeometry(R * 0.86, R * 0.78, 0.02, 26);
  side.rotateX(Math.PI / 2);
  const rim = new THREE.CylinderGeometry(R * 0.60, R * 0.60, W * 0.66, 20);
  rim.rotateX(Math.PI / 2);
  const face = new THREE.CylinderGeometry(R * 0.58, R * 0.58, 0.03, 20);
  face.rotateX(Math.PI / 2);
  const cap = new THREE.CylinderGeometry(0.06, 0.06, 0.05, 12);
  cap.rotateX(Math.PI / 2);
  hit = {
    tyre: knobbyTyreGeometry(R, W, 9),
    side, rim, face,
    spoke: new THREE.BoxGeometry(0.06, R * 1.05, 0.04),
    cap, W,
  };
  truckWheelGeoCache.set(key, hit);
  return hit;
}

function makeTruckWheel(R, W, tyreMat, rimMat, steelMat) {
  const g = new THREE.Group();
  const geo = truckWheelGeometry(R, W);
  const tyre = new THREE.Mesh(geo.tyre, tyreMat);
  tyre.castShadow = true;
  g.add(tyre);
  for (const s of [-1, 1]) {
    const wall = new THREE.Mesh(geo.side, tyreMat);
    wall.position.z = s * (W / 2 - 0.012);
    g.add(wall);
  }
  g.add(new THREE.Mesh(geo.rim, rimMat));
  const face = new THREE.Mesh(geo.face, rimMat);
  face.position.z = W * 0.36;
  g.add(face);
  for (let i = 0; i < 6; i++) {
    const sp = new THREE.Mesh(geo.spoke, rimMat);
    sp.position.z = W * 0.30;
    sp.rotation.z = i * Math.PI / 6;
    g.add(sp);
  }
  const cap = new THREE.Mesh(geo.cap, steelMat);
  cap.position.z = W * 0.40;
  g.add(cap);
  return g;
}

/* 越野卡车视觉体：材质逐车独立（幽灵透明度 / 涂装换色互不影响），几何全局共享 */
function createTruckMesh(car) {
  const baseColor = new THREE.Color(car.color || "#c2551d");
  const paint = new THREE.MeshStandardMaterial({ color: baseColor, metalness: 0.45, roughness: 0.45 });
  const paint2 = new THREE.MeshStandardMaterial({
    color: baseColor.clone().multiplyScalar(0.62), metalness: 0.4, roughness: 0.55,
  });
  const dark = new THREE.MeshStandardMaterial({ color: 0x24282d, metalness: 0.55, roughness: 0.55 });
  const steel = new THREE.MeshStandardMaterial({ color: 0x9aa4ad, metalness: 0.9, roughness: 0.30 });
  const glass = new THREE.MeshStandardMaterial({
    color: 0x8fd2ff, metalness: 0.1, roughness: 0.08,
    transparent: true, opacity: 0.5, side: THREE.DoubleSide,
  });
  glass.userData.baseAlpha = 0.5;                 // 幽灵淡出时在此基础上再乘透明度
  const lamp = new THREE.MeshStandardMaterial({
    color: 0xfff6dc, emissive: 0xffeab4, emissiveIntensity: 1.2, metalness: 0.1, roughness: 0.2,
  });
  const tailMat = new THREE.MeshStandardMaterial({ color: 0x5a1010, emissive: 0x000000, roughness: 0.4 });
  const springMat = new THREE.MeshStandardMaterial({ color: 0xc4ccd4, metalness: 0.9, roughness: 0.25 });
  const rubberMat = new THREE.MeshStandardMaterial({ color: 0x1d2022, metalness: 0.02, roughness: 0.95 });
  const rimMat = new THREE.MeshStandardMaterial({ color: 0x8e979f, metalness: 0.9, roughness: 0.3 });

  const geo = truckPartGeometry();
  const root = new THREE.Group();
  const bodyMesh = (g, mat) => {
    const m = new THREE.Mesh(g, mat);
    m.castShadow = true;
    root.add(m);
    return m;
  };
  bodyMesh(geo.paint, paint);
  bodyMesh(geo.paint2, paint2);
  bodyMesh(geo.dark, dark);
  bodyMesh(geo.steel, steel);
  bodyMesh(geo.glass, glass);
  bodyMesh(geo.lamp, lamp);
  bodyMesh(geo.tail, tailMat);
  bodyMesh(geo.rubber, rubberMat);

  // 四角螺旋弹簧（静态长度，保留越野车的外露悬挂特征）
  for (const x of [TRUCK.frontX, TRUCK.rearX]) {
    for (const z of [-0.74, 0.74]) {
      const coil = new THREE.Mesh(geo.coil, springMat);
      coil.position.set(x, 0.44, z);
      coil.castShadow = true;
      root.add(coil);
    }
  }

  // 四轮：steer 组（前轮转向）→ spin 组（滚动）→ 越野胎
  const wheels = { steer: [], spin: [] };
  const mkWheel = (x, z, front) => {
    const R = front ? TRUCK.wheelRF : TRUCK.wheelRR;
    const W = front ? TRUCK.frontW : TRUCK.rearW;
    const steer = new THREE.Group();
    steer.position.set(x, R, z);
    const spin = new THREE.Group();
    spin.add(makeTruckWheel(R, W, rubberMat, rimMat, steel));
    steer.add(spin);
    root.add(steer);
    wheels.steer.push({ group: steer, front });
    wheels.spin.push(spin);
  };
  mkWheel(TRUCK.frontX, TRUCK.frontZ, true);
  mkWheel(TRUCK.frontX, -TRUCK.frontZ, true);
  mkWheel(TRUCK.rearX, TRUCK.rearZ, false);
  mkWheel(TRUCK.rearX, -TRUCK.rearZ, false);

  // 货厢两侧车号（从车侧读正）
  const numMat = new THREE.MeshBasicMaterial({
    map: numberTexture(car.number), transparent: true, side: THREE.FrontSide,
  });
  for (const sgn of [1, -1]) {
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(0.28, 0.54), numMat);
    plate.position.set(-1.30, 0.80, sgn * 0.966);
    if (sgn < 0) plate.rotation.y = Math.PI;
    root.add(plate);
  }

  const allMats = [paint, paint2, dark, steel, glass, lamp, tailMat, springMat, rubberMat, rimMat, numMat];
  root.userData = {
    wheels, brakeMat: tailMat, allMats,
    spinAngle: 0, lastAlpha: null, wheelR: TRUCK.wheelRR,
  };
  return root;
}

/* 创建一辆车的 3D 视觉体（不进入场景，由 renderer 统一管理） */
export function createCarMesh(car) {
  if (isSu7Car(car)) return createSu7Mesh(car);
  if (isOffroadCar(car)) return createTruckMesh(car);

  const baseColor = new THREE.Color(car.color || "#ff3b3b");
  const livery = new THREE.MeshStandardMaterial({
    color: baseColor, metalness: 0.55, roughness: 0.32,
  });
  const liveryDark = new THREE.MeshStandardMaterial({
    color: baseColor.clone().multiplyScalar(0.5), metalness: 0.5, roughness: 0.4,
  });
  const carbon = new THREE.MeshStandardMaterial({ color: 0x17181d, metalness: 0.35, roughness: 0.55 });
  const suspMat = new THREE.MeshStandardMaterial({ color: 0x3d414a, metalness: 0.6, roughness: 0.4 });
  const brakeMat = new THREE.MeshStandardMaterial({ color: 0x2a0808, emissive: 0x000000, roughness: 0.6 });

  const geo = f1PartGeometry();
  const root = new THREE.Group();

  const bodyMesh = (g, mat) => {
    const m = new THREE.Mesh(g, mat);
    m.castShadow = true;
    root.add(m);
    return m;
  };
  bodyMesh(geo.livery, livery);
  bodyMesh(geo.dark, liveryDark);
  bodyMesh(geo.carbon, carbon);
  bodyMesh(geo.susp, suspMat);

  // 头盔（独立材质：随机偏色区分车手）+ 护目镜在 carbon 内；尾部雨灯（刹车点亮）
  const helmetMat = new THREE.MeshStandardMaterial({
    color: baseColor.clone().offsetHSL(0.5, 0.1, 0.1), metalness: 0.2, roughness: 0.3,
  });
  const helmet = bodyMesh(G.helmet, helmetMat);
  helmet.position.set(0.52, 0.59, 0);
  const rainLight = new THREE.Mesh(G.rainLight, brakeMat);
  rainLight.position.set(-2.62, 0.24, 0);
  rainLight.castShadow = true;
  root.add(rainLight);

  // 鼻锥车号贴片
  const numMat = new THREE.MeshBasicMaterial({
    map: numberTexture(car.number), transparent: true, side: THREE.FrontSide,
  });
  root.add(new THREE.Mesh(geo.number, numMat));

  // 四轮：steer 组（前轮转向）→ spin 组（滚动）→ 轮胎/轮辋
  const tread = SHARED.tread, sidewall = SHARED.sidewall;
  const wheels = { steer: [], spin: [] };
  const allMats = [livery, liveryDark, carbon, suspMat, brakeMat, helmetMat, numMat];
  const mkWheel = (x, z, front) => {
    const r = front ? WHEEL_R_F : WHEEL_R_R;
    const w = front ? WHEEL_FRONT_W : WHEEL_REAR_W;
    const tireGeo = front ? G.tireF : G.tireR;
    const rimGeo = G.rim;
    const steer = new THREE.Group();
    steer.position.set(x, r, z);
    const spin = new THREE.Group();
    const tireMat = new THREE.MeshStandardMaterial({ map: tread, roughness: 0.92, metalness: 0.05 });
    const wallMat = new THREE.MeshStandardMaterial({ map: sidewall, roughness: 0.85, metalness: 0.05 });
    const rimMat = new THREE.MeshStandardMaterial({ color: 0xb9bfc9, metalness: 0.85, roughness: 0.3 });
    const tire = new THREE.Mesh(tireGeo, [tireMat, wallMat, wallMat]);
    tire.rotation.x = Math.PI / 2;
    tire.castShadow = true;
    const rimA = new THREE.Mesh(rimGeo, rimMat);
    rimA.rotation.x = Math.PI / 2;
    rimA.position.z = w / 2 + 0.012;
    const rimB = rimA.clone();
    rimB.position.z = -rimA.position.z;
    spin.add(tire, rimA, rimB);
    steer.add(spin);
    root.add(steer);
    wheels.steer.push({ group: steer, front });
    wheels.spin.push(spin);
    allMats.push(tireMat, wallMat, rimMat);
  };
  mkWheel(WHEEL_FRONT_X, WHEEL_FRONT_Z, true);
  mkWheel(WHEEL_FRONT_X, -WHEEL_FRONT_Z, true);
  mkWheel(WHEEL_REAR_X, WHEEL_REAR_Z, false);
  mkWheel(WHEEL_REAR_X, -WHEEL_REAR_Z, false);

  root.userData.wheels = wheels;
  root.userData.brakeMat = brakeMat;
  root.userData.allMats = allMats;
  root.userData.spinAngle = 0;
  root.userData.lastAlpha = null;
  return root;
}

/* 每帧同步：位置 / 朝向 / 车轮滚动与转向 / 刹车灯 / 幽灵透明度 */
export function syncCarMesh(root, car, dt) {
  root.position.set(car.x, car.roadY || 0, car.y);
  // 赛道纵向剖面姿态（YXZ 欧拉：yaw ∘ pitch ∘ roll，小角近似）：
  //   rotation.z = 沿车头坡度 → 正 = 车头上仰（Rz 正把 +x（车头）抬向 +y）
  //   rotation.x = -横坡 → roadRoll>0 表示 +nor 侧（车身局部 +z）更高，需负 rx 抬起 +z
  root.rotation.order = "YXZ";
  root.rotation.z = Math.atan(car.roadPitch || 0);
  root.rotation.x = -Math.atan(car.roadRoll || 0);
  root.rotation.y = -car.angle;

  const u = root.userData;
  const ghostA = car.retired || car.ghostHidden ? 0 : (car.ghostAlpha == null ? 1 : Math.max(0, car.ghostAlpha));

  // SU7 真实车模分支：车轮自转 + 幽灵透明度（无转向节动画，参考实现同款处理）
  if (u.isGlb) {
    u.spinAngle -= (car.speed * dt) / 0.3;
    for (const n of u.spinNodes) n.rotation.z = u.spinAngle;
    root.position.y = (car.roadY || 0) + (car.shake > 0.2 ? Math.random() * car.shake * 0.01 : 0);
    if (u.glbReady && ghostA !== u.lastAlpha) {
      root.visible = ghostA > 0.02;
      for (const m of u.mats) {
        m.transparent = ghostA < 0.999;
        m.opacity = ghostA;
      }
      u.lastAlpha = ghostA;
    }
    return;
  }

  const spin = (Math.abs(car.speed) * dt) / (u.wheelR || WHEEL_R_R) * (car.speed < 0 ? 1 : -1);
  u.spinAngle = (u.spinAngle + spin) % (Math.PI * 2);
  for (const s of u.wheels.spin) s.rotation.z = u.spinAngle;
  // car.steer 经物理平滑后实际范围 ±0.55，直接映射只有 ±10°，追尾/远景机位几乎看不出
  // 转向；视觉增益放大到满舵 ±27°（街机可读角度，不影响物理）。
  const steerVis = -car.steer * 0.85;
  for (const s of u.wheels.steer) if (s.front) s.group.rotation.y = steerVis;
  const braking = !!(car.braking || (car.inBrake > 0 && Math.abs(car.speed) > 0.5));
  u.brakeMat.emissive.setHex(braking ? 0xff2020 : 0x000000);
  root.position.y = (car.roadY || 0) + (car.shake > 0.2 ? Math.random() * car.shake * 0.01 : 0);

  if (ghostA !== u.lastAlpha) {
    root.visible = ghostA > 0.02;
    for (const m of u.allMats) {
      const base = m.userData.baseAlpha ?? 1;   // 玻璃等半透明材质的固有透明度
      m.transparent = ghostA < 0.999 || base < 1;
      m.opacity = ghostA * base;
    }
    u.lastAlpha = ghostA;
  }
}

/* 释放一辆车的独立材质（共享几何、贴图与模板不释放） */
export function disposeCarMesh(root) {
  const u = root.userData;
  if (u.isGlb) {
    (u.mats || []).forEach(m => m && m.dispose());
    return;
  }
  (u.allMats || []).forEach(m => m && m.dispose());
}
