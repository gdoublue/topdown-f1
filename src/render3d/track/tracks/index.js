// 赛道 3D 个性化模块注册表：id → render3d/track/tracks/<id>.js
// 新增赛道：建 src/track/tracks/<id>.js 数据 + 本目录建同 id 3D 模块 + 两处注册。
import shanghai from "./shanghai.js";
import monza from "./monza.js";
import silverstone from "./silverstone.js";
import spa from "./spa.js";
import redbullring from "./redbullring.js";
import dragstrip from "./dragstrip.js";
import stadiumring from "./stadiumring.js";

export default {
  shanghai,
  monza,
  silverstone,
  spa,
  redbullring,
  dragstrip,
  stadiumring,
};
