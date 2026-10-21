// 开局菜单的步骤与 DOM 层：模式选择 → 赛车选择 → 在线模式。
// 游戏状态（mode / started / cars）仍由 main.js 持有，这里只负责面板显隐、
// 卡片渲染与事件转发，避免 main.js 里继续堆 UI 细节。
import { AI_CONFIGS } from "../game/ai.js";

const $ = (id) => document.getElementById(id);

let cb = { onSelectMode: null, onSelectCar: null, onBack: null };
let stepName = "mode";   // mode | car | online

export function currentStep() { return stepName; }

export function initMenuPanels(callbacks = {}) {
  cb = { ...cb, ...callbacks };
  const modal = $("startModal");
  if (!modal || modal.dataset.bound) return;
  modal.dataset.bound = "1";

  // 事件委托：模式卡 / 赛车卡（内容会被反复重建，绑在容器上最稳）
  modal.addEventListener("click", (e) => {
    const modeCard = e.target.closest(".mode-card");
    if (modeCard) { cb.onSelectMode?.(modeCard.getAttribute("data-mode")); return; }
    const carCard = e.target.closest(".car-card");
    if (carCard) cb.onSelectCar?.(carCard.getAttribute("data-car-id"));
  });

  // 键盘可操作：卡片本身就是按钮，Enter / Space 等价点击
  modal.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const card = e.target.closest(".mode-card, .car-card");
    if (!card) return;
    e.preventDefault();
    if (card.classList.contains("mode-card")) cb.onSelectMode?.(card.getAttribute("data-mode"));
    else cb.onSelectCar?.(card.getAttribute("data-car-id"));
  });

  // ← 返回：由 main.js 决定是"回上一步"还是"退出在线流程"
  $("backToModeBtn")?.addEventListener("click", () => cb.onBack?.(stepName));
}

function setTitle(title, desc) {
  const t = $("startTitle"), d = $("startDesc");
  if (t && title != null) t.textContent = title;
  if (d && desc != null) d.textContent = desc;
}

function setBackBtn(visible, title) {
  const b = $("backToModeBtn");
  if (!b) return;
  b.classList.toggle("hidden", !visible);
  if (title) b.title = title;
}

function setBody(which) {
  $("modeCards")?.classList.toggle("hidden", which !== "mode");
  $("carSelectWrap")?.classList.toggle("hidden", which !== "car");
  $("onlineWrap")?.classList.toggle("hidden", which !== "online");
  // 驾驶键位与音频署名只属于单机开局流程，在线模式有独立信息区
  $("startModal")?.querySelector(".start-footer")?.classList.toggle("hidden", which === "online");
}

export function showModeStep() {
  stepName = "mode";
  setBody("mode");
  setBackBtn(false);
  setTitle("选择玩法模式 · SELECT MODE", "单人计时刷圈，还是与全场 AI 车手同场竞速？");
}

export function showCarStep(m) {
  stepName = "car";
  setBody("car");
  setBackBtn(true, "返回上一步：重新选择玩法模式");
  setTitle(
    "选择你的赛车 · SELECT CAR",
    m === "solo" ? "单人计时：独自上赛道刷出最快圈速" : "你驾驶选中的赛车，其余车手全部由 AI 驾驶"
  );
  renderCarCards();
}

export function showOnlineStep() {
  stepName = "online";
  setBody("online");
  setBackBtn(true, "退出在线模式并返回主菜单");
  setTitle("在线对战 · ONLINE", "连接服务器查看各赛道排行榜，或创建房间与好友同场竞速");
}

// 在线面板内部的三个子视图由 net/onlineUI.js 维护，这里保持向后兼容
export function openStartModal() {
  $("startModal")?.classList.add("open");
}

export function closeStartModal() {
  $("startModal")?.classList.remove("open");
}

function carSpecText(perf = {}) {
  const vmax = perf.maxSpeed ? Math.round(perf.maxSpeed[0] * 3.6) : "--";
  const grip = perf.latGrip ? (perf.latGrip / 9.81).toFixed(1) : "--";
  return { vmax, grip };
}

export function renderCarCards() {
  const grid = $("carCardsGrid");
  if (!grid) return;
  grid.innerHTML = AI_CONFIGS.map((cfg, i) => {
    const { vmax, grip } = carSpecText(cfg.perf);
    // 仪表条用固定上限（500km/h、5g）而非“全场最快”：参数不会因为对手换车而变
    const speedPct = Math.max(6, Math.min(100, Math.round(Number(vmax) / 500 * 100)));
    const gripPct = Math.max(6, Math.min(100, Math.round(Number(grip) / 5 * 100)));
    return `
      <div class="track-card car-card" data-car-id="${cfg.id}" role="button" tabindex="0"
           style="--team-color:${cfg.color}"
           aria-label="选择 ${cfg.team} ${cfg.model}，车手 ${cfg.driverShort}">
        <div class="car-card-top">
          <span class="car-swatch" style="background:${cfg.color}"></span>
          <span class="car-team">${cfg.team}</span>
          <span class="car-index">${String(i + 1).padStart(2, "0")}</span>
        </div>
        <div class="car-model">${cfg.model}</div>
        <div class="car-driver">
          <span>${cfg.driverShort || cfg.driverName}</span>
          <small>${cfg.driverCode || ""} · #${cfg.number}</small>
        </div>
        <div class="car-specs">
          <div class="car-spec">
            <span>极速</span><b>${vmax} km/h</b>
            <i><em style="width:${speedPct}%"></em></i>
          </div>
          <div class="car-spec">
            <span>抓地</span><b>${grip} g</b>
            <i><em style="width:${gripPct}%"></em></i>
          </div>
        </div>
        <div class="car-cta">驾驶此车 <span>→</span></div>
      </div>
    `;
  }).join("");
}
