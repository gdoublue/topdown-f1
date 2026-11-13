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
  buildBoards, buildBridgePiers, buildClouds, buildGuardrails,
} from "./track/props.js";
import { ProceduralSkySystem } from "./sky.js";

export { setGantryLights } from "./track/props.js";
import TRACK_SCENE_MODULES from "./track/tracks/index.js";

export const SKY_HORIZON = 0xbcdcee;

export function setMaxAnisotropy(v) {
  _setMaxAnisotropy(v);
}

/* ================= 程序化物理天空穹顶 + 动态太阳 + 场景光照与雾气系统 =================
   使用 Rayleigh 大气散射、Mie 漫散射晕圈、HDR 太阳圆盘、FBM 动态高空流云。
   天穹跟随相机 XZ：保证穹壁视距恒定 2600m，永不被相机远平面（3200）裁剪。 */
export let skySystem = null;

export function updateSkyDome(x, z, dt = 0.016) {
  if (skySystem) skySystem.update(dt, { x, z });
}

export function createSky(scene, renderer = null) {
  if (skySystem) {
    skySystem.dispose();
    skySystem = null;
  }
  // 建立全新零资源物理程序化天空与太阳系统
  skySystem = new ProceduralSkySystem(scene, {
    elevationDeg: 34,    // 真实通透的下午黄金阳光角度
    azimuthDeg: 46,      // 最佳侧逆光赛道立体入射角
    hazeStrength: 0.45,  // 清新大奖赛空气质感
    cloudCover: 0.40,    // 高空柔和卷云
    renderer,
  });

  return skySystem.sunLight;
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
  const opts = { treeDensity: 1, cloudCount: 0, ...(mod && mod.options) };

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
  trackGroup.add(buildGuardrails());
  // 旧版假白云球体已移除，真实高空云层由 skySystem 程序化天穹实时驱动渲染
  if (skySystem) {
    const cover = opts.cloudCover ?? (opts.cloudCount ? Math.min(0.55, 0.22 + opts.cloudCount * 0.022) : 0.40);
    skySystem.setCloudCover(cover);
  }
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
