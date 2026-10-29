// 蒙扎国家赛车场 —— 赛道几何数据（每条赛道一个文件，便于单独调整走线与坡度）
// ctrl = 赛道中线控制点（Catmull-Rom 插值），sf = 起终点线位置。
// hills/bankK/bankMax 控制解析式起伏与弯道横坡（见 geometry.js 的剖面生成）。
// 本赛道使用 OSM 真实几何：单圈 5.793km、11 个弯，主直道 1.1km。
import { MONZA_CTRL } from "../monzaData.js";

export default {
  id: "monza",
  name: "蒙扎国家赛车场",
  nameEn: "Autodromo Nazionale Monza",
  country: "意大利",
  flag: "🇮🇹",
  length: 5793.0,
  turns: 11,
  hills: 1.6,                       // 皇家公园地势平缓
  hw: 7.0,
  hwWide: 9.5,
  laps: 3,
  tag: "速度圣殿 · 全年最高平均时速",
  desc: "拥有全赛历最高尾速的大直道、Rettifilo 极限减速弯、Curva Grande 极速弧线与传奇的 Parabolica 抛物线弯。",
  sf: { x: MONZA_CTRL[0][0], y: MONZA_CTRL[0][1] },
  ctrl: MONZA_CTRL,                 // OSM 真实赛道几何（444 个控制点，几何实测 5771m）
  sub: 4
};
