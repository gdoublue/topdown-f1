// 主入口：组装各模块并驱动主循环
import { TOTAL_LAPS } from "./config.js";
import { WORLD, pts } from "./track/geometry.js";
import { buildTrackCanvas } from "./track/render.js";
import { createCar, stepCar } from "./car/physics.js";
import { drawCar } from "./car/render.js";
import { resetCamera, updateCamera, applyCamera } from "./game/camera.js";
import { initInput, input, NO_INPUT } from "./game/input.js";
import * as fx from "./game/effects.js";
import { race, resetRace, tickCountdown, updateLap } from "./game/race.js";
import { initHud, fmt, showMsg, hideMsg, msgText, tickMsg, updateHUD } from "./game/hud.js";
import { initMinimap, drawMinimap } from "./game/minimap.js";
import * as audio from "./game/audio.js";

const canvas = document.getElementById("cv");
const ctx = canvas.getContext("2d");
const trackCanvas = buildTrackCanvas();

// 画布纵横比跟随世界尺寸
document.getElementById("game").style.aspectRatio = WORLD.w + " / " + WORLD.h;

initHud();
initMinimap();

const car = createCar();

function reset() {
  Object.assign(car, createCar());
  resetRace();
  resetCamera(car);
  fx.clearEffects();
  hideMsg(true);
}

function resize() {
  const r = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.max(1, Math.round(r.width * dpr));
  canvas.height = Math.max(1, Math.round(r.height * dpr));
}
window.addEventListener("resize", resize);

function update(dt) {
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

  // 非比赛状态（完赛滑行）不接收输入
  stepCar(car, dt, race.state === "racing" ? input : NO_INPUT, fx);

  const ev = updateLap(car);
  if (ev === "lap") {
    showMsg("LAP " + race.lap + "/" + TOTAL_LAPS, "", 1100);
    audio.lapSound();
  } else if (ev === "finish") {
    showMsg("FINISH",
      "总时间 " + fmt(race.total) + "　·　最快圈 " + fmt(race.best) + "　·　按 R 重新开始", 0);
    audio.finishSound();
  }
  if (race.state === "finished" && Math.abs(car.speed) < 2) car.speed = 0;
}

function draw() {
  applyCamera(ctx, canvas, car.shake);
  ctx.drawImage(trackCanvas, 0, 0, WORLD.w, WORLD.h);
  fx.drawEffects(ctx);
  drawCar(ctx, car);
  drawMinimap(car);
}

let prevTs = 0;
function frame(ts) {
  requestAnimationFrame(frame);
  if (!prevTs) prevTs = ts;
  let dt = (ts - prevTs) / 1000;
  prevTs = ts;
  if (dt > 0.05) dt = 0.05;

  update(dt);
  updateCamera(car, dt);
  fx.updateEffects(dt);
  audio.updateAudio(car, input, dt, race.state === "racing");
  tickMsg(performance.now());
  draw();
  updateHUD(car);
}

resize();
reset();
initInput(reset);
audio.setupAudio();
requestAnimationFrame(frame);

// 调试钩子：供自动化测试读取内部状态
window.__gp = { car, race, input, pts, audio: audio.audioState };
