// 仰望 U9 Xtreme 真实车模（livery === "yangwang"）：
// public/models/u9/u9.glb（Sketchfab 导出，5.3MB，12 张贴图全部内嵌；
// 用到 KHR_materials_clearcoat / _specular / _transmission）。
// 原始坐标：+Z 车头、+Y 向上、整车长度约 0.045 单位（根节点 0.01 缩放 + -90° 轴变换），
// 加载后统一旋转到项目约定（+X 车头、+Y 向上、+Z 车身右侧）并按车长归一化。
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import {
  glowPositions, createBrakeGlow, updateBrakeGlow, disposeBrakeGlow,
} from "./shared.js";

export const id = "yangwang";

export function isYangwangCar(car) {
  return !!car && car.livery === "yangwang";
}

export function match(car) {
  return isYangwangCar(car);
}

const MODEL_URL = "models/u9/u9.glb";
const TARGET_LEN = 5.05;          // 车长归一化目标（米，与 SU7 车模一致）
const BODY_MAT = "MAT_BYD_YangWang_U9_Carpaint";
// 随车轮转动的件：轮胎+轮毂（Hub）、轮辐（Wheel）、刹车盘（Disk）；
// MAT_Tire_Brake（卡钳）保持静止
const SPIN_MAT = /Hub|Wheel|Disk/i;
// 轮胎本体材质：用它自己的包围盒定轮心，保证自转/转向严格绕轮毂中心
const TIRE_MAT = /Hub/i;
// 灯光材质：MAT_Lights 同时用于头灯、尾灯与灯带，只能按网格位置区分车头/车尾
const LIGHT_MAT = /Lights?/i;
const DEFAULT_WHEEL_R = 0.33;
const STEER_GAIN = 0.85;          // 与 F1 一致：car.steer(±0.55) × 0.85 ≈ 满舵 ±27°
const STEER_SMOOTH = 18;          // 转向视觉插值速率（1/s）
const BRAKE_GLOW = 9.0;           // 刹车时尾灯自发光强度（ACES 下需要拉高才够亮）
const BRAKE_SMOOTH = 12;          // 尾灯亮灭插值速率（1/s）

let templatePromise = null;

function modelUrl() {
  return new URL(MODEL_URL, document.baseURI).href;
}

// 归一化：旋转到 +X 车头 → 按车长缩放 → 车底落在 y=0、车体中心对齐原点
function normalizeTemplate(scene) {
  const yaw = new THREE.Group();
  yaw.rotation.y = Math.PI / 2;   // 模型 +Z（车头）→ 项目 +X
  yaw.add(scene);
  const holder = new THREE.Group();
  holder.add(yaw);

  holder.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(holder);
  const size = box.getSize(new THREE.Vector3());
  holder.scale.setScalar(TARGET_LEN / Math.max(1e-4, size.x));

  holder.updateMatrixWorld(true);
  box.setFromObject(holder);
  const center = box.getCenter(new THREE.Vector3());
  holder.position.set(-center.x, -box.min.y, -center.z);
  return holder;
}

function loadTemplate() {
  if (!templatePromise) {
    const loader = new GLTFLoader();
    templatePromise = loader.loadAsync(modelUrl())
      .then(gltf => normalizeTemplate(gltf.scene))
      .catch(err => {
        console.warn("[render3d] 仰望 U9 模型加载失败，回退占位车体", err);
        templatePromise = null;
        throw err;
      });
  }
  return templatePromise;
}

/* 实例化：材质逐车克隆（车漆换色 / 幽灵淡出需要独立材质），
   轮胎、轮辐、刹车盘按四个象限聚成轮组，每组套一个"转向 + 自转"双轴 pivot：
     - pivot.rotation.y = 转向角（绕轮毂中心的竖直轴转动，仅前轮）
     - pivot.rotation.z = 滚动角（绕车轴自转）
   pivot 原点取轮胎本体的包围盒中心，保证自转/转向都严格绕轮毂中心；
   卡钳（MAT_Tire_Brake）留在原位不随轮转。 */
function buildInstance(root, template, car) {
  const inst = template.clone(true);
  root.add(inst);
  // 车模是异步加载的，此时 root 可能已被摆到赛道上：装配期间把 root 变换归零，
  // 让包围盒与 attach 全部按 root 局部坐标计算，轮心才不会被整车的世界位移带偏
  const savedP = root.position.clone();
  const savedQ = root.quaternion.clone();
  const savedS = root.scale.clone();
  root.position.set(0, 0, 0);
  root.quaternion.identity();
  root.scale.set(1, 1, 1);
  root.updateMatrixWorld(true);

  const mats = [];
  const wheelMeshes = [];
  const brakeMats = [];
  const rearLightBox = new THREE.Box3();
  const box = new THREE.Box3();
  inst.traverse(o => {
    if (!o.isMesh) return;
    o.castShadow = true;
    const src = Array.isArray(o.material) ? o.material : [o.material];
    const cloned = src.map(m => m.clone());
    o.material = Array.isArray(o.material) ? cloned : cloned[0];
    for (const m of cloned) {
      mats.push(m);
      if (m.name === BODY_MAT) m.color.set(car.color || "#f59e0b");
    }
    if (cloned.some(m => SPIN_MAT.test(m.name || ""))) wheelMeshes.push(o);
    // 尾灯：材质逐网格克隆，按网格在车尾（-X）挑出尾灯组，免得头灯一起亮
    if (cloned.some(m => LIGHT_MAT.test(m.name || ""))) {
      box.setFromObject(o);
      if (box.getCenter(new THREE.Vector3()).x < -0.2) {
        rearLightBox.union(box);
        for (const m of cloned) {
          if (!LIGHT_MAT.test(m.name || "")) continue;
          m.emissive.setHex(0xff2008);
          m.emissiveIntensity = 0;
          brakeMats.push(m);
        }
      }
    }
  });

  const c = new THREE.Vector3();
  const clusters = new Map();
  for (const mesh of wheelMeshes) {
    box.setFromObject(mesh);
    box.getCenter(c);
    const key = (c.x >= 0 ? "F" : "R") + (c.z >= 0 ? "L" : "R");
    let cl = clusters.get(key);
    if (!cl) {
      cl = { all: null, tire: null, meshes: [] };
      clusters.set(key, cl);
    }
    cl.all = cl.all ? cl.all.union(box) : box.clone();
    const ms = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    if (ms.some(m => TIRE_MAT.test(m.name || ""))) {
      cl.tire = cl.tire ? cl.tire.union(box) : box.clone();
    }
    cl.meshes.push(mesh);
  }

  const spinNodes = [];
  const steerNodes = [];
  let radiusSum = 0;
  for (const cl of clusters.values()) {
    const hubBox = cl.tire || cl.all;   // 轮心以轮胎本体为准，轮辐外凸不影响圆心
    const pivot = new THREE.Group();
    pivot.rotation.order = "YXZ";       // 先转向（y）再滚动（z）
    pivot.position.copy(hubBox.getCenter(new THREE.Vector3()));
    if (pivot.position.x > 0) steerNodes.push(pivot);   // +X 为车头 → 前轮参与转向
    root.add(pivot);
    for (const mesh of cl.meshes) pivot.attach(mesh);
    spinNodes.push(pivot);
    radiusSum += Math.abs(hubBox.max.y - hubBox.min.y) / 2;
  }

  // 尾灯辉光 + 车尾红色点光源（把光洒到车后路面，配合自发光更像真车）
  const brakeGlow = createBrakeGlow(root, glowPositions(rearLightBox), {
    color: 0xff3a12, size: 1.0, lightPower: 5.0,
  });

  const u = root.userData;
  u.glbReady = true;
  u.spinNodes = spinNodes;
  u.steerNodes = steerNodes;
  u.mats = mats;
  u.brakeMats = brakeMats;
  u.brakeGlowObj = brakeGlow;
  u.wheelR = spinNodes.length ? radiusSum / spinNodes.length : DEFAULT_WHEEL_R;
  u.lastAlpha = null;

  // 还原 root 变换（装配期间临时归零）
  root.position.copy(savedP);
  root.quaternion.copy(savedQ);
  root.scale.copy(savedS);
  root.updateMatrixWorld(true);
}

export function create(car) {
  const root = new THREE.Group();
  root.userData = {
    isGlb: true, glbReady: false, spinNodes: [], steerNodes: [], mats: [],
    brakeMats: [], brakeGlowObj: null, spinAngle: 0, steerVis: 0, brakeGlow: 0,
    lastAlpha: null, wheelR: DEFAULT_WHEEL_R,
  };
  const placeholder = new THREE.Mesh(
    new THREE.BoxGeometry(5.0, 1.15, 2.0),
    new THREE.MeshStandardMaterial({ color: 0xf59e0b, roughness: 0.35, metalness: 0.5 })
  );
  placeholder.position.y = 0.575;
  placeholder.castShadow = true;
  placeholder.name = "placeholder";
  root.add(placeholder);

  loadTemplate().then(tpl => {
    buildInstance(root, tpl, car);
    const ph = root.getObjectByName("placeholder");
    if (ph) {
      root.remove(ph);
      ph.geometry.dispose();
      ph.material.dispose();
    }
  }).catch(() => { /* 占位盒保留 */ });

  return root;
}

// glTF 车模：轮组自转 + 前轮转向（幽灵透明度由 shared.applyGhost 统一处理）
export function sync(root, car, ctx) {
  const u = root.userData;
  const dt = ctx.dt ?? 0.016;

  // 滚动：绕车轴（pivot.z），按轮胎实际半径换算
  const r = u.wheelR || DEFAULT_WHEEL_R;
  u.spinAngle = (u.spinAngle - ((car.speed || 0) * dt) / r) % (Math.PI * 2);
  for (const p of u.spinNodes) p.rotation.z = u.spinAngle;

  // 转向：绕轮毂中心的竖直轴（pivot.y），与 F1 同一增益并做轻度插值
  const target = -(car.steer || 0) * STEER_GAIN;
  u.steerVis = (u.steerVis || 0) + (target - (u.steerVis || 0)) * Math.min(1, dt * STEER_SMOOTH);
  for (const p of u.steerNodes) p.rotation.y = u.steerVis;

  // 尾灯：踩刹车时点亮（红光亮起/熄灭带插值，避免一闪一闪）
  const glowTarget = ctx.braking ? 1 : 0;
  u.brakeGlow = (u.brakeGlow || 0) + (glowTarget - (u.brakeGlow || 0)) * Math.min(1, dt * BRAKE_SMOOTH);
  if (u.brakeMats && u.brakeMats.length) {
    for (const m of u.brakeMats) m.emissiveIntensity = u.brakeGlow * BRAKE_GLOW;
  }
  updateBrakeGlow(u.brakeGlowObj, u.brakeGlow, ctx.ghostA ?? 1);
}

/* 释放车模实例化出来的独立材质与尾灯辉光（共享模板、几何与贴图不释放） */
export function dispose(root) {
  (root.userData.mats || []).forEach(m => m && m.dispose());
  disposeBrakeGlow(root.userData.brakeGlowObj);
  root.userData.brakeGlowObj = null;
}
