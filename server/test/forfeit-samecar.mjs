import assert from "node:assert";
import { RaceSim } from "../core/sim.js";
import { getRandomLivery } from "../../src/car/render.js";

console.log("======================================================");
console.log("测试 1: 选同一款车时随机涂装与颜色点位随机");
console.log("======================================================");

{
  // 模拟同一款车 4 辆车
  const l0 = getRandomLivery(0);
  const l1 = getRandomLivery(1);
  const l2 = getRandomLivery(2);
  const l3 = getRandomLivery(3);

  console.log("车 0 涂装:", l0.name, "主色:", l0.color, "尾翼:", l0.wing, "车号:", l0.num);
  console.log("车 1 涂装:", l1.name, "主色:", l1.color, "尾翼:", l1.wing, "车号:", l1.num);
  console.log("车 2 涂装:", l2.name, "主色:", l2.color, "尾翼:", l2.wing, "车号:", l2.num);
  console.log("车 3 涂装:", l3.name, "主色:", l3.color, "尾翼:", l3.wing, "车号:", l3.num);

  assert.notStrictEqual(l0.color, l1.color, "相邻同车涂装颜色点位必须不同");
  assert.notStrictEqual(l1.color, l2.color, "相邻同车涂装颜色点位必须不同");
  assert.notStrictEqual(l0.wing, l1.wing, "尾翼颜色点位必须不同");
  assert.notStrictEqual(l0.num, l1.num, "车号点位必须不同");
  console.log("✓ 同款车随机涂装与颜色点位生成通过！");
}

console.log("\n======================================================");
console.log("测试 2: 多人房间比赛中认输判定与结算排名沉底");
console.log("======================================================");

{
  const room = {
    id: "multi-room",
    trackId: "dragstrip",
    laps: 1,
    fillAI: false,
    maxPlayers: 2,
    sameCar: true,
  };
  const humans = [
    { sid: "human-1", nickname: "PlayerA", carId: "ferrari-sf24" },
    { sid: "human-2", nickname: "PlayerB", carId: "ferrari-sf24" },
  ];
  const sim = new RaceSim(room, humans);

  // 开赛
  sim.race.state = "racing";
  sim.race.raceStart = performance.now();

  // 比赛中途：PlayerA 主动认输退出
  sim.forfeitPlayer("human-1");

  // PlayerB 正常跑完上报完赛
  sim.reportFinish("human-2", {
    totalMs: 65000,
    bestLapMs: 65000,
    laps: 1,
  });

  // 执行一次 tick 触发终局检查
  sim.tick(0.033, performance.now());

  // 验证：比赛已提前正常结束，不需要等待 150 秒超时！
  assert.strictEqual(sim.ended, true, "PlayerA 认输且 PlayerB 完赛后，比赛必须立即正常结束！");

  const results = sim.results();
  console.log("比赛结果排名:");
  for (const r of results) {
    console.log(`  P${r.rank}: ${r.nickname} (forfeited=${r.forfeited}, finished=${r.finished}, total=${(r.totalMs/1000).toFixed(1)}s)`);
  }

  // 验证：PlayerB 获得 P1，PlayerA 认输获得 P2 且沉底
  assert.strictEqual(results[0].sessionId, "human-2", "正常完赛的 PlayerB 必须排名第一");
  assert.strictEqual(results[1].sessionId, "human-1", "认输的 PlayerA 必须排名垫底");
  assert.strictEqual(results[1].forfeited, true, "PlayerA 必须带 forfeited 标记");
  console.log("✓ 多人对战认输提前终局与排名沉底测试通过！");
}

console.log("\n======================================================");
console.log("所有新增功能专项测试全绿通过 ✅");
console.log("======================================================");
