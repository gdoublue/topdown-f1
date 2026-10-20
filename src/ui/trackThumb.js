// 赛道缩略图：选赛道时给每张卡片画一张小地图。
// createTrackContext 是纯函数（不会切换当前激活赛道），结果按 trackId 缓存。
import { createTrackContext } from "../track/geometry.js";

const CACHE = new Map();
const W = 264, H = 96, DPR = 2;

export function trackThumbUrl(trackId) {
  if (CACHE.has(trackId)) return CACHE.get(trackId);
  let url = "";
  try { url = render(trackId); } catch (e) { url = ""; }
  CACHE.set(trackId, url);
  return url;
}

function render(trackId) {
  const t = createTrackContext(trackId);
  const cv = document.createElement("canvas");
  cv.width = W * DPR;
  cv.height = H * DPR;
  const g = cv.getContext("2d");
  g.scale(DPR, DPR);

  g.fillStyle = "#070c14";
  g.fillRect(0, 0, W, H);

  const pad = 9;
  const s = Math.min((W - pad * 2) / Math.max(1, t.WORLD.w), (H - pad * 2) / Math.max(1, t.WORLD.h));
  g.save();
  g.translate((W - t.WORLD.w * s) / 2, (H - t.WORLD.h * s) / 2);
  g.scale(s, s);
  g.lineJoin = "round";
  g.lineCap = "round";

  const loop = () => {
    g.beginPath();
    const last = t.isLinear ? t.N - 1 : t.N;
    for (let i = 0; i <= last; i++) {
      const k = t.isLinear ? Math.min(i, t.N - 1) : i % t.N;
      if (i === 0) g.moveTo(t.pts[k].x, t.pts[k].y);
      else g.lineTo(t.pts[k].x, t.pts[k].y);
    }
    if (!t.isLinear) g.closePath();
  };

  // 缩略图里赛道很短时，按固定屏幕像素兜底，否则细到看不见
  const band = Math.max(t.HW * 2, 4.6 / s);

  // 外描边（草地 / 路肩边界）
  g.strokeStyle = "rgba(0,0,0,.8)";
  g.lineWidth = band + Math.max(1.6 / s, 1.6);
  loop(); g.stroke();

  // 沥青
  g.strokeStyle = "#6b7686";
  g.lineWidth = band;
  loop(); g.stroke();

  // 中心线
  g.strokeStyle = "rgba(255,255,255,.22)";
  g.lineWidth = Math.max(0.7 / s, 0.8);
  loop(); g.stroke();

  // 起终点线
  const tick = Math.max(t.HW, 3.2 / s);
  g.strokeStyle = "#f8fafc";
  g.lineWidth = Math.max(1.4 / s, 1.4);
  g.beginPath();
  g.moveTo(t.pts[0].x - t.nor[0].x * tick, t.pts[0].y - t.nor[0].y * tick);
  g.lineTo(t.pts[0].x + t.nor[0].x * tick, t.pts[0].y + t.nor[0].y * tick);
  g.stroke();

  g.restore();
  return cv.toDataURL("image/png");
}
