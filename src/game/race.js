// 比赛流程：倒计时、计圈、成绩
import { TOTAL_LAPS } from "../config.js";
import { N } from "../track/geometry.js";

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

// 计圈判定（在 stepCar 之后调用）；返回 "lap" | "finish" | null
export function updateLap(car) {
  const prev = car.idx;
  car.idx = car.nearIdx;
  if (race.state !== "racing") return null;

  if (prev > N * 0.72 && car.idx < N * 0.28) {
    if (!race.half) return null;
    const t = performance.now();
    race.last = t - race.lapStart;
    if (race.best == null || race.last < race.best) race.best = race.last;
    race.lapStart = t;
    race.half = false;
    race.lap++;
    if (race.lap > TOTAL_LAPS) {
      race.total = t - race.raceStart;
      race.state = "finished";
      return "finish";
    }
    return "lap";
  }
  if (prev < N * 0.28 && car.idx > N * 0.72) race.half = false;
  if (car.idx > N * 0.34 && car.idx < N * 0.66) race.half = true;
  return null;
}
