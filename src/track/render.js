// 赛道静态渲染：草坪、沥青、路肩、轮胎墙、起跑线（离屏一次绘制，单位：米）
import { WORLD, isLinear } from "./geometry.js";
import { makeRandom } from "../utils.js";
import { pts, N, tan, nor, curvS, kerbFlag, hw, addLoop, ringPath, centerPath } from "./geometry.js";

const SS = 2;   // 超采样倍率

export function buildTrackCanvas() {
  const cv = document.createElement("canvas");
  cv.width = WORLD.w * SS;
  cv.height = WORLD.h * SS;
  const g = cv.getContext("2d");
  g.scale(SS, SS);
  g.lineJoin = "round";
  g.lineCap = "round";

  const rnd = makeRandom(1337);

  /* ---------- 草坪 ---------- */
  g.fillStyle = "#2f8d4a";
  g.fillRect(0, 0, WORLD.w, WORLD.h);

  // 割草条纹（12m 斜向宽条）
  g.save();
  g.translate(WORLD.w / 2, WORLD.h / 2);
  g.rotate(-0.3);
  const bw = 12, span = 3000;
  g.fillStyle = "rgba(255,255,255,.055)";
  for (let x = -span; x < span; x += bw * 2) g.fillRect(x, -span, bw, span * 2);
  g.fillStyle = "rgba(0,40,10,.06)";
  for (let x = -span + bw; x < span; x += bw * 2) g.fillRect(x, -span, bw, span * 2);
  g.restore();

  for (let i = 0; i < 3000; i++) {
    const x = rnd() * WORLD.w, y = rnd() * WORLD.h;
    g.fillStyle = rnd() > 0.5 ? "rgba(255,255,255,.05)" : "rgba(0,60,20,.10)";
    g.fillRect(x, y, 0.7, 0.7);
  }

  const vg = g.createRadialGradient(WORLD.w * 0.5, WORLD.h * 0.46, 250, WORLD.w * 0.5, WORLD.h * 0.46, 1070);
  vg.addColorStop(0, "rgba(0,0,0,0)");
  vg.addColorStop(1, "rgba(0,20,5,.30)");
  g.fillStyle = vg;
  g.fillRect(0, 0, WORLD.w, WORLD.h);

  /* ---------- 赛道投影 ---------- */
  g.strokeStyle = "rgba(0,0,0,.20)";
  g.lineWidth = 9.5;
  g.beginPath(); addLoop(g, 1); g.stroke();
  g.beginPath(); addLoop(g, -1); g.stroke();

  /* ---------- 沥青 ---------- */
  ringPath(g);
  g.fillStyle = "#484e58";
  g.fill("evenodd");

  const noise = document.createElement("canvas");
  noise.width = noise.height = 140;
  const ng = noise.getContext("2d");
  for (let i = 0; i < 2600; i++) {
    const a = 0.03 + rnd() * 0.07;
    ng.fillStyle = rnd() > 0.45 ? "rgba(255,255,255," + a + ")" : "rgba(0,0,0," + a + ")";
    ng.fillRect(rnd() * 140, rnd() * 140, 1.7, 1.7);
  }
  g.save();
  ringPath(g);
  g.clip("evenodd");
  g.fillStyle = g.createPattern(noise, "repeat");
  g.globalAlpha = 0.85;
  g.fillRect(0, 0, WORLD.w, WORLD.h);

  g.globalAlpha = 1;
  g.strokeStyle = "rgba(0,0,0,.16)";
  g.lineWidth = 2;
  g.beginPath(); addLoop(g, 1); g.stroke();
  g.beginPath(); addLoop(g, -1); g.stroke();

  g.strokeStyle = "rgba(255,255,255,.035)";
  g.lineWidth = 3.6;
  centerPath(g);
  g.stroke();
  g.restore();

  /* ---------- 白色边线 ---------- */
  g.strokeStyle = "rgba(240,246,252,.92)";
  g.lineWidth = 0.6;
  g.beginPath(); addLoop(g, 1, -0.45); g.stroke();
  g.beginPath(); addLoop(g, -1, 0.45); g.stroke();

  /* ---------- 路肩（红白相间，宽约 1m） ---------- */
  const BLOCK = 9;
  for (let side = -1; side <= 1; side += 2) {
    let i = 0;
    while (i < N) {
      if (!kerbFlag[i]) { i++; continue; }
      let j = i;
      while (j < N && kerbFlag[j]) j++;
      let bi = 0;
      for (let s = i; s < j; s += BLOCK, bi++) {
        const e = Math.min(s + BLOCK, j);
        g.beginPath();
        for (let k = s; k <= e; k++) {
          const q = pts[k % N], n = nor[k % N];
          const off = side * hw[k % N] + 0.3;
          const x = q.x + n.x * off, y = q.y + n.y * off;
          if (k === s) g.moveTo(x, y); else g.lineTo(x, y);
        }
        for (let k = e; k >= s; k--) {
          const q = pts[k % N], n = nor[k % N];
          const off = side * hw[k % N] + 1.3;
          g.lineTo(q.x + n.x * off, q.y + n.y * off);
        }
        g.closePath();
        g.fillStyle = (bi % 2 === 0) ? "#e13b46" : "#f3f7fb";
        g.fill();
      }
      i = j;
    }
  }

  /* ---------- 轮胎墙（弯道外侧，半径 0.67m 的轮胎） ---------- */
  for (let i = 0; i < N; i += 2) {
    if (Math.abs(curvS[i]) < 1 / 26.6) continue;
    const side = curvS[i] > 0 ? -1 : 1;
    const q = pts[i], n = nor[i];
    const off = side * (hw[i] + 2.5);
    const x = q.x + n.x * off, y = q.y + n.y * off;
    g.beginPath();
    g.arc(x, y, 0.67, 0, Math.PI * 2);
    g.fillStyle = "#191d23";
    g.fill();
    g.beginPath();
    g.arc(x, y, 0.28, 0, Math.PI * 2);
    g.fillStyle = "#c9d3de";
    g.fill();
  }

  /* ---------- 场边树丛 ---------- */
  const distToTrk = (x, y) => {
    let best = Infinity;
    for (let i = 0; i < N; i += 2) {
      const dx = pts[i].x - x, dy = pts[i].y - y;
      const d = dx * dx + dy * dy;
      if (d < best) best = d;
    }
    return Math.sqrt(best);
  };
  const drawTree = (x, y, r) => {
    g.save();
    g.translate(x, y);
    g.fillStyle = "rgba(0,0,0,.22)";
    g.beginPath(); g.ellipse(r * 0.4, r * 0.5, r * 1.02, r * 0.96, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = "#1f6b38";
    g.beginPath();
    g.arc(0, -r * 0.15, r, 0, Math.PI * 2);
    g.arc(-r * 0.62, r * 0.42, r * 0.62, 0, Math.PI * 2);
    g.arc(r * 0.6, r * 0.46, r * 0.58, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = "rgba(150,230,160,.28)";
    g.beginPath(); g.arc(-r * 0.3, -r * 0.45, r * 0.5, 0, Math.PI * 2); g.fill();
    g.restore();
  };
  let placedTrees = 0;
  for (let att = 0; att < 2600 && placedTrees < 70; att++) {
    const x = 30 + rnd() * (WORLD.w - 60), y = 30 + rnd() * (WORLD.h - 60);
    if (distToTrk(x, y) < 12) continue;
    drawTree(x, y, 2 + rnd() * 2);
    placedTrees++;
  }

  /* ---------- 起终点格子线（横跨赛道） ---------- */
  const drawGridLine = (idx) => {
    const sp = pts[idx], st = tan[idx];
    g.save();
    g.translate(sp.x, sp.y);
    g.rotate(Math.atan2(st.y, st.x));
    const cells = 10, cw = (hw[idx] * 2) / cells, depth = 1.5;
    for (let r = 0; r < 2; r++) {
      for (let c = 0; c < cells; c++) {
        g.fillStyle = ((r + c) % 2 === 0) ? "#f5f9fd" : "#181c22";
        g.fillRect(-depth + r * depth, -hw[idx] + c * cw, depth + 0.05, cw + 0.05);
      }
    }
    g.fillStyle = "rgba(255,255,255,.55)";
    g.fillRect(-depth - 0.8, -hw[idx], 0.45, hw[idx] * 2);
    g.restore();
  };

  drawGridLine(0);
  // 线性赛道：终点处再画一条格子线（单程冲刺的决胜线）
  if (isLinear) drawGridLine(N - 1);

  return cv;
}

export { SS };
