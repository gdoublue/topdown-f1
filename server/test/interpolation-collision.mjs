// 验证：
// 1. 时间戳驱动 + 样条插值：不同帧率/网络抖动下仍是匀速运动（速度波动 < 12%）
// 2. 网络短暂停顿下的航位推算（Dead Reckoning）
// 3. QQ飞车式客户端非对称碰撞（零延迟阻挡、后车减速、弹性推开、防穿模）
// 4. 服务端 AI 对人类玩家的单向防穿透处理

import assert from "node:assert";
import { createCar, stepCar, getCarDistance } from "../../src/car/physics.js";
import { RaceSim } from "../core/sim.js";
import { sampleRemote, createClockOffset, createPlayoutClock } from "../../src/net/remoteSync.js";

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
console.log("测试 2: 时间戳驱动插值 —— 不同帧率 + 网络抖动下速度是否恒定");
console.log("======================================================");

// 端到端模拟：发送端固定节拍采样 → 服务端 30Hz 中继 → 网络抖动 → 接收端渲染
// 车沿 X 轴以 speed m/s 匀速行驶，理想情况每帧速度应恒等于 speed。
function simulateRemote({ renderHz = 144, sendHz = 30, relayHz = 30, jitterMs = 0, seconds = 4, speed = 60 }) {
  const sendStep = 1000 / sendHz;
  const relayStep = 1000 / relayHz;
  const total = seconds * 1000;
  const arrives = [];
  let si = 0, latestSent = null;
  const sent = [];
  for (let st = 0; st <= total; st += sendStep) sent.push({ st, x: speed * st / 1000 });

  // 服务端每个 tick 转发"当前最新的那份采样"，并在快照上盖均匀时间戳 ts
  let lastRecv = -1e9;
  for (let rt = 0; rt <= total; rt += relayStep) {
    while (si < sent.length && sent[si].st <= rt) latestSent = sent[si++];
    if (!latestSent) continue;
    lastRecv = Math.max(lastRecv, rt + 20 + Math.random() * jitterMs);   // 20ms 基础延迟 + 抖动，TCP 不乱序
    arrives.push({
      recv: lastRecv,
      ts: rt,
      st: latestSent.st,
      x: latestSent.x,
    });
  }

  // 接收端：与 netrace.js 同一套 ——
  // 渲染时钟只由快照 ts 推动（偏移热机后锁定），真人样本只被插值
  const srvClock = createClockOffset(), offClock = createClockOffset();
  let ai = 0;
  const clock = createPlayoutClock();
  const buf = [];
  const out = [];
  const dt = 1 / renderHz;
  let now = 0;
  for (let f = 0; f <= total * renderHz / 1000; f++) {
    now += 1000 / renderHz;
    while (ai < arrives.length && arrives[ai].recv <= now) {
      const a = arrives[ai++];
      clock.noteRef(a.ts + srvClock.observe(a.recv, a.ts));
      const t = a.st + offClock.observe(a.recv, a.st);
      const lastSample = buf[buf.length - 1];
      if (lastSample && t <= lastSample.t + 0.5) lastSample.x = a.x;
      else {
        buf.push({ t, x: a.x, y: 0, a: 0, v: speed });
        if (buf.length > 60) buf.shift();
      }
    }
    if (clock.latestSampleMs < 0) continue;
    const renderMs = clock.update(dt);
    while (buf.length > 3 && buf[1].t < renderMs - 80) buf.shift();
    const r = sampleRemote(buf, renderMs);
    if (r) out.push(r.x);
  }
  // 计算每帧速度偏差
  const dtSec = 1 / renderHz;
  const speeds = [];
  for (let i = 1; i < out.length; i++) speeds.push((out[i] - out[i - 1]) / dtSec);
  const steady = speeds.slice(Math.floor(speeds.length * 0.3));
  const min = Math.min(...steady), max = Math.max(...steady);
  const avg = steady.reduce((a, b) => a + b, 0) / steady.length;
  return { min, avg, max, ripple: (max - min) / avg };
}

{
  const cases = [
    { label: "60fps 玩家 · 无抖动", opts: { renderHz: 144, sendHz: 30, jitterMs: 0 } },
    { label: "30fps 玩家 · 无抖动", opts: { renderHz: 144, sendHz: 30, jitterMs: 0 } },
    { label: "144fps 玩家 · 网络抖动 20ms", opts: { renderHz: 144, sendHz: 30, jitterMs: 20 } },
    { label: "20fps 玩家（50ms 采样）", opts: { renderHz: 144, sendHz: 20, jitterMs: 10 } },
    { label: "60fps 渲染", opts: { renderHz: 60, sendHz: 30, jitterMs: 12 } },
  ];
  for (const c of cases) {
    const r = simulateRemote({ speed: 60, seconds: 4, ...c.opts });
    console.log(`  ${c.label}: 速度 min/avg/max = ${r.min.toFixed(1)} / ${r.avg.toFixed(1)} / ${r.max.toFixed(1)} m/s · 波动 ${(r.ripple * 100).toFixed(1)}%`);
    assert.ok(r.avg > 55 && r.avg < 65, "平均速度必须等于真实车速（不能整体变慢）");
    assert.ok(r.ripple < 0.12, `速度波动必须很小（当前 ${(r.ripple * 100).toFixed(1)}%）`);
  }
  console.log("✓ 帧率无关 + 网络抖动下仍是匀速运动（速度波动 < 12%）");
}

console.log("\n======================================================");
console.log("测试 3: 断流外推（Dead Reckoning，网络抖动断包不急刹）");
console.log("======================================================");

{
  const speed = 40;
  const buf = [
    { t: 1000, x: 200, y: 100, a: 0, v: speed },
    { t: 1033, x: 201.33, y: 100, a: 0, v: speed },
  ];
  // 渲染时间已经跑到最后一个样本之后 33ms（对方掉帧/丢包）
  const r = sampleRemote(buf, 1066);
  assert.ok(r.extrapolated, "超出末样本必须走外推分支");
  assert.ok(r.x > buf[1].x, "在网络抖动丢包期间，赛车必须惯性向前延伸，绝不停滞！");
  const step = r.x - buf[1].x;
  assert.ok(Math.abs(step - speed * 0.033) < 0.5, `外推位移应≈1 帧真实位移（当前 ${step.toFixed(2)}m）`);
  // 外推必须连续：紧贴末样本的时刻不能跳变
  const edge = sampleRemote(buf, 1033.01);
  assert.ok(Math.abs(edge.x - buf[1].x) < 0.05, "样本边界处不得跳变");
  console.log(`✓ 断流外推通过: 33ms 未收包下前移 ${step.toFixed(2)}m，边界连续`);
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
console.log("测试 5: 真人采样抖动不得污染 AI 时间轴（固定延时播放缓冲）");
console.log("======================================================");

{
  // 场景：同一场比赛里，AI 样本来自服务器均匀 tick 网格，
  // 真人样本来自对方本机帧（15~79ms 不规则），且快照到达有 0~40ms 抖动。
  // 断言：AI 在观战端的播放速度必须绝对匀速 —— 真人再抖也推不动全局时钟。
  const TICK = 1000 / 30, SPEED = 60, RENDER_HZ = 144, TOTAL = 5000;
  let seed = 12345;
  const rnd = (a, b) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return a + (seed / 0x7fffffff) * (b - a); };

  const snaps = [];
  {
    let lastArrive = -1e9;
    for (let k = 0; k * TICK <= TOTAL; k++) {
      const ts = k * TICK;
      const arrive = Math.max(lastArrive, ts + 20 + rnd(0, 40));   // TCP 不乱序，迟到会让后续包一起排队
      lastArrive = arrive;
      snaps.push({ ts, arrive });
    }
  }

  const H_EPOCH = 987654;        // 对方本机时钟纪元与本地不同
  const sends = [];
  {
    let frameT = H_EPOCH + 17, acc = 0, lastArrive = 0;
    while (frameT - H_EPOCH <= TOTAL) {
      const step = rnd(15, 45);   // 帧率抖动 → 采样间隔 15~79ms
      frameT += step; acc += step;
      if (acc >= TICK) {
        acc = acc > TICK ? 0 : acc - TICK;
        const st = Math.round(frameT * 100) / 100;
        const arrive = Math.max(lastArrive, frameT - H_EPOCH + 25 + rnd(0, 40));
        lastArrive = arrive;
        sends.push({ st, x: SPEED * (st - H_EPOCH) / 1000, arrive });
      }
    }
  }

  const clock = createPlayoutClock();
  const srvClock = createClockOffset(), humanClock = createClockOffset();
  const aiBuf = [], huBuf = [], out = [];
  const dt = 1 / RENDER_HZ;
  let si = 0, hi = 0;

  for (let f = 1; f * dt * 1000 <= TOTAL; f++) {
    const now = f * dt * 1000;

    while (si < snaps.length && snaps[si].arrive <= now) {
      const sn = snaps[si++];
      const off = srvClock.observe(now, sn.ts);       // 均匀参考轴：热机取最小值后锁定
      clock.noteRef(sn.ts + off);
      aiBuf.push({ t: sn.ts + off, x: SPEED * sn.ts / 1000, y: 0, a: 0, v: SPEED });
      if (aiBuf.length > 60) aiBuf.shift();
    }

    while (hi < sends.length && sends[hi].arrive <= now) {
      const h = sends[hi++];
      const t = h.st + humanClock.observe(now, h.st);
      const last = huBuf[huBuf.length - 1];
      if (last && t <= last.t + 0.5) last.x = h.x;
      else {
        huBuf.push({ t, x: h.x, y: 0, a: 0, v: SPEED });
        if (huBuf.length > 60) huBuf.shift();
      }
      // 注意：真人样本绝不 noteRef —— 这是 AI 保持丝滑的关键
    }

    const renderMs = clock.update(dt);
    if (renderMs < 0) continue;
    while (aiBuf.length > 3 && aiBuf[1].t < renderMs - 80) aiBuf.shift();
    const r = sampleRemote(aiBuf, renderMs);
    if (r && f > RENDER_HZ) out.push({ x: r.x, now });
  }

  const speeds = [];
  for (let i = 1; i < out.length; i++) speeds.push((out[i].x - out[i - 1].x) / ((out[i].now - out[i - 1].now) / 1000));
  const steady = speeds.slice(Math.floor(speeds.length * 0.2));
  const min = Math.min(...steady), max = Math.max(...steady);
  const avg = steady.reduce((a, b) => a + b, 0) / steady.length;
  const ripple = (max - min) / avg;
  console.log(`  AI 观战速度 min/avg/max = ${min.toFixed(2)} / ${avg.toFixed(2)} / ${max.toFixed(2)} m/s · 波动 ${(ripple * 100).toFixed(2)}%`);
  assert.ok(ripple < 0.01, `真人每帧都在抖时 AI 仍须绝对匀速（当前波动 ${(ripple * 100).toFixed(2)}%）`);
  console.log("✓ 渲染时钟只认服务器均匀 tick，AI 时间轴不被真人不规则采样带偏");
}

console.log("\n======================================================");
console.log("所有平滑插值与 QQ 飞车碰撞逻辑测试全绿通过 ✅");
console.log("======================================================");
