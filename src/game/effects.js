// 特效：刹车痕与草地尘土
export const skids = [];
export const dust = [];

// 在线模式里远端车也会落印（netrace.emitRemoteSkid 本地推算，4 条/车），
// 8 车同场时峰值产出约是单人的 8 倍，池子上限从 5200 提到 9000：
// 再多就只剩"挤掉最老的印子"这一个后果（留存时间被压缩），而不是卡帧。
const MAX_SKIDS = 9000;
const MAX_DUST = 240;

let _chainSeq = 0;

// yA / yB：段两端各自的路面高度。3D 里一个印子段可能跨过纵向坡度或横坡，
// 两端共用同一高度会让远端扎进沥青（斯帕 14% 坡上 1m 段就差 14cm）。
// 通过在端点对象 b 上挂载法向 (_nx/_ny) 与强度 (_i)，相邻帧自动共享接缝顶点与起止透明度，
// 形成连续无接缝的丝带网格，彻底消除逐帧重叠黑节与阶梯断层。
export function addSkid(a, b, intensity = 0.5, width = 0.38, yA = 0, yB = yA, intensityA = null) {
  const hw = Math.max(0.05, (width || 0.38) * 0.5) * 1.08;
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  let nxB, nyB;
  if (len > 1e-4) {
    nxB = (-dy / len) * hw;
    nyB = (dx / len) * hw;
  } else if (a && a._nx != null) {
    nxB = a._nx;
    nyB = a._ny;
  } else {
    nxB = hw;
    nyB = 0;
  }

  const chained = !!(a && a._nx != null && len < 4.5);
  const nxA = chained ? a._nx : nxB;
  const nyA = chained ? a._ny : nyB;
  const iB = Math.max(0.0, Math.min(1.0, intensity));
  // 新起印首段从 0 平滑渐入（梭形起头），续接段严格承接上一帧末尾强度
  const iA = intensityA != null
    ? Math.max(0.0, Math.min(1.0, intensityA))
    : (chained ? a._i : 0.0);
  const chainId = chained ? a._chainId : (_chainSeq++);
  const alongA = chained ? (a._along || 0) : 0;
  const alongB = alongA + len;

  if (b && typeof b === "object") {
    b._nx = nxB;
    b._ny = nyB;
    b._i = iB;
    b._chainId = chainId;
    b._along = alongB;
  }

  skids.push({
    a: { x: a.x, y: a.y },
    b: { x: b.x, y: b.y },
    nxA, nyA,
    nxB, nyB,
    chained,
    chainId,
    alongA,
    alongB,
    life: 1,
    intensityA: iA,
    intensity: iB,
    width: width || 0.38,
    ya: yA || 0,
    yb: yB || 0,
  });
  if (skids.length > MAX_SKIDS) skids.splice(0, 60);
}

export function addDust(x, y, vx, vy, z = 0, isSmoke = false) {
  if (dust.length >= MAX_DUST) return;
  const a = Math.random() * Math.PI * 2;
  dust.push({
    x: x + Math.cos(a) * 0.5,
    y: y + Math.sin(a) * 0.5,
    z: z || 0,
    isSmoke: !!isSmoke,
    vx, vy,
    r: isSmoke ? (0.32 + Math.random() * 0.45) : (0.4 + Math.random() * 0.7),
    life: isSmoke ? (0.35 + Math.random() * 0.30) : (0.5 + Math.random() * 0.45),
    max: isSmoke ? 0.65 : 0.95,
    col: isSmoke ? "215,220,228" : (Math.random() > 0.5 ? "160,170,110" : "120,140,90")
  });
}

export function updateEffects(dt) {
  // 刹车印留存时间延长 5 倍（衰减速率由 0.09 调整为 0.018，留存约 55 秒，覆盖大半圈到整圈）
  for (let i = skids.length - 1; i >= 0; i--) {
    skids[i].life -= dt * 0.018;
    if (skids[i].life <= 0) skids.splice(i, 1);
  }
  for (let i = dust.length - 1; i >= 0; i--) {
    const p = dust[i];
    p.x += p.vx * dt; p.y += p.vy * dt;
    p.vx *= 1 - 1.6 * dt; p.vy *= 1 - 1.6 * dt;
    p.r += 2 * dt;
    p.life -= dt;
    if (p.life <= 0) dust.splice(i, 1);
  }
}

export function drawEffects(ctx, view) {
  // 视野剔除：刹车印会累积到数千段，但镜头一次只看得到几十米。
  // 原来每帧把全部段都拼进路径（即使远在赛道另一头），长局越跑越卡；
  // 这里先用 AABB 过滤，只有可见段才参与建路径，画面完全等价。
  const vx0 = view ? view.x - 2 : -Infinity;
  const vy0 = view ? view.y - 2 : -Infinity;
  const vx1 = view ? view.x + view.w + 2 : Infinity;
  const vy1 = view ? view.y + view.h + 2 : Infinity;

  // 高性能分桶批量绘制：将多达数千段前后轮刹车印按深浅聚合为 8 次批处理绘制，杜绝掉帧卡顿。
  // 每段用四边形填充而不是统一 lineWidth 描边 —— 这样前轮 0.34m / 后轮 0.44m 的真实胎宽才能体现，
  // 四条痕迹（左前/右前/左后/右后）宽度各不相同、互不粘连。
  if (skids.length > 0) {
    const BUCKET_COUNT = 8;
    const buckets = Array.from({ length: BUCKET_COUNT }, () => []);

    for (let i = 0; i < skids.length; i++) {
      const s = skids[i];
      const hw = Math.max(0.05, (s.width || 0.38) * 0.5);
      if (vx0 !== -Infinity) {
        const minX = (s.a.x < s.b.x ? s.a.x : s.b.x) - hw;
        const maxX = (s.a.x > s.b.x ? s.a.x : s.b.x) + hw;
        const minY = (s.a.y < s.b.y ? s.a.y : s.b.y) - hw;
        const maxY = (s.a.y > s.b.y ? s.a.y : s.b.y) + hw;
        if (maxX < vx0 || minX > vx1 || maxY < vy0 || minY > vy1) continue;
      }
      const inten = ((s.intensityA ?? s.intensity ?? 0.5) + (s.intensity ?? 0.5)) * 0.5;
      const alpha = (0.12 + inten * 0.72) * s.life;
      const bIdx = Math.min(BUCKET_COUNT - 1, Math.max(0, Math.floor(alpha * BUCKET_COUNT)));
      buckets[bIdx].push(s);
    }

    for (let b = 0; b < BUCKET_COUNT; b++) {
      const list = buckets[b];
      if (list.length === 0) continue;
      const alpha = ((b + 0.6) / BUCKET_COUNT).toFixed(3);
      ctx.fillStyle = `rgba(16,18,22,${alpha})`;
      ctx.beginPath();
      for (let j = 0; j < list.length; j++) {
        const s = list[j];
        const hw = Math.max(0.05, (s.width || 0.38) * 0.5);
        const dx = s.b.x - s.a.x, dy = s.b.y - s.a.y;
        const len = Math.hypot(dx, dy);
        if (len < 1e-4) {
          ctx.moveTo(s.a.x + hw, s.a.y);
          ctx.arc(s.a.x, s.a.y, hw, 0, Math.PI * 2);
          continue;
        }
        const nxA = s.nxA != null ? s.nxA : (-dy / len) * hw;
        const nyA = s.nyA != null ? s.nyA : (dx / len) * hw;
        const nxB = s.nxB != null ? s.nxB : nxA;
        const nyB = s.nyB != null ? s.nyB : nyA;
        ctx.moveTo(s.a.x + nxA, s.a.y + nyA);
        ctx.lineTo(s.b.x + nxB, s.b.y + nyB);
        ctx.lineTo(s.b.x - nxB, s.b.y - nyB);
        ctx.lineTo(s.a.x - nxA, s.a.y - nyA);
        ctx.closePath();
      }
      ctx.fill();
    }
  }

  for (let i = 0; i < dust.length; i++) {
    const p = dust[i];
    if (p.x < vx0 || p.x > vx1 || p.y < vy0 || p.y > vy1) continue;
    ctx.fillStyle = "rgba(" + p.col + "," + (0.5 * Math.max(0, p.life / p.max)) + ")";
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    ctx.fill();
  }
}

export function clearEffects() {
  skids.length = 0;
  dust.length = 0;
}
