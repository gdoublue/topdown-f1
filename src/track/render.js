// 赛道静态渲染：草坪、沥青、路肩、轮胎墙、起跑线（离屏一次绘制，单位：米）
import { WORLD, isLinear } from "./geometry.js";
import { makeRandom } from "../utils.js";
import { pts, N, tan, nor, curvS, kerbFlag, hw, cumDist, LAP_LENGTH, addLoop, ringPath, centerPath } from "./geometry.js";

const SS = 4;   // 超采样倍率（赛道画质核心，不做任何降级）

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
  // 原 .30：场外草地被压成一片暗绿，"冲出赛道"完全看不出来；只保留极轻的远处压暗
  vg.addColorStop(1, "rgba(0,20,5,.12)");
  g.fillStyle = vg;
  g.fillRect(0, 0, WORLD.w, WORLD.h);

  /* ---------- 沥青 ---------- */
  // 不再画"赛道投影"：那圈深绿色描边既不是路面也不是路肩，
  // 物理上毫无意义却特别像一条可以走的窄道，直接去掉，让草坪一路铺到路缘。
  ringPath(g);
  g.fillStyle = "#4c535e";   // 略亮一档的中性灰，和深绿草地拉开明度差
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

  /* ---------- 沥青硬边 + 白色边线 ---------- */
  // 硬边：把沥青边界压实成一条深色细线，远看也能一眼分清"路面 / 草皮"
  g.strokeStyle = "rgba(8,12,18,.55)";
  g.lineWidth = 0.45;
  g.beginPath(); addLoop(g, 1, -0.18); g.stroke();
  g.beginPath(); addLoop(g, -1, 0.18); g.stroke();

  g.strokeStyle = "rgba(242,248,255,.95)";
  g.lineWidth = 0.5;
  g.beginPath(); addLoop(g, 1, -0.5); g.stroke();
  g.beginPath(); addLoop(g, -1, 0.5); g.stroke();

  /* ---------- 路肩（红白相间路缘石：1.5m 宽 / 1.5m 一段） ---------- */
  // 连续弯道处按 kerbFlag 铺设；线性赛道（直线冲刺）全段两侧连续铺路肩。
  // 旧实现两个硬伤：① side*hw+0.3 在左侧(side=-1)把路肩画进了沥青内侧，
  // 看起来像沥青上的一条红色涂装；② 每 9 个采样点才换色（≈33m 一段），不像路缘石。
  const KERB_W = 1.5;      // 路缘石宽度（米）
  const KERB_SEG = 1.5;    // 红白分段长度（米）
  const kerbIdx = (k) => (isLinear ? Math.min(k, N - 1) : k % N);

  // 提取 kerbFlag 的连续路段
  const kerbRanges = [];
  for (let i = 0; i < N;) {
    if (!isLinear && !kerbFlag[i]) { i++; continue; }
    let j = i;
    while (j < N && (isLinear || kerbFlag[j])) j++;
    kerbRanges.push([i, j]);
    i = j;
  }

  const kerbPath = (side) => {
    g.beginPath();
    for (const [i0, i1] of kerbRanges) {
      for (let k = i0; k <= i1; k++) {
        const idx = kerbIdx(k);
        const off = side * (hw[idx] + KERB_W / 2);   // 内外两段都朝路外偏移
        const x = pts[idx].x + nor[idx].x * off;
        const y = pts[idx].y + nor[idx].y * off;
        if (k === i0) g.moveTo(x, y); else g.lineTo(x, y);
      }
    }
  };

  g.lineCap = "butt";
  for (const side of [-1, 1]) {
    // 深色描边：让路缘石凸出于路面 / 草地之上，边界清楚
    g.setLineDash([]);
    g.strokeStyle = "rgba(10,14,20,.45)";
    g.lineWidth = KERB_W + 0.45;
    kerbPath(side); g.stroke();

    // 同一路径描两次、相位错开半个周期 → 红白相间的路缘石
    g.lineWidth = KERB_W;
    g.setLineDash([KERB_SEG, KERB_SEG]);
    g.lineDashOffset = 0;
    g.strokeStyle = "#e03a41";
    kerbPath(side); g.stroke();
    g.lineDashOffset = KERB_SEG;
    g.strokeStyle = "#f2f6fa";
    kerbPath(side); g.stroke();
  }
  g.setLineDash([]);
  g.lineDashOffset = 0;
  g.lineCap = "round";

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
  // 线性赛道：在计时终点（比赛里程处）画决胜格子线。
  // 注意沥青可能延伸到冲线缓冲区之后（dragstrip 冲线后还有 5km 巡航区），
  // 所以不能直接画在沥青末端 N-1。
  if (isLinear) {
    let fi = N - 1;
    for (let i = 0; i < N; i++) {
      if (cumDist[i] >= LAP_LENGTH) { fi = i; break; }
    }
    drawGridLine(fi);
  }

  return cv;
}

export { SS };
