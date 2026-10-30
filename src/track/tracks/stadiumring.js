// 云栖体育场环道 —— 赛道几何数据（每条赛道一个文件，便于单独调整走线与坡度）
// 解析式环道点生成：两条平行直道 + 两端半圆（体育场环道等规则几何赛道用）。
// 沿理想路径按 step 等距生成精确坐标点 → 切线连续、间距均匀，避免 Catmull-Rom
// 在控制点间距突变处产生样条尖点（尖点会让弯速表要求刹到近乎停车，车辆直接冲出赛道）。
function ovalPoints({ xL, xR, y0, y1, step = 20 }) {
  const R = (y1 - y0) / 2;
  const cy = (y0 + y1) / 2;
  const pts = [];
  for (let x = xL; x < xR; x += step) pts.push([x, y0]);                 // 底直道（左→右）
  const nArc = Math.max(8, Math.round((Math.PI * R) / step));
  for (let i = 1; i < nArc; i++) {                                       // 右半圆（向下凸）
    const th = -Math.PI / 2 + (Math.PI * i) / nArc;
    pts.push([xR + R * Math.cos(th), cy + R * Math.sin(th)]);
  }
  for (let x = xR; x > xL; x -= step) pts.push([x, y1]);                 // 顶直道（右→左）
  for (let i = 1; i < nArc; i++) {                                       // 左半圆（向上凸）
    const th = Math.PI / 2 + (Math.PI * i) / nArc;
    pts.push([xL + R * Math.cos(th), cy + R * Math.sin(th)]);
  }
  return pts;
}

export default {
  id: "stadiumring",
  name: "云栖体育场环道",
  nameEn: "Yunqi Stadium Oval",
  country: "中国",
  flag: "🏟️",
  length: 4500.0,
  turns: 2,
  hills: 1.6,
  bankK: 60,                          // 横坡增益：恒定曲率弯 → 真实速度场 banking
  bankMax: 0.20,                      // 弯道最大横坡 ~11.5°（外侧更高）
  hw: 7.5,
  hwWide: 9.5,
  laps: 3,
  tag: "环形冲刺 · 双大直道恒定曲率",
  desc: "以田径场为蓝本的巨型环道：两条 1.15km 大直道与两段 350m 半径恒定半圆弯相接，没有急刹、没有发卡，是尾速、弹射与持续横向 G 值的纯试炼场。",
  sf: { x: 500, y: 300 },
  ctrl: ovalPoints({ xL: 450, xR: 1600, y0: 300, y1: 1000, step: 25 }),
  sub: 5
};
