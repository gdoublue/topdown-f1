// WS 冒烟测试：hello 握手 → 建房 → 设置车辆/ready → 房间广播
// 运行：node test/smoke-ws.mjs   （需服务端已启动在 8080）
import WebSocket from "ws";

const PORT = process.env.PORT || 8080;
const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
const log = (tag, obj) => console.log(`[${tag}]`, JSON.stringify(obj ?? null)?.slice(0, 220));

const fail = setTimeout(() => { console.error("SMOKE TEST TIMEOUT"); process.exit(1); }, 8000);

ws.on("open", () => {
  ws.send(JSON.stringify({ t: "hello", fingerprint: "smoke-ws-" + Date.now(), nickname: "SmokeBot" }));
});

let step = 0;
ws.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.t !== "welcome" && msg.t !== "room_update") return log("other", msg);
  if (msg.t === "welcome") {
    log("welcome", { playerId: msg.playerId, nickname: msg.nickname, tracks: msg.tracks.length });
    ws.send(JSON.stringify({ t: "room_create", trackId: "monza", sameCar: true }));
  } else if (msg.t === "room_update") {
    step++;
    log("room_update", msg.room);
    if (step === 1) {
      ws.send(JSON.stringify({ t: "room_set", carId: "redbull", ready: true }));
    } else if (step === 2) {
      ws.send(JSON.stringify({ t: "room_leave" }));
      // 离开后房间应被销毁（单成员空房回收），用 REST 验证
      setTimeout(async () => {
        const res = await fetch("http://localhost:8080/api/rooms");
        const { rooms } = await res.json();
        clearTimeout(fail);
        if (rooms.length === 0) {
          console.log("[rooms] 空房已回收 ✔");
          console.log("SMOKE TEST OK");
          process.exit(0);
        } else {
          console.error("[rooms] 房间未回收:", rooms);
          process.exit(1);
        }
      }, 400);
    }
  } else if (msg.t === "error") {
    log("error", msg);
    clearTimeout(fail);
    process.exit(1);
  }
});
