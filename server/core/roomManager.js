// 房间管理器：创建 / 加入 / 离开 / 广播 / 空房回收
import { SERVER_CONFIG } from "../config.js";
import { Room } from "./room.js";

const rooms = new Map();
export { rooms };   // gateway 的模拟主循环需要枚举所有房间

export function createRoom(session, opts = {}) {
  if (rooms.size >= SERVER_CONFIG.maxRooms) return { ok: false, reason: "server_full" };
  const room = new Room(session, opts);
  rooms.set(room.id, room);
  room.addMember(session);
  return { ok: true, room };
}

export function getRoom(roomId) {
  return rooms.get(roomId) || null;
}

export function listRooms() {
  return [...rooms.values()]
    .filter(r => r.state === "lobby" || r.state === "racing")   // 大厅只展示可加入/可观的房间
    .map(r => r.view());
}

export function joinRoom(session, roomId) {
  const room = rooms.get(roomId);
  if (!room) return { ok: false, reason: "room_not_found" };
  const res = room.addMember(session);
  return res.ok ? { ok: true, room } : res;
}

export function leaveRoom(session, roomId) {
  const room = rooms.get(roomId);
  if (!room) return { ok: false, reason: "room_not_found" };
  room.removeMember(session.id);
  if (room.members.size === 0) {
    rooms.delete(roomId);
    return { ok: true, room, destroyed: true };
  }
  return { ok: true, room, destroyed: false };
}

export function findRoomOf(sessionId) {
  for (const room of rooms.values()) {
    if (room.members.has(sessionId)) return room;
  }
  return null;
}

// 会话断开时：从所在房间移除并广播
export function handleDisconnect(session, broadcast) {
  const room = findRoomOf(session.id);
  if (!room) return null;
  room.removeMember(session.id);
  if (room.members.size === 0) {
    rooms.delete(room.id);
    return { room, destroyed: true };
  }
  broadcast(room, "room_update", { room: room.view() });
  return { room, destroyed: false };
}
