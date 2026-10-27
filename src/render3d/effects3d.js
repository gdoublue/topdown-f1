// 3D 特效：刹车痕（GPU 顶点池，平铺路面）与草地尘土（点精灵）
// 数据源复用 2D 的 fx.skids / fx.dust 数组（netrace 远端车落印逻辑零改动）
import * as THREE from "three";
import { skids, dust } from "../game/effects.js";

const MAX_SKIDS = 9000;   // 与 effects.js 的池子上限一致
const MAX_DUST = 200;

/* ================= 刹车痕：单个大 BufferGeometry，每帧重写可见段 ================= */
const skidGeo = new THREE.BufferGeometry();
{
  const pos = new Float32Array(MAX_SKIDS * 4 * 3);
  const alpha = new Float32Array(MAX_SKIDS * 4);
  const idx = new Uint32Array(MAX_SKIDS * 6);
  for (let i = 0; i < MAX_SKIDS; i++) {
    const b = i * 4, j = i * 6;
    // 两个三角形都必须朝上（+y）：顶点序 a+n, b+n, b-n, a-n
    idx[j] = b; idx[j + 1] = b + 1; idx[j + 2] = b + 2;
    idx[j + 3] = b; idx[j + 4] = b + 2; idx[j + 5] = b + 3;
  }
  skidGeo.setAttribute("position", new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
  skidGeo.setAttribute("aAlpha", new THREE.BufferAttribute(alpha, 1).setUsage(THREE.DynamicDrawUsage));
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
  uniforms: { uColor: { value: new THREE.Color(0.045, 0.048, 0.056) } },
  vertexShader: `
    attribute float aAlpha;
    varying float vA;
    void main() {
      vA = aAlpha;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: `
    uniform vec3 uColor;
    varying float vA;
    void main() { gl_FragColor = vec4(uColor, vA); }`,
});
const skidMesh = new THREE.Mesh(skidGeo, skidMat);
skidMesh.frustumCulled = false;
skidMesh.renderOrder = 2;

const _sp = skidGeo.getAttribute("position");
const _sa = skidGeo.getAttribute("aAlpha");

// 分段稳定 ID：seg 对象首次出现时分配，跨帧不变。
// 高度抖动若按数组下标取（下标随淘汰滚动），重叠段会整帧互换高度 → 闪烁。
let _skidSeq = 0;
function skidId(s) {
  if (s._v3id == null) s._v3id = _skidSeq++;
  return s._v3id;
}

function updateSkids() {
  const n = Math.min(skids.length, MAX_SKIDS);
  const p = _sp.array, a = _sa.array;
  for (let i = 0; i < n; i++) {
    const s = skids[i];
    const hw = Math.max(0.05, (s.width || 0.38) * 0.5) * 1.25;   // 视觉加宽：掠射角下细缝不可见
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
    const y = 0.058 + (skidId(s) % 4) * 0.0009;
    const inten = s.intensity || 0.5;
    const alpha = Math.min(0.92, (0.3 + inten * 0.72)) * Math.max(0, s.life);
    const b = i * 12, ba = i * 4;
    p[b]     = s.a.x - ex + nx; p[b + 1]  = y; p[b + 2]  = s.a.y - ez + nz;
    p[b + 3] = s.b.x + ex + nx; p[b + 4]  = y; p[b + 5]  = s.b.y + ez + nz;
    p[b + 6] = s.b.x + ex - nx; p[b + 7]  = y; p[b + 8]  = s.b.y + ez - nz;
    p[b + 9] = s.a.x - ex - nx; p[b + 10] = y; p[b + 11] = s.a.y - ez - nz;
    a[ba] = alpha; a[ba + 1] = alpha; a[ba + 2] = alpha; a[ba + 3] = alpha;
  }
  skidGeo.setDrawRange(0, n * 6);
  if (n > 0) {
    _sp.needsUpdate = true;
    _sa.needsUpdate = true;
  }
}

/* ================= 尘土：点精灵（圆点软边 + 按生命周期淡出） ================= */
const dustGeo = new THREE.BufferGeometry();
{
  dustGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(MAX_DUST * 3), 3).setUsage(THREE.DynamicDrawUsage));
  dustGeo.setAttribute("aAlpha", new THREE.BufferAttribute(new Float32Array(MAX_DUST), 1).setUsage(THREE.DynamicDrawUsage));
  dustGeo.setAttribute("aSize", new THREE.BufferAttribute(new Float32Array(MAX_DUST), 1).setUsage(THREE.DynamicDrawUsage));
  dustGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e7);
}
const dustMat = new THREE.ShaderMaterial({
  transparent: true,
  depthWrite: false,
  uniforms: { uScale: { value: 600 } },
  vertexShader: `
    attribute float aAlpha;
    attribute float aSize;
    varying float vA;
    uniform float uScale;
    void main() {
      vA = aAlpha;
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      gl_PointSize = aSize * uScale / max(1.0, -mv.z);
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: `
    varying float vA;
    void main() {
      float d = length(gl_PointCoord - 0.5);
      if (d > 0.5) discard;
      float soft = 1.0 - smoothstep(0.28, 0.5, d);
      gl_FragColor = vec4(vec3(0.55, 0.56, 0.42), vA * soft);
    }`,
});
const dustPoints = new THREE.Points(dustGeo, dustMat);
dustPoints.frustumCulled = false;
dustPoints.renderOrder = 3;

const _dp = dustGeo.getAttribute("position");
const _da = dustGeo.getAttribute("aAlpha");
const _ds = dustGeo.getAttribute("aSize");

function updateDust() {
  const n = Math.min(dust.length, MAX_DUST);
  const p = _dp.array, a = _da.array, sz = _ds.array;
  for (let i = 0; i < n; i++) {
    const d = dust[i];
    p[i * 3] = d.x; p[i * 3 + 1] = 0.45 + (d.max - d.life) * 2.2; p[i * 3 + 2] = d.y;
    a[i] = 0.5 * Math.max(0, d.life / d.max);
    sz[i] = d.r * 2.4;
  }
  dustGeo.setDrawRange(0, n);
  if (n > 0) {
    _dp.needsUpdate = true;
    _da.needsUpdate = true;
    _ds.needsUpdate = true;
  }
}

export function initEffects3D(scene) {
  scene.add(skidMesh);
  scene.add(dustPoints);
}

export function updateEffects3D() {
  updateSkids();
  updateDust();
}
