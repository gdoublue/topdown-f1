// 3D 赛道场景门面：组装共享景物层（track/props.js）与每赛道个性化模块（track/tracks/<id>.js）。
// 对外 API 与拆分前完全一致（renderer.js 零改动）：SKY_HORIZON / setMaxAnisotropy /
// createSky / updateSkyDome / setGantryLights / buildTrackScene。
// 世界坐标映射：2D (x, y) → three.js (x, y0, z)，y 轴向上为高度；
// 赛道几何一律 import 自 src/track/geometry.js 权威数据（与物理判定同源）。
import * as THREE from "three";
import {
  pts, N, nor, tan, hw, kerbFlag, cumDist, curvS, currentTrackId,
  h, bank, bridges, roadElev, roadAt, indexAtDistance, isLinear, LAP_LENGTH, terrainAt,
} from "../track/geometry.js";
import {
  setMaxAnisotropy as _setMaxAnisotropy,
  sampleIndices, ribbonGeometry, quadSegmentsGeometry, hash01,
} from "./track/shared.js";
import {
  prepareGroundSampler, buildGround, buildAsphalt, buildEdgeLines, buildKerbs,
  buildStartLine, buildTrees, buildGrandstands, buildGantry, buildPit,
  buildBoards, buildBridgePiers, buildClouds,
} from "./track/props.js";

export { setGantryLights } from "./track/props.js";
import TRACK_SCENE_MODULES from "./track/tracks/index.js";

export const SKY_HORIZON = 0xbcd9ea;

export function setMaxAnisotropy(v) {
  _setMaxAnisotropy(v);
}

/* ================= 天空穹顶 + 灯光 + 雾 =================
   天穹跟随相机 XZ（updateSkyDome）：穹壁视距恒定 2400m，永不被相机远平面
   （3200）裁剪 —— 否则会露出黑色清屏色，即偶发的"多边形黑球"。 */
let skyDome = null;
export function updateSkyDome(x, z) {
  if (skyDome) skyDome.position.set(x, 0, z);
}

export function createSky(scene) {
  const geo = new THREE.SphereGeometry(2400, 24, 12);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      top: { value: new THREE.Color(0x3273b8) },
      bottom: { value: new THREE.Color(SKY_HORIZON) },
    },
    vertexShader: `
      varying vec3 vPos;
      void main() {
        vPos = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform vec3 top; uniform vec3 bottom; varying vec3 vPos;
      void main() {
        float h = clamp(vPos.y / 900.0, 0.0, 1.0);
        gl_FragColor = vec4(mix(bottom, top, pow(h, 0.75)), 1.0);
      }`,
  });
  skyDome = new THREE.Mesh(geo, mat);
  scene.add(skyDome);

  scene.add(new THREE.HemisphereLight(0xcfe4f5, 0x2e4d2b, 1.1));

  const sun = new THREE.DirectionalLight(0xfff2dc, 3.0);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -95;
  sun.shadow.camera.right = 95;
  sun.shadow.camera.top = 95;
  sun.shadow.camera.bottom = -95;
  sun.shadow.camera.near = 20;
  sun.shadow.camera.far = 700;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.02;
  // 树影/看台影落在路面上时不要是硬邦邦的黑块：
  // radius 让 PCF 采样范围变宽（边缘柔和），intensity 抬一点（保留天光与地面反弹）
  sun.shadow.radius = 2.5;
  sun.shadow.intensity = 0.8;
  scene.add(sun);
  scene.add(sun.target);
  scene.fog = new THREE.Fog(SKY_HORIZON, 550, 1700);
  return sun;
}

/* ================= 赛道场景组装（换赛道时调用） ================= */
let trackGroup = null;

export function buildTrackScene(scene) {
  if (trackGroup) {
    scene.remove(trackGroup);
    trackGroup.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        (Array.isArray(o.material) ? o.material : [o.material]).forEach(mm => {
          if (mm.map) mm.map.dispose();
          if (mm.bumpMap) mm.bumpMap.dispose();
          if (mm.roughnessMap) mm.roughnessMap.dispose();
          mm.dispose();
        });
      }
    });
  }

  const sampler = prepareGroundSampler();
  // 每赛道渲染 options：track/tracks/<id>.js 的 options 覆盖默认值
  const mod = TRACK_SCENE_MODULES[currentTrackId];
  const opts = { treeDensity: 1, cloudCount: 9, ...(mod && mod.options) };

  trackGroup = new THREE.Group();
  trackGroup.add(buildGround());
  trackGroup.add(buildAsphalt());
  trackGroup.add(buildEdgeLines());
  trackGroup.add(buildBridgePiers());
  trackGroup.add(buildKerbs());
  trackGroup.add(buildStartLine());
  trackGroup.add(buildGrandstands());
  trackGroup.add(buildGantry());
  trackGroup.add(buildPit());
  trackGroup.add(buildTrees(opts));
  trackGroup.add(buildBoards(opts));
  trackGroup.add(buildClouds(opts));
  scene.add(trackGroup);

  // 每赛道个性化装饰钩子：模块缺失时静默跳过（新赛道可只加数据不加文件）
  if (mod && typeof mod.decorate === "function") {
    try {
      mod.decorate({
        THREE,
        group: trackGroup,
        opts,
        pts, N, nor, tan, hw, kerbFlag, cumDist, curvS,
        h, bank, bridges, roadElev, roadAt, indexAtDistance, isLinear, LAP_LENGTH,
        groundAt: sampler, terrainAt,
        sampleIndices, ribbonGeometry, quadSegmentsGeometry, hash01,
      });
    } catch (e) {
      console.error("[track3d] decorate 钩子异常 (" + currentTrackId + ")", e);
    }
  }
  return trackGroup;
}
