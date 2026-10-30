// 琼海直线竞速测试场 —— 赛道几何数据（每条赛道一个文件，便于单独调整走线与坡度）
// ctrl = 赛道中线控制点（Catmull-Rom 插值），sf = 起终点线位置。
// linear: true 表示不闭合的单程冲刺道。
export default {
  id: "dragstrip",
  name: "琼海直线竞速测试场",
  nameEn: "Qionghai Straight-Line Sprint Circuit",
  country: "中国",
  flag: "🏁",
  length: 6000.0,
  turns: 0,
  hills: 0,                         // 冲刺道：绝对平直
  hw: 18.0,                            // 半宽 18m（沥青全宽 36m）：足够多车并排发车与超车
  hwWide: 18.0,
  laps: 1,
  linear: true,                        // 线性赛道：起点→终点单程冲刺，不闭合
  tag: "极速圣殿 · 6km 纯直线冲刺 + 5km 巡航缓冲",
  desc: "从起点到终点一条 6km 纯直线，没有弯道、只需跑一趟：全世界最纯粹的尾速与加减速对决，四轮驱动弹射与空气动力学的终极考场。冲线后还有 5km 沥青缓冲区可供减速巡航。",
  sf: { x: 150, y: 300 },
  ctrl: [[150, 300], [11150, 300]],   // 沥青总长 11km：6km 计时段 + 冲线后 5km 巡航缓冲区
  sub: 2750                           // 每 4m 一个采样点，与 AI 步进间距精确对齐
};
