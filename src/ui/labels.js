// 车手 / 车队 / 车型的统一显示名：计时塔、遥测条、结算与在线榜单共用一套规则。
// 在线对局里 shortName 是服务器下发的车型字符串，nickname 才是玩家名，不能混用。

function stripDriverName(name) {
  return String(name || "").replace(/\s*\([^)]*\)\s*$/, "").trim();
}

export function driverLabel(car) {
  if (!car) return "车手";
  if (car.isPlayer) return car.nickname || "你";
  if (car.isAI && car.driverShort) return car.driverShort;
  return car.nickname || car.driverShort || stripDriverName(car.driverName) || car.shortName || "车手";
}

export function driverCode(car) {
  if (!car || car.isPlayer) return "";
  if (car.driverCode) return String(car.driverCode).toUpperCase();
  const m = String(car.driverName || "").match(/\(([A-Z]{2,4})/);
  return m ? m[1] : "";
}

export function carModelLabel(car) {
  if (!car) return "";
  const parts = [car.team, car.model].filter(Boolean);
  if (parts.length) return parts.join(" · ");
  return car.shortName || car.name || "";
}

export function carNumberLabel(car) {
  return car && car.number ? `#${car.number}` : "";
}

export function isAICar(car) {
  return !!(car && car.isAI);
}
