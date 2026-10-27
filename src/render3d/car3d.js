// 程序化 F1 赛车 3D 网格：全部用 three.js 基础几何拼装（F1 车型零外部资源）
// 小米 SU8 Ultra（livery === "su7ultra"）使用真实 SU7 车模：
// public/models/su7/（EXT_meshopt glTF，来源 github.com/Yechuanjie/xiaomi-su7）
// 车头朝局部 +x；挂载到场景时 rotation.y = -car.angle（2D 画布角度 → three 坐标）
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";

// 车身几何与 2D 物理包围盒一致：长 5.6m（车头 +2.8 / 车尾 -2.8）、宽 2.0m
const WHEEL_R_F = 0.33, WHEEL_R_R = 0.36;
const WHEEL_FRONT_X = 1.72, WHEEL_REAR_X = -1.72;
const WHEEL_FRONT_Z = 0.74, WHEEL_REAR_Z = 0.76;
const WHEEL_FRONT_W = 0.31, WHEEL_REAR_W = 0.42;

/* ================= 共享几何（所有车复用） ================= */
// 俯视轮廓（x 向前，y 为侧向 → 旋转后映射到 z）
function monocoqueGeometry() {
  const s = new THREE.Shape();
  s.moveTo(-2.72, -0.88);
  s.lineTo(-2.72, 0.88);
  s.quadraticCurveTo(-1.3, 0.66, 0.15, 0.52);
  s.quadraticCurveTo(0.85, 0.42, 1.45, 0.2);
  s.lineTo(2.55, 0.15);
  s.quadraticCurveTo(2.82, 0.13, 2.82, 0);
  s.quadraticCurveTo(2.82, -0.13, 2.55, -0.15);
  s.lineTo(1.45, -0.2);
  s.quadraticCurveTo(0.85, -0.42, 0.15, -0.52);
  s.quadraticCurveTo(-1.3, -0.66, -2.72, -0.88);
  const geo = new THREE.ExtrudeGeometry(s, {
    depth: 0.26, bevelEnabled: true, bevelThickness: 0.06, bevelSize: 0.06, bevelSegments: 2,
  });
  geo.rotateX(Math.PI / 2);            // 平铺到 xz 平面，厚度朝 -y
  geo.translate(0, 0.42, 0);           // 底面 0.10（离地净高），顶面 0.48 —— 高于刹车印平面
  return geo;
}

// 侧视轮廓（引擎盖脊线 + 空气箱，x 向前 y 向上，挤出为横向厚度）
function engineSpineGeometry() {
  const s = new THREE.Shape();
  s.moveTo(-2.45, 0.24);
  s.quadraticCurveTo(-1.6, 0.42, -0.7, 0.5);
  s.quadraticCurveTo(-0.1, 0.56, 0.25, 0.62);   // 空气箱顶
  s.quadraticCurveTo(0.8, 0.5, 1.35, 0.34);
  s.lineTo(1.5, 0.2);
  s.lineTo(-2.3, 0.2);
  const geo = new THREE.ExtrudeGeometry(s, {
    depth: 0.4, bevelEnabled: true, bevelThickness: 0.05, bevelSize: 0.05, bevelSegments: 2,
  });
  geo.translate(0, 0.16, -0.25);       // 抬到底盘上方，居中横向
  return geo;
}

const G = {
  mono: monocoqueGeometry(),
  spine: engineSpineGeometry(),
  floor: new THREE.BoxGeometry(4.7, 0.07, 1.95),
  frontWingMain: new THREE.BoxGeometry(0.62, 0.035, 1.95),
  frontWingFlap: new THREE.BoxGeometry(0.4, 0.03, 1.7),
  fwEndplate: new THREE.BoxGeometry(0.62, 0.26, 0.04),
  rearWingMain: new THREE.BoxGeometry(0.42, 0.045, 1.48),
  rearWingFlap: new THREE.BoxGeometry(0.3, 0.035, 1.4),
  rwEndplate: new THREE.BoxGeometry(0.6, 0.44, 0.035),
  rwPillar: new THREE.BoxGeometry(0.4, 0.4, 0.06),
  beamWing: new THREE.BoxGeometry(0.3, 0.03, 1.1),
  halo: new THREE.TorusGeometry(0.4, 0.045, 8, 18, Math.PI),
  haloPillar: new THREE.CylinderGeometry(0.035, 0.045, 0.36, 6),
  helmet: new THREE.SphereGeometry(0.155, 14, 12),
  visor: new THREE.BoxGeometry(0.12, 0.07, 0.22),
  brakeLight: new THREE.BoxGeometry(0.05, 0.13, 0.16),
  susp: new THREE.CylinderGeometry(0.025, 0.025, 1, 5),
  tireF: new THREE.CylinderGeometry(WHEEL_R_F, WHEEL_R_F, WHEEL_FRONT_W, 22),
  tireR: new THREE.CylinderGeometry(WHEEL_R_R, WHEEL_R_R, WHEEL_REAR_W, 22),
  rim: new THREE.CylinderGeometry(WHEEL_R_F * 0.55, WHEEL_R_F * 0.55, 0.03, 14),
  noseNum: new THREE.PlaneGeometry(0.42, 0.24),
};

/* ================= 程序化贴图 ================= */
// 轮胎侧壁：黑底 + 轮辋圈 + 彩色配方环（零外部资源）
function tireSidewallTexture() {
  const S = 128;
  const cv = document.createElement("canvas");
  cv.width = S; cv.height = S;
  const c = cv.getContext("2d");
  c.fillStyle = "#0c0d10";
  c.fillRect(0, 0, S, S);
  const cx = S / 2;
  c.strokeStyle = "#3a3d44";
  c.lineWidth = 3;
  c.beginPath(); c.arc(cx, cx, S * 0.27, 0, Math.PI * 2); c.stroke();   // 轮辋圈
  c.strokeStyle = "#c2382f";                                            // 红色软胎配方环
  c.lineWidth = 7;
  c.beginPath(); c.arc(cx, cx, S * 0.38, 0, Math.PI * 2); c.stroke();
  c.strokeStyle = "#1a1b1f";
  c.lineWidth = 2;
  for (let k = 0; k < 12; k++) {                                        // 细放射纹
    const a = (k / 12) * Math.PI * 2;
    c.beginPath();
    c.moveTo(cx + Math.cos(a) * S * 0.3, cx + Math.sin(a) * S * 0.3);
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

// 车号贴图（鼻锥上）
function numberTexture(num) {
  const cv = document.createElement("canvas");
  cv.width = 128; cv.height = 72;
  const c = cv.getContext("2d");
  c.clearRect(0, 0, 128, 72);
  c.fillStyle = "#f5f6f8";
  c.font = "bold 52px Arial, sans-serif";
  c.textAlign = "center";
  c.textBaseline = "middle";
  c.strokeStyle = "#101216";
  c.lineWidth = 6;
  c.strokeText(String(num ?? ""), 64, 38);
  c.fillText(String(num ?? ""), 64, 38);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const SHARED = {
  sidewall: tireSidewallTexture(),
  tread: tireTreadTexture(),
};

function box(geo, mat, x, y, z, opts = {}) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  if (opts.rx) m.rotation.x = opts.rx;
  if (opts.ry) m.rotation.y = opts.ry;
  if (opts.rz) m.rotation.z = opts.rz;
  m.castShadow = true;
  return m;
}

function suspensionLink(x1, y1, z1, x2, y2, z2, mat) {
  const len = Math.hypot(x2 - x1, y2 - y1, z2 - z1);
  const m = new THREE.Mesh(G.susp, mat);
  m.position.set((x1 + x2) / 2, (y1 + y2) / 2, (z1 + z2) / 2);
  m.lookAt(x2, y2, z2);
  m.rotateX(Math.PI / 2);
  m.scale.set(1, len, 1);
  m.castShadow = true;
  return m;
}

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

/* 创建一辆车的 3D 视觉体（不进入场景，由 renderer 统一管理） */
export function createCarMesh(car) {
  if (isSu7Car(car)) return createSu7Mesh(car);
  const baseColor = new THREE.Color(car.color || "#ff3b3b");
  const livery = new THREE.MeshStandardMaterial({
    color: baseColor, metalness: 0.55, roughness: 0.32,
  });
  const liveryDark = new THREE.MeshStandardMaterial({
    color: baseColor.clone().multiplyScalar(0.5), metalness: 0.5, roughness: 0.4,
  });
  const carbon = new THREE.MeshStandardMaterial({ color: 0x17181d, metalness: 0.35, roughness: 0.55 });
  const suspMat = new THREE.MeshStandardMaterial({ color: 0x33363d, metalness: 0.6, roughness: 0.4 });
  const brakeMat = new THREE.MeshStandardMaterial({ color: 0x2a0808, emissive: 0x000000, roughness: 0.6 });

  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);

  // 底板 + 单壳车身 + 引擎盖脊线（车体底面 ≥0.10，刹车印 0.058 从下方通过）
  const floor = box(G.floor, carbon, 0, 0.13, 0);
  body.add(floor);
  body.add(box(G.mono, livery, 0, 0, 0));
  body.add(box(G.spine, liveryDark, -0.25, 0.12, 0));

  // 前翼：主翼片 + 上层翼片 + 端板
  body.add(box(G.frontWingMain, liveryDark, 2.62, 0.16, 0));
  body.add(box(G.frontWingFlap, carbon, 2.42, 0.25, 0, { rx: -0.18 }));
  body.add(box(G.fwEndplate, carbon, 2.58, 0.23, 0.96));
  body.add(box(G.fwEndplate, carbon, 2.58, 0.23, -0.96));

  // 尾翼：主翼 + DRS 翼 + 端板 + 梁翼 + 支柱
  body.add(box(G.rearWingMain, liveryDark, -2.5, 0.9, 0));
  body.add(box(G.rearWingFlap, carbon, -2.6, 1.02, 0, { rx: 0.22 }));
  body.add(box(G.rwEndplate, livery, -2.52, 0.8, 0.74));
  body.add(box(G.rwEndplate, livery, -2.52, 0.8, -0.74));
  body.add(box(G.beamWing, carbon, -2.45, 0.5, 0));
  body.add(box(G.rwPillar, carbon, -2.42, 0.55, 0));

  // Halo（半环 + 前柱）与头盔（带护目镜）
  const halo = new THREE.Mesh(G.halo, carbon);
  halo.position.set(0.3, 0.68, 0);
  halo.rotation.x = -Math.PI / 2 * 0.42;
  halo.rotation.z = Math.PI;                 // 开口朝前下
  halo.castShadow = true;
  body.add(halo);
  body.add(box(G.haloPillar, carbon, 0.64, 0.58, 0));
  const helmetMat = new THREE.MeshStandardMaterial({
    color: baseColor.clone().offsetHSL(0.5, 0.1, 0.1), metalness: 0.2, roughness: 0.3,
  });
  const helmet = new THREE.Mesh(G.helmet, helmetMat);
  helmet.position.set(0.14, 0.64, 0);
  helmet.castShadow = true;
  body.add(helmet);
  body.add(box(G.visor, carbon, 0.28, 0.65, 0));

  // 尾部雨灯（刹车点亮）
  const brakeLight = new THREE.Mesh(G.brakeLight, brakeMat);
  brakeLight.position.set(-2.74, 0.5, 0);
  body.add(brakeLight);

  // 鼻锥车号贴片（单壳顶面 0.48 之上）
  const numMat = new THREE.MeshBasicMaterial({
    map: numberTexture(car.number), transparent: true, side: THREE.FrontSide,
  });
  const numPlane = new THREE.Mesh(G.noseNum, numMat);
  numPlane.position.set(1.95, 0.485, 0);
  numPlane.rotation.x = -Math.PI / 2;
  numPlane.rotation.z = -Math.PI / 2;
  body.add(numPlane);

  // 四轮：steer 组（前轮转向）→ spin 组（滚动）→ 轮胎/轮辋
  const tread = SHARED.tread, sidewall = SHARED.sidewall;
  const wheels = { steer: [], spin: [] };
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
    // 双叉臂悬臂（锚点随车体抬高）
    const hubY = r;
    body.add(suspensionLink(x * 0.86, 0.26, Math.sign(z) * 0.3, x, hubY + 0.08, z * 0.98, suspMat));
    body.add(suspensionLink(x * 0.86, 0.16, Math.sign(z) * 0.3, x, hubY - 0.06, z * 0.98, suspMat));
    root.userData._mats = root.userData._mats || [];
    root.userData._mats.push(tireMat, wallMat, rimMat);
  };
  mkWheel(WHEEL_FRONT_X, WHEEL_FRONT_Z, true);
  mkWheel(WHEEL_FRONT_X, -WHEEL_FRONT_Z, true);
  mkWheel(WHEEL_REAR_X, WHEEL_REAR_Z, false);
  mkWheel(WHEEL_REAR_X, -WHEEL_REAR_Z, false);

  root.userData.wheels = wheels;
  root.userData.brakeMat = brakeMat;
  root.userData.liveryMats = [livery, liveryDark, helmetMat, numMat];
  root.userData.spinAngle = 0;
  root.userData.lastAlpha = null;
  return root;
}

/* 每帧同步：位置 / 朝向 / 车轮滚动与转向 / 刹车灯 / 幽灵透明度 */
export function syncCarMesh(root, car, dt) {
  root.position.set(car.x, 0, car.y);
  root.rotation.y = -car.angle;

  const u = root.userData;
  const ghostA = car.retired || car.ghostHidden ? 0 : (car.ghostAlpha == null ? 1 : Math.max(0, car.ghostAlpha));

  // SU7 真实车模分支：车轮自转 + 幽灵透明度（无转向节动画，参考实现同款处理）
  if (u.isGlb) {
    u.spinAngle -= (car.speed * dt) / 0.3;
    for (const n of u.spinNodes) n.rotation.z = u.spinAngle;
    root.position.y = car.shake > 0.2 ? Math.random() * car.shake * 0.01 : 0;
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

  const spin = (Math.abs(car.speed) * dt) / WHEEL_R_R * (car.speed < 0 ? 1 : -1);
  u.spinAngle = (u.spinAngle + spin) % (Math.PI * 2);
  for (const s of u.wheels.spin) s.rotation.z = u.spinAngle;
  const steerVis = -car.steer * 0.32;
  for (const s of u.wheels.steer) if (s.front) s.group.rotation.y = steerVis;
  const braking = !!(car.braking || (car.inBrake > 0 && Math.abs(car.speed) > 0.5));
  u.brakeMat.emissive.setHex(braking ? 0xff2020 : 0x000000);
  root.position.y = car.shake > 0.2 ? Math.random() * car.shake * 0.01 : 0;

  const a = car.retired || car.ghostHidden ? 0 : (car.ghostAlpha == null ? 1 : Math.max(0, car.ghostAlpha));
  if (a !== u.lastAlpha) {
    root.visible = a > 0.02;
    const mats = [...u.liveryMats, ...u._mats];
    for (const m of mats) {
      m.transparent = a < 0.999;
      m.opacity = a;
    }
    u.lastAlpha = a;
  }
}

/* 释放一辆车的独立材质（共享几何与模板不释放） */
export function disposeCarMesh(root) {
  const u = root.userData;
  if (u.isGlb) {
    (u.mats || []).forEach(m => m && m.dispose());
    return;
  }
  [...(u.liveryMats || []), ...(u._mats || [])].forEach(m => m && m.dispose());
}
