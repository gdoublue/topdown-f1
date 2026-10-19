import { createCar, stepCar, resolveCarCollisions, nearestIndex } from "../src/car/physics.js";
import { AI_CONFIGS, buildGridSlots, applyCarConfig, createAIInput, driveAI } from "../src/game/ai.js";
import { race, resetRace, initCarRaceState, updateCarLap } from "../src/game/race.js";
import { switchTrack, hw } from "../src/track/geometry.js";
import { TRACKS } from "../src/track/tracks.js";

const RUNS_PER_TRACK = 10;
const fps = 60;
const fx = { addSkid() {}, addDust() {}, clearEffects() {} };

function runSingleRace(trackObj, targetLaps = 3) {
  switchTrack(trackObj.id);
  // 发车位：读取 AI_CONFIGS 中 gridPos 指定的杆位，其余随机
  const carGrid = buildGridSlots(AI_CONFIGS, true);

  const cars = [];
  const aiInputs = [];
  const stats = [];

  for (let i = 0; i < AI_CONFIGS.length; i++) {
    const cfg = AI_CONFIGS[i];
    const car = applyCarConfig(createCar(carGrid[i]), cfg);
    initCarRaceState(car, 0);

    cars.push(car);
    aiInputs.push(createAIInput());
    stats.push({
      cfg,
      lapTimes: [],
      finishTime: null,
      maxSpeed: 0,
      maxExcess: -999
    });
  }

  resetRace();
  race.state = "racing";
  race.raceStart = race.lapStart = 0;

  let simTime = 0;
  const MAX_FRAMES = 60 * 60 * 20;

  for (let f = 0; f < MAX_FRAMES; f++) {
    const dt = 1 / fps;
    simTime += dt;

    for (let i = 0; i < cars.length; i++) {
      const car = cars[i];
      const ai = aiInputs[i];
      const st = stats[i];

      if (!car.finished) {
        driveAI(car, ai, dt, cars);
      }
      stepCar(car, dt, car.finished ? { up: false, brake: 1, steer: 0 } : ai, fx);

      const speedKmH = Math.abs(car.speed) * 3.6;
      if (speedKmH > st.maxSpeed) st.maxSpeed = speedKmH;

      const near = nearestIndex(car.x, car.y, car.nearIdx);
      const excess = near.d - hw[near.i];
      if (excess > st.maxExcess) st.maxExcess = excess;

      const ev = updateCarLap(car, simTime);
      if (ev === "lap") {
        st.lapTimes.push(+car.last.toFixed(2));
      } else if (ev === "finish") {
        st.lapTimes.push(+car.last.toFixed(2));
        st.finishTime = simTime;
      }
    }

    resolveCarCollisions(cars);
    if (cars.every(c => c.finished)) break;
  }

  const standings = cars.map((car, i) => {
    const st = stats[i];
    const bestLap = st.lapTimes.length > 0 ? Math.min(...st.lapTimes) : 999;
    return {
      car,
      st,
      finishTime: st.finishTime || simTime,
      bestLap,
      margin: -st.maxExcess
    };
  }).sort((a, b) => a.finishTime - b.finishTime || a.bestLap - b.bestLap);

  return standings;
}

console.log("==========================================================================================");
console.log(`🚀 开始基准测试: 5 条赛道各模拟 ${RUNS_PER_TRACK} 遍 (共 50 场大奖赛)...`);
console.log("==========================================================================================\n");

const overallStats = {};
AI_CONFIGS.forEach(c => {
  overallStats[c.id] = {
    cfg: c,
    wins: 0,
    p2: 0,
    p3: 0,
    p4: 0,
    bestLaps: 0,
    timesWonPerTrack: {}
  };
});

const t0 = performance.now();

for (const track of TRACKS) {
  process.stdout.write(`🏎️  正在模拟 [${track.flag} ${track.name}] 10 遍: `);
  const trackWins = {};
  AI_CONFIGS.forEach(c => trackWins[c.id] = 0);

  for (let r = 0; r < RUNS_PER_TRACK; r++) {
    const standings = runSingleRace(track);
    const winner = standings[0];
    trackWins[winner.car.id]++;
    overallStats[winner.car.id].wins++;

    standings.forEach((s, idx) => {
      if (idx === 1) overallStats[s.car.id].p2++;
      if (idx === 2) overallStats[s.car.id].p3++;
      if (idx === 3) overallStats[s.car.id].p4++;
    });

    let bestOfRace = standings[0];
    standings.forEach(s => {
      if (s.bestLap < bestOfRace.bestLap) bestOfRace = s;
    });
    overallStats[bestOfRace.car.id].bestLaps++;
    process.stdout.write(".");
  }

  AI_CONFIGS.forEach(c => {
    overallStats[c.id].timesWonPerTrack[track.id] = trackWins[c.id];
  });

  const winSummary = AI_CONFIGS.map(c => `${c.shortName}: ${trackWins[c.id]}胜`).join(" | ");
  console.log(` 完成! (${winSummary})`);
}

const totalTimeMs = (performance.now() - t0).toFixed(0);

console.log("\n==========================================================================================");
console.log(`📊 50 场大奖赛全赛道统计结果 (总耗时: ${totalTimeMs}ms)`);
console.log("==========================================================================================");
console.log("赛车 & 战术风格                    | 夺冠总数 (胜率) | P2次数 | P3次数 | P4次数 | 最快圈数");
console.log("------------------------------------+-----------------+--------+--------+--------+----------");

Object.values(overallStats).forEach(s => {
  const nameStr = `[${s.cfg.driverName || s.cfg.shortName}] ${s.cfg.name}`.padEnd(35);
  const winRate = ((s.wins / (TRACKS.length * RUNS_PER_TRACK)) * 100).toFixed(1);
  const winStr = `${s.wins}/50 (${winRate}%)`.padStart(15);
  const p2Str = `${s.p2}`.padStart(6);
  const p3Str = `${s.p3}`.padStart(6);
  const p4Str = `${s.p4}`.padStart(6);
  const flStr = `${s.bestLaps}`.padStart(8);

  console.log(`${nameStr} | ${winStr} | ${p2Str} | ${p3Str} | ${p4Str} | ${flStr}`);
});

console.log("==========================================================================================");
console.log("各赛道分站冠军分布:");
TRACKS.forEach(t => {
  const dist = AI_CONFIGS.map(c => `${c.shortName}: ${overallStats[c.id].timesWonPerTrack[t.id]}胜`).join(" | ");
  console.log(`  • ${t.flag} ${t.name}: ${dist}`);
});
console.log("==========================================================================================\n");
