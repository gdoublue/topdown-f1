// 自动驾驶（玩家算法接管自己的车）：单人 / 对战 AI / 在线练习 / 在线房间通用。
//
// 玩家在选车面板或在线房间里打开设置，代码需定义 driver(car, out, dt, otherCars)，
// 通过 out.up / out.brake / out.steer 输出控制量。默认内容是内置 superDriver 的源码
// （直接 Function.prototype.toString 取真实实现，永远和游戏内算法保持一致）。
import {
  N, pts, nor, hw, curvS, grade, onTrackChange, indexAtDistance,
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
  // 沿赛道物理距离（米）→ 最近采样下标（按 cumDist 精确换算，误差 ≤1 个点）
  // 环形自动取模、直线自动钳制；不能用 round(米/DS)，采样点不是按米均匀的
  idxAt(meters) {
    return indexAtDistance(meters);
  },
};

// 注入到玩家代码里的可用标识符（切换赛道后已重建的数组 / 表会被重新注入）
// 导出给无头台架 scripts/autopilot-bench.mjs：保证"游戏内能用的东西"和"台架里能用的东西"只有一份定义
export const API_PARAMS = [
  "N", "pts", "nor", "hw", "curvS", "grade", "lineX", "lineY", "DS", "PHYS",
  "clamp", "wrapAngle", "getSuperCornerCap", "evaluateTrafficAndOvertake",
  "CAR_LENGTH", "CAR_WIDTH", "getCarDistance", "superDriver", "track",
  "getApexReleaseCap"
];

// 赛道元信息 API 也导出，台架直接复用同一份 getter / idxAt。
// 冻结：算法只能读，不能往上挂东西（getter 属性没有 setter，赋值会静默失败）
Object.freeze(TRACK_API);
export { TRACK_API };

/* ===================== 注入给算法的世界（全部是副本） =====================
   算法拿到的 pts / hw / lineX / PHYS 都是副本：
   即使它乱写，也污染不到引擎、同场 AI、以及后续编译。
   换赛道本来就会重新编译，所以"副本"不影响任何合法用法。
*/
const freezePoint = (p) => Object.freeze({ x: p.x, y: p.y });

function buildPhysCopy() {
  return Object.freeze({
    ...PHYS,
    maxSpeed: Object.freeze([...PHYS.maxSpeed]),
    accelCurve: Object.freeze(PHYS.accelCurve.map((row) => Object.freeze([...row]))),
  });
}

// 与 DRIVER_PARAMS 一一对应（注入数据在前，被遮蔽的宿主全局在后 = undefined）。
// 导出给无头台架，保证两边注入的是同一份东西。
// copy=false 只给台架的 --raw（复现加固前"直接注入引擎真实数组"的行为，用于审计）
export function createAutopilotApiValues(copy = true) {
  const values = [
    N,
    copy ? pts.map(freezePoint) : pts,
    copy ? nor.map(freezePoint) : nor,
    copy ? hw.slice() : hw,
    copy ? curvS.slice() : curvS,
    copy ? grade.slice() : grade,
    copy ? lineX.slice() : lineX,
    copy ? lineY.slice() : lineY,
    DS,
    copy ? buildPhysCopy() : PHYS,
    clamp,
    wrapAngle,
    getSuperCornerCap,
    evaluateTrafficAndOvertake,
    CAR_LENGTH,
    CAR_WIDTH,
    getCarDistance,
    superDriver,
    TRACK_API,
    getApexReleaseCap,
  ];
  for (let i = 0; i < BLOCKED_GLOBALS.length; i++) values.push(undefined);
  return values;
}

/* ===================== 宿主全局屏蔽 =====================
   把这些名字做成驱动的【形参】（值一律 undefined）：函数作用域里的形参优先于全局，
   于是算法里写 window / localStorage / fetch / __gp 都只会拿到 undefined。
   为什么不用 with + Proxy：with 会让算法里每一次标识符查找都过一遍代理，
   重型算法（比如建赛车线的几千万次内层循环）会因此慢 10 倍；形参遮蔽是零开销的。

   注意：这不是安全沙箱（`({}).constructor.constructor` 之类的刻意逃逸仍可能拿到全局，
   而且 `this` 也不是绝对可靠），它挡的是"顺手就用宿主 API"的常规写法。
   真正影响公平性的两层是：driveAI 传只读视图 + 注入数据全是副本。
*/
export const BLOCKED_GLOBALS = [
  "window", "document", "localStorage", "sessionStorage", "indexedDB", "caches",
  "cookieStore", "fetch", "XMLHttpRequest", "WebSocket", "EventSource",
  "Worker", "SharedWorker", "serviceWorker", "navigator", "location", "history",
  "screen", "top", "parent", "self", "globalThis", "frames", "opener",
  "postMessage", "importScripts", "Function", "setTimeout", "setInterval",
  "clearTimeout", "clearInterval", "requestAnimationFrame", "cancelAnimationFrame",
  "__gp", "WebAssembly",
];

// 驱动的完整形参表：注入数据 + 被遮蔽的宿主全局
export const DRIVER_PARAMS = [...API_PARAMS, ...BLOCKED_GLOBALS];

// 工厂源码：游戏（new Function）和台架（vm）共用同一份，语义不会漂移
export function autopilotFactoryCode(src) {
  return `return function(${DRIVER_PARAMS.join(",")}){\n`
    + `${src}\n`
    + `;return (typeof driver === "function" ? driver : null);\n}`;
}

const NO_DRIVER_MSG = "没有找到 driver(car, out, dt, otherCars) 函数（函数名必须是 driver）";

// 与游戏内完全一致的编译入口（new Function + 同一份注入），供台架 / 工具复用
export function compileAutopilotSource(src) {
  return compile(src);
}

let enabled = false;
let source = DEFAULT_SOURCE;
let compiled = null;      // 当前源码的编译结果（失败时为 null）
let lastGood = null;      // 最近一次编译成功的算法：改错代码时车继续用它
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
// 编译失败时返回上一次成功的算法（从未成功过才返回 null → 退回该车内置 AI）
export function getAutopilotDriver() { return enabled ? (compiled || lastGood) : null; }
export function getAutopilotSource() { return source; }
export function getAutopilotError() { return compileError; }

// 编译玩家算法：注入副本数据 + 形参，代码里可直接使用
// 只认 driver：名字写错时直接报错，避免"代码没跑起来却悄悄用了内置算法"
function compile(src) {
  // 两次调用：第一次拿到"绑定形参的包装函数"，第二次执行玩家源码、取出 driver
  const factory = new Function(autopilotFactoryCode(src));
  const fn = factory()(...createAutopilotApiValues());
  if (typeof fn !== "function") throw new Error(NO_DRIVER_MSG);
  return fn;
}

function recompile(silent = false) {
  try {
    compiled = compile(source);
    lastGood = compiled;
    compileError = "";
    if (!silent) setStatus("✓ 算法编译通过", "ok");
    // 调试入口的关键：编译通过就广播一次，让在线对战（netrace 持有算法引用）
    // 也能立刻换成新版本，而不是要玩家手动关一次再开一次
    if (enabled) notify();
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
  // 比赛页面上的常驻开关（顶栏胶囊）
  const pill = document.getElementById("autopilotPill");
  if (pill) {
    pill.textContent = enabled ? "🤖 自动驾驶：开" : "🤖 自动驾驶：关";
    pill.classList.toggle("on", enabled);
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

// persist=false：只改本局状态，不写 localStorage。
// 用在"换视角自动接管"这种临时场景 —— 不能把玩家的长期偏好改成开启。
export function toggleAutopilot(on, { persist = true } = {}) {
  enabled = typeof on === "boolean" ? on : !enabled;
  if (enabled) recompile(true);   // 马上开跑前用最新代码编译一次
  if (persist) save();
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
  const isDefault = source === DEFAULT_SOURCE;
  setStatus(
    compileError
      ? "✗ " + compileError
      : (isDefault ? "✓ 默认算法 superDriver 已就绪" : "✓ 已加载本地保存的自定义算法"),
    compileError ? "err" : "ok"
  );

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
