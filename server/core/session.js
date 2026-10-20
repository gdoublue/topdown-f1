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

// 没填昵称时的默认昵称：友好的随机车手名（不再用指纹前缀拼 "Pilot-xxxx"，
// 那种看着就像浏览器签名，房间里别人根本认不出是谁）
const NICK_POOL = ["闪电", "追风", "弯心", "涡轮", "夜行", "漂移", "雷霆", "赤焰", "疾风", "超车"];
function randomNickname() {
  return NICK_POOL[Math.floor(Math.random() * NICK_POOL.length)] + "-" + crypto.randomInt(10, 99);
}

// 注册或识别玩家；返回 { player, created }
export function registerPlayer(fingerprint, nickname) {
  const db = loadDb();
  const fp = saltedHash(String(fingerprint || ""));
  if (!fp || fp.length < 8) throw new Error("invalid fingerprint");

  let player = db.players.find(p => p.fingerprint === fp);
  let created = false;
  if (!player) {
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
