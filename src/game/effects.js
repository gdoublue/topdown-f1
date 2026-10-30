// 特效：刹车痕与草地尘土
export const skids = [];
export const dust = [];

// 在线模式里远端车也会落印（netrace.emitRemoteSkid 本地推算，4 条/车），
// 8 车同场时峰值产出约是单人的 8 倍，池子上限从 5200 提到 9000：
// 再多就只剩"挤掉最老的印子"这一个后果（留存时间被压缩），而不是卡帧。
const MAX_SKIDS = 9000;
const MAX_DUST = 240;

// yA / yB：段两端各自的路面高度。3D 里一个印子段可能跨过纵向坡度或横坡，
// 两端共用同一高度会让远端扎进沥青（斯帕 14% 坡上 1m 段就差 14cm）。
export function addSkid(a, b, intensity = 0.5, width = 0.38, yA = 0, yB = yA) {
  skids.push({
    a: { x: a.x, y: a.y },
    b: { x: b.x, y: b.y },
    life: 1,
    intensity: Math.max(0.15, Math.min(1.0, intensity)),
    width: width || 0.38,
    ya: yA || 0,
    yb: yB || 0,
    seed: Math.random()     // 每段沉积深浅的随机相位（3D 着色用）
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
      const inten = s.intensity || 0.5;
      const alpha = (0.16 + inten * 0.68) * s.life;
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
          // 原地滑移：补一个圆点，避免出现空洞
          ctx.moveTo(s.a.x + hw, s.a.y);
          ctx.arc(s.a.x, s.a.y, hw, 0, Math.PI * 2);
          continue;
        }
        const ux = dx / len, uy = dy / len;
        const nx = -uy * hw, ny = ux * hw;
        const ex = ux * hw * 0.6, ey = uy * hw * 0.6;   // 两端略微延长，模拟圆头接缝
        ctx.moveTo(s.a.x - ex + nx, s.a.y - ey + ny);
        ctx.lineTo(s.b.x + ex + nx, s.b.y + ey + ny);
        ctx.lineTo(s.b.x + ex - nx, s.b.y + ey - ny);
        ctx.lineTo(s.a.x - ex - nx, s.a.y - ey - ny);
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
