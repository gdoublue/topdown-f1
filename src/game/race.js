import { TOTAL_LAPS, effectiveLaps } from "../config.js";
import { N, currentTrack, LAP_LENGTH } from "../track/geometry.js";

// 比赛状态工厂：服务端每个房间创建独立实例；浏览器沿用下方全局单例 race
export function createRaceState() {
  return {
    state: "countdown",   // countdown | racing | finished
    countdown: 3.0,
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
  r.state = "countdown";
  r.countdown = 3.0;
  r.lap = 1;
  r.best = null; r.last = null; r.total = 0;
  r.half = false;
}

// 倒计时推进；返回 "go" 表示刚开始比赛，否则返回当前应显示的数字
export function tickCountdown(dt) {
  race.countdown -= dt;
  if (race.countdown <= 0) {
    race.state = "racing";
    race.raceStart = race.lapStart = simClock;
    return "go";
  }
  return String(Math.max(1, Math.ceil(race.countdown)));
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
