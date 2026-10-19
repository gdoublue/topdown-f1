// 实时性能调校面板：直接读写当前焦点赛车的 perf，改完立即重建 AI 速度规划表
// 影响比赛成绩的核心参数都在这里：
//   极速 / 加速 / 功率 / 起步抓地 / 刹车 / 横向抓地 / 低速转向 / 转向响应 / 弯速极限 / 高速加速
import { refreshCarPerf } from "./ai.js";

const SPECS = [
  {
    key: "vmax", label: "极速", min: 200, max: 560, step: 5,
    get: (p) => Math.round((p.maxSpeed?.[0] ?? 100) * 3.6),
    set: (p, v) => {
      const ms = v / 3.6;
      if (p.maxSpeed) p.maxSpeed[0] = ms;
      else p.maxSpeed = [ms, ms * 0.9, ms * 0.34];
    },
    fmt: (v) => v.toFixed(0) + " km/h"
  },
  {
    key: "accelMult", label: "加速系数", min: 0.6, max: 2.2, step: 0.02,
    onlyIf: (p) => p.powerKW == null,          // F1 加速曲线才吃这个系数
    get: (p) => p.accelMult ?? 1,
    set: (p, v) => { p.accelMult = v; },
    fmt: (v) => v.toFixed(2) + "×"
  },
  {
    key: "highSpeedAccel", label: "高速加速", min: 0.4, max: 2.0, step: 0.02,
    onlyIf: (p) => p.powerKW == null,          // 高速段加速倍率（F1 曲线尾部）
    get: (p) => p.highSpeedAccel ?? 1,
    set: (p, v) => { p.highSpeedAccel = v; },
    fmt: (v) => v.toFixed(2) + "×"
  },
  {
    key: "powerKW", label: "功率", min: 200, max: 2400, step: 20,
    onlyIf: (p) => p.powerKW != null,          // 电车功率限制模型
    get: (p) => p.powerKW ?? 1000,
    set: (p, v) => { p.powerKW = v; },
    fmt: (v) => v.toFixed(0) + " kW"
  },
  {
    key: "launchAccel", label: "起步抓地", min: 8, max: 20, step: 0.1,
    onlyIf: (p) => p.launchAccel != null,
    get: (p) => p.launchAccel ?? 14,
    set: (p, v) => { p.launchAccel = v; },
    fmt: (v) => v.toFixed(1) + " m/s²"
  },
  {
    key: "brakeMult", label: "刹车", min: 0.2, max: 2.4, step: 0.02,
    get: (p) => p.brakeMult ?? 1,
    set: (p, v) => { p.brakeMult = v; },
    fmt: (v) => v.toFixed(2) + "×"
  },
  {
    key: "latGrip", label: "横向抓地", min: 8, max: 60, step: 0.5,
    get: (p) => p.latGrip ?? 45,
    set: (p, v) => { p.latGrip = v; },
    fmt: (v) => v.toFixed(1) + " m/s²"
  },
  {
    key: "maxOmega", label: "低速转向", min: 1.2, max: 4.6, step: 0.05,
    get: (p) => p.maxOmega ?? 3.4,
    set: (p, v) => { p.maxOmega = v; },
    fmt: (v) => v.toFixed(2) + " rad/s"
  },
  {
    key: "steerRate", label: "转向响应", min: 5, max: 20, step: 0.5,
    get: (p) => p.steerRate ?? 11,
    set: (p, v) => { p.steerRate = v; },
    fmt: (v) => v.toFixed(1)
  },
  {
    key: "cornerGripMult", label: "弯速极限", min: 0.8, max: 1.15, step: 0.01,
    get: (p) => p.cornerGripMult ?? 1,
    set: (p, v) => { p.cornerGripMult = v; },
    fmt: (v) => (v * 100).toFixed(0) + "%"
  }
];

// 原始配置快照（按赛车 id 保存），用于「恢复默认」
const DEFAULTS = new Map();
let currentCar = null;

function snapshot(perf) {
  const copy = { ...perf };
  if (perf.maxSpeed) copy.maxSpeed = [...perf.maxSpeed];
  return copy;
}

function buildRows(car) {
  const grid = document.getElementById("tuneGrid");
  const nameEl = document.getElementById("tuneCarName");
  if (nameEl) nameEl.textContent = car.shortName || car.name || "CAR";
  if (!grid) return;

  const perf = car.perf || (car.perf = {});
  grid.innerHTML = "";
  for (const spec of SPECS) {
    if (spec.onlyIf && !spec.onlyIf(perf)) continue;

    const row = document.createElement("div");
    row.className = "tune-row";

    const label = document.createElement("span");
    label.className = "tune-label";
    label.textContent = spec.label;

    const input = document.createElement("input");
    input.type = "range";
    input.min = String(spec.min);
    input.max = String(spec.max);
    input.step = String(spec.step);
    input.value = String(spec.get(perf));

    const val = document.createElement("span");
    val.className = "tune-val";
    val.textContent = spec.fmt(Number(input.value));

    input.addEventListener("input", () => {
      const v = Number(input.value);
      spec.set(perf, v);
      val.textContent = spec.fmt(v);
      refreshCarPerf(car);          // 立即重建弯速表 / 目标速度表
    });

    row.append(label, input, val);
    grid.appendChild(row);
  }
}

export function syncTuner(car) {
  if (!car || car === currentCar) return;
  currentCar = car;
  if (!DEFAULTS.has(car.id)) DEFAULTS.set(car.id, snapshot(car.perf || {}));
  buildRows(car);
}

export function initTuner() {
  const btn = document.getElementById("tuneToggle");
  const panel = document.getElementById("tunePanel");
  if (btn && panel) {
    btn.addEventListener("click", () => {
      const open = panel.classList.toggle("open");
      btn.classList.toggle("active", open);
    });
  }

  const reset = document.getElementById("tuneReset");
  if (reset) {
    reset.addEventListener("click", () => {
      const car = currentCar;
      const def = car && DEFAULTS.get(car.id);
      if (!car || !def) return;
      const perf = car.perf || (car.perf = {});
      // 清掉调校时新增的字段，再把原始值写回（保持 perf 对象引用不变）
      for (const k of Object.keys(perf)) {
        if (!(k in def)) delete perf[k];
      }
      for (const k of Object.keys(def)) {
        perf[k] = k === "maxSpeed" && def[k] ? [...def[k]] : def[k];
      }
      refreshCarPerf(car);
      buildRows(car);
    });
  }
}
