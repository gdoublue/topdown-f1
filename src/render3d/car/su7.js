// 小米 SU8 Ultra 真实车模（livery === "su7ultra"）：
// public/models/su7/sm_car.gltf（EXT_meshopt + webp 贴图，来源 github.com/Yechuanjie/xiaomi-su7）
// 车头朝 +x，车轮节点名 Wheel*，其子节点绕本地 z 自转，"body"/"body.001" 为车漆面（可换色）。
// 转向：给前轮 Wheel 节点外包一层 pivot，绕轮毂中心的竖直轴转动（与仰望 U9 同一套转向手感）。
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import {
  glowPositions, createBrakeGlow, updateBrakeGlow, disposeBrakeGlow,
} from "./shared.js";

export const id = "su7";

const DEFAULT_WHEEL_R = 0.3;
const STEER_GAIN = 0.85;      // 与 F1 / 仰望 U9 一致：car.steer(±0.55) × 0.85 ≈ 满舵 ±27°
const STEER_SMOOTH = 18;      // 转向视觉插值速率（1/s）
// 灯光材质：Car_ight 同时用于头灯与尾灯（带自发光贴图），只能按网格位置区分
const LIGHT_MAT = /ight/i;
const BRAKE_GLOW = 6.0;       // 刹车时尾灯自发光放大倍数（ACES 下需要拉高才够亮）
const BRAKE_SMOOTH = 12;      // 尾灯亮灭插值速率（1/s）

export function isSu7Car(car) {
  return !!car && car.livery === "su7ultra";
}

export function match(car) {
  return isSu7Car(car);
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
        m.aoMap = null;
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

function buildSu7Instance(template, car) {
  const inst = template.clone(true);
  const parts = { spinNodes: [], mats: [] };
  inst.traverse(o => {
    if (o.isMesh) {
      o.material = Array.isArray(o.material) ? o.material.map(m => m.clone()) : o.material.clone();
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        parts.mats.push(m);
        if (m.name === "Car_body") m.color.set(car.color || "#f5c518");
      }
    }
    if (/^Wheel/.test(o.name)) parts.spinNodes.push(...o.children);
  });
  inst.userData.parts = parts;
  return inst;
}

/* 前轴是一个含左右两轮的合并网格（Wheel.001 = 前轴、Wheel.002 = 后轴），
   要让两轮各自绕本侧轮毂中心转向，先按三角形质心的 z 正负把索引拆成两半
   （顶点属性缓冲区共享，不复制顶点）。 */
function splitAxlePair(mesh) {
  const geo = mesh.geometry;
  const pos = geo.attributes.position;
  const index = geo.index ? geo.index.array : null;
  const triCount = Math.floor((index ? index.length : pos.count) / 3);
  const sides = [[], []];
  for (let t = 0; t < triCount; t++) {
    const a = index ? index[t * 3] : t * 3;
    const b = index ? index[t * 3 + 1] : t * 3 + 1;
    const c = index ? index[t * 3 + 2] : t * 3 + 2;
    const zc = pos.getZ(a) + pos.getZ(b) + pos.getZ(c);
    (zc >= 0 ? sides[0] : sides[1]).push(a, b, c);
  }
  const halves = [];
  for (const ind of sides) {
    if (!ind.length) continue;
    const g = new THREE.BufferGeometry();
    for (const name of Object.keys(geo.attributes)) g.setAttribute(name, geo.attributes[name]);
    g.setIndex(ind);
    const m = new THREE.Mesh(g, mesh.material);
    m.name = mesh.name;
    m.castShadow = true;
    m.applyMatrix4(mesh.matrixWorld);   // 保持原网格的摆放
    halves.push(m);
  }
  return halves;
}

/* 轮组装配：前轴拆成左右两半，各自套一个"转向 + 自转"双轴 pivot（原点 = 轮毂中心）；
   后轴左右轮合并网格绕公共轮轴自转即正确，保持原样。
   装配期间临时把 root 变换归零：包围盒与 attach 都以 root 局部坐标计算，
   否则车模异步加载完成时 root 已被摆到赛道上，轮心会被整体平移。 */
function rigWheels(root, inst) {
  const savedP = root.position.clone();
  const savedQ = root.quaternion.clone();
  const savedS = root.scale.clone();
  root.position.set(0, 0, 0);
  root.quaternion.identity();
  root.scale.set(1, 1, 1);
  root.updateMatrixWorld(true);

  const wheels = [];
  inst.traverse(o => { if (o.isMesh && /^Wheel/i.test(o.name)) wheels.push(o); });

  const steerNodes = [];
  const spinNodes = [];
  const box = new THREE.Box3();
  let radiusSum = 0, radiusCount = 0;

  for (const w of wheels) {
    box.setFromObject(w);
    const isFront = box.getCenter(new THREE.Vector3()).x > 0;   // 车头朝 +x
    const halves = isFront ? splitAxlePair(w) : [];
    if (!halves.length) {
      spinNodes.push(w);
      radiusSum += Math.abs(box.max.y - box.min.y) / 2;
      radiusCount++;
      continue;
    }
    w.parent && w.parent.remove(w);
    for (const half of halves) {
      box.setFromObject(half);
      const pivot = new THREE.Group();
      pivot.rotation.order = "YXZ";        // 先转向（y）再滚动（z）
      pivot.position.copy(box.getCenter(new THREE.Vector3()));
      root.add(pivot);
      pivot.attach(half);
      steerNodes.push(pivot);
      spinNodes.push(pivot);
      radiusSum += Math.abs(box.max.y - box.min.y) / 2;
      radiusCount++;
    }
  }

  // 尾灯：Car_ight 材质前后灯共用（材质逐网格克隆），按网格位置只取车尾（-X）那一组
  const brakeMats = [];
  const rearLightBox = new THREE.Box3();
  inst.traverse(o => {
    if (!o.isMesh) return;
    const ms = Array.isArray(o.material) ? o.material : [o.material];
    if (!ms.some(m => LIGHT_MAT.test(m.name || ""))) return;
    box.setFromObject(o);
    if (box.getCenter(new THREE.Vector3()).x >= -0.2) return;
    rearLightBox.union(box);
    for (const m of ms) {
      if (!LIGHT_MAT.test(m.name || "")) continue;
      m.userData.baseEmissiveIntensity = m.emissiveIntensity;
      brakeMats.push(m);
    }
  });

  root.position.copy(savedP);
  root.quaternion.copy(savedQ);
  root.scale.copy(savedS);
  root.updateMatrixWorld(true);

  // 尾灯辉光 + 车尾红色点光源（把光洒到车后路面）
  const glow = createBrakeGlow(root, glowPositions(rearLightBox), {
    color: 0xff3a12, size: 1.05, lightPower: 5.0,
  });

  return {
    steerNodes, spinNodes, brakeMats, glow,
    radius: radiusCount ? radiusSum / radiusCount : 0,
  };
}

function createSu7Mesh(car) {
  const root = new THREE.Group();
  root.userData = {
    isGlb: true, glbReady: false, spinNodes: [], steerNodes: [], mats: [],
    brakeMats: [], brakeGlowObj: null, spinAngle: 0, steerVis: 0, brakeGlow: 0,
    lastAlpha: null, wheelR: DEFAULT_WHEEL_R,
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
    root.updateMatrixWorld(true);
    const rig = rigWheels(root, inst);
    root.userData.glbReady = true;
    root.userData.spinNodes = rig.spinNodes;
    root.userData.steerNodes = rig.steerNodes;
    root.userData.brakeMats = rig.brakeMats;
    root.userData.brakeGlowObj = rig.glow;
    root.userData.wheelR = rig.radius || DEFAULT_WHEEL_R;
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

export function create(car) {
  return createSu7Mesh(car);
}

// glTF 车模：车轮子节点绕本地 z 滚动，前轮外包 pivot 绕轮毂中心竖直轴转向
// （幽灵透明度由 shared.applyGhost 统一处理）
export function sync(root, car, ctx) {
  const u = root.userData;
  const dt = ctx.dt ?? 0.016;

  // 滚动：按轮胎实测半径换算，避免固定 0.3 造成的滚动速度偏差
  const r = u.wheelR || DEFAULT_WHEEL_R;
  u.spinAngle = (u.spinAngle - ((car.speed || 0) * dt) / r) % (Math.PI * 2);
  for (const n of u.spinNodes) n.rotation.z = u.spinAngle;

  // 转向：前轮绕轮毂中心的竖直轴，与 F1 / 仰望 U9 同增益并做轻度插值
  const target = -(car.steer || 0) * STEER_GAIN;
  u.steerVis = (u.steerVis || 0) + (target - (u.steerVis || 0)) * Math.min(1, dt * STEER_SMOOTH);
  for (const p of u.steerNodes || []) p.rotation.y = u.steerVis;

  // 尾灯：在原有自发光贴图基础上提高强度并由白转红，松刹车平滑回落
  const glowTarget = ctx.braking ? 1 : 0;
  u.brakeGlow = (u.brakeGlow || 0) + (glowTarget - (u.brakeGlow || 0)) * Math.min(1, dt * BRAKE_SMOOTH);
  if (u.brakeMats && u.brakeMats.length) {
    const g = u.brakeGlow;
    for (const m of u.brakeMats) {
      m.emissiveIntensity = (m.userData.baseEmissiveIntensity || 1) * (1 + g * BRAKE_GLOW);
      m.emissive.setRGB(1, 1 - 0.78 * g, 1 - 0.9 * g);
    }
  }
  updateBrakeGlow(u.brakeGlowObj, u.brakeGlow, ctx.ghostA ?? 1);
}

/* 释放车模实例化出来的独立材质与尾灯辉光（共享模板与贴图不释放） */
export function dispose(root) {
  (root.userData.mats || []).forEach(m => m && m.dispose());
  disposeBrakeGlow(root.userData.brakeGlowObj);
  root.userData.brakeGlowObj = null;
}
