// 3D 渲染总入口：接管 #cv 画布（WebGL），物理/AI/HUD/联网零改动
// 车辆视觉体按 car 对象实例缓存，比赛重开/换车自动清理
import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { onTrackChange } from "../track/geometry.js";
import { race } from "../game/race.js";
import { buildTrackScene, createSky, setGantryLights, setMaxAnisotropy, updateSkyDome, SKY_HORIZON } from "./track3d.js";
import { createCarMesh, syncCarMesh, disposeCarMesh } from "./car3d.js";
import { initEffects3D, updateEffects3D } from "./effects3d.js";
import { init3DCamera, update3DCamera, cycleCameraMode, getCamera3DLabel, CAMERA_MODES, setTopPitchDeg, useTopCameraMode } from "./camera3d.js";

let renderer = null;
let scene = null;
let camera = null;
let sun = null;
let carGroup = null;
let aiLine = null;
let aiTargetRing = null;

const carVisuals = new Map();   // car 对象 → THREE.Group

export function init3D(canvas) {
  renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(1);   // 分辨率由 renderQuality 动态机制经 resize3D 控制
  // 兜底：任何被远平面裁剪的像素（如天穹缝隙）露出的应是雾色而非默认黑色
  renderer.setClearColor(SKY_HORIZON);
  renderer.shadowMap.enabled = true;
  // PCFSoftShadowMap 在新版 three 已移除（会被强制降级并打印警告）；
  // 用 PCF + light.shadow.radius 做柔边，效果一致且可控
  renderer.shadowMap.type = THREE.PCFShadowMap;
  // 胶片感：ACES 色调映射 + 环境反射（车漆 PBR 需要 scene.environment）
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(60, 1, 0.3, 3200);
  init3DCamera(camera);

  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.55;

  setMaxAnisotropy(renderer.capabilities.getMaxAnisotropy());
  sun = createSky(scene);
  buildTrackScene(scene);
  initEffects3D(scene);

  carGroup = new THREE.Group();
  scene.add(carGroup);

  // AI 探测线（视图面板开关）：焦点车 → 前瞻目标点
  const lineGeo = new THREE.BufferGeometry();
  lineGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(6), 3).setUsage(THREE.DynamicDrawUsage));
  aiLine = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: 0x00ffb4, transparent: true, opacity: 0.5 }));
  aiLine.visible = false;
  aiLine.frustumCulled = false;
  scene.add(aiLine);
  const ringGeo = new THREE.TorusGeometry(1.1, 0.09, 6, 20);
  aiTargetRing = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0x00ffb4, transparent: true, opacity: 0.8 }));
  aiTargetRing.rotation.x = -Math.PI / 2;
  aiTargetRing.visible = false;
  scene.add(aiTargetRing);

  // 赛道上下文任何切换（选赛道 / 在线下发 / 练习房）都自动重建 3D 场景
  onTrackChange(() => buildTrackScene(scene));

  // 调试句柄（控制台：__r3d.scene / __r3d.camera）
  window.__r3d = {
    get scene() { return scene; },
    get camera() { return camera; },
    get renderer() { return renderer; },
  };

  return renderer;
}

export function resize3D(backingW, backingH) {
  if (!renderer) return;
  renderer.setSize(backingW, backingH, false);
  camera.aspect = backingW / Math.max(1, backingH);
  camera.updateProjectionMatrix();
}

// 画质档位：低档关阴影（渲染负载大头），其余档位保持
export function applyQuality3D(mode) {
  if (!renderer) return;
  renderer.shadowMap.enabled = mode !== "low";
  scene.traverse(o => {
    if (o.isMesh || o.isInstancedMesh) o.material && (o.material.needsUpdate = true);
  });
}

export function cycleCamera3D() {
  return cycleCameraMode();
}

export function setTopPitch3D(v) {
  return setTopPitchDeg(v);
}

export function switchToTopCamera3D() {
  return useTopCameraMode();
}

export { getCamera3DLabel, getTopPitchDeg } from "./camera3d.js";

/* 主渲染：每帧由 main.js 的 draw() 调用 */
export function render3D(cars, focusIndex, dt, opts = {}) {
  if (!renderer) return;
  const focusCar = cars[focusIndex] || cars[0];

  // ---- 车辆视觉体同步（创建 / 更新 / 清理退场的车） ----
  const seen = new Set();
  for (const car of cars) {
    if (!car) continue;
    seen.add(car);
    let v = carVisuals.get(car);
    if (!v) {
      v = createCarMesh(car);
      carVisuals.set(car, v);
      carGroup.add(v);
    }
    syncCarMesh(v, car, dt);
  }
  if (carVisuals.size > seen.size) {
    for (const [car, v] of carVisuals) {
      if (!seen.has(car)) {
        carGroup.remove(v);
        disposeCarMesh(v);
        carVisuals.delete(car);
      }
    }
  }

  // ---- AI 探测线 ----
  const inp = opts.aiTarget;
  if (opts.showAILine && inp && inp.targetX != null && focusCar) {
    const ry = focusCar.roadY || 0;
    const p = aiLine.geometry.getAttribute("position");
    p.setXYZ(0, focusCar.x, ry + 0.5, focusCar.y);
    p.setXYZ(1, inp.targetX, ry + 0.5, inp.targetY);
    p.needsUpdate = true;
    aiLine.material.color.set(focusCar.color || "#00ffb4");
    aiTargetRing.material.color.copy(aiLine.material.color);
    aiTargetRing.position.set(inp.targetX, ry + 0.14, inp.targetY);
    aiLine.visible = true;
    aiTargetRing.visible = true;
  } else {
    aiLine.visible = false;
    aiTargetRing.visible = false;
  }

  // ---- 镜头（2D cam 已由主循环 updateCamera 推进） ----
  if (focusCar) {
    update3DCamera(focusCar, dt);
    const ry = focusCar.roadY || 0;
    // 阴影光源跟随焦点车（含真实赛道高程，正交阴影盒 ±95m）
    sun.position.set(focusCar.x + 130, ry + 210, focusCar.y + 75);
    sun.target.position.set(focusCar.x, ry, focusCar.y);
    sun.target.updateMatrixWorld();
    // 天穹跟随相机 XZ：保证穹壁视距恒定 2400m，永不被远平面裁剪（黑球根治）
    updateSkyDome(focusCar.x, focusCar.y);
  }

  // 发车龙门架灯组与 race.lights 联动（倒计时逐组点亮，灯灭发车）
  setGantryLights(race.state === "countdown" ? (race.lights | 0) : 0);

  updateEffects3D(cars, dt);
  renderer.render(scene, camera);
}
