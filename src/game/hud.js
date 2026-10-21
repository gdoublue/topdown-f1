function escapeHtml(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
import { M, effectiveLaps } from "../config.js";
import { N, currentTrack } from "../track/geometry.js";
import { race, simClock } from "./race.js";
import { driverLabel, driverCode, carModelLabel, carNumberLabel } from "../ui/labels.js";

const el = {};
let msgTimer = 0;
let isAI = false;
let onSelectCarCallback = null;

export function initHud(aiMode = false, onSelectCar = null) {
  isAI = aiMode;
  onSelectCarCallback = onSelectCar;
  const ids = [
    "lap", "time", "best", "last", "speed", "msg", "msgMain", "msgSub",
    "standingsList", "standingsHint", "carColorDot", "carBadgeName", "carBadgeModel",
    "speedVal", "gVal", "gLatVal", "gLonVal", "statusPos", "statusLap", "statusTime",
    "statusBest", "statusLast", "soloDriver", "soloCar"
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

// 属性 / 行内样式 / display 的脏检查版本：
// 逐帧无条件 setAttribute / style.setProperty 会让浏览器每帧做一次样式重算，
// 在 144Hz（单帧预算 6.9ms）下这部分开销非常可观。
function setAttr(node, name, v) {
  if (!node) return;
  node._a || (node._a = Object.create(null));
  if (node._a[name] !== v) { node._a[name] = v; node.setAttribute(name, v); }
}

function setStyle(node, prop, v) {
  if (!node) return;
  node._s || (node._s = Object.create(null));
  if (node._s[prop] !== v) { node._s[prop] = v; node.style.setProperty(prop, v); }
}

function setDisplay(node, v) {
  if (!node || node._disp === v) return;
  node._disp = v;
  node.style.display = v;
}

// 计时塔每行的子节点一次性缓存：原来每帧每行 9 次 querySelector（8 行 = 72 次/帧），
// 144Hz 下就是 10000+ 次 DOM 查询/秒，纯浪费。
function rowRefs(row) {
  if (row._r) return row._r;
  return (row._r = {
    rank: row.querySelector(".standing-rank"),
    bar: row.querySelector(".standing-color-bar"),
    name: row.querySelector(".standing-name"),
    code: row.querySelector(".standing-code"),
    you: row.querySelector(".standing-you-tag"),
    cam: row.querySelector(".standing-cam-tag"),
    gap: row.querySelector(".standing-gap"),
    car: row.querySelector(".standing-car"),
    best: row.querySelector(".standing-best"),
  });
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
  setText(el.soloDriver, driverLabel(car));
  setText(el.soloCar, carModelLabel(car));
}

// F1 计时塔的差距列：同圈用实时距离估算，完赛车用总用时差，落后整圈直接标 LAP。
function fmtGapSeconds(sec) {
  if (!isFinite(sec) || sec < 0) return "—";
  if (sec >= 60) {
    return `+${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;
  }
  return `+${sec.toFixed(1)}s`;
}

function gapText(ahead, car, rank) {
  if (car.retired) return "OUT";
  if (rank === 0) return car.finished ? "WINNER" : "LEADER";
  if (car.finished && ahead.finished) {
    return `+${fmt(Math.max(0, (car.total || 0) - (ahead.total || 0)))}`;
  }
  if (car.finished || ahead.finished) return "—";
  const dist = (ahead.raceDist ?? 0) - (car.raceDist ?? 0);
  if (!isFinite(dist) || dist <= 0.5) return "—";
  const lapLen = currentTrack?.length || 5000;
  if (dist >= lapLen) return `+${Math.floor(dist / lapLen)} LAP`;
  const speed = Math.max(12, (Math.abs(ahead.speed || 0) + Math.abs(car.speed || 0)) / 2);
  return fmtGapSeconds(dist / speed);
}

// 稳定 DOM：只在数量不匹配或结构过期时初始化，避免每帧 innerHTML 导致点击事件断触
function ensureStandingRows(count) {
  if (!el.standingsList) return [];
  let rows = Array.from(el.standingsList.children);
  const needsRebuild = rows.length !== count || rows.some(r => !r.querySelector(".standing-main"));
  if (needsRebuild) {
    el.standingsList.innerHTML = "";
    rows = [];
    for (let i = 0; i < count; i++) {
      const row = document.createElement("div");
      row.className = "standing-row";
      row.innerHTML = `
        <span class="standing-rank">P1</span>
        <span class="standing-color-bar"></span>
        <div class="standing-main">
          <div class="standing-top">
            <span class="standing-name">DRIVER</span>
            <span class="standing-code"></span>
            <span class="standing-you-tag">YOU</span>
            <span class="standing-cam-tag">● CAM</span>
            <span class="standing-gap">—</span>
          </div>
          <div class="standing-bottom">
            <span class="standing-car">CAR</span>
            <span class="standing-best">--:--.--</span>
          </div>
        </div>
      `;
      el.standingsList.appendChild(row);
      rows.push(row);
    }
  }
  return rows;
}

// AI 模式多车计时塔与选中赛车遥测更新
export function updateAIHUD(cars, focusIndex, onSelectCar) {
  if (!isAI || !cars || cars.length === 0) return;
  if (onSelectCar) onSelectCarCallback = onSelectCar;

  const activeCar = cars[focusIndex] || cars[0];

  // 按赛道连续里程排序（完赛按总用时，未完赛按里程）
  const getScore = (c) => {
    if (c.finished) return 10000000 - (c.total || 0);
    return c.raceDist != null ? c.raceDist : -9999;
  };
  const sorted = [...cars].map((car, originalIdx) => ({ car, originalIdx })).sort((a, b) => {
    const diff = getScore(b.car) - getScore(a.car);
    if (Math.abs(diff) > 0.001) return diff;
    return a.originalIdx - b.originalIdx;
  });
  const focusRank = sorted.findIndex(x => x.originalIdx === focusIndex);

  // 1. 更新当前赛车遥测状态与 G 值
  setText(el.carBadgeName, driverLabel(activeCar));
  setText(el.carBadgeModel, carModelLabel(activeCar));
  if (el.carColorDot) el.carColorDot.style.backgroundColor = activeCar.color || "#ff3b3b";
  setText(el.statusPos, focusRank >= 0 ? `P${focusRank + 1}` : "P—");
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
  setText(el.statusLast, fmt(activeCar.last));

  // 2. 更新右上角 F1 计时塔
  if (!el.standingsList) return;

  const leader = sorted[0]?.car;
  if (leader && el.standingsHint) {
    const lapNo = Math.min(leader.lap || 1, maxLaps);
    setText(el.standingsHint, `LAP ${lapNo}/${maxLaps}`);
  }

  // 找出全场最快圈速（紫色高亮显示）
  let overallBest = Infinity;
  for (const c of cars) {
    if (c.best && c.best < overallBest) overallBest = c.best;
  }

  const rows = ensureStandingRows(sorted.length);
  for (let rank = 0; rank < sorted.length; rank++) {
    const item = sorted[rank];
    const c = item.car;
    const isFocus = item.originalIdx === focusIndex;
    const row = rows[rank];
    const r = rowRefs(row);

    setAttr(row, "data-idx", String(item.originalIdx));
    row.classList.toggle("active", isFocus);
    row.classList.toggle("is-player", !!c.isPlayer);
    row.classList.toggle("out", !!c.retired);
    row.classList.toggle("pos-1", rank === 0);
    row.classList.toggle("pos-2", rank === 1);
    row.classList.toggle("pos-3", rank === 2);
    setStyle(row, "--team-color", c.color || "#e10600");

    setText(r.rank, `P${rank + 1}`);
    setStyle(r.bar, "background-color", c.color || "#ff4a5e");

    const name = driverLabel(c);
    const model = carModelLabel(c);
    setText(r.name, name);
    setAttr(r.name, "title", `${name} · ${model}`);
    setText(r.code, c.retired ? "OUT" : (driverCode(c) || carNumberLabel(c)));
    setDisplay(r.you, c.isPlayer ? "inline-block" : "none");
    setDisplay(r.cam, isFocus ? "inline-block" : "none");
    setText(r.car, model);

    setText(r.gap, gapText(sorted[rank - 1]?.car, c, rank));
    r.gap?.classList.toggle("leader", rank === 0);

    if (c.best) {
      setText(r.best, fmt(c.best));
      r.best?.classList.toggle("purple", c.best === overallBest);
    } else {
      setText(r.best, "--:--.--");
      r.best?.classList.remove("purple");
    }
  }
}
