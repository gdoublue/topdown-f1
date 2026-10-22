/* 算法调试公共底座
 * ---------------------------------------------------------------------------
 * 所有调试脚本（algo-doctor / algo-check / autopilot-bench）共用同一套：
 *   · 算法加载与沙箱编译（与游戏内同一个工厂 autopilotFactoryCode）
 *   · 单场 solo 仿真循环（driver → stepCar → 计圈，与 main.js 物理子步一致）
 *   · 逐步遥测钩子 onStep（给分析型工具采集通道/分段数据）
 * 这样"换一个算法来调"只需要换 --algo 参数，不必再写新脚本。
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

import { createCar, stepCar, resolveCarCollisions, finishedCarInput } from "../../src/car/physics.js";
import {
  AI_CONFIGS, applyCarConfig, createAIInput, buildGridSlots, driveAI,
  superDriver, driveApexHunter, driveVectorPursuit, driveClassicBaseline, driveSmoothCruiser,
} from "../../src/game/ai.js";
import { geminiDriver } from "../../src/game/geminiDriver.js";
import { race, resetRace, initCarRaceState, updateCarLap } from "../../src/game/race.js";
import { switchTrack } from "../../src/track/geometry.js";
import { PHYS, setRaceLaps } from "../../src/config.js";
import {
  autopilotFactoryCode, createAutopilotApiValues, API_PARAMS, DRIVER_PARAMS,
} from "../../src/ui/autopilot.js";
import { driverCarView, driverCarsView, drainDriverViolations, DRIVER_THIS } from "../../src/game/driverSandbox.js";

const FX = { addSkid() {}, addDust() {}, clearEffects() {} };
const NO_DRIVER_MSG = "没有找到 driver(car, out, dt, otherCars) 函数（函数名必须是 driver）";

export const BUILTIN_ALGOS = {
  superDriver,
  geminiDriver,
  apexHunter: driveApexHunter,
  vectorPursuit: driveVectorPursuit,
  classicBaseline: driveClassicBaseline,
  smoothCruiser: driveSmoothCruiser,
};

export const DEFAULT_REF = "geminiDriver";

/* ============================== 赛道 / 赛车 ============================== */

export function listCars() {
  return AI_CONFIGS.map((c) => c.id);
}

export function carConfig(carId) {
  const cfg = AI_CONFIGS.find((c) => c.id === carId);
  if (!cfg) throw new Error(`未知赛车：${carId}（可选：${listCars().join(" / ")}）`);
  return cfg;
}

/* ============================== 算法加载 ============================== */

function installSeededRandom(ctx, seed) {
  const src = `Math.random = (function(){let a=${seed >>> 0};return function(){a=(a+0x6D2B79F5)|0;`
    + `let t=Math.imul(a^(a>>>15),1|a);t=(t+Math.imul(t^(t>>>7),61|t))^t;`
    + `return((t^(t>>>14))>>>0)/4294967296;};})();`;
  new vm.Script(src).runInContext(ctx);
}

function makeSandboxConsole(logs, verbose, label) {
  const push = (level) => (...args) => {
    const text = args.map((a) => {
      if (typeof a === "object" && a !== null) {
        try { return JSON.stringify(a).slice(0, 160); } catch { return "[object]"; }
      }
      return String(a);
    }).join(" ");
    if (logs.length < 300) logs.push(`${level}: ${text}`);
    if (verbose) console.log(`    │ [${label}] console.${level}: ${text}`);
  };
  return { log: push("log"), info: push("info"), warn: push("warn"), error: push("error"), debug: push("debug"), table: push("table") };
}

function apiValues(copy = true) {
  const values = createAutopilotApiValues(copy);
  if (values.length !== DRIVER_PARAMS.length) {
    throw new Error(`注入项数量不一致（${values.length} vs ${DRIVER_PARAMS.length}）：检查 src/ui/autopilot.js`);
  }
  for (let i = 0; i < API_PARAMS.length; i++) {
    if (values[i] === undefined) throw new Error(`注入项 "${API_PARAMS[i]}" 取值为 undefined`);
  }
  return values;
}

export function compileSandbox(source, { seed = 1, logs = [], verbose = false, label = "algo" } = {}) {
  const ctx = vm.createContext({ console: makeSandboxConsole(logs, verbose, label) });
  installSeededRandom(ctx, seed);
  let factory;
  try {
    factory = new vm.Script(`(function(){${autopilotFactoryCode(source)}})`, { filename: label }).runInContext(ctx);
  } catch (e) {
    throw new Error(`语法错误：${e.message}`);
  }
  const fn = factory()(...apiValues(true));
  if (typeof fn !== "function") throw new Error(NO_DRIVER_MSG);
  return fn;
}

/** 加载算法：内置名 / 文件路径 / `别名=路径` / `-`（stdin） */
export function loadAlgo(spec, { seed = 1, verbose = false } = {}) {
  const eq = spec.indexOf("=");
  const alias = eq > 0 ? spec.slice(0, eq) : null;
  const target = eq > 0 ? spec.slice(eq + 1) : spec;

  if (BUILTIN_ALGOS[target]) {
    return { name: alias || target, builtin: true, fn: BUILTIN_ALGOS[target], logs: [] };
  }

  let source, file = null, name;
  if (target === "-") {
    source = fs.readFileSync(0, "utf8");
    name = alias || "stdin";
  } else {
    file = path.resolve(target);
    if (!fs.existsSync(file)) {
      throw new Error(`找不到算法：${target}（内置算法：${Object.keys(BUILTIN_ALGOS).join(" / ")}）`);
    }
    source = fs.readFileSync(file, "utf8");
    name = alias || path.basename(file, path.extname(file));
  }
  const logs = [];
  compileSandbox(source, { seed, logs, verbose, label: name });   // 入口 / 语法预检
  return { name, builtin: false, source, file, logs };
}

/** 换赛道后重新编译（与游戏一致：注入的 pts / lineX 是新赛道的） */
export function compileForRun(algo, { seed = 1, verbose = false } = {}) {
  if (algo.builtin) return algo.fn;
  return compileSandbox(algo.source, { seed, logs: algo.logs, verbose, label: algo.name });
}

/* ============================== 跑一场（solo / duel / vs） ============================== */

const round1 = (v) => Math.round(v * 10) / 10;

/**
 * @param {object} o
 * @param {object} o.algo         loadAlgo() 的返回值
 * @param {string} [o.mode]       solo | duel | vs
 * @param {string} o.trackId
 * @param {string} o.carId
 * @param {number} [o.laps=3]
 * @param {number} [o.dt=1/60]
 * @param {boolean} [o.jitter=false]
 * @param {number} [o.seed=1]
 * @param {number} [o.maxSeconds=0]  0 = 圈数 × 240 + 120
 * @param {Function} [o.onStep]  ({ car, out, dt, step, simMs, live }) => void（只在我的车未完赛时调用）
 * @param {boolean} [o.verbose=false]
 */
export function runRace(o) {
  const {
    algo, rivalAlgo = null, mode = "solo", trackId, carId, rivalCarId = null,
    laps = 3, dt = 1 / 60, jitter = false, seed = 1,
    maxSeconds = 0, onStep = null, verbose = false, randomGrid = false,
  } = o;
  if (mode !== "solo" && mode !== "duel" && mode !== "vs") throw new Error(`未知模式：${mode}`);

  const cfg = carConfig(carId);
  const rivalCfg = rivalAlgo ? carConfig(rivalCarId || carId) : null;
  // 顺序固定：先激活赛道，再编译（算法拿到的注入数据才是这条赛道的）
  switchTrack(trackId);
  const fn = compileForRun(algo, { seed, verbose });
  if (algo.logs) algo.logs.length = 0;
  const rivalFn = rivalAlgo ? compileForRun(rivalAlgo, { seed, verbose: false }) : null;

  setRaceLaps(laps);
  resetRace();
  race.state = "racing";
  race.raceStart = race.lapStart = 0;

  const cars = [];
  const outs = [];
  let meIdx = 0;
  let rivalIdx = -1;
  const pushCar = (carCfg, gridPos, role) => {
    const car = applyCarConfig(createCar(gridPos), carCfg);
    car.isPlayer = role === "me";
    car.isAI = role !== "me";
    car.driver = role === "me" ? fn : role === "rival" ? rivalFn : carCfg.driver;
    initCarRaceState(car, 0);
    car.raceStart = 0;
    cars.push(car);
    outs.push(createAIInput());
    return cars.length - 1;
  };

  if (mode === "solo") {
    meIdx = pushCar(cfg, 0, "me");
    if (rivalAlgo) rivalIdx = pushCar(rivalCfg, 1, "rival");
  } else if (mode === "duel") {
    meIdx = pushCar(cfg, 0, "me");      // 同款车 1v1：只比算法
    rivalIdx = rivalAlgo ? pushCar(rivalCfg, 1, "rival") : pushCar(cfg, 1, "ai");
  } else {
    const grid = buildGridSlots(AI_CONFIGS, randomGrid);
    for (let i = 0; i < AI_CONFIGS.length; i++) {
      const idx = pushCar(AI_CONFIGS[i], grid[i], AI_CONFIGS[i].id === cfg.id ? "me" : "ai");
      if (cars[idx].isPlayer) meIdx = idx;
    }
    // 对手算法：同款车追加到队尾（发车位靠后，读数时按总时/最快圈比，不看名次先后）
    if (rivalAlgo) rivalIdx = pushCar(rivalCfg, AI_CONFIGS.length, "rival");
  }

  const meCar = cars[meIdx];
  const stats = cars.map(() => ({ laps: [], top: 0, grass: 0, frames: 0, timeSpent: 0 }));
  let simMs = 0;
  let steps = 0;
  let errors = 0;
  let firstError = "";
  const violations = new Map();
  const maxMs = (maxSeconds > 0 ? maxSeconds : laps * 240 + 120) * 1000;
  const live = [];
  const wall0 = process.hrtime.bigint();

  while (simMs < maxMs) {
    const stepDt = jitter ? dt * (0.6 + Math.random() * 0.8) : dt;
    simMs += stepDt * 1000;
    steps++;

    live.length = 0;
    for (const c of cars) if (!c.finished) live.push(c);

    for (let i = 0; i < cars.length; i++) {
      const car = cars[i];
      const out = outs[i];
      if (i === meIdx) {
        try {
          fn.call(DRIVER_THIS, driverCarView(car), out, stepDt, driverCarsView(live));
        } catch (e) {
          errors++;
          if (!firstError) firstError = String((e && e.message) || e);
          if (verbose) console.log(`    │ ✗ 第 ${steps} 步异常：${firstError}`);
          out.up = false; out.brake = 1; out.steer = 0;
        }
        for (const hit of drainDriverViolations()) {
          violations.set(hit.key, (violations.get(hit.key) || 0) + hit.count);
        }
      } else if (i === rivalIdx) {
        try {
          rivalFn.call(DRIVER_THIS, driverCarView(car), out, stepDt, driverCarsView(live));
        } catch (e) {
          out.up = false; out.brake = 1; out.steer = 0;   // 对手异常：松油滑行，不污染我的统计
        }
      } else {
        driveAI(car, out, stepDt, live);      // 其余车沿用各自的内置 AI
      }

      stepCar(car, stepDt, car.finished ? finishedCarInput(car, out) : out, FX);

      const st = stats[i];
      st.frames++;
      if (car.surf === 2) st.grass++;
      if (Math.abs(car.speed) * 3.6 > st.top) st.top = Math.abs(car.speed) * 3.6;

      const ev = updateCarLap(car, simMs);
      if (ev === "lap" || ev === "finish") st.laps.push(Math.round(car.last));

      if (i === meIdx) {
        if (onStep && !car.finished) onStep({ car, out, dt: stepDt, step: steps, simMs, live });
        if (!Number.isFinite(car.x + car.y + car.speed)) {
          errors++;
          if (!firstError) firstError = "车辆状态变成 NaN";
        }
      }
    }

    resolveCarCollisions(cars);

    if (errors >= 3) break;
    if (cars.every((c) => c.finished)) break;
  }

  const wallMs = Number(process.hrtime.bigint() - wall0) / 1e6;
  const rows = cars.map((car, i) => ({
    isMine: i === meIdx,
    isRival: i === rivalIdx,
    carId: car.id,
    carName: car.shortName,
    driver: i === meIdx ? algo.name : i === rivalIdx ? (rivalAlgo?.name || "对手") : "内置AI",
    finished: !!car.finished,
    bestLapMs: car.best == null ? null : Math.round(car.best),
    totalMs: car.finished ? Math.round(car.total) : null,
    lapTimesMs: stats[i].laps,
    topSpeedKmh: round1(stats[i].top),
    grassPct: stats[i].frames ? Math.round((stats[i].grass / stats[i].frames) * 1000) / 10 : 0,
    raceDist: Math.round(car.raceDist || 0),
  }));
  rows.sort((a, b) => {
    if (a.finished !== b.finished) return a.finished ? -1 : 1;
    if (a.finished) return (a.totalMs ?? Infinity) - (b.totalMs ?? Infinity);
    return b.raceDist - a.raceDist;
  });
  rows.forEach((r, i) => { r.rank = i + 1; });

  const me = rows.find((r) => r.isMine);
  const rivalRow = rows.find((r) => r.isRival) || null;
  const winner = rows[0];
  const meSt = stats[meIdx];

  return {
    ok: errors === 0,
    algo: algo.name,
    mode,
    trackId,
    carId,
    carName: cfg.shortName,
    laps,
    dtSec: dt,
    jitter: !!jitter,
    finished: me.finished,
    bestLapMs: me.bestLapMs,
    totalMs: me.totalMs,
    lapTimesMs: me.lapTimesMs,
    topSpeedKmh: me.topSpeedKmh,
    grassPct: me.grassPct,
    steps,
    myFrames: meSt.frames,
    simSeconds: simMs / 1000,
    wallMs,
    rank: me.rank,
    fieldSize: rows.length,
    gapToWinnerMs: me.finished && winner.finished ? Math.round((me.totalMs ?? 0) - (winner.totalMs ?? 0)) : null,
    // 同场对手算法（--rival）的成绩与差距；正数 = 我比对手慢
    rival: rivalRow ? {
      algo: rivalRow.driver,
      carId: rivalRow.carId,
      carName: rivalRow.carName,
      rank: rivalRow.rank,
      finished: rivalRow.finished,
      bestLapMs: rivalRow.bestLapMs,
      totalMs: rivalRow.totalMs,
      gapTotalMs: me.totalMs != null && rivalRow.totalMs != null ? me.totalMs - rivalRow.totalMs : null,
      gapBestLapMs: me.bestLapMs != null && rivalRow.bestLapMs != null ? me.bestLapMs - rivalRow.bestLapMs : null,
    } : null,
    rivals: rows.filter((r) => !r.isMine).map((r) => ({
      carId: r.carId, carName: r.carName, driver: r.driver, rank: r.rank,
      bestLapMs: r.bestLapMs, totalMs: r.totalMs, finished: r.finished,
    })),
    violations: violations.size,
    violationSamples: [...violations.entries()].slice(0, 6).map(([k, n]) => `${k} × ${n}`),
    errors,
    firstError,
  };
}

/** 单车计时（runRace 的 solo 快捷方式，给只关心圈速的工具用） */
export function runSolo(o) {
  return runRace({ ...o, mode: "solo" });
}

/* ============================== 物理模型参考值 ============================== */

/** 满油门纵向加速度（与 src/car/physics.js 的 accelAt / evAccelAt 同式，用于"实际 vs 模型"对比） */
export function perfAccelAt(perf = {}, v = 0) {
  if (perf.powerKW != null) {
    const P = perf.powerKW * 1000;
    const m = perf.massKg ?? 2200;
    const vmax = perf.naturalVmax ?? (perf.maxSpeed ? perf.maxSpeed[0] : PHYS.maxSpeed[0]);
    const k = P / Math.max(1, m * vmax * vmax * vmax);
    const a = P / (m * Math.max(v, 2)) - k * v * v;
    return Math.max(0, Math.min(a, perf.launchAccel ?? 14.0));
  }
  const c = PHYS.accelCurve;
  let a = c[c.length - 1][1];
  for (let i = 1; i < c.length; i++) {
    if (v <= c[i][0]) {
      const v0 = c[i - 1][0], a0 = c[i - 1][1];
      a = a0 + (c[i][1] - a0) * (v - v0) / (Math.max(1e-4, c[i][0] - v0));
      break;
    }
  }
  if (v > c[c.length - 1][0]) a *= perf.highSpeedAccel ?? 1.0;
  return a * (perf.accelMult ?? 1.0);
}

/* ============================== 小工具 ============================== */

export function fmtMs(ms) {
  if (ms == null || !Number.isFinite(ms)) return "—";
  const t = Math.max(0, ms);
  const m = Math.floor(t / 60000);
  const s = (t % 60000) / 1000;
  return m > 0 ? `${m}:${s.toFixed(3).padStart(6, "0")}` : `${s.toFixed(3)}s`;
}

export function parseList(spec, all) {
  if (!spec || spec === "all") return all.slice();
  return spec.split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * 兼容 `--key=value` 与 `--key value` 两种写法：
 * 某些 shell / npm 会把 `--json=out.json` 拆成两个参数，归一化后两个脚本都能正常解析。
 */
const VALUE_KEYS = new Set([
  "algo", "tracks", "cars", "track", "car", "laps", "ref", "sections", "dt", "seed",
  "max-grass", "max-slow",
]);
const PATH_KEYS = new Set(["json", "save"]);

export function normalizeArgs(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    // 形如 `--json =out.json`（某些 shell 会把 = 拆开）
    if (/^--[\w-]+$/.test(a) && argv[i + 1]?.startsWith("=")) {
      out.push(a + argv[i + 1]);
      i++;
      continue;
    }
    const m = /^--([\w-]+)$/.exec(a);
    const next = argv[i + 1];
    if (m && next != null && !next.startsWith("--")) {
      const key = m[1];
      const take = VALUE_KEYS.has(key) || (PATH_KEYS.has(key) && /\.json$/i.test(next));
      if (take) { out.push(`${a}=${next}`); i++; continue; }
    }
    out.push(a);
  }
  return out;
}
