#!/usr/bin/env node
/* 算法验收（algo-check）
 * ---------------------------------------------------------------------------
 * 固定矩阵回归：全赛道 × 全车型，跑你的算法与参照算法，按阈值判定 PASS / FAIL，
 * 退出码可直接接 CI。判定项：
 *   · 完赛、无异常、无越权写入
 *   · 草地占比 ≤ --max-grass
 *   · 最快圈相对参照算法 ≤ --max-slow%（参照可关掉）
 * 用法见 scripts/algo-debug.md
 */
import fs from "node:fs";
import { TRACKS } from "../src/track/tracks.js";
import {
  DEFAULT_REF, fmtMs, listCars, loadAlgo, normalizeArgs, parseList, runRace,
} from "./lib/algo-harness.mjs";

const USAGE = `
算法验收 · algo-check

  node scripts/algo-check.mjs --algo=<文件|内置名|-> [选项]

选项：
  --tracks=all|id,id   赛道集合，缺省 all
  --cars=all|id,id     赛车集合，缺省 all
  --mode=solo|vs|duel  solo=单车计时（缺省）/ vs=整场混战 / duel=同款车 1v1
  --laps=<n>           圈数，缺省 2（1 圈含发车，不适合对比）
  --ref=<name|none>    参照算法，缺省 ${DEFAULT_REF}（单独跑一场对照）
  --rival=<文件|内置名>  同场对手算法：同场追加一台同款车直接对刷（与 --ref 二选一，优先 --rival）
  --max-grass=<pct>    草地帧占比上限，缺省 1.5（%）
  --max-slow=<pct>     慢于参照算法的上限，缺省 2（%）
  --seed=<n>           随机种子，缺省 1
  --dt=<秒>            物理步长，缺省 1/60
  --jitter             步长抖动
  --save=<文件>        把每个用例的结果写成 JSON
  --quiet              只打印失败项与汇总
  -h, --help           显示本帮助
`;

function parseArgs(argv) {
  const o = {
    algo: null, rival: null, tracks: "all", cars: "all", mode: "solo", laps: 2, ref: DEFAULT_REF,
    maxGrass: 1.5, maxSlow: 2, seed: 1, dt: 1 / 60, jitter: false,
    save: null, quiet: false, help: false,
  };
  for (const a of argv) {
    if (a === "-h" || a === "--help") { o.help = true; continue; }
    if (a === "--jitter") { o.jitter = true; continue; }
    if (a === "--quiet") { o.quiet = true; continue; }
    const m = /^--([\w-]+)=(.*)$/.exec(a);
    if (!m) {
      // 某些 shell 会把 `--save=out.json` 拆成两个参数：裸的 .json 参数按输出文件处理
      if (!a.startsWith("-") && !a.startsWith("=")) {
        if (/\.json$/i.test(a)) o.save = a;
        else if (!o.algo) o.algo = a;
      }
      continue;
    }
    const [, k, v] = m;
    if (k === "algo") o.algo = v;
    else if (k === "rival") o.rival = v;
    else if (k === "tracks") o.tracks = v;
    else if (k === "cars") o.cars = v;
    else if (k === "mode") o.mode = v;
    else if (k === "laps") o.laps = Math.max(1, Math.round(Number(v) || 1));
    else if (k === "ref") o.ref = v;
    else if (k === "max-grass") o.maxGrass = Math.max(0, Number(v) || 0);
    else if (k === "max-slow") o.maxSlow = Math.max(0, Number(v) || 0);
    else if (k === "seed") o.seed = Number(v) >>> 0;
    else if (k === "dt") o.dt = Math.max(1 / 500, Number(v) || 1 / 60);
    else if (k === "save") o.save = v;
    else throw new Error(`未知参数：--${k}（--help 看用法）`);
  }
  return o;
}

function main() {
  let opt;
  try { opt = parseArgs(normalizeArgs(process.argv.slice(2))); } catch (e) { console.error(`✗ ${e.message}`); process.exit(1); }
  if (opt.help) { console.log(USAGE); return; }
  if (!opt.algo) { console.log(USAGE); process.exit(1); }

  const trackIds = parseList(opt.tracks, TRACKS.map((t) => t.id));
  const carIds = parseList(opt.cars, listCars());
  for (const t of trackIds) if (!TRACKS.some((x) => x.id === t)) { console.error(`✗ 未知赛道：${t}`); process.exit(1); }
  for (const c of carIds) if (!listCars().includes(c)) { console.error(`✗ 未知赛车：${c}`); process.exit(1); }

  const algo = loadAlgo(opt.algo, { seed: opt.seed });
  const rivalAlgo = opt.rival ? loadAlgo(opt.rival, { seed: opt.seed }) : null;
  const refAlgo = rivalAlgo || opt.ref === "none" ? null : loadAlgo(opt.ref, { seed: opt.seed });

  const results = [];
  const pad = (s, n) => String(s).padEnd(n);
  const vsField = opt.mode !== "solo";
  console.log(`\n=== 算法验收 · ${algo.name} ===`);
  console.log(`${trackIds.length} 赛道 × ${carIds.length} 车型 · ${opt.mode} · ${opt.laps} 圈`
    + ` · dt=1/${Math.round(1 / opt.dt)}${opt.jitter ? " · 抖动" : ""} · seed=${opt.seed}`);
  const baseName = rivalAlgo ? rivalAlgo.name : refAlgo ? opt.ref : null;
  console.log(`阈值：草地 ≤ ${opt.maxGrass}%${baseName ? ` · 慢于 ${baseName} ≤ ${opt.maxSlow}%` : ""}\n`);
  if (!opt.quiet) console.log(pad("赛道", 13) + pad("车型", 15) + pad("本算法", 11) + pad(rivalAlgo ? "对手" : "参照", 11)
    + pad("Δ%", 8) + pad("草地", 8) + pad("异常", 6) + (vsField || rivalAlgo ? pad("名次", 10) : "") + "判定");

  for (const trackId of trackIds) {
    for (const carId of carIds) {
      const run = runRace({
        algo, rivalAlgo, mode: opt.mode, trackId, carId, laps: opt.laps, dt: opt.dt, jitter: opt.jitter, seed: opt.seed,
      });
      const ref = refAlgo
        ? runRace({
          algo: refAlgo, mode: opt.mode, trackId, carId, laps: opt.laps,
          dt: opt.dt, jitter: opt.jitter, seed: opt.seed,
        })
        : null;
      // 同场对手：跑「角色互换」的第二场，两向平均消除队尾起步偏差
      let swap = null;
      if (rivalAlgo) {
        swap = runRace({
          algo: rivalAlgo, rivalAlgo: algo, mode: opt.mode, trackId, carId,
          laps: opt.laps, dt: opt.dt, jitter: opt.jitter, seed: opt.seed,
        });
      }
      const pctOf = (mineMs, baseMs2) => (mineMs && baseMs2 ? ((mineMs - baseMs2) / baseMs2) * 100 : null);
      const d1 = rivalAlgo ? pctOf(run.bestLapMs, run.rival?.bestLapMs) : null;
      const d2 = rivalAlgo ? pctOf(swap.bestLapMs, swap.rival?.bestLapMs) : null;
      const baseMs = rivalAlgo
        ? (run.rival?.bestLapMs ?? null)
        : (ref ? ref.bestLapMs : null);
      const deltaPct = rivalAlgo
        ? (d1 != null && d2 != null ? (d1 + d2) / 2 : (d1 ?? d2))
        : pctOf(run.bestLapMs, baseMs);

      const reasons = [];
      if (!run.finished) reasons.push("未完赛");
      if (run.errors) reasons.push(`异常${run.errors}`);
      if (run.violations) reasons.push(`越权${run.violations}`);
      if (run.grassPct > opt.maxGrass) reasons.push(`草地${run.grassPct}%`);
      if (deltaPct != null && deltaPct > opt.maxSlow) reasons.push(`慢${deltaPct.toFixed(1)}%`);

      const row = {
        trackId, carId, carName: run.carName, mode: opt.mode,
        bestLapMs: run.bestLapMs, totalMs: run.totalMs,
        baseName, baseBestLapMs: baseMs,
        deltaPct: deltaPct == null ? null : Math.round(deltaPct * 100) / 100,
        grassPct: run.grassPct, errors: run.errors, violations: run.violations,
        rank: run.rank, fieldSize: run.fieldSize,
        refRank: ref ? ref.rank : null,
        rival: run.rival || null,
        rivalDeltaPct: d1 == null ? null : Math.round(d1 * 100) / 100,
        rivalSwapDeltaPct: d2 == null ? null : Math.round(d2 * 100) / 100,
        gapToWinnerMs: run.gapToWinnerMs,
        finished: run.finished, pass: reasons.length === 0, reasons,
      };
      results.push(row);

      const ok = row.pass;
      if (!opt.quiet || !ok) {
        const rankCell = vsField || rivalAlgo
          ? pad(`P${row.rank}/${row.fieldSize}`, 10)
          : "";
        console.log(pad(trackId, 13) + pad(run.carName, 15) + pad(fmtMs(row.bestLapMs), 11)
          + pad(baseMs ? fmtMs(baseMs) : "—", 11)
          + pad(deltaPct == null ? "—" : (deltaPct >= 0 ? "+" : "") + deltaPct.toFixed(1), 8)
          + pad(run.grassPct + "%", 8) + pad(run.errors, 6) + rankCell
          + (ok ? "PASS" : "FAIL " + reasons.join("/")));
      }
    }
  }

  const fails = results.filter((r) => !r.pass);
  const withDelta = results.filter((r) => r.deltaPct != null);
  const avgDelta = withDelta.length ? withDelta.reduce((s, r) => s + r.deltaPct, 0) / withDelta.length : 0;
  const byTrack = new Map();
  for (const r of withDelta) {
    const e = byTrack.get(r.trackId) || { sum: 0, n: 0 };
    e.sum += r.deltaPct; e.n++;
    byTrack.set(r.trackId, e);
  }

  console.log("\n" + "─".repeat(72));
  const avgRank = (vsField || rivalAlgo) ? results.reduce((s, r) => s + r.rank, 0) / results.length : 0;
  console.log(`PASS ${results.length - fails.length}/${results.length}`
    + (withDelta.length
      ? ` · 平均 ${avgDelta >= 0 ? "+" : ""}${avgDelta.toFixed(2)}%（负 = 比${rivalAlgo ? "对手" : "参照"}快）`
      : "")
    + (vsField || rivalAlgo ? ` · 平均名次 P${avgRank.toFixed(1)}/${results[0].fieldSize}` : ""));
  if (byTrack.size) {
    const per = [...byTrack.entries()].map(([t, e]) => `${t} ${e.sum / e.n >= 0 ? "+" : ""}${(e.sum / e.n).toFixed(2)}%`);
    console.log("分赛道：" + per.join(" · "));
  }
  if (fails.length) {
    console.log("\n失败项：");
    for (const f of fails) console.log(` ✗ ${f.trackId} / ${f.carName}：${f.reasons.join("、")}`);
  }

  if (opt.save) {
    fs.writeFileSync(opt.save, JSON.stringify({
      algo: algo.name, mode: opt.mode,
      base: baseName, rival: rivalAlgo ? rivalAlgo.name : null, ref: refAlgo ? refAlgo.name : null, laps: opt.laps,
      dt: opt.dt, seed: opt.seed, jitter: opt.jitter,
      maxGrass: opt.maxGrass, maxSlow: opt.maxSlow,
      pass: fails.length === 0, avgDeltaPct: Math.round(avgDelta * 100) / 100, results,
    }, null, 2), "utf8");
    console.log(`✓ 结果已写入 ${opt.save}`);
  }

  process.exit(fails.length ? 1 : 0);
}

main();
