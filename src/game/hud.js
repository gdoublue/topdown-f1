// HUD：面板数值刷新与中央提示
import { TOTAL_LAPS, M } from "../config.js";
import { race } from "./race.js";

const el = {};
let msgTimer = 0;

export function initHud() {
  for (const id of ["lap", "time", "best", "last", "speed", "msg", "msgMain", "msgSub"]) {
    el[id] = document.getElementById(id);
  }
}

function setText(node, v) {
  if (node._v !== v) { node._v = v; node.textContent = v; }
}

export function fmt(ms) {
  if (ms == null || !isFinite(ms)) return "--:--.--";
  const t = Math.max(0, ms);
  const m = Math.floor(t / 60000);
  const s = Math.floor(t / 1000) % 60;
  const cs = Math.floor(t / 10) % 100;
  return m + ":" + String(s).padStart(2, "0") + "." + String(cs).padStart(2, "0");
}

export function showMsg(main, sub, dur) {
  el.msgMain.textContent = main;
  el.msgSub.textContent = sub || "";
  el.msg.classList.add("show");
  msgTimer = dur ? performance.now() + dur : 0;
}

export function hideMsg(force) {
  el.msg.classList.remove("show");
  if (force) { el.msgMain.textContent = ""; el.msgSub.textContent = ""; }
  msgTimer = 0;
}

export function msgText() {
  return el.msgMain.textContent;
}

// msgTimer 到期自动隐藏（完赛提示常驻）
export function tickMsg(now) {
  if (msgTimer && now > msgTimer && race.state !== "finished") hideMsg(false);
}

export function updateHUD(car) {
  // 速度换算：世界单位/秒 → km/h（1m = M 单位）
  setText(el.speed, String(Math.round(Math.abs(car.speed) / M * 3.6)));
  setText(el.lap, Math.min(race.lap, TOTAL_LAPS) + "/" + TOTAL_LAPS);
  let t = 0;
  if (race.state === "racing") t = performance.now() - race.raceStart;
  else if (race.state === "finished") t = race.total;
  setText(el.time, fmt(t));
  setText(el.best, fmt(race.best));
  setText(el.last, fmt(race.last));
}
