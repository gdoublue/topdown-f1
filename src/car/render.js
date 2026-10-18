// 赛车渲染：以“米”为单位绘制（车宽 2m、车长 5.6m），再按 M 缩放到世界
import { M } from "../config.js";
import { TAU, rrect } from "../utils.js";

export function drawCar(g, car) {
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

  // 尾翼
  g.fillStyle = "#1c222a";
  rrect(g, -2.82, -0.74, 0.5, 1.48, 0.06); g.fill();
  g.fillStyle = "#e13b46";
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
  grad.addColorStop(0, "#ff7078");
  grad.addColorStop(0.42, "#e6303f");
  grad.addColorStop(1, "#a81a29");
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
    g.fillStyle = "#c82636";
    g.fill();
    g.strokeStyle = "rgba(255,255,255,.22)";
    g.lineWidth = 0.025;
    g.stroke();
  }

  // 车头白色装饰条
  g.fillStyle = "rgba(255,255,255,.8)";
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
  g.fillStyle = "#ffd166";
  g.beginPath();
  g.arc(0.12, 0, 0.2, 0, TAU);
  g.fill();
  g.fillStyle = "#1b2027";
  rrect(g, 0.2, -0.15, 0.16, 0.3, 0.05); g.fill();

  // 前翼
  g.fillStyle = "#1c222a";
  rrect(g, 2.28, -0.92, 0.42, 1.84, 0.05); g.fill();
  g.fillStyle = "#e13b46";
  rrect(g, 2.62, -0.92, 0.1, 1.84, 0.03); g.fill();
  g.fillStyle = "#1c222a";
  rrect(g, 2.22, -1.0, 0.5, 0.14, 0.04); g.fill();
  rrect(g, 2.22, 0.86, 0.5, 0.14, 0.04); g.fill();

  g.restore();
}
