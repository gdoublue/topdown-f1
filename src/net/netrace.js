// 在线竞速客户端（QQ飞车式高帧率连续插值 + 零延迟本地非对称碰撞模型）
//
// 1. 自车：完全本地 60fps 模拟（与单机同款物理），零网络延迟——手感与单机一致
//    完赛时本地计时并向服务器上报成绩（服务器做合理性校验与排名）
// 2. 远端车（人类+AI）—— 固定延时播放缓冲 + 时间戳样条插值（见 remoteSync.js）：
//    - 渲染时钟只锚在服务端快照时间戳 ts 上（均匀 tick 轴）：一次锁定时钟偏移，
//      之后按本机 dt 恒速推进，不随任何包跳变 —— 真人采样再不均匀也推不动它，
//      AI 因此保持改造前的丝滑匀速
//    - 远端统一延后 REMOTE_DELAY_MS 播放（FPS 式插值缓冲）：宁可看"过去式"残影，
//      也不让不均匀到达的坐标直接驱动画面
//    - 60Hz 上报 + 服务端收到即转发（peer_state）：把缓冲需要覆盖的"空档"从
//      66ms（33ms 采样 + 33ms 快照节拍）压到 ~17ms，播放延迟因此从 120ms 降到 80ms
//    - 发送端采样时间戳 st：真人真实采样间隔被完整保留，不被 33ms 网格量化
//    - 非均匀 Catmull-Rom 样条插值：关键帧处速度连续，不会"快一帧慢一帧"
//    - 断流速度外推（Dead Reckoning）+ 12ms 微平滑兜底，绝不急刹卡顿
// 3. 联网碰撞（QQ 飞车非对称碰撞模型）：
//    - 自车与远端车本地碰撞检测（getCarDistance），自车即时硬分离与减速阻挡（0 延迟、绝不穿模）
//    - 后车追尾前车时，后车承担动量损失，前车速度保持（公平无穿车漏洞、不被后方顶飞）
//    - 远端车受击时叠加微量平滑弹性排斥（Visual Pushback），带接触火花扬尘、车身震动与碰撞音效
// 4. 比赛时钟（倒计时/开赛/结束）由服务器权威驱动
import { switchTrack, LAP_LENGTH, isLinear, indexAtDistance } from "../track/geometry.js";
import { setRaceLaps } from "../config.js";
import { createCar, stepCar, finishedCarInput, getCarDistance } from "../car/physics.js";
import { getRandomLivery } from "../car/render.js";
import { updateCarLap } from "../game/race.js";
import { applyCarConfig, AI_CONFIGS, driveAI, createAIInput } from "../game/ai.js";
import { race as globalRace, simClock } from "../game/race.js";
import { conn } from "./connection.js";
import { sampleRemote, createClockOffset, createPlayoutClock } from "./remoteSync.js";
import * as audio from "../game/audio.js";

// 自车状态上报：60Hz 固定节拍（用累积器驱动，与渲染帧率完全解耦）。
// 上报越密，接收端需要覆盖的"采样空档"越小 → 远端播放延迟可以压得越低；
// 同时别人看你过弯也更顺。代价约 12KB/s/人（JSON 文本帧），完全可接受。
// 30fps 的客户端会自动退化成逐帧上报（33ms），不会报错。
const SAMPLE_HZ = 60;
const SAMPLE_MS = 1000 / SAMPLE_HZ;
// 远端固定播放延迟（FPS 式插值缓冲）。
// 预算 = 一个上报间隔(16.7ms) + 网络抖动余量。服务端改成"收到即转发"后，
// 预算里不再含 0~33ms 的快照节拍等待，因此从 120ms 压到 80ms：
//   实测（48 组抖动×发送频率扫描）60Hz 上报 + 抖动≤60ms 时断流外推 0%，
//   30Hz 上报（低端机）+ 抖动 40ms 时约 0.8%，靠航位推算 + 12ms 平滑吸收。
// 网络质量好的局可以试 70（再省 10ms，抖动>40ms 的玩家会开始依赖外推）。
const REMOTE_DELAY_MS = 80;
// 位姿平滑常数（秒）：只用于吸收残余抖动/修正跳变，稳态滞后 < 1m（不再是 3~4m 的追赶量）
const SMOOTH_TAU_HUMAN = 0.012;
const SMOOTH_TAU_AI = 0.010;
const SMOOTH_TAU_ANGLE = 0.014;

let active = false;
let myId = null;
let cars = [];
// 自动驾驶（在线对战）：自车在本地模拟，算法接管时用 driveAI 生成控制量
let netAutopilot = { on: false, driver: null };
const autoOthers = [];
export function setNetAutopilot(on, driver) {
  netAutopilot = { on: !!on, driver: driver || null };
}
let entries = [];                       // { netId, isMe, car, buf: [], off, pushX, pushY }
// 渲染时间轴：全部用"本地 performance.now 毫秒"表达。
// 唯一驱动源 = 服务端快照时间戳（均匀 tick），实体样本只被插值、不推动时钟。
const clock = createPlayoutClock({ delayMs: REMOTE_DELAY_MS });
// 服务器时钟 → 本机时钟：热机取最小值后【一次锁定】，再也不随包跳变
const srvClock = createClockOffset();
let sampleAcc = 0;                      // 上报节拍累积器（与帧率无关）
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
  clock.reset();
  srvClock.reset();
  sampleAcc = 0;
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
    car.isAI = isAICar;
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
    entries.push({
      netId: c.id, isMe: car.isPlayer, car,
      buf: [],            // 采样缓冲：{ t(本地ms), x, y, a, v }
      off: createClockOffset(),   // 该车"发送端时钟 → 本机时钟"偏移（热机后锁定）
      pushX: 0, pushY: 0,
      synced: false,
    });
  });

  active = true;
  return cars;
}

export function stopNetRace() {
  active = false;
  entries = [];
  finishResults = null;
  clock.reset();
  srvClock.reset();
}

// 写入一条已定位到"本机时钟毫秒"的远端样本。
// 同一时刻的重复样本（服务端多 tick 转发同一状态 / 即时中继与快照重叠）只更新末样本，
// 不制造零宽区间，避免插值段长为 0 时速度算出无穷大。
function pushSample(e, t, x, y, a, v) {
  const buf = e.buf;
  const last = buf[buf.length - 1];
  if (last && t <= last.t + 0.5) {
    last.x = x; last.y = y; last.a = a; last.v = v;
    return last.t;
  }
  buf.push({ t, x, y, a, v });
  if (buf.length > 60) buf.shift();
  return t;
}

// 真人样本：st 来自对方本机帧，用它自己的锁定偏移换算到本机时钟。
// 只用于给这辆车定位，永远不参与渲染时钟推进（时钟只认服务器快照 ts）。
function pushHumanSample(e, st, x, y, a, v, recvAt) {
  const stx = st != null ? st : recvAt;   // 老客户端没有 st 时退化为接收时刻
  return pushSample(e, stx + e.off.observe(recvAt, stx), x, y, a, v);
}

// 玩家采样即时中继（服务端收到即转发，不等 30Hz 快照节拍）。
// 只补位姿样本；圈数/成绩/完赛状态仍以权威快照为准，两套数据不打架。
function onPeerState(msg) {
  if (!active) return;
  const e = entries.find(x => x.netId === msg.i);
  if (!e || e.isMe) return;
  const st = (typeof msg.st === "number" && msg.st > 0) ? msg.st : null;
  pushHumanSample(e, st, msg.x, msg.y, msg.a, msg.v, performance.now());
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

  const recvAt = performance.now();

  // ---- 均匀参考轴：服务端快照时间戳 ts ----
  // ts 就是服务器 tick 逻辑时钟（每 tick 严格 +33.3ms），AI 样本的 st 与它同源。
  // 用最小 (到达时刻 − 服务器时刻) 一次锁定时钟偏移（= 本机与服务器的时钟差 + 最小链路延迟）：
  // 网络抖动只会让某个观测值变大，取最小值天然把它滤掉，偏移不会随包跳变。
  // 这一步是"AI 丝滑"的根：时钟只认这条均匀轴，不认任何一辆车的采样节奏。
  const hasTs = typeof msg.ts === "number" && msg.ts > 0;
  const srvOff = hasTs ? srvClock.observe(recvAt, msg.ts) : 0;
  if (hasTs) clock.noteRef(msg.ts + srvOff);
  let legacyRef = -1;   // 老服务端（快照无 ts）的退化参考

  for (const sc of msg.cars) {
    const e = entries.find(x => x.netId === sc.i);
    if (!e || e.isMe) continue;

    // ---- 样本时刻：统一换算成"本机单调时钟毫秒"，只用于定位样本，不推进时钟 ----
    //  · AI：诞生于服务器 tick 网格，直接投到参考轴上（与渲染时钟同源，绝对均匀）
    //  · 真人：诞生于对方本机某一帧，用"该实体的最小延迟"换算（st 的真实间隔被保留）
    const isAI = sc.i.startsWith("ai:");
    const st = (typeof sc.st === "number" && sc.st > 0) ? sc.st : null;

    if (isAI && hasTs && st != null) {
      pushSample(e, st + srvOff, sc.x, sc.y, sc.a, sc.v);
    } else {
      const t = pushHumanSample(e, st, sc.x, sc.y, sc.a, sc.v, recvAt);
      // 没有服务端时间戳时，AI 的均匀样本仍可当参考轴（真人样本绝不参与）
      if (!hasTs && isAI && st != null && t > legacyRef) legacyRef = t;
    }

    // 比赛进度/成绩以服务器快照中继为准
    e.car.lap = sc.lap;
    e.car.raceDist = sc.rd;
    e.car.finished = !!sc.fin;
    e.car.total = sc.tot || null;
    if (sc.best) e.car.best = sc.best;
    // 对手踏板状态（AI 由服务器模拟、玩家由 60Hz 上报 + 30Hz 快照中继）
    e.car.inBrake = sc.b | 0;
    e.car.inUp = !!sc.u;
    e.car.inSteer = sc.s || 0;

    // 远端车没有本地物理，nearIdx / trackS 会永远停在发车格初值：
    // 用服务器上报的里程反推，玩家算法里的 o.nearIdx / o.trackS 才有意义
    // （evaluateTrafficAndOvertake 也是靠 o.nearIdx 判断前车的）
    const rd = Number(sc.rd);
    if (Number.isFinite(rd)) {
      const lapLen = Math.max(1, LAP_LENGTH || 5000);
      const lapNo = Math.max(1, Number(sc.lap) || 1);
      const s = isLinear
        ? Math.max(0, Math.min(lapLen, rd))
        : (((rd - (lapNo - 1) * lapLen) % lapLen) + lapLen) % lapLen;
      e.car.trackS = s;
      // 按 cumDist 精确换算（采样点不是按米均匀的，round(s / DS) 误差可达一倍）
      e.car.nearIdx = indexAtDistance(s);
      e.car.idx = e.car.nearIdx;
    }
  }

  if (legacyRef > 0) clock.noteRef(legacyRef);
}



// 远端车辆：在"最新时刻 − REMOTE_DELAY_MS"处采样（固定延时缓冲），
// 用 Catmull-Rom 样条（C1 连续，关键帧处速度无突变）+ 断流外推 + 微平滑重建位姿。
//
// 为什么不用线性插值：真人样本间隔并不严格相等（33~79ms），线性插值会让速度
// 在每个关键帧处跳变 —— 看起来就是"一快一慢"的抽搐。样条用相邻样本差分求切线，
// 整条曲线速度连续；再叠加极小的指数平滑兜住残余抖动。
function interpolateRemoteCars(dt) {
  for (const e of entries) {
    if (e.isMe || e.buf.length === 0 || e.car.retired) continue;
    const buf = e.buf;
    const c = e.car;

    // 清理已经播放过去的旧样本（保留 1 个历史点用于求切线）
    while (buf.length > 3 && buf[1].t < clock.renderMs - 80) buf.shift();

    // ---- 1. 按渲染时间轴解算"目标位姿"（样条插值 / 断流外推）----
    const res = sampleRemote(buf, clock.renderMs, 250);
    if (!res) continue;
    const tx = res.x, ty = res.y, ta = res.a, tv = res.v;

    // ---- 2. 微平滑：只兜残余抖动/外推回收时的跳变（12ms 时间常数，稳态滞后 < 1m）----
    if (!e.synced) {
      e.synced = true;
      c.x = tx; c.y = ty; c.angle = ta; c.speed = tv;
    } else {
      const tauPos = e.netId.startsWith("ai:") ? SMOOTH_TAU_AI : SMOOTH_TAU_HUMAN;
      const kPos = 1 - Math.exp(-dt / tauPos);
      const kAng = 1 - Math.exp(-dt / SMOOTH_TAU_ANGLE);
      const kSpd = 1 - Math.exp(-dt / 0.08);
      c.x += (tx - c.x) * kPos;
      c.y += (ty - c.y) * kPos;
      c.angle += wrapAngle(ta - c.angle) * kAng;
      c.speed += (tv - c.speed) * kSpd;
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

// QQ 飞车式客户端非对称碰撞系统
//
// 【坐标权威】不存在"以被撞方为准"或"以撞人方为准"——而是【各以自己为准】：
//   · 自己的车：100% 本地权威，绝不被远端坐标改写（零延迟、0 抖动、绝不回滚）
//   · 远处的车：它的权威轨迹由它自己算，你只在【你自己的屏幕上】叠加一个视觉排斥
//     偏移（pushX/pushY，指数衰减回 0），绝不会回写、也不会发给服务器
//   · 服务器不裁决真人之间的碰撞（幽灵竞速）：只有 AI 对真人做单向防穿（AI 让步）。
//     这样任何人都无法靠"我这边判你撞我"去改变别人的比赛结果。
//
// 【动量权威】判定用两车平均航向（getCarDistance），sLon > 0 表示对方在我前方：
//   · 我在后面（追尾方）→ 我承担 45% 速度差损失并被向后硬分离，绝不穿模
//   · 我在前面（被追尾）→ 速度严格保持，不被后车顶飞
//   · 侧面并排 → 双方对称的轻微摩擦
//   注意：双方看到的都是对方 ~70ms 前的坐标，并排/斜向混战时可能两边都判自己"在后"，
//   于是双方各自减速（双罚）。压缩播放延迟就是在压缩这种误判窗口。
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
  clock.update(dt);
  interpolateRemoteCars(dt);

  // ---- 3. QQ 飞车式客户端非对称碰撞与打击感响应 ----
  if (me) {
    resolveClientCarCollisions(me.car, fx, dt);

    // ---- 4. 状态上报：固定 33.3ms 节拍（累积器驱动，30/60/144fps 的间隔完全一致）----
    // 同时上报采样时刻 st（本机单调时钟），接收端据此重建真实时间轴，
    // 这样"帧率不同的玩家"在别人眼里也是匀速运动。
    const c = me.car;
    sampleAcc += dt * 1000;
    if (sampleAcc >= SAMPLE_MS) {
      sampleAcc -= SAMPLE_MS;
      if (sampleAcc > SAMPLE_MS) sampleAcc = 0;   // 长卡顿后不要补发一串旧状态
      if (!conn.isOpen()) return event;
      conn.send({
        t: "car_state",
        // 采样时刻保留 2 位小数：位置是连续量，时间戳只精确到 1ms 会引入
        // ±0.5ms 的采样时刻误差（≈3% 的间隔失真），别人看来就是快慢不均
        st: Math.round(now * 100) / 100,
        x: Math.round(c.x * 100) / 100,
        y: Math.round(c.y * 100) / 100,
        angle: Math.round(c.angle * 10000) / 10000,
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

// 有车友退出房间/认输：把他的车从本场比赛抹掉（自己这辆车由 leaveOnlineRoom 统一处理）
function onPlayerForfeit(msg) {
  if (!active) return;
  const e = entries.find(x => x.netId === msg.sid);
  if (!e || e.isMe) return;
  e.car.retired = true;
  e.car.finished = true;      // 不再参与本地碰撞判定
  e.car.total = 9999999;      // 排名沉底
  e.buf.length = 0;
}

export function bindNetRaceHandlers() {
  conn.on("snapshot", onSnapshot);
  conn.on("peer_state", onPeerState);
  conn.on("race_end", onRaceEnd);
  conn.on("player_forfeit", onPlayerForfeit);
}

export function forfeitNetRace() {
  if (active && conn.isOpen()) {
    conn.send({ t: "surrender" });
  }
}
