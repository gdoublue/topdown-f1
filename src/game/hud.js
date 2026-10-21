function escapeHtml(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
import { M, effectiveLaps } from "../config.js";
import { N, currentTrack } from "../track/geometry.js";
import { race, simClock } from "./race.js";

const el = {};
let msgTimer = 0;
let isAI = false;
let onSelectCarCallback = null;

export function initHud(aiMode = false, onSelectCar = null) {
  isAI = aiMode;
  onSelectCarCallback = onSelectCar;
  const ids = [
    "lap", "time", "best", "last", "speed", "msg", "msgMain", "msgSub",
    "standingsList", "carColorDot", "carBadgeName", "speedVal", "gVal",
    "gLatVal", "gLonVal", "statusLap", "statusTime", "statusBest"
  ];
  for (const id of ids) {
    el[id] = document.getElementById(id);
  }

  // 必须"跟着模式走"而不是只加不删：否则打过一局在线/对战之后，
  // 回到单人时 #stats / #speedo 仍被 ai-mode 隐藏，排位榜和遥测条却一直挂着
  // （显示的还是上一局的旧数据）
  document.body.classList.toggle("ai-mode", !!isAI);

  if (isAI) {
    // 在排行榜容器上使用全局事件委托，保证点击 100% 灵敏响应，不受 DOM 刷新影响
    if (el.standingsList) {
      const handleRowClick = (e) => {
        const row = e.target.closest(".standing-row");
        if (row && onSelectCarCallback) {
          const idx = Number(row.getAttribute("data-idx"));
          if (!isNaN(idx)) {
            onSelectCarCallback(idx);
          }
        }
      };
      el.standingsList.addEventListener("click", handleRowClick);
      el.standingsList.addEventListener("pointerdown", handleRowClick);
    }
  }
}

export function setOnSelectCar(fn) {
  onSelectCarCallback = fn;
}

function setText(node, v) {
  if (node && node._v !== v) { node._v = v; node.textContent = v; }
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
  if (!el.msgMain) return;
  el.msgMain.textContent = main;
  el.msgSub.textContent = sub || "";
  el.msg.classList.add("show");
  msgTimer = dur ? performance.now() + dur : 0;
}

export function hideMsg(force) {
  if (!el.msg) return;
  el.msg.classList.remove("show");
  if (force) { el.msgMain.textContent = ""; el.msgSub.textContent = ""; }
  msgTimer = 0;
}

export function msgText() {
  return el.msgMain ? el.msgMain.textContent : "";
}

// msgTimer 到期自动隐藏
export function tickMsg(now) {
  if (msgTimer && now > msgTimer && race.state !== "finished") hideMsg(false);
}

// 单人模式 HUD
export function updateHUD(car) {
  if (!car) return;
  setText(el.speed, String(Math.round(Math.abs(car.speed) / M * 3.6)));
  const maxLaps = effectiveLaps(currentTrack?.laps);
  setText(el.lap, Math.min(car.lap || race.lap, maxLaps) + "/" + maxLaps);
  let t = 0;
  // 与圈速同源：用模拟时钟，倍速下也显示真实比赛用时
  if (race.state === "racing") t = Math.max(0, simClock - (car.raceStart || race.raceStart || 0));
  else if (race.state === "finished") t = car.total || race.total;
  setText(el.time, fmt(t));
  setText(el.best, fmt(car.best || race.best));
  setText(el.last, fmt(car.last || race.last));
}

// 稳定 DOM：只在数量不匹配或结构过期时初始化，避免每帧 innerHTML 导致点击事件断触
function ensureStandingRows(count) {
  if (!el.standingsList) return [];
  let rows = Array.from(el.standingsList.children);
  const needsRebuild = rows.length !== count || rows.some(r => !r.querySelector(".standing-speed"));
  if (needsRebuild) {
    el.standingsList.innerHTML = "";
    rows = [];
    for (let i = 0; i < count; i++) {
      const row = document.createElement("div");
      row.className = "standing-row";
      row.innerHTML = `
        <div class="standing-left">
          <span class="standing-rank">P1</span>
          <span class="standing-color-bar"></span>
          <span class="standing-name">CAR</span>
          <span class="standing-cam-tag" style="display:none">CAM</span>
        </div>
        <div class="standing-right">
          <span class="standing-best">--:--.--</span>
          <span class="standing-speed">0 KM/H</span>
        </div>
      `;
      el.standingsList.appendChild(row);
      rows.push(row);
    }
  }
  return rows;
}

// AI 模式多车排行榜与选中赛车遥测更新
export function updateAIHUD(cars, focusIndex, onSelectCar) {
  if (!isAI || !cars || cars.length === 0) return;
  if (onSelectCar) onSelectCarCallback = onSelectCar;

  const activeCar = cars[focusIndex] || cars[0];

  // 1. 更新当前赛车遥测状态与 G 值
  setText(el.carBadgeName, activeCar.name || "CAR");
  if (el.carColorDot) el.carColorDot.style.backgroundColor = activeCar.color || "#ff3b3b";
  setText(el.speedVal, String(Math.round(Math.abs(activeCar.speed) * 3.6)));

  const gTotal = activeCar.gTotal || 0;
  setText(el.gVal, gTotal.toFixed(1));
  if (el.gVal) {
    el.gVal.className = gTotal > 3.2 ? "g-high" : (gTotal > 1.8 ? "g-mid" : "");
  }
  setText(el.gLatVal, `${(activeCar.gLat || 0).toFixed(1)}G`);
  const gLonVal = activeCar.gLon || 0;
  setText(el.gLonVal, `${gLonVal >= 0 ? "+" : ""}${gLonVal.toFixed(1)}G`);

  const maxLaps = effectiveLaps(currentTrack?.laps);
  setText(el.statusLap, `${Math.min(activeCar.lap || 1, maxLaps)}/${maxLaps}`);
  let t = 0;
  if (race.state === "racing") t = Math.max(0, simClock - (activeCar.raceStart || race.raceStart || 0));
  else if (activeCar.finished) t = activeCar.total;
  setText(el.statusTime, fmt(t));
  setText(el.statusBest, fmt(activeCar.best));

  // 2. 更新右上角排位排行榜
  if (!el.standingsList) return;

  // 找出全场最快圈速（紫色高亮显示）
  let overallBest = Infinity;
  for (const c of cars) {
    if (c.best && c.best < overallBest) overallBest = c.best;
  }

  // 根据赛道连续物理米数里程实时排序 (完赛赛车按总成绩用时排在最前；起跑格按负里程严格区分 P1~P4)
  const getScore = (c) => {
    if (c.finished) return 10000000 - (c.total || 0);
    return c.raceDist != null ? c.raceDist : -9999;
  };
  const sorted = [...cars].map((car, originalIdx) => ({ car, originalIdx })).sort((a, b) => {
    const diff = getScore(b.car) - getScore(a.car);
    if (Math.abs(diff) > 0.001) return diff;
    return a.originalIdx - b.originalIdx;
  });

  const rows = ensureStandingRows(sorted.length);
  for (let rank = 0; rank < sorted.length; rank++) {
    const item = sorted[rank];
    const c = item.car;
    const isFocus = item.originalIdx === focusIndex;
    const row = rows[rank];

    row.setAttribute("data-idx", String(item.originalIdx));
    if (isFocus) {
      if (!row.classList.contains("active")) row.classList.add("active");
    } else {
      if (row.classList.contains("active")) row.classList.remove("active");
    }

    const rankEl = row.querySelector(".standing-rank");
    if (rankEl) {
      rankEl.textContent = `P${rank + 1}`;
      if (rank === 0) rankEl.classList.add("gold");
      else rankEl.classList.remove("gold");
    }

    const barEl = row.querySelector(".standing-color-bar");
    if (barEl) barEl.style.backgroundColor = c.color || "#ff4a5e";

    const isPlayer = !!c.isPlayer;
    if (isPlayer) {
      if (!row.classList.contains("is-player")) row.classList.add("is-player");
    } else {
      if (row.classList.contains("is-player")) row.classList.remove("is-player");
    }

    const nameEl = row.querySelector(".standing-name");
    if (nameEl) {
      const displayName = c.nickname || c.driverName || c.name || c.shortName;
      const numPrefix = c.number ? `#${c.number} ` : "";
      nameEl.innerHTML = `${numPrefix}${escapeHtml(displayName)}${isPlayer ? ' <span class="standing-you-tag">YOU</span>' : ""}`;
      nameEl.title = `${displayName} (${c.shortName || ""})`;
    }

    const camEl = row.querySelector(".standing-cam-tag");
    if (camEl) camEl.style.display = isFocus ? "inline-block" : "none";

    const bestEl = row.querySelector(".standing-best");
    if (bestEl) {
      if (c.best) {
        bestEl.textContent = fmt(c.best);
        if (c.best === overallBest) {
          bestEl.classList.add("purple");
        } else {
          bestEl.classList.remove("purple");
        }
      } else {
        bestEl.textContent = "--:--.--";
        bestEl.classList.remove("purple");
      }
    }

    const speedEl = row.querySelector(".standing-speed");
    if (speedEl) {
      speedEl.textContent = `${Math.round(Math.abs(c.speed) * 3.6)} KM/H`;
    }
  }
}
