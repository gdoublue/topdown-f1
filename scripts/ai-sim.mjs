import { createCar, stepCar, resolveCarCollisions, nearestIndex, finishedCarInput } from "../src/car/physics.js";
import { AI_CONFIGS, buildGridSlots, applyCarConfig, createAIInput, driveAI } from "../src/game/ai.js";
import { race, resetRace, initCarRaceState, updateCarLap } from "../src/game/race.js";
import { switchTrack, currentTrack, hw } from "../src/track/geometry.js";
import { TRACKS, getTrack } from "../src/track/tracks.js";

// 命令行参数解析
const args = process.argv.slice(2);
function getArg(name, def) {
  const prefix = `--${name}=`;
  const found = args.find(a => a.startsWith(prefix));
  if (found) return found.slice(prefix.length);
  return def;
}

// 识别所选赛道参数 (--track=xxx 或位置参数)
let trackParam = getArg("track", null);
if (!trackParam) {
  const pos = args.find(a => !a.startsWith("-") && isNaN(Number(a)));
  if (pos) trackParam = pos.toLowerCase();
}
if (!trackParam) trackParam = "shanghai";

const isAllTracks = trackParam === "all" || trackParam === "season" || trackParam === "championship";
const targetLaps = Number(getArg("laps", args.find(a => !a.startsWith("-") && !isNaN(Number(a))) || 3));
const fps = Number(getArg("fps", 60));
const jitter = args.includes("--jitter") || args.includes("-j");
const isFixed = args.includes("--fixed");

const fx = { addSkid() {}, addDust() {}, clearEffects() {} };

// 单场大奖赛物理仿真执行器
function runGrandPrix(trackObj, laps, verbose = true) {
  switchTrack(trackObj.id);

  // 发车位：AI_CONFIGS 中 gridPos 指定的杆位优先，其余随机（--fixed 时按配置顺序）
  const carGrid = buildGridSlots(AI_CONFIGS, !isFixed);

  if (verbose) {
    console.log("----------------------------------------------------------------------------------------------------");
    console.log(`🏁  ${trackObj.flag} ${trackObj.name} (${trackObj.nameEn}) · ${trackObj.country}`);
    console.log(`    赛道规格: 长度 ${(trackObj.length / 1000).toFixed(2)}km | ${trackObj.turns} 个弯道 | 特点: ${trackObj.tag}`);
    console.log(`    发车排位 (${isFixed ? "固定发车格" : "🎲 随机抽签发车格"}):`);
    AI_CONFIGS.map((c, i) => ({ c, slot: carGrid[i] }))
      .sort((a, b) => a.slot - b.slot)
      .forEach(({ c, slot }) => console.log(`      P${slot + 1}: [${c.shortName}] ${c.name}`));
    console.log("");
  }

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
      maxSpeed: 0,
      speedSum: 0,
      frames: 0,
      maxExcess: -999,
      grassFrames: 0,
      prevSteer: 0,
      steerJerkSum: 0,
      finishTime: null
    });
  }

  resetRace();
  race.state = "racing";
  race.raceStart = race.lapStart = 0;

  let simTime = 0;
  let totalFrames = 0;
  const wallStart = performance.now();
  const MAX_FRAMES = 60 * 60 * 25; // 虚拟时间保护上限

  for (let f = 0; f < MAX_FRAMES; f++) {
    const dt = jitter ? (1 / fps) * (0.6 + Math.random() * 0.8) : 1 / fps;
    simTime += dt;
    totalFrames++;

    const liveCars = cars.filter(c => !c.finished);   // 完赛车幽灵化

    for (let i = 0; i < cars.length; i++) {
      const car = cars[i];
      const ai = aiInputs[i];
      const st = stats[i];

      if (!car.finished) {
        driveAI(car, ai, dt, liveCars);
        const dSteer = (ai.steer - st.prevSteer) / dt;
        st.steerJerkSum += Math.abs(dSteer);
        st.prevSteer = ai.steer;
      }

      stepCar(car, dt, car.finished ? finishedCarInput(car) : ai, fx);

      st.frames++;
      const speedKmH = Math.abs(car.speed) * 3.6;
      if (speedKmH > st.maxSpeed) st.maxSpeed = speedKmH;
      st.speedSum += speedKmH;

      const near = nearestIndex(car.x, car.y, car.nearIdx);
      const excess = near.d - hw[near.i];
      if (excess > st.maxExcess) st.maxExcess = excess;
      if (excess > 1.5) st.grassFrames++;

      const ev = updateCarLap(car, simTime);
      if (ev === "lap") {
        st.lapTimes.push(+car.last.toFixed(2));
        if (verbose) {
          console.log(`    ⏱️  [${car.shortName}] 完成第 ${car.lap - 1} 圈: 耗时 ${car.last.toFixed(2)}s (极速: ${st.maxSpeed.toFixed(1)} km/h)`);
        }
      } else if (ev === "finish") {
        st.lapTimes.push(+car.last.toFixed(2));
        st.finishTime = simTime;
        if (verbose) {
          console.log(`    🏁  [${car.shortName}] 率先完赛！总用时: ${simTime.toFixed(2)}s`);
        }
      }
    }

    resolveCarCollisions(cars);

    if (cars.every(c => c.finished)) break;
  }

  const wallDuration = (performance.now() - wallStart).toFixed(1);

  const standings = cars.map((car, i) => {
    const st = stats[i];
    const bestLap = st.lapTimes.length > 0 ? Math.min(...st.lapTimes) : 999;
    const avgSpeed = (st.speedSum / Math.max(1, st.frames)).toFixed(1);
    const avgJerk = (st.steerJerkSum / Math.max(1, st.frames)).toFixed(2);
    const marginToKerb = (-st.maxExcess).toFixed(2);

    return {
      car,
      st,
      rank: 0,
      finishTime: st.finishTime || simTime,
      bestLap,
      avgSpeed,
      avgJerk,
      marginToKerb,
      fastestLapOfRace: false,
      points: 0
    };
  }).sort((a, b) => a.finishTime - b.finishTime || a.bestLap - b.bestLap);

  standings.forEach((s, idx) => s.rank = idx + 1);

  // 结算 F1 积分 (P1=25, P2=18, P3=15, P4=12) 与最快单圈 (+1 分)
  const F1_POINTS = [25, 18, 15, 12];
  let fastestLapCar = standings[0];
  standings.forEach(s => {
    if (s.bestLap < fastestLapCar.bestLap) fastestLapCar = s;
  });
  fastestLapCar.fastestLapOfRace = true;

  standings.forEach((s, idx) => {
    s.points = (F1_POINTS[idx] || 0) + (s.fastestLapOfRace ? 1 : 0);
  });

  return {
    track: trackObj,
    standings,
    totalFrames,
    simTime,
    wallDuration
  };
}

// 打印单场比赛排位表
function printStandingsTable(result) {
  console.log("\n名次 | 赛车 & 战术风格                    | 积分 | 完赛耗时 | 最快圈速 | 实测极速  | 边缘余量 | 平滑度");
  console.log("-----+------------------------------------+------+----------+----------+-----------+----------+--------");

  result.standings.forEach(s => {
    const rankStr = ` P${s.rank} `.padEnd(5);
    const nameStr = s.car.shortName.padEnd(35);
    const ptsStr = `+${s.points}${s.fastestLapOfRace ? '💜' : ' '}`.padStart(4);
    const totalStr = `${s.finishTime.toFixed(2)}s`.padStart(8);
    const bestStr = `${s.bestLap.toFixed(2)}s`.padStart(8);
    const speedStr = `${s.st.maxSpeed.toFixed(1)}km/h`.padStart(9);
    const marginStr = `${s.marginToKerb}m`.padStart(8);
    const jerkStr = `${s.avgJerk}`.padStart(6);

    console.log(`${rankStr}| ${nameStr}| ${ptsStr} | ${totalStr} | ${bestStr} | ${speedStr} | ${marginStr} | ${jerkStr}`);
  });
  console.log("-----+------------------------------------+------+----------+----------+-----------+----------+--------");
}

// ==================== 主入口流程 ====================

if (isAllTracks) {
  // 全赛季锦标赛：连续模拟全部 5 大传奇 F1 赛车场
  console.log("\n====================================================================================================");
  console.log("🏆  FORMULA 1 全赛季多赛道大奖赛锦标赛无头物理仿真 (WORLD CHAMPIONSHIP SEASON)");
  console.log("====================================================================================================");
  console.log(`赛历规划: 5 站大奖赛 (${TRACKS.map(t => `${t.flag} ${t.name.slice(0, 3)}`).join(" -> ")})`);
  console.log(`规则设定: 每站 ${targetLaps} 圈 | F1 积分榜 25-18-15-12 | 💜 最快单圈 +1 分 | 帧率 ${fps}fps\n`);

  const seasonScores = {};
  AI_CONFIGS.forEach(c => {
    seasonScores[c.id] = {
      cfg: c,
      points: 0,
      wins: 0,
      podiums: 0,
      fastestLaps: 0,
      totalMargin: 0,
      results: []
    };
  });

  let grandTotalFrames = 0;
  const seasonWallStart = performance.now();

  TRACKS.forEach((trackObj, roundIdx) => {
    console.log(`\n============================ ROUND ${roundIdx + 1}/5: ${trackObj.flag} ${trackObj.name.toUpperCase()} ============================`);
    const res = runGrandPrix(trackObj, targetLaps, true);
    grandTotalFrames += res.totalFrames;

    printStandingsTable(res);

    res.standings.forEach(s => {
      const sc = seasonScores[s.car.id];
      sc.points += s.points;
      if (s.rank === 1) sc.wins++;
      if (s.rank <= 3) sc.podiums++;
      if (s.fastestLapOfRace) sc.fastestLaps++;
      sc.totalMargin += Number(s.marginToKerb);
      sc.results.push(`P${s.rank}`);
    });
  });

  const seasonWallDuration = (performance.now() - seasonWallStart).toFixed(1);

  // 年度车手总冠军积分榜
  const seasonRank = Object.values(seasonScores).sort((a, b) => b.points - a.points || b.wins - a.wins);

  console.log("\n====================================================================================================");
  console.log("👑 🏁  FORMULA 1 年度车手世界总冠军总积分榜 (FINAL WORLD DRIVERS' CHAMPIONSHIP)");
  console.log("====================================================================================================");
  console.log("名次 | 车手 / 赛车 & 核心算法                    | 总积分 | 分站冠军 | 领奖台 | 最快圈 | 各站名次");
  console.log("-----+------------------------------------------+--------+----------+--------+--------+-------------------");

  seasonRank.forEach((r, idx) => {
    const rankStr = ` P${idx + 1} `.padEnd(5);
    const carStr = `[${r.cfg.driverName || r.cfg.shortName}] ${r.cfg.name}`.padEnd(52);
    const ptsStr = `${r.points} pts`.padStart(6);
    const winStr = `${r.wins} 冠`.padStart(6);
    const podStr = `${r.podiums} 次`.padStart(6);
    const flStr = `${r.fastestLaps} 次`.padStart(6);
    const resultsStr = `  ${r.results.join(" · ")}`;

    console.log(`${rankStr}| ${carStr}| ${ptsStr} | ${winStr} | ${podStr} | ${flStr} |${resultsStr}`);
  });
  console.log("====================================================================================================");

  const champion = seasonRank[0];
  console.log(`\n🏆 恭喜 ${champion.cfg.driverName || champion.cfg.shortName} (${champion.cfg.name}) 荣膺年度世界总冠军！`);
  console.log(`   总积分: ${champion.points} 分 · 夺冠场次: ${champion.wins}/5 站 · 最快圈: ${champion.fastestLaps} 次`);
  console.log(`⚡ 性能统计: 全赛季 5 站大奖赛共计 ${grandTotalFrames} 物理帧，总仿真耗时仅 ${seasonWallDuration}ms\n`);

} else {
  // 单赛道评测
  const targetTrack = getTrack(trackParam);
  console.log("\n====================================================================================================");
  console.log(`🏎️   F1 多算法单站大奖赛无头物理仿真 · ${targetTrack.flag} ${targetTrack.name}`);
  console.log("====================================================================================================");
  console.log(`赛道详细: ${targetTrack.nameEn} (${targetTrack.country}) | 全长 ${(targetTrack.length / 1000).toFixed(2)}km | ${targetTrack.turns} 个弯道`);
  console.log(`赛道特点: ${targetTrack.tag}`);
  console.log(`历史背景: ${targetTrack.desc}`);
  console.log(`仿真配置: ${targetLaps} 圈 | 基准帧率 ${fps}fps | 抖动 ${jitter ? "开" : "关"}\n`);

  const res = runGrandPrix(targetTrack, targetLaps, true);
  printStandingsTable(res);

  console.log(`⚡ 性能统计: 处理 ${res.totalFrames} 帧物理仿真仅耗时 ${res.wallDuration}ms (仿真加速比: ${(res.simTime / (res.wallDuration / 1000)).toFixed(0)}x)\n`);
  const winner = res.standings[0];
  console.log(`🏆 分站冠军: ${winner.car.name}`);
  console.log(`   最快单圈: ${winner.bestLap}s | 赛道边缘安全余量: ${winner.marginToKerb}m | 获得积分: ${winner.points} pts`);

  console.log("\n💡 提示: 您可以通过参数无缝评测其他真实赛道或全赛季锦标赛:");
  console.log("   • 蒙扎国家赛车场:      node scripts/ai-sim.mjs --track=monza");
  console.log("   • 银石赛车场:          node scripts/ai-sim.mjs --track=silverstone");
  console.log("   • 斯帕-弗朗科尔尚:     node scripts/ai-sim.mjs --track=spa");
  console.log("   • 红牛环赛车场:        node scripts/ai-sim.mjs --track=redbullring");
  console.log("   • 全赛季 5 站锦标赛:   node scripts/ai-sim.mjs --track=all\n");
}
