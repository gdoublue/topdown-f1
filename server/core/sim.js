// 房间竞速协调器（QQ飞车式幽灵竞速模型）
//
// 职责划分：
//   - 每个玩家：自己的车在【自己的客户端】以完整帧率本地模拟（零网络延迟），
//     以 60Hz 上报位置/圈数状态（30fps 客户端退化为逐帧）；服务器只做中继展示与合理性校验
//   - AI 补位车：服务器 30Hz 权威模拟（复用单机物理）
//   - 服务器：比赛时钟（倒计时/开赛/结束）、状态广播、成绩收集与排名
//   - 车辆间不发生实体碰撞（幽灵竞速）——在线竞速没有必须实时对撞的交互
import { activateContext, createTrackContext } from "../../src/track/geometry.js";
import { createCar, stepCar, nearestIndex, finishedCarInput, resolveCarCollisions, getCarDistance } from "../../src/car/physics.js";
import { applyCarConfig, createAIInput, driveAI, AI_CONFIGS } from "../../src/game/ai.js";
import { createRaceState, initCarRaceState, updateCarLap, lightsFor } from "../../src/game/race.js";
import { TOTAL_LAPS, PHYS, setRaceLaps } from "../../src/config.js";
import { TRACK_MIN_LAP_MS, DEFAULT_MIN_LAP_MS } from "../config.js";
import { minLapMsFor, RACE_MIN_LAP_SAFETY } from "../services/lapValidation.js";

const FX_STUB = { addSkid() {}, addDust() {}, clearEffects() {} };

export class RaceSim {
  constructor(room, humans) {
    this.room = room;
    this.humans = humans;             // [{ sid, nickname, carId }]
    this.trackCtx = createTrackContext(room.trackId);
    activateContext(this.trackCtx);   // 立即激活一次：预构建 AI 走线数据缓存
    this.race = createRaceState();
    this.aiEntries = [];              // { car, aiInput }
    this.ghosts = new Map();          // sid -> 幽灵（客户端中继状态）
    this.finishReports = new Map();   // sid -> { totalMs, bestLapMs, laps, valid }
    this.tickNo = 0;
    this.simMs = 0;                    // 模拟逻辑时钟（毫秒）：AI 车样本的时间戳来源，均匀步进
    // 发车时刻（服务器 perf 时钟）：倒计时锚在它上面，客户端用它把"灯灭"对齐到同一个
    // 绝对时刻，而不是各自等自己收到 racing 包（那样每个人都晚一个单程时延，房主先窜出去）。
    this.goWallMs = 0;
    this.ended = false;
    this.endBroadcast = false;
    this.maxLaps = room.laps || this.trackCtx.track?.laps || TOTAL_LAPS;
    this._carList = [];               // 复用数组（AI 避让感知用）
    this._buildAI();
    for (const h of humans) this.addPlayer(h.sid, h.nickname, h.carId);
  }

  // AI 补位车：占满剩余发车位（同车模式下沿用统一性能、只换驾驶员）
  _buildAI() {
    const aiCount = this.room.fillAI
      ? Math.max(0, this.room.maxPlayers - this.humans.length)
      : 0;
    const sameCarId = this.room.sameCar
      ? (this.humans[0]?.carId || AI_CONFIGS[0].id)
      : null;
    let gridPos = this.humans.length;   // 人类占前排发车位，AI 排后
    // AI 阵容固定：人类选了同一款车也照常出这台 AI（保留它原本的车和车手），
    // 不再从 AI 名单里剔除被玩家占用的车型；同款车的区分交给客户端的随机涂装。
    for (const cfg of AI_CONFIGS) {
      if (this.aiEntries.length >= aiCount) break;
      const perfCfg = sameCarId
        ? (AI_CONFIGS.find(c => c.id === sameCarId) || AI_CONFIGS[0])
        : cfg;
      const car = applyCarConfig(createCar(gridPos++), perfCfg);
      if (sameCarId) {
        car.algorithm = cfg.id;
        car.shortName = cfg.shortName;
        car.name = cfg.name;
        car.color = cfg.color;
        car.number = cfg.number;
        car.driver = cfg.driver;
        car.driverName = cfg.driverName;
      }
      car.isPlayer = false;
      car.nickname = cfg.shortName + "(AI)";
      initCarRaceState(car, performance.now());
      this.aiEntries.push({ car, aiInput: createAIInput() });
    }
  }

  // 注册人类幽灵（发车位 idx = 人类序号，客户端同序本地 createCar）
  addPlayer(sid, nickname, carId) {
    const cfg = AI_CONFIGS.find(c => c.id === carId) || AI_CONFIGS[0];
    const car = createCar(this.ghosts.size);
    car.isPlayer = true;
    const numList = ["1", "16", "44", "55", "11", "81", "4", "63", "7", "9", "23", "77"];
    const colorList = ["#ef233c", "#0284c7", "#d97706", "#ec4899", "#10b981", "#ea580c", "#a855f7", "#0891b2"];
    const slotIdx = this.ghosts.size;
    const color = this.room.sameCar ? colorList[slotIdx % colorList.length] : cfg.color;
    const number = this.room.sameCar ? numList[slotIdx % numList.length] : cfg.number;
    this.ghosts.set(sid, {
      sid, nickname, carId: cfg.id, shortName: cfg.shortName, color, number,
      car, lastAt: 0,
      // 反作弊基线：上一次被接受的位置 / 里程 / 圈数（见 setPlayerState）
      lastRd: Number(car.raceDist) || 0,
      lastLap: 1,
      rejected: 0,
    });
  }

  // 客户端状态上报（~60Hz）：位置 / 里程 / 圈数 / 完赛标记全部做合理性钳制。
  //
  // 幽灵模型下"自车"由客户端模拟，服务器不重算物理，但**不是全盘接收**：
  //   · 单帧位移 > vMax·dt·1.5 + 2m 的样本丢弃位置（保留上一帧）。连续异常
  //     （切后台 / 重连 / 设备时钟跳变）后放行位置，保证别人眼里的车不会永远卡住；
  //     但里程仍只能按物理上限推进，靠瞬移抢名次没有意义。
  //   · raceDist 每帧最多增长同一个阈值、圈数最多 +1、完赛标记必须里程到位。
  //     真正的成绩仍以 race_finish 上报 + 理论最短圈校验为准（reportFinish）。
  setPlayerState(sid, s, now) {
    const g = this.ghosts.get(sid);
    if (!g) return;
    const c = g.car;
    const vMax = (c.perf?.maxSpeed?.[0] ?? PHYS.maxSpeed[0]) * 1.05 + 5;
    const lapLen = Math.max(1, this.trackCtx.LAP_LENGTH || 5000);
    const endDist = Math.max(1, this.maxLaps) * lapLen;
    // 正常 60Hz ≈ 2.6m 的余量，远大于实际单帧位移；掉线重连也不会被误杀
    // 【窗口基准】必须用"发送端自报的采样间隔"（st 差），不能只看服务端到达间隔：
    //   · 客户端掉帧后会把物理补推一段（一帧最多补 250ms），这批位移在真实时间上完全合法；
    //   · 但连续补推 / 网络成串到达时，两包到达间隔可能只有几毫秒 → 用到达间隔算窗口，
    //     合法样本会被判成瞬移，位置原地不动而 st 继续前进；
    //   · 接收端于是收到"时间在走、坐标不动"的重复样本 → 别人看到的就是这辆车一格一格地卡。
    // 用 st 差 + 到达间隔封顶（+0.35s）既能覆盖补推，也不给伪造 st 刷位移留太大口子。
    const arrivalDt = g.lastAt > 0 ? Math.min(1, Math.max(0, (now - g.lastAt) / 1000)) : 0.5;
    const stPrev = Number(g.st) || 0;
    const stNow = Number(s.st) || 0;
    const stDt = stNow > stPrev ? Math.min(2, (stNow - stPrev) / 1000) : 0;
    const dt = g.lastAt > 0
      ? Math.max(arrivalDt, Math.min(stDt, arrivalDt + 0.35))
      : 0.5;
    const stepLimit = vMax * dt * 1.5 + 2;

    const nx = Number(s.x);
    const ny = Number(s.y);
    if (Number.isFinite(nx) && Number.isFinite(ny)) {
      const jump = Math.hypot(nx - c.x, ny - c.y);
      if (jump <= stepLimit) {
        c.x = nx;
        c.y = ny;
        g.rejected = 0;
      } else {
        g.rejected = (g.rejected || 0) + 1;
        // 兜底：连续 30 个样本都不合理 → 放行位置（观感自愈），里程仍然受限
        if (g.rejected >= 30) { c.x = nx; c.y = ny; g.rejected = 0; }
      }
    }

    c.angle = Number(s.angle) || 0;
    c.speed = Math.max(-vMax, Math.min(vMax, Number(s.speed) || 0));

    // 里程：按物理上限推进 + 不回退（发车格为负里程，允许停留在负值）
    const rdPrev = Number.isFinite(g.lastRd) ? g.lastRd : (Number(c.raceDist) || 0);
    let rd = Number(s.rd);
    if (!Number.isFinite(rd)) rd = rdPrev;
    if (rd > rdPrev + stepLimit) rd = rdPrev + stepLimit;
    if (rd < Math.min(rdPrev, 0)) rd = Math.min(rdPrev, 0);
    if (rd > endDist) rd = endDist;
    g.lastRd = rd;
    c.raceDist = rd;

    // 圈数：最多 +1，且不超过本场总圈数
    const lap = Math.max(1, Math.round(Number(s.lap)) || 1);
    g.lastLap = Math.min(lap, (g.lastLap || 1) + 1, Math.max(1, this.maxLaps));
    c.lap = g.lastLap;

    // 完赛标记：必须里程到位（成绩另由 race_finish 校验）
    c.finished = !!s.fin && rd >= endDist - 5;
    c.total = Number(s.tot) || 0;
    c.best = Number(s.best) || 0;
    // 踏板 / 方向输入：中继给其他玩家（对手算法可据此判断前车是否在刹车）
    c.inBrake = Math.max(0, Math.min(2, Number(s.b) | 0));
    c.inUp = !!s.u;
    c.inSteer = Math.max(-1, Math.min(1, Number(s.s) || 0));
    const near = nearestIndex(c.x, c.y, c.nearIdx >= 0 ? c.nearIdx : -1);
    c.nearIdx = near.i; c.trackS = near.s;   // AI 避让感知需要
    g.lastAt = now;
    // 采样时刻由发送端给出（毫秒，客户端自己的单调时钟）：
    // 服务端原样中继，不用"收到时刻"或"快照 tick"给样本打时间戳，
    // 否则一帧样本会被对齐到 33ms 网格，接收端插值必然出现快慢交替的顿挫。
    g.st = Number(s.st) || 0;
  }

  // 玩家认输 / 放弃比赛
  forfeitPlayer(sid) {
    const g = this.ghosts.get(sid);
    if (!g || this.finishReports.has(sid)) return;
    g.forfeited = true;
    g.car.finished = true;
    g.car.forfeited = true;
    this.finishReports.set(sid, {
      totalMs: 9999999,
      bestLapMs: Math.round(g.car.best || 0),
      laps: Math.max(0, (g.car.lap || 1) - 1),
      valid: false,
      forfeited: true,
    });
  }

  hasForfeited(sid) {
    return !!this.finishReports.get(sid)?.forfeited;
  }

  // 玩家退出房间 / 掉线：该车彻底退赛（判负留名次），
  // 后续快照不再下发这台车 —— 其他人既不会被挡路，也不会看到一辆停在赛道上的幽灵车。
  retirePlayer(sid) {
    const g = this.ghosts.get(sid);
    if (!g) return;
    this.forfeitPlayer(sid);
    g.gone = true;
  }

  // 真人都已完赛（或已退赛）？
  humansAllDone() {
    return this.ghosts.size > 0 && [...this.ghosts.keys()].every(sid => this.finishReports.has(sid));
  }

  // 单人房（真人 < 2）：真人跑完就直接把剩余的 AI 圈无渲染快进到终局。
  // 做法是按 30Hz 步长空跑模拟（不广播快照、不渲染），让 AI 用真实成绩冲线，
  // 玩家不用再干等 AI 把剩下的两三圈跑完。
  fastForwardToEnd(now, maxSimMs = 300000) {
    if (this.ended) return;
    const dt = 1 / 30;
    const limit = now + maxSimMs;
    let t = now;
    while (!this.ended && t < limit) {
      t += dt * 1000;
      this.tick(dt, t);
    }
    if (!this.ended) {
      // 兜底：AI 卡死/出界时强制终局，未完赛车按里程排名
      this.ended = true;
      this.race.state = "finished";
    }
  }

  // 玩家完赛上报（本地计时）；服务器做合理性校验
  reportFinish(sid, r) {
    const g = this.ghosts.get(sid);
    if (!g || this.finishReports.has(sid)) return;
    const minLap = minLapMsFor(this.room.trackId, g.carId);
    const totalMs = Math.round(Number(r.totalMs) || 0);
    const bestLapMs = Math.round(Number(r.bestLapMs) || 0);
    const laps = Math.max(1, Math.round(Number(r.laps)) || 1);
    const valid = bestLapMs >= minLap * RACE_MIN_LAP_SAFETY
      && totalMs >= laps * minLap * RACE_MIN_LAP_SAFETY;
    this.finishReports.set(sid, { totalMs, bestLapMs, laps, valid });
    g.car.finished = true;
    g.car.total = totalMs;
    g.car.best = bestLapMs;
  }

  tick(dt, now) {
    activateContext(this.trackCtx);   // 多房间轮流 tick：切到本房间赛道（缓存下 O(1)）
    setRaceLaps(this.maxLaps);        // 房间自定义圈数：AI 计圈必须按房间设定（否则会多跑/少跑）
    this.simMs += dt * 1000;          // 逻辑时钟：AI 样本时间戳 = 这个均匀步进的时钟

    if (this.race.state === "countdown") {
      // 倒计时【锚在真实时钟上】而不是"每 tick 减 dt"：
      // goWall 一经确定就不再变化，剩余时间 = goWall - now。
      // 这样客户端拿任一包算出的发车时刻都是同一个精确值（否则 tick 相位会带来 ±16ms 抖动）。
      if (!this.goWallMs) this.goWallMs = now + Math.max(0, this.race.countdown) * 1000;
      const leftSec = (this.goWallMs - now) / 1000;
      // 在"最接近 goWall 的那个 tick"发车（半个 tick 内就算到点）：AI 与客户端的
      // 出发时刻平均误差 ≈ 0，不会出现"AI 总比人晚半帧起步"。
      if (leftSec <= dt * 0.5) {
        this.race.countdown = 0;
        this.race.state = "racing";
        this.race.raceStart = now;
        for (const e of this.aiEntries) {
          e.car.raceStart = now;
          e.car.lapStart = now;   // 圈速从绿灯起算
        }
        return;
      }
      this.race.countdown = leftSec;
      return;
    }
    if (this.race.state !== "racing") return;

    // AI 车本地模拟；人类幽灵作为感知对象参与避让（无实体碰撞）
    // 完赛车辆已幽灵化：不再作为避让/跟车目标，避免堵住仍在比赛的车
    const carList = this._carList;
    carList.length = 0;
    for (const e of this.aiEntries) if (!e.car.finished) carList.push(e.car);
    for (const g of this.ghosts.values()) if (!g.car.finished) carList.push(g.car);

    for (const e of this.aiEntries) {
      // 完赛车也必须继续跑 AI 决策：finishedCarInput 只接管"纵向"（收油到巡航速度），
      // 转向仍然取自 aiInput.steer。之前完赛后跳过 driveAI，舵角被冻结在冲线那一帧，
      // 车会保持那个舵角径直开出赛道 —— 这就是"在线对战里 AI 跑完就不按赛道走"的原因。
      driveAI(e.car, e.aiInput, dt, carList);
      const ctrl = e.car.finished ? finishedCarInput(e.car, e.aiInput) : e.aiInput;
      stepCar(e.car, dt, ctrl, FX_STUB);
      updateCarLap(e.car, now, this.race);
    }
    // AI 车之间保持防穿模
    if (this.aiEntries.length > 1) {
      resolveCarCollisions(this.aiEntries.map(e => e.car));
    }

    // AI 车对人类玩家进行单向防穿透处理（保护人类先行权：AI 作为后车追尾时减速并推开，人类坐标与速度严格不修改）
    if (this.ghosts.size > 0 && this.aiEntries.length > 0) {
      for (const e of this.aiEntries) {
        const aiCar = e.car;
        for (const g of this.ghosts.values()) {
          const humanCar = g.car;
          // 完赛车辆幽灵化：已冲线的车不再参与碰撞
          if (aiCar.finished || humanCar.finished) continue;
          const geo = getCarDistance(aiCar, humanCar);
          if (geo.gapFrontRear >= 0 || geo.gapLateral >= 0) continue;

          const dx = humanCar.x - aiCar.x;
          const dy = humanCar.y - aiCar.y;
          const dist = Math.hypot(dx, dy) || 1;
          const nx = dx / dist, ny = dy / dist;

          const pen = Math.min(-geo.gapFrontRear, -geo.gapLateral);
          const push = Math.min(0.6, Math.max(0.04, pen * 0.6));
          aiCar.x -= nx * push;
          aiCar.y -= ny * push;

          // 若 AI 是后车且追尾人类，AI 承担动量损失减速
          if (Math.abs(geo.sLon) >= Math.abs(geo.dLat) && geo.sLon > 0) {
            if (aiCar.speed > humanCar.speed) {
              aiCar.speed -= (aiCar.speed - humanCar.speed) * 0.45;
            }
          } else {
            aiCar.speed *= 0.995;
          }
        }
      }
    }

    // 终局判定：
    //  · 多人房：所有真人完赛即结束，不再等 AI 跑完（AI 按当前进度参与排名）
    //  · 单人房：真人完赛后由 gateway 快进 AI 到终局，保留完整的 AI 成绩
    //  · 超时阈值按圈数放宽（理论最短圈 × 圈数 × 1.8 + 60s 缓冲）：
    //    固定 150s 会把长赛道多圈的比赛提前掐断，导致所有人被记成未完赛。
    if (!this.ended) {
      const humansAllDone = this.humansAllDone();
      const allAIDone = this.aiEntries.every(e => e.car.finished);
      const multiHuman = this.ghosts.size >= 2;
      const minLap = TRACK_MIN_LAP_MS[this.room.trackId] ?? DEFAULT_MIN_LAP_MS;
      const timeout = now - this.race.raceStart > minLap * this.maxLaps * 1.8 + 60000;
      if ((humansAllDone && (multiHuman || allAIDone)) || timeout) {
        this.ended = true;
        this.race.state = "finished";
      }
    }
  }

  // 快照：AI 权威状态 + 人类中继状态
  // wall：本包发出时的服务器单调时钟（performance.now 同源），与 ts 成线性关系 ts ↔ wall。
  // 客户端用 ping/pong 的往返时延算出"服务器 perf → 本机 perf"偏移，就能把 goAt
  // 换算成一个绝对的本机时刻 —— 所有客户端在同一个瞬间起步（不再各自等包到达）。
  snapshot(wall = 0) {
    // 快照时间戳 = 本房间的模拟逻辑时钟（每 tick 严格 +33.3ms）。
    // 这是客户端的【唯一渲染时间轴】：它均匀、单调、与任何玩家的帧率/网络无关，
    // 客户端据此锁定播放时钟，真人样本只被插值、不参与推进。
    const ts = Math.round(this.simMs * 100) / 100;
    const carSnap = (c, st) => ({
      x: Math.round(c.x * 100) / 100,
      y: Math.round(c.y * 100) / 100,
      a: Math.round(c.angle * 10000) / 10000,
      v: Math.round(c.speed * 10) / 10,
      st: Math.round((st || 0) * 100) / 100,
      lap: c.lap,
      rd: Math.round(c.raceDist || 0),
      fin: c.finished ? 1 : 0,
      tot: Math.round(c.total || 0),
      best: c.best ? Math.round(c.best) : 0,
      // 踏板状态（AI 来自本地模拟，玩家来自 car_state 上报）
      b: c.inBrake | 0,
      u: c.inUp ? 1 : 0,
      s: Math.round((c.inSteer || 0) * 100) / 100,
    });
    return {
      t: "snapshot",
      tick: this.tickNo++,
      ts,
      wall: Math.round((Number(wall) || 0) * 100) / 100,
      // 发车时刻：用【同一个包里的 wall】把 goWall 换算到 sim 时间轴再下发。
      // 客户端反向换算 goWall = wall + (goAt - ts) 是恒等式，所以无论 tick 相位如何，
      // 各端算出的发车时刻都精确一致（goAt 本身只是载体，不参与任何计时）。
      goAt: Math.round((ts + ((this.goWallMs || (wall + Math.max(0, this.race.countdown) * 1000)) - (Number(wall) || 0))) * 100) / 100,
      state: this.race.state,
      // 发车灯（真实 F1：五组红灯逐组亮 → 随机等待 → 灯灭发车）。
      // countdown 改成浮点：客户端要靠它算"还剩多少"做灯架动画，整数秒会一格一格跳；
      // lights 直接给灯组数，客户端不用再自己推时间轴（同一套规则见 src/game/race.js）。
      countdown: Math.max(0, Math.round((this.race.countdown || 0) * 100) / 100),
      lights: this.race.state === "countdown"
        ? lightsFor(this.race.countdown, this.race.countdownTotal)
        : 0,
      cars: [
        // st = 该样本的采样时刻（各自时钟域）：
        //  · 真人：客户端上报时自己打的时间戳，服务端原样中继（真实采样间隔不被量化）
        //  · AI：与 snapshot.ts 完全一致 —— 服务器均匀 tick 网格上的一个精确点
        ...[...this.ghosts.values()].filter(g => !g.gone).map(g => ({ i: g.sid, ...carSnap(g.car, g.st || 0) })),
        ...this.aiEntries.map(e => ({ i: "ai:" + e.car.algorithm, ...carSnap(e.car, ts) })),
      ],
    };
  }

  // 最终排名：已上报完赛按总时；未上报按最后已知进度
  results() {
    const rows = [];
    for (const g of this.ghosts.values()) {
      const rep = this.finishReports.get(g.sid);
      const isForfeited = !!(g.forfeited || rep?.forfeited);
      rows.push({
        sessionId: g.sid,
        nickname: g.nickname,
        carId: g.carId,
        shortName: g.shortName,
        color: g.color,
        finished: isForfeited ? false : !!rep,
        forfeited: isForfeited,
        valid: rep && !isForfeited ? rep.valid : 0,
        totalMs: rep ? rep.totalMs : Math.round(g.car.total || 0),
        bestLapMs: rep ? rep.bestLapMs : Math.round(g.car.best || 0),
        laps: rep ? rep.laps : Math.min((g.car.lap || 1) - 1, this.maxLaps),
        raceDist: g.car.raceDist || 0,
      });
    }
    for (const e of this.aiEntries) {
      const c = e.car;
      rows.push({
        sessionId: null,
        nickname: c.nickname,
        shortName: c.shortName,
        color: c.color,
        finished: !!c.finished,
        forfeited: false,   // 必须显式给出：缺字段会让排序里的 forfeited 比较恒为"不同"，AI 永远排在真人前面
        valid: 1,
        totalMs: Math.round(c.total || 0),
        bestLapMs: c.best ? Math.round(c.best) : 0,
        laps: Math.min((c.lap || 1) - 1, this.maxLaps),
        raceDist: c.raceDist || 0,
      });
    }
    rows.sort((a, b) => {
      if (a.forfeited !== b.forfeited) return a.forfeited ? 1 : -1;
      if (a.finished !== b.finished) return a.finished ? -1 : 1;
      if (a.finished) {
        // 合理性校验未通过的成绩（客户端乱报/改车）排在所有有效成绩之后，
        // 不能靠"报一个更快的总时"直接拿冠军
        const av = a.valid ? 1 : 0, bv = b.valid ? 1 : 0;
        if (av !== bv) return bv - av;
        return a.totalMs - b.totalMs;
      }
      return b.raceDist - a.raceDist;
    });
    return rows.map((r, i) => ({ ...r, rank: i + 1 }));
  }
}
