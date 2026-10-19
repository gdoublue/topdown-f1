// 主入口：组装各模块并驱动主循环（支持多赛道切换与多赛车不同算法同场竞速）
import { TOTAL_LAPS } from "./config.js";
import { TRACKS, getTrack } from "./track/tracks.js";
import { WORLD, pts, N, switchTrack, currentTrack, currentTrackId } from "./track/geometry.js";
import { buildTrackCanvas } from "./track/render.js";
import { createCar, stepCar, resolveCarCollisions, finishedCarInput } from "./car/physics.js";
import { drawCar } from "./car/render.js";
import { resetCamera, updateCamera, applyCamera } from "./game/camera.js";
import { initInput, input, NO_INPUT } from "./game/input.js";
import * as fx from "./game/effects.js";
import { race, resetRace, tickCountdown, initCarRaceState, updateCarLap } from "./game/race.js";
import { initHud, fmt, showMsg, hideMsg, msgText, tickMsg, updateHUD, updateAIHUD, setOnSelectCar } from "./game/hud.js";
import { initMinimap, drawMinimap } from "./game/minimap.js";
import * as audio from "./game/audio.js";
import { AI_CONFIGS, applyCarConfig, buildGridSlots, createAIInput, driveAI, AI_RESTART_DELAY, rebuildAITrack } from "./game/ai.js";

// ?ai=1 → 电脑自动驾驶（npm run ai 会带这个参数打开）
const AI_MODE = new URLSearchParams(location.search).has("ai");

const canvas = document.getElementById("cv");
const ctx = canvas.getContext("2d");
let trackCanvas = buildTrackCanvas();

initHud(AI_MODE);
initMinimap();

// 赛车列表：AI 模式下初始化 4 辆不同涂装与算法的赛车；玩家模式下单车
let cars = [];
let aiInputs = [];
let focusIndex = 0;
let finishAt = 0;

// 洗牌算法：用于每局发车位随机排位
function shuffle(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function setupCars() {
  cars = [];
  aiInputs = [];
  if (AI_MODE) {
    // 发车位：读取 AI_CONFIGS 中各车 gridPos 指定的杆位，其余车辆随机填入剩余格位
    const carGrid = buildGridSlots(AI_CONFIGS, true);

    for (let i = 0; i < AI_CONFIGS.length; i++) {
      const car = applyCarConfig(createCar(carGrid[i]), AI_CONFIGS[i]);
      initCarRaceState(car);
      cars.push(car);
      aiInputs.push(createAIInput());
    }
  } else {
    const car = createCar(0);
    car.livery = "ferrari";
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
  setupCars();
  resetRace();
  switchFocusCar(0);
  fx.clearEffects();
  hideMsg(true);
  finishAt = 0;
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

  document.title = (AI_MODE ? "AI 锦标赛 · " : "俯视 F1 · ") + currentTrack.name;
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

  // 若启动时无显式 ?track= 指定赛道，则开局先弹出赛道选择框供玩家挑选
  const hasExplicitTrack = new URLSearchParams(window.location.search).has("track");
  if (!hasExplicitTrack) {
    openTrackModal();
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
  if (AI_MODE) {
    if (e.key >= "1" && e.key <= String(cars.length)) {
      switchFocusCar(Number(e.key) - 1);
    } else if (e.key === "Tab") {
      e.preventDefault();
      switchFocusCar((focusIndex + 1) % cars.length);
    }
  }
});

function update(dt) {
  if (isModalOpen) return;

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
    const ctrl = AI_MODE ? aiInputs[i] : (i === 0 ? input : NO_INPUT);

    if (AI_MODE) {
      driveAI(car, aiInputs[i], dt, cars);
    }

    // 已完赛的车辆减速停稳并驶离赛车线（避免被仍在比赛的后车冲撞）
    let effCtrl = ctrl;
    if (car.finished) effCtrl = finishedCarInput(car);
    else if (race.state !== "racing") effCtrl = NO_INPUT;

    stepCar(car, dt, effCtrl, fx);

    const ev = updateCarLap(car);
    if (i === focusIndex) {
      if (ev === "lap") {
        showMsg("LAP " + car.lap + "/" + TOTAL_LAPS, car.shortName, 1100);
        audio.lapSound();
      } else if (ev === "finish" && !finishAt) {
        showMsg("WINNER: " + car.shortName, "总时间 " + fmt(car.total) + " · 最快圈 " + fmt(car.best), 0);
        audio.finishSound();
      }
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

  // 绘制当前焦点赛车的前瞻目标点与引线
  if (AI_MODE && aiInputs[focusIndex]?.targetX) {
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

let prevTs = 0;
function frame(ts) {
  requestAnimationFrame(frame);
  if (!prevTs) prevTs = ts;
  let dt = (ts - prevTs) / 1000;
  prevTs = ts;
  if (dt > 0.05) dt = 0.05;

  update(dt);

  // AI 演示模式：全员完赛后自动重开
  if (AI_MODE && finishAt && performance.now() - finishAt > AI_RESTART_DELAY) reset();

  const activeCar = cars[focusIndex] || cars[0];
  const activeCtrl = AI_MODE ? aiInputs[focusIndex] : input;

  updateCamera(activeCar, dt);
  fx.updateEffects(dt);
  audio.updateAudio(activeCar, activeCtrl, dt, race.state === "racing");
  tickMsg(performance.now());
  draw();

  // 刷新 HUD（AI 模式刷新多车排位与实时 G 值遥测；玩家模式刷新单人 HUD）
  if (AI_MODE) {
    updateAIHUD(cars, focusIndex, switchFocusCar);
  } else {
    updateHUD(activeCar);
  }
}

resize();
reset();
initInput(reset);
audio.setupAudio();
initTrackSelector();

const help = document.getElementById("help");
if (AI_MODE) {
  if (help) help.innerHTML = "AI 锦标赛 · 点击顶部或按 T 选赛道 · 1-4 换视角 · R 重开";
} else {
  if (help) help.innerHTML = "J 油门　K 轻刹　L 倒车 · ← → / A D 转向 · T 选赛道 · R 重开";
}

requestAnimationFrame(frame);

window.__gp = { cars, race, input, aiInputs, ai: AI_MODE, pts, audio: audio.audioState };
