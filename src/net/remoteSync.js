// 远端实体同步核心（纯函数，无 DOM / 无依赖，便于单测与复用）
//
// 时间轴约定：所有样本时间 t 都是"本机单调时钟毫秒"（performance.now 同一时间轴）。
//   · 渲染时钟的唯一驱动源 = 服务端快照时间戳 ts（均匀 30Hz tick 逻辑时钟）：
//     用最小 (到达时刻 − ts) 锁定偏移，之后按本机 dt 恒速推进，任何实体样本都推不动它。
//   · AI 样本 st 与 ts 同源（服务器 tick），天然落在均匀网格上，插值即匀速。
//   · 真人样本 st 来自发送端本机帧，用"该实体的最小延迟"换算成本机时钟时刻：
//     真实采样间隔被完整保留（不被 33ms 网格量化），但绝不参与时钟推进。

// 样本缓冲里二分定位 t 所在区间：返回 i，使 buf[i].t <= t <= buf[i+1].t
export function findSpan(buf, t) {
  let lo = 0, hi = buf.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (buf[mid].t <= t) lo = mid; else hi = mid;
  }
  return lo;
}

// 在时间轴上解算远端位姿：
//  · 区间内：非均匀 Catmull-Rom（切线取相邻样本差分）→ 关键帧处速度连续，无"快慢交替"
//  · 超出末样本：按末样本航向/速度直线外推（最多 maxExtrapMs），宁可视差也不急刹
// 返回 { x, y, a, v, extrapolated }
export function sampleRemote(buf, tMs, maxExtrapMs = 250) {
  const n = buf.length;
  if (n === 0) return null;
  const first = buf[0];
  const last = buf[n - 1];

  if (n === 1 || tMs <= first.t) {
    return { x: first.x, y: first.y, a: first.a, v: first.v, extrapolated: false };
  }
  if (tMs >= last.t) {
    const dtSec = Math.min(maxExtrapMs / 1000, (tMs - last.t) / 1000);
    return {
      x: last.x + Math.cos(last.a) * last.v * dtSec,
      y: last.y + Math.sin(last.a) * last.v * dtSec,
      a: last.a,
      v: last.v,
      extrapolated: true,
    };
  }

  const i = findSpan(buf, tMs);
  const s0 = buf[i], s1 = buf[i + 1];
  const span = Math.max(1, s1.t - s0.t);
  const u = Math.min(1, Math.max(0, (tMs - s0.t) / span));
  const u2 = u * u, u3 = u2 * u;

  // 非均匀 Catmull-Rom：m = 相邻两点速度 × 本段时长（端点缺邻居时退化为该段弦）
  const sPrev = buf[i - 1] || s0;
  const sNext = buf[i + 2] || s1;
  const invPrev = span / Math.max(1, s1.t - sPrev.t);
  const invNext = span / Math.max(1, sNext.t - s0.t);
  const m0x = (s1.x - sPrev.x) * invPrev;
  const m0y = (s1.y - sPrev.y) * invPrev;
  const m1x = (sNext.x - s0.x) * invNext;
  const m1y = (sNext.y - s0.y) * invNext;

  const h00 = 2 * u3 - 3 * u2 + 1;
  const h10 = u3 - 2 * u2 + u;
  const h01 = -2 * u3 + 3 * u2;
  const h11 = u3 - u2;

  let dA = s1.a - s0.a;
  while (dA > Math.PI) dA -= Math.PI * 2;
  while (dA < -Math.PI) dA += Math.PI * 2;

  return {
    x: h00 * s0.x + h10 * m0x + h01 * s1.x + h11 * m1x,
    y: h00 * s0.y + h10 * m0y + h01 * s1.y + h11 * m1y,
    a: s0.a + dA * u,
    v: s0.v + (s1.v - s0.v) * u,
    extrapolated: false,
  };
}

// 时钟偏移估计：观测值 obs = 到达时刻 - 采样时刻 = 真实时钟差 + 本次网络延迟，
// 取历史最小值即"真实时钟差 + 最小网络延迟"→ 天然剔除网络抖动。
// 每次只允许极缓慢上浮，容忍两端时钟漂移。
export function nextOffset(prev, recvAt, st) {
  const obs = recvAt - st;
  if (prev == null) return obs;
  if (obs < prev) return obs;
  return prev + 0.005;   // 每样本 5µs，约 0.15ms/s，仅用于吸收两端时钟的微小漂移
}

// 时钟偏移锁定器："锁一次，不随包跳变"
//
// 为什么不能一直用 nextOffset：最小值滤波在热机阶段会不断刷新出更小的观测值，
// 每次刷新都会让已入缓冲的样本时刻整体前移一点 —— 样本间隔因此被压缩/拉伸，
// 插值出来的速度就会一快一慢（这正是"看别人像 PPT"的元凶之一）。
// 所以：热机阶段（前 warmup 个包）取最小值快速收敛，之后【冻结】偏移，
// 让样本时刻间隔严格等于发送端真实采样间隔 —— 匀速的前提。
// 唯一例外：观测值比锁定值小 80ms 以上（说明热机时链路异常、锁偏了），重新锁定。
export function createClockOffset({ warmup = 40, relockMs = 80 } = {}) {
  const s = { off: null, n: 0 };
  return {
    get value() { return s.off; },
    get locked() { return s.off != null && s.n >= warmup; },
    reset() { s.off = null; s.n = 0; },
    observe(recvAt, st) {
      const obs = recvAt - st;
      if (s.off == null) { s.off = obs; s.n = 1; return s.off; }
      if (s.n < warmup) {
        s.n++;
        if (obs < s.off) s.off = obs;
        return s.off;
      }
      if (obs < s.off - relockMs) { s.off = obs; s.n = warmup; }
      return s.off;
    },
  };
}

// 渲染时钟：固定延时播放缓冲（FPS 式 Interpolation Buffer）
//
// 与自适应缓冲的关键差别：时钟**只认均匀参考轴**（服务端快照时间戳 ts），
// 绝不"死追"任何一辆车的样本 —— 真人采样间隔 15~79ms 天生不均匀，
// 一旦让它去推时钟，AI 的均匀样本也会被这口晃动的钟带得一起抖。
//
// 稳态行为：目标 = 最新参考时刻 − delayMs，目标是 33.3ms 的阶梯；
// 本机时钟恒速 1.0 自由推进时，err 在 [0, 33.3] 内锯齿摆动，
// 死区（默认 60ms > 一个 tick）内一次修正都不做 —— 渲染速度绝对恒定。
// 只有真实漂移（服务器掉速 / 长卡顿 / 时钟偏差）才用 ≤4% 的速率把水位拉回。
export function createPlayoutClock({ delayMs = 120, deadBandMs = 60 } = {}) {
  const s = { renderMs: -1, refMs: -1, delayMs, deadBandMs };

  return {
    get renderMs() { return s.renderMs; },
    get delayMs() { return s.delayMs; },
    get latestSampleMs() { return s.refMs; },   // 兼容旧命名：最新参考时刻

    reset() {
      s.renderMs = -1;
      s.refMs = -1;
    },

    // 均匀参考轴（本机时钟毫秒）。单调不回退：网络只会让包迟到，不会让时间倒流。
    noteRef(localMs) {
      if (localMs > s.refMs) s.refMs = localMs;
    },

    // 兼容入口：把样本时刻直接当参考轴（单测 / 无服务端时间戳的退化路径）
    noteSample(t) {
      if (t > s.refMs) s.refMs = t;
    },

    update(dt) {
      if (s.refMs < 0) return s.renderMs;
      const target = s.refMs - s.delayMs;
      if (s.renderMs < 0) { s.renderMs = target; return s.renderMs; }

      // err > 0：时钟落后（延时变多、画得更旧） · err < 0：时钟超前（有断流风险）
      const err = target - s.renderMs;
      if (Math.abs(err) > 300) {          // 重连 / 长时间切后台：直接对齐
        s.renderMs = target;
        return s.renderMs;
      }
      let rate = 1.0;
      const d = s.deadBandMs;
      if (err > d) rate = 1 + Math.min(0.04, (err - d) * 0.00025);
      else if (err < -d) rate = 1 - Math.min(0.04, (-err - d) * 0.00025);
      s.renderMs += dt * 1000 * rate;
      return s.renderMs;
    },
  };
}
