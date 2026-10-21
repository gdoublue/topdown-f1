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
import { sampleRemote, createClockOffset, createPlayoutClock, createDelayController } from "./remoteSync.js";
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
// 80ms 是**标称值**：链路干净时恒定不变；一旦有对端的缓冲真的被掏空（单包尖峰 / 持续变差），
// 自适应控制器会把播放延迟最多垫到 150ms，链路恢复后再慢慢退回 80ms。
const REMOTE_DELAY_MS = 80;
// 自适应延迟上限：链路真的差时最多退到 150ms（实测再往上收益递减、滞后反而明显）
const REMOTE_DELAY_MAX_MS = 150;
// 位姿平滑常数（秒）：只用于吸收残余抖动/修正跳变。
// 人类对端放宽到 25ms（约 1.2m 滞后）：不可控的部分（对方主线程卡、包到达不齐）
// 只能靠这一层吃掉，宁可整体"略旧 1m"，也不要高频抽搐。
const SMOOTH_TAU_HUMAN = 0.025;
const SMOOTH_TAU_AI = 0.010;
const SMOOTH_TAU_ANGLE = 0.030;
// 失联分档（毫秒）：< ghost 正常；ghost ~ remove 半透明且不再参与碰撞；> remove 直接隐藏。
// 依据：播放缓冲 80ms + 外推 250ms 之后已经彻底定格，800ms 起就没有"还在跑"的观感了。
const STALE_GHOST_MS = 800;
const STALE_REMOVE_MS = 3000;
// 自适应延迟的判据：只有"采样间隔正常"的对端断流才说明缓冲不够深；
// 2fps 的对端天生每帧都断流，那是他自己慢，不该把全场延迟顶到上限。
const STARVE_MAX_GAP_MS = 120;
// 每车独立延迟的收敛速度（毫秒/秒）：加得比减得快 —— 先保住平滑，再慢慢收回滞后
const EXTRA_RISE_MS_PER_SEC = 150;
const EXTRA_FALL_MS_PER_SEC = 60;
// 外推回弹的误差吸收时间常数（秒）：≈ cl_smooth
const RECOVER_TAU = 0.07;
// 采样缓冲保留的历史时长（毫秒）：要覆盖每车额外延迟的动态调整（最多 450ms）
// 240ms 不够：额外延迟回落 / 偏移平移时采样点会小幅前移，一旦越过 buf[0]，
// sampleRemote 只能返回"最老的一个样本"→ 远端车瞬间倒回去一段再冲上来。
const HISTORY_MS = 700;
// 每车播放点的"安全边距"死区（毫秒）—— 这是消除抽搐/闪烁的关键：
//   lead = 播放点 − 最新样本时刻。目标是把 lead 稳定压在这个区间里（始终在样本后面），
//   这样永远走样条插值，不会碰到外推（外推会冻结车头角度，还会让 recX 回弹反复注入）。
//   lead > −NEAR → 往后垫延迟；lead < −FAR → 才允许慢慢收回；中间【什么都不做】。
// 没有这个死区就是开关控制：播放点来回横跳，画面表现为高频抽搐。
const LEAD_NEAR_MS = 30;
const LEAD_FAR_MS = 110;
const EXTRA_RISE_FAST_MS_PER_SEC = 240;   // 补深速率（比常规 150 快，但仍是连续变化，不是跳变）
// 每车额外延迟上限：300ms 已经能覆盖"6~10fps 的对端 + 链路晚到"，
// 再往上（原来 450）只会让这辆车永久落后、并且掩盖真正的时间轴故障。
const EXTRA_MAX_MS = 300;

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
// 自适应播放延迟：用"缓冲是否见底"做反馈（见 remoteSync.createDelayController）。
// 不用"到达时刻 − 采样时刻"估抖动：那个差值里混着浏览器派发消息的主线程调度延迟，
// 在干净的本机链路上也能测出 25~56ms 的假抖动，会把延迟白白顶到 100ms 以上。
const delayCtl = createDelayController({ baseMs: REMOTE_DELAY_MS, maxMs: REMOTE_DELAY_MAX_MS });
let sampleAcc = 0;                      // 上报节拍累积器（与帧率无关）
let lastSendSt = 0;                     // 上次上报用的模拟时刻（同一时刻不重复发）
let lastSrvOff = null;                  // 上一次用到的服务器时钟偏移（变化时必须平移参考轴）
// 远端车位姿跳变记账：{ id, d(米), dt, extra, delay, extrap, buf, play }
// 用 __gp.net.jumps 看"瞬移"到底有多大、发生在什么缓冲状态下。
const jumps = [];
const JUMP_LOG_MAX = 24;
let netStarved = false;                 // 上一帧是否有"健康对端"的缓冲被掏空（自适应延迟输入）
let serverState = "countdown";
let finishReported = false;
let finishResults = null;
let lastBumpSoundTime = 0;

export const netrace = {
  get active() { return active; },
  get cars() { return cars; },
  get results() { return finishResults; },
  get state() { return serverState; },
  // 远端车位姿跳变记账（最近 24 条）：d=跳变米数，play=渲染点相对最老样本的毫秒数，
  // extrap=当时是否在断流外推，extra/delay=该车额外延迟与全局目标延迟
  get jumps() { return jumps.slice(); },
  // 网络诊断快照（控制台 / 现场排查用）：
  //   delayMs   当前目标播放延迟（80 = 标称，抖动大时最多 150）
  //   offsetMs  已经实际生效的额外延迟
  //   starved   上一帧是否有健康对端的缓冲被掏空
  //   cars      每个远端车的新鲜度与失联档位（0 正常 / 1 半透明 / 2 已隐藏）
  get stats() {
    return {
      delayMs: Math.round(clock.delayMs),
      offsetMs: Math.round(clock.offsetMs),
      starved: netStarved,
      cars: entries.filter(e => !e.isMe).map(e => ({
        id: e.netId,
        age: Math.round(e.car.netAge || 0),
        ghost: e.car.ghostHidden ? 2 : (e.car.ghostAlpha < 1 ? 1 : 0),
        gap: Math.round(e.gapEwma || 0),      // 该对端的采样间隔
        extra: Math.round(e.extraMs || 0),    // 给它单独加的延迟
        lead: Math.round(e.leadMs || 0),      // 播放点相对它最新样本的领先量（>0 = 在替它直线外推）
        extrap: e.extrap ? 1 : 0,             // 上一帧是否正在外推
      })),
    };
  },
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
  delayCtl.reset();
  clock.setDelay(REMOTE_DELAY_MS);
  sampleAcc = 0;
  lastSendSt = 0;
  lastSrvOff = null;
  jumps.length = 0;
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
    // 远端车失联分档的视觉状态（1 / false = 正常；由 interpolateRemoteCars 每帧刷新）
    car.ghostAlpha = 1;
    car.ghostHidden = false;
    car.netAge = 0;
    cars.push(car);
    entries.push({
      netId: c.id, isMe: car.isPlayer, car,
      buf: [],            // 采样缓冲：{ t(本地ms), x, y, a, v }
      off: createClockOffset(),   // 该车"发送端时钟 → 本机时钟"偏移（热机后锁定）
      pushX: 0, pushY: 0,
      synced: false,
      lastFreshAt: 0,     // 最近一次"样本时间戳真的前进了"的到达时刻（本机 ms）
      lastGapMs: 0,       // 该对端的采样间隔（判断是"慢"还是"抖"）
      gapEwma: 0,         // 采样间隔的平滑值：决定这辆车要不要额外往后放
      extraMs: 0,         // 该车独有的额外播放延迟（只影响它自己，不影响别人）
      recX: 0, recY: 0,   // 外推回弹的衰减偏移（cl_smooth 式误差吸收）
      wasExtrap: false,
      jumpHold: 0,        // 跳变护栏连续生效的帧数（超过 40 帧就放行，避免永久卡在旧位置）
      leadMs: 0,          // 播放点相对最新样本的领先量（诊断用）
      leadEwma: 0,        // 领先量的平滑值（缓冲深度控制器只看它，避免被 16.7ms 阶梯带抖）
      extrap: false,      // 上一帧是否在直线外推（诊断用）
      extrapMs: 0,        // 当前这段连续外推已经持续多久（决定要不要做回弹补偿）
    });
  });

  active = true;
  return cars;
}

export function stopNetRace() {
  active = false;
  entries = [];
  finishResults = null;
  lastSrvOff = null;
  clock.reset();
  srvClock.reset();
}

// 写入一条已定位到"本机时钟毫秒"的远端样本。
// 同一时刻的重复样本（服务端多 tick 转发同一状态 / 即时中继与快照重叠）只更新末样本，
// 不制造零宽区间，避免插值段长为 0 时速度算出无穷大。
function pushSample(e, t, x, y, a, v, recvAt) {
  const buf = e.buf;
  let last = buf[buf.length - 1];
  if (last) {
    if (t < last.t - 400) {
      // 时间轴断层：时间戳一下倒退 0.4 秒以上，说明这个实体的时间轴已经不可信
      // （发送端卡死补推、页面冻结后恢复、或偏移被重锁）。此时绝不能把新旧样本硬拼，
      // 否则这辆车会长期"偏老 → 一直被外推"（实测：lead 3705ms、extra 顶满、extrap 恒为 1）。
      // 直接清空重来，几百毫秒内自动恢复。
      resetEntityTimeline(e);
      last = null;
    } else if (t <= last.t - 0.5) {
      // 更旧的样本必须丢弃，不能"合并"：旧写法会把迟到一点的旧坐标覆盖到末样本上，
      // 时间戳却不动 —— 一帧反向微跳（约 1m）就是这么来的。
      return last.t;
    } else if (t <= last.t + 0.5) {
      // 同一时刻的重复样本：只刷新坐标
      last.x = x; last.y = y; last.a = a; last.v = v;
      return last.t;
    } else if (t > last.t + 800) {
      // 时间戳一下前进 0.8 秒以上：这段空档里它其实一直在动，保留旧样本会让接收端
      // 在这 0.8 秒里"以 1/50 的速度爬"。清掉旧样本，让它直接滑到新位置（有跳变护栏兜着）。
      buf.length = 0;
      last = null;
    }
  }
  const gap = last ? t - last.t : 0;
  e.lastGapMs = gap;                     // 该对端的采样间隔（用于区分"慢"和"抖"）
  if (gap > 0) e.gapEwma = e.gapEwma ? e.gapEwma * 0.75 + gap * 0.25 : gap;
  buf.push({ t, x, y, a, v });
  if (buf.length > 60) buf.shift();
  // 新鲜度只认"时间戳真的前进了"。服务端会把停更的旧状态按 30Hz 重复下发，
  // 若用到达时刻判断，掉线玩家的车永远不会被判定为失联。
  e.lastFreshAt = recvAt != null ? recvAt : performance.now();
  return t;
}

// 合流后的位姿下行（服务端 16ms 打成一个包）：8 人房从 3360 次/秒发送降到 ~60 次/秒。
// 每条记录 [sid, st, x, y, a, v]，入缓冲路径与 peer_state 完全一致。
function onPeersBundle(msg) {
  if (!active || !Array.isArray(msg.c)) return;
  const recvAt = performance.now();
  for (let k = 0; k < msg.c.length; k++) {
    const row = msg.c[k];
    if (!row) continue;
    const e = entries.find(x => x.netId === row[0]);
    if (!e || e.isMe) continue;
    const st = (typeof row[1] === "number" && row[1] > 0) ? row[1] : null;
    pushHumanSample(e, st, row[2], row[3], row[4], row[5], recvAt);
  }
}

// 时钟偏移一变，已经缓冲的样本必须跟着一起平移 —— 这条不变量是整个平滑的前提：
// 样本时刻是用"当时的偏移"算出来的，偏移变了只影响新样本，就等于把新旧样本
// 塞到两条不同的时间轴上。新样本会比旧的还早 → 被 pushSample 当旧样本丢掉 →
// 那辆车先"定格"几十毫秒再突然接上，看起来就是抽搐。
function rebaseBuffer(buf, deltaMs) {
  if (!deltaMs) return;
  for (let i = 0; i < buf.length; i++) buf[i].t += deltaMs;
}

// 该实体的时间轴作废，从头来：清样本、清控制量、允许下一帧直接吸附。
function resetEntityTimeline(e) {
  e.buf.length = 0;
  e.synced = false;
  e.extraMs = 0;
  e.leadEwma = 0;
  e.leadLatched = 0;
  e.extrapMs = 0;
  e.recX = 0;
  e.recY = 0;
  e.wasExtrap = false;
  if (e.off && typeof e.off.reset === "function") e.off.reset();
}

// 真人样本：st 来自对方本机帧，用它自己的锁定偏移换算到本机时钟。
// 只用于给这辆车定位，永远不参与渲染时钟推进（时钟只认服务器快照 ts）。
function pushHumanSample(e, st, x, y, a, v, recvAt) {
  const stx = st != null ? st : recvAt;   // 老客户端没有 st 时退化为接收时刻
  const prevOff = e.off.value;
  const off = e.off.observe(recvAt, stx);
  if (prevOff != null && off !== prevOff) {
    const d = off - prevOff;
    if (Math.abs(d) > 500) {
      // 偏移一次跳半秒以上 = 对方的时钟/时间轴换过（页面冻结恢复、长时间卡死后补推）：
      // 已缓冲的样本一律作废，重新锁，别拿旧样本硬拼新时间轴。
      resetEntityTimeline(e);
    } else {
      rebaseBuffer(e.buf, d);
      if (e.leadEwma) e.leadEwma += d;   // 样本整体平移了，控制量跟着平移
    }
  }
  return pushSample(e, stx + off, x, y, a, v, recvAt);
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

// 比赛状态只允许单向前进：快照现在走 DataChannel（无序、不重传），
// 迟到的旧快照若把状态从 racing 拽回 countdown，那一帧 stepCar 会被跳过
// （自车冻一帧再弹出去），屏幕上还会再闪一次倒计时。
const STATE_RANK = { countdown: 0, racing: 1, finished: 2 };
const stateRank = (s) => STATE_RANK[s] ?? -1;

function onSnapshot(msg) {
  if (!active) return;
  const prev = serverState;
  if (stateRank(msg.state) >= stateRank(serverState)) {
    serverState = msg.state;
    globalRace.state = msg.state === "racing" ? "racing" : msg.state;
    if (msg.state === "countdown") globalRace.countdown = msg.countdown;
  }

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
  if (hasTs) {
    // 偏移一变（热机收敛 / WS→DataChannel 接管 / 重锁），参考轴必须同步平移：
    // 见 remoteSync.createPlayoutClock.shiftRef 的注释——否则播放点会永久跑在样本前面。
    // 单次平移量封顶 180ms：|err| > 300 时 playout 时钟会"直接对齐"（跳一下），
    // 分 2~3 个快照平移完既能消掉偏差，也永远落不到那条硬对齐分支上。
    // 参考轴和已缓冲样本必须用【同一个】平移量，否则缓冲内部的时间轴会被撕开。
    if (lastSrvOff != null && srvOff !== lastSrvOff) {
      const dOff = Math.max(-180, Math.min(180, srvOff - lastSrvOff));
      clock.shiftRef(dOff);
      for (const e of entries) rebaseBuffer(e.buf, dOff);
    }
    lastSrvOff = srvOff;
    clock.noteRef(msg.ts + srvOff);
  }
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
      pushSample(e, st + srvOff, sc.x, sc.y, sc.a, sc.v, recvAt);
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
  const nowMs = performance.now();
  // 采样时间轴：含自适应延迟（好链路 = 80ms，抖动大时自动加深）
  const playMs = clock.playMs;
  netStarved = false;

  // ---- 失联分档：正常 → 半透明（且退出碰撞）→ 隐藏 ----
  // 判据是"样本时间戳停止前进"的时长（e.lastFreshAt），不是收到包的时刻：
  // 服务端会把停更的旧状态按 30Hz 重复下发，用到达时刻判断永远掉不了档。
  for (const e of entries) {
    if (e.isMe || e.car.retired) continue;
    const age = e.lastFreshAt ? nowMs - e.lastFreshAt : 0;
    e.car.netAge = age;
    if (age > STALE_REMOVE_MS) {
      e.car.ghostHidden = true;
      e.car.ghostAlpha = 0;
    } else {
      e.car.ghostHidden = false;
      e.car.ghostAlpha = age <= STALE_GHOST_MS
        ? 1
        : Math.max(0.35, 1 - ((age - STALE_GHOST_MS) / (STALE_REMOVE_MS - STALE_GHOST_MS)) * 0.65);
    }
  }

  for (const e of entries) {
    if (e.isMe || e.buf.length === 0 || e.car.retired) continue;
    const buf = e.buf;
    const c = e.car;

    // ---- 0. 每车缓冲深度：全局只剩这一个旋钮（e.extraMs），带死区 + 快加慢减 ----
    // 为什么只留一个：播放点同时被"采样间隔补深""领先量修正""回弹补偿"三条独立回路
    // 拉扯时，任何一条动一下画面就抖一下（前几版就是在几个回路之间来回横跳）。
    // 现在只有 extraMs 在动，而且只在死区外才动。
    //
    // (a) 下限：缓冲至少要覆盖这个对端的一个采样间隔（慢对端；只抬不压）
    const gap = e.gapEwma || 16.7;
    const floor = Math.min(EXTRA_MAX_MS, Math.max(0, gap * 1.25 - Math.max(30, clock.delayMs - 20)));
    if (e.extraMs < floor) {
      e.extraMs = Math.min(floor, e.extraMs + EXTRA_RISE_MS_PER_SEC * dt);
    }
    let entryPlayMs = playMs - e.extraMs;

    // 清理已经播放过去的旧样本。
    // 留 700ms 历史（HISTORY_MS）：额外延迟在动态调整、偏移平移时采样点会前移，
    // 历史太短会让采样点瞬间落到 buf[0] 之前 —— sampleRemote 只能返回最老的样本，
    // 远端车就会"倒退一段再冲回来"。
    while (buf.length > 3 && buf[1].t < entryPlayMs - HISTORY_MS) buf.shift();

    // (b) 领先量死区：lead = 播放点 − 最新样本时刻。
    //   lead > 0     → 已经在替他直线外推（位置跑到前面、车头不转）
    //   lead ≈ −0    → 压在样本边界上，插值/外推来回切 → 抽搐
    // 目标区间 [−LEAD_FAR, −LEAD_NEAR]：始终待在最新样本后面。
    // 用 EWMA 抹掉 60Hz 样本 16.7ms 的阶梯，否则控制量自己就在抖。
    const newestT = buf[buf.length - 1].t;
    if ((c.netAge || 0) < STALE_GHOST_MS) {
      const lead0 = entryPlayMs - newestT;
      e.leadEwma = e.leadEwma ? e.leadEwma * 0.88 + lead0 * 0.12 : lead0;

      // (c) 兜底：领先量长期大于 0.5 秒 = 这个实体样本的时间轴已经不可用
      // （发送端卡死补推 / 时钟被重锁）。继续加大延迟只会让它永久外推，
      // 实测就是 lead 3705ms + extra 顶满 + extrap 恒为 1 的抽搐状态。
      // 直接重置这个实体重来，几百毫秒内恢复，而不是整局都错位。
      if (lead0 > 500) {
        e.leadLatched = (e.leadLatched || 0) + dt * 1000;
        if (e.leadLatched > 500) {
          resetEntityTimeline(e);
          continue;
        }
      } else {
        e.leadLatched = 0;
      }

      if (e.leadEwma > -LEAD_NEAR_MS) {
        e.extraMs = Math.min(EXTRA_MAX_MS, e.extraMs
          + Math.min(e.leadEwma + LEAD_NEAR_MS, EXTRA_RISE_FAST_MS_PER_SEC * dt));
      } else if (e.leadEwma < -LEAD_FAR_MS && e.extraMs > floor) {
        // 只回落到 floor，绝不与 (a) 对着干（否则两个回路就在死区边上互相推）
        e.extraMs = Math.max(floor, e.extraMs - EXTRA_FALL_MS_PER_SEC * dt);
      }
      entryPlayMs = playMs - e.extraMs;
    }

    // ---- 1. 按渲染时间轴解算"目标位姿"（样条插值 / 断流外推）----
    // 外推上限随"对端安静了多久"连续放开（30ms + age，最多 250ms）：
    // 刚发的包还在路上 → 只允许几十毫秒的直冲（一两米，看不出方向错）；
    // 对端真的安静了（掉帧/丢包）→ 逐步放开航位推算，避免急刹定格。
    // 注意必须是连续函数：早先写成 age<150?40:250 的硬切换，安静到 150ms 那一帧
    // 目标点会一次性前跳 8 米 —— 那也是一次"闪"。
    const silenceMs = Math.max(0, c.netAge || 0);
    const res = sampleRemote(buf, entryPlayMs, Math.min(250, 30 + silenceMs));
    if (!res) continue;

    // 自适应延迟的反馈信号：这一帧缓冲区是否真的被掏空（正在直线外推）。
    // 只统计"采样间隔正常、且没有失联"的对端 —— 慢对端天生每帧见底，不该带偏全场延迟。
    const starved = res.extrapolated && (entryPlayMs - newestT) > 8
      && e.lastGapMs < STARVE_MAX_GAP_MS
      && (c.netAge || 0) < STALE_GHOST_MS;
    if (starved) netStarved = true;
    e.leadMs = entryPlayMs - newestT;
    e.extrap = res.extrapolated;
    let tx = res.x, ty = res.y;
    const ta = res.a, tv = res.v;

    // ---- 位姿跳变护栏 ----
    // 真出现"一帧几十米"的位移时（缓冲被重排、时间轴重锁、样本乱序），不要直接瞬移：
    // 按物理上可能的上限逼近，并在 __gp.net.jumps 里记账，便于定位真正的根因。
    // 失联很久后重新出现（netAge 大）属于合法重定位，直接放行。
    if (e.synced && (c.netAge || 0) < STALE_GHOST_MS) {
      const dxT = tx - c.x, dyT = ty - c.y;
      const dT = Math.hypot(dxT, dyT);
      const stepMax = Math.min(24, (Math.abs(tv) + Math.abs(c.speed)) * dt + 8);
      if (dT > stepMax) {
        if (e.jumpHold <= 40) {
          e.jumpHold++;
          const k = stepMax / dT;
          tx = c.x + dxT * k;
          ty = c.y + dyT * k;
          if (jumps.length >= JUMP_LOG_MAX) jumps.shift();
          jumps.push({
            id: e.netId,
            d: Math.round(dT),
            dt: Math.round(dt * 1000),
            extra: Math.round(e.extraMs),
            delay: Math.round(clock.delayMs),
            extrap: res.extrapolated ? 1 : 0,
            buf: buf.length,
            play: Math.round(entryPlayMs - buf[0].t),
          });
        }
      } else {
        e.jumpHold = 0;
      }
    } else {
      e.jumpHold = 0;
    }

    // ---- 2. 外推结束：把"视觉位置 − 真实目标"的偏差记成衰减偏移 ----
    // 不再让样条一帧内把漂移补齐（那就是"弹一下"），而是在 ~70ms 内吸收掉。
    // 只有"确实外推了一段时间"（>30ms）才需要补偿：
    // 插值/外推在边界上来回切时，原来每两帧就往 recX 里注入一次误差（上限 25m！），
    // 视觉上就是车身在真实轨迹附近高频抖动、一闪一闪 —— 现在短促切换不补偿。
    if (res.extrapolated) e.extrapMs = (e.extrapMs || 0) + dt * 1000;
    if (e.wasExtrap && !res.extrapolated) {
      if (e.extrapMs > 30) {
        e.recX = Math.max(-8, Math.min(8, e.recX + (c.x - tx)));
        e.recY = Math.max(-8, Math.min(8, e.recY + (c.y - ty)));
      }
      e.extrapMs = 0;
    }
    e.wasExtrap = res.extrapolated;

    // ---- 3. 微平滑：只兜残余抖动（12ms 时间常数，稳态滞后 < 1m）----
    if (!e.synced) {
      e.synced = true;
      c.x = tx; c.y = ty; c.angle = ta; c.speed = tv;
    } else {
      if (e.recX || e.recY) {
        const decay = Math.exp(-dt / RECOVER_TAU);
        e.recX *= decay; e.recY *= decay;
        if (Math.abs(e.recX) < 0.01) e.recX = 0;
        if (Math.abs(e.recY) < 0.01) e.recY = 0;
      }
      const sx = tx + e.recX, sy = ty + e.recY;
      const tauPos = e.netId.startsWith("ai:") ? SMOOTH_TAU_AI : SMOOTH_TAU_HUMAN;
      const kPos = 1 - Math.exp(-dt / tauPos);
      const kAng = 1 - Math.exp(-dt / SMOOTH_TAU_ANGLE);
      const kSpd = 1 - Math.exp(-dt / 0.08);
      c.x += (sx - c.x) * kPos;
      c.y += (sy - c.y) * kPos;
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
    // 失联车辆不再参与碰撞：他早就不在比赛里了，撞上一辆"定格"的幽灵车会让自车凭空减速
    if (other.ghostHidden || (other.netAge || 0) > STALE_GHOST_MS) continue;

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
    const now2 = performance.now();

    // 1. 本地自车位移硬分离（自车后退避开，绝不穿模）
    meCar.x -= nx * push;
    meCar.y -= ny * push;

    // 2. 远端车叠加本地弹性视觉排斥（有形受击弹动，随插值平滑恢复）
    e.pushX = (e.pushX || 0) + nx * push * 0.5;
    e.pushY = (e.pushY || 0) + ny * push * 0.5;

    // 3. 动力学冲量损耗（后车追尾吃亏减速，前车不受害）
    //
    // 【软化】原来是无条件 `speed -= diff * 0.45`，有三个不公平：
    //   a. 连续贴合时每帧都罚一次（60Hz = 每秒罚 60 次）；
    //   b. 撞的是"对方 80~300ms 前的残影"，追尾判定本身含误差；
    //   c. 深穿透和轻轻蹭一下罚得一样重。
    // 现在：按穿透深度缩放、每次接触事件最多罚一次（150ms 冷却）、
    //       并且对"明显滞后"的残影只做位移分离、不判动量（避免撞空气被扣速）。
    const isLon = Math.abs(geo.sLon) >= Math.abs(geo.dLat);
    const phantom = (other.netAge || 0) > 120 || e.extraMs > 120;
    const canPenalize = !phantom && now2 - (e.lastMomentumAt || 0) > 150;
    if (isLon) {
      if (geo.sLon > 0 && meCar.speed > other.speed) {
        // meCar 是后车追尾者：只承担与穿透深度成比例的那部分速度差
        const k = 0.45 * Math.min(1, pen / 1.2);
        meCar.speed -= (meCar.speed - other.speed) * (canPenalize ? k : 0);
        if (canPenalize) e.lastMomentumAt = now2;
      }
      // 若 meCar 是前车被追尾，本地速度严格保持，不被顶飞
    } else if (canPenalize) {
      // 侧向并排挤压擦碰：轻微摩擦阻尼
      meCar.speed *= 0.996;
      e.lastMomentumAt = now2;
    }

    // 4. 视听与打击感反馈
    // 打击感只在"接触开始"时给一次：并排/贴车持续重叠时，若每帧都补满 shake 与扬尘，
    // 镜头就会被 applyCamera 每帧随机偏移（±shake 世界单位）→ 整个画面高频抖动，
    // 比"撞一下"难受得多，而且会让人误以为是自车在卡顿。同一辆车 200ms 内只触发一次。
    const now = now2;
    const fresh = now - (e.lastBumpFxAt || 0) > 200;
    if (fresh) {
      e.lastBumpFxAt = now;
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
    }

    // 碰撞音效（带 120ms 防重叠冷却）
    if (now - lastBumpSoundTime > 120) {
      lastBumpSoundTime = now;
      audio.bumpSound();
    }
  }
}

// 每帧：自车本地物理 + 远端高精度插值 + 本地碰撞响应 + 状态上报
// finalStep：掉帧补偿会把一帧拆成多个物理子步，碰撞只在最后一步解算——
//   拆步的目的是"补时间"，若每步都跑一次非对称碰撞，自车会被 -45% 速度差与硬分离
//   连罚 2~8 次（掉帧越多弹得越狠），看起来就是自车"一顿一顿"。
// 返回自车计圈事件（"lap" | "finish" | null），供主流程提示
export function updateNetRace(dt, localInput, now, fx, finalStep = true) {
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
  // 自适应延迟：缓冲见底时把播放延迟垫深（最多 150ms），链路恢复后回落到 80ms。
  // 用的是上一帧的 netStarved（一帧延迟对 15ms 级别的调整没有影响）。
  clock.setDelay(delayCtl.update(dt, netStarved));
  clock.update(dt);
  interpolateRemoteCars(dt);

  // ---- 3. QQ 飞车式客户端非对称碰撞与打击感响应 ----
  if (me) {
    if (finalStep) resolveClientCarCollisions(me.car, fx, dt);

    // ---- 4. 状态上报：固定 33.3ms 节拍（累积器驱动，30/60/144fps 的间隔完全一致）----
    // 同时上报采样时刻 st（本机单调时钟），接收端据此重建真实时间轴，
    // 这样"帧率不同的玩家"在别人眼里也是匀速运动。
    const c = me.car;
    sampleAcc += dt * 1000;
    // 一帧只上报一次（且只在最后一步）：补推拆步时一帧会算好几段位移，
    // 它们的时间戳都是"本帧真实时刻"，连发就会被接收端当成同一刻的重复样本合并，
    // 结果是"坐标比时间戳跑得快"→ 别人眼里你跑到真实位置前面。
    if (sampleAcc >= SAMPLE_MS && finalStep) {
      sampleAcc -= SAMPLE_MS;
      if (sampleAcc > SAMPLE_MS) sampleAcc = 0;   // 长卡顿后不要补发一串旧状态
      if (!conn.isOpen()) return event;
      // 同一时刻不重复上报：接收端对"时刻相同"的样本只更新坐标、不动时间戳，
      // 那等于"坐标跑在时间戳前面"，看你的车就会显得比真实位置靠前。
      if (now - lastSendSt < SAMPLE_MS * 0.5) return event;
      lastSendSt = now;
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
  conn.on("peer_state", onPeerState);      // 兼容：旧服务端/单包中继
  conn.on("peers_bundle", onPeersBundle);  // 新：16ms 合包广播
  conn.on("race_end", onRaceEnd);
  conn.on("player_forfeit", onPlayerForfeit);
}

export function forfeitNetRace() {
  if (active && conn.isOpen()) {
    conn.send({ t: "surrender" });
  }
}
