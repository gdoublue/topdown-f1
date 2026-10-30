// 比赛开始前赛车模型加载进度 UI 模块
// 负责在单人/对战 AI 以及在线对战中管理模型加载遮罩与进度条

let overlayEl = null;
let titleEl = null;
let subEl = null;
let singleWrapEl = null;
let singleBarEl = null;
let singleTextEl = null;
let singleDescEl = null;
let multiWrapEl = null;
let multiListEl = null;

function ensureElements() {
  if (!overlayEl) overlayEl = document.getElementById("raceLoadingOverlay");
  if (!titleEl) titleEl = document.getElementById("raceLoadingTitle");
  if (!subEl) subEl = document.getElementById("raceLoadingSub");
  if (!singleWrapEl) singleWrapEl = document.getElementById("singleLoadingWrap");
  if (!singleBarEl) singleBarEl = document.getElementById("singleProgressBar");
  if (!singleTextEl) singleTextEl = document.getElementById("singleProgressText");
  if (!singleDescEl) singleDescEl = document.getElementById("singleProgressDesc");
  if (!multiWrapEl) multiWrapEl = document.getElementById("multiLoadingWrap");
  if (!multiListEl) multiListEl = document.getElementById("multiLoadingList");
}

/**
 * 显示单人 / 对战 AI 加载进度条
 */
export function showSingleLoading(title = "正在加载比赛赛车模型…", sub = "首次加载真实 3D 车模需下载资源，请稍候") {
  ensureElements();
  if (!overlayEl) return;
  overlayEl.classList.remove("hidden");
  if (titleEl) titleEl.textContent = title;
  if (subEl) subEl.textContent = sub;
  if (singleWrapEl) singleWrapEl.classList.remove("hidden");
  if (multiWrapEl) multiWrapEl.classList.add("hidden");
  updateSingleProgress(0, "正在连接资源…");
}

/**
 * 更新单人模式进度 (0 ~ 1)
 */
export function updateSingleProgress(ratio, desc = "") {
  ensureElements();
  const pct = Math.max(0, Math.min(100, Math.round(ratio * 100)));
  if (singleBarEl) singleBarEl.style.width = pct + "%";
  if (singleTextEl) singleTextEl.textContent = pct + "%";
  if (singleDescEl && desc) singleDescEl.textContent = desc;
}

/**
 * 显示联机模式全员加载进度列表
 */
export function showMultiLoading(title = "正在加载赛车模型与同步车手…", sub = "等待所有车手加载完毕后发车") {
  ensureElements();
  if (!overlayEl) return;
  overlayEl.classList.remove("hidden");
  if (titleEl) titleEl.textContent = title;
  if (subEl) subEl.textContent = sub;
  if (singleWrapEl) singleWrapEl.classList.add("hidden");
  if (multiWrapEl) multiWrapEl.classList.remove("hidden");
}

/**
 * 更新联机全员进度列表
 * @param {Array<{ id, nickname, carId, progress }>} players
 * @param {string} mySessionId
 */
export function updateMultiProgress(players, mySessionId) {
  ensureElements();
  if (!multiListEl) return;
  if (!Array.isArray(players) || !players.length) return;

  multiListEl.innerHTML = players.map(p => {
    const isMe = p.id === mySessionId;
    const pct = Math.max(0, Math.min(100, Math.round(Number(p.progress) || 0)));
    const isReady = pct >= 100;
    return `
      <div class="multi-loading-item">
        <div class="multi-item-row">
          <span class="multi-item-name">
            ${escapeHtml(p.nickname || "车手")}
            ${isMe ? '<span class="me-badge">你</span>' : ""}
          </span>
          <span class="multi-item-pct ${isReady ? "" : "loading"}">
            ${isReady ? "✓ 已就绪" : pct + "%"}
          </span>
        </div>
        <div class="race-progress-track">
          <div class="race-progress-fill" style="width: ${pct}%"></div>
        </div>
      </div>
    `;
  }).join("");
}

/**
 * 隐藏加载进度遮罩
 */
export function hideRaceLoading() {
  ensureElements();
  if (overlayEl) overlayEl.classList.add("hidden");
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
