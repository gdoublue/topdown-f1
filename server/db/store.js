// 数据持久化适配层：当前用 JSON 文件实现（零依赖、Windows 友好），
// 接口按表设计，后续可无缝替换为 better-sqlite3（表结构见本文件底部注释）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "gp.json");

const EMPTY = {
  meta: { version: 1, createdAt: Date.now() },
  players: [],        // { id, fingerprint, nickname, firstSeen, lastSeen, races, wins }
  lapRecords: [],     // { id, playerId, trackId, carId, bestLapMs, totalMs, laps, source, validated, createdAt }
};

let db = null;
let saveTimer = null;

export function loadDb() {
  if (db) return db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  try {
    db = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  } catch {
    db = structuredClone(EMPTY);
  }
  // 补齐缺失表（版本演进兜底）
  for (const k of Object.keys(EMPTY)) if (db[k] == null) db[k] = structuredClone(EMPTY[k]);
  return db;
}

// 防抖落盘：高频提交成绩时不阻塞事件循环
export function saveDb() {
  if (saveTimer) return;
  saveTimer = setTimeout(flushDb, 500);
}

// 立即落盘（优雅关闭 / 关键节点调用）
export function flushDb() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  if (!db) return;
  try {
    const tmp = DB_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, DB_FILE);   // 原子替换，避免写一半损坏
  } catch (e) {
    console.error("[store] 保存失败:", e.message);
  }
}

/*
== 未来切换 better-sqlite3 时的表结构（schema.sql）==
CREATE TABLE players (
  id TEXT PRIMARY KEY, fingerprint TEXT UNIQUE, nickname TEXT,
  first_seen INTEGER, last_seen INTEGER, races INTEGER DEFAULT 0, wins INTEGER DEFAULT 0
);
CREATE TABLE lap_records (
  id TEXT PRIMARY KEY, player_id TEXT, track_id TEXT, car_id TEXT,
  best_lap_ms INTEGER, total_ms INTEGER, laps INTEGER,
  source TEXT, validated INTEGER DEFAULT 1, created_at INTEGER
);
CREATE INDEX idx_lap_records_board ON lap_records(track_id, best_lap_ms);
CREATE TABLE race_results (
  id TEXT PRIMARY KEY, room_id TEXT, track_id TEXT, player_id TEXT,
  rank INTEGER, total_ms INTEGER, best_lap_ms INTEGER, created_at INTEGER
);
CREATE TABLE driver_scripts (
  id TEXT PRIMARY KEY, player_id TEXT, name TEXT, version INTEGER,
  code TEXT, status TEXT DEFAULT 'active', created_at INTEGER
);
*/
