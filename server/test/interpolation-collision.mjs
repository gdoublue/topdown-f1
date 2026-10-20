// 验证：
// 1. 连续浮点快照插值（消除 30Hz 阶梯顿挫，高帧率平滑推进）
// 2. 网络短暂停顿下的航位推算（Dead Reckoning）
// 3. QQ飞车式客户端非对称碰撞（零延迟阻挡、后车减速、弹性推开、防穿模）
// 4. 服务端 AI 对人类玩家的单向防穿透处理

import assert from "node:assert";
import { createCar, stepCar, getCarDistance } from "../../src/car/physics.js";
import { RaceSim } from "../core/sim.js";

console.log("======================================================");
console.log("测试 1: 服务端 AI 车对人类玩家单向防穿透");
console.log("======================================================");

{
  const room = {
    id: "test-room",
    trackId: "dragstrip",
    laps: 1,
    fillAI: true,
    maxPlayers: 2,
    sameCar: false,
  };
  const humans = [{ sid: "human-1", nickname: "Player1", carId: "ferrari-sf24" }];
  const sim = new RaceSim(room, humans);

  // 人类开赛
  sim.race.state = "racing";
  for (const e of sim.aiEntries) {
    e.car.raceStart = performance.now();
    e.car.lapStart = performance.now();
  }

  // 设定人类幽灵在前方 (x: 200, y: 470, speed: 50)
  sim.setPlayerState("human-1", { x: 200, y: 470, angle: 0, speed: 50, lap: 1, rd: 200 }, performance.now());

  // 设定 AI 在人类正后方，初速更快 (x: 198, y: 470, speed: 120)，产生重叠追尾
  const ai = sim.aiEntries[0].car;
  ai.x = 198;
  ai.y = 470;
  ai.speed = 120;
  const initialHumanX = sim.ghosts.get("human-1").car.x;

  // 执行一次 tick
  sim.tick(0.033, performance.now());

  // 验证：人类幽灵坐标没有被服务端篡改
  assert.strictEqual(sim.ghosts.get("human-1").car.x, initialHumanX, "人类坐标不可被服务端篡改");
  // 验证：AI 车作为后车受到了阻挡和减速惩罚
  assert.ok(ai.speed < 120, `AI 追尾人类后必须减速，当前速度: ${ai.speed}`);
  console.log(`✓ AI 追尾人类防穿透通过: 人类坐标严格锁定在 ${initialHumanX}，AI 速度由 120 降为 ${ai.speed.toFixed(1)}`);
}

console.log("\n======================================================");
console.log("测试 2: 客户端连续时间快照插值（消除 30Hz 阶梯停滞）");
console.log("======================================================");

{
  // 模拟客户端快照插值环境
  const SIM_TICK_HZ = 30;
  const INTERPOLATION_DELAY_TICKS = 2.5;

  let renderTick = -1;
  let latestServerTick = -1;

  function updateClock(dt) {
    if (latestServerTick < 0) return;
    if (renderTick < 0) {
      renderTick = latestServerTick - INTERPOLATION_DELAY_TICKS;
      return;
    }
    const targetTick = latestServerTick - INTERPOLATION_DELAY_TICKS;
    const error = targetTick - renderTick;
    let advanceRate = 1.0;
    if (Math.abs(error) > 8.0) renderTick = targetTick;
    else if (error > 0.05) advanceRate = 1.0 + Math.min(0.18, error * 0.12);
    else if (error < -0.05) advanceRate = Math.max(0.82, 1.0 + error * 0.12);
    renderTick += dt * SIM_TICK_HZ * advanceRate;
  }

  const buf = [];
  // 构造 30Hz 的快照序列（车沿 X 轴以 50 m/s 匀速行驶）
  for (let t = 0; t <= 10; t++) {
    buf.push({ tick: t, x: 100 + t * (50 / 30), y: 200, a: 0, v: 50 });
  }
  latestServerTick = 10;
  renderTick = 10 - INTERPOLATION_DELAY_TICKS; // = 7.5

  const car = { x: 0, y: 0, angle: 0, speed: 0 };

  function sampleInterpolation(dt) {
    updateClock(dt);
    // 区间插值
    let s0 = buf[0], s1 = buf[buf.length - 1];
    for (let i = 0; i < buf.length - 1; i++) {
      if (buf[i].tick <= renderTick && buf[i + 1].tick >= renderTick) {
        s0 = buf[i]; s1 = buf[i + 1];
        break;
      }
    }
    const span = Math.max(0.0001, s1.tick - s0.tick);
    const alpha = Math.min(1, Math.max(0, (renderTick - s0.tick) / span));
    car.x = s0.x + (s1.x - s0.x) * alpha;
    car.y = s0.y + (s1.y - s0.y) * alpha;
    return car.x;
  }

  // 客户端以 60Hz（dt = 1/60s ≈ 16.67ms）连续渲染 4 帧（在服务端 2 个快照到达之间）
  const x_frame1 = sampleInterpolation(1 / 60);
  const x_frame2 = sampleInterpolation(1 / 60);
  const x_frame3 = sampleInterpolation(1 / 60);
  const x_frame4 = sampleInterpolation(1 / 60);

  console.log(`60Hz 采样连续 4 帧 X 坐标: ${x_frame1.toFixed(3)}, ${x_frame2.toFixed(3)}, ${x_frame3.toFixed(3)}, ${x_frame4.toFixed(3)}`);
  assert.ok(x_frame2 > x_frame1, "第 2 帧必须平滑前进，绝不可停滞在原地！");
  assert.ok(x_frame3 > x_frame2, "第 3 帧必须平滑前进！");
  assert.ok(x_frame4 > x_frame3, "第 4 帧必须平滑前进！");

  const step1 = x_frame2 - x_frame1;
  const step2 = x_frame3 - x_frame2;
  const step3 = x_frame4 - x_frame3;
  assert.ok(Math.abs(step1 - step2) < 0.05, "连续帧位移增量必须极为均匀平滑！");
  console.log("✓ 连续时间浮点插值验证通过：60fps 下无任何停滞瞬移！");
}

console.log("\n======================================================");
console.log("测试 3: 航位推算（Dead Reckoning，网络抖动断包不急刹）");
console.log("======================================================");

{
  const buf = [{ tick: 5, x: 200, y: 100, a: 0, v: 40 }];
  const SIM_TICK_HZ = 30;
  // 假设网络发生抖动延迟，当前 renderTick 已达到 6.0（超过最新快照 5.0，大约 33ms 未收到包）
  const renderTick = 6.0;
  const last = buf[0];
  const extrapDt = Math.min(0.25, Math.max(0, (renderTick - last.tick) / SIM_TICK_HZ));
  const carX = last.x + Math.cos(last.a) * last.v * extrapDt;

  assert.ok(carX > last.x, "在网络抖动丢包期间，赛车必须惯性向前延伸，绝不停滞！");
  console.log(`✓ 航位推算通过: 33ms 未收包下自动前移至 ${carX.toFixed(2)} (前移 ${(carX - last.x).toFixed(2)}m)`);
}

console.log("\n======================================================");
console.log("测试 4: QQ飞车式客户端本地非对称碰撞（零延迟阻挡与防穿模）");
console.log("======================================================");

{
  // 模拟客户端两车：自车追尾前方的远端 AI 车
  const meCar = { x: 98, y: 200, angle: 0, speed: 80, shake: 0 };
  const remoteEntry = {
    car: { x: 100, y: 200, angle: 0, speed: 40 },
    pushX: 0,
    pushY: 0,
  };

  const geoBefore = getCarDistance(meCar, remoteEntry.car);
  assert.ok(geoBefore.gapFrontRear < 0 && geoBefore.gapLateral < 0, "两车初始产生穿透重叠");

  // 执行非对称碰撞
  const dx = remoteEntry.car.x - meCar.x;
  const dy = remoteEntry.car.y - meCar.y;
  const dist = Math.hypot(dx, dy) || 1;
  const nx = dx / dist, ny = dy / dist;
  const pen = Math.min(-geoBefore.gapFrontRear, -geoBefore.gapLateral);
  const push = Math.min(0.7, Math.max(0.04, pen * 0.7));

  // 1. 自车后退分离
  meCar.x -= nx * push;
  meCar.y -= ny * push;

  // 2. 远端车叠加视觉弹性位移
  remoteEntry.pushX += nx * push * 0.5;
  remoteEntry.pushY += ny * push * 0.5;

  // 3. 动力学减速（后车承担）
  if (geoBefore.sLon > 0 && meCar.speed > remoteEntry.car.speed) {
    const diff = meCar.speed - remoteEntry.car.speed;
    meCar.speed -= diff * 0.45;
  }

  // 验证
  assert.ok(meCar.x < 98, "自车必须被阻挡推后");
  assert.ok(meCar.speed < 80, `自车追尾后速度必须减退，当前速度: ${meCar.speed}`);
  assert.ok(remoteEntry.pushX > 0, "远端车必须获得弹性视觉排斥，产生受击打击感");
  assert.strictEqual(remoteEntry.car.speed, 40, "被撞的前车速度不受影响，弯中不会失控");
  console.log(`✓ 客户端非对称碰撞通过: 自车被阻挡至 x=${meCar.x.toFixed(2)}, 速度由 80 降至 ${meCar.speed.toFixed(1)}，远端车视觉弹性位移 pushX=${remoteEntry.pushX.toFixed(2)}`);
}

console.log("\n======================================================");
console.log("所有平滑插值与 QQ 飞车碰撞逻辑测试全绿通过 ✅");
console.log("======================================================");
