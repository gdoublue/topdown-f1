// 左上角小地图：统一固定尺寸、自适应等比例居中、镜头视野框、赛车位置
import { HW } from "../config.js";
import { WORLD, pts, N, nor, currentTrack, isLinear } from "../track/geometry.js";
import { cam } from "./camera.js";

export const MINI_W = 210;
export const MINI_H = 135;

let miniScale = 1;
let miniOffX = 0;
let miniOffY = 0;
let staticCv = null;
let mctx = null;

export function initMinimap() {
  const miniCanvas = document.getElementById("mini");
  if (miniCanvas) {
    miniCanvas.width = MINI_W;
    miniCanvas.height = MINI_H;
  }

  const miniTrackName = document.getElementById("miniTrackName");
  if (miniTrackName && currentTrack) {
    miniTrackName.textContent = currentTrack.flag + " " + currentTrack.name;
  }

  // 严格等比例居中计算：不论赛道是细长形还是方形，均保持 1:1 物理比例居中，绝不拉伸挤压
  const PAD = 10;
  const availW = MINI_W - PAD * 2;
  const availH = MINI_H - PAD * 2;
  miniScale = Math.min(availW / Math.max(1, WORLD.w), availH / Math.max(1, WORLD.h));
  miniOffX = PAD + (availW - WORLD.w * miniScale) / 2;
  miniOffY = PAD + (availH - WORLD.h * miniScale) / 2;

  staticCv = document.createElement("canvas");
  staticCv.width = MINI_W;
  staticCv.height = MINI_H;
  const m = staticCv.getContext("2d");

  // 统一深邃碳纤维暗底
  m.fillStyle = "#070c14";
  m.fillRect(0, 0, MINI_W, MINI_H);

  m.save();
  m.translate(miniOffX, miniOffY);
  m.scale(miniScale, miniScale);
  m.lineJoin = "round";
  m.lineCap = "round";

  const loop = () => {
    m.beginPath();
    const last = isLinear ? N - 1 : N;
    for (let i = 0; i <= last; i++) {
      const k = isLinear ? Math.min(i, N - 1) : i % N;
      if (i === 0) m.moveTo(pts[k].x, pts[k].y); else m.lineTo(pts[k].x, pts[k].y);
    }
    if (!isLinear) m.closePath();
  };

  // 外路肩/草地交界外框
  m.strokeStyle = "rgba(0,0,0,0.65)";
  m.lineWidth = HW * 2 + 6;
  loop(); m.stroke();

  // 沥青路面
  m.strokeStyle = "#475569";
  m.lineWidth = HW * 2;
  loop(); m.stroke();

  // 赛道中心指引浅线
  m.strokeStyle = "rgba(255,255,255,0.22)";
  m.lineWidth = 1.2;
  loop(); m.stroke();

  // 起终点线
  m.strokeStyle = "#f8fafc";
  m.lineWidth = 3.5;
  m.beginPath();
  m.moveTo(pts[0].x - nor[0].x * HW, pts[0].y - nor[0].y * HW);
  m.lineTo(pts[0].x + nor[0].x * HW, pts[0].y + nor[0].y * HW);
  m.stroke();

  // 线性赛道：终点决胜线（棋盘格双色）
  if (isLinear) {
    m.strokeStyle = "#ffd166";
    m.beginPath();
    m.moveTo(pts[N - 1].x - nor[N - 1].x * HW, pts[N - 1].y - nor[N - 1].y * HW);
    m.lineTo(pts[N - 1].x + nor[N - 1].x * HW, pts[N - 1].y + nor[N - 1].y * HW);
    m.stroke();
  }

  m.restore();

  const el = document.getElementById("mini");
  if (el) mctx = el.getContext("2d");
}

export function drawMinimap(cars, activeIdx = 0) {
  if (!mctx || !staticCv) return;
  mctx.clearRect(0, 0, MINI_W, MINI_H);
  mctx.drawImage(staticCv, 0, 0);

  // 镜头视野框 (等比例投射)
  mctx.strokeStyle = "rgba(0, 229, 255, 0.55)";
  mctx.lineWidth = 1.2;
  mctx.strokeRect(
    miniOffX + cam.view.x * miniScale,
    miniOffY + cam.view.y * miniScale,
    cam.view.w * miniScale,
    cam.view.h * miniScale
  );

  // 赛车位置标记 (像素空间精确渲染，避免极小/极大)
  const carList = Array.isArray(cars) ? cars : [cars];
  for (let i = 0; i < carList.length; i++) {
    const c = carList[i];
    if (!c || c.retired) continue;
    const isFollow = i === activeIdx;
    const px = miniOffX + c.x * miniScale;
    const py = miniOffY + c.y * miniScale;
    const color = c.color || (c.livery === "redbull" ? "#00b4d8" : c.livery === "aston" ? "#10b981" : c.livery === "mercedes" ? "#e2e8f0" : c.livery === "su7ultra" ? "#f5c518" : c.livery === "yangwang" ? "#f59e0b" : "#ff3b3b");

    mctx.fillStyle = color;
    mctx.beginPath();
    mctx.arc(px, py, isFollow ? 4.2 : 3.0, 0, Math.PI * 2);
    mctx.fill();

    mctx.lineWidth = isFollow ? 1.6 : 0.9;
    mctx.strokeStyle = isFollow ? "#ffffff" : "rgba(0,0,0,0.8)";
    mctx.stroke();
  }
}
