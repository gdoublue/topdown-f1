// 银石赛车场 —— 赛道几何数据（每条赛道一个文件，便于单独调整走线与坡度）
// ctrl = 赛道中线控制点（Catmull-Rom 插值），sf = 起终点线位置。
// hills/bankK/bankMax 控制解析式起伏与弯道横坡（见 geometry.js 的剖面生成）。
// 本赛道使用 OSM 真实几何：单圈 5.891km、18 个弯（Arena 段 + Maggotts/Becketts 高速 S 弯）。
import { SILVERSTONE_CTRL } from "../silverstoneData.js";

export default {
  id: "silverstone",
  name: "银石赛车场",
  nameEn: "Silverstone Circuit",
  country: "英国",
  flag: "🇬🇧",
  length: 5891.0,
  turns: 18,
  hills: 4.2,
  hw: 7.0,
  hwWide: 9.8,
  laps: 3,
  tag: "高速气动 · 传奇 Maggotts-Becketts",
  desc: "现代 F1 运动的摇篮！拥有全球最负盛名的高速连续变向 S 弯组合与全油门 8 挡盲切的 Copse 弯，考验极致下压力。",
  sf: { x: SILVERSTONE_CTRL[0][0], y: SILVERSTONE_CTRL[0][1] },
  ctrl: SILVERSTONE_CTRL,           // OSM 真实赛道几何（451 个控制点，几何实测 5863m）
  sub: 4
};
