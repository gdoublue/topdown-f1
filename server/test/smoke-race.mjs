// P3 冒烟测试（幽灵竞速模型）：建房 → 开赛 → car_state 上报 → race_finish → race_end
// 运行：node test/smoke-race.mjs   （需服务端已启动；SMOKE_TRACK=dragstrip 可加速）
import WebSocket from "ws";

const PORT = process.env.PORT || 8080;
const TRACK = process.env.SMOKE_TRACK || "shanghai";
const LAPS = process.env.SMOKE_LAPS || "";
const fail = setTimeout(() => { console.error("SMOKE TEST TIMEOUT"); process.exit(1); }, 240000);

let sid = null;
let snaps = 0;
let carMoves = false;
let gotRaceStart = false;
let gotRaceEnd = false;
let reported = false;

const ws = new WebSocket(`ws://localhost:${PORT}/ws`);

ws.on("open", () => {
  ws.send(JSON.stringify({ t: "hello", fingerprint: "smoke-race-" + Date.now(), nickname: "RacerBot" }));
});

ws.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.t === "welcome") {
    sid = msg.sid;
    console.log("[welcome] sid =", sid, "| 昵称 =", msg.nickname);
    ws.send(JSON.stringify({ t: "room_create", trackId: TRACK, sameCar: true }));
  } else if (msg.t === "room_update" && !gotRaceStart) {
    ws.send(JSON.stringify({ t: "room_set", carId: "mercedes-w15", ready: true }));
    setTimeout(() => ws.send(JSON.stringify({ t: "room_start", laps: LAPS || undefined })), 300);
  } else if (msg.t === "race_start") {
    gotRaceStart = true;
    console.log("[race_start] 赛道 =", msg.trackId, "| 圈数 =", msg.laps, "| 参赛 =", msg.cars.map(c => c.shortName).join(", "));
    // 幽灵模型：本地模拟，12Hz 上报状态（直线赛道全油门直线跑）
    let x = 90, rd = 12;
    const stateTimer = setInterval(() => {
      if (!gotRaceStart || ws.readyState !== 1 || reported) return;
      x += 80; rd += 80;
      ws.send(JSON.stringify({ t: "car_state", x, y: 470, angle: 0, speed: 100, lap: 1, rd, fin: 0, tot: 0, best: 0 }));
    }, 80);
    // 10 秒后上报完赛（本地计时成绩）
    setTimeout(() => {
      clearInterval(stateTimer);
      reported = true;
      ws.send(JSON.stringify({ t: "race_finish", totalMs: 68000, bestLapMs: 68000, laps: 1 }));
      console.log("[race_finish] 已上报本地成绩 (68.0s)");
    }, 10000);
  } else if (msg.t === "snapshot") {
    snaps++;
    const me = msg.cars.find(c => c.i === sid);
    if (me && rd_last !== me.rd && me.rd > rd_last) carMoves = true;
    if (me) rd_last = me.rd;
    if (snaps === 1) console.log("[snapshot#1] state =", msg.state, "| 车辆数 =", msg.cars.length);
    if (snaps % 300 === 0) console.log(`[snapshot#${snaps}] state =`, msg.state, "| 我的进度 rd =", me?.rd, "| fin =", me?.fin);
  } else if (msg.t === "race_end") {
    gotRaceEnd = true;
    console.log("[race_end] 排名:");
    for (const r of msg.results) console.log(`   P${r.rank} ${r.nickname} (${r.shortName}) total=${(r.totalMs/1000).toFixed(1)}s best=${(r.bestLapMs/1000).toFixed(1)}s laps=${r.laps} fin=${r.finished} valid=${r.valid}`);
    clearTimeout(fail);
    console.log("\nSMOKE TEST " + (snaps > 40 && carMoves ? "OK" : "FAILED") + ` (snapshots=${snaps}, ghostMoved=${carMoves})`);
    process.exit(0);
  } else if (msg.t === "error") {
    if (msg.code === "already_racing") return;
    console.error("[error]", msg);
    clearTimeout(fail);
    process.exit(1);
  }
});

let rd_last = -1;
