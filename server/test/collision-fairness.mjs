// 碰撞公平性实证测试：复现"后车弯道快速追尾前车"场景，量化被撞车损失
// 运行：node test/collision-fairness.mjs
//
// 场景设计（上海站最急弯心 + 直道对照）：
//   - 前车(victim)：以弯道抓地极限速度的 85% 沿中心线过弯（正常合理速度）
//   - 后车(attacker)：1.5 倍前车速度沿同线追击（弯中 divebomb），纯追踪转向 + 全油门
//   - 前车滑行（无油门无刹车）——最坏情况：被撞者没有主动防御
// 观测：前车速度损失、出赛道帧数、后车是否完成超越
import { createCar, stepCar, resolveCarCollisions, nearestIndex } from "../../src/car/physics.js";
import { switchTrack, curvS, pts, tan, hw, N, LAP_LENGTH } from "../../src/track/geometry.js";
import { PHYS } from "../../src/config.js";
import { clamp } from "../../src/utils.js";

const fx = { addSkid() {}, addDust() {}, clearEffects() {} };
switchTrack("shanghai");
const DS = LAP_LENGTH / N;

// ---- 找最急弯心与最长直道 ----
let iApex = 0, iStraight = 0;
for (let i = 0; i < N; i++) {
  if (Math.abs(curvS[i]) > Math.abs(curvS[iApex])) iApex = i;
  if (Math.abs(curvS[i]) < Math.abs(curvS[iStraight])) iStraight = i;
}
const R = 1 / Math.max(1e-5, Math.abs(curvS[iApex]));
const vLimit = Math.sqrt(PHYS.latGrip * R);   // 弯道抓地极限速度

function makeCar(atIdx, speed) {
  const car = createCar(0);
  car.x = pts[atIdx].x; car.y = pts[atIdx].y;
  car.angle = Math.atan2(tan[atIdx].y, tan[atIdx].x);
  car.speed = speed;
  const near = nearestIndex(car.x, car.y, -1);
  car.nearIdx = near.i; car.trackS = near.s;
  car.lap = 1; car.half = true;   // 屏蔽计圈逻辑干扰
  return car;
}

// 纯追踪转向（沿中心线行驶）
function pursuitSteer(car) {
  const v = Math.abs(car.speed);
  const step = Math.max(1, Math.round(Math.max(8, v * 0.85) / DS));
  const j = (car.nearIdx + step) % N;
  let hErr = Math.atan2(pts[j].y - car.y, pts[j].x - car.x) - car.angle;
  while (hErr > Math.PI) hErr -= Math.PI * 2;
  while (hErr < -Math.PI) hErr += Math.PI * 2;
  return clamp(hErr * 1.8, -1, 1);
}

function trackSOf(car) {
  return nearestIndex(car.x, car.y, car.nearIdx).s;
}

function run(label, atIdx, victimSpeed, attackerSpeed, seconds = 4, corner = true) {
  const victim = makeCar(atIdx, victimSpeed);
  const backIdx = (atIdx - Math.round(10 / DS) + N) % N;
  const attacker = makeCar(backIdx, attackerSpeed);

  const v0 = victim.speed;
  let minV = Infinity, endV = 0, offTicks = 0, passed = false;
  const dt = 1 / 60, steps = seconds / dt;

  for (let s = 0; s < steps; s++) {
    stepCar(victim, dt, { up: false, brake: 0, steer: corner ? pursuitSteer(victim) : 0 }, fx);
    stepCar(attacker, dt, { up: true, brake: 0, steer: corner ? pursuitSteer(attacker) : 0 }, fx);
    resolveCarCollisions([victim, attacker]);

    minV = Math.min(minV, victim.speed);
    const vNear = nearestIndex(victim.x, victim.y, victim.nearIdx);
    if (vNear.d > hw[vNear.i]) offTicks++;
    // 后车是否完成超越：沿赛道里程领先且已拉开 15m 以上
    const aS = trackSOf(attacker), vS = trackSOf(victim);
    let lead = aS - vS;
    if (lead < -LAP_LENGTH / 2) lead += LAP_LENGTH;
    if (s > steps * 0.25 && lead > 15) passed = true;
    endV = victim.speed;
  }

  const vNear = nearestIndex(victim.x, victim.y, victim.nearIdx);
  console.log(`\n== ${label} ==`);
  console.log(`  前车初速 ${(v0 * 3.6).toFixed(0)} km/h | 后车初速 ${(attackerSpeed * 3.6).toFixed(0)} km/h`);
  console.log(`  前车: 最低 ${(minV * 3.6).toFixed(1)} km/h | 结束 ${(endV * 3.6).toFixed(1)} km/h | 净损失 ${((v0 - endV) * 3.6).toFixed(1)} km/h`);
  console.log(`  前车: 出赛道 ${offTicks}/${steps} 帧 | 距路缘 ${(hw[vNear.i] - vNear.d).toFixed(2)} m`);
  console.log(`  后车完成超越: ${passed ? "是 ⚠️" : "否"}`);
}

console.log("======================================================");
console.log("碰撞公平性测试（上海国际赛车场）");
console.log(`弯心极限速度 ${(vLimit * 3.6).toFixed(0)} km/h`);
console.log("======================================================");

run("S1 直道追尾（对照）", iStraight, 200 / 3.6, 300 / 3.6, 3, false);
run("S2 弯中追尾: 前车 85% 弯速, 后车 1.5x 前车", iApex, vLimit * 0.85, vLimit * 0.85 * 1.5, 4, true);
run("S3 弯中追尾: 前车 95% 弯速, 后车 2.0x 前车", iApex, vLimit * 0.95, vLimit * 0.95 * 2.0, 4, true);
