// 自动驾驶（玩家算法接管自己的车）：单人 / 对战 AI / 在线练习 / 在线房间通用。
//
// 默认算法：内置 superDriver（最速 F1 出弯，开箱即用，无需显示复杂长代码）。
// 支持在下拉框中自由切换多种内置算法，支持直接导入 / 导出算法代码文件。
// 仅在选择“自定义手写算法”时才展示完整代码编辑器供自由编写。
import {
  N, pts, nor, hw, curvS, grade, onTrackChange, indexAtDistance,
  currentTrackId, LAP_LENGTH, HW, isLinear, kerbFlag
} from "../track/geometry.js";
import { getTrack } from "../track/tracks.js";
import {
  DS, lineX, lineY, wrapAngle, getSuperCornerCap,
  evaluateTrafficAndOvertake, superDriver,
  driveApexHunter, driveVectorPursuit, driveClassicBaseline, driveSmoothCruiser
} from "../game/ai.js";
import { getApexReleaseCap, geminiDriver } from "../game/geminiDriver.js";
import { PHYS, effectiveLaps } from "../config.js";
import { clamp } from "../utils.js";
import { CAR_LENGTH, CAR_WIDTH, getCarDistance } from "../car/physics.js";

const ON_KEY = "gp_autopilot_on";
const ALGO_KEY = "gp_autopilot_algo";
const SRC_KEY = "gp_autopilot_src";

// 内置算法元数据表
export const BUILTIN_DRIVERS = {
  superDriver: {
    id: "superDriver",
    name: "superDriver",
    label: "⚡ superDriver (内置·推荐极速 / F1出弯最强)",
    badge: "推荐最速",
    desc: "2026 最新优化成果：平滑赛车线 + 紧凑不对称弯心释放（Apex-Release）+ 3D 坡度下压力补偿，出弯全油门早开，全赛道速度王者且 0 草地率违规。",
    fn: superDriver,
    template: [
      "// 内置 superDriver 算法直接调用",
      "// 可直接运行，或在下方按需微调控制量：",
      "const driver = (car, out, dt, otherCars) => {",
      "  superDriver(car, out, dt, otherCars);",
      "  // 例：在特定条件下微调输出",
      "  // out.up = Math.min(1.0, out.up);",
      "};"
    ].join("\n")
  },
  geminiDriver: {
    id: "geminiDriver",
    name: "geminiDriver",
    label: "🎯 geminiDriver (内置·双前瞻弯心释放)",
    badge: "双前瞻",
    desc: "双前瞻不对称窗口与极窄刹车前瞻走线算法，阿斯顿·马丁 AMR24 与小米 SU8 内置的主力算法，弯道极限释放极快。",
    fn: geminiDriver,
    template: [
      "// 内置 geminiDriver 算法调用",
      "const driver = (car, out, dt, otherCars) => {",
      "  geminiDriver(car, out, dt, otherCars);",
      "};"
    ].join("\n")
  },
  apexHunter: {
    id: "apexHunter",
    name: "apexHunter",
    label: "🏎️ apexHunter (内置·激进贴内切弯)",
    badge: "激进切弯",
    desc: "激进走线算法，入弯角度大、深刹车极限贴内弯心，适合超轻量化高下压力赛车。",
    fn: driveApexHunter,
    template: [
      "// 内置 apexHunter 激进贴内切弯算法",
      "const driver = (car, out, dt, otherCars) => {",
      "  driveApexHunter(car, out, dt, otherCars);",
      "};"
    ].join("\n")
  },
  vectorPursuit: {
    id: "vectorPursuit",
    name: "vectorPursuit",
    label: "📐 vectorPursuit (内置·几何纯追踪)",
    badge: "平稳追踪",
    desc: "纯几何航向角误差补偿算法，出弯循迹平稳，适合防打滑与稳定行车。",
    fn: driveVectorPursuit,
    template: [
      "// 内置 vectorPursuit 几何追踪算法",
      "const driver = (car, out, dt, otherCars) => {",
      "  driveVectorPursuit(car, out, dt, otherCars);",
      "};"
    ].join("\n")
  },
  classicBaseline: {
    id: "classicBaseline",
    name: "classicBaseline",
    label: "🏁 classicBaseline (内置·经典单点前瞻)",
    badge: "经典基准",
    desc: "单点距离前瞻经典循迹算法，逻辑清晰透明，适合作为自主算法开发的极简参照物。",
    fn: driveClassicBaseline,
    template: [
      "// 内置 classicBaseline 经典单点前瞻算法",
      "const driver = (car, out, dt, otherCars) => {",
      "  driveClassicBaseline(car, out, dt, otherCars);",
      "};"
    ].join("\n")
  },
  smoothCruiser: {
    id: "smoothCruiser",
    name: "smoothCruiser",
    label: "🚗 smoothCruiser (内置·重车平滑巡航)",
    badge: "重车巡航",
    desc: "专门针对大马力、大车重车辆（如小米 SU8 Ultra / 仰望 U9X）调优的防打滑平滑巡航算法。",
    fn: driveSmoothCruiser,
    template: [
      "// 内置 smoothCruiser 重车平滑巡航算法",
      "const driver = (car, out, dt, otherCars) => {",
      "  driveSmoothCruiser(car, out, dt, otherCars);",
      "};"
    ].join("\n")
  }
};

// 自定义手写算法默认起始模板
const DEFAULT_CUSTOM_SOURCE = [
  "// 自定义自动驾驶算法",
  "// 入口约定：必须定义名为 driver(car, out, dt, otherCars) 的函数",
  "// 输出控制量：out.up (0~1 油门), out.brake (0~1 刹车), out.steer (-1~1 转向)",
  "// 详细 API 与数据文档见右上角「📖 开发参数文档」",
  "const driver = (car, out, dt, otherCars) => {",
  "  // 方式 1：直接调用内置 superDriver（推荐）并在其基础上进行微调：",
  "  superDriver(car, out, dt, otherCars);",
  "  ",
  "  // 方式 2：完全手写掌控控制量（解开下方注释即可自定义纯手写算法）：",
  "  /*",
  "  const ti = (car.idx + 18) % N;",
  "  const targetX = pts[ti].x + lineX[ti] * hw[ti];",
  "  const targetY = pts[ti].y + lineY[ti] * hw[ti];",
  "  const steerError = wrapAngle(Math.atan2(targetY - car.y, targetX - car.x) - car.angle);",
  "  out.steer = clamp(steerError * 2.8, -1, 1);",
  "  out.up = 1.0;",
  "  out.brake = 0.0;",
  "  */",
  "};"
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
  idxAt(meters) {
    return indexAtDistance(meters);
  },
};

// 注入到玩家代码里的可用标识符（切换赛道后已重建的数组 / 表会被重新注入）
export const API_PARAMS = [
  "N", "pts", "nor", "hw", "curvS", "grade", "lineX", "lineY", "DS", "PHYS",
  "clamp", "wrapAngle", "getSuperCornerCap", "evaluateTrafficAndOvertake",
  "CAR_LENGTH", "CAR_WIDTH", "getCarDistance", "superDriver", "track",
  "getApexReleaseCap", "geminiDriver", "driveApexHunter", "driveVectorPursuit",
  "driveClassicBaseline", "driveSmoothCruiser"
];

Object.freeze(TRACK_API);
export { TRACK_API };

const freezePoint = (p) => Object.freeze({ x: p.x, y: p.y });

function buildPhysCopy() {
  return Object.freeze({
    ...PHYS,
    maxSpeed: Object.freeze([...PHYS.maxSpeed]),
    accelCurve: Object.freeze(PHYS.accelCurve.map((row) => Object.freeze([...row]))),
  });
}

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
    geminiDriver,
    driveApexHunter,
    driveVectorPursuit,
    driveClassicBaseline,
    driveSmoothCruiser,
  ];
  for (let i = 0; i < BLOCKED_GLOBALS.length; i++) values.push(undefined);
  return values;
}

export const BLOCKED_GLOBALS = [
  "window", "document", "localStorage", "sessionStorage", "indexedDB", "caches",
  "cookieStore", "fetch", "XMLHttpRequest", "WebSocket", "EventSource",
  "Worker", "SharedWorker", "serviceWorker", "navigator", "location", "history",
  "screen", "top", "parent", "self", "globalThis", "frames", "opener",
  "postMessage", "importScripts", "Function", "setTimeout", "setInterval",
  "clearTimeout", "clearInterval", "requestAnimationFrame", "cancelAnimationFrame",
  "__gp", "WebAssembly",
];

export const DRIVER_PARAMS = [...API_PARAMS, ...BLOCKED_GLOBALS];

export function autopilotFactoryCode(src) {
  return `return function(${DRIVER_PARAMS.join(",")}){\n`
    + `${src}\n`
    + `;return (typeof driver === "function" ? driver : null);\n}`;
}

const NO_DRIVER_MSG = "没有找到 driver(car, out, dt, otherCars) 函数（函数名必须是 driver）";

export function compileAutopilotSource(src) {
  return compile(src);
}

// 核心状态
let enabled = false;
let selectedAlgo = "superDriver";          // 默认内置 superDriver，可选 "geminiDriver" / ... / "custom"
let source = DEFAULT_CUSTOM_SOURCE;
let compiled = null;                      // 自定义代码编译结果
let lastGood = null;                      // 上一次成功的自定义算法
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

// 获取当前驱动算法函数
export function getAutopilotDriver() {
  if (!enabled) return null;
  if (selectedAlgo in BUILTIN_DRIVERS) {
    return BUILTIN_DRIVERS[selectedAlgo].fn;
  }
  return compiled || lastGood;
}

export function getAutopilotSource() {
  if (selectedAlgo in BUILTIN_DRIVERS) {
    return BUILTIN_DRIVERS[selectedAlgo].template;
  }
  return source;
}

export function getAutopilotError() { return compileError; }
export function getSelectedAlgorithm() { return selectedAlgo; }

function compile(src) {
  const factory = new Function(autopilotFactoryCode(src));
  const fn = factory()(...createAutopilotApiValues());
  if (typeof fn !== "function") throw new Error(NO_DRIVER_MSG);
  return fn;
}

function recompile(silent = false) {
  if (selectedAlgo in BUILTIN_DRIVERS) {
    compiled = null;
    compileError = "";
    if (!silent) setStatus(`✓ 内置算法 ${selectedAlgo} 已就绪`, "ok");
    if (enabled) notify();
    return;
  }

  try {
    compiled = compile(source);
    lastGood = compiled;
    compileError = "";
    if (!silent) setStatus("✓ 自定义算法编译通过", "ok");
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
    localStorage.setItem(ALGO_KEY, selectedAlgo);
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
  const pill = document.getElementById("autopilotPill");
  if (pill) {
    pill.textContent = enabled ? "🤖 自动驾驶：开" : "🤖 自动驾驶：关";
    pill.classList.toggle("on", enabled);
  }
}

function emitModalChange() {
  window.dispatchEvent(new Event("modalchange"));
}

// 刷新面板视图（内置算法卡片 vs 自定义代码编辑器）
function updateView() {
  const builtinView = document.getElementById("autopilotBuiltinView");
  const customView = document.getElementById("autopilotCustomView");
  const select = document.getElementById("autopilotAlgoSelect");
  const code = document.getElementById("autopilotCode");

  if (select) select.value = selectedAlgo;

  if (selectedAlgo in BUILTIN_DRIVERS) {
    const info = BUILTIN_DRIVERS[selectedAlgo];
    if (builtinView) {
      builtinView.style.display = "block";
      const badge = document.getElementById("builtinAlgoBadge");
      const title = document.getElementById("builtinAlgoTitle");
      const desc = document.getElementById("builtinAlgoDesc");
      if (badge) badge.textContent = info.badge;
      if (title) title.textContent = info.name;
      if (desc) desc.textContent = info.desc;
    }
    if (customView) customView.style.display = "none";
    setStatus(`✓ 内置算法 ${info.name} 已就绪 · 开箱即用`, "ok");
  } else {
    if (builtinView) builtinView.style.display = "none";
    if (customView) {
      customView.style.display = "flex";
      if (code && code.value !== source) code.value = source;
    }
    recompile();
  }
}

// 导出当前算法为 .js 文件并尝试复制到剪贴板
export function exportCurrentAlgorithm() {
  let exportCode = "";
  let filename = "";

  if (selectedAlgo in BUILTIN_DRIVERS) {
    const info = BUILTIN_DRIVERS[selectedAlgo];
    filename = `${info.name}.js`;
    exportCode = [
      `// 自动驾驶算法：${info.name}`,
      `// 描述：${info.desc}`,
      `// 无头台架测试命令：node scripts/autopilot-bench.mjs --algo=${info.name}.js`,
      info.template
    ].join("\n");
  } else {
    filename = "custom_driver.js";
    exportCode = source || DEFAULT_CUSTOM_SOURCE;
  }

  // 触发文件下载
  try {
    const blob = new Blob([exportCode], { type: "text/javascript;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (err) {
    console.warn("下载文件失败", err);
  }

  // 复制到剪贴板
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(exportCode).then(() => {
      setStatus(`✓ 已导出 ${filename} 并已复制到剪贴板！`, "ok");
    }).catch(() => {
      setStatus(`✓ 已导出文件 ${filename}`, "ok");
    });
  } else {
    setStatus(`✓ 已导出文件 ${filename}`, "ok");
  }
}

// 导入算法文件
export function importAlgorithmText(text, filename = "算法文件") {
  if (!text || !text.trim()) {
    setStatus("✗ 导入失败：文件内容为空", "err");
    return;
  }
  selectedAlgo = "custom";
  source = text;
  save();
  updateView();
  setStatus(`✓ 成功导入 ${filename}，已切换为自定义手写模式`, "ok");
}

export function openAutopilot() {
  const modal = document.getElementById("autopilotModal");
  if (!modal) return;
  const toggle = document.getElementById("autopilotToggle");
  if (toggle) toggle.checked = enabled;

  updateView();
  modal.classList.add("open");
  emitModalChange();
}

export function closeAutopilot() {
  const modal = document.getElementById("autopilotModal");
  if (!modal) return;
  if (selectedAlgo === "custom") recompile(true);
  modal.classList.remove("open");
  emitModalChange();
}

export function toggleAutopilot(on, { persist = true } = {}) {
  enabled = typeof on === "boolean" ? on : !enabled;
  if (enabled && selectedAlgo === "custom") recompile(true);
  if (persist) save();
  notify();
  const toggle = document.getElementById("autopilotToggle");
  if (toggle) toggle.checked = enabled;
  setStatus(enabled ? "已启用：本局由算法驾驶你的车" : "已关闭：交还键盘控制", enabled ? "ok" : "");
}

export function initAutopilot() {
  try {
    enabled = localStorage.getItem(ON_KEY) === "1";
    const savedAlgo = localStorage.getItem(ALGO_KEY);
    if (savedAlgo && (savedAlgo in BUILTIN_DRIVERS || savedAlgo === "custom")) {
      selectedAlgo = savedAlgo;
    } else {
      selectedAlgo = "superDriver";
    }

    const savedSrc = localStorage.getItem(SRC_KEY);
    if (savedSrc && savedSrc.trim()) source = savedSrc;
  } catch { /* 忽略 */ }

  const modal = document.getElementById("autopilotModal");
  const code = document.getElementById("autopilotCode");
  const toggle = document.getElementById("autopilotToggle");
  const algoSelect = document.getElementById("autopilotAlgoSelect");
  const importBtn = document.getElementById("autopilotImportBtn");
  const exportBtn = document.getElementById("autopilotExportBtn");
  const fileInput = document.getElementById("autopilotFileInput");
  const builtinEditBtn = document.getElementById("builtinEditBtn");
  const builtinCopyBtn = document.getElementById("builtinCopyBtn");
  const loadTemplateBtn = document.getElementById("autopilotLoadTemplateBtn");
  const resetBtn = document.getElementById("autopilotReset");

  if (!modal) return;

  if (toggle) toggle.checked = enabled;
  updateView();

  // 算法选择切换
  algoSelect?.addEventListener("change", () => {
    selectedAlgo = algoSelect.value;
    save();
    updateView();
    if (enabled) notify();
  });

  // 基于内置算法手写修改
  builtinEditBtn?.addEventListener("click", () => {
    const template = BUILTIN_DRIVERS[selectedAlgo]?.template || DEFAULT_CUSTOM_SOURCE;
    source = template;
    selectedAlgo = "custom";
    save();
    updateView();
    code?.focus();
    setStatus("已加载算法模板，可在此直接编辑完整代码", "ok");
  });

  // 复制当前内置算法代码
  builtinCopyBtn?.addEventListener("click", () => {
    const template = BUILTIN_DRIVERS[selectedAlgo]?.template || "";
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(template).then(() => {
        setStatus(`✓ 已复制 ${selectedAlgo} 调用代码到剪贴板！`, "ok");
      });
    }
  });

  // 导入算法按钮
  importBtn?.addEventListener("click", () => {
    fileInput?.click();
  });

  fileInput?.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      importAlgorithmText(e.target?.result, file.name);
    };
    reader.readAsText(file);
    fileInput.value = "";
  });

  // 导出算法按钮
  exportBtn?.addEventListener("click", () => {
    exportCurrentAlgorithm();
  });

  // 载入 superDriver 模板
  loadTemplateBtn?.addEventListener("click", () => {
    source = BUILTIN_DRIVERS.superDriver.template;
    if (code) code.value = source;
    scheduleSave();
    recompile();
    setStatus("✓ 已载入 superDriver 模板代码", "ok");
  });

  // 重置代码
  resetBtn?.addEventListener("click", () => {
    source = DEFAULT_CUSTOM_SOURCE;
    if (code) code.value = source;
    scheduleSave();
    recompile();
    setStatus("✓ 已重置为默认自定义模板", "ok");
  });

  // 自定义代码编辑即防抖编译
  let timer = 0;
  code?.addEventListener("input", () => {
    source = code.value;
    scheduleSave();
    clearTimeout(timer);
    timer = setTimeout(() => { recompile(); }, 400);
  });

  toggle?.addEventListener("change", () => toggleAutopilot(toggle.checked));
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

  // 切换赛道后 pts/nor/hw/lineX 等被重建，必须重新注入
  onTrackChange(() => { if (compiled || enabled) recompile(true); });
}
