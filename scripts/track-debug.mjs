#!/usr/bin/env node
/* 赛道调试（track-debug）
 * ---------------------------------------------------------------------------
 * 改完赛道数据（src/track/tracks/<id>.js、geometry.js 剖面/宽度）后先跑这个脚本，
 * 不开浏览器就能查出"树长在路上""看不见的东西挡车""路面自交折角"这类问题。
 *
 * 三项检查：
 *   1) 几何：长度/宽度/高程/纵坡/立交桥、最急弯（原始半径）、最长直道、
 *      非相邻路段贴太近（同高度时路面会重叠）、走线半径与最低目标速度。
 *   2) 树木：复用渲染同一套 layoutTrees + 净空检测，逐棵验证离路面 ≥ TREE_CLEARANCE。
 *   3) 比赛：runSolo 无头跑一圈，检测卡死（|v|<1.5m/s 持续 >2.5s），记录位置/赛道里程/路肩状态。
 *
 * 用法：
 *   node scripts/track-debug.mjs --track=shanghai
 *   node scripts/track-debug.mjs --track=all --laps=2 --json=out.json
 *   npm run track:debug -- --track=spa
 * 退出码：0 = 通过；1 = 有失败项（未完赛 / 卡死 / 树侵入路面 / NaN）。
 */
import fs from "node:fs";
import * as geo from "../src/track/geometry.js";
import { switchTrack } from "../src/track/geometry.js";
import { TRACKS, DEFAULT_TRACK_ID } from "../src/track/tracks.js";
import { AI_CONFIGS, buildAIData, buildCarVTarget } from "../src/game/ai.js";
import { nearestIndex } from "../src/car/physics.js";
import { loadAlgo, runSolo, fmtMs } from "./lib/algo-harness.mjs";
import TRACK_SCENE_MODULES from "../src/render3d/track/tracks/index.js";
import {
  layoutTrees, makeTrackClearance, TREE_CLEARANCE,
} from "../src/render3d/track/treeLayout.js";

const USAGE = `
赛道调试 · track-debug

  node scripts/track-debug.mjs [--track=<id|all>] [选项]

选项：
  --track=<id|all>   赛道，缺省 ${DEFAULT_TRACK_ID}；all = 全部赛道
  --car=<id>         赛车，缺省 ${AI_CONFIGS[0].id}（--car=all 可看列表）
  --laps=<n>         无头比赛圈数，缺省 1
  --algo=<内置名|文件>  自动驾驶算法，缺省 superDriver
  --no-race          只做几何 + 树木检查，不跑无头比赛
  --no-trees         跳过树木检查（没有 three 构建环境时用）
  --json=<文件>      把完整结果写成 JSON
  -h, --help         显示本帮助
`;

/* ============================== 参数 ============================== */

function parseArgs(argv) {
  const o = {
    track: DEFAULT_TRACK_ID, car: AI_CONFIGS[0].id, laps: 1, algo: "superDriver",
    race: true, trees: true, json: null, help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") { o.help = true; continue; }
    if (a === "--no-race") { o.race = false; continue; }
    if (a === "--no-trees") { o.trees = false; continue; }
    let k = null, v = null;
    const eq = /^--([\w-]+)=(.*)$/.exec(a);
    if (eq) {
      [, k, v] = eq;
    } else if (/^--[\w-]+$/.test(a) && argv[i + 1] != null && !argv[i + 1].startsWith("--")) {
      k = a.slice(2);
      v = argv[++i];
    }
    if (k == null) {
      if (!a.startsWith("-")) o.track = a;       // 位置参数当赛道名
      continue;
    }
    if (k === "track" || k === "tracks") o.track = v;
    else if (k === "car") o.car = v;
    else if (k === "laps") o.laps = Math.max(1, Number(v) || 1);
    else if (k === "algo") o.algo = v;
    else if (k === "json") o.json = v;
  }
  return o;
}

/* ============================== 小工具 ============================== */

const m1 = (v) => Math.round(v * 10) / 10;
const kmh = (ms) => m1(ms * 3.6);
const idxOf = (s, ds) => Math.round(s / ds);

function trackIds(spec) {
  if (!spec || spec === "all") return TRACKS.map((t) => t.id);
  const ids = spec.split(",").map((s) => s.trim()).filter(Boolean);
  const bad = ids.filter((id) => !TRACKS.some((t) => t.id === id));
  if (bad.length) throw new Error(`未知赛道：${bad.join(", ")}（可选：${TRACKS.map((t) => t.id).join(" / ")}）`);
  return ids;
}

// 稳健三点曲率半径：两侧取距本点 ≥ minSpan 米的邻点，避免中心线点距不均时
// 相邻小段（上海最密 0.4m）把半径算成 1~2m 的假尖角；真发夹弯仍能测出 6m 级半径。
function rawRadii(pts, cumDist, N, isLinear, minSpan = 3.5) {
  const R = new Float64Array(N);
  const at = (i) => (isLinear ? Math.min(Math.max(i, 0), N - 1) : ((i % N) + N) % N);
  const pick = (i, dir) => {
    let j = i, arc = 0;
    for (let n = 0; n < 48; n++) {
      const k = at(j + dir);
      arc += Math.hypot(pts[k].x - pts[j].x, pts[k].y - pts[j].y);
      j = k;
      if (arc >= minSpan) break;
      if (isLinear && (j === 0 || j === N - 1)) break;
      if (!isLinear && Math.abs(j - i) === N - 1) break;
    }
    return j;
  };
  for (let i = 0; i < N; i++) {
    const a = pick(i, -1), b = pick(i, 1);
    const v1x = pts[i].x - pts[a].x, v1y = pts[i].y - pts[a].y;
    const v2x = pts[b].x - pts[i].x, v2y = pts[b].y - pts[i].y;
    const l1 = Math.hypot(v1x, v1y), l2 = Math.hypot(v2x, v2y);
    const k = Math.abs(Math.atan2(v1x * v2y - v1y * v2x, v1x * v2x + v1y * v2y)) / ((l1 + l2) * 0.5 || 1);
    R[i] = k > 1e-6 ? 1 / k : 1e6;
  }
  return R;
}

// 点距分布：AI 的速度规划按均匀 DS 计算，局部点距差太多会让前瞻/刹车距离失真
function spacingStats(pts, cumDist, N, isLinear, ds) {
  const d = [];
  for (let i = 0; i < (isLinear ? N - 1 : N); i++) {
    const j = (i + 1) % N;
    d.push(Math.hypot(pts[j].x - pts[i].x, pts[j].y - pts[i].y));
  }
  d.sort((a, b) => a - b);
  const pick = (q) => d[Math.min(d.length - 1, Math.floor(d.length * q))];
  const thin = d.filter((x) => x < ds * 0.5).length;
  return { min: d[0], p10: pick(0.1), median: pick(0.5), max: d[d.length - 1], thin, total: d.length };
}

// 局部极小的连续弯：按弧长 25m 合并，返回 [{ idx, s, R }]
function tightCorners(R, cumDist, N, isLinear, maxR = 150) {
  const out = [];
  for (let i = 0; i < N; i++) {
    if (R[i] > maxR) continue;
    let isMin = true;
    for (let d = -2; d <= 2; d++) {
      const j = isLinear ? Math.min(Math.max(i + d, 0), N - 1) : (i + d + N) % N;
      if (R[j] < R[i]) { isMin = false; break; }
    }
    if (!isMin) continue;
    const s = cumDist[i];
    const prev = out[out.length - 1];
    if (prev && Math.abs(s - prev.s) < 25) {
      if (R[i] < prev.R) { prev.R = R[i]; prev.idx = i; prev.s = s; }
    } else {
      out.push({ idx: i, s, R: R[i] });
    }
  }
  return out.sort((a, b) => a.R - b.R);
}

function longestStraight(curvS, cumDist, ds, N, isLinear) {
  const straight = (i) => Math.abs(curvS[i]) <= 1 / 400;
  let best = { len: 0, from: 0, to: 0 };
  let runStart = -1;
  for (let k = 0; k < (isLinear ? N : N * 2); k++) {
    const i = k % N;
    if (straight(i)) {
      if (runStart < 0) runStart = k;
      const len = (k - runStart + 1) * ds;
      if (len > best.len) {
        best = { len, from: runStart % N, to: i, s0: cumDist[runStart % N], s1: cumDist[i] };
      }
    } else {
      runStart = -1;
      if (!isLinear) { /* 闭合环继续扫第二圈，保证跨起终点的直道不被截断 */ }
    }
    if (runStart >= 0 && k - runStart + 1 >= N) break;   // 整圈都是直道（直线冲刺）
  }
  return best;
}

/* ============================== 几何检查 ============================== */

function auditGeometry(id, carId) {
  switchTrack(id);
  const ctx = geo.createTrackContext(id);
  const { N, pts, hw, cumDist, LAP_LENGTH, isLinear, h, grade, bridges, curvS } = ctx;
  const ds = isLinear ? cumDist[N - 1] / Math.max(1, N - 1) : LAP_LENGTH / N;
  const R = rawRadii(pts, cumDist, N, isLinear);
  const spacing = spacingStats(pts, cumDist, N, isLinear, ds);

  let minR = Infinity, minRi = 0;
  let hwMin = Infinity, hwMax = -Infinity;
  let hMin = Infinity, hMax = -Infinity, maxGrade = 0;
  for (let i = 0; i < N; i++) {
    if (R[i] < minR) { minR = R[i]; minRi = i; }
    if (hw[i] < hwMin) hwMin = hw[i];
    if (hw[i] > hwMax) hwMax = hw[i];
    if (h[i] < hMin) hMin = h[i];
    if (h[i] > hMax) hMax = h[i];
    maxGrade = Math.max(maxGrade, Math.abs(grade[i]));
  }

  // 半宽 ≥ 原始半径：内侧边线越过曲率中心，路面网格会折回并自交
  const narrow = [];
  for (let i = 0; i < N; i++) if (hw[i] >= R[i]) narrow.push(i);
  const narrowZones = [];
  for (const i of narrow) {
    const s = cumDist[i];
    const last = narrowZones[narrowZones.length - 1];
    if (last && Math.abs(s - last.s1) < 40) {
      last.s1 = s; last.n++;
      if (R[i] < last.R) { last.R = R[i]; last.hw = hw[i]; }
    } else {
      narrowZones.push({ s0: s, s1: s, n: 1, R: R[i], hw: hw[i] });
    }
  }

  // 非相邻路段贴太近：同高度（<3m）时两段沥青会重叠
  const minArc = Math.max(60, 8 * hwMax);
  let minGap = Infinity, minGapPair = null, overlaps = 0, worstClear = Infinity, worstClearPair = null;
  for (let i = 0; i < N; i++) {
    for (let j = i + 1; j < N; j++) {
      const arc = cumDist[j] - cumDist[i];
      if (arc < minArc) continue;
      if (!isLinear && LAP_LENGTH - arc < minArc) continue;
      const dist = Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y);
      if (dist < minGap) {
        minGap = dist;
        minGapPair = { i, j, s0: cumDist[i], s1: cumDist[j], dist };
      }
      if (Math.abs(h[i] - h[j]) > 3) continue;
      const clear = dist - hw[i] - hw[j];
      if (clear < worstClear) {
        worstClear = clear;
        worstClearPair = { i, j, s0: cumDist[i], s1: cumDist[j], dist, clear, dh: h[i] - h[j] };
      }
      if (clear < 0) overlaps++;
    }
  }

  const straight = isLinear
    ? longestStraight(curvS, cumDist, ds, N, true)
    : longestStraight(curvS, cumDist, ds, N, false);
  const corners = tightCorners(R, cumDist, N, isLinear);

  // AI 走线 + 弯速表（与 superDriver 一致的口径）
  const bundle = buildAIData(ctx);
  const lineR = rawRadii(
    Array.from({ length: N }, (_, i) => ({ x: bundle.lineX[i], y: bundle.lineY[i] })),
    cumDist, N, isLinear
  );
  let lineMinR = Infinity, lineMinRi = 0;
  for (let i = 0; i < N; i++) if (lineR[i] < lineMinR) { lineMinR = lineR[i]; lineMinRi = i; }
  const cfg = AI_CONFIGS.find((c) => c.id === carId) || AI_CONFIGS[0];
  const cap = buildCarVTarget(cfg.perf || {}, {
    gripFactor: 0.96, brakeFactor: 0.95, noBrakePlan: true,
  }, { N, DS: bundle.DS, rcurvS: bundle.rcurvS, bank: ctx.bank, grade: ctx.grade });
  let minCap = Infinity, minCapI = 0;
  for (let i = 0; i < N; i++) if (cap[i] < minCap) { minCap = cap[i]; minCapI = i; }

  const warnings = [];
  if (narrowZones.length) {
    warnings.push(
      `${narrowZones.length} 处半宽 ≥ 原始转弯半径（内侧边线自交）：`
      + narrowZones.slice(0, 3).map((z) =>
        `s=${m1(z.s0)}~${m1(z.s1)}m R=${m1(z.R)}m hw=${m1(z.hw)}m`).join("；")
    );
  }
  if (overlaps > 0) {
    warnings.push(`${overlaps} 对同高度路段沥青重叠（最近净空 ${m1(worstClear)}m @ s=${m1(worstClearPair.s0)}/${m1(worstClearPair.s1)}m）`);
  }
  if (minCap < 8) {
    warnings.push(`走线最低目标速度仅 ${kmh(minCap)}km/h @s=${m1(cumDist[minCapI])}m —— 疑似走线折叠，车会被"看不见的东西"顶住`);
  }
  if (spacing.thin > 0) {
    warnings.push(
      `中心线点距不均（${spacing.min.toFixed(2)}~${spacing.max.toFixed(2)}m，中位 ${spacing.median.toFixed(2)}m，`
      + `${spacing.thin}/${spacing.total} 段 < DS/2）：AI 按均匀 DS=${ds.toFixed(2)}m 规划前瞻/刹车，该区域会失真`
    );
  }

  return {
    id,
    name: ctx.track.name,
    N, ds, LAP_LENGTH, isLinear,
    lineLengthM: cumDist[N - 1],
    spacing,
    hw: { min: hwMin, max: hwMax },
    elevation: { min: hMin, max: hMax },
    maxGradePct: maxGrade * 100,
    bridges: bridges.map((b) => ({ s: b.s, h: b.h })),
    minRadius: { R: minR, idx: minRi, s: cumDist[minRi], hw: hw[minRi] },
    tightCorners: corners.slice(0, 5).map((c) => ({ ...c, hw: hw[c.idx] })),
    longestStraight: straight,
    selfApproach: {
      minGap, pair: minGapPair, minClear: worstClear, worstPair: worstClearPair, overlaps,
      minArc,
    },
    racingLine: { minRadius: { R: lineMinR, idx: lineMinRi, s: cumDist[lineMinRi] }, minCap: { v: minCap, idx: minCapI, s: cumDist[minCapI], kmh: kmh(minCap) } },
    warnings,
  };
}

/* ============================== 树木检查 ============================== */

function treeOptions(id) {
  const mod = TRACK_SCENE_MODULES[id];
  return { treeDensity: 1, cloudCount: 9, ...(mod && mod.options) };
}

function auditTrees(id) {
  switchTrack(id);                        // treeLayout 读的是激活赛道全局
  const opts = treeOptions(id);
  const { spots } = layoutTrees(opts);
  const clear = makeTrackClearance();
  let minClear = Infinity, minSpot = null;
  const bad = [];
  for (const [x, z] of spots) {
    const c = clear(x, z);
    if (c < minClear) { minClear = c; minSpot = [x, z]; }
    if (c < TREE_CLEARANCE) bad.push({ x, z, clear: c });
  }
  return {
    density: opts.treeDensity ?? 1,
    count: spots.length,
    clearanceRequired: TREE_CLEARANCE,
    minClear,
    minSpot,
    violating: bad.length,
    samples: bad.slice(0, 5),
  };
}

/* ============================== 无头比赛 ============================== */

function auditRace(id, carId, laps, algoName) {
  const algo = loadAlgo(algoName);
  const stuck = [];
  let lowStart = null;
  let minSpeed = Infinity, minSpeedAt = null;
  const STUCK_V = 1.5, STUCK_T = 2.5;

  const res = runSolo({
    algo, trackId: id, carId, laps,
    onStep: ({ car, simMs }) => {
      if (simMs < 2000) return;                     // 跳过发车
      const v = Math.abs(car.speed);
      if (v < minSpeed) {
        minSpeed = v;
        minSpeedAt = { x: car.x, y: car.y, s: car.raceDist || 0, idx: car.nearIdx };
      }
      if (v < STUCK_V) {
        if (lowStart == null) lowStart = simMs;
        else if (simMs - lowStart >= STUCK_T * 1000) {
          const near = nearestIndex(car.x, car.y);
          stuck.push({
            simMs: Math.round(simMs),
            x: m1(car.x), y: m1(car.y),
            s: m1(near.s), idx: near.i,
            dCenter: m1(near.d), hw: m1(geo.hw[near.i]),
            surf: car.surf,
            v: m1(v),
          });
          lowStart = null;
        }
      } else {
        lowStart = null;
      }
    },
  });

  const minCap = (() => {
    // 卡死位置的目标速度（诊断"AI 自己停住"还是"被物理顶住"）
    const ctx = geo.createTrackContext(id);
    const b = buildAIData(ctx);
    const cfg = AI_CONFIGS.find((c) => c.id === carId);
    return buildCarVTarget(cfg?.perf || {}, {
      gripFactor: 0.96, brakeFactor: 0.95, noBrakePlan: true,
    }, { N: ctx.N, DS: b.DS, rcurvS: b.rcurvS, bank: ctx.bank, grade: ctx.grade });
  })();

  for (const ev of stuck) ev.capKmh = kmh(minCap[ev.idx] ?? 0);

  return {
    algo: res.algo,
    carId,
    carName: res.carName,
    laps,
    finished: res.finished,
    bestLapMs: res.bestLapMs,
    totalMs: res.totalMs,
    lapTimesMs: res.lapTimesMs,
    topSpeedKmh: res.topSpeedKmh,
    grassPct: res.grassPct,
    errors: res.errors,
    firstError: res.firstError,
    stuck,
    minSpeedKmh: Number.isFinite(minSpeed) ? kmh(minSpeed) : null,
    minSpeedAt,
  };
}

/* ============================== 输出 ============================== */

function report(geoRes, treeRes, raceRes) {
  const g = geoRes;
  console.log(`\n=== ${g.id} · ${g.name} ===`);

  console.log("几何");
  console.log(`  长度 ${m1(g.LAP_LENGTH)}m${g.isLinear ? `（中心线 ${m1(g.lineLengthM)}m）` : ""} · N=${g.N} · DS=${g.ds.toFixed(3)}m · 半宽 ${m1(g.hw.min)}~${m1(g.hw.max)}m`);
  console.log(`  点距 ${g.spacing.min.toFixed(2)}~${g.spacing.max.toFixed(2)}m（中位 ${g.spacing.median.toFixed(2)}m，<DS/2 的 ${g.spacing.thin} 段）`);
  console.log(`  高程 ${m1(g.elevation.min)}~${m1(g.elevation.max)}m · 最大纵坡 ${m1(g.maxGradePct)}% · 立交桥 ${g.bridges.length}`);
  const c = g.minRadius;
  console.log(c.R >= 1e5 ? "  无弯道（直线赛道）" : `  最急弯 R=${m1(c.R)}m @s=${m1(c.s)}m (idx=${c.idx}, hw=${m1(c.hw)}m)`);
  if (g.tightCorners.length > 1) {
    console.log("  紧弯 Top5：" + g.tightCorners.map((t) =>
      `R${m1(t.R)}m@s${m1(t.s)}`).join(" · "));
  }
  const st = g.longestStraight;
  console.log(`  最长直道 ${m1(st.len)}m @s=${m1(st.s0 ?? 0)}→${m1(st.s1 ?? 0)}m`);
  console.log(`  非相邻路段最近 ${m1(g.selfApproach.minGap)}m（同高度净空 ${m1(g.selfApproach.minClear)}m，重叠 ${g.selfApproach.overlaps} 对）`);
  console.log(`  走线最急 R=${m1(g.racingLine.minRadius.R)}m · 最低目标速度 ${g.racingLine.minCap.kmh}km/h @s=${m1(g.racingLine.minCap.s)}m`);

  if (treeRes) {
    console.log("树木");
    console.log(`  ${treeRes.violating === 0 ? "✓" : "✗"} ${treeRes.count} 棵 · 最小离路净空 ${m1(treeRes.minClear)}m（要求 ≥${treeRes.clearanceRequired}m）`);
    if (treeRes.violating) {
      console.log(`  侵入 ${treeRes.violating} 棵：` + treeRes.samples.map((s) =>
        `(${m1(s.x)},${m1(s.z)}) 净空 ${m1(s.clear)}m`).join("；"));
    }
  }

  if (raceRes) {
    console.log("比赛");
    console.log(`  ${raceRes.algo} · ${raceRes.carName} · ${raceRes.laps} 圈`);
    console.log(`  ${raceRes.finished ? "✓ 完赛" : "✗ 未完赛"} · 最快圈 ${fmtMs(raceRes.bestLapMs)} · 总时 ${fmtMs(raceRes.totalMs)} · 草地 ${raceRes.grassPct}% · 极速 ${raceRes.topSpeedKmh}km/h`);
    console.log(`  行驶最低速 ${raceRes.minSpeedKmh}km/h${raceRes.minSpeedAt ? ` @s=${m1(raceRes.minSpeedAt.s)}m` : ""}`);
    if (raceRes.stuck.length) {
      console.log(`  ✗ 卡死 ${raceRes.stuck.length} 次`);
      for (const ev of raceRes.stuck.slice(0, 5)) {
        console.log(`    s=${ev.s}m idx=${ev.idx} surf=${ev.surf} 偏离中心 ${ev.dCenter}m/${ev.hw}m · v=${ev.v}m/s · 目标弯速 ${ev.capKmh}km/h`);
      }
    } else {
      console.log("  ✓ 无卡死");
    }
    if (raceRes.errors) console.log(`  ✗ 异常 ${raceRes.errors} 次${raceRes.firstError ? `：${raceRes.firstError}` : ""}`);
  }

  for (const w of g.warnings) console.log(`  ⚠ ${w}`);
}

/* ============================== 主流程 ============================== */

const opts = parseArgs(process.argv.slice(2));
if (opts.help) { console.log(USAGE); process.exit(0); }
if (opts.car === "all") {
  console.log("可选赛车：\n  " + AI_CONFIGS.map((c) => `${c.id}（${c.shortName}）`).join("\n  "));
  process.exit(0);
}
if (!AI_CONFIGS.some((c) => c.id === opts.car)) {
  console.error(`未知赛车：${opts.car}（可选：${AI_CONFIGS.map((c) => c.id).join(" / ")}）`);
  process.exit(1);
}

let failed = false;
const all = { generatedAt: new Date().toISOString(), tracks: [] };

for (const id of trackIds(opts.track)) {
  const geoRes = auditGeometry(id, opts.car);
  const treeRes = opts.trees ? auditTrees(id) : null;
  const raceRes = opts.race ? auditRace(id, opts.car, opts.laps, opts.algo) : null;
  report(geoRes, treeRes, raceRes);
  all.tracks.push({ id, geometry: geoRes, trees: treeRes, race: raceRes });

  if (treeRes && treeRes.violating > 0) failed = true;
  if (raceRes && (!raceRes.finished || raceRes.stuck.length > 0 || raceRes.errors > 0)) failed = true;
  if (!Number.isFinite(geoRes.LAP_LENGTH) || geoRes.LAP_LENGTH <= 0) failed = true;
}

if (opts.json) {
  fs.writeFileSync(opts.json, JSON.stringify(all, null, 2));
  console.log(`\n结果已写入 ${opts.json}`);
}

console.log(failed ? "\n结果：FAIL" : "\n结果：PASS");
process.exit(failed ? 1 : 0);
