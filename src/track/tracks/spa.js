// 斯帕-弗朗科尔尚赛车场 —— 赛道几何数据（每条赛道一个文件，便于单独调整走线与坡度）
// ctrl = 赛道中线控制点（Catmull-Rom 插值），sf = 起终点线位置。
// hills/bankK/bankMax 控制解析式起伏与弯道横坡（见 geometry.js 的剖面生成）。
// 本赛道使用 OSM 真实几何 + DEM 真实高程/地形，不走解析式起伏。
import { SPA_CTRL, SPA_ELEV, SPA_TERRAIN } from "../spaData.js";

export default {
  id: "spa",
  name: "斯帕-弗朗科尔尚赛车场",
  nameEn: "Circuit de Spa-Francorchamps",
  country: "比利时",
  flag: "🇧🇪",
  length: 7004.0,
  turns: 19,
  hills: 0,                         // 真实 DEM 高程剖面（elev）优先，不再叠加谐波起伏
  hw: 7.2,
  hwWide: 10.0,
  laps: 3,
  tag: "阿登过山车 · 传奇艾尔罗格红河弯",
  desc: "全长逾 7 公里的传奇森林赛道！包含极限下坡接冲天盲弯 Eau Rouge/Raidillon、长达 2km 的 Kemmel 直道与 280km/h 极限 Pouhon 双弯。",
  sf: { x: SPA_CTRL[0][0], y: SPA_CTRL[0][1] },
  ctrl: SPA_CTRL,                   // OSM 真实赛道几何（280 个控制点 @25m，单圈 7004m）
  elev: SPA_ELEV,                   // 真实海拔剖面：落差 102m，起终点归一化到 0
  terrain: SPA_TERRAIN,             // 周边 DEM 地形网格（草地/山坡跟随真实地势）
  sub: 4
};
