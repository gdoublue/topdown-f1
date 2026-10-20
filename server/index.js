// 服务端入口：HTTP (REST API) + WebSocket 网关
// REST:
//   GET  /api/health                 健康检查
//   GET  /api/leaderboard/:trackId   某赛道排行榜
//   POST /api/leaderboard            在线单人练习成绩提交 { fingerprint, trackId, carId, bestLapMs, totalMs, laps }
//   GET  /api/rooms                  房间列表
import http from "node:http";
import { SERVER_CONFIG } from "./config.js";
import { loadDb, flushDb } from "./db/store.js";
import { registerPlayer } from "./core/session.js";
import { submitLapRecord, getLeaderboardView } from "./services/leaderboard.js";
import { listRooms } from "./core/roomManager.js";
import { attachGateway, broadcastBoards } from "./net/gateway.js";

loadDb();

const server = http.createServer((req, res) => {
  // 开发期 CORS：vite (5173) 直连本服务
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, "http://localhost");
  const json = (code, obj) => {
    res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(obj));
  };

  if (req.method === "GET" && url.pathname === "/api/health") {
    return json(200, { ok: true, uptime: process.uptime(), protocol: 1 });
  }

  if (req.method === "GET" && url.pathname.startsWith("/api/leaderboard/")) {
    const trackId = url.pathname.split("/")[3];
    return json(200, { trackId, entries: getLeaderboardView(trackId, { limit: 20 }) });
  }

  if (req.method === "POST" && url.pathname === "/api/leaderboard") {
    let body = "";
    req.on("data", c => { body += c; if (body.length > 64 * 1024) req.destroy(); });
    req.on("end", () => {
      try {
        const d = JSON.parse(body);
        const { player } = registerPlayer(d.fingerprint, d.nickname);
        const rec = submitLapRecord({
          playerId: player.id, trackId: d.trackId, carId: d.carId,
          bestLapMs: d.bestLapMs, totalMs: d.totalMs, laps: d.laps,
          source: "solo_practice",
        });
        json(200, { ok: true, validated: !!rec.validated, recordId: rec.id });
        // 新成绩写入 → 在线用户的排行榜即时刷新
        if (rec.validated) broadcastBoards(d.trackId);
      } catch (e) {
        json(400, { ok: false, error: e.message });
      }
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/rooms") {
    return json(200, { rooms: listRooms() });
  }

  json(404, { error: "not_found" });
});

attachGateway(server);

server.listen(SERVER_CONFIG.port, () => {
  console.log(`🏁 Top-down F1 server listening on http://localhost:${SERVER_CONFIG.port}`);
  console.log(`   WS: ws://localhost:${SERVER_CONFIG.port}${SERVER_CONFIG.wsPath}`);
});

// 优雅关闭：确保防抖中的数据落盘
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    console.log(`\n[${sig}] 保存数据并关闭…`);
    flushDb();
    process.exit(0);
  });
}
