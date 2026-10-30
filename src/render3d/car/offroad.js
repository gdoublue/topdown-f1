// 越野卡车 TRAIL RIG（livery === "offroad"）：梯形大梁、方盒子车身、防滚架、车顶灯排、
// 涉水喉、备胎、螺旋弹簧与大块花纹越野胎（零外部资源）。
// 坐标沿用项目约定：x 向前（+2.7 车头）、y 向上、z 向右（车身右侧）；
// 轮位与 physics.js 的落印坐标对齐（±1.75 / ±0.8x），刹车印才能压在轮胎正下方。
import * as THREE from "three";
import { _up, _one, mergeBucket, numberTexture, GROUND } from "./shared.js";

export const id = "offroad";

const TRUCK = {
  wheelRF: 0.42, wheelRR: 0.44,
  frontX: 1.75, rearX: -1.75,
  frontZ: 0.82, rearZ: 0.84,
  frontW: 0.34, rearW: 0.36,
};


export function isOffroadCar(car) {
  return !!car && car.livery === "offroad";
}

export function match(car) {
  return isOffroadCar(car);
}

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
    if (row === 0 || row === 5) sc *= 0.90;
    p.setX(i, x * sc); p.setZ(i, z * sc);
  }
  g.computeVertexNormals();
  g.rotateX(Math.PI / 2);
  return g;
}

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
  box("dark", 1.86, 0.06, 1.94, -1.30, 1.09, 0);
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
    push("dark", new THREE.CylinderGeometry(0.175, 0.175, 0.08, 20), 2.49, 1.02, z, 0, 0, Math.PI / 2);
    push("lamp", new THREE.CylinderGeometry(0.15, 0.15, 0.10, 20), 2.545, 1.02, z, 0, 0, Math.PI / 2);
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

  /* ---- 防滚架 + 车顶行李架 + 灯排 ---- */
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

  /* ---- 备胎 + 固定带 ---- */
  push("rubber", new THREE.CylinderGeometry(0.42, 0.42, 0.30, 20), -1.45, 1.28, 0);
  push("steel", new THREE.CylinderGeometry(0.26, 0.26, 0.34, 16), -1.45, 1.28, 0);
  box("dark", 0.55, 0.05, 0.10, -1.45, 1.44, 0);

  /* ---- 前后桥 ---- */
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
  glass.userData.baseAlpha = 0.5;
  const lamp = new THREE.MeshStandardMaterial({
    color: 0xfff6dc, emissive: 0xffeab4, emissiveIntensity: 2.0, metalness: 0.1, roughness: 0.15,
  });
  const tailMat = new THREE.MeshStandardMaterial({ color: 0x5a1010, emissive: 0x000000, roughness: 0.4 });
  const springMat = new THREE.MeshStandardMaterial({ color: 0xc4ccd4, metalness: 0.9, roughness: 0.25 });
  const rubberMat = new THREE.MeshStandardMaterial({ color: 0x1d2022, metalness: 0.02, roughness: 0.95 });
  const rimMat = new THREE.MeshStandardMaterial({ color: 0x8e979f, metalness: 0.9, roughness: 0.3 });

  const geo = truckPartGeometry();
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const bodyMesh = (g, mat) => {
    const m = new THREE.Mesh(g, mat);
    m.castShadow = true;
    body.add(m);
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

  const coils = [];
  for (const x of [TRUCK.frontX, TRUCK.rearX]) {
    for (const z of [-0.74, 0.74]) {
      const coil = new THREE.Mesh(geo.coil, springMat);
      coil.position.set(x, 0.44, z);
      coil.castShadow = true;
      root.add(coil);
      coils.push({ mesh: coil, x, z });
    }
  }

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

  const numMat = new THREE.MeshBasicMaterial({
    map: numberTexture(car.number), transparent: true, side: THREE.FrontSide,
  });
  for (const sgn of [1, -1]) {
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(0.28, 0.54), numMat);
    plate.position.set(-1.30, 0.80, sgn * 0.966);
    if (sgn < 0) plate.rotation.y = Math.PI;
    body.add(plate);
  }

  const allMats = [paint, paint2, dark, steel, glass, lamp, tailMat, springMat, rubberMat, rimMat, numMat];
  const aoMat = new THREE.MeshBasicMaterial({
    map: GROUND.contactShadow,
    transparent: true,
    opacity: 0.72,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  aoMat.userData.baseAlpha = 0.72;
  allMats.push(aoMat);
  const aoShadow = new THREE.Mesh(GROUND.contactShadowGeo, aoMat);
  aoShadow.position.y = 0.005;
  aoShadow.renderOrder = 1;
  root.add(aoShadow);

  root.userData = {
    wheels, brakeMat: tailMat, allMats,
    body, coils, roll: 0, pitch: 0, kerbLift: 0, aoShadow,
    spinAngle: 0, lastAlpha: null, wheelR: TRUCK.wheelRR,
  };
  return root;
}

export function create(car) {
  return createTruckMesh(car);
}

// 越野卡车悬挂：车身相对车轮侧倾、俯仰与四角弹簧压缩
export function sync(root, car, ctx) {
  const u = root.userData;
  const dt = ctx.dt ?? 0.016;
  // 车身相对车轮侧倾、俯仰与四角弹簧压缩
  if (u.body) {
    const latG = Math.max(0, car.gLat || 0);
    const rollTarget = -Math.sign(car.steer || 0) * Math.min(0.14, latG * 0.07);
    const pitchTarget = Math.max(-0.055, Math.min(0.045, (car.accel || 0) * 0.004));
    const k = Math.min(1, dt * 8);
    u.roll += (rollTarget - u.roll) * k;
    u.pitch += (pitchTarget - u.pitch) * k;
    u.body.rotation.x = u.roll;
    u.body.rotation.z = u.pitch;
    u.body.position.y = -Math.min(0.035, Math.abs(u.roll) * 0.12 + Math.abs(u.pitch) * 0.12);
    for (const c of u.coils) {
      const dy = u.pitch * c.x - u.roll * c.z;
      c.mesh.scale.y = Math.max(0.6, Math.min(1.3, 1 + dy / 0.5));
    }
  }
}

/* 释放一辆车的独立材质（共享几何与贴图不释放） */
export function dispose(root) {
  (root.userData.allMats || []).forEach(m => m && m.dispose());
}
