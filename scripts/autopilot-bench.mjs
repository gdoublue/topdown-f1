#!/usr/bin/env node
/* ============================================================================
 * 无头算法台架 · Autopilot Headless Bench
 * ----------------------------------------------------------------------------
 * 用【真实引擎】跑玩家写的 driver 脚本（和游戏内「🤖 自动驾驶」编辑器同一套注入）：
 *   src/car/physics.js（纵向/转向/摩擦圆/路面）+ src/game/ai.js（弯速表/赛车线）
 *   + src/track/geometry.js（赛道几何）+ src/game/race.js（计圈）
 * 只把渲染/DOM 拿掉，物理与算法调用顺序和 main.js 的物理子步一致。
 *
 * 两个用途：
 *   1. 玩家：改完算法先在这里跑，秒级拿到圈速，不用开浏览器；
 *   2. 开发者：同一算法跑全部赛车 / 全部赛道，检查新车发布后的公平性。
 * 完整用法 / 调试套路 / 报错速查：scripts/autopilot-bench.md
 *
 * 公平性：默认就是引擎加固后的真实行为 ——
 *   · 编译与注入完全复用 src/ui/autopilot.js（vm 域里跑，拿不到 window/document/localStorage/fetch）；
 *   · car / otherCars 传只读视图（src/game/driverSandbox.js），瞬移 / 改速度 / 改 perf / 推对手
 *     会被引擎直接丢弃并记一条越权写入；
 *   · 注入的 pts / hw / lineX / PHYS 都是副本，改不到引擎。
 * 想复现"加固前会怎样"（把裸对象交给算法），用 --raw（只审计，不是正常测试路径）。
 *
 * 用法：
 *   node scripts/autopilot-bench.mjs --help
 *   node scripts/autopilot-bench.mjs --algo=userscripts/自动驾驶脚本.js --car=all
 *   node scripts/autopilot-bench.mjs --algo=my.js --track=all --car=all --laps=3 --json
 *   node scripts/autopilot-bench.mjs --algo=my.js --mode=vs --car=smooth-cruiser --verbose
 *   node scripts/autopilot-bench.mjs --algo=- --track=monza        # 从 stdin 读源码
 * ========================================================================== */

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

import { createCar, stepCar, resolveCarCollisions, finishedCarInput } from "../src/car/physics.js";
import {
  AI_CONFIGS, buildGridSlots, applyCarConfig, createAIInput, lineX, lineY,
  superDriver, driveApexHunter, driveVectorPursuit, driveClassicBaseline, driveSmoothCruiser,
} from "../src/game/ai.js";
import { geminiDriver } from "../src/game/geminiDriver.js";
import { race, resetRace, initCarRaceState, updateCarLap } from "../src/game/race.js";
import { switchTrack, N, pts, nor, hw, curvS, currentTrackId } from "../src/track/geometry.js";
import { TRACKS, getTrack } from "../src/track/tracks.js";
import { PHYS, setRaceLaps } from "../src/config.js";
import {
  autopilotFactoryCode, createAutopilotApiValues, API_PARAMS, DRIVER_PARAMS,
} from "../src/ui/autopilot.js";
import {
  driverCarView, driverCarsView, drainDriverViolations, DRIVER_THIS,
} from "../src/game/driverSandbox.js";

const FX = { addSkid() {}, addDust() {}, clearEffects() {} };
const NO_DRIVER_MSG = "没有找到 driver(car, out, dt, otherCars) 函数（函数名必须是 driver）";

/* ============================== 1. 命令行 ============================== */

const USAGE = `
无头算法台架 · Autopilot Headless Bench

  node scripts/autopilot-bench.mjs [算法...] [选项]

算法（可重复，缺省 = superDriver）：
  --algo=<文件.js>      玩家算法源码（需定义 driver 函数），也可写 别名=路径
  --algo=-              从 stdin 读取源码
  --algo=superDriver    内置算法：superDriver / geminiDriver / apexHunter /
                        vectorPursuit / classicBaseline / smoothCruiser

选项：
  --track=<id|all>      赛道，缺省 shanghai；all = 全部赛道（默认每站 1 圈更省时）
  --car=<id|all>        赛车，缺省 all = 全部赛车各跑一场
  --laps=<n>            圈数，缺省 3（--track=all 且未显式指定时为 1）
  --mode=solo|vs|duel   solo=单车计时（缺省）；vs=整场对局（其余车用内置 AI）；
                        duel=同款车 1v1（你的算法 vs 该车内置算法）
  --dt=<秒>             物理步长，缺省 1/60（0.0333 可模拟 30fps 低端机）
  --jitter              步长抖动 ±40%（模拟真实帧率波动）
  --seed=<n>            随机种子，缺省 1（同一 seed 结果可复现）
  --random-grid         发车位随机（缺省固定发车位，便于对比）
  --raw                 复现加固前的引擎行为（裸对象 + 真实赛道数组），只审计、不拦截
  --ignore-errors       算法抛异常时继续跑（用松油滑行替代）；不加则 3 次异常后中止本场
  --max-seconds=<n>     单场仿真上限（秒），缺省按圈数给足
  --json                输出 JSON 到 stdout（便于管道 / CI）
  --json=<文件>         直接写 JSON 文件（UTF-8，绕开 shell 重定向的编码问题）
  --baseline=<json>     与上次保存的结果对比（表格里加一列 Δ 最快圈）
  --verbose             打印每圈、异常、违规明细与 console.log
  --list                列出可用赛道 / 赛车 / 内置算法
  -h, --help            显示本帮助
`;

function parseArgs(argv) {
  const o = {
    algos: [], tracks: null, cars: null, laps: null, mode: "solo",
    dt: 1 / 60, jitter: false, seed: 1, strict: true, json: false,
    verbose: false, randomGrid: false, ignoreErrors: false, maxSeconds: 0,
    baseline: null, jsonFile: null, list: false, help: false,
  };
  for (const a of argv) {
    if (a === "-h" || a === "--help") { o.help = true; continue; }
    if (a === "--list") { o.list = true; continue; }
    if (a === "--raw") { o.strict = false; continue; }
    if (a === "--json") { o.json = true; continue; }
    if (a === "--verbose") { o.verbose = true; continue; }
    if (a === "--jitter") { o.jitter = true; continue; }
    if (a === "--random-grid") { o.randomGrid = true; continue; }
    if (a === "--ignore-errors") { o.ignoreErrors = true; continue; }
    const m = /^--([\w-]+)=(.*)$/.exec(a);
    if (!m) {
      if (!a.startsWith("-")) o.algos.push(a);   // 位置参数当作算法文件
      continue;
    }
    const [, k, v] = m;
    if (k === "json") { o.json = true; if (v) o.jsonFile = v; }
    else if (k === "algo") o.algos.push(v);
    else if (k === "track") o.tracks = v;
    else if (k === "car") o.cars = v;
    else if (k === "laps") o.laps = Math.max(1, Math.round(Number(v) || 1));
    else if (k === "mode") o.mode = v;
    else if (k === "dt") o.dt = Math.max(1 / 500, Number(v) || 1 / 60);
    else if (k === "seed") o.seed = Number(v) >>> 0;
    else if (k === "max-seconds") o.maxSeconds = Number(v) || 0;
    else if (k === "baseline") o.baseline = v;
    else throw new Error(`未知参数：--${k}（--help 看用法）`);
  }
  if (!["solo", "vs", "duel"].includes(o.mode)) throw new Error("--mode 只能是 solo / vs / duel");
  if (!o.laps) o.laps = o.tracks === "all" ? 1 : 3;
  return o;
}

/* ============================== 2. 随机数 ============================== */

// 同一 seed 下"发车位 / 巡航速度 / 算法里的 Math.random"都可复现
function mulberry32(a) {
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function installSeededRandomInContext(ctx, seed) {
  const src = `Math.random = (function(){let a=${seed >>> 0};return function(){a=(a+0x6D2B79F5)|0;`
    + `let t=Math.imul(a^(a>>>15),1|a);t=(t+Math.imul(t^(t>>>7),61|t))^t;`
    + `return((t^(t>>>14))>>>0)/4294967296;};})();`;
  new vm.Script(src).runInContext(ctx);
}

/* ========================= 3. 与游戏一致的注入 ========================= */

// 注入值一律从 src/ui/autopilot.js 取（同一个工厂、同一份副本逻辑），
// 台架不再自己维护一份，避免"游戏里能用的东西"和"台架里能用的东西"漂移。
// 兜底自检：参数表变了但工厂没跟上时直接报错。
function apiValues(copy = true) {
  const values = createAutopilotApiValues(copy);
  if (values.length !== DRIVER_PARAMS.length) {
    throw new Error(`注入项数量不一致（${values.length} vs ${DRIVER_PARAMS.length}）：请检查 src/ui/autopilot.js`);
  }
  // 前 API_PARAMS 项必须有值；后面那些是被遮蔽的宿主全局（约定就是 undefined）
  for (let i = 0; i < API_PARAMS.length; i++) {
    if (values[i] === undefined) throw new Error(`注入项 "${API_PARAMS[i]}" 取值为 undefined`);
  }
  return values;
}

/* ============================ 4. 算法加载 ============================ */

const BUILTIN_ALGOS = {
  superDriver,
  geminiDriver,
  apexHunter: driveApexHunter,
  vectorPursuit: driveVectorPursuit,
  classicBaseline: driveClassicBaseline,
  smoothCruiser: driveSmoothCruiser,
};

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

// 沙箱编译：源码工厂直接用游戏的那一份（autopilotFactoryCode），
// 区别只在"跑在 vm 域里" —— window/document 连影子都没有，而形参遮蔽的语义完全一致。
function compileInSandbox(source, { seed, logs = [], verbose, label = "algo" }) {
  const ctx = vm.createContext({ console: makeSandboxConsole(logs, verbose, label) });
  installSeededRandomInContext(ctx, seed);
  let factory;
  try {
    factory = new vm.Script(`(function(){${autopilotFactoryCode(source)}})`, { filename: label })
      .runInContext(ctx);
  } catch (e) {
    throw new Error(`语法错误：${e.message}`);
  }
  const fn = factory()(...apiValues(true));
  if (typeof fn !== "function") throw new Error(NO_DRIVER_MSG);
  return fn;
}

// --raw：复现加固前的引擎行为（注入真实数组 / 真实 PHYS，不做任何数据副本），
// 用于验证"如果放开会怎样"，不是正常测试路径。
function compileRaw(source) {
  const factory = new Function(autopilotFactoryCode(source));
  const fn = factory()(...apiValues(false));
  if (typeof fn !== "function") throw new Error(NO_DRIVER_MSG);
  return fn;
}

function loadAlgorithm(spec, opt) {
  const eq = spec.indexOf("=");
  const alias = eq > 0 ? spec.slice(0, eq) : null;
  const target = eq > 0 ? spec.slice(eq + 1) : spec;

  if (BUILTIN_ALGOS[target]) {
    return { name: alias || target, builtin: true, fn: BUILTIN_ALGOS[target] };
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

  // 先编译一次做语法/入口校验（真正的算法会按赛道重新编译）
  const logs = [];
  compileInSandbox(source, { seed: opt.seed, logs, verbose: opt.verbose, label: name });
  return { name, builtin: false, source, file, logs };
}

// 每场比赛按当前赛道重新编译一次（与游戏"换赛道自动重编译"一致）
function compileForRun(algo, opt) {
  if (algo.builtin) return algo.fn;
  return opt.strict
    ? compileInSandbox(algo.source, { seed: opt.seed, logs: algo.logs, verbose: opt.verbose, label: algo.name })
    : compileRaw(algo.source);
}

/* ============================ 5. 公平性审计 ============================ */

// 算法只允许写 car._xxx（文档约定的自定义状态）和自己拿到的 out。
const CAR_FIELDS = [
  "x", "y", "angle", "speed", "steer", "nearIdx", "trackS", "raceDist", "lap",
  "finished", "half", "inUp", "inBrake", "inSteer", "accel", "braking", "surf",
  "gLat", "gLon", "gTotal", "idx", "best", "last", "total", "prevSpeed", "shake",
];
const OPP_FIELDS = ["x", "y", "angle", "speed", "nearIdx", "trackS", "raceDist", "lap", "finished"];
// 内置算法用来存记忆的字段：篡改对手这些字段等于干扰别人的 AI
const OPP_STATE = [
  "_latOffset", "_cruiseStuck", "_cruiseRev", "_cruiseMoved", "_cruiseOTSide",
  "_cruiseOTUntil", "_cruiseBlockT", "_lockedTargetLat", "_lockTimer", "_blockTimer",
];

const snapFields = (obj, keys) => {
  const s = {};
  for (const k of keys) s[k] = obj[k];
  return s;
};

// restore=false 时只记录（--raw：复现游戏内的真实允许范围）
function diffAndRestore(obj, snap, keys, restore, onHit) {
  for (const k of keys) {
    if (!Object.is(obj[k], snap[k])) {
      if (onHit) onHit(k, snap[k], obj[k]);
      if (restore) obj[k] = snap[k];
    }
  }
}

function clonePerf(p) {
  if (!p || typeof p !== "object") return p;
  const c = { ...p };
  if (Array.isArray(p.maxSpeed)) c.maxSpeed = [...p.maxSpeed];
  return c;
}

function restorePerf(car, saved) {
  if (!car.perf || typeof car.perf !== "object") car.perf = {};
  for (const k of Object.keys(car.perf)) if (!(k in saved)) delete car.perf[k];
  for (const k of Object.keys(saved)) {
    car.perf[k] = k === "maxSpeed" && Array.isArray(saved[k]) ? [...saved[k]] : saved[k];
  }
}

const sumArray = (a) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s; };
const sumPoints = (a) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i].x + a[i].y; return s; };

// 共享赛道数据 / 全局物理常量：被改会污染同场所有车（含内置 AI）
function trackFingerprint() {
  return [
    sumPoints(pts), sumPoints(nor), sumArray(hw), sumArray(curvS),
    sumArray(lineX), sumArray(lineY), N, currentTrackId, JSON.stringify(PHYS),
  ].join("|");
}

// 严格模式下的共享数据快照：被改就整段还原（对象引用保持不变，算法手里的引用继续有效）
function snapshotShared() {
  return {
    hw: hw.slice(), curvS: curvS.slice(), lineX: lineX.slice(), lineY: lineY.slice(),
    pts: pts.map((p) => ({ x: p.x, y: p.y })),
    nor: nor.map((p) => ({ x: p.x, y: p.y })),
  };
}

function restoreShared(s) {
  hw.set(s.hw); curvS.set(s.curvS); lineX.set(s.lineX); lineY.set(s.lineY);
  for (let i = 0; i < pts.length; i++) { pts[i].x = s.pts[i].x; pts[i].y = s.pts[i].y; }
  for (let i = 0; i < nor.length; i++) { nor[i].x = s.nor[i].x; nor[i].y = s.nor[i].y; }
}

function snapshotPhys() {
  return {
    ...PHYS,
    maxSpeed: [...PHYS.maxSpeed],
    accelCurve: PHYS.accelCurve.map((r) => [...r]),
  };
}

function restorePhys(s) {
  for (const k of Object.keys(PHYS)) if (!(k in s)) delete PHYS[k];
  for (const k of Object.keys(s)) {
    PHYS[k] = (k === "maxSpeed" || k === "accelCurve") ? s[k].map((v) => (Array.isArray(v) ? [...v] : v)) : s[k];
  }
}

/* ============================== 6. 跑一场 ============================== */

function fmtMs(ms) {
  if (ms == null || !Number.isFinite(ms)) return "—";
  const t = Math.max(0, ms);
  const m = Math.floor(t / 60000);
  const s = (t % 60000) / 1000;
  return m > 0 ? `${m}:${s.toFixed(3).padStart(6, "0")}` : `${s.toFixed(3)}s`;
}

const fmtNum = (v) => (typeof v === "number" && Number.isFinite(v) ? String(Math.round(v * 1000) / 1000) : String(v));

function runRace(job) {
  const { trackId, carCfg, mode, algo, laps, dt, jitter, randomGrid } = job;

  // 赛道必须已经激活（main 里先 switchTrack 再编译，顺序不能反：
  // 反了算法会拿到上一条赛道的 pts / lineX，跑出来的成绩毫无意义）
  if (currentTrackId !== trackId) throw new Error(`内部错误：当前赛道 ${currentTrackId} ≠ ${trackId}`);

  setRaceLaps(laps);
  resetRace();
  race.state = "racing";
  race.raceStart = race.lapStart = 0;

  const cars = [];
  const outs = [];
  let meIdx = 0;

  const pushCar = (cfg, gridPos, isMine) => {
    const car = applyCarConfig(createCar(gridPos), cfg);
    car.isPlayer = isMine;
    car.isAI = !isMine;
    car.driver = isMine ? algo.fn : cfg.driver;
    initCarRaceState(car, 0);
    car.raceStart = 0;
    cars.push(car);
    outs.push(createAIInput());
    return cars.length - 1;
  };

  if (mode === "solo") {
    meIdx = pushCar(carCfg, 0, true);
  } else if (mode === "duel") {
    // 同款赛车 1v1：性能完全一样，只比算法（P1 发车位略占优，8m）
    meIdx = pushCar(carCfg, 0, true);
    pushCar(carCfg, 1, false);        // 对手 = 该车内置算法
  } else {
    const grid = buildGridSlots(AI_CONFIGS, randomGrid);
    for (let i = 0; i < AI_CONFIGS.length; i++) {
      const isMine = AI_CONFIGS[i].id === carCfg.id;
      const idx = pushCar(AI_CONFIGS[i], grid[i], isMine);
      if (isMine) meIdx = idx;
    }
  }

  const meCar = cars[meIdx];
  const stats = cars.map(() => ({ laps: [], top: 0, grass: 0, frames: 0 }));
  const trackBase = trackFingerprint();
  const harden = !!job.harden;        // true = 走引擎加固后的只读视图
  const sharedSnap = harden ? null : snapshotShared();
  const physSnap = harden ? null : snapshotPhys();

  let simMs = 0;
  let steps = 0;
  let errors = 0;
  let firstError = "";
  const violationKinds = new Map();   // 同一类违规只记一次（附出现次数），避免刷屏
  const sandboxHits = new Map();      // 引擎沙箱拦截的越权写入（加固模式）
  let dead = false;

  const maxMs = (job.maxSeconds > 0 ? job.maxSeconds : laps * 240 + 120) * 1000;
  const live = [];
  const wall0 = process.hrtime.bigint();

  const addViolation = (kind, detail) => {
    const hit = violationKinds.get(kind);
    if (hit) { hit.count++; return; }
    violationKinds.set(kind, { count: 1, at: steps, text: `${kind}${detail ? " · " + detail : ""}` });
  };

  while (simMs < maxMs) {
    const stepDt = jitter ? dt * (0.6 + Math.random() * 0.8) : dt;
    simMs += stepDt * 1000;
    steps++;

    live.length = 0;
    for (const c of cars) if (!c.finished) live.push(c);

    for (let i = 0; i < cars.length; i++) {
      const car = cars[i];
      const out = outs[i];
      const drv = car.driver;
      // 加固模式下引擎自己会拦截越权写入，台架只需读沙箱日志；
      // --raw 才需要逐帧快照比对（复现"不设防"的旧行为）
      const audit = !harden && i === meIdx && !dead;

      // 审计快照：玩家车全字段 + perf + driver 引用；对手只查物理量与内置算法状态
      let meSnap = null, mePerf = null, oppSnaps = null, oppStates = null;
      if (audit) {
        meSnap = snapFields(meCar, CAR_FIELDS);
        mePerf = clonePerf(meCar.perf);
        oppSnaps = cars.map((c, k) => (k === i ? null : snapFields(c, OPP_FIELDS)));
        oppStates = cars.map((c, k) => (k === i ? null : snapFields(c, OPP_STATE)));
      }

      if (typeof drv === "function") {
        try {
          // 与 driveAI 完全一致：加固模式传只读视图，raw 模式传裸对象；this 都给空对象
          if (harden) drv.call(DRIVER_THIS, driverCarView(car), out, stepDt, driverCarsView(live));
          else drv.call(DRIVER_THIS, car, out, stepDt, live);
        } catch (e) {
          errors++;
          if (!firstError) firstError = String((e && e.message) || e);
          if (job.verbose) console.log(`    │ ✗ 第 ${steps} 步异常：${firstError}`);
          // 异常时给一个安全输入（游戏里是整帧中止，这里选择继续以便看到完整成绩）
          out.up = false; out.brake = 1; out.steer = 0;
          if (!job.ignoreErrors && errors >= 3) dead = true;
        }
        if (harden && i === meIdx) {
          for (const hit of drainDriverViolations()) {
            sandboxHits.set(hit.key, (sandboxHits.get(hit.key) || 0) + hit.count);
          }
        }
      }

      if (audit) {
        const fix = false;   // 这个分支只服务 --raw：只记录，不回滚
        // 自己的车：任何非 _ 字段的写入都是作弊
        diffAndRestore(meCar, meSnap, CAR_FIELDS, fix, (k, from, to) => {
          addViolation(`非法写入 car.${k}`, `${fmtNum(from)} → ${fmtNum(to)}`);
        });
        if (meCar.driver !== drv) {
          addViolation("非法改写 car.driver", String(meCar.driver));
          if (fix) meCar.driver = drv;
        }
        // perf 可能被原地改（抓地 / 极速 / 刹车）
        if (JSON.stringify(meCar.perf) !== JSON.stringify(mePerf)) {
          addViolation("非法修改 car.perf", "性能参数被改写");
          if (fix) restorePerf(meCar, mePerf);
        }
        // 对手：不能推别人的车，也不能给别人的 AI 塞状态
        for (let k = 0; k < cars.length; k++) {
          if (k === i) continue;
          diffAndRestore(cars[k], oppSnaps[k], OPP_FIELDS, fix, (f, from, to) => {
            addViolation(`非法写入对手 ${cars[k].shortName}.${f}`, `${fmtNum(from)} → ${fmtNum(to)}`);
          });
          diffAndRestore(cars[k], oppStates[k], OPP_STATE, fix, (f) => {
            addViolation(`非法干扰对手 AI 状态 ${cars[k].shortName}.${f}`, "");
          });
        }
        // 全局物理常量（周期检查）
        if (steps % 120 === 0 && trackFingerprint() !== trackBase) {
          addViolation("共享赛道数据 / PHYS 被篡改", "hw / lineX / pts / curvS / PHYS 发生改变");
          if (fix) { restoreShared(sharedSnap); restorePhys(physSnap); }
        }
      }

      stepCar(car, stepDt, car.finished ? finishedCarInput(car, out) : out, FX);

      const st = stats[i];
      st.frames++;
      st.top = Math.max(st.top, Math.abs(car.speed) * 3.6);
      if (car.surf === 2) st.grass++;

      const ev = updateCarLap(car, simMs);
      if (ev === "lap") {
        st.laps.push(Math.round(car.last));
        if (job.verbose && i === meIdx) console.log(`    │ 第 ${car.lap - 1} 圈 ${fmtMs(car.last)}`);
      } else if (ev === "finish") {
        st.laps.push(Math.round(car.last));
        if (job.verbose && i === meIdx) console.log(`    │ 🏁 完赛 ${fmtMs(simMs)}`);
      }

      if (!Number.isFinite(car.x + car.y + car.speed)) {
        addViolation("车辆状态变成 NaN", "算法输出/写入了非有限值");
        dead = true;
      }
    }

    resolveCarCollisions(cars);

    if (dead) break;
    if (cars.every((c) => c.finished)) break;
  }

  const wallMs = Number(process.hrtime.bigint() - wall0) / 1e6;

  const rows = cars.map((car, i) => {
    const st = stats[i];
    return {
      isMine: i === meIdx,
      carId: car.id,
      carName: car.shortName,
      finished: !!car.finished,
      bestLapMs: car.best == null ? null : Math.round(car.best),
      totalMs: car.finished ? Math.round(car.total) : null,
      lapTimesMs: st.laps,
      topSpeedKmh: Math.round(st.top * 10) / 10,
      grassPct: st.frames ? Math.round((st.grass / st.frames) * 1000) / 10 : 0,
      raceDist: Math.round(car.raceDist || 0),
      driver: car.driver === algo.fn ? algo.name : "内置",
    };
  });

  rows.sort((a, b) => {
    if (a.finished !== b.finished) return a.finished ? -1 : 1;
    if (a.finished) return (a.totalMs ?? Infinity) - (b.totalMs ?? Infinity);
    return b.raceDist - a.raceDist;
  });
  rows.forEach((r, i) => { r.rank = i + 1; });

  const me = rows.find((r) => r.isMine);
  const violationSamples = [];
  // 加固模式：引擎直接拦下的越权写入（这些写入没有进入物理）
  for (const [key, count] of [...sandboxHits.entries()].slice(0, 6)) {
    violationSamples.push(`${key} 被引擎拦截 · 共 ${count} 次（只读字段，写入已丢弃）`);
  }
  // --raw：逐帧比对发现的非法写入（这些写入真的改了游戏状态）
  for (const v of [...violationKinds.values()].slice(0, 6)) {
    violationSamples.push(`${v.text} @ 第 ${v.at} 步${v.count > 1 ? `（共 ${v.count} 次）` : ""}`);
  }
  const violationCount = sandboxHits.size + violationKinds.size;
  return {
    ok: !!(me && me.finished && violationCount === 0 && errors === 0),
    trackId,
    trackName: getTrack(trackId).name,
    carId: carCfg.id,
    carName: carCfg.shortName,
    mode,
    algo: algo.name,
    laps,
    dtSec: Math.round(dt * 1e6) / 1e6,
    jitter: !!jitter,
    hardened: harden,
    me: me ? { ...me } : null,
    rows,
    simSeconds: Math.round(simMs) / 1000,
    steps,
    wallMs: Math.round(wallMs),
    violations: violationCount,
    violationSamples,
    errors,
    firstError,
    logs: algo.logs ? algo.logs.slice(0, 20) : [],
  };
}

/* ============================== 7. 输出 ============================== */

function pad(s, n) {
  s = String(s);
  let w = 0;
  for (const ch of s) w += ch.charCodeAt(0) > 0x2e80 ? 2 : 1;
  return s + " ".repeat(Math.max(0, n - w));
}

// 解析 JSON：容忍前面混进来的日志（npm 会把脚本横幅打到 stdout）
function parseLoose(text) {
  try {
    return JSON.parse(text);
  } catch {
    const a = text.indexOf("[");
    const b = text.lastIndexOf("]");
    if (a >= 0 && b > a) return JSON.parse(text.slice(a, b + 1));
    return JSON.parse(text);   // 抛出原始错误
  }
}

// 读 JSON 文件：UTF-8（含 BOM）→ 失败再按 UTF-16LE 读（Windows PowerShell 5.1 的 `>` 重定向）
function readJsonFile(file) {
  const raw = fs.readFileSync(file);
  const utf8 = raw.toString("utf8").replace(/^\uFEFF/, "");
  try {
    return parseLoose(utf8);
  } catch {
    return parseLoose(raw.toString("utf16le").replace(/^\uFEFF/, ""));
  }
}

// 基线：--json 存下来的结果数组，按 赛道|车|算法 建索引
function loadBaseline(file) {
  const rows = readJsonFile(file);
  if (!Array.isArray(rows)) throw new Error(`基线文件格式不对（应该是 --json 的输出数组）：${file}`);
  const map = new Map();
  for (const r of rows) {
    if (!r || !r.me) continue;
    map.set(`${r.trackId}|${r.carId}|${r.algo}`, r);
  }
  return map;
}

function printTable(results, baseline) {
  const head = `${pad("算法", 15)}│ ${pad("赛车", 18)}│ ${pad("最快圈", 10)}│ ${pad("总时", 11)}│ ${pad("各圈", 28)}│ ${pad("平均", 10)}│ ${pad("极速", 10)}│ ${pad("草地", 6)}│ 违规/异常`;
  console.log(head);
  console.log("─".repeat(head.length));
  for (const r of results) {
    const me = r.me;
    if (!me) continue;
    const laps = me.lapTimesMs.map(fmtMs).join(" ");
    const trackLen = getTrack(r.trackId).length;
    const avg = me.bestLapMs ? Math.round((trackLen / (me.bestLapMs / 1000)) * 3.6) : null;
    const flag = (r.violations ? `⚠${r.violations}` : "0") + " / " + (r.errors ? `✗${r.errors}` : "0");
    // 基线对比：Δ 最快圈（负数 = 变快）
    let delta = "";
    if (baseline) {
      const base = baseline.get(`${r.trackId}|${r.carId}|${r.algo}`);
      if (!base) delta = "  Δ 新增";
      else if (base.me.bestLapMs != null && me.bestLapMs != null) {
        const d = (me.bestLapMs - base.me.bestLapMs) / 1000;
        delta = `  Δ ${d > 0 ? "+" : ""}${d.toFixed(3)}s`;
      } else delta = "  Δ 无法对比";
    }
    console.log(
      `${pad(r.algo, 15)}│ ${pad(r.carName, 18)}│ ${pad(fmtMs(me.bestLapMs), 10)}│ ${pad(fmtMs(me.totalMs), 11)}│ `
      + `${pad(laps || "—", 28)}│ ${pad(avg == null ? "—" : avg + " km/h", 10)}│ ${pad(me.topSpeedKmh + " km/h", 10)}│ `
      + `${pad(me.grassPct + "%", 6)}│ ${flag}${delta}`
    );
    if (r.rows.length > 1) {
      const others = r.rows.filter((x) => !x.isMine)
        .map((x) => `P${x.rank} ${x.carName}(${x.driver}) ${x.finished ? fmtMs(x.totalMs) : "DNF"}`).join(" · ");
      console.log(`${pad("", 17)}└ 同场：${others}`);
    }
    if (r.violations > 0) {
      console.log(`${pad("", 19)}⚠ ${r.violations} 类越权写入${r.hardened ? "（引擎已拦截）" : "（--raw 未拦截）"}：`);
      for (const v of r.violationSamples) console.log(`${pad("", 21)}- ${v}`);
    }
    if (r.errors > 0) {
      console.log(`${pad("", 19)}✗ 运行异常 ${r.errors} 次，首个：${r.firstError}`);
    }
  }
}

function printList() {
  console.log("赛道：");
  for (const t of TRACKS) {
    console.log(`  ${pad(t.id, 14)} ${t.flag} ${t.name} · ${(t.length / 1000).toFixed(2)}km · 推荐 ${t.laps} 圈`);
  }
  console.log("\n赛车：");
  for (const c of AI_CONFIGS) {
    console.log(`  ${pad(c.id, 18)} ${c.shortName} · 极速 ${(c.perf.maxSpeed[0] * 3.6).toFixed(0)}km/h`
      + ` · 抓地 ${(c.perf.latGrip / 9.81).toFixed(2)}g · 刹车 ${c.perf.brakeMult.toFixed(2)}x`
      + (c.perf.powerKW ? ` · ${c.perf.powerKW}kW / ${c.perf.massKg}kg` : ""));
  }
  console.log("\n内置算法：");
  for (const k of Object.keys(BUILTIN_ALGOS)) console.log(`  ${k}`);
}

/* ============================== 8. 主流程 ============================== */

function main() {
  let opt;
  try {
    opt = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`✗ ${e.message}`);
    process.exit(2);
  }
  if (opt.help) { console.log(USAGE); return; }
  if (opt.list) { printList(); return; }

  const hostRandom = Math.random;
  Math.random = mulberry32(opt.seed);

  try {
    const algoSpecs = opt.algos.length ? opt.algos : ["superDriver"];
    const algos = algoSpecs.map((s) => loadAlgorithm(s, opt));

    const trackIds = opt.tracks === "all"
      ? TRACKS.map((t) => t.id)
      : (opt.tracks ? opt.tracks.split(",").map((s) => s.trim()).filter(Boolean) : ["shanghai"]);

    const carIds = !opt.cars || opt.cars === "all"
      ? AI_CONFIGS.map((c) => c.id)
      : opt.cars.split(",").map((s) => s.trim()).filter(Boolean);

    for (const id of trackIds) if (!TRACKS.some((t) => t.id === id)) throw new Error(`未知赛道：${id}`);
    for (const id of carIds) if (!AI_CONFIGS.some((c) => c.id === id)) throw new Error(`未知赛车：${id}`);

    const baseline = opt.baseline ? loadBaseline(opt.baseline) : null;

    if (!opt.json) {
      console.log("\n=== 无头算法台架 · TOPDOWN F1 ===");
      console.log(`算法：${algos.map((a) => (a.builtin ? `${a.name}(内置)` : a.name)).join(" / ")}`);
      console.log(`赛道：${trackIds.join(" / ")} | 赛车：${carIds.length === AI_CONFIGS.length ? "全部" : carIds.join(" / ")}`);
      console.log(`模式：${opt.mode} | 圈数：${opt.laps} | 步长：1/${Math.round(1 / opt.dt)}${opt.jitter ? " ± 抖动" : ""}`
        + ` | seed：${opt.seed} | ${opt.strict ? "引擎沙箱（只读视图 + 只读注入数据）" : "RAW（加固前行为，仅审计用）"}`);
      if (baseline) console.log(`基线：${opt.baseline}（${baseline.size} 条记录，Δ 负数 = 变快）`);
      console.log("");
    }

    const results = [];
    for (const algo of algos) {
      for (const trackId of trackIds) {
        for (const carId of carIds) {
          const cfg = AI_CONFIGS.find((c) => c.id === carId);
          if (!cfg) throw new Error(`未知赛车：${carId}`);
          // 顺序：先激活赛道 → 再编译（游戏里换赛道也是"重建数据 → 重新编译玩家代码"）
          switchTrack(trackId);
          const fn = compileForRun(algo, opt);
          if (algo.logs) algo.logs.length = 0;   // 只保留本场的 console 输出
          const job = {
            trackId, carCfg: cfg, mode: opt.mode,
            algo: { name: algo.name, fn, logs: algo.logs },
            laps: opt.laps, dt: opt.dt, jitter: opt.jitter,
            randomGrid: opt.randomGrid, maxSeconds: opt.maxSeconds,
            harden: opt.strict, ignoreErrors: opt.ignoreErrors,
            verbose: opt.verbose,
          };
          results.push(runRace(job));
        }
      }
    }

    if (opt.json) {
      const text = JSON.stringify(results, null, 2);
      if (opt.jsonFile) {
        fs.writeFileSync(opt.jsonFile, text, "utf8");
        console.log(`✓ 结果已写入 ${opt.jsonFile}（${results.length} 条）`);
      } else {
        console.log(text);
      }
    } else {
      printTable(results, baseline);
      const bad = results.filter((r) => r.violations > 0 || r.errors > 0);
      if (bad.length) {
        console.log(`\n⚠ ${bad.length} 场存在越权写入或运行异常，成绩需要打折看（见上表）。`);
        if (opt.strict) {
          console.log("   这些写入已被引擎丢弃，成绩仍代表「只用 out 控制自己的车」能达到的水平；请修掉算法里的越权写法。");
        }
      }
      const totalSim = results.reduce((s, r) => s + r.simSeconds, 0);
      const totalWall = results.reduce((s, r) => s + r.wallMs, 0);
      console.log(`\n合计 ${results.length} 场 · 仿真 ${totalSim.toFixed(1)}s · 实际耗时 ${totalWall}ms`
        + `（${(totalSim / Math.max(0.001, totalWall / 1000)).toFixed(0)}× 实时）`);
    }
  } catch (e) {
    console.error(`\n✗ ${e.message}`);
    process.exitCode = 1;
  } finally {
    Math.random = hostRandom;
  }
}

main();
