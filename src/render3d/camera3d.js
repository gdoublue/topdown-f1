// 3D 追尾镜头：三种机位（追尾 / 转播远景 / 俯瞰），指数平滑 + 速度感 FOV
// 焦点复用 2D cam.x/cam.y（已含前瞻与平滑），小地图视野框也从这里同步
import * as THREE from "three";
import { cam } from "../game/camera.js";
import { clamp } from "../utils.js";
import { terrainAt } from "../track/geometry.js";

export const CAMERA_MODES = [
  { id: "chase", label: "追尾视角", dist: 13.5, height: 5.4, look: 11, fov: 60 },
  { id: "far",   label: "转播远景", dist: 25,   height: 11.5, look: 7,  fov: 54 },
  { id: "top",   label: "俯瞰视角", dist: -3,   height: 148,  look: 6,  fov: 50 },
];
let modeIdx = 0;

const _pos = new THREE.Vector3();
const _look = new THREE.Vector3();
let _heading = 0;
let _initialized = false;
let _lastFov = 0;
let camera3D = null;

export function init3DCamera(camObj) {
  camera3D = camObj;
}

function shortestArc(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

export function cycleCameraMode() {
  modeIdx = (modeIdx + 1) % CAMERA_MODES.length;
  return CAMERA_MODES[modeIdx].label;
}

export function getCamera3DLabel() {
  return CAMERA_MODES[modeIdx].label;
}

// 焦点车切换 / 重开时由外部调用：镜头立即吸附，不做跨场平滑
export function snapCamera3D(car) {
  const ry = car.roadY || 0;
  const m = CAMERA_MODES[modeIdx];
  const floor = terrainAt ? terrainAt(cam.x, cam.y) + 1.2 : -Infinity;
  _pos.set(cam.x, Math.max(ry + m.height, floor), cam.y);
  _look.set(car.x, ry + 1.1, car.y);
  _heading = car.angle;
  _initialized = true;
}

export function update3DCamera(car, dt) {
  if (!camera3D) return;
  const m = CAMERA_MODES[modeIdx];
  const zoom = clamp(cam.zoomScale || 1, 0.4, 3);
  const s = 1 / Math.pow(zoom, 0.75);   // 手动视野缩放：越大越近

  // 焦点大幅跳变（切车 / 重开 / 在线瞬移）：直接吸附
  const jump = Math.hypot(cam.x - _look.x, cam.y - _look.z);
  if (!_initialized || jump > 60) {
    snapCamera3D(car);
  }

  // 航向平滑（最短弧插值），避免过弯时镜头横甩
  _heading += shortestArc(car.angle - _heading) * Math.min(1, dt * 6.5);
  const hx = Math.cos(_heading), hz = Math.sin(_heading);

  const roadY = car.roadY || 0;
  const want = new THREE.Vector3(
    cam.x - hx * m.dist * s,
    roadY + m.height * s,                 // 相对路面抬高：真实 100m 落差下不悬空/贴地
    cam.y - hz * m.dist * s
  );
  _pos.lerp(want, Math.min(1, dt * 4.5));
  const camFloor = terrainAt ? terrainAt(_pos.x, _pos.z) + 1.2 : -Infinity;
  _pos.y = Math.max(_pos.y, roadY + 1.15, camFloor);

  const wantLook = new THREE.Vector3(
    cam.x + hx * m.look * s,
    roadY + 1.1,
    cam.y + hz * m.look * s
  );
  _look.lerp(wantLook, Math.min(1, dt * 7));

  // 草地/碰撞抖动
  if (car.shake > 0.2) {
    camera3D.position.set(
      _pos.x + (Math.random() - 0.5) * car.shake * 0.12,
      _pos.y + (Math.random() - 0.5) * car.shake * 0.05,
      _pos.z + (Math.random() - 0.5) * car.shake * 0.12
    );
  } else {
    camera3D.position.copy(_pos);
  }
  camera3D.lookAt(_look);

  // 速度感 FOV：追尾机位随速度轻微拉广
  const spd = Math.abs(car.speed);
  const fovTarget = m.fov + (m.id === "chase" ? 9 * Math.min(1, spd / 95) : 0);
  if (Math.abs(fovTarget - _lastFov) > 0.05) {
    camera3D.fov += (fovTarget - camera3D.fov) * Math.min(1, dt * 3);
    if (Math.abs(fovTarget - camera3D.fov) < 0.05) camera3D.fov = fovTarget;
    camera3D.updateProjectionMatrix();
    _lastFov = camera3D.fov;
  }

  // 同步 2D cam.view（小地图视野框）：以镜头焦点为中心的近似方框
  const box = (m.id === "top" ? 250 : 175) / zoom;
  cam.view.x = cam.x - box / 2;
  cam.view.y = cam.y - box / 2;
  cam.view.w = box;
  cam.view.h = box;
}
