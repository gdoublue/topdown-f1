// 特效：刹车痕与草地尘土
export const skids = [];
export const dust = [];

const MAX_SKIDS = 5200;
const MAX_DUST = 200;

export function addSkid(a, b, intensity = 0.5, width = 0.38) {
  skids.push({
    a: { x: a.x, y: a.y },
    b: { x: b.x, y: b.y },
    life: 1,
    intensity: Math.max(0.15, Math.min(1.0, intensity)),
    width: width || 0.38
  });
  if (skids.length > MAX_SKIDS) skids.splice(0, 60);
}

export function addDust(x, y, vx, vy) {
  if (dust.length >= MAX_DUST) return;
  const a = Math.random() * Math.PI * 2;
  dust.push({
    x: x + Math.cos(a) * 0.5,
    y: y + Math.sin(a) * 0.5,
    vx, vy,
    r: 0.4 + Math.random() * 0.7,
    life: 0.5 + Math.random() * 0.45,
    max: 0.95,
    col: Math.random() > 0.5 ? "160,170,110" : "120,140,90"
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

export function drawEffects(ctx) {
  ctx.lineCap = "round";

  // 高性能分桶批量绘制：将多达数千段前后轮刹车印按深浅聚合为 8 次批处理绘制，杜绝掉帧卡顿
  if (skids.length > 0) {
    const BUCKET_COUNT = 8;
    const buckets = Array.from({ length: BUCKET_COUNT }, () => []);

    for (let i = 0; i < skids.length; i++) {
      const s = skids[i];
      const inten = s.intensity || 0.5;
      const alpha = (0.16 + inten * 0.68) * s.life;
      const bIdx = Math.min(BUCKET_COUNT - 1, Math.max(0, Math.floor(alpha * BUCKET_COUNT)));
      buckets[bIdx].push(s);
    }

    for (let b = 0; b < BUCKET_COUNT; b++) {
      const list = buckets[b];
      if (list.length === 0) continue;
      const alpha = ((b + 0.6) / BUCKET_COUNT).toFixed(3);
      ctx.strokeStyle = `rgba(16,18,22,${alpha})`;
      ctx.lineWidth = 0.38;
      ctx.beginPath();
      for (let j = 0; j < list.length; j++) {
        const item = list[j];
        ctx.moveTo(item.a.x, item.a.y);
        ctx.lineTo(item.b.x, item.b.y);
      }
      ctx.stroke();
    }
  }

  for (let i = 0; i < dust.length; i++) {
    const p = dust[i];
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
