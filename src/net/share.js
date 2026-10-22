// 房间分享链接：游戏站点（明文）+ 服务器地址与房间号（加密 token）
//  · 链接形如：https://hw.066808.xyz:8080/#/join?h=<游戏 URL>&k=<token>
//  · h 是明文（对方能看清是哪个游戏站点），k 里带 ws 服务器地址与房间号，
//    经过 XOR + base64url 处理，不是明文 —— 目的只是"别让链接里直接暴露服务器地址"，
//    属于轻量混淆，不是安全加密。
import { conn } from "./connection.js";

const SHARE_KEY = "tdgp-share-v1";

function b64urlFromBytes(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function bytesFromB64url(str) {
  const s = String(str || "").replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4 ? "=".repeat(4 - (s.length % 4)) : "";
  const raw = atob(s + pad);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

// 对称：加密 / 解密同一套操作
function xorInPlace(bytes) {
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] ^= SHARE_KEY.charCodeAt(i % SHARE_KEY.length) ^ ((i * 37) & 0xff);
  }
}

export function encodeShareToken(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  xorInPlace(bytes);
  return b64urlFromBytes(bytes);
}

export function decodeShareToken(token) {
  try {
    const bytes = bytesFromB64url(token);
    xorInPlace(bytes);
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

// 当前游戏站点（明文 URL，去掉 hash / query）
export function gameShareUrl() {
  return location.origin + location.pathname;
}

export function buildShareLink(roomId) {
  const game = gameShareUrl();
  const token = encodeShareToken({ s: conn.url || "", r: roomId || "" });
  return `${game}#/join?h=${encodeURIComponent(game)}&k=${token}`;
}

// 当前地址里是否有邀请参数（#/join?h=...&k=...）
export function readShareInvite() {
  const hash = location.hash || "";
  if (!/^#\/join\b/.test(hash)) return null;
  const q = hash.indexOf("?");
  if (q < 0) return null;
  const params = new URLSearchParams(hash.slice(q + 1));
  const k = params.get("k");
  if (!k) return null;
  return { h: params.get("h") || "", k };
}
