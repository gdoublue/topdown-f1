import { TOTAL_LAPS, effectiveLaps } from "../config.js";
import { N, currentTrack, LAP_LENGTH } from "../track/geometry.js";

/* ================= 发车灯（真实 F1：灯灭发车） =================
   5 组红灯逐组点亮（每组间隔 1s），全亮后再随机等待 0.6~2.0s，
   然后所有红灯同时熄灭 —— 熄灭的那一刻才真正发车。
   随机等待不是偷懒：真实 F1 的灭灯时刻也是不可预判的（防抢跑）。
   旧的 "3-2-1-GO" 数字倒数已废弃；服务端房间赛复用同一套常量与算法。 */
export const START_LIGHT_COUNT = 5;      // 灯组数
export const START_LIGHT_STEP = 1.0;     // 每组点亮间隔（秒）
export const START_HOLD_MIN = 0.6;       // 全亮后的随机等待（秒），下限
export const START_HOLD_MAX = 2.0;       // 上限

// 本次发车倒计时总时长（秒）= 4 个间隔 + 随机等待（4.6 ~ 6.0s）
export function rollStartCountdown() {
  return START_LIGHT_STEP * (START_LIGHT_COUNT - 1)
    + START_HOLD_MIN + Math.random() * (START_HOLD_MAX - START_HOLD_MIN);
}

// 剩余秒数 → 当前应点亮几组红灯（0 = 全灭 = 已经发车）
export function lightsFor(remaining, total) {
  if (!(remaining > 0)) return 0;
  const elapsed = Math.max(0, (total || 0) - remaining);
  return Math.min(START_LIGHT_COUNT, Math.floor(elapsed / START_LIGHT_STEP) + 1);
}

// 比赛状态工厂：服务端每个房间创建独立实例；浏览器沿用下方全局单例 race
export function createRaceState() {
  const total = rollStartCountdown();
  return {
    state: "countdown",   // countdown | racing | finished
    countdown: total,
    countdownTotal: total,   // 本次倒计时的起始值：灯数 = f(剩余, 总时长)
    lights: 0,               // 当前点亮的灯组数（0 = 全灭）
    lap: 1,
    best: null, last: null, total: 0,
    half: false,
    raceStart: 0, lapStart: 0
  };
}

export const race = createRaceState();

/* ================= 比赛模拟时钟 =================
   圈速/总时唯一时间源：由主循环按实际推进的 dt 累加（倍速下与物理同步），
   不能用 performance.now()——否则 2× 快进跑出的 90s 圈会被记成 45s。 */
export let simClock = 0;   // 毫秒
export function resetSimClock(v = 0) { simClock = v; }
export function advanceSimClock(ms) { if (ms > 0) simClock += ms; }

export function resetRace(r = race) {
  const total = rollStartCountdown();
  r.state = "countdown";
  r.countdown = total;
  r.countdownTotal = total;
  r.lights = 0;
  r.lap = 1;
  r.best = null; r.last = null; r.total = 0;
  r.half = false;
}

// 倒计时推进：返回 "go" 表示本帧灯灭发车，否则返回 null。
// 当前灯组数写在 r.lights 里（渲染层只管读，不重复算时间）。
export function tickCountdown(dt, r = race) {
  r.countdown -= dt;
  if (r.countdown <= 0) {
    r.countdown = 0;
    r.lights = 0;                 // 灯灭 = 发车
    r.state = "racing";
    r.raceStart = r.lapStart = simClock;
    return "go";
  }
  r.lights = lightsFor(r.countdown, r.countdownTotal);
  return null;
}

export function initCarRaceState(car, now = performance.now()) {
  car.lap = 1;
  car.best = null;
  car.last = null;
  car.total = 0;
  car.half = false;
  car.lapStart = now;
  car.finished = false;
  car.lapTimes = [];
  car._cruiseV = null;        // 完赛巡航速度：每场比赛重新随机（60~100km/h）
  if (car.gridPos != null && car.raceDist == null) {
    car.raceDist = -(12 + car.gridPos * 8);
  }
}

// 多车独立计圈判定（r: 比赛状态实例，服务端每房间独立；缺省用全局单例）
export function updateCarLap(car, now = performance.now(), r = race) {
  const prev = car.idx;
  car.idx = car.nearIdx;
  if (r.state !== "racing" || car.finished) return null;

  // 线性赛道：抵达终点线（比赛里程）即单程完赛；终点后方为缓冲区
  if (currentTrack.linear) {
    if (car.trackS >= currentTrack.length - 2) {
      const startT = car.lapStart != null ? car.lapStart : now;
      car.last = now - startT;
      if (!car.lapTimes) car.lapTimes = [];
      car.lapTimes.push(car.last);
      if (car.best == null || car.last < car.best) car.best = car.last;
      car.lap = (car.lap || 1) + 1;
      const raceT = car.raceStart != null ? car.raceStart : (r.raceStart != null ? r.raceStart : 0);
      car.total = now - raceT;
      car.finished = true;
      car.raceDist = currentTrack.length;
      return "finish";
    }
    return null;
  }

  if (prev > N * 0.72 && car.idx < N * 0.28) {
    if (!car.half) return null;
    const startT = car.lapStart != null ? car.lapStart : now;
    car.last = now - startT;
    if (!car.lapTimes) car.lapTimes = [];
    car.lapTimes.push(car.last);
    if (car.best == null || car.last < car.best) car.best = car.last;
    car.lapStart = now;
    car.half = false;
    car.lap = (car.lap || 1) + 1;
    const maxLaps = effectiveLaps(currentTrack?.laps);
    const lapLen = LAP_LENGTH || 5000;
    if (car.lap > maxLaps) {
      const raceT = car.raceStart != null ? car.raceStart : (r.raceStart != null ? r.raceStart : 0);
      car.total = now - raceT;
      car.finished = true;
      car.raceDist = maxLaps * lapLen;
      return "finish";
    }
    car.raceDist = (car.lap - 1) * lapLen + (car.trackS || 0);
    return "lap";
  }
  if (prev < N * 0.28 && car.idx > N * 0.72) car.half = false;
  if (car.idx > N * 0.34 && car.idx < N * 0.66) car.half = true;
  return null;
}

// 计圈判定（在 stepCar 之后调用，单车模式兼容）；返回 "lap" | "finish" | null
export function updateLap(car) {
  const ev = updateCarLap(car);
  if (ev) {
    race.lap = car.lap;
    race.last = car.last;
    race.best = car.best;
    if (ev === "finish") {
      race.total = car.total;
      race.state = "finished";
    }
  }
  return ev;
}
