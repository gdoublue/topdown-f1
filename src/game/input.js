// 键盘输入
// 转向：← → 或 A D
// 油门：J（W 同样可用）
// 刹车：K 轻刹、L 重刹（重刹停稳后倒车）；刹车优先级高于油门
const keys = new Set();

export const input = {
  get up() { return keys.has("j") || keys.has("w"); },
  get brake() {
    if (keys.has("l")) return 2;              // 重刹
    if (keys.has("k") || keys.has("s")) return 1;   // 轻刹
    return 0;
  },
  get left() { return keys.has("ArrowLeft") || keys.has("a"); },
  get right() { return keys.has("ArrowRight") || keys.has("d"); }
};

export const NO_INPUT = { up: false, brake: 0, left: false, right: false };

export function initInput(onRestart) {
  window.addEventListener("keydown", function (e) {
    if (e.key === "ArrowUp" || e.key === "ArrowDown" ||
      e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === " ") {
      e.preventDefault();
    }
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    keys.add(k);
    if (k === "r" && onRestart) onRestart();
  });
  window.addEventListener("keyup", function (e) {
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    keys.delete(k);
  });
  window.addEventListener("blur", function () { keys.clear(); });
}
