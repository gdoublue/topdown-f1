// 在线竞速客户端（QQ飞车式高帧率连续插值 + 零延迟本地非对称碰撞模型）
//
// 1. 自车：完全本地 60fps 模拟（与单机同款物理），零网络延迟——手感与单机一致
//    完赛时本地计时并向服务器上报成绩（服务器做合理性校验与排名）
// 2. 远端车（人类+AI）：
//    - 连续浮点渲染时钟（Continuous Render Clock）：突破离散 tick 限制，支持 60/120/144Hz 丝滑插值
//    - 航位推算（Dead Reckoning）：网络微抖动时按最后已知航向与速度惯性向前延伸，绝不急刹卡顿
//    - 动态时钟漂移对齐（Clock Drift Adjustment）：平滑适应网络抖动
// 3. 联网碰撞（QQ 飞车非对称碰撞模型）：
//    - 自车与远端车本地碰撞检测（getCarDistance），自车即时硬分离与减速阻挡（0 延迟、绝不穿模）
//    - 后车追尾前车时，后车承担动量损失，前车速度保持（公平无穿车漏洞、不被后方顶飞）
//    - 远端车受击时叠加微量平滑弹性排斥（Visual Pushback），带接触火花扬尘、车身震动与碰撞音效
// 4. 比赛时钟（倒计时/开赛/结束）由服务器权威驱动
import { switchTrack } from "../track/geometry.js";
import { setRaceLaps } from "../config.js";
import { createCar, stepCar, finishedCarInput, getCarDistance } from "../car/physics.js";
import { getRandomLivery } from "../car/render.js";
import { updateCarLap } from "../game/race.js";
import { applyCarConfig, AI_CONFIGS, driveAI, createAIInput } from "../game/ai.js";
import { race as globalRace, simClock } from "../game/race.js";
import { conn } from "./connection.js";
import * as audio from "../game/audio.js";

const SIM_TICK_HZ = 30;                 // 服务端物理模拟与快照广播基准频率（30Hz）
const INTERPOLATION_DELAY_TICKS = 2.5;  // 连续插值延迟缓冲（~83ms，兼顾超低延迟与平滑抗抖动）
const STATE_HZ_MS = 80;                 // 自车状态上报间隔（~12Hz）

let active = false;
let myId = null;
let cars = [];
// 自动驾驶（在线对战）：自车在本地模拟，算法接管时用 driveAI 生成控制量
let netAutopilot = { on: false, driver: null };
const autoOthers = [];
export function setNetAutopilot(on, driver) {
  netAutopilot = { on: !!on, driver: driver || null };
}
let entries = [];                       // { netId, isMe, car, buf: [], pushX: 0, pushY: 0 }
let lastStateSent = 0;
let latestServerTick = -1;
let renderTick = -1;                    // 浮点连续渲染时钟（支持高刷 60/120/144Hz 连续插值）
let serverState = "countdown";
let finishReported = false;
let finishResults = null;
let lastBumpSoundTime = 0;

export const netrace = {
  get active() { return active; },
  get cars() { return cars; },
  get results() { return finishResults; },
  get state() { return serverState; },
};

function wrapAngle(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

export function startNetRace(msg, mySessionId) {
  myId = mySessionId;
  finishResults = null;
  finishReported = false;
  latestServerTick = -1;
  renderTick = -1;
  lastBumpSoundTime = 0;
  serverState = "countdown";
  globalRace.state = "countdown";
  globalRace.countdown = 3;

  switchTrack(msg.trackId);
  setRaceLaps(msg.laps || 0);

  cars = [];
  entries = [];
  msg.cars.forEach((c, idx) => {
    const cfgId = c.id.startsWith("ai:") ? c.id.slice(3) : null;
    const cfg = AI_CONFIGS.find(x => x.id === cfgId) || AI_CONFIGS.find(x => x.shortName === c.shortName) || AI_CONFIGS[0];
    const car = applyCarConfig(createCar(idx), cfg);
    car.shortName = c.shortName;
    car.name = c.nickname || c.shortName;
    car.nickname = c.nickname;
    car.isPlayer = c.id === myId;
    car.sessionId = c.id;

    // 涂装规则：
    //  · 真人玩家：同车竞技 / 同场出现同款车时分配专属随机涂装，方便区分
    //  · AI 补位车：永远使用配置里固定的车队涂装（红牛就是红牛、法拉利就是红色），
    //    否则同一场比赛里 AI 会被随机成别的车队配色，认不出是谁
    const isAICar = c.id.startsWith("ai:");
    const sameModelCount = msg.cars.filter(x => (x.shortName === c.shortName || msg.sameCar)).length;
    if (!isAICar && (sameModelCount > 1 || msg.sameCar)) {
      const livery = getRandomLivery(idx, c.number);
      car.customLivery = livery;
      car.color = c.color || livery.color;
      car.number = c.number || livery.num;
    } else {
      car.customLivery = null;
      car.color = c.color || cfg.color;
      car.number = c.number || cfg.number;
    }
    cars.push(car);
    entries.push({ netId: c.id, isMe: car.isPlayer, car, buf: [], pushX: 0, pushY: 0 });
  });

  active = true;
  return cars;
}

export function stopNetRace() {
  active = false;
  entries = [];
  finishResults = null;
  latestServerTick = -1;
  renderTick = -1;
}

function onSnapshot(msg) {
  if (!active) return;
  const prev = serverState;
  serverState = msg.state;
  globalRace.state = msg.state === "racing" ? "racing" : msg.state;
  if (msg.state === "countdown") globalRace.countdown = msg.countdown;

  // 开赛瞬间：本地圈速/总时计时起点对齐绿灯（与单机同源，统一用模拟时钟）
  if (prev === "countdown" && msg.state === "racing") {
    for (const e of entries) {
      if (e.isMe) { e.car.raceStart = simClock; e.car.lapStart = simClock; }
    }
  }

  latestServerTick = Math.max(latestServerTick, msg.tick);
  if (renderTick < 0) {
    renderTick = msg.tick - INTERPOLATION_DELAY_TICKS;
  }

  for (const sc of msg.cars) {
    const e = entries.find(x => x.netId === sc.i);
    if (!e || e.isMe) continue;
    e.buf.push({ tick: msg.tick, x: sc.x, y: sc.y, a: sc.a, v: sc.v });
    if (e.buf.length > 45) e.buf.shift();

    // 比赛进度/成绩以服务器快照中继为准
    e.car.lap = sc.lap;
    e.car.raceDist = sc.rd;
    e.car.finished = !!sc.fin;
    e.car.total = sc.tot || null;
    if (sc.best) e.car.best = sc.best;
    // 对手踏板状态（AI 由服务器模拟、玩家由 12Hz 上报中继）
    e.car.inBrake = sc.b | 0;
    e.car.inUp = !!sc.u;
    e.car.inSteer = sc.s || 0;
  }
}

// 推进连续浮点渲染时钟（带微调追赶与防漂移）
function updateInterpolationClock(dt) {
  if (latestServerTick < 0) return;
  if (renderTick < 0) {
    renderTick = latestServerTick - INTERPOLATION_DELAY_TICKS;
    return;
  }

  const targetTick = latestServerTick - INTERPOLATION_DELAY_TICKS;
  const error = targetTick - renderTick;

  let advanceRate = 1.0;
  if (Math.abs(error) > 8.0) {
    // 发生网络掉线重连或严重滞后：直接对齐目标
    renderTick = targetTick;
  } else if (error > 0.05) {
    // 渲染时钟滞后（网络恢复或新包积压）：以微加速平滑追赶（最多 +18%）
    advanceRate = 1.0 + Math.min(0.18, error * 0.12);
  } else if (error < -0.05) {
    // 渲染时钟超前（网络抖动新包迟到）：以微减速平滑等待（最多 -18%）
    advanceRate = Math.max(0.82, 1.0 + error * 0.12);
  }

  // 基于真实流逝时间 dt 连续平滑推进浮点 tick（突破 30Hz 阶梯停滞）
  renderTick += dt * SIM_TICK_HZ * advanceRate;
}

// 远端车辆高精度平滑插值 + 航位推算（Dead Reckoning）+ 碰撞视觉位移衰减
function interpolateRemoteCars(dt) {
  for (const e of entries) {
    if (e.isMe || e.buf.length === 0) continue;
    const buf = e.buf;
    const c = e.car;

    // 清理过旧快照缓存（保留到 renderTick 前 1 个 tick 即可）
    while (buf.length > 2 && buf[1].tick < renderTick - 1.0) {
      buf.shift();
    }

    if (buf.length === 1 || renderTick <= buf[0].tick) {
      const s = buf[0];
      c.x = s.x; c.y = s.y; c.angle = s.a; c.speed = s.v;
    } else if (renderTick >= buf[buf.length - 1].tick) {
      // 航位推算（Dead Reckoning）：若网络抖动短暂未收到新快照，沿最后已知航向与速度惯性平滑延伸
      const last = buf[buf.length - 1];
      const extrapDt = Math.min(0.25, Math.max(0, (renderTick - last.tick) / SIM_TICK_HZ));
      c.x = last.x + Math.cos(last.a) * last.v * extrapDt;
      c.y = last.y + Math.sin(last.a) * last.v * extrapDt;
      c.angle = last.a;
      c.speed = last.v;
    } else {
      // 区间连续双快照高精度插值（alpha 在 [0, 1] 间完全连续）
      let s0 = buf[0], s1 = buf[buf.length - 1];
      for (let i = 0; i < buf.length - 1; i++) {
        if (buf[i].tick <= renderTick && buf[i + 1].tick >= renderTick) {
          s0 = buf[i];
          s1 = buf[i + 1];
          break;
        }
      }
      const span = Math.max(0.0001, s1.tick - s0.tick);
      const alpha = Math.min(1, Math.max(0, (renderTick - s0.tick) / span));

      c.x = s0.x + (s1.x - s0.x) * alpha;
      c.y = s0.y + (s1.y - s0.y) * alpha;
      c.angle = s0.a + wrapAngle(s1.a - s0.a) * alpha;
      c.speed = s0.v + (s1.v - s0.v) * alpha;
    }

    // 叠加碰撞弹开的视觉排斥偏移，并快速指数阻尼衰减回 0
    if (e.pushX || e.pushY) {
      c.x += e.pushX;
      c.y += e.pushY;
      const decay = Math.pow(0.01, dt);
      e.pushX *= decay;
      e.pushY *= decay;
      if (Math.abs(e.pushX) < 0.001) e.pushX = 0;
      if (Math.abs(e.pushY) < 0.001) e.pushY = 0;
    }
  }
}

// QQ 飞车式客户端非对称碰撞系统：
// - 自车 100% 本地即时结算（0 延迟、0 抖动、绝不回滚）
// - 自车追尾前车时承担冲量损失减速并向后弹开，阻止穿车；前车速度保持（保护领先者）
// - 远端车被撞时施加轻量弹性视觉排斥，带火花扬尘、车身震动与碰撞音效
function resolveClientCarCollisions(meCar, fx, dt) {
  if (!meCar || serverState !== "racing") return;

  for (const e of entries) {
    if (e.isMe) continue;
    const other = e.car;
    // 完赛车辆幽灵化：不与仍在比赛的车发生碰撞（本地与服务器判定一致）
    if (meCar.finished || other.finished) continue;

    const geo = getCarDistance(meCar, other);
    // 只有包围盒重叠才判定接触
    if (geo.gapFrontRear >= 0 || geo.gapLateral >= 0) continue;

    // 两车中心连线单位向量（从 meCar 指向 other）
    const dx = other.x - meCar.x;
    const dy = other.y - meCar.y;
    const dist = Math.hypot(dx, dy) || 1;
    const nx = dx / dist;
    const ny = dy / dist;

    // 穿透量与推开量
    const pen = Math.min(-geo.gapFrontRear, -geo.gapLateral);
    const push = Math.min(0.7, Math.max(0.04, pen * 0.7));

    // 1. 本地自车位移硬分离（自车后退避开，绝不穿模）
    meCar.x -= nx * push;
    meCar.y -= ny * push;

    // 2. 远端车叠加本地弹性视觉排斥（有形受击弹动，随插值平滑恢复）
    e.pushX = (e.pushX || 0) + nx * push * 0.5;
    e.pushY = (e.pushY || 0) + ny * push * 0.5;

    // 3. 动力学冲量损耗（QQ 飞车经典规则：后车追尾吃亏减速，前车不受害）
    const isLon = Math.abs(geo.sLon) >= Math.abs(geo.dLat);
    if (isLon) {
      if (geo.sLon > 0) {
        // meCar 是后车追尾者
        if (meCar.speed > other.speed) {
          const diff = meCar.speed - other.speed;
          // 后车承受动量损失（45% 速度差），阻止强行穿车并保护前车
          meCar.speed -= diff * 0.45;
        }
      }
      // 若 meCar 是前车被追尾，本地速度严格保持，不被顶飞
    } else {
      // 侧向并排挤压擦碰：轻微摩擦阻尼
      meCar.speed *= 0.992;
    }

    // 4. 视听与打击感反馈
    const cx = (meCar.x + other.x) * 0.5;
    const cy = (meCar.y + other.y) * 0.5;
    if (fx && typeof fx.addDust === "function") {
      fx.addDust(
        cx + (Math.random() - 0.5) * 0.4,
        cy + (Math.random() - 0.5) * 0.4,
        -nx * 10 + (Math.random() - 0.5) * 4,
        -ny * 10 + (Math.random() - 0.5) * 4
      );
    }
    // 车身震动
    meCar.shake = Math.min((meCar.shake || 0) + 3.0, 7.5);

    // 碰撞音效（带 120ms 防重叠冷却）
    const now = performance.now();
    if (now - lastBumpSoundTime > 120) {
      lastBumpSoundTime = now;
      audio.bumpSound();
    }
  }
}

// 每帧：自车本地物理 + 远端高精度插值 + 本地碰撞响应 + 状态上报
// 返回自车计圈事件（"lap" | "finish" | null），供主流程提示
export function updateNetRace(dt, localInput, now, fx) {
  if (!active) return null;
  let event = null;
  const me = entries.find(e => e.isMe);

  // ---- 1. 自车：本地完整模拟（与单机同路径，0 延迟） ----
  if (me) {
    const c = me.car;
    if (serverState === "racing") {
      let ctrl;
      if (c.finished) {
        ctrl = finishedCarInput(c, null);   // 完赛巡航
      } else if (netAutopilot.on) {
        // 自动驾驶：用玩家算法接管自车（与单机同一套 driveAI 通道）
        if (!me.aiInput) me.aiInput = createAIInput();
        if (netAutopilot.driver) c.driver = netAutopilot.driver;
        autoOthers.length = 0;
        for (const e of entries) if (!e.car.finished) autoOthers.push(e.car);
        driveAI(c, me.aiInput, dt, autoOthers);
        ctrl = me.aiInput;
      } else {
        ctrl = {
          up: !!localInput.up,
          brake: localInput.brake | 0,
          steer: (localInput.right ? 1 : 0) - (localInput.left ? 1 : 0),
          left: !!localInput.left, right: !!localInput.right,
        };
      }
      stepCar(c, dt, ctrl, fx);
      const ev = updateCarLap(c, simClock);
      if (ev) event = ev;
      if (ev === "finish" && !finishReported && conn.isOpen()) {
        finishReported = true;
        conn.send({
          t: "race_finish",
          totalMs: Math.round(c.total || 0),
          bestLapMs: Math.round(c.best || 0),
          laps: Math.max(1, (c.lap || 2) - 1),
        });
      }
    }
  }

  // ---- 2. 远端车：连续浮点时间高精度插值 + 航位推算 ----
  updateInterpolationClock(dt);
  interpolateRemoteCars(dt);

  // ---- 3. QQ 飞车式客户端非对称碰撞与打击感响应 ----
  if (me) {
    resolveClientCarCollisions(me.car, fx, dt);

    // ---- 4. 状态上报 ~12Hz（带碰撞后的真实物理状态） ----
    const c = me.car;
    if (now - lastStateSent >= STATE_HZ_MS && conn.isOpen()) {
      lastStateSent = now;
      conn.send({
        t: "car_state",
        x: Math.round(c.x * 10) / 10,
        y: Math.round(c.y * 10) / 10,
        angle: Math.round(c.angle * 1000) / 1000,
        speed: Math.round(c.speed * 10) / 10,
        lap: c.lap,
        rd: Math.round(c.raceDist || 0),
        fin: c.finished ? 1 : 0,
        tot: Math.round(c.total || 0),
        best: c.best ? Math.round(c.best) : 0,
        // 踏板/方向输入：让其他玩家的算法能看到你的刹车、油门与转向状态
        b: c.inBrake | 0,
        u: c.inUp ? 1 : 0,
        s: Math.round((c.inSteer || 0) * 100) / 100,
      });
    }
  }

  return event;
}

function onRaceEnd(msg) {
  if (!active) return;
  finishResults = msg.results;
  serverState = "finished";
  globalRace.state = "finished";
  // 服务器权威排名回填（幽灵车成绩以服务器为准）
  for (const r of msg.results) {
    const e = entries.find(x => x.netId === r.sessionId || (!r.sessionId && x.car.nickname === r.nickname));
    if (e) {
      e.car.finished = r.finished;
      e.car.total = r.totalMs || e.car.total;
      if (r.bestLapMs) e.car.best = r.bestLapMs;
      e.car.lap = (r.laps || 0) + 1;
    }
  }
}

export function bindNetRaceHandlers() {
  conn.on("snapshot", onSnapshot);
  conn.on("race_end", onRaceEnd);
}

export function forfeitNetRace() {
  if (active && conn.isOpen()) {
    conn.send({ t: "surrender" });
  }
}
