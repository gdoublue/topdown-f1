// 树木布局：纯数据（不碰 three），渲染（props.buildTrees）与无头调试脚本
// （scripts/track-debug.mjs）共用同一份位置与净空检查，避免"脚本看着没问题、画面里树却长在路上"。
import { pts, N, nor, hw, isLinear } from "../../track/geometry.js";
import { hash01 } from "./shared.js";

export const TREE_CLEARANCE = 8;   // 树冠最大半径 3m + 5m 安全余量

/* 赛道净空查询：候选点到中心线折线的最小距离，减去该处半宽（含路肩）。
   必须逐段精确计算 —— 按每几个采样点抽查（间隔 20m+）时，折返弯/发夹弯
   两段赛道靠得很近，点会从采样空隙"漏"过去，树就长到路面上了。 */
export function makeTrackClearance() {
  const segCount = isLinear ? N - 1 : N;   // 闭合赛道补上末段（N-1 → 0）
  const ax = new Float64Array(segCount), az = new Float64Array(segCount);
  const vx = new Float64Array(segCount), vz = new Float64Array(segCount);
  const invL2 = new Float64Array(segCount), edge = new Float64Array(segCount);
  for (let j = 0; j < segCount; j++) {
    const a = pts[j], b = pts[(j + 1) % N];
    const dx = b.x - a.x, dz = b.y - a.y;
    ax[j] = a.x; az[j] = a.y;
    vx[j] = dx; vz[j] = dz;
    const l2 = dx * dx + dz * dz;
    invL2[j] = l2 > 1e-9 ? 1 / l2 : 0;
    edge[j] = Math.max(hw[j], hw[(j + 1) % N]) + 1.5;   // 半宽 + 路缘石
  }
  return (x, z) => {
    let best = Infinity;
    for (let j = 0; j < segCount; j++) {
      let t = ((x - ax[j]) * vx[j] + (z - az[j]) * vz[j]) * invL2[j];
      if (t < 0) t = 0; else if (t > 1) t = 1;
      const dx = x - (ax[j] + vx[j] * t);
      const dz = z - (az[j] + vz[j] * t);
      const clear = Math.sqrt(dx * dx + dz * dz) - edge[j];
      if (clear < best) best = clear;
    }
    return best;
  };
}

/**
 * 生成树木位置。density > 1 时围绕种子点做确定性抖动，抖动后同样过净空检查。
 * @returns {{ spots: Array<[number, number, number]>, seeds: number }}
 *   spots: [x, z, r]（r ∈ [0,1) 决定树高/树冠与配色）
 */
export function layoutTrees(opts = {}) {
  const clearanceAt = makeTrackClearance();

  const seeds = [];
  const step = 5;
  for (let i = 0; i < N; i += step) {
    for (const side of [1, -1]) {
      if (hash01(i, side) > 0.62) continue;
      const off = hw[i] + 16 + hash01(i, side * 3) * 46;
      const x = pts[i].x + nor[i].x * side * off;
      const z = pts[i].y + nor[i].y * side * off;
      seeds.push([x, z, hash01(i, side * 7)]);
    }
  }

  const target = Math.min(Math.round(seeds.length * (opts.treeDensity ?? 1)), opts.treeCap ?? 420);
  const spots = [];
  const maxTries = target * 8 + 128;
  for (let k = 0; spots.length < target && k < maxTries; k++) {
    const seed = seeds[k % seeds.length];
    let x = seed[0], z = seed[1];
    if (k >= seeds.length) {
      const ang = hash01(k, 31) * Math.PI * 2;
      const rad = 4 + hash01(k, 47) * 14;
      x += Math.cos(ang) * rad;
      z += Math.sin(ang) * rad;
    }
    if (clearanceAt(x, z) < TREE_CLEARANCE) continue;
    spots.push([x, z, seed[2]]);
  }
  return { spots, seeds: seeds.length };
}
