// 真实世界经典 F1 赛车场数据集
// 每条赛道的几何与坡度数据独立放在 ./tracks/<id>.js，单独调整不影响其他赛道。
// 新增赛道：建 ./tracks/<id>.js（默认导出赛道对象）→ 在下方注册表登记。
import shanghai from "./tracks/shanghai.js";
import monza from "./tracks/monza.js";
import silverstone from "./tracks/silverstone.js";
import spa from "./tracks/spa.js";
import redbullring from "./tracks/redbullring.js";
import dragstrip from "./tracks/dragstrip.js";
import stadiumring from "./tracks/stadiumring.js";

export const TRACKS = [
  shanghai,
  monza,
  silverstone,
  spa,
  redbullring,
  dragstrip,
  stadiumring,
];

export const DEFAULT_TRACK_ID = "shanghai";

export function getTrack(id = DEFAULT_TRACK_ID) {
  const found = TRACKS.find(t => t.id === id);
  return found || TRACKS[0];
}
