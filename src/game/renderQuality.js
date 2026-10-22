// 渲染质量与动态分辨率：只改画布后备像素，不改 CSS 尺寸。
// 镜头视野由 canvas.height 推导，所以降分辨率不会改变世界视野/操作。
// 自动模式按真实帧间隔调整渲染比例，弱机额外关闭 backdrop-filter 等每帧合成开销。

const STORE_KEY = "f1-render-quality";

const PRESETS = {
  auto:   { label: "自动", dprMax: 1.5,  maxPixels: 3_400_000, fixedScale: 1,    trackSS: 4, lite: false },
  high:   { label: "高",   dprMax: 1.5,  maxPixels: Infinity,  fixedScale: 1,    trackSS: 4, lite: false },
  medium: { label: "中",   dprMax: 1.25, maxPixels: 3_000_000, fixedScale: 0.85, trackSS: 3, lite: false },
  low:    { label: "低",   dprMax: 1.0,  maxPixels: 1_500_000, fixedScale: 0.65, trackSS: 2, lite: true },
};

const AUTO_MIN_SCALE = 0.4;      // 自动模式最低到像素上限的 40%
const SLOW_EMA_MS = 19.5;        // 约 51fps：持续低于此值就降分辨率
const SLOW_HOLD_MS = 700;
const FAST_EMA_MS = 15;          // 约 66fps：高刷屏才可能持续满足，用于回升
const FAST_HOLD_MS = 4000;
const COOLDOWN_MS = 900;

function loadMode() {
  try {
    const v = localStorage.getItem(STORE_KEY);
    if (PRESETS[v]) return v;
  } catch { /* 隐私模式/本地文件：用默认 */ }
  return "auto";
}

let mode = loadMode();
let autoScale = 1;               // 自动模式：相对像素上限的比例（0.4 ~ 1）
let autoLite = false;            // 自动模式降到很低仍慢 → 关闭高开销合成
let emaMs = 16.7;
let slowForMs = 0;
let fastForMs = 0;
let cooldownUntil = 0;
let lastCssArea = 0;
let last = { w: 0, h: 0, scale: 1, dpr: 1, px: 0 };
const listeners = [];

function liteActive() {
  return mode === "auto" ? autoLite : PRESETS[mode].lite;
}

function applyBodyClass() {
  if (document.body) document.body.classList.toggle("perf-lite", liteActive());
}

// 低画质档位在页面加载时就要生效（脚本在 body 末尾，正常已可访问）
if (document.body) applyBodyClass();
else document.addEventListener("DOMContentLoaded", applyBodyClass, { once: true });

function emit() {
  applyBodyClass();
  for (const fn of listeners) {
    try { fn(); } catch (e) { console.error("[quality] listener error:", e); }
  }
}

export function onQualityChange(fn) { listeners.push(fn); }
export function getQualityMode() { return mode; }
// 自动模式降到低特效时，赛道贴图也一起降到 SS=2：
// 视觉上已经用低分辨率在放大，继续沿用 SS=3/4 只会白占显存和采样带宽。
export function getTrackSS() {
  if (mode === "auto") return autoLite ? 2 : 4;
  return PRESETS[mode].trackSS;
}

export function setQualityMode(next) {
  if (!PRESETS[next] || next === mode) return;
  mode = next;
  autoScale = 1;
  autoLite = next === "auto" ? false : PRESETS[next].lite;
  emaMs = 16.7;
  slowForMs = fastForMs = 0;
  cooldownUntil = performance.now() + 500;
  try { localStorage.setItem(STORE_KEY, mode); } catch { /* ignore */ }
  emit();
}

// 视口面积明显变化（换显示器/全屏切换）时重新从高画质开始测，避免把旧窗口的
// 低分辨率比例带到更大的画布上，也避免小窗口把画质永久压在低档。
export function noteViewport(cssW, cssH) {
  const area = Math.max(1, cssW) * Math.max(1, cssH);
  if (lastCssArea > 0 && (area > lastCssArea * 1.25 || area < lastCssArea * 0.8)) {
    autoScale = 1;
    if (mode === "auto") autoLite = false;
    emaMs = 16.7;
    slowForMs = fastForMs = 0;
    applyBodyClass();
  }
  lastCssArea = area;
  applyBodyClass();
  // resize 后重新分配画布本身会掉一帧，别把它当成“性能不足”
  cooldownUntil = performance.now() + 500;
}

export function computeBackingSize(cssW, cssH, deviceDpr) {
  const p = PRESETS[mode];
  const dpr = Math.min(Math.max(1, deviceDpr || 1), p.dprMax);
  const basePx = Math.max(1, cssW * dpr) * Math.max(1, cssH * dpr);
  // 像素上限决定“满档”能到多少；自动比例再在它之下升降
  const capScale = p.maxPixels ? Math.min(1, Math.sqrt(p.maxPixels / basePx)) : 1;
  let scale = mode === "auto" ? capScale * autoScale : Math.min(p.fixedScale, capScale);
  scale = Math.max(0.25, Math.min(1, scale));
  const w = Math.max(1, Math.round(cssW * dpr * scale));
  const h = Math.max(1, Math.round(cssH * dpr * scale));
  last = { w, h, scale, dpr, px: w * h };
  return { w, h, scale, dpr };
}

// 返回 true 表示画布尺寸需要重建（调用方负责 resize）
export function sampleFrameQuality(dtMs, now) {
  if (!(dtMs > 0) || dtMs > 1200) return false;   // 切后台/长卡顿不参与判定
  const sample = Math.min(dtMs, 60);
  emaMs += (sample - emaMs) * (dtMs > 35 ? 0.2 : 0.06);
  if (mode !== "auto" || now < cooldownUntil) return false;

  const slow = dtMs > 28 || emaMs > SLOW_EMA_MS;
  const fast = dtMs < 16 && emaMs < FAST_EMA_MS;
  if (slow) {
    slowForMs += dtMs;
    fastForMs = 0;
  } else if (fast) {
    fastForMs += dtMs;
    slowForMs = Math.max(0, slowForMs - dtMs * 0.5);
  } else {
    slowForMs = Math.max(0, slowForMs - dtMs * 0.5);
    fastForMs = 0;
  }

  if (slowForMs >= SLOW_HOLD_MS) {
    const step = dtMs > 45 ? 0.6 : 0.82;
    const next = Math.max(AUTO_MIN_SCALE, autoScale * step);
    let changed = false;
    if (next < autoScale - 0.005) {
      autoScale = next;
      changed = true;
      cooldownUntil = now + COOLDOWN_MS;
      slowForMs = 0;
    } else {
      slowForMs = SLOW_HOLD_MS;
    }
    // 已经压到很低还慢：说明瓶颈不只是填充率，关掉背景模糊/扫描线
    if (!autoLite && (autoScale <= 0.6 || (dtMs > 45 && autoScale <= 0.85))) {
      autoLite = true;
      emit();
    }
    return changed;
  }

  if (fastForMs >= FAST_HOLD_MS) {
    const next = Math.min(1, autoScale + 0.08);
    const changed = next > autoScale + 0.005;
    if (changed) {
      autoScale = next;
      cooldownUntil = now + COOLDOWN_MS * 2;
    }
    fastForMs = 0;
    return changed;
  }
  return false;
}

export function getQualityStats() {
  return {
    mode,
    label: PRESETS[mode].label,
    lite: liteActive(),
    width: last.w,
    height: last.h,
    px: last.px,
    scale: +last.scale.toFixed(2),
    dpr: +last.dpr.toFixed(2),
    autoScale: +autoScale.toFixed(2),
    trackSS: getTrackSS(),
    emaMs: +emaMs.toFixed(1),
  };
}

export function getQualityInfo() {
  const s = getQualityStats();
  if (!s.width) return `${s.label} · 测量中`;
  return `${s.label} · ${s.width}×${s.height} · ${Math.round(s.scale * 100)}%${s.lite ? " · 低特效" : ""}`;
}
