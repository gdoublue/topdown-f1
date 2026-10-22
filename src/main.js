// 主入口：组装各模块并驱动主循环（支持多赛道切换与多赛车不同算法同场竞速）
import { TOTAL_LAPS, effectiveLaps, setRaceLaps, RACE_LAPS } from "./config.js";
import { TRACKS, getTrack } from "./track/tracks.js";
import { WORLD, pts, N, switchTrack, currentTrack, currentTrackId } from "./track/geometry.js";
import { buildTrackCanvas } from "./track/render.js";
import { createCar, stepCar, resolveCarCollisions, finishedCarInput } from "./car/physics.js";
import { drawCar, getRandomLivery } from "./car/render.js";
import { resetCamera, updateCamera, applyCamera, setZoomScale, cam } from "./game/camera.js";
import { initInput, input, NO_INPUT } from "./game/input.js";
import * as fx from "./game/effects.js";
import { race, resetRace, tickCountdown, initCarRaceState, updateCarLap, simClock, advanceSimClock, resetSimClock } from "./game/race.js";
import { initHud, fmt, showMsg, hideMsg, msgText, tickMsg, updateHUD, updateAIHUD, setOnSelectCar } from "./game/hud.js";
import { initTuner, syncTuner, setTunerEnabled } from "./game/tuner.js";
import {
  initMenuPanels, currentStep, showModeStep, showCarStep, showOnlineStep,
  openStartModal, closeStartModal, renderCarCards
} from "./ui/menuPanels.js";
import { trackThumbUrl } from "./ui/trackThumb.js";
import {
  initAutopilot, isAutopilotOn, getAutopilotDriver, openAutopilot, onAutopilotChange, toggleAutopilot
} from "./ui/autopilot.js";
import { initMinimap, drawMinimap } from "./game/minimap.js";
import * as audio from "./game/audio.js";
import { AI_CONFIGS, applyCarConfig, buildGridSlots, createAIInput, driveAI, AI_RESTART_DELAY, rebuildAITrack } from "./game/ai.js";
import { conn } from "./net/connection.js";
import { rtc } from "./net/rtc.js";
import { initOnlineUI, showOnline as showOnlineUI, hideOnline as hideOnlineUI, leaveOnlineRoom } from "./net/onlineUI.js";
import { getFingerprint } from "./net/fingerprint.js";
import { startNetRace, stopNetRace, updateNetRace, bindNetRaceHandlers, netrace, forfeitNetRace, setNetAutopilot } from "./net/netrace.js";
import { driverLabel, driverCode, carModelLabel, carNumberLabel } from "./ui/labels.js";
import {
  onQualityChange, setQualityMode, getQualityMode, getTrackSS,
  computeBackingSize, noteViewport, sampleFrameQuality, getQualityStats, getQualityInfo
} from "./game/renderQuality.js";

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// 规范 URL 路由处理（消除 ?ai=1 等老式 query hack，优先 hash 路由）
let initHash = location.hash;
if (location.search && new URLSearchParams(location.search).has("ai")) {
  initHash = "#/spectate";
  try { history.replaceState(null, "", location.pathname + "#/spectate"); } catch (e) {}
}
const SPECTATE = initHash === "#/spectate";

const canvas = document.getElementById("cv");
const offTrackWarnEl = document.getElementById("offTrackWarn");
const fpsValueEl = document.getElementById("fpsValue");
let fpsFrames = 0;
let fpsWindowStart = 0;
// alpha:false → 不透明画布，避免移动端内核（夸克/UC 等）逐帧透明合成的闪烁
const ctx = canvas.getContext("2d", { alpha: false });
// 赛道贴图的超采样倍率随画质档位变化（高·自动=4 / 中=3 / 低·自动低特效=2）
let currentTrackSS = getTrackSS();
let trackCanvas = buildTrackCanvas(currentTrackSS);
let qualityInfoEl = null;

initMinimap();

// 玩法模式：null(未选择) | "solo"(单人计时) | "vs"(与 AI 同场竞速) | "spectate"(全 AI 观战)
let mode = SPECTATE ? "spectate" : null;
let playerCarId = null;   // 玩家选择的赛车 id（solo / vs）
let playerIndex = 0;      // 玩家在 cars 数组中的下标
let started = false;
let startedOnce = false;      // 完成"模式 → 赛车"选择后才开始倒计时

// 赛车列表：对战/观战模式装载全部 AI 配置；单人模式只有玩家一辆
let cars = [];
let aiInputs = [];
const activeCars = [];   // 未完赛车辆（复用数组，供 AI 避让感知；完赛车已幽灵化）
let focusIndex = 0;
let focusAutopilot = false;   // 在线换视角时临时接管用（切回自己的车要交还键盘）
let finishAt = 0;
let firstFinishAt = 0;   // 首车冲线时刻（模拟时钟）：用于掉队兜底
const STALL_FINISH_MS = 20000;      // 首车完赛后 20s 仍未全员完赛 → 强制结算
// 兜底硬上限：按圈数给足时间（每圈 150s + 2 分钟缓冲），防止一辆车卡死导致永不结算
function raceHardLimitMs() {
  return effectiveLaps(currentTrack?.laps) * 150000 + 120000;
}
let winner = null;      // 全场首位冲线车辆（与观察视角无关）
let resultsShown = false;   // 结算大屏是否已展示
let onlinePractice = false; // 在线单人练习：成绩自动上传服务器排行榜
let showAILine = false; // 是否绘制焦点赛车的 AI 前瞻目标点与引线（默认关闭，可在视图面板开启）
let speedMult = 1;      // 比赛倍速（观战/单人/对战 AI 快进；在线对战为服务器实时，不生效）
const SPEED_STEPS = [1, 2, 4, 8, 16];
const MAX_SUBSTEP_DT = 1 / 30;   // 倍速后切成 ≤1/30s 的固定物理子步，保证模拟稳定
const AI_HUD_INTERVAL_MS = 80;   // 计时塔刷新间隔（12.5Hz）：低频信息，不必跟满帧率
const SOLO_HUD_INTERVAL_MS = 50; // 单人遥测 20Hz：数字够跟手，同时省掉 144Hz 下的逐帧 DOM 写
let lastAiHudAt = 0;
let lastSoloHudAt = 0;

// 洗牌算法：用于每局发车位随机排位
function shuffle(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// 该下标车辆是否由 AI 驾驶（观战模式全为 AI；对战模式除玩家外全为 AI；自动驾驶时玩家车也交给算法）
function isAIDriven(i) {
  // 在线对战：本机赛车的自动驾驶由 netrace 内部驱动，且 aiInputs 不参与维护，
  // 这里必须返回 false，否则会去取一个不存在的 aiInputs[i]（undefined）。
  if (mode === "onlinerace") return false;
  if (mode === "spectate") return true;
  if (i === playerIndex && isAutopilotOn()) return true;
  return mode === "vs" && i !== playerIndex;
}

// 把当前自动驾驶设置同步到玩家车上（支持比赛途中开关 / 改完代码立即生效）
// 注意：这里必须每帧刷新引用，否则玩家在弹窗里改完算法、编译也通过了，
// 车却还在跑上一次的旧函数（调试体验直接崩掉）。
function syncPlayerAutopilot() {
  const me = cars[playerIndex];
  if (!me || !me.isPlayer) return;
  if (!isAutopilotOn()) {
    if (me.autopilot) {
      me.autopilot = false;
      me.driver = null;
    }
    return;
  }
  me.autopilot = true;
  // 编译失败时 getAutopilotDriver() 为 null：保留上一次编译成功的算法（或该车内置 AI）
  const drv = getAutopilotDriver();
  if (drv && me.driver !== drv) me.driver = drv;
}

function setupCars() {
  cars = [];
  aiInputs = [];
  playerIndex = 0;

  // 单人计时：只放玩家选中的赛车
  if (mode === "solo") {
    const cfg = AI_CONFIGS.find(c => c.id === playerCarId) || AI_CONFIGS[0];
    const car = applyCarConfig(createCar(0), cfg);
    car.isPlayer = true;
    car.isAI = false;
    initCarRaceState(car);
    cars.push(car);
    aiInputs.push(createAIInput());
    return;
  }

  // 发车位：读取 AI_CONFIGS 中各车 gridPos 指定的杆位，其余车辆随机填入剩余格位
  const carGrid = buildGridSlots(AI_CONFIGS, true);
  const chosen = AI_CONFIGS.findIndex(c => c.id === playerCarId);
  playerIndex = (mode === "vs" && chosen >= 0) ? chosen : 0;

  for (let i = 0; i < AI_CONFIGS.length; i++) {
    const car = applyCarConfig(createCar(carGrid[i]), AI_CONFIGS[i]);
    // 观战模式没有“玩家车”：不要给 P1 误标 YOU
    car.isPlayer = mode === "vs" && i === playerIndex;
    car.isAI = !car.isPlayer;
    initCarRaceState(car);
    cars.push(car);
    aiInputs.push(createAIInput());
  }
}

function switchFocusCar(idx) {
  if (idx < 0 || idx >= cars.length) return;
  const target = cars[idx];
  focusIndex = idx;
  resetCamera(target);
  audio.syncCarAudio(target);

  // 在线对战允许换视角，但你的车不能没人开：
  //  · 换到别人视角时若自动驾驶没开 → 用【玩家本地算法】临时接管（不写偏好设置）
  //  · 切回自己的车 → 若这次接管是换视角引起的，就把键盘交还
  if (mode !== "onlinerace") return;
  if (!target.isPlayer) {
    if (!isAutopilotOn()) {
      focusAutopilot = true;
      toggleAutopilot(true, { persist: false });
      updateHelpText();
      showMsg("自动驾驶接管", "看别人视角时，你的车由本地算法驾驶", 1800);
    }
  } else if (focusAutopilot) {
    releaseFocusAutopilot();
  }
}

// 页面上的自动驾驶开关：顶栏胶囊点击 / 快捷键 B 都走这里，开不开由玩家决定
function toggleAutopilotQuick() {
  if (mode === "spectate") return;   // 全 AI 观战没有"自己的车"可交出去
  const next = !isAutopilotOn();
  focusAutopilot = false;            // 手动开关之后就不再算"换视角临时接管"
  toggleAutopilot(next);
  // 关掉自动驾驶时把镜头收回自己的车，否则等于蒙着眼睛开
  if (!next) {
    const myIdx = mode === "onlinerace"
      ? cars.findIndex(c => c.isPlayer)
      : (mode === "vs" ? playerIndex : -1);
    if (myIdx >= 0 && myIdx !== focusIndex) switchFocusCar(myIdx);
  }
  updateHelpText();
}

// 交还键盘：只关掉"因为换视角而自动打开"的那次自动驾驶
// silent：退出比赛/回大厅等场景，不要弹提示（此时屏幕已被弹窗占据）
function releaseFocusAutopilot(silent = false) {
  if (!focusAutopilot) return;
  focusAutopilot = false;
  toggleAutopilot(false, { persist: false });
  updateHelpText();
  if (!silent) showMsg("已交还键盘", "自动驾驶已关闭", 1200);
}
setOnSelectCar(switchFocusCar);

function reset() {
  if (!started || resultsShown) return;   // 开局选择阶段 / 结算大屏展示中不响应 R 重开
  if (mode === "onlinerace") return;      // 在线对战物理在服务器，R 不做本地重开
  hideResults();
  setupCars();
  resetRace();
  switchFocusCar(playerIndex);
  fx.clearEffects();
  hideMsg(true);
  finishAt = 0;
  firstFinishAt = 0;
  resetSimClock(0);
  winner = null;
}

// 画布后备分辨率由画质档位/动态缩放决定，CSS 尺寸始终铺满窗口：
// 降的是渲染像素，UI 仍是原生分辨率。镜头按 canvas.height 推导，世界视野不变。
function updateQualityInfo() {
  if (!qualityInfoEl) qualityInfoEl = document.getElementById("qualityInfo");
  if (qualityInfoEl) qualityInfoEl.textContent = getQualityInfo();
}

function resize() {
  const r = canvas.getBoundingClientRect();
  noteViewport(r.width, r.height);
  // 视口变化可能让自动模式退出低特效，赛道贴图档位随之恢复
  applyTrackQuality();
  const { w, h } = computeBackingSize(r.width, r.height, window.devicePixelRatio || 1);
  // 尺寸没变就不重置画布：移动端地址栏收起/展开会触发 resize，
  // 无条件重设 canvas.width 会清屏，造成"一闪一闪"
  if (canvas.width === w && canvas.height === h) {
    updateQualityInfo();
    return;
  }
  canvas.width = w;
  canvas.height = h;
  // alpha:false 画布不透底：开局菜单阶段先铺一层深色底（贴近页面渐变背景）
  ctx.fillStyle = "#0b111c";
  ctx.fillRect(0, 0, w, h);
  updateQualityInfo();
}
window.addEventListener("resize", resize);

function applyTrackQuality() {
  const ss = getTrackSS();
  if (ss === currentTrackSS) return;
  currentTrackSS = ss;
  trackCanvas = buildTrackCanvas(ss);
}

onQualityChange(() => {
  applyTrackQuality();
  resize();
  updateQualityInfo();
});

let isModalOpen = false;
// 在线退出确认：比赛不冻结，自车临时交给自动驾驶（取消后归还键盘）
let onlineQuitConfirmOpen = false;
let quitConfirmAutoTakeover = false;

// 用真实弹窗状态重算冻结标记：避免某个弹窗还开着、比赛却已经放行的漏洞
export function syncModalOpen() {
  isModalOpen = ["startModal", "trackModal", "resultsModal", "confirmModal", "autopilotModal"]
    .some(id => document.getElementById(id)?.classList.contains("open"));
  return isModalOpen;
}

// 弹窗由各模块自行开合时（如自动驾驶设置），通过事件把冻结状态同步给主循环
window.addEventListener("modalchange", () => syncModalOpen());

function updateTrackUI() {
  const pillFlag = document.getElementById("pillFlag");
  const pillName = document.getElementById("pillName");
  const pillLen = document.getElementById("pillLen");
  const pillSession = document.getElementById("pillSession");
  if (pillFlag) pillFlag.textContent = currentTrack.flag;
  if (pillName) pillName.textContent = currentTrack.name;
  if (pillLen) pillLen.textContent = (currentTrack.length / 1000).toFixed(2) + "km";
  if (pillSession) {
    pillSession.textContent = mode === "onlinerace" ? "ONLINE"
      : mode === "spectate" ? "AI GP"
        : mode === "vs" ? "GRAND PRIX"
          : mode === "solo" ? "TIME ATTACK" : "PRACTICE";
  }

  const label = mode === "onlinerace" ? "在线对战 · "
    : mode === "spectate" ? "AI 锦标赛 · " : mode === "vs" ? "对战 AI · " : "俯视 F1 · ";
  document.title = label + currentTrack.name;
}

const LAP_OPTIONS = [0, 1, 2, 3, 5, 8, 10, 15, 20];   // 0 = 赛道默认

// 圈数选择 chips（0 = 跟随各赛道推荐圈数）
function renderLapChips() {
  const wrap = document.getElementById("lapChips");
  if (!wrap) return;
  wrap.innerHTML = LAP_OPTIONS.map(n => `
    <button class="online-chip ${RACE_LAPS === n ? "active" : ""}" data-laps="${n}">
      ${n === 0 ? "赛道默认" : n + " 圈"}
    </button>`).join("");
  const hint = document.getElementById("lapsHint");
  if (hint) {
    hint.textContent = RACE_LAPS
      ? `当前所有赛道均按 ${RACE_LAPS} 圈比赛`
      : "未选择时按各赛道推荐圈数（3-4 圈）";
  }
  updateTrackStartSummary();
}

// 底部开始栏：显示即将开跑的赛道 / 圈数 / 长度
function updateTrackStartSummary() {
  const el = document.getElementById("trackStartSummary");
  if (!el) return;
  const t = getTrack(pendingTrackId || currentTrackId);
  if (!t) return;
  const laps = effectiveLaps(t.laps);
  el.innerHTML = `即将开跑：<b>${t.flag} ${t.name}</b> · <em>${laps} 圈</em> · ${(t.length / 1000).toFixed(2)} km`;
}

function onLapChipClick(e) {
  const chip = e.target.closest("[data-laps]");
  if (!chip) return;
  setRaceLaps(chip.getAttribute("data-laps"));
  renderLapChips();
  // 比赛已开始：改变圈数立即重开比赛生效（与切换赛道同规则）
  if (started && mode !== "onlinerace") reset();
}

let pendingTrackId = null;

function renderTrackCards() {
  const grid = document.getElementById("trackCardsGrid");
  if (!grid) return;
  const activeId = pendingTrackId || currentTrackId;
  grid.innerHTML = TRACKS.map(t => {
    const isCur = t.id === activeId;
    return `
      <div class="track-card ${isCur ? 'active' : ''}" data-track-id="${t.id}">
        ${isCur ? '<div class="active-badge">✓ SELECTED</div>' : ''}
        <div class="track-card-top">
          <span class="track-card-flag">${t.flag}</span>
          <span class="track-card-len">${(t.length / 1000).toFixed(2)} km · ${t.turns} 弯</span>
        </div>
        <img class="track-mini" src="${trackThumbUrl(t.id)}" alt="${t.name} 赛道图">
        <div class="track-card-title">${t.name}</div>
        <div class="track-card-en">${t.nameEn}</div>
        <div class="track-card-tag">${t.tag}</div>
        <p class="track-card-desc">${t.desc}</p>
      </div>
    `;
  }).join("");
  renderLapChips();
}

// fromStart：开局流程（选完车 → 选赛道）打开的，取消时要退回"选赛车"而不是直接开赛
let trackModalFromStart = false;

export function openTrackModal(fromStart = false) {
  const modal = document.getElementById("trackModal");
  if (!modal) return;
  trackModalFromStart = !!fromStart;
  pendingTrackId = currentTrackId;
  renderTrackCards();
  const closeBtn = document.getElementById("closeTrackModal");
  if (closeBtn) closeBtn.title = fromStart ? "返回上一步（重新选择赛车）" : "关闭并继续比赛";
  modal.classList.add("open");
  isModalOpen = true;
}

export function closeTrackModal() {
  const modal = document.getElementById("trackModal");
  if (modal) {
    modal.classList.remove("open");
    syncModalOpen();
  }
}

// 取消（✕ / 点击遮罩 / Esc）：开局流程中退回选车步骤，比赛中则直接关闭继续比赛
export function cancelTrackModal() {
  if (trackModalFromStart) {
    trackModalFromStart = false;
    closeTrackModal();
    started = false;            // 还没真正发车：比赛不保留
    resetSimClock(0);
    showCarStep(mode);
    openStartModal();
    isModalOpen = true;
    return;
  }
  closeTrackModal();
}

export function applyTrack(trackId) {
  trackModalFromStart = false;
  switchTrack(trackId || currentTrackId);
  pendingTrackId = currentTrackId;
  trackCanvas = buildTrackCanvas(currentTrackSS);

  updateTrackUI();
  initMinimap();
  renderTrackCards();
  // 先关闭面板再重开比赛：避免面板还开着时后台已经开始倒计时/跑圈
  closeTrackModal();
  reset();
}

function initTrackSelector() {
  pendingTrackId = currentTrackId;
  updateTrackUI();
  renderTrackCards();

  const pill = document.getElementById("trackSwitcherPill");
  if (pill) pill.addEventListener("click", () => openTrackModal(false));

  const closeBtn = document.getElementById("closeTrackModal");
  if (closeBtn) closeBtn.addEventListener("click", cancelTrackModal);

  const modal = document.getElementById("trackModal");
  if (modal) {
    modal.addEventListener("click", (e) => {
      if (e.target === modal) cancelTrackModal();
    });
  }

  // 点击卡片仅高亮切换，绝不直接开赛
  const grid = document.getElementById("trackCardsGrid");
  if (grid) {
    grid.addEventListener("click", (e) => {
      const card = e.target.closest(".track-card");
      if (card) {
        const tid = card.getAttribute("data-track-id");
        if (tid) {
          pendingTrackId = tid;
          renderTrackCards();
        }
      }
    });
  }

  // 必须手动点击开始比赛按钮才应用并开跑
  const startBtn = document.getElementById("trackStartBtn");
  if (startBtn) {
    startBtn.addEventListener("click", () => {
      applyTrack(pendingTrackId || currentTrackId);
    });
  }

  const lapChips = document.getElementById("lapChips");
  if (lapChips) lapChips.addEventListener("click", onLapChipClick);

}

// 键盘按键：T/t 切换赛道面板，Esc 关闭面板，1~4 或 Tab 切换跟随赛车
window.addEventListener("keydown", (e) => {
  if (resultsShown) return;   // 结算大屏展示中屏蔽比赛快捷键
  const startModalOpen = document.getElementById("startModal")?.classList.contains("open");
  if (startModalOpen) {
    // 开局弹窗打开时屏蔽比赛快捷键，但保留 Esc = 返回上一步（根步骤不响应）
    if (e.key === "Escape" && currentStep() !== "mode") {
      e.preventDefault();
      backToMainMenu();
    }
    return;
  }
  // 赛道弹窗内按 Enter 等同点击"开始比赛"（必须先确认才发车）
  if (e.key === "Enter" && document.getElementById("trackModal")?.classList.contains("open")) {
    e.preventDefault();
    document.getElementById("trackStartBtn")?.click();
    return;
  }
  // B：快捷开关自动驾驶（弹窗打开、焦点在输入框/代码框里时不触发）
  if ((e.key === "b" || e.key === "B") && !isModalOpen) {
    const tag = (e.target && e.target.tagName) || "";
    if (tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT") {
      e.preventDefault();
      toggleAutopilotQuick();
      return;
    }
  }
  if (e.key === "t" || e.key === "T") {
    e.preventDefault();
    // 在线对战：赛道由房间统一决定，客户端不提供切换入口（否则本地赛道会和服务端错位）
    if (mode === "onlinerace") return;
    if (isModalOpen) cancelTrackModal();
    else openTrackModal(false);
    return;
  }
  if (e.key === "Escape") {
    if (document.getElementById("confirmModal")?.classList.contains("open")) {
      e.preventDefault();
      closeConfirmModal();
      return;
    }
    if (isModalOpen) {
      e.preventDefault();
      cancelTrackModal();
      return;
    }
    if (mode === "onlinerace") {
      e.preventDefault();
      openOnlineQuitConfirm();
      return;
    }
    if (started) {
      e.preventDefault();
      reopenStartFlow();
      return;
    }
  }
  if ((e.key === "+" || e.key === "=") && mode !== "onlinerace") {
    cycleSpeed(1);
    return;
  }
  if (e.key === "-" && mode !== "onlinerace") {
    cycleSpeed(-1);
    return;
  }
  // 换视角：对战/观战/在线都支持（在线换走会自动开自动驾驶，见 switchFocusCar）
  if (mode === "vs" || mode === "spectate" || mode === "onlinerace") {
    if (e.key >= "1" && e.key <= String(cars.length)) {
      switchFocusCar(Number(e.key) - 1);
    } else if (e.key === "Tab") {
      e.preventDefault();
      switchFocusCar((focusIndex + 1) % cars.length);
    }
  }
});

// 无渲染快进用的空特效桩：不产生刹车痕/扬尘，避免快进时刷爆粒子池
const FX_SILENT = { addSkid() {}, addDust() {}, clearEffects() {} };

// 单人局（场上只有自己一个真人：单人计时 / 与 AI 对战）自己冲线后，
// 剩余 AI 直接无渲染快进到全部完赛 —— 不再一帧一帧实时期待 AI 跑完剩下的圈。
function simulateRemainingToEnd(maxSimMs = 300000) {
  const dt = 1 / 30;
  const maxSteps = Math.ceil((maxSimMs / 1000) / dt);
  for (let s = 0; s < maxSteps; s++) {
    activeCars.length = 0;
    for (const c of cars) if (!c.finished) activeCars.push(c);
    if (activeCars.length === 0) break;
    advanceSimClock(dt * 1000);
    for (let i = 0; i < cars.length; i++) {
      const car = cars[i];
      if (car.finished) continue;        // 自己的车已冲线，成绩锁定不再推进
      driveAI(car, aiInputs[i], dt, activeCars);
      stepCar(car, dt, aiInputs[i], FX_SILENT);
      updateCarLap(car, simClock);
    }
    if (race.state === "racing") resolveCarCollisions(cars);
  }
  // 兜底：极少数卡死/出界的车保持未完赛，结算里按里程排在后段
}

function update(dt, finalStep = true, simNowMs = 0) {
  if (!started) return;
  // 在线退出确认期间比赛照常推进，避免自己的车停在赛道上被撞/被超
  if (isModalOpen && !onlineQuitConfirmOpen) return;

  // 比赛时钟与物理同源推进：倍速快进时圈速/总时也按模拟时间计算
  advanceSimClock(dt * 1000);

  // ---- 在线竞速（幽灵模式）：自车本地物理，远端车幽灵插值 ----
  if (mode === "onlinerace") {
    if (race.state === "countdown") {
      const c = String(Math.max(1, Math.ceil(race.countdown)));
      if (msgText() !== c) { showMsg(c, "", 0); audio.beep(700, 0.12); }
    } else if (/^\d$/.test(msgText())) {
      showMsg("GO!", "", 900);   // 倒计时结束：清屏显示 GO
      audio.beep(1200, 0.35, 0.2);
    }
    const ev = updateNetRace(dt, input, simNowMs || performance.now(), fx, finalStep);
    if (ev === "lap") {
      const me = cars.find(c => c.isPlayer);
      showMsg("LAP " + Math.min(me.lap, effectiveLaps(currentTrack?.laps)) + "/" + effectiveLaps(currentTrack?.laps), me.shortName, 1100);
      audio.lapSound();
    } else if (ev === "finish") {
      const me = cars.find(c => c.isPlayer);
      showMsg("FINISH!", "总时间 " + fmt(me.total) + " · 最快圈 " + fmt(me.best), 0);
      audio.finishSound();
    }

    // 服务器权威排名 → 结算大屏
    if (netrace.results && !resultsShown) {
      showResults();
    }
    return;
  }

  if (race.state === "countdown") {
    const r = tickCountdown(dt);
    if (r === "go") {
      showMsg("GO!", "", 900);
      audio.beep(1200, 0.35, 0.2);
      audio.startSound();
      // 圈速与总时从绿灯起算：否则第 1 圈会把 3 秒倒计时计入（服务端同理）
      for (const c of cars) { c.raceStart = simClock; c.lapStart = simClock; }
    } else if (msgText() !== r) {
      showMsg(r, "", 0);
      audio.beep(700, 0.12);
    }
    return;
  }

  // 自动驾驶：把算法挂到玩家车上（单人 / 对战 AI 均生效）
  syncPlayerAutopilot();

  // 未完赛车辆（AI 感知用）：完赛车已经幽灵化，不再作为避让/跟车目标
  activeCars.length = 0;
  for (const c of cars) if (!c.finished) activeCars.push(c);

  // 更新所有赛车的物理与 AI 决策
  for (let i = 0; i < cars.length; i++) {
    const car = cars[i];
    const aiDriven = isAIDriven(i);
    if (aiDriven) driveAI(car, aiInputs[i], dt, activeCars);

    const ctrl = aiDriven ? aiInputs[i] : input;

    // 已完赛的车辆平滑降速到随机巡航速度（60~100km/h，不再停车）；AI 车沿用其转向与弯前刹车
    let effCtrl = ctrl;
    if (car.finished) effCtrl = finishedCarInput(car, aiDriven ? aiInputs[i] : null);
    else if (race.state !== "racing") effCtrl = NO_INPUT;

    stepCar(car, dt, effCtrl, fx);

    const ev = updateCarLap(car, simClock);
    if (i === focusIndex && ev === "lap") {
      showMsg("LAP " + car.lap + "/" + effectiveLaps(currentTrack?.laps), car.shortName, 1100);
      audio.lapSound();
    }
  }

  // 冠军判定：全场首位冲线者，与当前观察视角无关
  // （同一帧有多车冲线时取总用时最短者，避免按数组顺序误判）
  if (!winner) {
    for (const c of cars) {
      if (c.finished && (!winner || (c.total || 0) < (winner.total || 0))) winner = c;
    }
    if (winner) {
      showMsg("WINNER: " + winner.shortName, "总时间 " + fmt(winner.total) + " · 最快圈 " + fmt(winner.best), 0);
      audio.finishSound();
    }
  }

  // 物理碰撞分离：防止多车重叠穿模与挤卡
  if (race.state === "racing") {
    resolveCarCollisions(cars);
  }

  // 单人局：自己冲线后直接把剩余 AI 无渲染快进到终局，立刻出成绩
  // （观战模式除外——那是全 AI 表演赛，要一直看着跑）
  const myCar = cars[playerIndex];
  if (!finishAt && mode !== "spectate" && myCar && myCar.finished && !cars.every(c => c.finished)) {
    simulateRemainingToEnd();
    // 快进跑完后重新判定冠军（可能有人比你先冲线）
    winner = null;
    for (const c of cars) {
      if (c.finished && (!winner || (c.total || 0) < (winner.total || 0))) winner = c;
    }
    finishAt = performance.now() - 3000;   // 让本帧末尾立刻弹出结算大屏
  }

  // 检查是否全员完赛；未完赛时用超时兜底，避免一辆车卡死导致永远不结算
  const allFinished = cars.every(c => c.finished);
  if (allFinished && !finishAt) {
    finishAt = performance.now();
  } else if (!finishAt) {
    if (!firstFinishAt && cars.some(c => c.finished)) firstFinishAt = simClock;
    const stalled = firstFinishAt && simClock - firstFinishAt > STALL_FINISH_MS;
    const tooLong = simClock > raceHardLimitMs();
    if (stalled || tooLong) finishAt = performance.now();   // 未完赛车按里程排名
  }

  // 全员完赛片刻后弹出结算大屏（排名 / 用时 / 最快圈 / 差距）
  if (finishAt && !resultsShown && performance.now() - finishAt > 2600) {
    showResults();
  }
}

// 远端车失联分档的绘制包装：正常车直接画；弱网车套一层透明度；彻底失联的车跳过
function drawCarWithGhostAlpha(car) {
  if (!car || car.retired || car.ghostHidden) return;
  const a = car.ghostAlpha;
  if (a == null || a >= 1) { drawCar(ctx, car); return; }
  const prev = ctx.globalAlpha;
  ctx.globalAlpha = prev * Math.max(0, a);
  drawCar(ctx, car);
  ctx.globalAlpha = prev;
}

// 8 车分散在赛道上时，大部分车都在镜头外；车体绘制有几十条路径和渐变，
// 屏幕外的不画，和屏幕内完全等价（小地图仍显示全部车）。
const CAR_CULL_MARGIN = 12;
function isCarVisible(car) {
  if (!car) return false;
  const v = cam.view;
  return car.x > v.x - CAR_CULL_MARGIN && car.x < v.x + v.w + CAR_CULL_MARGIN &&
         car.y > v.y - CAR_CULL_MARGIN && car.y < v.y + v.h + CAR_CULL_MARGIN;
}

function draw() {
  const activeCar = cars[focusIndex] || cars[0];
  applyCamera(ctx, canvas, activeCar.shake);
  ctx.drawImage(trackCanvas, 0, 0, WORLD.w, WORLD.h);
  fx.drawEffects(ctx, cam.view);

  // 绘制当前焦点赛车的前瞻目标点与引线（视图面板可随时关闭）
  if (showAILine && mode !== "solo" && aiInputs[focusIndex]?.targetX) {
    const inp = aiInputs[focusIndex];
    ctx.save();
    ctx.beginPath();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = activeCar.color ? `${activeCar.color}66` : "rgba(0, 255, 180, 0.35)";
    ctx.lineWidth = 1.2;
    ctx.moveTo(activeCar.x, activeCar.y);
    ctx.lineTo(inp.targetX, inp.targetY);
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(inp.targetX, inp.targetY, 2.2, 0, Math.PI * 2);
    ctx.fillStyle = activeCar.color || "#00ffb4";
    ctx.shadowColor = activeCar.color || "#00ffb4";
    ctx.shadowBlur = 6;
    ctx.fill();
    ctx.restore();
  }

  // 绘制所有赛车（从后向前绘制，主焦点赛车最后绘制避免被遮挡）
  // retired = 已退出房间的车友：直接消失，不在赛道上留下幽灵车
  // ghostHidden / ghostAlpha = 在线对战的失联分档：半透明 → 彻底隐藏
  for (let i = 0; i < cars.length; i++) {
    if (i !== focusIndex && isCarVisible(cars[i])) drawCarWithGhostAlpha(cars[i]);
  }
  if (isCarVisible(cars[focusIndex])) drawCarWithGhostAlpha(cars[focusIndex]);

  // 小地图
  drawMinimap(cars, focusIndex);
}

// ================= 开局流程：玩法模式 → 赛车 → 赛道 =================
// 面板显隐 / 卡片渲染已抽到 src/ui/menuPanels.js，这里只保留游戏状态与跳转规则

// 第一步：选择玩法模式（单人 / 与 AI 对战 / 在线）
function selectMode(m) {
  // 比赛中直接切模式 = 放弃当前比赛（在线会认输并退出房间）
  if (started) {
    forfeitNetRace();
    stopNetRace();
    leaveOnlineRoom();
    started = false;
    finishAt = 0;
    winner = null;
    hideResults();
    hideMsg(true);
  }
  if (m === "online") {
    mode = "online";
    try { location.hash = "#/online"; } catch (e) {}
    showOnlineStep();
    openStartModal();
    isModalOpen = true;
    showOnlineUI();
    return;
  }
  mode = m;
  try { location.hash = "#/" + m; } catch (e) {}
  showCarStep(m);
  openStartModal();
  isModalOpen = true;
}

// 返回主菜单（根步骤）。从在线流程返回时，先主动退出房间并终止进行中的在线比赛，
// 否则服务端仍把你留在房间里，房主一开赛客户端会被直接拽进对局。
function backToModeStep() {
  if (onlineQuitConfirmOpen) closeConfirmModal();   // 归还临时自动驾驶
  leaveOnlineSession();
  mode = null;
  releaseFocusAutopilot(true);   // 离开对局：把"换视角临时接管"的自动驾驶还回去
  onlinePractice = false;
  started = false;
  resultsShown = false;
  finishAt = 0;
  winner = null;
  hideMsg(true);
  try { location.hash = "#/menu"; } catch (e) {}
  updateTopControls();
  hideOnlineUI();
  showModeStep();
  openStartModal();
  isModalOpen = true;
}

// 第二步：选择赛车（对战模式下其余车辆自动交给 AI）
function selectCar(carId) {
  playerCarId = carId;
  closeStartModal();
  isModalOpen = false;
  startGame();
}

function startGame() {
  started = true;
  resultsShown = false;
  isModalOpen = false;
  offTrackWarnEl?.classList.add("hidden");
  resetSimClock(0);
  firstFinishAt = 0;
  setTunerEnabled(mode !== "onlinerace");
  initHud(mode !== "solo", switchFocusCar);
  setupCars();
  resetRace();
  switchFocusCar(playerIndex);
  fx.clearEffects();
  hideMsg(true);
  finishAt = 0;
  winner = null;
  updateTrackUI();
  updateHelpText();
  updateTopControls();   // 从在线对局切回单机/对战时，把联机里隐藏的控件恢复回来
  // 开局先选赛道；URL 显式指定过 ?track= 则直接开赛
  if (!startedOnce && mode !== "spectate") { startedOnce = true; openTrackModal(true); }
}


// ================= 控制面板顶栏与退出管理 =================
function updateTopControls() {
  const reopenBtn = document.getElementById("reopenStartBtn");
  const quitOnlineBtn = document.getElementById("quitOnlineBtn");
  const online = mode === "onlinerace";

  if (online) {
    if (reopenBtn) reopenBtn.classList.add("hidden");
    if (quitOnlineBtn) quitOnlineBtn.classList.remove("hidden");
  } else {
    if (reopenBtn) {
      reopenBtn.classList.remove("hidden");
      reopenBtn.textContent = "⟲ 重选模式";
    }
    if (quitOnlineBtn) quitOnlineBtn.classList.add("hidden");
  }

  // 联机专属裁剪：这些入口在在线对战里要么无效、要么有害，直接不出现
  //  · 赛道切换胶囊：赛道由房间统一决定，点了会把本地赛道改掉，和服务器全盘错位
  //  · 比赛倍速：本地快进对服务器实时比赛无效（快捷键 +/- 也已屏蔽）
  //  · AI 探测线：调试用的 AI 前瞻引线，联机里属于额外信息
  for (const id of ["trackSwitcherPill", "speedRow", "aiLineRow"]) {
    document.getElementById(id)?.classList.toggle("hidden", online);
  }

  // 全 AI 观战模式没有"自己的车可交给算法"，这个开关没有意义
  document.getElementById("autopilotPill")?.classList.toggle("hidden", mode === "spectate");
}

function openConfirmModal(title, desc, onConfirm) {
  const modal = document.getElementById("confirmModal");
  if (!modal) return;
  const titleEl = document.getElementById("confirmTitle");
  const descEl = document.getElementById("confirmDesc");
  const okBtn = document.getElementById("confirmOkBtn");
  if (titleEl && title) titleEl.textContent = title;
  if (descEl && desc) descEl.textContent = desc;

  const handleOk = () => {
    closeConfirmModal();
    onConfirm?.();
    okBtn.removeEventListener("click", handleOk);
  };
  okBtn.onclick = handleOk;

  modal.classList.add("open");
  isModalOpen = true;
}

// 在线对战退出确认：不冻结比赛，先把自车交给自动驾驶。
// 玩家取消则收回自动驾驶，确认则带着算法继续跑完退出前的最后一小段（服务端判负）。
function openOnlineQuitConfirm() {
  if (!isAutopilotOn()) {
    quitConfirmAutoTakeover = true;
    toggleAutopilot(true, { persist: false });
  }
  onlineQuitConfirmOpen = true;
  openConfirmModal(
    "确认退出比赛",
    "比赛仍在继续，你的赛车已暂时交给自动驾驶。多人对战中途退出将被判定为认输 (Surrender)。确认退出并返回在线大厅吗？",
    quitOnlineRaceWithSurrender
  );
}

function closeConfirmModal() {
  const modal = document.getElementById("confirmModal");
  if (modal) modal.classList.remove("open");
  if (onlineQuitConfirmOpen) {
    onlineQuitConfirmOpen = false;
    if (quitConfirmAutoTakeover) {
      quitConfirmAutoTakeover = false;
      toggleAutopilot(false, { persist: false });
    }
  }
  syncModalOpen();
}

// 只退出"自己这辆车"的在线比赛：停止本地渲染与状态上报，不动服务器上的其他车手。
// 用于房间内点「离开房间」/ 断线重连后看到房间界面等场景：
// 之前这里不处理比赛态，会出现"已经退出房间，但本地比赛还在跑"的情况。
function exitLocalNetRace() {
  if (mode !== "onlinerace") return;
  stopNetRace();
  hideResults();
  hideMsg(true);
  resetSimClock(0);
  mode = "online";
  releaseFocusAutopilot(true);
  started = false;
  resultsShown = false;
  finishAt = 0;
  winner = null;
  updateTopControls();
}

// 主动离开在线流程：终止/认输在线比赛 + 退出房间。
// 必须在切回主菜单前调用，否则服务端仍把你留在房间里，房主一开赛会被拽回对局。
function leaveOnlineSession() {
  forfeitNetRace();   // 内部判断是否在比赛中；服务端同帧判负并移除
  stopNetRace();
  leaveOnlineRoom();  // 不在房间时是空操作
  hideOnlineUI();
}

// 在线比赛退出并判定为认输，回到在线大厅
function quitOnlineRaceWithSurrender() {
  forfeitNetRace();
  stopNetRace();
  leaveOnlineRoom();
  exitToOnlineLobby();
  showMsg("已退出比赛", "已认输并返回在线大厅", 2500);
}

// 退出并返回在线大厅界面（仍在在线模式下，可继续选房间）
function exitToOnlineLobby() {
  hideResults();
  closeConfirmModal();
  started = false;
  resultsShown = false;
  finishAt = 0;
  winner = null;
  mode = "online";
  releaseFocusAutopilot(true);
  try { location.hash = "#/online"; } catch (e) {}
  resetSimClock(0);

  showOnlineStep();
  openStartModal();
  isModalOpen = true;
  showOnlineUI();
  updateTopControls();
}

function updateHelpText() {
  const help = document.getElementById("helpBody");
  if (!help) return;
  // 自动驾驶开启时给个明确提示（键盘操作不再作用于你的车）
  const auto = isAutopilotOn() ? "<br>🤖 自动驾驶中：你的赛车由算法驾驶（Esc → 重选模式 可关闭）" : "";
  if (mode === "onlinerace") {
    // 在线：可以换视角，但换走时自己的车会临时交给算法；Esc 是"退出/认输"而不是重选模式
    const focusAuto = focusAutopilot
      ? "<br>🤖 正在看别人的视角：你的车已交给本地算法驾驶（切回自己的车即交还键盘）"
      : (isAutopilotOn() ? "<br>🤖 自动驾驶中：你的赛车由算法驾驶" : "");
    help.innerHTML = "在线竞速 · J 油门　K 轻刹　L 重刹 · 1-7 / Tab 换视角 · B 自动驾驶 · Esc 退出 (认输)" + focusAuto;
  } else if (mode === "spectate") {
    help.innerHTML = "AI 锦标赛 · 点击顶部或按 T 选赛道 · 1-7 换视角 · + / - 倍速快进 · R 重开 · Esc 菜单";
  } else if (mode === "vs") {
    help.innerHTML = "J 油门　K 轻刹　L 重刹/倒车 · ← → / A D 转向 · 1-7 换视角 · B 自动驾驶 · T 选赛道 · R 重开 · Esc 菜单" + auto;
  } else {
    help.innerHTML = "J 油门　K 轻刹　L 重刹/倒车 · ← → / A D 转向 · B 自动驾驶 · T 选赛道 · R 重开 · Esc 菜单" + auto;
  }
}

function initStartFlow() {
  // 开局面板（模式 / 赛车 / 在线）的 DOM 与返回按钮由 ui/menuPanels.js 管理
  initMenuPanels({
    onSelectMode: selectMode,
    onSelectCar: selectCar,
    onBack: () => backToMainMenu(),   // ← 返回：任何一步都能回到主菜单（在线会先退房间/比赛）
  });

  // 比赛中随时重选玩法模式与赛车
  const reopenBtn = document.getElementById("reopenStartBtn");
  if (reopenBtn) reopenBtn.addEventListener("click", reopenStartFlow);

  // 自动驾驶开关（顶栏常驻）：点击或按 B 都走这一条路径
  const autoPill = document.getElementById("autopilotPill");
  if (autoPill) autoPill.addEventListener("click", toggleAutopilotQuick);

  // 在线模式退出/认输按钮
  const quitBtn = document.getElementById("quitOnlineBtn");
  if (quitBtn) {
    quitBtn.addEventListener("click", openOnlineQuitConfirm);
  }

  // 确认弹窗关闭与取消
  document.getElementById("closeConfirmModal")?.addEventListener("click", closeConfirmModal);
  document.getElementById("confirmCancelBtn")?.addEventListener("click", closeConfirmModal);

  initResultsModal();

  initOnlineUI({
    onStartPractice: startOnlinePractice,
    onExit: () => backToMainMenu(),
    onOpenAutopilot: () => openAutopilot(),
    // 退出房间前：把自己正在跑的比赛彻底停掉（认输/移出由服务端统一处理，其他车友不受影响）
    onBeforeLeaveRoom: exitLocalNetRace,
    onDisconnected: () => {
      // 在线比赛中掉线：终止比赛退回主菜单
      if (mode === "onlinerace") {
        stopNetRace();
        backToMainMenu();
      }
      showMsg("与服务器断开连接", "", 2500);
    },
  });

  // 在线即时对战：race_start → 切入 onlinerace 模式。
  // 已经回到主菜单（不在在线流程里）时，直接拒绝，避免被别人的房间拽进对局
  conn.on("race_start", (msg) => {
    if (mode !== "online" && mode !== "onlinerace") {
      if (conn.isOpen()) conn.send({ t: "surrender" });
      return;
    }
    startOnlineRace(msg);
  });
  bindNetRaceHandlers();
}

// ================= 在线即时对战（服务器权威模拟） =================
function startOnlineRace(msg) {
  hideOnlineUI();
  closeStartModal();
  closeTrackModal();
  isModalOpen = false;
  resultsShown = false;
  onlinePractice = false;
  mode = "onlinerace";
  started = true;
  lastNetSimAt = 0;   // 新一局：重置在线节拍的时间基准

  resetSimClock(0);
  firstFinishAt = 0;
  // 在线成绩由服务器权威判定：客户端不允许改车（调校面板禁用），避免"客户端自己加性能"
  setTunerEnabled(false);

  initHud(true, switchFocusCar);
  // 在线对战的玩家车在本地模拟：自动驾驶算法交给 netrace 驱动
  setNetAutopilot(isAutopilotOn(), getAutopilotDriver());
  cars = startNetRace(msg, conn.session?.sid);
  focusIndex = Math.max(0, cars.findIndex(c => c.isPlayer));
  releaseFocusAutopilot(true);   // 上一局残留的"换视角接管"不能带进新一局
  switchFocusCar(focusIndex);
  fx.clearEffects();
  hideMsg(true);
  finishAt = 0;
  winner = null;
  updateTrackUI();
  updateHelpText();
  showMsg("在线对战", "QQ飞车即时碰撞 · 等待发车", 1500);
  updateTopControls();
  try { location.hash = "#/online/race"; } catch (e) {}
}

// 在线单人练习：复用 solo 流程，完赛成绩自动上传服务器排行榜
function startOnlinePractice() {
  hideOnlineUI();
  onlinePractice = true;
  mode = "solo";
  showCarStep("solo");
  const title = document.getElementById("startTitle");
  const desc = document.getElementById("startDesc");
  if (title) title.textContent = "选择你的赛车 (ONLINE 练习)";
  if (desc) desc.textContent = "独自刷圈，完赛成绩将自动上传服务器排行榜";
  openStartModal();
  isModalOpen = true;
}

// ================= 比赛中重选模式 / 赛车 =================

// ================= 规范 Hash 路由调度器 =================
function handleRoute() {
  const hash = (location.hash || "").replace(/^#\/?/, "");
  const [route] = hash.split("/");

  if (route === "spectate") {
    if (mode !== "spectate" || !started) {
      mode = "spectate";
      playerCarId = null;
      closeStartModal();
      closeTrackModal();
      document.getElementById("resultsModal")?.classList.remove("open");
      isModalOpen = false;
      startGame();
    }
  } else if (route === "solo" || route === "vs") {
    // 已经在对应模式里就不要再打断（否则每次 hash 变化都会重开）
    if (mode !== route) selectMode(route);
  } else if (route === "online") {
    if (mode !== "onlinerace" && mode !== "online") selectMode("online");
  } else if (route === "menu" || !route) {
    // 主菜单是根：无论当前在比赛还是在房间，都允许回来（在线会先退房间/认输）
    if (started || mode === "online" || mode === "onlinerace") backToMainMenu();
    else backToModeStep();
  }
  updateTopControls();
}

window.addEventListener("hashchange", handleRoute);

// 比赛中「重选模式」= 放弃当前比赛回到主菜单
function reopenStartFlow() {
  if (resultsShown) return;
  backToMainMenu();
}

// ================= 结算大屏 =================
function hideResults() {
  const homeBtn = document.getElementById("resultsHomeBtn");
  if (homeBtn) homeBtn.textContent = mode === "onlinerace" ? "🚪 返回在线大厅" : "🏠 回到主页面";
  const modal = document.getElementById("resultsModal");
  if (modal) modal.classList.remove("open");
  resultsShown = false;
  syncModalOpen();   // 只在没有其他弹窗打开时解除比赛冻结
}

function showResults() {
  const modal = document.getElementById("resultsModal");
  if (!modal) return;
  // 比赛已结束，退出确认失去意义：关掉弹窗并归还临时自动驾驶
  if (onlineQuitConfirmOpen) closeConfirmModal();
  resultsShown = true;
  isModalOpen = true;   // 冻结比赛

  const maxLaps = effectiveLaps(currentTrack?.laps);
  const trackName = `${currentTrack.flag} ${currentTrack.name}`;
  const title = document.getElementById("resultsTitle");
  const desc = document.getElementById("resultsDesc");
  const trackEl = document.getElementById("resultsTrack");
  const table = document.getElementById("resultsTable");

  // 排名规则：完赛车按总用时升序在前；未完赛车按里程排后
  const order = cars
    .map((car, i) => ({ car, i }))
    .sort((a, b) => {
      const af = a.car.finished ? 1 : 0, bf = b.car.finished ? 1 : 0;
      if (af !== bf) return bf - af;
      if (af) return (a.car.total || 0) - (b.car.total || 0);
      return (b.car.raceDist || 0) - (a.car.raceDist || 0);
    });

  const champ = order[0]?.car;
  if (title) {
    title.textContent = mode === "solo"
      ? "🏁 计时结束"
      : `🏁 ${champ ? driverLabel(champ) : ""} 夺得冠军`;
  }
  if (desc) {
    const finishedCount = cars.filter(c => c.finished && !c.retired).length;
    desc.textContent = `${trackName} · ${maxLaps} 圈 · ${finishedCount}/${cars.length} 台完赛`;
  }
  if (trackEl) trackEl.textContent = trackName;

  // 全场最快圈（紫色高亮）
  let overallBest = Infinity;
  for (const c of cars) {
    if (c.best && c.best < overallBest) overallBest = c.best;
  }

  let prevTotal = null;
  const rowsHtml = order.map((item, rank) => {
    const c = item.car;
    const isPlayer = !!c.isPlayer;
    const code = driverCode(c) || carNumberLabel(c);
    const totalText = c.retired
      ? `<span class="rr-out">退赛</span>`
      : c.finished ? fmt(c.total) : `<span class="rr-out">未完赛</span>`;
    const gapText = rank === 0
      ? (mode === "solo" ? "—" : "WINNER")
      : c.retired ? "OUT"
        : (c.finished && prevTotal != null ? "+" + fmt(c.total - prevTotal) : "—");
    if (c.finished && !c.retired) prevTotal = c.total;
    return `
      <div class="result-row p${rank + 1} ${isPlayer ? "player" : ""}">
        <span class="rr-rank">${rank + 1}</span>
        <span class="rr-color" style="background:${c.color || "#ff4a5e"}"></span>
        <span class="rr-name">${escapeHtml(driverLabel(c))}${code ? `<small class="rr-code">${escapeHtml(code)}</small>` : ""}${isPlayer ? '<i class="rr-you">YOU</i>' : ""}${c.isAI ? '<span class="rr-ai">AI</span>' : ""}</span>
        <span class="rr-car">${escapeHtml(carModelLabel(c))}</span>
        <span class="rr-total">${totalText}</span>
        <span class="rr-best ${c.best === overallBest ? "purple" : ""}">${fmt(c.best)}</span>
        <span class="rr-gap">${gapText}</span>
      </div>
    `;
  }).join("");

  if (table) {
    table.innerHTML = `
      <div class="result-row result-head">
        <span class="rr-rank">#</span>
        <span class="rr-color"></span>
        <span class="rr-name">车手</span>
        <span class="rr-car">车型</span>
        <span class="rr-total">总用时</span>
        <span class="rr-best">最快圈速</span>
        <span class="rr-gap">差距</span>
      </div>
      ${rowsHtml}
    `;
  }

  modal.classList.add("open");

  // 在线单人练习：成绩上传服务器排行榜
  const uploadEl = document.getElementById("resultsUpload");
  if (uploadEl) {
    if (mode === "solo" && onlinePractice && conn.isOpen() && champ) {
      uploadEl.textContent = "⏳ 正在上传成绩到服务器排行榜…";
      uploadResult(champ).then(ok => {
        uploadEl.textContent = ok
          ? "✅ 成绩已上传至服务器排行榜（大厅可查看排名）"
          : "⚠️ 成绩未通过服务器合理性校验，未计入排行榜";
      }).catch(() => {
        uploadEl.textContent = "❌ 上传失败：服务器连接异常";
      });
    } else if (mode === "solo" && onlinePractice) {
      uploadEl.textContent = "⚠️ 未连接服务器，成绩未上传";
    } else {
      uploadEl.textContent = "";
    }
  }
}

// 提交在线练习成绩（REST）
async function uploadResult(car) {
  const res = await fetch(conn.httpBase + "/api/leaderboard", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      fingerprint: getFingerprint(),
      nickname: conn.session?.nickname,
      trackId: currentTrackId,
      carId: car.id,
      bestLapMs: Math.round(car.best || 0),
      totalMs: Math.round(car.total || 0),
      laps: car.lapTimes?.length || 1,
    }),
  });
  const data = await res.json();
  return !!(data.ok && data.validated);
}

// 结算大屏按钮：再来一局 / 回到主页面
function initResultsModal() {
  const restartBtn = document.getElementById("resultsRestartBtn");
  if (restartBtn) {
    restartBtn.addEventListener("click", () => {
      hideResults();
      if (mode === "onlinerace") {
        // 房间还在：直接请求服务器重开（非房主/未就绪时服务端会拒绝并保持在房间）
        stopNetRace();   // 清掉上一次比赛结果，避免结算屏立即复现
        conn.send({ t: "room_start" });
        showMsg("等待开赛", "房主可再次点击开始", 2000);
        const startModal = document.getElementById("startModal");
        if (startModal) startModal.classList.remove("open");
      } else {
        reset();
      }
    });
  }
  const homeBtn = document.getElementById("resultsHomeBtn");
  if (homeBtn) {
    homeBtn.addEventListener("click", () => {
      if (mode === "onlinerace") {
        exitToOnlineLobby();
      } else {
        backToMainMenu();
      }
    });
  }
}

// 回到主页面：重置到"选择玩法模式"开局弹窗
function backToMainMenu() {
  hideResults();
  offTrackWarnEl?.classList.add("hidden");
  playerCarId = null;
  finishAt = 0;
  winner = null;
  hideMsg(true);
  // backToModeStep 内部会先退出在线房间/比赛，再复位到"选择玩法模式"
  backToModeStep();
  syncModalOpen();
}

// ================= 视图工具：AI 探测线开关 + 视野缩放系数 =================
function initViewTools() {
  // 画质：自动按帧率调整渲染分辨率；高/中/低为固定档位（会重建赛道贴图）
  const qualitySelect = document.getElementById("qualitySelect");
  if (qualitySelect) {
    qualitySelect.value = getQualityMode();
    qualitySelect.addEventListener("change", () => setQualityMode(qualitySelect.value));
  }
  updateQualityInfo();

  // 比赛倍速 chips
  const speedWrap = document.getElementById("speedChips");
  if (speedWrap) {
    speedWrap.innerHTML = SPEED_STEPS.map(s =>
      `<button class="speed-chip ${s === speedMult ? "active" : ""}" data-speed="${s}" title="${s}× 速度">${s}×</button>`).join("");
    speedWrap.addEventListener("click", (e) => {
      const chip = e.target.closest("[data-speed]");
      if (chip) setSpeedMult(Number(chip.getAttribute("data-speed")));
    });
  }

  const toggle = document.getElementById("aiLineToggle");
  if (toggle) {
    const sync = () => {
      toggle.classList.toggle("on", showAILine);
      toggle.setAttribute("aria-pressed", String(showAILine));
    };
    toggle.addEventListener("click", () => {
      showAILine = !showAILine;
      sync();
    });
    sync();
  }

  const range = document.getElementById("zoomRange");
  const val = document.getElementById("zoomVal");
  const applyZoom = () => {
    const z = Number(range.value) || 1;
    setZoomScale(z);
    if (val) val.textContent = z.toFixed(2) + "×";
  };
  if (range) {
    range.addEventListener("input", applyZoom);
    applyZoom();
  }

  const resetBtn = document.getElementById("zoomReset");
  if (resetBtn) {
    resetBtn.addEventListener("click", () => {
      if (range) {
        range.value = "1";
        applyZoom();
      }
      // 滑杆归位之外，镜头也要立刻吸附回当前焦点车：
      // 只改缩放系数时，若本来就接近 1× 会"看起来毫无反应"
      const car = cars[focusIndex];
      if (car) resetCamera(car);

      resetBtn.textContent = "已复位";
      resetBtn.classList.add("is-done");
      clearTimeout(resetBtn._doneTimer);
      resetBtn._doneTimer = setTimeout(() => {
        resetBtn.textContent = "复位视图";
        resetBtn.classList.remove("is-done");
      }, 900);
    });
  }

  // 视图工具 / 操作说明：点击标题栏折叠展开（HTML 里默认 collapsed）
  for (const id of ["viewTools", "help"]) {
    const panel = document.getElementById(id);
    panel?.querySelector(".panel-header")?.addEventListener("click", () => {
      panel.classList.toggle("collapsed");
    });
  }
}

// 设置比赛倍速（并刷新 chips 高亮）
function setSpeedMult(mult) {
  speedMult = SPEED_STEPS.includes(mult) ? mult : 1;
  document.querySelectorAll("#speedChips .speed-chip").forEach(chip => {
    chip.classList.toggle("active", Number(chip.getAttribute("data-speed")) === speedMult);
  });
}

function cycleSpeed(dir) {
  const idx = SPEED_STEPS.indexOf(speedMult);
  const next = Math.max(0, Math.min(SPEED_STEPS.length - 1, idx + dir));
  setSpeedMult(SPEED_STEPS[next]);
}

// ================= 在线对战的模拟节拍 =================
// 物理推进和 car_state 上报都不能只挂在 rAF 上：浏览器会把"被遮挡/后台"窗口的 rAF
// 降到 ~2Hz（实测 2.3Hz，而同一时刻 setInterval 仍有 61Hz）。一旦 rAF 停摆，
// 自车几乎不动、上报也一起停发，别人屏幕上的你就会变成
// "250ms 直线外推 → 定格 → 瞬移"。这里用 16ms 定时器兜底：
//   · rAF 健康（60ms 内有帧）→ 定时器只做一次时间比较就返回，零影响
//   · rAF 被节流 → 由定时器按真实流逝时间接管，物理与上报始终保持 60Hz
const NET_FALLBACK_GAP_MS = 60;
let lastRafAt = 0;
let lastNetSimAt = 0;
let netFallbackTimer = 0;
// 两次绘制之间累计推进的模拟时间（秒）。
// 镜头/特效用它而不是 rAF 的 dt：物理可能被 16ms 定时器、或被掉帧补偿推进了 66~250ms，
// 画面若只按 rAF dt（还被钳在 50ms）走，自车就会在屏幕上"先窜一段、再被镜头追回来"。
let netSimAccum = 0;
let lastNetGapMs = 0;
let lastNetSteps = 0;
let lastVisualDt = 0;

// 帧节奏诊断（__gp.perf）：最近 120 帧的真实间隔 + 上一帧模拟/画面推进时间。
// 判断"自车抖"到底是帧率问题还是时钟不同步：sim.gapMs ≈ sim.visualMs 才说明两者同源。
const FRAME_WIN = 120;
const frameGaps = new Float32Array(FRAME_WIN);
let frameGapIdx = 0;
let frameGapCount = 0;
function recordFrameGap(ms) {
  frameGaps[frameGapIdx] = ms;
  frameGapIdx = (frameGapIdx + 1) % FRAME_WIN;
  if (frameGapCount < FRAME_WIN) frameGapCount++;
}

function advanceNetSim(nowMs) {
  if (!lastNetSimAt) { lastNetSimAt = nowMs; return; }
  const prevMs = lastNetSimAt;
  let gap = (nowMs - prevMs) / 1000;
  lastNetSimAt = nowMs;
  if (gap <= 0) return;
  if (gap > 0.25) gap = 0.25;   // 长卡顿/切后台：最多补 250ms，避免物理积分爆掉
  const steps = Math.min(8, Math.max(1, Math.ceil(gap / MAX_SUBSTEP_DT)));
  const stepDt = gap / steps;
  netSimAccum += gap;
  lastNetGapMs = gap * 1000;
  lastNetSteps = steps;
  // 碰撞只在最后一步解算：拆步是"补时间"，不是"多撞几次"。
  // 旧写法每步都跑一次非对称碰撞，掉帧补 3 步时自车会被 -45% 速度差和硬分离惩罚 3 次。
  for (let i = 0; i < steps; i++) {
    // 上报时间戳一律用【真实时间】nowMs，不能用"补推后的模拟时刻"。
    // 因为 gap 被钳到 250ms 时，模拟时刻会比真实时间永久落后一大截（卡死 14.5 秒就是落后 14 秒），
    // 于是样本时间戳出现 14 秒的年代断层；接收端的最小值锁相会被这条断层污染，
    // 之后这辆车的样本永远"偏老"，别人只能一直替它直线外推（现象：位置提前 + 车头不转 + 抽搐）。
    // 位置与时间戳的微小不一致（补推那一段走得少）由接收端的时间轴断层检测兜掉。
    update(stepDt, i === steps - 1, nowMs);
  }
}

function startNetFallback() {
  if (netFallbackTimer) return;
  netFallbackTimer = setInterval(() => {
    if (mode !== "onlinerace" || !started) return;
    const now = performance.now();
    if (now - lastRafAt < NET_FALLBACK_GAP_MS) return;   // rAF 正常 → 完全让位
    advanceNetSim(now);
  }, 16);
}

let prevTs = 0;
function frame(ts) {
  requestAnimationFrame(frame);
  if (!prevTs) prevTs = ts;
  const now = performance.now();
  // 用回调真实开始时刻而不是 ts：ts 是"帧起点"，回调真正执行时已经晚了几毫秒到几十毫秒，
  // 混用会让 30fps（每帧 JS 约 30ms）的机器被误判成"rAF 已停摆"，定时器跟着多推一遍模拟。
  lastRafAt = now;
  const rawDt = (ts - prevTs) / 1000;
  prevTs = ts;
  if (started) recordFrameGap(rawDt * 1000);
  // 自动画质：只在真正跑比赛、无弹窗、页面可见时采样真实帧间隔。
  // 降档会立刻重建后备画布；升档有长冷却，避免在 60Hz 边界来回抖。
  if (started && !isModalOpen && document.visibilityState === "visible") {
    if (sampleFrameQuality(rawDt * 1000, now)) resize();
  }
  let dt = rawDt;
  if (dt > 0.05) dt = 0.05;

  // 右下方帧率角标：每 500ms 统计一次，避免逐帧数字抖动
  if (fpsValueEl) {
    if (!fpsWindowStart) fpsWindowStart = ts;
    fpsFrames++;
    const fpsSpan = ts - fpsWindowStart;
    if (fpsSpan >= 500) {
      fpsValueEl.textContent = String(Math.round((fpsFrames * 1000) / fpsSpan));
      fpsFrames = 0;
      fpsWindowStart = ts;
    }
  }

  if (!started) return;   // 开局选择阶段（模式 / 赛车弹窗）不渲染比赛

  // 倍速快进：本地模式的比赛时间 ×N，切成固定物理子步推进
  // （在线对战是服务器实时权威模拟，倍速只作用于本地单机类模式）
  // visualDt = 本帧画面（镜头/粒子）应该推进的时间，必须与自车物理推进的时间严格一致：
  //   · 在线：两次绘制之间物理实际推进了多少（可能来自定时器 + 掉帧补偿），画面就用多少
  //   · 单机：模拟时间 = 真实时间 × 倍速
  let visualDt;
  if (mode === "onlinerace") {
    // 在线对战统一走"真实时间"节拍：rAF 正常时就是这里推进，被节流时由定时器接管
    advanceNetSim(now);
    visualDt = netSimAccum > 0 ? Math.min(0.25, netSimAccum) : dt;
    netSimAccum = 0;
  } else {
    lastNetSimAt = 0;   // 离开在线模式：清掉时间基准，避免下次带着旧时间戳补帧
    netSimAccum = 0;
    const scaled = dt * speedMult;
    const steps = Math.min(32, Math.max(1, Math.ceil(scaled / MAX_SUBSTEP_DT)));
    const stepDt = scaled / steps;
    for (let i = 0; i < steps; i++) {
      update(stepDt);
      if (isModalOpen) break;   // 弹窗打开（结算/选赛道）后停止剩余子步
    }
    visualDt = scaled;
  }
  lastVisualDt = visualDt;
  syncTuner(cars[focusIndex]);   // 切车时把调校面板同步到当前焦点赛车

  // 冲出正常路线（车轮压在草地上）提示：不依赖背景明暗，直接闪红警告
  const offTrack = !isModalOpen && cars[focusIndex]?.surf === 2;
  offTrackWarnEl?.classList.toggle("hidden", !offTrack);

  // 全 AI 观战模式：全员完赛后自动重开（结算大屏弹出时暂停自动重开）
  if (mode === "spectate" && finishAt && !resultsShown && performance.now() - finishAt > AI_RESTART_DELAY) reset();

  const activeCar = cars[focusIndex] || cars[0];
  if (!activeCar) return;   // 极端情况下车辆池已清空（退出比赛途中）：本帧跳过渲染，避免空引用
  // AI 输入池只在与 cars 同源建立时才有对应项（在线模式/切视角后可能为空），缺项时退回玩家输入
  const activeCtrl = (isAIDriven(focusIndex) ? aiInputs[focusIndex] : input) || input;

  // 倍速下镜头/粒子必须按"模拟时间"推进：
  // 车辆以 N 倍速前进，若镜头仍按真实时间慢慢追（时间常数 ~0.24s），
  // 4× 时稳态滞后就会被放大 4 倍，车会被甩到画面边缘甚至屏幕外。
  // 在线模式同理（见上方 visualDt）：镜头与自车必须走同一个时钟，否则掉帧时车会"窜一下再被追回"。
  updateCamera(activeCar, visualDt);
  fx.updateEffects(visualDt);
  // 弹窗（赛道选择 / 开局重选 / 结算大屏）打开时引擎声回落怠速；
  // 在线退出确认是例外：自动驾驶仍在跑，引擎声继续
  const raceAudible = race.state === "racing" && !resultsShown && (!isModalOpen || onlineQuitConfirmOpen);
  audio.updateAudio(activeCar, activeCtrl, dt, raceAudible);
  tickMsg(performance.now());
  draw();

  // 刷新 HUD（对战/观战模式刷新多车排位与实时 G 值遥测；单人模式刷新单人 HUD）
  // 计时塔属于低频信息：10~12Hz 肉眼完全够用。144Hz 屏上每帧刷 8 行 DOM（约 160 次写操作）
  // 会把 6.9ms 的单帧预算吃掉一大块，这是双人联机掉到 30fps 的主要来源之一。
  if (mode !== "solo") {
    if (now - lastAiHudAt >= AI_HUD_INTERVAL_MS) {
      lastAiHudAt = now;
      updateAIHUD(cars, focusIndex, switchFocusCar);
    }
  } else if (now - lastSoloHudAt >= SOLO_HUD_INTERVAL_MS) {
    lastSoloHudAt = now;
    updateHUD(activeCar);
  }
}

resize();
initInput(reset);
audio.setupAudio();
initTrackSelector();
initStartFlow();
initViewTools();
initTuner();
initAutopilot();
// 自动驾驶开关变化时，把最新算法同步给在线对战的本地模拟
onAutopilotChange(() => setNetAutopilot(isAutopilotOn(), getAutopilotDriver()));

updateHelpText();

updateTopControls();
if (SPECTATE) {
  location.hash = "#/spectate";
  startGame();
} else {
  handleRoute();
}

startNetFallback();   // 在线模式：rAF 被浏览器节流时由它保持 60Hz 模拟与上报
requestAnimationFrame(frame);

window.__gp = {
  get cars() { return cars; },
  net: netrace,   // 在线对战诊断（net.stats：播放延迟 / 抖动峰值 / 各远端车新鲜度）
  conn,           // 连接诊断（conn.transport: udp / websocket；conn.rtcState）
  rtc,            // UDP 通道诊断（rtc.debugInfo(): ICE/连接状态）
  // 帧节奏诊断：frame.avgMs/maxMs/hitches 是 rAF 真实间隔；sim.gapMs 是上一帧物理推进的时间，
  // sim.visualMs 是同一帧画面推进的时间 —— 两者相等才说明自车与镜头同源（不再"窜一下再追回"）。
  perf: {
    get frame() {
      if (!frameGapCount) return null;
      let sum = 0, max = 0, hitches = 0;
      for (let i = 0; i < frameGapCount; i++) {
        const g = frameGaps[i];
        sum += g;
        if (g > max) max = g;
        if (g > 50) hitches++;
      }
      return { avgMs: +(sum / frameGapCount).toFixed(1), maxMs: +max.toFixed(1), hitches, n: frameGapCount };
    },
    get sim() {
      return { gapMs: +lastNetGapMs.toFixed(1), steps: lastNetSteps, visualMs: +(lastVisualDt * 1000).toFixed(1) };
    },
    // 当前渲染档位 / 动态分辨率 / 实际后备像素 / 赛道贴图超采样倍率
    get quality() { return getQualityStats(); },
    // 画布实际像素：填充成本与像素面积成正比，4K/Retina 上这是最容易失控的一项
    get canvas() {
      return {
        w: canvas.width, h: canvas.height,
        cssW: Math.round(canvas.getBoundingClientRect().width),
        dpr: +(canvas.width / Math.max(1, canvas.getBoundingClientRect().width)).toFixed(2),
        px: Math.round(canvas.width * canvas.height / 1e6 * 10) / 10,
      };
    },
  },
  race, input, aiInputs, pts,
  get mode() { return mode; },
  get ai() { return mode !== "solo"; },
  get started() { return started; },
  get speedMult() { return speedMult; },
  audio: audio.audioState
};
