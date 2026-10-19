import { TOTAL_LAPS } from "../config.js";
import { N, currentTrack, LAP_LENGTH } from "../track/geometry.js";

export const race = {
  state: "countdown",     // countdown | racing | finished
  countdown: 3.0,
  lap: 1,
  best: null, last: null, total: 0,
  half: false,
  raceStart: 0, lapStart: 0
};

export function resetRace() {
  race.state = "countdown";
  race.countdown = 3.0;
  race.lap = 1;
  race.best = null; race.last = null; race.total = 0;
  race.half = false;
}

// 倒计时推进；返回 "go" 表示刚开始比赛，否则返回当前应显示的数字
export function tickCountdown(dt) {
  race.countdown -= dt;
  if (race.countdown <= 0) {
    race.state = "racing";
    race.raceStart = race.lapStart = performance.now();
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
  if (car.gridPos != null && car.raceDist == null) {
    car.raceDist = -(12 + car.gridPos * 8);
  }
}

// 多车独立计圈判定
export function updateCarLap(car, now = performance.now()) {
  const prev = car.idx;
  car.idx = car.nearIdx;
  if (race.state !== "racing" || car.finished) return null;

  // 线性赛道：抵达终点线（比赛里程）即单程完赛；终点后方为缓冲区
  if (currentTrack.linear) {
    if (car.trackS >= currentTrack.length - 2) {
      const startT = car.lapStart != null ? car.lapStart : now;
      car.last = now - startT;
      if (!car.lapTimes) car.lapTimes = [];
      car.lapTimes.push(car.last);
      if (car.best == null || car.last < car.best) car.best = car.last;
      car.lap = (car.lap || 1) + 1;
      const raceT = car.raceStart != null ? car.raceStart : (race.raceStart != null ? race.raceStart : 0);
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
    const maxLaps = currentTrack?.laps || TOTAL_LAPS;
    const lapLen = LAP_LENGTH || 5000;
    if (car.lap > maxLaps) {
      const raceT = car.raceStart != null ? car.raceStart : (race.raceStart != null ? race.raceStart : 0);
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
