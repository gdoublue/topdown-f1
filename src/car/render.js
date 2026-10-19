// 赛车渲染：以“米”为单位绘制（车宽 2m、车长 5.6m），再按 M 缩放到世界
import { M } from "../config.js";
import { TAU, rrect } from "../utils.js";

// 赛车涂装配色表：键为车型代号（与 AI_CONFIGS 的 livery 字段对应）
export const CAR_LIVERIES = {
  ferrari: {           // 法拉利 SF-24
    grad: ["#ff6b6b", "#e02424", "#991b1b"],
    side: "#b91c1c",
    wing: "#e02424",
    stripe: "rgba(255,255,255,.9)",
    helmet: "#ffd166",
    num: "16",
    numColor: "#ffffff"
  },
  redbull: {           // 红牛 RB20
    grad: ["#38bdf8", "#0284c7", "#075985"],
    side: "#0369a1",
    wing: "#f59e0b",
    stripe: "rgba(255,255,255,.9)",
    helmet: "#ef4444",
    num: "1",
    numColor: "#ffffff"
  },
  aston: {             // 阿斯顿·马丁 AMR24
    grad: ["#34d399", "#059669", "#064e3b"],
    side: "#047857",
    wing: "#a3e635",
    stripe: "rgba(255,255,255,.9)",
    helmet: "#f97316",
    num: "14",
    numColor: "#ffffff"
  },
  mercedes: {          // 梅奔 W15
    grad: ["#f8fafc", "#94a3b8", "#475569"],
    side: "#06b6d4",
    wing: "#06b6d4",
    stripe: "rgba(6,182,212,.95)",
    helmet: "#38bdf8",
    num: "44",
    numColor: "#0f172a"
  },
  su7ultra: {          // 小米 SU7 Ultra（灼烈黄）· 街车车体
    body: "road",      // road = 封闭座舱街车渲染，与 F1 开放式车体区分
    grad: ["#fde047", "#f5c518", "#a16207"],
    side: "#ca8a04",
    wing: "#0a0a0a",
    stripe: "rgba(15,23,42,.9)",
    helmet: "#0ea5e9",
    num: "7",
    numColor: "#0f172a"
  },
  yangwang: {          // 仰望 U9X（曜石黑金）· 街车车体
    body: "road",
    grad: ["#475569", "#1e293b", "#020617"],
    side: "#b45309",
    wing: "#f59e0b",
    stripe: "rgba(245,158,11,.92)",
    helmet: "#f43f5e",
    num: "9",
    numColor: "#fbbf24"
  },
  cyber: {           // cyber
    grad: ["#00ff00", "#0000ff", "#fe8096"],
    side: "#fe8096",
    wing: "#f59e0b",
    stripe: "rgba(255,255,255,.9)",
    helmet: "#ef4444",
    num: "55",
    numColor: "#fe8096"
  },
};

export function drawCar(g, car, liveryKey = "ferrari") {
  const livery = CAR_LIVERIES[car.livery || liveryKey] || CAR_LIVERIES.ferrari;

  g.save();
  g.translate(car.x, car.y);
  g.rotate(car.angle);
  g.scale(M, M);          // 之后全部使用米

  // 落地阴影
  g.save();
  g.translate(0.08, 0.1);
  g.fillStyle = "rgba(0,0,0,.30)";
  g.beginPath();
  g.ellipse(0, 0, 2.9, 0.95, 0, 0, TAU);
  g.fill();
  g.restore();

  // 街车车体（量产电车超跑）：封闭座舱、贯穿式尾灯，与 F1 开放式车体明显区分
  if (livery.body === "road") {
    drawRoadBody(g, car, livery);
    g.restore();
    return;
  }

  // 尾翼
  g.fillStyle = "#1c222a";
  rrect(g, -2.82, -0.74, 0.5, 1.48, 0.06); g.fill();
  g.fillStyle = livery.wing;
  rrect(g, -2.88, -0.76, 0.55, 0.17, 0.05); g.fill();
  rrect(g, -2.88, 0.59, 0.55, 0.17, 0.05); g.fill();

  // 刹车灯
  if (car.braking) {
    g.fillStyle = "rgba(255,60,60,.35)";
    rrect(g, -3.05, -0.52, 0.46, 0.32, 0.1); g.fill();
    rrect(g, -3.05, 0.2, 0.46, 0.32, 0.1); g.fill();
    g.fillStyle = "#ff3b3b";
    rrect(g, -2.8, -0.48, 0.24, 0.26, 0.06); g.fill();
    rrect(g, -2.8, 0.22, 0.24, 0.26, 0.06); g.fill();
  }

  // 轮胎
  const tyre = (cx, cy, w, l, rot) => {
    g.save();
    g.translate(cx, cy);
    g.rotate(rot || 0);
    g.fillStyle = "#14181d";
    rrect(g, -l / 2, -w / 2, l, w, 0.09); g.fill();
    g.fillStyle = "rgba(255,255,255,.18)";
    rrect(g, -l / 2 + 0.07, -w / 2 + 0.055, l - 0.14, 0.08, 0.03); g.fill();
    g.restore();
  };
  tyre(-1.75, -0.79, 0.42, 0.74, 0);
  tyre(-1.75, 0.79, 0.42, 0.74, 0);
  tyre(1.75, -0.77, 0.36, 0.62, car.steer * 0.5);
  tyre(1.75, 0.77, 0.36, 0.62, car.steer * 0.5);

  // 车身
  const grad = g.createLinearGradient(0, -0.55, 0, 0.55);
  grad.addColorStop(0, livery.grad[0]);
  grad.addColorStop(0.42, livery.grad[1]);
  grad.addColorStop(1, livery.grad[2]);
  g.beginPath();
  g.moveTo(2.8, -0.12);
  g.bezierCurveTo(2.3, -0.2, 1.4, -0.3, 0.4, -0.36);
  g.lineTo(-0.9, -0.42);
  g.lineTo(-2.1, -0.5);
  g.lineTo(-2.45, -0.47);
  g.lineTo(-2.45, 0.47);
  g.lineTo(-2.1, 0.5);
  g.lineTo(-0.9, 0.42);
  g.lineTo(0.4, 0.36);
  g.bezierCurveTo(1.4, 0.3, 2.3, 0.2, 2.8, 0.12);
  g.closePath();
  g.fillStyle = grad;
  g.fill();
  g.strokeStyle = "rgba(0,0,0,.35)";
  g.lineWidth = 0.03;
  g.stroke();

  // 侧箱
  for (const s of [-1, 1]) {
    g.beginPath();
    g.moveTo(0.7, -0.34 * s);
    g.lineTo(-0.3, -0.42 * s);
    g.lineTo(-1.1, -0.52 * s);
    g.lineTo(-1.65, -0.5 * s);
    g.lineTo(-1.4, -0.36 * s);
    g.closePath();
    g.fillStyle = livery.side;
    g.fill();
    g.strokeStyle = "rgba(255,255,255,.22)";
    g.lineWidth = 0.025;
    g.stroke();
  }

  // 车头白色/高光装饰条
  g.fillStyle = livery.stripe;
  rrect(g, 1.25, -0.07, 1.1, 0.14, 0.07); g.fill();

  // 座舱 / 头盔
  g.fillStyle = "#0f1318";
  g.beginPath();
  g.ellipse(-0.45, 0, 0.62, 0.3, 0, 0, TAU);
  g.fill();
  g.strokeStyle = "#2b333d";
  g.lineWidth = 0.05;
  g.beginPath();
  g.ellipse(-0.45, 0, 0.6, 0.32, 0, 0, TAU);
  g.stroke();
  g.fillStyle = livery.helmet;
  g.beginPath();
  g.arc(0.12, 0, 0.2, 0, TAU);
  g.fill();
  g.fillStyle = "#1b2027";
  rrect(g, 0.2, -0.15, 0.16, 0.3, 0.05); g.fill();

  // 车身号码
  g.save();
  g.rotate(Math.PI / 2);
  g.fillStyle = livery.numColor;
  g.font = "bold 0.45px sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(car.number || livery.num, 0, 1.1);
  g.restore();

  // 前翼
  g.fillStyle = "#1c222a";
  rrect(g, 2.28, -0.92, 0.42, 1.84, 0.05); g.fill();
  g.fillStyle = livery.wing;
  rrect(g, 2.62, -0.92, 0.1, 1.84, 0.03); g.fill();
  g.fillStyle = "#1c222a";
  rrect(g, 2.22, -1.0, 0.5, 0.14, 0.04); g.fill();
  rrect(g, 2.22, 0.86, 0.5, 0.14, 0.04); g.fill();

  g.restore();
}

// 街车（量产电车超跑）车体：封闭式玻璃座舱、贯穿式尾灯、鸭尾扰流，
// 无前翼/侧箱/头盔，与 F1 开放式车体形成明显视觉区分
function drawRoadBody(g, car, livery) {
  // 轮胎（比 F1 略窄，收入轮拱）
  const tyre = (cx, cy, w, l, rot) => {
    g.save();
    g.translate(cx, cy);
    g.rotate(rot || 0);
    g.fillStyle = "#14181d";
    rrect(g, -l / 2, -w / 2, l, w, 0.09); g.fill();
    g.fillStyle = "rgba(255,255,255,.18)";
    rrect(g, -l / 2 + 0.07, -w / 2 + 0.055, l - 0.14, 0.08, 0.03); g.fill();
    g.restore();
  };
  tyre(-1.55, -0.86, 0.42, 0.72, 0);
  tyre(-1.55, 0.86, 0.42, 0.72, 0);
  tyre(1.5, -0.84, 0.38, 0.62, car.steer * 0.5);
  tyre(1.5, 0.84, 0.38, 0.62, car.steer * 0.5);

  // 车身：超跑楔形轮廓（前窄后宽的量产街车比例）
  const grad = g.createLinearGradient(0, -1, 0, 1);
  grad.addColorStop(0, livery.grad[0]);
  grad.addColorStop(0.45, livery.grad[1]);
  grad.addColorStop(1, livery.grad[2]);
  g.beginPath();
  g.moveTo(2.6, -0.38);
  g.quadraticCurveTo(2.68, 0, 2.6, 0.38);                      // 圆钝车头（前部宽 0.76m，量产车比例）
  g.bezierCurveTo(2.3, 0.56, 2.05, 0.68, 1.45, 0.78);          // 前翼子板
  g.bezierCurveTo(0.9, 0.9, 0.1, 0.94, -0.6, 0.94);
  g.bezierCurveTo(-1.3, 0.96, -2.0, 0.98, -2.4, 0.82);
  g.quadraticCurveTo(-2.55, 0.72, -2.55, 0.5);
  g.lineTo(-2.55, -0.5);
  g.quadraticCurveTo(-2.55, -0.72, -2.4, -0.82);
  g.bezierCurveTo(-2.0, -0.98, -1.3, -0.96, -0.6, -0.94);
  g.bezierCurveTo(0.1, -0.92, 0.9, -0.88, 1.45, -0.76);
  g.bezierCurveTo(2.05, -0.66, 2.3, -0.54, 2.6, -0.38);
  g.closePath();
  g.fillStyle = grad;
  g.fill();
  g.strokeStyle = "rgba(0,0,0,.4)";
  g.lineWidth = 0.035;
  g.stroke();

  // 鸭尾扰流板
  g.fillStyle = "#11151b";
  rrect(g, -2.42, -0.78, 0.28, 1.56, 0.06); g.fill();
  g.fillStyle = livery.wing;
  rrect(g, -2.48, -0.8, 0.14, 1.6, 0.06); g.fill();

  // 贯穿式尾灯（EV 标志性设计，刹车时高亮泛光）
  if (car.braking) {
    g.fillStyle = "rgba(255,69,58,.32)";
    rrect(g, -2.72, -0.95, 0.48, 1.9, 0.12); g.fill();
  }
  g.fillStyle = car.braking ? "#ff453a" : livery.wing;
  rrect(g, -2.56, -0.82, 0.16, 1.64, 0.07); g.fill();

  // 封闭式玻璃座舱
  g.fillStyle = "rgba(10,14,20,.92)";
  g.beginPath();
  g.moveTo(0.75, -0.5);
  g.quadraticCurveTo(-0.1, -0.64, -0.85, -0.58);
  g.quadraticCurveTo(-1.12, -0.52, -1.16, -0.28);
  g.lineTo(-1.16, 0.28);
  g.quadraticCurveTo(-1.12, 0.52, -0.85, 0.58);
  g.quadraticCurveTo(-0.1, 0.64, 0.75, 0.5);
  g.quadraticCurveTo(0.96, 0.32, 0.96, 0);
  g.quadraticCurveTo(0.96, -0.32, 0.75, -0.5);
  g.closePath();
  g.fill();
  g.strokeStyle = "rgba(255,255,255,.18)";
  g.lineWidth = 0.03;
  g.stroke();

  // 前大灯
  g.fillStyle = "rgba(215,238,255,.88)";
  rrect(g, 2.26, -0.44, 0.34, 0.22, 0.09); g.fill();
  rrect(g, 2.26, 0.22, 0.34, 0.22, 0.09); g.fill();

  // 引擎盖拉花
  g.fillStyle = livery.stripe;
  rrect(g, 1.0, -0.08, 1.25, 0.16, 0.08); g.fill();

  // 车身号码（与前翼子板位置一致）
  g.save();
  g.rotate(Math.PI / 2);
  g.fillStyle = livery.numColor;
  g.font = "bold 0.45px sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(car.number || livery.num, 0, 1.1);
  g.restore();
}
