// 3D 特效：刹车痕（GPU 顶点池，平铺路面）、草地尘土/锁胎白烟（点精灵）与 F1 底板钛合金摩擦火花（速度拉伸光轨）
// 数据源复用 2D 的 fx.skids / fx.dust 数组（轮胎印的触发与高度由 physics / netrace 写入）
import * as THREE from "three";
import { skids, dust, addDust } from "../game/effects.js";
import { sampleGroundMeshY } from "./track/props.js";

const MAX_SKIDS = 9000;   // 与 effects.js 的池子上限一致
const MAX_DUST = 240;
const MAX_SPARKS = 320;   // F1 底板钛合金火花粒子上限

/* ================= 刹车痕：单个大 BufferGeometry，每帧重写可见段 ================= */
const skidGeo = new THREE.BufferGeometry();
{
  const pos = new Float32Array(MAX_SKIDS * 4 * 3);
  const alpha = new Float32Array(MAX_SKIDS * 4);
  const side = new Float32Array(MAX_SKIDS * 4);
  const along = new Float32Array(MAX_SKIDS * 4);
  const seed = new Float32Array(MAX_SKIDS * 4);
  const idx = new Uint32Array(MAX_SKIDS * 6);
  for (let i = 0; i < MAX_SKIDS; i++) {
    const b = i * 4, j = i * 6;
    // 两个三角形都必须朝上（+y）：顶点序 a+n, b+n, b-n, a-n
    idx[j] = b; idx[j + 1] = b + 1; idx[j + 2] = b + 2;
    idx[j + 3] = b; idx[j + 4] = b + 2; idx[j + 5] = b + 3;
    // 横向（±1 = 胎肩边缘）与纵向（0/1 = 段首/段尾）坐标：着色器据此羽化边缘、做沉积颗粒
    side[b] = 1; side[b + 1] = 1; side[b + 2] = -1; side[b + 3] = -1;
    along[b] = 0; along[b + 1] = 1; along[b + 2] = 1; along[b + 3] = 0;
  }
  skidGeo.setAttribute("position", new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
  skidGeo.setAttribute("aAlpha", new THREE.BufferAttribute(alpha, 1).setUsage(THREE.DynamicDrawUsage));
  skidGeo.setAttribute("aSide", new THREE.BufferAttribute(side, 1));
  skidGeo.setAttribute("aAlong", new THREE.BufferAttribute(along, 1));
  skidGeo.setAttribute("aSeed", new THREE.BufferAttribute(seed, 1).setUsage(THREE.DynamicDrawUsage));
  skidGeo.setIndex(new THREE.BufferAttribute(idx, 1));
  skidGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);   // 永不剔除
}
const skidMat = new THREE.ShaderMaterial({
  transparent: true,
  depthWrite: false,
  // 深度偏好：向相机方向微推，杜绝与沥青/路肩共面闪烁
  polygonOffset: true,
  polygonOffsetFactor: -4,
  polygonOffsetUnits: -4,
  uniforms: { uColor: { value: new THREE.Color(0.028, 0.030, 0.036) } },
  vertexShader: `
    attribute float aAlpha;
    attribute float aSide;
    attribute float aAlong;
    attribute float aSeed;
    varying float vA;
    varying float vSide;
    varying float vAlong;
    varying float vSeed;
    void main() {
      vA = aAlpha;
      vSide = aSide;
      vAlong = aAlong;
      vSeed = aSeed;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: `
    uniform vec3 uColor;
    varying float vA;
    varying float vSide;
    varying float vAlong;
    varying float vSeed;

    float hash21(vec2 p) {
      p = fract(p * vec2(123.34, 456.21));
      p += dot(p, p + 45.32);
      return fract(p.x * p.y);
    }

    void main() {
      // 胎肩接触压力低 → 横向羽化，边缘融融地散进沥青，而不是一条硬边色块
      float across = 1.0 - abs(vSide);
      float shape = smoothstep(0.0, 0.24, across) * (0.88 + 0.12 * across);
      // 橡胶沉积不匀：每段随机深浅（段间无接缝跳变：seed 只决定整段亮度）
      float grain = 0.74 + 0.26 * hash21(vec2(vSeed * 71.3, 3.7));
      // 段内被刮擦出的明暗起伏
      float wobble = 0.93 + 0.07 * sin(vAlong * 5.0 + vSeed * 6.2831);
      float a = vA * shape * grain * wobble;
      if (a < 0.005) discard;
      gl_FragColor = vec4(uColor, a);
    }`,
});
const skidMesh = new THREE.Mesh(skidGeo, skidMat);
skidMesh.frustumCulled = false;
skidMesh.renderOrder = 2;

const _sp = skidGeo.getAttribute("position");
const _sa = skidGeo.getAttribute("aAlpha");
const _ss = skidGeo.getAttribute("aSeed");

// 分段稳定 ID：seg 对象首次出现时分配，跨帧不变。
// 高度抖动若按数组下标取（下标随淘汰滚动），重叠段会整帧互换高度 → 闪烁。
let _skidSeq = 0;
function skidId(s) {
  if (s._v3id == null) s._v3id = _skidSeq++;
  return s._v3id;
}

function updateSkids() {
  const n = Math.min(skids.length, MAX_SKIDS);
  const p = _sp.array, a = _sa.array, sd = _ss.array;
  for (let i = 0; i < n; i++) {
    const s = skids[i];
    // 宽度贴近真实胎宽（物理端前 0.32 / 后 0.42）：只加 8% 抗锯齿余量。
    const hw = Math.max(0.05, (s.width || 0.38) * 0.5) * 1.08;
    const dx = s.b.x - s.a.x, dz = s.b.y - s.a.y;
    const len = Math.hypot(dx, dz);
    let nx, nz;
    if (len > 1e-4) {
      nx = (-dz / len) * hw; nz = (dx / len) * hw;
    } else {
      nx = hw; nz = 0;
    }
    // 两端各延长 0.85×半宽：相邻段链式相接处无缝（2D 版同样靠端部延长）
    const ex = len > 1e-4 ? (dx / len) * hw * 0.85 : 0;
    const ez = len > 1e-4 ? (dz / len) * hw * 0.85 : 0;
    // 高度仅比沥青路面（0.05）高 8mm：车体所有部件底面都抬到 0.09 以上，
    // 印子在几何上不可能与车身相交；轮胎落地由深度测试自然遮挡
    const yOff = 0.058 + (skidId(s) % 4) * 0.0009;
    const ya = (s.ya != null ? s.ya : s.y || 0) + yOff;
    const yb = (s.yb != null ? s.yb : s.ya || 0) + yOff;
    const inten = s.intensity || 0.5;
    const alpha = Math.min(0.9, 0.26 + inten * 0.7) * Math.max(0, s.life);
    const seed = s.seed != null ? s.seed : (s.seed = Math.random());
    const b = i * 12, ba = i * 4;
    p[b]     = s.a.x - ex + nx; p[b + 1]  = ya; p[b + 2]  = s.a.y - ez + nz;
    p[b + 3] = s.b.x + ex + nx; p[b + 4]  = yb; p[b + 5]  = s.b.y + ez + nz;
    p[b + 6] = s.b.x + ex - nx; p[b + 7]  = yb; p[b + 8]  = s.b.y + ez - nz;
    p[b + 9] = s.a.x - ex - nx; p[b + 10] = ya; p[b + 11] = s.a.y - ez - nz;
    a[ba] = alpha; a[ba + 1] = alpha; a[ba + 2] = alpha; a[ba + 3] = alpha;
    sd[ba] = seed; sd[ba + 1] = seed; sd[ba + 2] = seed; sd[ba + 3] = seed;
  }
  skidGeo.setDrawRange(0, n * 6);
  if (n > 0) {
    _sp.needsUpdate = true;
    _sa.needsUpdate = true;
    _ss.needsUpdate = true;
  }
}

/* ================= 尘土与锁胎白烟：点精灵（支持高程贴合与烟尘分色） ================= */
const dustGeo = new THREE.BufferGeometry();
{
  dustGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(MAX_DUST * 3), 3).setUsage(THREE.DynamicDrawUsage));
  dustGeo.setAttribute("aAlpha", new THREE.BufferAttribute(new Float32Array(MAX_DUST), 1).setUsage(THREE.DynamicDrawUsage));
  dustGeo.setAttribute("aSize", new THREE.BufferAttribute(new Float32Array(MAX_DUST), 1).setUsage(THREE.DynamicDrawUsage));
  dustGeo.setAttribute("aSmoke", new THREE.BufferAttribute(new Float32Array(MAX_DUST), 1).setUsage(THREE.DynamicDrawUsage));
  dustGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
}
const dustMat = new THREE.ShaderMaterial({
  transparent: true,
  depthWrite: false,
  uniforms: { uScale: { value: 600 } },
  vertexShader: `
    attribute float aAlpha;
    attribute float aSize;
    attribute float aSmoke;
    varying float vA;
    varying float vSmoke;
    uniform float uScale;
    void main() {
      vA = aAlpha;
      vSmoke = aSmoke;
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      gl_PointSize = aSize * uScale / max(1.0, -mv.z);
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: `
    varying float vA;
    varying float vSmoke;
    void main() {
      float d = length(gl_PointCoord - 0.5);
      if (d > 0.5) discard;
      float soft = 1.0 - smoothstep(0.18, 0.5, d);
      vec3 dustCol = vec3(0.55, 0.56, 0.42);
      vec3 smokeCol = vec3(0.86, 0.88, 0.92);
      vec3 col = mix(dustCol, smokeCol, vSmoke);
      gl_FragColor = vec4(col, vA * soft);
    }`,
});
const dustPoints = new THREE.Points(dustGeo, dustMat);
dustPoints.frustumCulled = false;
dustPoints.renderOrder = 3;

const _dp = dustGeo.getAttribute("position");
const _da = dustGeo.getAttribute("aAlpha");
const _ds = dustGeo.getAttribute("aSize");
const _dsm = dustGeo.getAttribute("aSmoke");

function updateDust() {
  const n = Math.min(dust.length, MAX_DUST);
  const p = _dp.array, a = _da.array, sz = _ds.array, sm = _dsm.array;
  for (let i = 0; i < n; i++) {
    const d = dust[i];
    const baseZ = d.isSmoke ? (d.z || 0) : Math.max(d.z || 0, sampleGroundMeshY(d.x, d.y));
    const age = d.max - d.life;
    p[i * 3] = d.x;
    p[i * 3 + 1] = baseZ + (d.isSmoke ? 0.22 + age * 1.35 : 0.40 + age * 2.1);
    p[i * 3 + 2] = d.y;
    a[i] = (d.isSmoke ? 0.36 : 0.5) * Math.max(0, d.life / d.max);
    sz[i] = d.r * (d.isSmoke ? 2.1 : 2.4);
    sm[i] = d.isSmoke ? 1.0 : 0.0;
  }
  dustGeo.setDrawRange(0, n);
  if (n > 0) {
    _dp.needsUpdate = true;
    _da.needsUpdate = true;
    _ds.needsUpdate = true;
    _dsm.needsUpdate = true;
  }
}

/* ================= F1 底板钛合金摩擦火花（3D 速度拉伸发光丝带 + 地面弹跳物理） =================
   真实 F1 在大直道高速下压力压缩（>245km/h）、重刹俯冲或压上锯齿路缘石时，
   车底 T-tray 与扩散器前缘的钛合金滑块（Titanium Skid Block）会擦出明亮的金橙色火花雨。 */
const sparks = [];
const sparkGeo = new THREE.BufferGeometry();
{
  const pos = new Float32Array(MAX_SPARKS * 4 * 3);
  const uv = new Float32Array(MAX_SPARKS * 4 * 2);
  const alpha = new Float32Array(MAX_SPARKS * 4);
  const idx = new Uint16Array(MAX_SPARKS * 6);
  for (let i = 0; i < MAX_SPARKS; i++) {
    const b = i * 4, j = i * 6;
    idx[j] = b; idx[j + 1] = b + 1; idx[j + 2] = b + 2;
    idx[j + 3] = b; idx[j + 4] = b + 2; idx[j + 5] = b + 3;
    // u: 0 = 火花明亮前端, 1 = 炽热拖尾末端; v: -1..+1 横向宽度
    uv[b * 2] = 0;     uv[b * 2 + 1] = -1;
    uv[(b + 1) * 2] = 0; uv[(b + 1) * 2 + 1] = 1;
    uv[(b + 2) * 2] = 1; uv[(b + 2) * 2 + 1] = 1;
    uv[(b + 3) * 2] = 1; uv[(b + 3) * 2 + 1] = -1;
  }
  sparkGeo.setAttribute("position", new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
  sparkGeo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  sparkGeo.setAttribute("aAlpha", new THREE.BufferAttribute(alpha, 1).setUsage(THREE.DynamicDrawUsage));
  sparkGeo.setIndex(new THREE.BufferAttribute(idx, 1));
  sparkGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
}

const sparkMat = new THREE.ShaderMaterial({
  transparent: true,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
  side: THREE.DoubleSide,
  vertexShader: `
    attribute float aAlpha;
    varying vec2 vUv;
    varying float vA;
    void main() {
      vUv = uv;
      vA = aAlpha;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: `
    varying vec2 vUv;
    varying float vA;
    void main() {
      float core = 1.0 - abs(vUv.y);
      core = pow(max(0.0, core), 1.6);
      float trail = 1.0 - smoothstep(0.0, 1.0, vUv.x);
      // 钛合金火花色温：前端白炽金黄 -> 中段亮橙 -> 尾部深红橙
      vec3 headCol = vec3(1.0, 0.96, 0.80);
      vec3 midCol  = vec3(1.0, 0.56, 0.12);
      vec3 tailCol = vec3(0.95, 0.22, 0.02);
      vec3 col = mix(headCol, midCol, smoothstep(0.0, 0.45, vUv.x));
      col = mix(col, tailCol, smoothstep(0.45, 1.0, vUv.x));
      float a = vA * core * (0.25 + 0.75 * trail);
      if (a < 0.01) discard;
      gl_FragColor = vec4(col * 1.8, a);
    }`,
});
const sparkMesh = new THREE.Mesh(sparkGeo, sparkMat);
sparkMesh.frustumCulled = false;
sparkMesh.renderOrder = 4;

const _skp = sparkGeo.getAttribute("position");
const _ska = sparkGeo.getAttribute("aAlpha");

function spawnSpark(x, y, z, vx, vy, vz, groundY) {
  if (sparks.length >= MAX_SPARKS) return;
  const maxLife = 0.14 + Math.random() * 0.20;
  sparks.push({
    x, y, z,
    vx, vy, vz,
    groundY,
    life: maxLife,
    max: maxLife,
  });
}

function stepAndEmitCarEffects(cars, dt) {
  if (!cars || !dt || dt <= 0) return;
  const stepDt = Math.min(dt, 0.05);

  for (let c = 0; c < cars.length; c++) {
    const car = cars[c];
    if (!car || car.retired || car.finished || car.ghostHidden) continue;
    const spd = Math.abs(car.speed || 0);
    if (spd < 18) continue;

    const roadY = (car.roadY || 0) + 0.052;
    const ca = Math.cos(car.angle || 0), sa = Math.sin(car.angle || 0);
    const nx = -sa, nz = ca;

    // 1. 重刹锁胎白烟（前轮锁死滑移时产生短促的浅灰白橡胶青烟）
    if (car.braking && (car.skidI || 0) > 0.36 && spd > 24 && Math.random() < stepDt * 28) {
      const side = Math.random() > 0.5 ? 0.77 : -0.77;
      const wx = car.x + ca * 1.65 + nx * side;
      const wz = car.y + sa * 1.65 + nz * side;
      addDust(
        wx, wz,
        car.speed * ca * 0.25 + (Math.random() - 0.5) * 3.5,
        car.speed * sa * 0.25 + (Math.random() - 0.5) * 3.5,
        car.roadY || 0,
        true
      );
    }

    // 2. F1 赛车底板钛合金滑块摩擦火花（越野车与街车底盘高、无钛合金底板，跳过）
    const isF1 = car.livery !== "offroad" && car.livery !== "su7ultra" && car.livery !== "yangwang";
    if (!isF1) continue;

    // 触发场景：
    //  a) 压上锯齿路缘石 (surf === 1) 且车速 > 25m/s (90km/h)
    //  b) 重刹俯冲 (braking) 且车速 > 42m/s (151km/h)，前底板 T-tray 触地
    //  c) 高 G 弯道侧倾压缩 (gLat > 3.1) 且车速 > 38m/s，外侧底板刀锋翼触地
    //  d) 大直道极速下压力触底 (spd > 68m/s ≈ 245km/h)，随路面微起伏间歇擦出火花
    const onKerb = car.surf === 1 && spd > 25;
    const diveScrape = car.braking && spd > 42 && (car.accel || 0) < -18;
    const cornerScrape = (car.gLat || 0) > 3.1 && spd > 38;
    const aeroBottoming = spd > 66 && Math.sin((car.trackS || 0) * 0.42 + c * 1.7) > 0.28;

    let intensity = 0;
    if (onKerb) intensity += 1.0;
    if (diveScrape) intensity += 0.85;
    if (cornerScrape) intensity += 0.65;
    if (aeroBottoming) intensity += 0.75 * Math.min(1, (spd - 64) / 22);

    if (intensity <= 0) continue;

    const emitCount = Math.min(5, Math.floor(intensity * stepDt * 95 + Math.random() * 1.4));
    for (let k = 0; k < emitCount; k++) {
      // 火花源点：前 T-tray (+0.85m, z=0) 或后扩散器底板前缘 (-1.75m, z=±0.28m)
      const fromFront = diveScrape || (Math.random() < 0.42);
      const localX = fromFront ? (0.75 + Math.random() * 0.25) : (-1.85 + Math.random() * 0.35);
      const turnSide = car.steer ? -Math.sign(car.steer) : (Math.random() > 0.5 ? 1 : -1);
      const localZ = fromFront
        ? (Math.random() - 0.5) * 0.16
        : (cornerScrape ? turnSide * (0.35 + Math.random() * 0.22) : (Math.random() - 0.5) * 0.52);

      const sx = car.x + ca * localX + nx * localZ;
      const sz = car.y + sa * localX + nz * localZ;
      const sy = roadY + 0.015 + Math.random() * 0.02;

      // 火花相对于地面向车尾高速喷射并被尾部扩散器乱流向上扬起
      const ejectBack = 14 + Math.random() * 18;
      const ejectLat = (Math.random() - 0.5) * 5.2 + localZ * 2.4;
      const vx = (car.speed - ejectBack) * ca + ejectLat * nx;
      const vz = (car.speed - ejectBack) * sa + ejectLat * nz;
      const vy = 1.4 + Math.random() * 2.8 + (onKerb ? 1.1 : 0);

      spawnSpark(sx, sy, sz, vx, vy, vz, roadY);
    }
  }
}

function updateSparks(dt) {
  const stepDt = Math.min(dt || 0.016, 0.05);
  for (let i = sparks.length - 1; i >= 0; i--) {
    const s = sparks[i];
    s.life -= stepDt;
    if (s.life <= 0) {
      sparks.splice(i, 1);
      continue;
    }
    s.vy -= 19.6 * stepDt; // 重力下坠
    s.x += s.vx * stepDt;
    s.y += s.vy * stepDt;
    s.z += s.vz * stepDt;
    // 空气阻力衰减
    const drag = Math.max(0, 1 - stepDt * 2.2);
    s.vx *= drag;
    s.vz *= drag;
    // 触碰沥青路面弹跳迸射
    if (s.y < s.groundY + 0.008) {
      s.y = s.groundY + 0.008;
      s.vy = Math.abs(s.vy) * (0.42 + Math.random() * 0.18);
      s.vx += (Math.random() - 0.5) * 2.2;
      s.vz += (Math.random() - 0.5) * 2.2;
    }
  }

  const n = Math.min(sparks.length, MAX_SPARKS);
  const p = _skp.array, a = _ska.array;
  for (let i = 0; i < n; i++) {
    const s = sparks[i];
    const vLen = Math.hypot(s.vx, s.vy, s.vz) || 1;
    // 光轨长度随相对速度拉伸（0.28m ~ 0.85m）
    const streakLen = Math.min(0.85, Math.max(0.26, vLen * 0.022));
    const dx = (s.vx / vLen) * streakLen;
    const dy = (s.vy / vLen) * streakLen;
    const dz = (s.vz / vLen) * streakLen;

    // 构造加宽的水平/垂直混合丝带法向，使任何视角下都能看清丝带宽度
    const halfW = 0.024;
    let rx = -s.vz / vLen, rz = s.vx / vLen;
    const rLen = Math.hypot(rx, rz) || 1;
    rx = (rx / rLen) * halfW;
    rz = (rz / rLen) * halfW;
    const ry = halfW * 0.65;

    const hx = s.x, hy = s.y, hz = s.z;
    const tx = s.x - dx, ty = Math.max(s.groundY + 0.005, s.y - dy), tz = s.z - dz;

    const b = i * 12, ba = i * 4;
    p[b]     = hx - rx; p[b + 1]  = hy - ry; p[b + 2]  = hz - rz;
    p[b + 3] = hx + rx; p[b + 4]  = hy + ry; p[b + 5]  = hz + rz;
    p[b + 6] = tx + rx; p[b + 7]  = ty + ry; p[b + 8]  = tz + rz;
    p[b + 9] = tx - rx; p[b + 10] = ty - ry; p[b + 11] = tz - rz;

    const alpha = Math.min(1, (s.life / s.max) * 1.25);
    a[ba] = alpha; a[ba + 1] = alpha; a[ba + 2] = alpha; a[ba + 3] = alpha;
  }

  sparkGeo.setDrawRange(0, n * 6);
  if (n > 0) {
    _skp.needsUpdate = true;
    _ska.needsUpdate = true;
  }
}

export function initEffects3D(scene) {
  scene.add(skidMesh);
  scene.add(dustPoints);
  scene.add(sparkMesh);
}

export function updateEffects3D(cars, dt) {
  stepAndEmitCarEffects(cars, dt);
  updateSkids();
  updateDust();
  updateSparks(dt);
}
