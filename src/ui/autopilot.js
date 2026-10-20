// 自动驾驶（玩家算法接管自己的车）：单人 / 对战 AI / 在线练习 / 在线房间通用。
//
// 玩家在选车面板或在线房间里打开设置，代码需定义 driver(car, out, dt, otherCars)，
// 通过 out.up / out.brake / out.steer 输出控制量。默认内容是内置 superDriver 的源码
// （直接 Function.prototype.toString 取真实实现，永远和游戏内算法保持一致）。
import {
  N, pts, nor, hw, curvS, onTrackChange,
  currentTrackId, LAP_LENGTH, HW, isLinear, kerbFlag
} from "../track/geometry.js";
import { getTrack } from "../track/tracks.js";
import {
  DS, lineX, lineY, wrapAngle, getSuperCornerCap,
  evaluateTrafficAndOvertake, superDriver
} from "../game/ai.js";
import { getApexReleaseCap } from "../game/geminiDriver.js";
import { PHYS, effectiveLaps } from "../config.js";
import { clamp } from "../utils.js";
import { CAR_LENGTH, CAR_WIDTH, getCarDistance } from "../car/physics.js";

const ON_KEY = "gp_autopilot_on";
const SRC_KEY = "gp_autopilot_src";

// 默认算法：把内置 superDriver 用 const driver 绑定。
// 入口函数名固定是 driver（不需要、也不应该叫 superDriver）。
// 生产构建会把代码压缩，superDriver.toString() 得到的源码里标识符被改写、
// 无法靠注入的同名参数运行；这种情况改用一行"直接调用内置实现"的默认源。
const RAW_SRC = superDriver.toString();
const SRC_READABLE = /\blineX\b/.test(RAW_SRC) && /\bgetSuperCornerCap\b/.test(RAW_SRC);

const DEFAULT_SOURCE = SRC_READABLE
  ? [
      "// 入口约定：必须有一个名为 driver 的函数（下面是内置 superDriver 的实现，直接绑到 driver）",
      "// driver(car, out, dt, otherCars) → 写 out.up / out.brake / out.steer 控制你的车",
      "// 全部可读字段 / 可写字段 / 工具函数：点弹窗里的「📖 参数说明」",
      "const driver = " + RAW_SRC + ";"
    ].join("\n")
  : [
      "// 入口约定：必须有一个名为 driver 的函数",
      "// 当前是压缩构建，内置算法源码已不可读，这里直接调用内置实现：",
      "// 想自定义就把 driver 改成你自己的函数，用 car / out / dt / otherCars 以及注入的赛道数据",
      "const driver = (car, out, dt, otherCars) => superDriver(car, out, dt, otherCars);"
    ].join("\n");

// 赛道元信息：全部用 getter 实时读取当前激活赛道，切换赛道后无需重新注入
const TRACK_API = {
  get id() { return currentTrackId; },
  get name() { return getTrack(currentTrackId).name; },
  get flag() { return getTrack(currentTrackId).flag; },
  get length() { return LAP_LENGTH; },                                  // 本场计算的圈长（米）
  get turns() { return getTrack(currentTrackId).turns; },
  get laps() { return effectiveLaps(getTrack(currentTrackId).laps); },  // 本场圈数
  get isLinear() { return isLinear; },                                  // 直线冲刺（不闭合）
  get N() { return N; },
  get DS() { return DS; },
  get HW() { return HW; },                                              // 基础半宽（米）
  get kerbFlag() { return kerbFlag; },                                  // 1 = 该采样点有路缘石
  // 沿赛道距离（米）→ 采样下标
  idxAt(meters) {
    const n = Math.max(1, N);
    if (isLinear) return Math.max(0, Math.min(n - 1, Math.round((meters / Math.max(1, LAP_LENGTH)) * (n - 1))));
    const base = Math.floor((meters / Math.max(0.1, LAP_LENGTH)) * n);
    return ((base % n) + n) % n;
  },
};

// 注入到玩家代码里的可用标识符（切换赛道后已重建的数组 / 表会被重新注入）
const API_PARAMS = [
  "N", "pts", "nor", "hw", "curvS", "lineX", "lineY", "DS", "PHYS",
  "clamp", "wrapAngle", "getSuperCornerCap", "evaluateTrafficAndOvertake",
  "CAR_LENGTH", "CAR_WIDTH", "getCarDistance", "superDriver", "track",
  "getApexReleaseCap"
];

let enabled = false;
let source = DEFAULT_SOURCE;
let compiled = null;
let compileError = "";
let saveTimer = 0;
const listeners = [];

function notify() {
  for (const fn of listeners) {
    try { fn(enabled); } catch (e) { console.error(e); }
  }
  refreshLabels();
}

export function onAutopilotChange(fn) { listeners.push(fn); }

export function isAutopilotOn() { return enabled; }
export function getAutopilotDriver() { return enabled ? compiled : null; }
export function getAutopilotSource() { return source; }
export function getAutopilotError() { return compileError; }

// 编译玩家算法：把游戏内部数据与工具函数作为形参注入，代码里可直接使用
function compile(src) {
  const factory = new Function(
    ...API_PARAMS,
    // 只认 driver：名字写错时直接报错，避免"代码没跑起来却悄悄用了内置算法"
    `${src}\n;return (typeof driver === "function" ? driver : null);`
  );
  const fn = factory(
    N, pts, nor, hw, curvS, lineX, lineY, DS, PHYS,
    clamp, wrapAngle, getSuperCornerCap, evaluateTrafficAndOvertake,
    CAR_LENGTH, CAR_WIDTH, getCarDistance, superDriver, TRACK_API, getApexReleaseCap
  );
  if (typeof fn !== "function") throw new Error("没有找到 driver(car, out, dt, otherCars) 函数（函数名必须是 driver）");
  return fn;
}

function recompile(silent = false) {
  try {
    compiled = compile(source);
    compileError = "";
    if (!silent) setStatus("✓ 算法编译通过", "ok");
  } catch (e) {
    compiled = null;
    compileError = e.message || String(e);
    setStatus("✗ " + compileError, "err");
  }
}

function setStatus(text, kind = "") {
  const el = document.getElementById("autopilotStatus");
  if (!el) return;
  el.textContent = text;
  el.className = "autopilot-status" + (kind ? " " + kind : "");
}

function save() {
  try {
    localStorage.setItem(ON_KEY, enabled ? "1" : "0");
    localStorage.setItem(SRC_KEY, source);
  } catch { /* 隐私模式下忽略 */ }
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 400);
}

export function refreshLabels() {
  const btn = document.getElementById("autopilotOpenBtn");
  if (btn) {
    btn.textContent = enabled ? "🤖 自动驾驶：已开启" : "🤖 自动驾驶：关闭";
    btn.classList.toggle("on", enabled);
  }
  const roomBtn = document.getElementById("roomAutopilotBtn");
  if (roomBtn) {
    roomBtn.textContent = enabled ? "🤖 自动驾驶：开" : "🤖 自动驾驶：关";
    roomBtn.classList.toggle("on", enabled);
  }
}

function emitModalChange() {
  window.dispatchEvent(new Event("modalchange"));
}

export function openAutopilot() {
  const modal = document.getElementById("autopilotModal");
  if (!modal) return;
  const code = document.getElementById("autopilotCode");
  const toggle = document.getElementById("autopilotToggle");
  if (code && code.value !== source) code.value = source;
  if (toggle) toggle.checked = enabled;
  setStatus(compileError ? "✗ " + compileError : (compiled ? "✓ 算法就绪" : ""));
  modal.classList.add("open");
  emitModalChange();
}

export function closeAutopilot() {
  const modal = document.getElementById("autopilotModal");
  if (!modal) return;
  recompile(true);          // 关面板时再兜底编一次，避免防抖还没跑完就开赛
  modal.classList.remove("open");
  emitModalChange();
}

export function toggleAutopilot(on) {
  enabled = typeof on === "boolean" ? on : !enabled;
  if (enabled) recompile(true);   // 马上开跑前用最新代码编译一次
  save();
  notify();
  const toggle = document.getElementById("autopilotToggle");
  if (toggle) toggle.checked = enabled;
  setStatus(enabled ? "已启用：本局由算法驾驶你的车" : "已关闭：交还键盘控制", enabled ? "ok" : "");
}

export function initAutopilot() {
  try {
    enabled = localStorage.getItem(ON_KEY) === "1";
    const saved = localStorage.getItem(SRC_KEY);
    if (saved && saved.trim()) source = saved;
  } catch { /* 忽略 */ }

  const modal = document.getElementById("autopilotModal");
  const code = document.getElementById("autopilotCode");
  const toggle = document.getElementById("autopilotToggle");
  if (!modal || !code) return;

  code.value = source;
  if (toggle) toggle.checked = enabled;
  recompile(true);
  setStatus(compileError ? "✗ " + compileError : "✓ 默认算法：superDriver", compileError ? "err" : "ok");

  // 编辑即编译（防抖），有错只在状态栏提示，不影响已编译的可用算法
  let timer = 0;
  code.addEventListener("input", () => {
    source = code.value;
    scheduleSave();
    clearTimeout(timer);
    timer = setTimeout(() => { recompile(); }, 400);
  });

  toggle?.addEventListener("change", () => toggleAutopilot(toggle.checked));

  document.getElementById("autopilotReset")?.addEventListener("click", () => {
    source = DEFAULT_SOURCE;
    code.value = source;
    save();
    recompile();
  });

  document.getElementById("autopilotDone")?.addEventListener("click", closeAutopilot);
  document.getElementById("closeAutopilotModal")?.addEventListener("click", closeAutopilot);
  modal.addEventListener("click", (e) => { if (e.target === modal) closeAutopilot(); });

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && modal.classList.contains("open")) {
      e.preventDefault();
      e.stopPropagation();
      closeAutopilot();
    }
  }, true);

  document.getElementById("autopilotOpenBtn")?.addEventListener("click", openAutopilot);
  refreshLabels();

  // 切换赛道后 pts/nor/hw/lineX 等被重建，必须重新注入一次
  onTrackChange(() => { if (compiled || enabled) recompile(true); });
}
