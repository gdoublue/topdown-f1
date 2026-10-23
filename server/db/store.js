// 数据持久化适配层：当前用 JSON 文件实现（零依赖、Windows 友好），
// 接口按表设计，后续可无缝替换为 better-sqlite3（表结构见本文件底部注释）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "gp.json");
const BACKUP_DIR = path.join(DATA_DIR, "backups");
const BACKUP_KEEP = 7;

const EMPTY = {
  meta: { version: 1, createdAt: Date.now() },
  players: [],        // { id, fingerprint, nickname, firstSeen, lastSeen, races, wins }
  lapRecords: [],     // { id, playerId, trackId, carId, bestLapMs, totalMs, laps, source, validated, createdAt }
};

let db = null;
let saveTimer = null;
let writing = false;
let writeQueued = false;
let backedUpDay = "";

function readDbFile(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function latestBackup() {
  try {
    const files = fs.readdirSync(BACKUP_DIR)
      .filter(f => /^gp-\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .sort()
      .reverse();
    for (const f of files) {
      const parsed = readDbFile(path.join(BACKUP_DIR, f));
      if (parsed) return parsed;
    }
  } catch { /* 没有备份目录 */ }
  return null;
}

export function loadDb() {
  if (db) return db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const existed = fs.existsSync(DB_FILE);
  let parsed = existed ? readDbFile(DB_FILE) : null;
  let recovered = false;
  if (!parsed && existed) {
    // 主库损坏：留存现场，尝试从最近备份恢复；没有备份才从空库开始
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    try {
      fs.renameSync(DB_FILE, `${DB_FILE}.corrupt-${stamp}`);
      console.error("[store] 数据库损坏，原文件已留存:", `${DB_FILE}.corrupt-${stamp}`);
    } catch (e) {
      console.error("[store] 数据库损坏且无法留存现场:", e.message);
    }
    parsed = latestBackup();
    recovered = !!parsed;
    if (recovered) console.warn("[store] 已从最近备份恢复");
  }
  db = parsed || structuredClone(EMPTY);
  // 补齐缺失表（版本演进兜底）
  for (const k of Object.keys(EMPTY)) if (db[k] == null) db[k] = structuredClone(EMPTY[k]);
  if (!Array.isArray(db.players)) db.players = [];
  if (!Array.isArray(db.lapRecords)) db.lapRecords = [];
  if (recovered) flushDbSync();   // 恢复出来的数据立刻写回主库
  return db;
}

// 防抖落盘：500ms 内的多次变更合并成一次异步全量写，避免阻塞事件循环
export function saveDb() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void flushDb();
  }, 500);
}

export async function flushDb() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  if (!db) return;
  if (writing) { writeQueued = true; return; }   // 写盘期间的变更合并到下一轮
  writing = true;
  try {
    const snapshot = JSON.stringify(db);   // 同步取快照，避免写盘途中对象被改
    const tmp = DB_FILE + ".tmp";
    await fs.promises.writeFile(tmp, snapshot);
    await fs.promises.rename(tmp, DB_FILE);   // 原子替换，避免写一半损坏
    await backupDaily();
  } catch (e) {
    console.error("[store] 保存失败:", e.message);
  } finally {
    writing = false;
    if (writeQueued) {
      writeQueued = false;
      saveDb();
    }
  }
}

// 同步落盘：只给进程退出用，保证 exit(0) 前数据确实写完
export function flushDbSync() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  if (!db) return;
  try {
    const tmp = DB_FILE + ".shutdown.tmp";   // 与异步写分开，避免两个写者抢同一个 tmp
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, DB_FILE);
  } catch (e) {
    console.error("[store] 保存失败:", e.message);
  }
}

// 每日备份一份完整库，保留最近 7 天；已有当天备份时不覆盖
async function backupDaily() {
  const day = new Date().toISOString().slice(0, 10);
  if (backedUpDay === day) return;
  backedUpDay = day;
  try {
    await fs.promises.mkdir(BACKUP_DIR, { recursive: true });
    const dest = path.join(BACKUP_DIR, `gp-${day}.json`);
    if (!readDbFile(dest)) await fs.promises.copyFile(DB_FILE, dest);
    const files = (await fs.promises.readdir(BACKUP_DIR))
      .filter(f => /^gp-\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .sort()
      .reverse();
    for (const f of files.slice(BACKUP_KEEP)) {
      await fs.promises.unlink(path.join(BACKUP_DIR, f)).catch(() => {});
    }
  } catch (e) {
    console.error("[store] 备份失败:", e.message);
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
