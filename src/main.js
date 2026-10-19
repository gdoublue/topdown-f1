// 主入口：组装各模块并驱动主循环（支持多赛道切换与多赛车不同算法同场竞速）
import { TOTAL_LAPS } from "./config.js";
import { TRACKS, getTrack } from "./track/tracks.js";
import { WORLD, pts, N, switchTrack, currentTrack, currentTrackId } from "./track/geometry.js";
import { buildTrackCanvas } from "./track/render.js";
import { createCar, stepCar, resolveCarCollisions, finishedCarInput } from "./car/physics.js";
import { drawCar } from "./car/render.js";
import { resetCamera, updateCamera, applyCamera, setZoomScale } from "./game/camera.js";
import { initInput, input, NO_INPUT } from "./game/input.js";
import * as fx from "./game/effects.js";
import { race, resetRace, tickCountdown, initCarRaceState, updateCarLap } from "./game/race.js";
import { initHud, fmt, showMsg, hideMsg, msgText, tickMsg, updateHUD, updateAIHUD, setOnSelectCar } from "./game/hud.js";
import { initTuner, syncTuner } from "./game/tuner.js";
import { initMinimap, drawMinimap } from "./game/minimap.js";
import * as audio from "./game/audio.js";
import { AI_CONFIGS, applyCarConfig, buildGridSlots, createAIInput, driveAI, AI_RESTART_DELAY, rebuildAITrack } from "./game/ai.js";

// ?ai=1 → 全 AI 锦标赛观战（npm run ai 会带这个参数打开，跳过开局选择）
const SPECTATE = new URLSearchParams(location.search).has("ai");

const canvas = document.getElementById("cv");
const ctx = canvas.getContext("2d");
let trackCanvas = buildTrackCanvas();

initMinimap();

// 玩法模式：null(未选择) | "solo"(单人计时) | "vs"(与 AI 同场竞速) | "spectate"(全 AI 观战)
let mode = SPECTATE ? "spectate" : null;
let playerCarId = null;   // 玩家选择的赛车 id（solo / vs）
let playerIndex = 0;      // 玩家在 cars 数组中的下标
let started = false;      // 完成"模式 → 赛车"选择后才开始倒计时

// 赛车列表：对战/观战模式装载全部 AI 配置；单人模式只有玩家一辆
let cars = [];
let aiInputs = [];
let focusIndex = 0;
let finishAt = 0;
let winner = null;      // 全场首位冲线车辆（冠军与观察视角无关）
let showAILine = true;  // 是否绘制焦点赛车的 AI 前瞻目标点与引线（可在视图面板关闭）

// 洗牌算法：用于每局发车位随机排位
function shuffle(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// 该下标车辆是否由 AI 驾驶（观战模式全为 AI；对战模式除玩家外全为 AI；单人模式无 AI）
function isAIDriven(i) {
  return mode === "spectate" || (mode === "vs" && i !== playerIndex);
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
    car.isPlayer = (i === playerIndex);
    initCarRaceState(car);
    cars.push(car);
    aiInputs.push(createAIInput());
  }
}

function switchFocusCar(idx) {
  if (idx < 0 || idx >= cars.length) return;
  focusIndex = idx;
  resetCamera(cars[focusIndex]);
  audio.syncCarAudio(cars[focusIndex]);
}
setOnSelectCar(switchFocusCar);

function reset() {
  if (!started) return;   // 开局选择阶段还没有车
  setupCars();
  resetRace();
  switchFocusCar(playerIndex);
  fx.clearEffects();
  hideMsg(true);
  finishAt = 0;
  winner = null;
}

function resize() {
  const r = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.max(1, Math.round(r.width * dpr));
  canvas.height = Math.max(1, Math.round(r.height * dpr));
}
window.addEventListener("resize", resize);

let isModalOpen = false;

function updateTrackUI() {
  const pillFlag = document.getElementById("pillFlag");
  const pillName = document.getElementById("pillName");
  const pillLen = document.getElementById("pillLen");
  if (pillFlag) pillFlag.textContent = currentTrack.flag;
  if (pillName) pillName.textContent = currentTrack.name;
  if (pillLen) pillLen.textContent = (currentTrack.length / 1000).toFixed(2) + "km";

  const label = mode === "spectate" ? "AI 锦标赛 · " : mode === "vs" ? "对战 AI · " : "俯视 F1 · ";
  document.title = label + currentTrack.name;
}

function renderTrackCards() {
  const grid = document.getElementById("trackCardsGrid");
  if (!grid) return;
  grid.innerHTML = TRACKS.map(t => {
    const isCur = t.id === currentTrackId;
    return `
      <div class="track-card ${isCur ? 'active' : ''}" data-track-id="${t.id}">
        ${isCur ? '<div class="active-badge">CURRENT</div>' : ''}
        <div class="track-card-top">
          <span class="track-card-flag">${t.flag}</span>
          <span class="track-card-len">${(t.length / 1000).toFixed(2)} km · ${t.turns} 弯</span>
        </div>
        <div class="track-card-title">${t.name}</div>
        <div class="track-card-en">${t.nameEn}</div>
        <div class="track-card-tag">${t.tag}</div>
        <p class="track-card-desc">${t.desc}</p>
      </div>
    `;
  }).join("");
}

export function openTrackModal() {
  const modal = document.getElementById("trackModal");
  if (modal) {
    renderTrackCards();
    modal.classList.add("open");
    isModalOpen = true;
  }
}

export function closeTrackModal() {
  const modal = document.getElementById("trackModal");
  if (modal) {
    modal.classList.remove("open");
    isModalOpen = false;
  }
}

export function applyTrack(trackId) {
  switchTrack(trackId);
  trackCanvas = buildTrackCanvas();

  try {
    const url = new URL(window.location.href);
    url.searchParams.set("track", trackId);
    window.history.replaceState(null, "", url.toString());
  } catch (e) {}

  updateTrackUI();
  initMinimap();
  reset();
  renderTrackCards();
  closeTrackModal();
}

function initTrackSelector() {
  updateTrackUI();
  renderTrackCards();

  const pill = document.getElementById("trackSwitcherPill");
  if (pill) pill.addEventListener("click", openTrackModal);

  const closeBtn = document.getElementById("closeTrackModal");
  if (closeBtn) closeBtn.addEventListener("click", closeTrackModal);

  const modal = document.getElementById("trackModal");
  if (modal) {
    modal.addEventListener("click", (e) => {
      if (e.target === modal) closeTrackModal();
    });
  }

  const grid = document.getElementById("trackCardsGrid");
  if (grid) {
    grid.addEventListener("click", (e) => {
      const card = e.target.closest(".track-card");
      if (card) {
        const tid = card.getAttribute("data-track-id");
        if (tid) applyTrack(tid);
      }
    });
  }

}

// 键盘按键：T/t 切换赛道面板，Esc 关闭面板，1~4 或 Tab 切换跟随赛车
window.addEventListener("keydown", (e) => {
  if (e.key === "t" || e.key === "T") {
    e.preventDefault();
    if (isModalOpen) closeTrackModal();
    else openTrackModal();
    return;
  }
  if (e.key === "Escape" && isModalOpen) {
    e.preventDefault();
    closeTrackModal();
    return;
  }
  if (mode === "vs" || mode === "spectate") {
    if (e.key >= "1" && e.key <= String(cars.length)) {
      switchFocusCar(Number(e.key) - 1);
    } else if (e.key === "Tab") {
      e.preventDefault();
      switchFocusCar((focusIndex + 1) % cars.length);
    }
  }
});

function update(dt) {
  if (!started || isModalOpen) return;

  if (race.state === "countdown") {
    const r = tickCountdown(dt);
    if (r === "go") {
      showMsg("GO!", "", 900);
      audio.beep(1200, 0.35, 0.2);
      audio.startSound();
    } else if (msgText() !== r) {
      showMsg(r, "", 0);
      audio.beep(700, 0.12);
    }
    return;
  }

  // 更新所有赛车的物理与 AI 决策
  for (let i = 0; i < cars.length; i++) {
    const car = cars[i];
    const aiDriven = isAIDriven(i);
    if (aiDriven) driveAI(car, aiInputs[i], dt, cars);

    const ctrl = aiDriven ? aiInputs[i] : input;

    // 已完赛的车辆平滑降速到随机巡航速度（60~100km/h，不再停车）；AI 车沿用其转向与弯前刹车
    let effCtrl = ctrl;
    if (car.finished) effCtrl = finishedCarInput(car, aiDriven ? aiInputs[i] : null);
    else if (race.state !== "racing") effCtrl = NO_INPUT;

    stepCar(car, dt, effCtrl, fx);

    const ev = updateCarLap(car);
    if (i === focusIndex && ev === "lap") {
      showMsg("LAP " + car.lap + "/" + TOTAL_LAPS, car.shortName, 1100);
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

  // 检查是否全员完赛
  const allFinished = cars.every(c => c.finished);
  if (allFinished && !finishAt) {
    finishAt = performance.now();
  }
}

function draw() {
  const activeCar = cars[focusIndex] || cars[0];
  applyCamera(ctx, canvas, activeCar.shake);
  ctx.drawImage(trackCanvas, 0, 0, WORLD.w, WORLD.h);
  fx.drawEffects(ctx);

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
  for (let i = 0; i < cars.length; i++) {
    if (i !== focusIndex) drawCar(ctx, cars[i]);
  }
  if (cars[focusIndex]) {
    drawCar(ctx, cars[focusIndex]);
  }

  // 小地图
  drawMinimap(cars, focusIndex);
}

// ================= 开局流程：玩法模式 → 赛车 → 赛道 =================
function carSpecText(perf = {}) {
  const vmax = perf.maxSpeed ? Math.round(perf.maxSpeed[0] * 3.6) : "--";
  const grip = perf.latGrip ? (perf.latGrip / 9.81).toFixed(1) : "--";
  return `极速 ${vmax} km/h · 横向 ${grip}g`;
}

function renderCarCards() {
  const grid = document.getElementById("carCardsGrid");
  if (!grid) return;
  grid.innerHTML = AI_CONFIGS.map(cfg => `
    <div class="track-card car-card" data-car-id="${cfg.id}" style="border-color:${cfg.color}44">
      <div class="car-card-top">
        <span class="car-swatch" style="background:${cfg.color}"></span>
        <span class="track-card-len">#${cfg.number}</span>
      </div>
      <div class="track-card-title">${cfg.shortName}</div>
      <div class="track-card-en">${cfg.driverName}</div>
      <div class="track-card-tag">${carSpecText(cfg.perf)}</div>
    </div>
  `).join("");
}

// 第一步：选择玩法模式（单人 / 与 AI 对战）
function selectMode(m) {
  mode = m;
  const title = document.getElementById("startTitle");
  const desc = document.getElementById("startDesc");
  const modeCards = document.getElementById("modeCards");
  const carWrap = document.getElementById("carSelectWrap");
  if (modeCards) modeCards.classList.add("hidden");
  if (carWrap) carWrap.classList.remove("hidden");
  if (title) title.textContent = "选择你的赛车 (SELECT CAR)";
  if (desc) {
    desc.textContent = m === "solo"
      ? "单人计时：独自上赛道刷出最快圈速"
      : "你驾驶选中的赛车，其余车手全部由 AI 驾驶";
  }
  renderCarCards();
}

// 第二步：选择赛车（对战模式下其余车辆自动交给 AI）
function selectCar(carId) {
  playerCarId = carId;
  const modal = document.getElementById("startModal");
  if (modal) modal.classList.remove("open");
  startGame();
}

function startGame() {
  started = true;
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
  // 开局先选赛道；URL 显式指定过 ?track= 则直接开赛
  if (!new URLSearchParams(location.search).has("track")) openTrackModal();
}

function updateHelpText() {
  const help = document.getElementById("help");
  if (!help) return;
  if (mode === "spectate") {
    help.innerHTML = "AI 锦标赛 · 点击顶部或按 T 选赛道 · 1-7 换视角 · R 重开";
  } else if (mode === "vs") {
    help.innerHTML = "J 油门　K 轻刹　L 重刹/倒车 · ← → / A D 转向 · 1-7 换视角 · T 选赛道 · R 重开";
  } else {
    help.innerHTML = "J 油门　K 轻刹　L 重刹/倒车 · ← → / A D 转向 · T 选赛道 · R 重开";
  }
}

function initStartFlow() {
  const modal = document.getElementById("startModal");
  if (!modal) return;
  modal.addEventListener("click", (e) => {
    const modeCard = e.target.closest(".mode-card");
    if (modeCard) {
      selectMode(modeCard.getAttribute("data-mode"));
      return;
    }
    const carCard = e.target.closest(".car-card");
    if (carCard) selectCar(carCard.getAttribute("data-car-id"));
  });
}

// ================= 视图工具：AI 探测线开关 + 视野缩放系数 =================
function initViewTools() {
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
      if (!range) return;
      range.value = "1";
      applyZoom();
    });
  }
}

let prevTs = 0;
function frame(ts) {
  requestAnimationFrame(frame);
  if (!prevTs) prevTs = ts;
  let dt = (ts - prevTs) / 1000;
  prevTs = ts;
  if (dt > 0.05) dt = 0.05;

  if (!started) return;   // 开局选择阶段（模式 / 赛车弹窗）不渲染比赛

  update(dt);
  syncTuner(cars[focusIndex]);   // 切车时把调校面板同步到当前焦点赛车

  // 全 AI 观战模式：全员完赛后自动重开
  if (mode === "spectate" && finishAt && performance.now() - finishAt > AI_RESTART_DELAY) reset();

  const activeCar = cars[focusIndex] || cars[0];
  const activeCtrl = isAIDriven(focusIndex) ? aiInputs[focusIndex] : input;

  updateCamera(activeCar, dt);
  fx.updateEffects(dt);
  audio.updateAudio(activeCar, activeCtrl, dt, race.state === "racing");
  tickMsg(performance.now());
  draw();

  // 刷新 HUD（对战/观战模式刷新多车排位与实时 G 值遥测；单人模式刷新单人 HUD）
  if (mode !== "solo") {
    updateAIHUD(cars, focusIndex, switchFocusCar);
  } else {
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

updateHelpText();

if (SPECTATE) {
  // npm run ai：跳过开局选择，直接进入全 AI 观战
  startGame();
} else {
  // 常规启动：先选玩法模式，再选赛车，未选中的车辆全部交给 AI
  const startModal = document.getElementById("startModal");
  if (startModal) startModal.classList.add("open");
}

requestAnimationFrame(frame);

window.__gp = {
  get cars() { return cars; },
  race, input, aiInputs, pts,
  get mode() { return mode; },
  get ai() { return mode !== "solo"; },
  get started() { return started; },
  audio: audio.audioState
};
