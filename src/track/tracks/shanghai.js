// 上海国际赛车场 —— 赛道几何数据（每条赛道一个文件，便于单独调整走线与坡度）
// ctrl = 赛道中线控制点（Catmull-Rom 插值），sf = 起终点线位置。
// hills/bankK/bankMax 控制解析式起伏与弯道横坡（见 geometry.js 的剖面生成）。
import { CTRL } from "../data.js";

export default {
  id: "shanghai",
  name: "上海国际赛车场",
  nameEn: "Shanghai International Circuit",
  country: "中国",
  flag: "🇨🇳",
  length: 5451.24,
  turns: 16,
  hills: 4.2,                       // 纵向起伏幅度（米，波峰对草地高度）
  hw: 7.0,
  hwWide: 10.0,
  laps: 3,
  tag: "平衡挑战 · 螺线弯与超长大直道",
  desc: "标志性“上”字形布局，拥有 1.17km 极限尾速大直道与极富技术挑战的连续收紧螺线弯 (T1-T4)。",
  sf: { x: 470.5, y: 319.6 },
  ctrl: CTRL,
  sub: 6
};
