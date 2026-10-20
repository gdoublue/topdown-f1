// RaceSim 直测：AI 车是否正常推进、终局判定是否触发
import { RaceSim } from "../core/sim.js";

const room = { trackId: "dragstrip", laps: 1, sameCar: true, fillAI: true, maxPlayers: 8 };
const humans = [{ sid: "s1", nickname: "Tester", carId: "mercedes-w15" }];
const sim = new RaceSim(room, humans);

// 模拟人类上报完赛（1s 后）
sim.reportFinish("s1", { totalMs: 68000, bestLapMs: 68000, laps: 1 });

const dt = 1 / 30;
let now = 1000;
for (let i = 0; i < 30 * 100; i++) {   // 模拟 100 秒
  now += dt * 1000;
  sim.tick(dt, now);
  if (i % 300 === 0) {
    const ai = sim.aiEntries[0]?.car;
    console.log(`t=${(i / 30).toFixed(0)}s state=${sim.race.state} AI#0 rd=${Math.round(ai?.raceDist || 0)} fin=${ai?.finished} ghosts=${[...sim.ghosts.values()].map(g => Math.round(g.car.raceDist))}`);
  }
  if (sim.ended) { console.log(`ENDED at t=${(i / 30).toFixed(1)}s`); break; }
}
if (!sim.ended) console.log("NOT ENDED after 100s");
console.log("results:", sim.results().map(r => `P${r.rank} ${r.nickname} fin=${r.finished} total=${(r.totalMs/1000).toFixed(1)}`).join(" | "));
