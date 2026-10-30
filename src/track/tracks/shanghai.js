// 上海国际赛车场 —— 赛道几何数据（每条赛道一个文件，便于单独调整走线与坡度）
// ctrl = 赛道中线控制点（Catmull-Rom 插值），sf = 起终点线位置。
// hills/bankK/bankMax 控制解析式起伏与弯道横坡（见 geometry.js 的剖面生成）。
// 本赛道使用 OSM 真实几何 + 公开资料重建的真实高程剖面，不走解析式起伏。
import { SHANGHAI_CTRL, SHANGHAI_ELEV } from "../shanghaiData.js";

export default {
  id: "shanghai",
  name: "上海国际赛车场",
  nameEn: "Shanghai International Circuit",
  country: "中国",
  flag: "🇨🇳",
  length: 5451.24,
  turns: 16,
  hills: 0,                         // 真实高程剖面（elev）优先，不再叠加谐波起伏
  hw: 7.0,
  hwWide: 10.0,
  laps: 3,
  tag: "平衡挑战 · 螺线弯与超长大直道",
  desc: "标志性“上”字形布局，拥有 1.17km 极限尾速大直道与极富技术挑战的连续收紧螺线弯 (T1-T4)。",
  sf: { x: SHANGHAI_CTRL[0][0], y: SHANGHAI_CTRL[0][1] },
  ctrl: SHANGHAI_CTRL,              // OSM 真实赛道几何（372 个控制点，几何实测 5460m）
  elev: SHANGHAI_ELEV,              // 真实高程剖面：T2 弯顶最高 +11.24m，最低点 +4.50m
  sub: 4
};
