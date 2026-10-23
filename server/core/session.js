// 玩家指纹会话：识别 / 注册 / 昵称管理
// 指纹由客户端采集（canvas/UA/屏幕/硬件并发等加权哈希）后上传，
// 服务端加盐二次哈希后作为玩家身份键。指纹会漂移（浏览器升级），
// 因此采用"同指纹合并"策略即可，后续可加模糊匹配（同 IP + 相似分量）。
import crypto from "node:crypto";
import { loadDb, saveDb } from "../db/store.js";

function saltedHash(fingerprint) {
  return crypto
    .createHash("sha256")
    .update(fingerprint + process.env.SESSION_SALT, "utf8")
    .digest("hex")
    .slice(0, 32);
}

function newId(prefix) {
  return prefix + "_" + crypto.randomBytes(8).toString("hex");
}

// 玩家表上限：唯一指纹可以无限刷，必须有硬上限。
// 到顶后优先淘汰"没有成绩、没有胜场"的最久未活跃玩家；腾不出位置就拒绝新玩家。
const MAX_PLAYERS = 10000;
const PLAYER_EVICT_RATIO = 0.9;

function ensurePlayerCapacity(db) {
  if (db.players.length < MAX_PLAYERS) return true;
  const withRecords = new Set(db.lapRecords.map(r => r.playerId));
  const removable = db.players
    .filter(p => !withRecords.has(p.id) && !p.wins && !p.races)
    .sort((a, b) => (a.lastSeen || 0) - (b.lastSeen || 0));
  const target = Math.floor(MAX_PLAYERS * PLAYER_EVICT_RATIO);
  const need = db.players.length - target + 1;   // 腾出的位置要能容纳本次新玩家
  if (removable.length < need) return false;
  const drop = new Set(removable.slice(0, need).map(p => p.id));
  db.players = db.players.filter(p => !drop.has(p.id));
  return true;
}

// 没填昵称时的默认昵称：友好的随机车手名（不再用指纹前缀拼 "Pilot-xxxx"，
// 那种看着就像浏览器签名，房间里别人根本认不出是谁）
const NICK_POOL = ["闪电", "追风", "弯心", "涡轮", "夜行", "漂移", "雷霆", "赤焰", "疾风", "超车"];
function randomNickname() {
  return NICK_POOL[Math.floor(Math.random() * NICK_POOL.length)] + "-" + crypto.randomInt(10, 99);
}

// 注册或识别玩家；返回 { player, created }
export function registerPlayer(fingerprint, nickname) {
  const db = loadDb();
  const raw = String(fingerprint || "").slice(0, 256);
  if (!raw) throw new Error("invalid fingerprint");
  const fp = saltedHash(raw);

  let player = db.players.find(p => p.fingerprint === fp);
  let created = false;
  if (!player) {
    if (!ensurePlayerCapacity(db)) throw new Error("player_capacity");
    player = {
      id: newId("plr"),
      fingerprint: fp,
      nickname: sanitizeNickname(nickname) || randomNickname(),
      firstSeen: Date.now(),
      lastSeen: Date.now(),
      races: 0,
      wins: 0,
    };
    db.players.push(player);
    created = true;
    saveDb();
  } else {
    player.lastSeen = Date.now();
    if (nickname) player.nickname = sanitizeNickname(nickname);
    saveDb();
  }
  return { player, created };
}

export function getPlayer(playerId) {
  return loadDb().players.find(p => p.id === playerId) || null;
}

export function countRaceFinish(playerId, won = false) {
  const db = loadDb();
  const p = db.players.find(x => x.id === playerId);
  if (!p) return;
  p.races += 1;
  if (won) p.wins += 1;
  saveDb();
}

export function sanitizeNickname(name) {
  if (!name) return "";
  return String(name).replace(/[\\/:*?"<>|]/g, "").trim().slice(0, 16);
}
