#!/usr/bin/env node
/* 算法体检（algo-doctor）
 * ---------------------------------------------------------------------------
 * 不用改算法源码，逐物理步观察「引擎看到的输入/输出」，直接回答三个问题：
 *   1) 我比参照算法慢在哪一段？（分段用时/均速对比）
 *   2) 我的纵向通道怎么用的？（重刹/轻刹/油门/滑行占比、重刹脉冲、实际 vs 模型加速度）
 *   3) 我的转向吃满了没有？（转向饱和、出界）
 * 用法见 scripts/algo-debug.md；与 autopilot-bench.mjs 同一套编译与物理。
 */
import fs from "node:fs";
import { TRACKS } from "../src/track/tracks.js";
import { AI_CONFIGS } from "../src/game/ai.js";
import { N } from "../src/track/geometry.js";
import { CAR_LENGTH, CAR_WIDTH, getCarDistance } from "../src/car/physics.js";
import {
  DEFAULT_REF, fmtMs, listCars, loadAlgo, normalizeArgs, perfAccelAt, runRace,
} from "./lib/algo-harness.mjs";

const USAGE = `
算法体检 · algo-doctor

  node scripts/algo-doctor.mjs --algo=<文件|内置名|-> [选项]

选项：
  --track=<id>       赛道，缺省 shanghai
  --car=<id>         赛车，缺省 apex-hunter
  --mode=solo|vs|duel  solo=单车计时（缺省）/ vs=整场混战（其余车用内置 AI）/ duel=同款车 1v1
  --laps=<n>         圈数，缺省 3
  --ref=<name|none>  参照算法，缺省 ${DEFAULT_REF}；none = 只体检不对比
  --rival=<文件|内置名>  同场对手算法：追加一台同款车在场上直接对刷（vs/duel/solo 都可用）
  --sections=<n>     分段数量，缺省 12
  --dt=<秒>          物理步长，缺省 1/60（0.0333 = 30fps）
  --jitter           步长 ±40% 抖动
  --seed=<n>         随机种子，缺省 1
  --json[=<文件>]    输出 JSON（推荐写文件，避免 shell 编码问题）
  --dump-args        只打印本进程收到的原始参数（排查 shell / npm 吞参数）
  --verbose          打印算法里的 console.log
  --list             列出赛道 / 赛车 / 内置算法
  -h, --help         显示本帮助
`;

function parseArgs(argv) {
  const o = {
    algo: null, rival: null, track: "shanghai", car: "apex-hunter", mode: "solo", laps: 3, ref: DEFAULT_REF,
    sections: 12, dt: 1 / 60, jitter: false, seed: 1, json: false, jsonFile: null,
    verbose: false, list: false, help: false,
  };
  for (const a of argv) {
    if (a === "-h" || a === "--help") { o.help = true; continue; }
    if (a === "--list") { o.list = true; continue; }
    if (a === "--jitter") { o.jitter = true; continue; }
    if (a === "--verbose") { o.verbose = true; continue; }
    if (a === "--json") { o.json = true; continue; }
    const m = /^--([\w-]+)=(.*)$/.exec(a);
    if (!m) {
      // 某些 shell 会把 `--json=out.json` 拆成两个参数：裸的 .json 参数按输出文件处理
      if (!a.startsWith("-") && !a.startsWith("=")) {
        if (/\.json$/i.test(a)) { o.json = true; o.jsonFile = a; }
        else if (!o.algo) o.algo = a;
      }
      continue;
    }
    const [, k, v] = m;
    if (k === "algo") o.algo = v;
    else if (k === "rival") o.rival = v;
    else if (k === "track") o.track = v;
    else if (k === "car") o.car = v;
    else if (k === "mode") o.mode = v;
    else if (k === "laps") o.laps = Math.max(1, Math.round(Number(v) || 1));
    else if (k === "ref") o.ref = v;
    else if (k === "sections") o.sections = Math.max(2, Math.min(48, Math.round(Number(v) || 12)));
    else if (k === "dt") o.dt = Math.max(1 / 500, Number(v) || 1 / 60);
    else if (k === "seed") o.seed = Number(v) >>> 0;
    else if (k === "json") { o.json = true; if (v) o.jsonFile = v; }
    else throw new Error(`未知参数：--${k}（--help 看用法）`);
  }
  return o;
}

/* ============================== 遥测采集 ============================== */

function makeCollector(sections) {
  // 赛道在 runSolo 里才激活，N 会变：按当前 N 惰性换算分段宽度
  let per = 0, lastN = -1;
  const sec = Array.from({ length: sections }, () => ({
    frames: 0, dt: 0, v: 0, v2: 0, b2: 0, b1: 0, up: 0, sat: 0, grass: 0,
  }));
  const g = {
    frames: 0, b2: 0, b1: 0, up: 0, coast: 0, sat: 0, grass: 0,
    accelSum: 0, accelN: 0, modelSum: 0,
    pulses: 0, pulseFrames: 0,
    blocked: 0, alongside: 0,
    prevBrake: 0, runLen: 0, runKind: 0,
  };

  return {
    onStep({ car, out, dt, live }) {
      if (N !== lastN) { lastN = N; per = Math.max(1, Math.ceil(N / sections)); }
      const idx = (car.nearIdx | 0) % N;
      const s = sec[Math.min(sections - 1, Math.floor(idx / per))];
      const v = Math.abs(car.speed);
      const brake = out.brake | 0;
      const up = out.up ? 1 : 0;
      const sat = Math.abs(car.inSteer || 0) >= 0.98 ? 1 : 0;
      const grass = car.surf === 2 ? 1 : 0;

      g.frames++; s.frames++;
      g.b2 += brake === 2 ? 1 : 0;
      g.b1 += brake === 1 ? 1 : 0;
      g.up += up;
      g.coast += brake === 0 && !up ? 1 : 0;
      g.sat += sat; g.grass += grass;
      s.dt += dt; s.v += v; s.v2 += v * v;
      s.b2 += brake === 2 ? 1 : 0;
      s.b1 += brake === 1 ? 1 : 0;
      s.up += up; s.sat += sat; s.grass += grass;

      // 实际加速度（物理本步算出的 car.accel）vs 该车满油门模型值
      if (brake === 0 && up) {
        g.accelSum += car.accel || 0;
        g.modelSum += perfAccelAt(car.perf || {}, v);
        g.accelN++;
      }

      // 混战：正前方被车挡住 / 并排贴身（vs、duel 模式才有意义）
      if (live && live.length > 1) {
        let blocked = false, alongside = false;
        for (let i = 0; i < live.length; i++) {
          const o = live[i];
          if (o === car) continue;
          const geo = getCarDistance(car, o);
          if (!blocked && geo.sLon > 0 && geo.sLon < CAR_LENGTH + 8
            && Math.abs(geo.dLat) < CAR_WIDTH + 0.6) blocked = true;
          if (!alongside && Math.abs(geo.sLon) < CAR_LENGTH + 1.2
            && Math.abs(geo.dLat) < CAR_WIDTH + 1.2) alongside = true;
          if (blocked && alongside) break;
        }
        if (blocked) g.blocked++;
        if (alongside) g.alongside++;
      }

      // 重刹脉冲：重刹连续 ≤2 帧就松开的"点一下"
      if (brake === g.prevBrake) {
        g.runLen++;
      } else {
        if (g.runKind === 2 && g.runLen <= 2) { g.pulses++; g.pulseFrames += g.runLen; }
        g.runKind = brake; g.runLen = 1; g.wasUp = up;
      }
      g.prevBrake = brake;
    },
    result(lapCount = 1) {
      const lapsDone = Math.max(1, lapCount);
      if (g.runKind === 2 && g.runLen <= 2) { g.pulses++; g.pulseFrames += g.runLen; }
      const avgModel = g.accelN ? g.modelSum / g.accelN : 0;
      const avgReal = g.accelN ? g.accelSum / g.accelN : 0;
      return {
        global: {
          frames: g.frames,
          brake2Pct: pct(g.b2, g.frames),
          brake1Pct: pct(g.b1, g.frames),
          upPct: pct(g.up, g.frames),
          coastPct: pct(g.coast, g.frames),
          satPct: pct(g.sat, g.frames),
          accelAvg: round2(avgReal),
          accelModel: round2(avgModel),
          accelRatio: avgModel > 0.1 ? round2(avgReal / avgModel) : null,
          pulses: g.pulses,
          pulseShare: g.b2 ? round2(g.pulseFrames / g.b2) : 0,
          blockedPct: pct(g.blocked, g.frames),
          alongsidePct: pct(g.alongside, g.frames),
        },
        lapCount: lapsDone,
        sections: sec.map((x, i) => ({
          i,
          timeS: round2(x.dt),
          timePerLap: round2(x.dt / lapsDone),
          speed: x.frames ? round2(x.v / x.frames) : 0,
          speedSq: x.frames ? x.v2 / x.frames : 0,
          brake2Pct: pct(x.b2, x.frames),
          brake1Pct: pct(x.b1, x.frames),
          upPct: pct(x.up, x.frames),
          satPct: pct(x.sat, x.frames),
          grassPct: pct(x.grass, x.frames),
        })),
      };
    },
  };
}

const round2 = (v) => Math.round(v * 100) / 100;
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0);

/* ============================== 诊断建议 ============================== */

function buildAdvice(res, stats, refStats) {
  const tips = [];
  const g = stats.global;

  if (res.grassPct > 1.5) {
    tips.push(`草地 ${res.grassPct}%：已经跑出沥青。先降弯速或把前瞻缩短 10%，确认能 0 出界再放开`);
  }
  if (g.pulseShare > 0.3 && g.pulses > 20) {
    tips.push(`重刹脉冲 ${g.pulses} 次（占重刹帧 ${Math.round(g.pulseShare * 100)}%）：说明"超过目标速度就重刹一帧"的写法在振荡，`
      + `改成按【所需减速度 aReq】分档（aReq > 轻刹能力才重刹），或给触发加死区`);
  }
  if (g.accelRatio != null && g.accelRatio < 0.85) {
    tips.push(`油门时实际加速度只有模型的 ${Math.round(g.accelRatio * 100)}%：大量帧在滑行/轻刹，`
      + `检查刹车触发阈值是否过敏感（轻刹是重刹的 45%，一次轻刹要 6 帧油门才补回来）`);
  }
  if (g.satPct > 12) {
    tips.push(`转向饱和 ${g.satPct}%：前瞻过长或弯速表偏乐观 → 推头吃不满线上速度`);
  }
  if (g.brake2Pct > 28) {
    tips.push(`重刹占 ${g.brake2Pct}%：确认轻刹没有被完全跳过（轻刹只该用于包络上的调制）`);
  }
  if (g.upPct > 96 && refStats && refStats.bestLapMs && res.bestLapMs > refStats.bestLapMs) {
    tips.push("几乎全程在给油却仍比参照慢：问题不在油门，看下面的分段表找掉速段");
  }

  if (res.mode && res.mode !== "solo") {
    if (g.blockedPct > 25) {
      tips.push(`有 ${g.blockedPct}% 的帧正前方 8m 内有车：混战里跟车损失偏大，`
        + `检查跟车安全距离（√(v_lead² + 2·a_brake·gap)）与超车抽头时机`);
    }
    if (g.alongsidePct > 30) {
      tips.push(`并排帧 ${g.alongsidePct}%：横向走廊打分可能过度回避，`
        + `并排时优先保证"不刮擦 + 不丢动能"，别为了留余量把速度让掉`);
    }
    if (res.gapToWinnerMs != null && res.gapToWinnerMs > 1500 && res.rank > 1) {
      tips.push(`混战名次 P${res.rank}/${res.fieldSize}，落后冠军 +${(res.gapToWinnerMs / 1000).toFixed(2)}s：`
        + `先用 --mode=duel 排除交通影响，再回到 vs 看缠斗本身`);
    }
  }

  if (refStats) {
    const deltas = stats.sections
      .map((s, i) => ({ i, d: s.timePerLap - (refStats.sections[i]?.timePerLap ?? s.timePerLap), s }))
      .filter((x) => x.d > 0.03)
      .sort((a, b) => b.d - a.d);
    for (const x of deltas.slice(0, 3)) {
      const rs = refStats.sections[x.i];
      tips.push(`段 s${x.i} 每圈比参照慢 ${x.d.toFixed(2)}s（均速 ${x.s.speed} vs ${rs.speed} m/s，`
        + `重刹 ${x.s.brake2Pct}%、转向饱和 ${x.s.satPct}%）`
        + (x.s.satPct > 12 ? " → 优先改走线/前瞻" : x.s.brake2Pct > 25 ? " → 优先查刹车点与出弯开油" : ""));
    }
    const faster = stats.sections
      .map((s, i) => ({ i, d: (refStats.sections[i]?.timePerLap ?? s.timePerLap) - s.timePerLap }))
      .filter((x) => x.d > 0.05).sort((a, b) => b.d - a.d).slice(0, 2);
    if (faster.length) {
      tips.push(`已经领先的段：${faster.map((x) => `s${x.i}(-${x.d.toFixed(2)}s)`).join("、")}（保持这套做法）`);
    }
  }
  if (!tips.length) tips.push("没发现明显异常：通道占比、加速度、分段速度都在合理区间");
  return tips;
}

/* ============================== 主流程 ============================== */

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

function main() {
  const rawArgs = process.argv.slice(2);
  if (rawArgs.includes("--dump-args")) { console.log(JSON.stringify(rawArgs)); return; }
  let opt;
  try { opt = parseArgs(normalizeArgs(rawArgs)); } catch (e) { fail(e.message); }
  if (opt.help) { console.log(USAGE); return; }
  if (opt.list) {
    console.log("赛道：" + TRACKS.map((t) => t.id).join(" / "));
    console.log("赛车：" + listCars().join(" / "));
    console.log("内置算法：superDriver / geminiDriver / apexHunter / vectorPursuit / classicBaseline / smoothCruiser");
    return;
  }
  if (!opt.algo) { console.log(USAGE); process.exit(1); }
  if (!AI_CONFIGS.some((c) => c.id === opt.car)) fail(`未知赛车：${opt.car}（--list 查看）`);
  if (!TRACKS.some((t) => t.id === opt.track)) fail(`未知赛道：${opt.track}（--list 查看）`);

  const algo = loadAlgo(opt.algo, { seed: opt.seed, verbose: opt.verbose });
  const rivalAlgo = opt.rival ? loadAlgo(opt.rival, { seed: opt.seed }) : null;
  const collect = makeCollector(opt.sections);
  const res = runRace({
    algo, rivalAlgo, mode: opt.mode, trackId: opt.track, carId: opt.car, laps: opt.laps,
    dt: opt.dt, jitter: opt.jitter, seed: opt.seed,
    onStep: collect.onStep, verbose: opt.verbose,
  });
  const stats = collect.result(res.lapTimesMs.length);

  // 同场对手：再跑一遍「角色互换」（对手占我的发车位、我排到队尾），
  // 两向平均才消除"队尾起步"的偏差
  let swapRes = null;
  if (rivalAlgo) {
    swapRes = runRace({
      algo: rivalAlgo, rivalAlgo: algo, mode: opt.mode, trackId: opt.track, carId: opt.car,
      laps: opt.laps, dt: opt.dt, jitter: opt.jitter, seed: opt.seed,
    });
  }

  let refRes = null, refStats = null, refName = null;
  if (opt.ref !== "none" && opt.ref !== opt.algo) {
    refName = opt.ref;
    const refAlgo = loadAlgo(opt.ref, { seed: opt.seed, verbose: false });
    const refCollect = makeCollector(opt.sections);
    refRes = runRace({
      algo: refAlgo, mode: opt.mode, trackId: opt.track, carId: opt.car, laps: opt.laps,
      dt: opt.dt, jitter: opt.jitter, seed: opt.seed, onStep: refCollect.onStep,
    });
    refStats = refCollect.result(refRes.lapTimesMs.length);
  }

  const advice = buildAdvice(res, stats, refStats ? { ...refRes, ...refStats } : null);
  const payload = {
    ...res,
    sections: stats.sections,
    global: stats.global,
    reference: refRes ? { ...refRes, sections: refStats.sections, global: refStats.global } : null,
    rivalSwap: swapRes || null,
    advice,
  };

  if (opt.json || opt.jsonFile) {
    const text = JSON.stringify(payload, null, 2);
    if (opt.jsonFile) fs.writeFileSync(opt.jsonFile, text, "utf8");
    else console.log(text);
    if (opt.jsonFile) console.log(`✓ 结果已写入 ${opt.jsonFile}`);
  }

  /* ---------------- 打印报告 ---------------- */
  const row = (cells, w) => cells.map((c, i) => String(c).padStart(w[i])).join(" │ ");
  const head = ["段", "圈内s", "Δs", "均速", "重刹%", "轻刹%", "油门%", "饱和%", "草%"];
  const widths = [3, 7, 7, 6, 6, 6, 6, 6, 5];

  console.log(`\n=== 算法体检 · ${algo.name} ===`);
  console.log(`赛道 ${opt.track} · ${res.carName} (${opt.car}) · ${opt.mode} · ${opt.laps} 圈`
    + ` · dt=1/${Math.round(1 / opt.dt)}${opt.jitter ? " · 抖动" : ""} · seed=${opt.seed}`);
  const rankText = res.mode === "solo" ? ""
    : ` · 名次 P${res.rank}/${res.fieldSize}`
      + (res.gapToWinnerMs != null && res.gapToWinnerMs > 0 ? `（落后冠军 +${(res.gapToWinnerMs / 1000).toFixed(2)}s）` : "（冠军）");
  console.log(`最快圈 ${fmtMs(res.bestLapMs)} · 总时 ${fmtMs(res.totalMs)} · 极速 ${res.topSpeedKmh} km/h`
    + rankText + ` · 草地 ${res.grassPct}% · 异常 ${res.errors} · 越权 ${res.violations}`
    + (res.finished ? "" : " · 未完赛"));
  if (res.errors && res.firstError) console.log(`首个异常：${res.firstError}`);
  if (res.violationSamples.length) console.log(`越权写入：${res.violationSamples.join("；")}`);
  if (res.rival) {
    const sign = (v) => (v >= 0 ? "快" : "慢");
    const line = (tag, mine, opp, mineBest, oppBest) => {
      const dT = mine.totalMs != null && opp.totalMs != null ? (opp.totalMs - mine.totalMs) / 1000 : null;
      const dB = mine.bestLapMs != null && opp.bestLapMs != null ? (opp.bestLapMs - mine.bestLapMs) / 1000 : null;
      return `  ${tag}：我 P${mine.rank}/${mine.fieldSize} ${fmtMs(mine.totalMs)}`
        + ` · 对手 P${opp.rank}/${mine.fieldSize} ${fmtMs(opp.totalMs)}`
        + (dT == null ? "" : `　→　我${sign(dT)} ${Math.abs(dT).toFixed(3)}s`)
        + (dB == null ? "" : `（最快圈${sign(dB)} ${Math.abs(dB).toFixed(3)}s）`);
    };
    console.log(`\n[对决] 同场对手 ${res.rival.algo}（双向对刷，各占一次队尾）`);
    console.log(line("正向", res, res.rival));
    if (swapRes) console.log(line("反向", swapRes, swapRes.rival));
    if (swapRes && swapRes.rival) {
      const d1 = res.rival.totalMs != null && res.totalMs != null ? res.rival.totalMs - res.totalMs : null;
      const d2 = swapRes.rival.totalMs != null && swapRes.totalMs != null ? swapRes.rival.totalMs - swapRes.totalMs : null;
      const b1 = res.rival.bestLapMs != null && res.bestLapMs != null ? res.rival.bestLapMs - res.bestLapMs : null;
      const b2 = swapRes.rival.bestLapMs != null && swapRes.bestLapMs != null ? swapRes.rival.bestLapMs - swapRes.bestLapMs : null;
      const avgT = d1 != null && d2 != null ? (d1 + d2) / 2000 : null;
      const avgB = b1 != null && b2 != null ? (b1 + b2) / 2000 : null;
      console.log(`  平均：我${avgT == null ? "—" : sign(avgT) + " " + Math.abs(avgT).toFixed(3) + "s"}`
        + (avgB == null ? "" : ` · 最快圈${sign(avgB)} ${Math.abs(avgB).toFixed(3)}s`) + "（双向均值，已消除发车位偏差）");
    }
  }
  if (refRes) {
    const d = (res.bestLapMs - refRes.bestLapMs) / 1000;
    console.log(`参照 ${refName}（单独跑）：最快圈 ${fmtMs(refRes.bestLapMs)} · 本车 ${d >= 0 ? "+" : ""}${d.toFixed(3)}s`
      + ` · 草地 ${refRes.grassPct}%`);
  }

  console.log(`\n[分段] ${opt.sections} 段（按赛道采样点等分）`);
  console.log(row(head, widths));
  console.log(widths.map((w) => "─".repeat(w)).join("─┼─"));
  for (const s of stats.sections) {
    const rs = refStats?.sections[s.i];
    const dt = rs ? (s.timePerLap - rs.timePerLap) : 0;
    console.log(row([
      "s" + s.i, s.timePerLap.toFixed(2), rs ? (dt >= 0 ? "+" : "") + dt.toFixed(2) : "—",
      s.speed.toFixed(1), s.brake2Pct.toFixed(0), s.brake1Pct.toFixed(0),
      s.upPct.toFixed(0), s.satPct.toFixed(0), s.grassPct.toFixed(0),
    ], widths));
  }

  const g = stats.global;
  console.log("\n[通道]");
  console.log(`重刹 ${g.brake2Pct}% · 轻刹 ${g.brake1Pct}% · 油门 ${g.upPct}% · 滑行 ${g.coastPct}%`
    + ` · 转向饱和 ${g.satPct}%`);
  console.log(`重刹脉冲（≤2 帧就松开）${g.pulses} 次，占重刹帧 ${Math.round(g.pulseShare * 100)}%`);
  if (g.accelRatio != null) {
    console.log(`油门时实际加速度 ${g.accelAvg} vs 模型 ${g.accelModel} m/s²（${Math.round(g.accelRatio * 100)}%）`);
  }
  if (res.mode !== "solo") {
    console.log(`被挡（正前方 8m 内有车）${g.blockedPct}% · 并排贴身 ${g.alongsidePct}%`);
  }

  console.log("\n[诊断]");
  for (const t of advice) console.log(" · " + t);
  console.log("");
}

main();
