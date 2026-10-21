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
    // 角度也要外推：只冻结 last.a 会让"过弯中的车"保持进弯前的车头直冲，
    // 观感是"朝向不合理"，比位置偏差更刺眼。用最后两个样本估横摆角速度（限幅）。
    let omega = 0;
    if (n >= 2) {
      const p = buf[n - 2];
      const dtp = Math.max(1, last.t - p.t) / 1000;
      let dA = last.a - p.a;
      while (dA > Math.PI) dA -= Math.PI * 2;
      while (dA < -Math.PI) dA += Math.PI * 2;
      omega = Math.max(-3, Math.min(3, dA / dtp));
    }
    return {
      x: last.x + Math.cos(last.a) * last.v * dtSec,
      y: last.y + Math.sin(last.a) * last.v * dtSec,
      a: last.a + omega * dtSec,
      v: last.v,
      extrapolated: true,
    };
  }

  const i = findSpan(buf, tMs);
  const s0 = buf[i], s1 = buf[i + 1];
  const span = Math.max(1, s1.t - s0.t);
  const u = Math.min(1, Math.max(0, (tMs - s0.t) / span));
  const u2 = u * u, u3 = u2 * u;

  // 切线：优先用样本自带的物理速度 (v, a) —— 时间参数化 Hermite。
  // 本作的位移积分就是 x += cos(a)·v·dt，所以 (cos a, sin a)·v 就是真实速度向量，
  // 直接拿它做切线（乘上本段时长 span）比"邻点差分"稳得多：
  // 邻点差分在非均匀间隔下（掉帧 150ms 紧跟 16ms）会把短间隔那段的斜率放大，
  // 表现为高速入弯时轨迹先往弯外甩一下再折回（几何过冲）。
  const spanSec = span / 1000;
  let m0x, m0y, m1x, m1y;
  if (Math.abs(s0.v) > 0.5 && Math.abs(s1.v) > 0.5) {
    m0x = Math.cos(s0.a) * s0.v * spanSec;
    m0y = Math.sin(s0.a) * s0.v * spanSec;
    m1x = Math.cos(s1.a) * s1.v * spanSec;
    m1y = Math.sin(s1.a) * s1.v * spanSec;
    // 与弦长对齐限幅：个别样本速率异常时不许把曲线拉飞（正常加速远到不了 2.2 倍弦长）
    const chordX = s1.x - s0.x, chordY = s1.y - s0.y;
    const cl = Math.hypot(chordX, chordY);
    if (cl > 0.5) {
      const lim = cl * 2.2;
      const m0l = Math.hypot(m0x, m0y);
      const m1l = Math.hypot(m1x, m1y);
      if (m0l > lim) { m0x *= lim / m0l; m0y *= lim / m0l; }
      if (m1l > lim) { m1x *= lim / m1l; m1y *= lim / m1l; }
    }
  } else {
    // 静止 / 倒车 / 老服务端没带 v：退回邻点差分（非均匀缩放，端点退化为该段弦）
    const sPrev = buf[i - 1] || s0;
    const sNext = buf[i + 2] || s1;
    const invPrev = span / Math.max(1, s1.t - sPrev.t);
    const invNext = span / Math.max(1, sNext.t - s0.t);
    m0x = (s1.x - sPrev.x) * invPrev;
    m0y = (s1.y - sPrev.y) * invPrev;
    m1x = (sNext.x - s0.x) * invNext;
    m1y = (sNext.y - s0.y) * invNext;
  }

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
// 唯一例外：观测值比锁定值小 relockMs 以上（说明热机时链路异常、锁偏了），重新锁定。
// relockMs 从 80 提到 300：主线程抖动（尤其中间还要画 canvas 的那个浏览器）会让
// 个别包"看起来"早到几十毫秒，80ms 的门槛会频繁触发重锁 → 整条时间轴被平移 →
// 画面上就是每隔一会儿抽一下。300ms 只认真实异常（换链路/重连），日常抖动不再重锁。
export function createClockOffset({ warmup = 40, relockMs = 300 } = {}) {
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
// 稳态行为：目标 = 最新参考时刻 − baseDelayMs，目标是 33.3ms 的阶梯；
// 本机时钟恒速 1.0 自由推进时，err 在 [−33.3, 0] 内锯齿摆动，
// 死区（默认 60ms > 一个 tick）内一次修正都不做 —— 渲染速度绝对恒定。
// 只有真实漂移（服务器掉速 / 长卡顿 / 时钟偏差）才用 ≤4% 的速率把水位拉回。
//
// 自适应延迟不碰这条闭环：额外的缓冲需求走独立的时间轴偏移 offsetMs，
// 采样时用 playMs（= renderMs − offsetMs）。offsetMs 以 20ms/s 移动（≈播放速度 2%，
// 肉眼不可见），好处是加减延迟完全可逆，也不会被死区吃掉或把延迟永久顶高。
export function createPlayoutClock({ delayMs = 120, deadBandMs = 60, offsetRateMs = 20 } = {}) {
  const s = {
    renderMs: -1,
    refMs: -1,
    baseDelayMs: delayMs,   // 标称延迟：时钟目标只认它，永不改变
    delayMs,                // 目标总延迟（标称 + 自适应增量），由 setDelay 设置
    offsetMs: 0,            // playMs 相对 renderMs 的额外滞后（0 ~ 120）
    deadBandMs,
    offsetRateMs,
  };

  return {
    get renderMs() { return s.renderMs; },
    // 采样 / 裁剪实际使用的时间轴（已含自适应延迟）
    get playMs() { return s.renderMs < 0 ? s.renderMs : s.renderMs - s.offsetMs; },
    get delayMs() { return s.delayMs; },
    get offsetMs() { return s.offsetMs; },
    get latestSampleMs() { return s.refMs; },   // 兼容旧命名：最新参考时刻

    reset() {
      s.renderMs = -1;
      s.refMs = -1;
      s.offsetMs = 0;
      s.delayMs = s.baseDelayMs;
    },

    // 自适应播放延迟：设置"目标总延迟"。多出来的部分靠缓慢移动 offsetMs 实现，
    // 因此调高调低都完全可逆，且永不改变 renderMs 的推进速率（保持绝对匀速）。
    setDelay(ms) {
      const v = Number(ms);
      if (!Number.isFinite(v)) return s.delayMs;
      s.delayMs = Math.max(s.baseDelayMs, Math.min(400, v));
      return s.delayMs;
    },

    // 均匀参考轴（本机时钟毫秒）。单调不回退：网络只会让包迟到，不会让时间倒流。
    noteRef(localMs) {
      if (localMs > s.refMs) s.refMs = localMs;
    },

    // 时钟偏移变化时同步平移参考轴（允许变小）。
    // 为什么必须平移：ref 只吃"历史最大"的 ts+off，而样本时刻用的是"当前"off。
    // 一旦 off 变小（热机收敛、WS→DataChannel 接管、链路变好），ref 就会永久高出那一段：
    // 播放点跑到最新样本前面 → 远端车不停外推（冲出赛道），新样本到了又被拽回来。
    // 平移之后偏差只体现为 err → 由死区外的 ±4% 速率平滑吸收，不会跳。
    shiftRef(deltaMs) {
      const d = Number(deltaMs);
      if (!Number.isFinite(d) || d === 0 || s.refMs < 0) return;
      s.refMs += d;
    },

    // 兼容入口：把样本时刻直接当参考轴（单测 / 无服务端时间戳的退化路径）
    noteSample(t) {
      if (t > s.refMs) s.refMs = t;
    },

    update(dt) {
      if (s.refMs < 0) return s.renderMs;
      const target = s.refMs - s.baseDelayMs;
      if (s.renderMs < 0) s.renderMs = target;

      // 自适应偏移：缓慢靠近目标（≈播放速度 ±2%，察觉不到）
      const wantOffset = Math.max(0, Math.min(120, s.delayMs - s.baseDelayMs));
      const step = s.offsetRateMs * dt;
      if (wantOffset > s.offsetMs) s.offsetMs = Math.min(wantOffset, s.offsetMs + step);
      else if (wantOffset < s.offsetMs) s.offsetMs = Math.max(wantOffset, s.offsetMs - step);

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

// 自适应播放延迟控制器：**直接看缓冲有没有被掏空**，而不是去估计链路抖动。
//
// 为什么不用"到达时刻 − 采样时刻"估抖动：这个差值里混着客户端主线程的调度延迟
// （浏览器派发 WebSocket 消息本来就比网络到达晚几毫秒到几十毫秒），在干净的本机链路上
// 实测也能测出 25~56ms 的"抖动"，会把延迟白白顶到 100ms 以上。而缓冲是否见底是**结果**，
// 只有真的快断流才说明延迟不够，用它做反馈不会误判。
//
// 策略：
//   · 一帧里只要有"正常帧率的对端"缓冲见底（正在直线外推）就累计饿死时长
//   · 累计满 starveTriggerMs（默认 60ms）→ 延迟 +15ms（上限 150）
//   · 连续 calmMs（默认 3s）没有饿死 → 每秒回退 2ms，直到标称值
export function createDelayController({
  baseMs = 80,
  maxMs = 150,
  riseMs = 15,
  fallMsPerSec = 2,
  starveTriggerMs = 60,
  calmMs = 3000,
} = {}) {
  let cur = baseMs;
  let starveMs = 0;
  let calmAcc = 0;

  return {
    get value() { return cur; },
    reset() { cur = baseMs; starveMs = 0; calmAcc = 0; },

    // 每帧调用一次：starved = 本帧是否有"健康对端"的缓冲被掏空（需要更深的缓冲）
    update(dt, starved) {
      const ms = dt * 1000;
      if (starved) {
        starveMs += ms;
        calmAcc = 0;
      } else {
        starveMs = Math.max(0, starveMs - ms * 0.5);   // 偶发单帧不算数，慢慢衰减
        calmAcc += ms;
      }
      if (starveMs >= starveTriggerMs) {
        cur = Math.min(maxMs, cur + riseMs);
        starveMs = 0;
        calmAcc = 0;
      } else if (calmAcc >= calmMs) {
        cur = Math.max(baseMs, cur - fallMsPerSec * dt);
      }
      return cur;
    },
  };
}
