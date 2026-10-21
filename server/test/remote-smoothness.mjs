// 端到端观战流畅度回归测试（需服务端已启动，如：PORT=8099 node index.js）
// 运行：node test/remote-smoothness.mjs
// 机器人 A（驾驶员）按 60fps 帧、固定 33.3ms 节拍上报曲线运动；
// 机器人 B（观战者）用 remoteSync + createPlayoutClock 以 144fps 渲染，
// 实测 B 眼中 A 的路径速度波动 —— 应接近恒速（这正对应"看其他玩家卡不卡"）。
import WebSocket from "ws";
import { sampleRemote, createClockOffset, createPlayoutClock } from "../../src/net/remoteSync.js";

const PORT = process.env.PORT || 8099;
const SPEED = 60;            // m/s
const RENDER_HZ = 144;
const SEND_FPS = 60;         // 驾驶端帧率（60fps 帧里以固定 33.3ms 节拍采样）

function client(tag) {
  const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
  const c = { tag, ws, msgs: [], waiters: [], onSnapshot: null };
  ws.on("message", raw => {
    const m = JSON.parse(raw.toString());
    c.msgs.push(m);
    if (m.t === "snapshot" && c.onSnapshot) c.onSnapshot(m);
    if (m.t === "peer_state" && c.onPeerState) c.onPeerState(m);
    if (m.t === "peers_bundle" && c.onPeersBundle) c.onPeersBundle(m);
    for (const w of [...c.waiters]) if (w.t === m.t && (!w.pred || w.pred(m))) {
      c.waiters.splice(c.waiters.indexOf(w), 1); w.resolve(m);
    }
  });
  c.wait = (t, pred, ms = 8000) => new Promise((res, rej) => {
    const hit = c.msgs.find(m => m.t === t && (!pred || pred(m)));
    if (hit) return res(hit);
    c.waiters.push({ t, pred, resolve: res });
    setTimeout(() => rej(new Error(tag + " 等 " + t + " 超时")), ms);
  });
  c.send = o => ws.send(JSON.stringify(o));
  c.open = new Promise(r => ws.on("open", r));
  return c;
}

const A = client("A"), B = client("B");
await Promise.all([A.open, B.open]);
A.send({ t: "hello", fingerprint: "e2e-A", nickname: "甲" });
B.send({ t: "hello", fingerprint: "e2e-B", nickname: "乙" });
const wA = await A.wait("welcome");
await B.wait("welcome");
A.send({ t: "room_create", trackId: "monza", fillAI: true });
const ru = await A.wait("room_update");
A.send({ t: "room_set", carId: "vector-pursuit" });
B.send({ t: "room_join", roomId: ru.room.id });
await A.wait("room_update", m => m.room.players.length === 2);
B.send({ t: "room_set", carId: "apex-hunter", ready: true });
await A.wait("room_update", m => m.room.players.every(p => p.carId));
A.send({ t: "room_start" });
await A.wait("race_start");
await B.wait("race_start");
await A.wait("snapshot", m => m.state === "racing", 8000);

// ---- 驾驶端：60fps 循环，固定节拍采样 + st 时间戳 ----
const startWall = performance.now();
let acc = 0, lastFrame = startWall;
A.sendTimer = setInterval(() => {
  const now = performance.now();
  acc += now - lastFrame;
  lastFrame = now;
  if (acc >= 33.33) {
    acc -= 33.33;
    if (acc > 33.33) acc = 0;
    const tSec = (now - startWall) / 1000;
    const turn = Math.sin(tSec / 3) * 0.25;   // 缓慢转向，检验角度/切线
    A.send({
      t: "car_state", st: Math.round(now * 100) / 100,
      x: Math.round(Math.cos(turn) * SPEED * tSec * 100) / 100,
      y: Math.round(Math.sin(turn) * SPEED * tSec * 100) / 100,
      angle: Math.round(turn * 10000) / 10000,
      speed: SPEED, lap: 1, rd: Math.round(SPEED * tSec),
      b: 0, u: 1, s: 0,
    });
  }
}, 1000 / SEND_FPS);

// ---- 观战端：144fps 渲染，测量 A 车的帧间速度 ----
// 与 netrace.js 同一套：渲染时钟只由快照 ts 推动，真人样本只被插值
const aSid = wA.sid;
const srvClock = createClockOffset();
const off = createClockOffset();
const clock = createPlayoutClock();
const buf = [];
let prevX = null, prevY = null, prevRender = null, lastRender = performance.now();
const speeds = [];
// 一条 A 的样本入缓冲（快照与 peer_state 两条路都走这里，与 netrace.pushSample 一致）
function feed(sc, recv) {
  if (sc.i !== aSid) return;
  const st = (typeof sc.st === "number" && sc.st > 0) ? sc.st : recv;
  const t = st + off.observe(recv, st);
  const last = buf[buf.length - 1];
  if (last && t <= last.t + 0.5) { last.x = sc.x; last.y = sc.y; last.a = sc.a; last.v = sc.v; }
  else {
    buf.push({ t, x: sc.x, y: sc.y, a: sc.a, v: sc.v });
    if (buf.length > 60) buf.shift();
  }
}

B.onSnapshot = (msg) => {
  const recv = performance.now();
  if (typeof msg.ts === "number" && msg.ts > 0) {
    clock.noteRef(msg.ts + srvClock.observe(recv, msg.ts));
  }
  for (const sc of msg.cars) feed(sc, recv);
};

// 生产路径：服务端 16ms 合包广播（peers_bundle）；旧服务端仍会发 peer_state
B.onPeersBundle = (msg) => {
  if (!Array.isArray(msg.c)) return;
  const recv = performance.now();
  for (const row of msg.c) {
    if (!row || row[0] !== aSid) continue;
    feed({ i: row[0], st: row[1], x: row[2], y: row[3], a: row[4], v: row[5] }, recv);
  }
};
B.onPeerState = (msg) => feed(msg, performance.now());
B.renderTimer = setInterval(() => {
  const now = performance.now();
  const dt = (now - lastRender) / 1000;      // 用真实流逝时间（与浏览器 rAF 一致）
  lastRender = now;
  const renderMs = clock.update(dt);
  if (renderMs < 0) return;
  while (buf.length > 3 && buf[1].t < renderMs - 80) buf.shift();
  const r = sampleRemote(buf, renderMs);
  if (!r) return;
  if (prevX != null && prevRender != null) {
    const v = Math.hypot(r.x - prevX, r.y - prevY) / ((now - prevRender) / 1000);
    if (v > 1 && v < 200) speeds.push(v);   // 排除起步/异常帧
  }
  prevX = r.x; prevY = r.y;
  prevRender = now;
}, 1000 / RENDER_HZ);

await new Promise(r => setTimeout(r, 6000));
clearInterval(A.sendTimer);
clearInterval(B.renderTimer);

const steady = speeds.slice(Math.floor(speeds.length * 0.25));
const min = Math.min(...steady), max = Math.max(...steady);
const avg = steady.reduce((a, b) => a + b, 0) / steady.length;
console.log(`实测观战速度：min ${min.toFixed(1)} / avg ${avg.toFixed(1)} / max ${max.toFixed(1)} m/s · 波动 ${((max - min) / avg * 100).toFixed(1)}% · 样本 ${steady.length} 帧`);
if (steady.length < 200) throw new Error("采样帧数不足");
if (!(avg > SPEED * 0.9 && avg < SPEED * 1.1)) throw new Error("平均速度偏离真实车速");
if ((max - min) / avg > 0.15) throw new Error("速度波动过大，观感仍然卡顿");
console.log("END-TO-END SMOOTHNESS OK ✅");
process.exit(0);
