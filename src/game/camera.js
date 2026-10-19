// 跟随镜头：前瞻、动态变焦、世界边界夹取
import { ZOOM_HI, ZOOM_LO, PHYS } from "../config.js";
import { WORLD } from "../track/geometry.js";
import { clamp } from "../utils.js";

export const cam = {
  x: 0, y: 0,
  zoom: ZOOM_HI,
  view: { x: 0, y: 0, w: WORLD.w, h: WORLD.h }   // 当前视野（米），供小地图使用
};

export function resetCamera(car) {
  cam.x = car.x;
  cam.y = car.y;
  cam.zoom = ZOOM_HI;
}

export function updateCamera(car, dt) {
  const spd = Math.abs(car.speed);
  const targetZoom = ZOOM_HI - (ZOOM_HI - ZOOM_LO) * Math.min(1, spd / PHYS.maxSpeed[0]);
  cam.zoom += (targetZoom - cam.zoom) * Math.min(1, dt * 2.5);

  const look = Math.min(60, spd * 0.3);   // 前瞻约 0.3s，最多 60m
  const tx = car.x + Math.cos(car.angle) * look;
  const ty = car.y + Math.sin(car.angle) * look;
  const f = Math.min(1, dt * 4.2);
  cam.x += (tx - cam.x) * f;
  cam.y += (ty - cam.y) * f;
}

// 设置画布变换并返回视野信息
export function applyCamera(ctx, canvas, shake) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = "#173a22";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // 统一各赛道物理视野比例：基于标准参考高度解算物理米/像素，杜绝大世界赛道车辆缩成小点
  const REFERENCE_VIEW_H = 760;
  const k = (canvas.height / REFERENCE_VIEW_H) * cam.zoom;
  const viewW = canvas.width / k, viewH = canvas.height / k;
  let cx = WORLD.w >= viewW ? clamp(cam.x, viewW / 2, WORLD.w - viewW / 2) : WORLD.w / 2;
  let cy = WORLD.h >= viewH ? clamp(cam.y, viewH / 2, WORLD.h - viewH / 2) : WORLD.h / 2;
  if (shake > 0.2) {
    cx += (Math.random() - 0.5) * shake;
    cy += (Math.random() - 0.5) * shake;
  }
  cam.view.x = cx - viewW / 2;
  cam.view.y = cy - viewH / 2;
  cam.view.w = viewW;
  cam.view.h = viewH;

  ctx.setTransform(k, 0, 0, k, canvas.width / 2 - cx * k, canvas.height / 2 - cy * k);
}
