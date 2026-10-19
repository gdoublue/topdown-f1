// 0-400km/h 直线加速基准测试：每辆车静止全油门，测量分段加速时间与平均加速度
// 用法：node scripts/accel-test.mjs
// 物理约束校验：任意车 300-400km/h 段的平均加速度必须低于 200-300km/h 段（功率/阻力随速度恶化）
import { switchTrack } from "../src/track/geometry.js";
import { createCar, stepCar } from "../src/car/physics.js";
import { AI_CONFIGS, applyCarConfig } from "../src/game/ai.js";

switchTrack("dragstrip");

const DT = 1 / 120;                       // 固定步长，保证积分精度
const THRESHOLDS = [100, 200, 300, 400];  // km/h 里程碑
const fx = { addSkid() {}, addDust() {} };
const results = [];

for (const cfg of AI_CONFIGS) {
  const car = applyCarConfig(createCar(0), cfg);
  const input = { up: true, brake: 0, steer: 0 };
  const times = {};
  let t = 0;
  let lastKmh = 0, plateau = 0;
  const vmaxKmh = cfg.perf.maxSpeed[0] * 3.6;

  while (t < 300) {
    stepCar(car, DT, input, fx);
    t += DT;
    const kmh = car.speed * 3.6;
    for (const th of THRESHOLDS) {
      if (times[th] == null && kmh >= th) times[th] = t;
    }
    if (times[400] != null) break;                 // 已测到 400
    if (kmh >= vmaxKmh - 0.3) break;               // 到达极速封顶
    if (Math.abs(kmh - lastKmh) < 0.05) plateau += DT; else plateau = 0;
    lastKmh = kmh;
    if (plateau > 1.5) break;                      // 速度停滞（拖到极速）
  }

  // 分段平均加速度 (m/s²)
  const seg = {};
  const kmh2ms = 1000 / 3600;
  for (const [a, b] of [[0, 100], [100, 200], [200, 300], [300, 400]]) {
    if (times[a] != null && times[b] != null) {
      const dtSeg = times[b] - times[a];
      const dv = (b - a) * kmh2ms;
      seg[`${a}-${b}`] = { t: dtSeg, a: dv / dtSeg };
    }
  }
  results.push({ cfg, times, seg, vmax: vmaxKmh });
}

// 输出
console.log("\n================ 0-400km/h 直线加速基准（静止全油门，不考虑转弯）================");
console.log("车辆                  | 0-100  | 0-200  | 0-300  | 0-400  | 设计极速 | 实测极速");
console.log("----------------------+--------+--------+--------+--------+----------+---------");
for (const r of results) {
  const f = (v) => (r.times[v] != null ? r.times[v].toFixed(2) + "s" : "  ——  ");
  console.log(
    `${r.cfg.shortName.padEnd(20)}| ${f(100).padStart(6)} | ${f(200).padStart(6)} | ` +
    `${f(300).padStart(6)} | ${f(400).padStart(6)} | ${r.vmax.toFixed(0).padStart(5)}  |   ——  `
  );
}

console.log("\n---------------- 分段时间与平均加速度（加速度必须随速度单调递减）----------------");
console.log("车辆                  | 100-200      | 200-300      | 300-400      | 300-400 < 200-300 ?");
console.log("----------------------+--------------+--------------+--------------+-------------------");
for (const r of results) {
  const fmt = (k) => {
    const s = r.seg[k];
    return s ? `${s.t.toFixed(2)}s @${s.a.toFixed(2)}m/s²` : "    ——    ";
  };
  const a23 = r.seg["200-300"]?.a;
  const a34 = r.seg["300-400"]?.a;
  const ok = a23 != null && a34 != null ? (a34 < a23 ? "✓ 正常" : "✗ 异常！") : "  ——";
  console.log(
    `${r.cfg.shortName.padEnd(20)}| ${fmt("100-200").padEnd(12)} | ${fmt("200-300").padEnd(12)} | ` +
    `${fmt("300-400").padEnd(12)} | ${ok}`
  );
}
console.log("");
