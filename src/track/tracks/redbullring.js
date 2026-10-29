// 红牛环赛车场 —— 赛道几何数据（每条赛道一个文件，便于单独调整走线与坡度）
// ctrl = 赛道中线控制点（Catmull-Rom 插值），sf = 起终点线位置。
// hills/bankK/bankMax 控制解析式起伏与弯道横坡（见 geometry.js 的剖面生成）。
// 本赛道使用 OSM 真实几何（旧版手绘走线在 T3/回程路段自交，3D 里被当成真立交桥，
// 凭空长出 7.5m 桥面和桥墩），单圈 4.318km、10 个弯。
import { REDBULLRING_CTRL } from "../redbullringData.js";

export default {
  id: "redbullring",
  name: "红牛环赛车场",
  nameEn: "Red Bull Ring",
  country: "奥地利",
  flag: "🇦🇹",
  length: 4318.0,
  turns: 10,
  hills: 5.0,                       // 阿尔卑斯山丘：上坡发卡/下坡重刹
  hw: 7.0,
  hwWide: 9.6,
  laps: 4,
  tag: "重刹超车圣地 · 短小激进",
  desc: "坐落于阿尔卑斯山脉的高速短道，三段大直道紧随剧烈上坡/下坡重刹发卡弯，单圈仅 60 秒出头，攻防超车最为激烈。",
  sf: { x: REDBULLRING_CTRL[0][0], y: REDBULLRING_CTRL[0][1] },
  ctrl: REDBULLRING_CTRL,           // OSM 真实赛道几何（330 个控制点，几何实测 4293m）
  sub: 4
};
