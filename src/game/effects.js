// 特效：刹车痕与草地尘土
export const skids = [];
export const dust = [];

const MAX_SKIDS = 420;
const MAX_DUST = 190;

export function addSkid(a, b) {
  skids.push({ a: { x: a.x, y: a.y }, b: { x: b.x, y: b.y }, life: 1 });
  if (skids.length > MAX_SKIDS) skids.splice(0, 20);
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
  for (let i = skids.length - 1; i >= 0; i--) {
    skids[i].life -= dt * 0.09;
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
  for (let i = 0; i < skids.length; i++) {
    const s = skids[i];
    ctx.strokeStyle = "rgba(24,26,30," + (0.42 * s.life) + ")";
    ctx.lineWidth = 0.4;
    ctx.beginPath();
    ctx.moveTo(s.a.x, s.a.y);
    ctx.lineTo(s.b.x, s.b.y);
    ctx.stroke();
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
