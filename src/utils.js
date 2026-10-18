// 通用小工具
export const TAU = Math.PI * 2;

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

// 圆角矩形路径（只构建路径，不填充）
export function rrect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

// 确定性伪随机（保证每次生成一致）
export function makeRandom(seed) {
  let s = seed;
  return function () {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
}
