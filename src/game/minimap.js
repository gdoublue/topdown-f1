// 左上角小地图：静态底图 + 镜头视野框 + 赛车位置
import { HW } from "../config.js";
import { WORLD, pts, N, nor } from "../track/geometry.js";
import { cam } from "./camera.js";

export const MINI_W = 200;
export const MINI_H = Math.round(MINI_W * WORLD.h / WORLD.w);
const MINI_S = MINI_W / WORLD.w;

let staticCv = null;
let mctx = null;

export function initMinimap() {
  staticCv = document.createElement("canvas");
  staticCv.width = MINI_W;
  staticCv.height = MINI_H;
  const m = staticCv.getContext("2d");
  m.scale(MINI_S, MINI_S);
  m.fillStyle = "#101d27";
  m.fillRect(0, 0, WORLD.w, WORLD.h);
  m.lineJoin = "round";
  m.lineCap = "round";

  const loop = () => {
    m.beginPath();
    for (let i = 0; i <= N; i++) {
      const k = i % N;
      if (i === 0) m.moveTo(pts[k].x, pts[k].y); else m.lineTo(pts[k].x, pts[k].y);
    }
    m.closePath();
  };

  m.strokeStyle = "rgba(0,0,0,.55)";
  m.lineWidth = HW * 2 + 4;
  loop(); m.stroke();
  m.strokeStyle = "#666f7c";
  m.lineWidth = HW * 2;
  loop(); m.stroke();

  m.strokeStyle = "#f5f9fd";
  m.lineWidth = 3;
  m.beginPath();
  m.moveTo(pts[0].x - nor[0].x * HW, pts[0].y - nor[0].y * HW);
  m.lineTo(pts[0].x + nor[0].x * HW, pts[0].y + nor[0].y * HW);
  m.stroke();

  mctx = document.getElementById("mini").getContext("2d");
}

export function drawMinimap(car) {
  mctx.clearRect(0, 0, MINI_W, MINI_H);
  mctx.drawImage(staticCv, 0, 0);

  // 当前镜头视野
  mctx.strokeStyle = "rgba(255,255,255,.4)";
  mctx.lineWidth = 1;
  mctx.strokeRect(
    cam.view.x * MINI_S, cam.view.y * MINI_S,
    cam.view.w * MINI_S, cam.view.h * MINI_S
  );

  // 赛车位置
  mctx.fillStyle = "#ff4a5e";
  mctx.beginPath();
  mctx.arc(car.x * MINI_S, car.y * MINI_S, 3.2, 0, Math.PI * 2);
  mctx.fill();
  mctx.lineWidth = 1.2;
  mctx.strokeStyle = "rgba(255,255,255,.95)";
  mctx.stroke();
}
