// 加速测试台：复用游戏的纵向物理（stepLongitudinal / drawCar），
// 在 2.5km 直道上可视化速度、加速度、0-50/100/200/300 km/h 计时与轮胎印
import { PHYS } from "../config.js";
import { drawCar } from "../car/render.js";
import { stepLongitudinal } from "../car/physics.js";
import { initInput, input } from "../game/input.js";

/* ---------- 测试台状态 ---------- */
const STRIP = 2500;                 // 直道长度（米）
const ROAD_HW = 7;                  // 路面半宽 7m（14m）
const START_X = 50;

const car = {
  x: START_X, y: 0, angle: 0,
  speed: 0, accel: 0, braking: false, steer: 0
};

let surf = 0;                       // 0 沥青 2 草地
const btn = { j: false, k: false, l: false };

const GATES = [
  { kmh: 50, v: 50 / 3.6, id: "g50", time: null, abs: null, best: null },
  { kmh: 100, v: 100 / 3.6, id: "g100", time: null, abs: null, best: null },
  { kmh: 200, v: 200 / 3.6, id: "g200", time: null, abs: null, best: null },
  { kmh: 300, v: 300 / 3.6, id: "g300", time: null, abs: null, best: null },
  { kmh: 350, v: 350 / 3.6, id: "g350", time: null, abs: null, best: null }
];

let launchT = null;                 // 本次起步的计时起点（秒，测试台时钟）
let clock = 0;                      // 测试台累计时钟
const samples = [];                 // {t, v} 速度曲线采样
const skids = [];                   // 轮胎印 {x, y1, y2}

/* ---------- DOM ---------- */
const view = document.getElementById("view");
const vctx = view.getContext("2d");
const chart = document.getElementById("chart");
const cctx = chart.getContext("2d");
const el = {
  speed: document.getElementById("speedBig"),
  accel: document.getElementById("accelBox"),
  marks: document.getElementById("marks"),
  dist: document.getElementById("dist")
};
const gateEls = {};
for (const g of GATES) gateEls[g.kmh] = document.getElementById(g.id);

/* ---------- 输入：键盘 + 屏幕按钮 ---------- */
const keyState = { j: false, k: false, l: false };
function bindHold(id, on, off) {
  const b = document.getElementById(id);
  b.addEventListener("pointerdown", e => { e.preventDefault(); b.classList.add("on"); on(); });
  const end = () => { b.classList.remove("on"); off(); };
  b.addEventListener("pointerup", end);
  b.addEventListener("pointerleave", end);
}
bindHold("bJ", () => btn.j = true, () => btn.j = false);
bindHold("bK", () => btn.k = true, () => btn.k = false);
bindHold("bL", () => btn.l = true, () => btn.l = false);

document.getElementById("bSurf").addEventListener("click", function () {
  surf = surf === 0 ? 2 : 0;
  this.textContent = surf === 0 ? "路面：沥青" : "路面：草地";
});
document.getElementById("bReset").addEventListener("click", reset);
initInput(reset);

function reset() {
  car.x = START_X; car.speed = 0; car.accel = 0; car.braking = false;
  launchT = null;
  samples.length = 0;
  skids.length = 0;
  for (const g of GATES) { g.time = null; g.abs = null; }
}

/* ---------- 模拟 ---------- */
function step(dt) {
  const eff = {
    up: input.up || btn.j,
    brake: Math.max(input.brake, btn.k ? 1 : 0, btn.l ? 2 : 0),
    left: false, right: false
  };

  const wasStopped = Math.abs(car.speed) < 0.3;
  stepLongitudinal(car, dt, eff, surf);
  car.x += car.speed * dt;
  if (car.x > STRIP) { car.x = STRIP; car.speed = 0; }
  if (car.x < 2) { car.x = 2; car.speed = Math.max(0, car.speed); }

  clock += dt;

  // 起步计时：静止状态下踩下油门即开始
  if (launchT === null && wasStopped && eff.up && eff.brake === 0) launchT = clock;
  const elapsed = launchT === null ? 0 : clock - launchT;

  // 闯过速度门
  for (const g of GATES) {
    if (launchT !== null && g.time === null && car.speed >= g.v) {
      g.time = elapsed;
      g.abs = clock;                 // 曲线上标记用（绝对时钟）
      if (g.best == null || g.time < g.best) g.best = g.time;
    }
  }

  // 轮胎印：|纵向加速度| > 1g
  if (Math.abs(car.accel) > PHYS.skidG && Math.abs(car.speed) > 3) {
    skids.push({ x: car.x - 1.75, y1: 0.79, y2: -0.79 });
    if (skids.length > 2400) skids.splice(0, 40);
  }

  // 曲线采样（超长时抽稀）
  samples.push({ t: clock, v: Math.abs(car.speed) * 3.6 });
  if (samples.length > 4800) {
    const dec = [];
    for (let i = 0; i < samples.length; i += 2) dec.push(samples[i]);
    samples.length = 0;
    samples.push(...dec);
  }

  return elapsed;
}

/* ---------- 绘制：直道视图 ---------- */
function drawView() {
  const S = view.width / 190;                 // 视野约 190m
  const camX = clamp(car.x - 55, 0, STRIP - view.width / S);
  const midY = view.height * 0.55;

  vctx.setTransform(1, 0, 0, 1, 0, 0);
  vctx.fillStyle = "#2f8d4a";
  vctx.fillRect(0, 0, view.width, view.height);

  vctx.setTransform(S, 0, 0, S, -camX * S, 0);
  vctx.lineJoin = "round";

  // 路面
  vctx.fillStyle = "#484e58";
  vctx.fillRect(0, -ROAD_HW, STRIP, ROAD_HW * 2);
  vctx.strokeStyle = "rgba(0,0,0,.16)";
  vctx.lineWidth = 2;
  vctx.strokeRect(0, -ROAD_HW, STRIP, ROAD_HW * 2);

  // 白色边线
  vctx.strokeStyle = "rgba(240,246,252,.92)";
  vctx.lineWidth = 0.35;
  vctx.beginPath();
  vctx.moveTo(0, -ROAD_HW + 0.45); vctx.lineTo(STRIP, -ROAD_HW + 0.45);
  vctx.moveTo(0, ROAD_HW - 0.45); vctx.lineTo(STRIP, ROAD_HW - 0.45);
  vctx.stroke();

  // 距离标尺（每 50m 一道横线 + 标签）
  vctx.strokeStyle = "rgba(255,255,255,.28)";
  vctx.lineWidth = 0.25;
  for (let m = 0; m <= STRIP; m += 50) {
    vctx.beginPath();
    vctx.moveTo(m, -ROAD_HW); vctx.lineTo(m, ROAD_HW);
    vctx.stroke();
  }

  // 起点格子线
  for (let r = 0; r < 2; r++) {
    for (let c = 0; c < 10; c++) {
      vctx.fillStyle = ((r + c) % 2 === 0) ? "#f5f9fd" : "#181c22";
      vctx.fillRect(START_X - 1.5 + r * 1.5, -ROAD_HW + c * (ROAD_HW * 2 / 10), 1.55, ROAD_HW * 2 / 10 + 0.05);
    }
  }

  // 轮胎印
  vctx.strokeStyle = "rgba(24,26,30,.45)";
  vctx.lineWidth = 0.4;
  vctx.beginPath();
  for (const s of skids) {
    vctx.moveTo(s.x, s.y1);
    vctx.lineTo(s.x + 0.35, s.y1);
    vctx.moveTo(s.x, s.y2);
    vctx.lineTo(s.x + 0.35, s.y2);
  }
  vctx.stroke();

  // 赛车
  drawCar(vctx, car);

  // 标签（屏幕空间）
  vctx.setTransform(1, 0, 0, 1, 0, 0);
  vctx.fillStyle = "rgba(232,238,247,.75)";
  vctx.font = "11px 'Courier New', monospace";
  for (let m = Math.ceil(camX / 100) * 100; m < camX + view.width / S; m += 100) {
    vctx.fillText(m + " m", (m - camX) * S + 4, midY - ROAD_HW * S - 6);
  }
  vctx.fillStyle = "rgba(255,209,102,.9)";
  vctx.fillText("油门 J · 轻刹 K · 重刹 L", 8, 16);
}

/* ---------- 绘制：速度-时间曲线 ---------- */
function drawChart(elapsed) {
  const w = chart.width, h = chart.height;
  const padL = 54, padB = 26, padT = 14;
  cctx.setTransform(1, 0, 0, 1, 0, 0);
  cctx.clearRect(0, 0, w, h);

  const T = Math.max(15, Math.ceil(elapsed / 5) * 5);
  const vmax = 385;
  const X = t => padL + (w - padL - 12) * (t / T);
  const Y = v => h - padB - (h - padB - padT) * (v / vmax);

  // 网格
  cctx.font = "11px 'Courier New', monospace";
  for (let v = 0; v <= 350; v += 50) {
    cctx.strokeStyle = v === 100 || v === 200 || v === 300 || v === 350
      ? "rgba(255,209,102,.45)" : "rgba(160,200,240,.14)";
    cctx.beginPath();
    cctx.moveTo(padL, Y(v)); cctx.lineTo(w - 12, Y(v));
    cctx.stroke();
    cctx.fillStyle = "#8aa2ba";
    cctx.fillText(v + "", 12, Y(v) + 4);
  }
  for (let t = 0; t <= T; t += 5) {
    cctx.strokeStyle = "rgba(160,200,240,.10)";
    cctx.beginPath();
    cctx.moveTo(X(t), padT); cctx.lineTo(X(t), h - padB);
    cctx.stroke();
    cctx.fillStyle = "#8aa2ba";
    cctx.fillText(t + "s", X(t) - 6, h - 8);
  }

  // 速度曲线
  if (samples.length > 1) {
    cctx.strokeStyle = "#7dff9b";
    cctx.lineWidth = 2;
    cctx.beginPath();
    for (let i = 0; i < samples.length; i++) {
      const p = samples[i];
      if (i === 0) cctx.moveTo(X(p.t), Y(p.v)); else cctx.lineTo(X(p.t), Y(p.v));
    }
    cctx.stroke();
  }

  // 门限圆点
  for (const g of GATES) {
    if (g.time == null) continue;
    cctx.fillStyle = "#ffd166";
    cctx.beginPath();
    cctx.arc(X(g.abs), Y(g.kmh), 4, 0, Math.PI * 2);
    cctx.fill();
    cctx.fillStyle = "#ffd166";
    cctx.fillText(g.time.toFixed(2) + "s", X(g.abs) + 6, Y(g.kmh) - 4);
  }
}

/* ---------- 读数 ---------- */
function updateReadouts() {
  el.speed.textContent = (Math.abs(car.speed) * 3.6).toFixed(1);
  const g = car.accel / 9.81;
  el.accel.textContent = (g >= 0 ? "+" : "") + g.toFixed(2) + " g";
  const marking = Math.abs(car.accel) > PHYS.skidG && Math.abs(car.speed) > 3;
  el.marks.textContent = marking ? "轮胎印：有" : "轮胎印：无";
  el.marks.classList.toggle("off", !marking);
  el.dist.textContent = Math.max(0, Math.round(car.x - START_X)) + " m";

  for (const gate of GATES) {
    const row = gateEls[gate.kmh];
    const cell = row.querySelector(".t");
    const txt = gate.time == null ? "—" : gate.time.toFixed(2) + "s";
    if (cell.textContent !== txt) cell.textContent = txt;
    row.classList.toggle("done", gate.time != null);
  }
}

/* ---------- 主循环 ---------- */
let prevTs = 0;
function frame(ts) {
  requestAnimationFrame(frame);
  if (!prevTs) prevTs = ts;
  const dt = clamp((ts - prevTs) / 1000, 0.001, 0.05);
  prevTs = ts;

  const elapsed = step(dt);
  drawView();
  drawChart(launchT === null ? 0 : elapsed);
  updateReadouts();
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

reset();
requestAnimationFrame(frame);
