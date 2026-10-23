// 房间管理器：创建 / 加入 / 离开 / 广播 / 空房回收
import { SERVER_CONFIG } from "../config.js";
import { Room } from "./room.js";

const rooms = new Map();
export { rooms };   // gateway 的模拟主循环需要枚举所有房间

export function createRoom(session, opts = {}) {
  if (findRoomOf(session.id)) return { ok: false, reason: "already_in_room" };
  if (rooms.size >= SERVER_CONFIG.maxRooms) return { ok: false, reason: "server_full" };
  const room = new Room(session, opts);
  rooms.set(room.id, room);
  const res = room.addMember(session);
  if (!res.ok) {
    rooms.delete(room.id);   // 成员没加进去：不能留下空壳房
    return { ok: false, reason: res.reason };
  }
  return { ok: true, room, spectating: !!res.spectating };
}

export function getRoom(roomId) {
  return rooms.get(roomId) || null;
}

export function listRooms() {
  return [...rooms.values()]
    .filter(r => r.state === "lobby" || r.state === "racing")   // 大厅只展示可加入/可观的房间
    .map(r => r.view());
}

// opts.spectate：显式要求观赛；比赛进行中无论是否传都会按观赛身份加入
export function joinRoom(session, roomId, opts = {}) {
  // 一个连接只能在一个房间里：重复加入同一间按幂等处理，换房必须先离开
  const current = findRoomOf(session.id);
  if (current) {
    if (current.id === roomId) {
      const member = current.members.get(session.id);
      return { ok: true, room: current, spectating: !!member?.spectating, alreadyIn: true };
    }
    return { ok: false, reason: "already_in_room" };
  }
  const room = rooms.get(roomId);
  if (!room) return { ok: false, reason: "room_not_found" };
  const res = room.addMember(session, opts);
  return res.ok ? { ok: true, room, spectating: !!res.spectating } : res;
}

export function leaveRoom(session, roomId) {
  const room = rooms.get(roomId);
  if (!room) return { ok: false, reason: "room_not_found" };
  // 先取出身份再删：观赛者离开要单独播一条"离开观赛"提示
  const wasSpectating = !!room.members.get(session.id)?.spectating;
  room.removeMember(session.id);
  if (room.members.size === 0) {
    rooms.delete(roomId);
    return { ok: true, room, destroyed: true, wasSpectating };
  }
  return { ok: true, room, destroyed: false, wasSpectating };
}

export function findRoomOf(sessionId) {
  for (const room of rooms.values()) {
    if (room.members.has(sessionId)) return room;
  }
  return null;
}

// 会话断开时：从**所有**房间移除（正常情况只有一间，遍历是为了兜住历史脏状态），
// 返回每个受影响房间的结果，供网关逐间处理判负 / 观赛提示 / 结算。
export function removeSessionEverywhere(session, broadcast) {
  const affected = [];
  for (const [roomId, room] of rooms) {
    const member = room.members.get(session.id);
    if (!member) continue;
    const wasSpectating = !!member.spectating;
    room.removeMember(session.id);
    if (room.members.size === 0) {
      rooms.delete(roomId);
      affected.push({ room, destroyed: true, wasSpectating });
    } else {
      broadcast(room, "room_update", { room: room.view() });
      affected.push({ room, destroyed: false, wasSpectating });
    }
  }
  return affected;
}
