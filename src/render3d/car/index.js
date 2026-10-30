// 3D 车辆视觉体注册表与门面：对外 API 与拆分前完全一致
// （renderer.js 只依赖 createCarMesh / syncCarMesh / disposeCarMesh）。
// 一个车型一个文件：新增车型 → 建 car/<id>.js（导出 id / match / create / sync / dispose）
//   → 在下方 MODELS 与 ORDER 登记。
import { syncCarPose, syncWheels, syncBrakeLights, isBraking, applyGhost } from "./shared.js";
import * as f1 from "./f1.js";
import * as su7 from "./su7.js";
import * as offroad from "./offroad.js";
import * as yangwang from "./yangwang.js";

const MODELS = { f1, su7, offroad, yangwang };
// 有专属涂装标识的车型优先匹配；f1 为兜底默认车型
const ORDER = [su7, offroad, yangwang];
const DEFAULT_MODEL = f1;

function matchModel(car) {
  for (const m of ORDER) if (m.match(car)) return m;
  return DEFAULT_MODEL;
}

export function createCarMesh(car) {
  const model = matchModel(car);
  const root = model.create(car);
  root.userData.modelId = model.id;
  return root;
}

export function syncCarMesh(root, car, dt) {
  const u = root.userData;
  const model = MODELS[u.modelId] || DEFAULT_MODEL;
  const ctx = syncCarPose(root, car, dt);
  // 制动状态两种车型都要用：程序化车型点尾灯/刹车盘，glTF 车模点亮尾部灯组
  ctx.braking = isBraking(car, ctx.spd);

  // glTF 车模（SU7 / U9）的自转节点与材质列表独立，跳过程序化车轮/灯光管线
  if (u.isGlb) {
    model.sync(root, car, ctx);
    applyGhost(root, ctx.ghostA);
    return;
  }

  syncWheels(root, car, ctx);
  syncBrakeLights(root, car, ctx);
  model.sync(root, car, ctx);
  applyGhost(root, ctx.ghostA);
}

export function disposeCarMesh(root) {
  const model = MODELS[root.userData.modelId] || DEFAULT_MODEL;
  model.dispose(root);
}

export { isSu7Car } from "./su7.js";
export { isOffroadCar } from "./offroad.js";
export { isYangwangCar } from "./yangwang.js";

export async function preloadCars(cars, onProgress) {
  const needed = new Set();
  for (const car of (cars || [])) {
    if (!car) continue;
    const m = matchModel(car);
    if (m && typeof m.preload === "function") {
      needed.add(m);
    }
  }
  const models = Array.from(needed);
  if (!models.length) {
    if (onProgress) onProgress(1);
    return;
  }
  const progressMap = new Map();
  models.forEach(m => progressMap.set(m, 0));
  const update = () => {
    let sum = 0;
    for (const v of progressMap.values()) sum += v;
    if (onProgress) onProgress(sum / models.length);
  };
  await Promise.all(models.map(m => {
    return m.preload((event) => {
      let p = 0;
      if (event && event.total > 0) {
        p = event.loaded / event.total;
      } else if (event && event.loaded) {
        p = 0.5;
      }
      progressMap.set(m, Math.min(1, p));
      update();
    }).then(() => {
      progressMap.set(m, 1);
      update();
    }).catch(err => {
      console.warn("[render3d] preloadCars model load err:", err);
      progressMap.set(m, 1);
      update();
    });
  }));
  if (onProgress) onProgress(1);
}
