// 赛车渲染：以"米"为单位绘制（车宽 2m、车长 5.6m），再按 M 缩放到世界
import { M } from "../config.js";
import { TAU, rrect } from "../utils.js";

// 赛车涂装配色表：键为车型代号（与 AI_CONFIGS 的 livery 字段对应）
// 随机赛车涂装配色板（同车竞技/同车型防撞色，包含全部颜色点位）
export const RANDOM_LIVERY_PALETTES = [
  {
    name: "烈焰红金",
    grad: ["#ff4d4d", "#d90429", "#8b0000"],
    side: "#b91c1c",
    wing: "#ffd166",
    stripe: "rgba(255,255,255,.9)",
    helmet: "#ffd166",
    numColor: "#ffffff",
    color: "#ef233c",
  },
  {
    name: "海湾蓝橙",
    grad: ["#7dd3fc", "#0284c7", "#075985"],
    side: "#ea580c",
    wing: "#f97316",
    stripe: "rgba(249,115,22,.95)",
    helmet: "#fb923c",
    numColor: "#ffffff",
    color: "#0284c7",
  },
  {
    name: "曜石黑金",
    grad: ["#334155", "#0f172a", "#020617"],
    side: "#d97706",
    wing: "#f59e0b",
    stripe: "rgba(245,158,11,.92)",
    helmet: "#fbbf24",
    numColor: "#fde047",
    color: "#d97706",
  },
  {
    name: "赛博霓虹",
    grad: ["#22d3ee", "#06b6d4", "#0e7490"],
    side: "#ec4899",
    wing: "#f43f5e",
    stripe: "rgba(244,63,94,.92)",
    helmet: "#f43f5e",
    numColor: "#ffffff",
    color: "#ec4899",
  },
  {
    name: "极速翠绿",
    grad: ["#34d399", "#059669", "#064e3b"],
    side: "#047857",
    wing: "#ffffff",
    stripe: "rgba(255,255,255,.9)",
    helmet: "#f97316",
    numColor: "#ffffff",
    color: "#10b981",
  },
  {
    name: "熔岩火橙",
    grad: ["#fb923c", "#ea580c", "#9a3412"],
    side: "#18181b",
    wing: "#0f172a",
    stripe: "rgba(255,255,255,.9)",
    helmet: "#fde047",
    numColor: "#ffffff",
    color: "#ea580c",
  },
  {
    name: "紫电幻影",
    grad: ["#c084fc", "#9333ea", "#581c87"],
    side: "#84cc16",
    wing: "#a3e635",
    stripe: "rgba(163,230,53,.9)",
    helmet: "#bef264",
    numColor: "#ffffff",
    color: "#a855f7",
  },
  {
    name: "钛银冰蓝",
    grad: ["#ffffff", "#cbd5e1", "#475569"],
    side: "#06b6d4",
    wing: "#0891b2",
    stripe: "rgba(6,182,212,.95)",
    helmet: "#38bdf8",
    numColor: "#0f172a",
    color: "#0891b2",
  },
  {
    name: "荧光战蜂",
    grad: ["#fef08a", "#eab308", "#854d0e"],
    side: "#18181b",
    wing: "#09090b",
    stripe: "rgba(15,23,42,.9)",
    helmet: "#0284c7",
    numColor: "#0f172a",
    color: "#eab308",
  },
  {
    name: "白红经典",
    grad: ["#ffffff", "#f1f5f9", "#e2e8f0"],
    side: "#dc2626",
    wing: "#ef4444",
    stripe: "rgba(220,38,38,.9)",
    helmet: "#b91c1c",
    numColor: "#dc2626",
    color: "#e11d48",
  },
  {
    name: "极地冰霜",
    grad: ["#e0f2fe", "#7dd3fc", "#0369a1"],
    side: "#fb7185",
    wing: "#f43f5e",
    stripe: "rgba(251,113,133,.9)",
    helmet: "#fda4af",
    numColor: "#0f172a",
    color: "#38bdf8",
  },
  {
    name: "毒液暗夜",
    grad: ["#27272a", "#18181b", "#09090b"],
    side: "#ef4444",
    wing: "#dc2626",
    stripe: "rgba(239,68,68,.9)",
    helmet: "#ef4444",
    numColor: "#ef4444",
    color: "#ef4444",
  },
];

// 根据序号生成不重复的随机涂装与颜色点位
export function getRandomLivery(slotIdx = 0, defaultNum = null) {
  const p = RANDOM_LIVERY_PALETTES[(slotIdx * 3 + 1) % RANDOM_LIVERY_PALETTES.length];
  // 车号点位生成：若未指定则依据发车格或随机点位
  const numList = ["1", "16", "44", "55", "11", "81", "4", "63", "7", "9", "23", "77"];
  const num = defaultNum || numList[slotIdx % numList.length] || String(slotIdx + 1);
  return {
    ...p,
    num,
  };
}

/* ================= 逐部件随机涂装（在线 PK 用） =================
  与上面的整包配色板不同：不抽取现成的一套配色，而是车身渐变、侧箱、尾翼、
  引擎盖拉花、头盔、车号颜色各自独立随机，同场多台车几乎不可能撞色。
  车身三段渐变共用一个随机色相族（否则整车像调色盘），
  其余部件强制与车身色相错开 70°~290°，保证部件之间看得清边界。 */
const LIVERY_NUM_POOL = ["1", "16", "44", "55", "11", "81", "4", "63", "7", "9", "23", "77"];
const LIVERY_NUM_COLORS = ["#ffffff", "#0f172a", "#fde047", "#f8fafc"];

// 稳定种子：同一台车（sid / 车号）在任何客户端算出的涂装必须完全一样，
// 否则联机时"自己屏幕上是青色车、别人屏幕上是紫色车"。
function hashSeed(v) {
  const s = String(v ?? "");
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
// mulberry32：小而稳的确定性伪随机数发生器（同种子 → 同序列）
function mulberry32(a) {
  let t0 = a >>> 0;
  return function () {
    t0 = (t0 + 0x6D2B79F5) >>> 0;
    let t = t0;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hslStr(h, s, l, a = null) {
  const hh = Math.round(((h % 360) + 360) % 360);
  const ss = Math.round(s);
  const ll = Math.round(l);
  return a == null ? `hsl(${hh}, ${ss}%, ${ll}%)` : `hsla(${hh}, ${ss}%, ${ll}%, ${a})`;
}

// seed == null → 真随机（单机）；给 seed 则确定性生成（联机，靠 sid 对齐）
export function getRandomPartLivery(slotIdx = 0, defaultNum = null, seed = null) {
  const rnd = seed == null ? Math.random : mulberry32(hashSeed(seed));
  const randRange = (a, b) => a + rnd() * (b - a);
  const randHue = () => rnd() * 360;
  // 与 base 色相至少错开 minGap，方向随机（制造强对比的部件色）
  const contrastHue = (base, minGap) => {
    const gap = randRange(minGap, 360 - minGap);
    return base + (rnd() < 0.5 ? gap : -gap);
  };

  const hBody = randHue();
  const satBody = randRange(60, 92);
  const num = defaultNum || LIVERY_NUM_POOL[slotIdx % LIVERY_NUM_POOL.length] || String(slotIdx + 1);
  return {
    name: "逐部件随机",
    grad: [
      hslStr(hBody + randRange(-12, 12), satBody, randRange(56, 72)),
      hslStr(hBody, satBody, randRange(38, 50)),
      hslStr(hBody + randRange(-16, 16), Math.min(96, satBody + 6), randRange(20, 30)),
    ],
    side: hslStr(contrastHue(hBody, 70), randRange(55, 90), randRange(32, 52)),
    wing: hslStr(contrastHue(hBody, 90), randRange(70, 95), randRange(45, 62)),
    stripe: hslStr(contrastHue(hBody, 90), randRange(70, 95), 72, 0.92),
    helmet: hslStr(randHue(), randRange(75, 95), randRange(52, 68)),
    numColor: LIVERY_NUM_COLORS[Math.floor(rnd() * LIVERY_NUM_COLORS.length)],
    color: hslStr(hBody, 78, 52),        // 小地图 / HUD 排位条主题色跟随车身主色
    num,
  };
}

export const CAR_LIVERIES = {
  ferrari: {           // 法拉利 SF-24
    grad: ["#ff6b6b", "#e02424", "#991b1b"],
    side: "#b91c1c",
    wing: "#e02424",
    stripe: "rgba(255,255,255,.9)",
    helmet: "#ffd166",
    num: "16",
    numColor: "#ffffff"
  },
  redbull: {           // 红牛 RB20
    grad: ["#38bdf8", "#0284c7", "#075985"],
    side: "#0369a1",
    wing: "#f59e0b",
    stripe: "rgba(255,255,255,.9)",
    helmet: "#ef4444",
    num: "1",
    numColor: "#ffffff"
  },
  aston: {             // 阿斯顿·马丁 AMR24
    grad: ["#34d399", "#059669", "#064e3b"],
    side: "#047857",
    wing: "#a3e635",
    stripe: "rgba(255,255,255,.9)",
    helmet: "#f97316",
    num: "14",
    numColor: "#ffffff"
  },
  mercedes: {          // 梅奔 W15
    grad: ["#f8fafc", "#94a3b8", "#475569"],
    side: "#06b6d4",
    wing: "#06b6d4",
    stripe: "rgba(6,182,212,.95)",
    helmet: "#38bdf8",
    num: "44",
    numColor: "#0f172a"
  },
  su7ultra: {          // 小米 SU7 Ultra（灼烈黄）· 街车车体
    body: "road",      // road = 封闭座舱街车渲染，与 F1 开放式车体区分
    grad: ["#fde047", "#f5c518", "#a16207"],
    side: "#ca8a04",
    wing: "#0a0a0a",
    stripe: "rgba(15,23,42,.9)",
    helmet: "#0ea5e9",
    num: "7",
    numColor: "#0f172a"
  },
  yangwang: {          // 仰望 U9X（曜石黑金）· 街车车体
    body: "road",
    grad: ["#475569", "#1e293b", "#020617"],
    side: "#b45309",
    wing: "#f59e0b",
    stripe: "rgba(245,158,11,.92)",
    helmet: "#f43f5e",
    num: "9",
    numColor: "#fbbf24"
  },
  cyber: {           // cyber
    grad: ["#00ff00", "#0000ff", "#fe8096"],
    side: "#fe8096",
    wing: "#f59e0b",
    stripe: "rgba(255,255,255,.9)",
    helmet: "#ef4444",
    num: "55",
    numColor: "#fe8096"
  },
};

export function drawCar(g, car, liveryKey = "ferrari") {
  const baseLivery = CAR_LIVERIES[car.livery || liveryKey] || CAR_LIVERIES.ferrari;
  const livery = car.customLivery ? { ...baseLivery, ...car.customLivery } : baseLivery;

  g.save();
  g.translate(car.x, car.y);
  g.rotate(car.angle);
  g.scale(M, M);          // 之后全部使用米

  // 落地阴影
  g.save();
  g.translate(0.08, 0.1);
  g.fillStyle = "rgba(0,0,0,.30)";
  g.beginPath();
  g.ellipse(0, 0, 2.9, 0.95, 0, 0, TAU);
  g.fill();
  g.restore();

  // 街车车体（量产电车超跑）：封闭座舱、贯穿式尾灯，与 F1 开放式车体明显区分
  if (livery.body === "road") {
    drawRoadBody(g, car, livery);
    g.restore();
    return;
  }

  // 尾翼
  g.fillStyle = "#1c222a";
  rrect(g, -2.82, -0.74, 0.5, 1.48, 0.06); g.fill();
  g.fillStyle = livery.wing;
  rrect(g, -2.88, -0.76, 0.55, 0.17, 0.05); g.fill();
  rrect(g, -2.88, 0.59, 0.55, 0.17, 0.05); g.fill();

  // 刹车灯（本地车看物理状态，远端车看快照中继的踏板输入）
  if (car.braking || car.inBrake > 0) {
    g.fillStyle = "rgba(255,60,60,.35)";
    rrect(g, -3.05, -0.52, 0.46, 0.32, 0.1); g.fill();
    rrect(g, -3.05, 0.2, 0.46, 0.32, 0.1); g.fill();
    g.fillStyle = "#ff3b3b";
    rrect(g, -2.8, -0.48, 0.24, 0.26, 0.06); g.fill();
    rrect(g, -2.8, 0.22, 0.24, 0.26, 0.06); g.fill();
  }

  // 轮胎
  const tyre = (cx, cy, w, l, rot) => {
    g.save();
    g.translate(cx, cy);
    g.rotate(rot || 0);
    g.fillStyle = "#14181d";
    rrect(g, -l / 2, -w / 2, l, w, 0.09); g.fill();
    g.fillStyle = "rgba(255,255,255,.18)";
    rrect(g, -l / 2 + 0.07, -w / 2 + 0.055, l - 0.14, 0.08, 0.03); g.fill();
    g.restore();
  };
  tyre(-1.75, -0.79, 0.42, 0.74, 0);
  tyre(-1.75, 0.79, 0.42, 0.74, 0);
  tyre(1.75, -0.77, 0.36, 0.62, car.steer * 0.5);
  tyre(1.75, 0.77, 0.36, 0.62, car.steer * 0.5);

  // 车身
  const grad = g.createLinearGradient(0, -0.55, 0, 0.55);
  grad.addColorStop(0, livery.grad[0]);
  grad.addColorStop(0.42, livery.grad[1]);
  grad.addColorStop(1, livery.grad[2]);
  g.beginPath();
  g.moveTo(2.8, -0.12);
  g.bezierCurveTo(2.3, -0.2, 1.4, -0.3, 0.4, -0.36);
  g.lineTo(-0.9, -0.42);
  g.lineTo(-2.1, -0.5);
  g.lineTo(-2.45, -0.47);
  g.lineTo(-2.45, 0.47);
  g.lineTo(-2.1, 0.5);
  g.lineTo(-0.9, 0.42);
  g.lineTo(0.4, 0.36);
  g.bezierCurveTo(1.4, 0.3, 2.3, 0.2, 2.8, 0.12);
  g.closePath();
  g.fillStyle = grad;
  g.fill();
  g.strokeStyle = "rgba(0,0,0,.35)";
  g.lineWidth = 0.03;
  g.stroke();

  // 侧箱
  for (const s of [-1, 1]) {
    g.beginPath();
    g.moveTo(0.7, -0.34 * s);
    g.lineTo(-0.3, -0.42 * s);
    g.lineTo(-1.1, -0.52 * s);
    g.lineTo(-1.65, -0.5 * s);
    g.lineTo(-1.4, -0.36 * s);
    g.closePath();
    g.fillStyle = livery.side;
    g.fill();
    g.strokeStyle = "rgba(255,255,255,.22)";
    g.lineWidth = 0.025;
    g.stroke();
  }

  // 车头白色/高光装饰条
  g.fillStyle = livery.stripe;
  rrect(g, 1.25, -0.07, 1.1, 0.14, 0.07); g.fill();

  // 座舱 / 头盔
  g.fillStyle = "#0f1318";
  g.beginPath();
  g.ellipse(-0.45, 0, 0.62, 0.3, 0, 0, TAU);
  g.fill();
  g.strokeStyle = "#2b333d";
  g.lineWidth = 0.05;
  g.beginPath();
  g.ellipse(-0.45, 0, 0.6, 0.32, 0, 0, TAU);
  g.stroke();
  g.fillStyle = livery.helmet;
  g.beginPath();
  g.arc(0.12, 0, 0.2, 0, TAU);
  g.fill();
  g.fillStyle = "#1b2027";
  rrect(g, 0.2, -0.15, 0.16, 0.3, 0.05); g.fill();

  // 车身号码
  g.save();
  g.rotate(Math.PI / 2);
  g.fillStyle = livery.numColor;
  g.font = "bold 0.45px sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(car.number || livery.num, 0, 1.1);
  g.restore();

  // 前翼
  g.fillStyle = "#1c222a";
  rrect(g, 2.28, -0.92, 0.42, 1.84, 0.05); g.fill();
  g.fillStyle = livery.wing;
  rrect(g, 2.62, -0.92, 0.1, 1.84, 0.03); g.fill();
  g.fillStyle = "#1c222a";
  rrect(g, 2.22, -1.0, 0.5, 0.14, 0.04); g.fill();
  rrect(g, 2.22, 0.86, 0.5, 0.14, 0.04); g.fill();

  g.restore();
}

// 街车（量产电车超跑）车体：封闭式玻璃座舱、贯穿式尾灯、鸭尾扰流，
// 无前翼/侧箱/头盔，与 F1 开放式车体形成明显视觉区分
function drawRoadBody(g, car, livery) {
  // 轮胎（比 F1 略窄，收入轮拱）
  const tyre = (cx, cy, w, l, rot) => {
    g.save();
    g.translate(cx, cy);
    g.rotate(rot || 0);
    g.fillStyle = "#14181d";
    rrect(g, -l / 2, -w / 2, l, w, 0.09); g.fill();
    g.fillStyle = "rgba(255,255,255,.18)";
    rrect(g, -l / 2 + 0.07, -w / 2 + 0.055, l - 0.14, 0.08, 0.03); g.fill();
    g.restore();
  };
  tyre(-1.55, -0.86, 0.42, 0.72, 0);
  tyre(-1.55, 0.86, 0.42, 0.72, 0);
  tyre(1.5, -0.84, 0.38, 0.62, car.steer * 0.5);
  tyre(1.5, 0.84, 0.38, 0.62, car.steer * 0.5);

  // 车身：超跑楔形轮廓（前窄后宽的量产街车比例）
  const grad = g.createLinearGradient(0, -1, 0, 1);
  grad.addColorStop(0, livery.grad[0]);
  grad.addColorStop(0.45, livery.grad[1]);
  grad.addColorStop(1, livery.grad[2]);
  g.beginPath();
  g.moveTo(2.6, -0.38);
  g.quadraticCurveTo(2.68, 0, 2.6, 0.38);                      // 圆钝车头（前部宽 0.76m，量产车比例）
  g.bezierCurveTo(2.3, 0.56, 2.05, 0.68, 1.45, 0.78);          // 前翼子板
  g.bezierCurveTo(0.9, 0.9, 0.1, 0.94, -0.6, 0.94);
  g.bezierCurveTo(-1.3, 0.96, -2.0, 0.98, -2.4, 0.82);
  g.quadraticCurveTo(-2.55, 0.72, -2.55, 0.5);
  g.lineTo(-2.55, -0.5);
  g.quadraticCurveTo(-2.55, -0.72, -2.4, -0.82);
  g.bezierCurveTo(-2.0, -0.98, -1.3, -0.96, -0.6, -0.94);
  g.bezierCurveTo(0.1, -0.92, 0.9, -0.88, 1.45, -0.76);
  g.bezierCurveTo(2.05, -0.66, 2.3, -0.54, 2.6, -0.38);
  g.closePath();
  g.fillStyle = grad;
  g.fill();
  g.strokeStyle = "rgba(0,0,0,.4)";
  g.lineWidth = 0.035;
  g.stroke();

  // 鸭尾扰流板
  g.fillStyle = "#11151b";
  rrect(g, -2.42, -0.78, 0.28, 1.56, 0.06); g.fill();
  g.fillStyle = livery.wing;
  rrect(g, -2.48, -0.8, 0.14, 1.6, 0.06); g.fill();

  // 贯穿式尾灯（EV 标志性设计，刹车时高亮泛光）
  const braking = car.braking || car.inBrake > 0;
  if (braking) {
    g.fillStyle = "rgba(255,69,58,.32)";
    rrect(g, -2.72, -0.95, 0.48, 1.9, 0.12); g.fill();
  }
  g.fillStyle = braking ? "#ff453a" : livery.wing;
  rrect(g, -2.56, -0.82, 0.16, 1.64, 0.07); g.fill();

  // 封闭式玻璃座舱
  g.fillStyle = "rgba(10,14,20,.92)";
  g.beginPath();
  g.moveTo(0.75, -0.5);
  g.quadraticCurveTo(-0.1, -0.64, -0.85, -0.58);
  g.quadraticCurveTo(-1.12, -0.52, -1.16, -0.28);
  g.lineTo(-1.16, 0.28);
  g.quadraticCurveTo(-1.12, 0.52, -0.85, 0.58);
  g.quadraticCurveTo(-0.1, 0.64, 0.75, 0.5);
  g.quadraticCurveTo(0.96, 0.32, 0.96, 0);
  g.quadraticCurveTo(0.96, -0.32, 0.75, -0.5);
  g.closePath();
  g.fill();
  g.strokeStyle = "rgba(255,255,255,.18)";
  g.lineWidth = 0.03;
  g.stroke();

  // 前大灯
  g.fillStyle = "rgba(215,238,255,.88)";
  rrect(g, 2.26, -0.44, 0.34, 0.22, 0.09); g.fill();
  rrect(g, 2.26, 0.22, 0.34, 0.22, 0.09); g.fill();

  // 引擎盖拉花
  g.fillStyle = livery.stripe;
  rrect(g, 1.0, -0.08, 1.25, 0.16, 0.08); g.fill();

  // 车身号码（与前翼子板位置一致）
  g.save();
  g.rotate(Math.PI / 2);
  g.fillStyle = livery.numColor;
  g.font = "bold 0.45px sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(car.number || livery.num, 0, 1.1);
  g.restore();
}
