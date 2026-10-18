// 赛车物理：加减速、转向（抓地极限模型）、路面判定、轮胎印与粒子
import { PHYS } from "../config.js";
import { WORLD, pts, N, nor, tan, hw } from "../track/geometry.js";
import { clamp } from "../utils.js";

const START_IDX = (N - 16 + N) % N;

export function createCar() {
  return {
    x: pts[START_IDX].x + nor[START_IDX].x * 1.4,
    y: pts[START_IDX].y + nor[START_IDX].y * 1.4,
    angle: Math.atan2(tan[START_IDX].y, tan[START_IDX].x),
    speed: 0, steer: 0,
    idx: START_IDX, nearIdx: START_IDX,
    prevSpeed: 0, accel: 0,
    braking: false, shake: 0
  };
}

export function nearestIndex(x, y) {
  let best = Infinity, bi = 0;
  for (let i = 0; i < N; i++) {
    const dx = pts[i].x - x, dy = pts[i].y - y;
    const d = dx * dx + dy * dy;
    if (d < best) { best = d; bi = i; }
  }
  return { i: bi, d: Math.sqrt(best) };
}

// 满油门加速度（m/s²，随速度查表衰减，路肩/草地按系数折减）
function accelAt(v, surf) {
  const c = PHYS.accelCurve;
  let a = c[c.length - 1][1];
  for (let i = 1; i < c.length; i++) {
    if (v <= c[i][0]) {
      const v0 = c[i - 1][0], a0 = c[i - 1][1];
      a = a0 + (c[i][1] - a0) * (v - v0) / (c[i][0] - v0);
      break;
    }
  }
  if (surf === 1) a *= PHYS.accelKerbFactor;
  else if (surf === 2) a *= PHYS.accelGrassFactor;
  return a;
}

// 纵向物理（油门/刹车/滑行），独立导出供测试页复用
// car.speed / car.braking / car.accel 会被更新
export function stepLongitudinal(car, dt, input, surf) {
  const maxSpeed = PHYS.maxSpeed[surf];
  const up = input.up;
  const brake = input.brake;      // 0 无 / 1 轻刹 / 2 重刹（优先级高于油门）

  const prev = car.speed;
  car.braking = false;
  if (up && brake === 0) {
    car.speed += accelAt(Math.max(0, car.speed), surf) * dt;
    if (surf === 2) car.speed -= car.speed * PHYS.grassDrag * dt;
  } else if (brake > 0) {
    const strength = brake === 2 ? PHYS.brake : PHYS.brake * PHYS.lightBrakeFactor;
    if (car.speed > 1) {
      car.speed -= strength * dt;
      car.braking = true;
    } else if (brake === 2) {
      // 重刹停稳后倒车；轻刹只保持停止
      car.speed -= PHYS.reverseAccel * dt;
      if (car.speed < -PHYS.maxReverse) car.speed = -PHYS.maxReverse;
    } else {
      car.speed = Math.max(0, car.speed - strength * dt);
    }
  } else {
    // 松油门滑行：引擎制动 + 速度阻尼（草地额外阻力）
    const dec = PHYS.coastDecel + Math.abs(car.speed) * PHYS.coastDrag
      + (surf === 2 ? PHYS.grassCoastExtra : 0);
    const dv = dec * dt;
    if (Math.abs(car.speed) <= dv) car.speed = 0;
    else car.speed -= Math.sign(car.speed) * dv;
  }

  if (car.speed > maxSpeed) car.speed = Math.max(maxSpeed, car.speed - 120 * dt);

  // 实际纵向加速度（m/s²，轮胎印判定用）
  car.accel = dt > 0 ? (car.speed - prev) / dt : 0;
}

export function stepCar(car, dt, input, fx) {
  const near = nearestIndex(car.x, car.y);
  const d = near.d;
  const hwHere = hw[near.i];
  const surf = d < hwHere - 1 ? 0 : (d < hwHere + 1.5 ? 1 : 2);   // 0 沥青 1 路肩 2 草地

  stepLongitudinal(car, dt, input, surf);

  const spd = Math.abs(car.speed);
  const steerIn = (input.right ? 1 : 0) - (input.left ? 1 : 0);
  // 抓地极限转向：最大侧向加速度 latGrip → ω = latGrip / v（低速另有上限）
  // 必须有速度才能转向：0→3 m/s 线性生效，原地无法转向
  const omega = Math.min(PHYS.maxOmega, PHYS.latGrip / Math.max(spd, 1))
    * Math.min(1, spd / 3)
    * (surf === 2 ? 0.74 : 1);
  car.angle += steerIn * omega * dt * (car.speed < -1 ? -1 : 1);
  car.steer += (steerIn * 0.55 - car.steer) * Math.min(1, dt * 11);

  car.x += Math.cos(car.angle) * car.speed * dt;
  car.y += Math.sin(car.angle) * car.speed * dt;
  car.x = clamp(car.x, 10, WORLD.w - 10);
  car.y = clamp(car.y, 10, WORLD.h - 10);
  car.nearIdx = near.i;

  /* 后轮位置（米，用于刹车痕） */
  const rx = Math.cos(car.angle) * -1.75, ry = Math.sin(car.angle) * -1.75;
  const px = -Math.sin(car.angle), py = Math.cos(car.angle);
  const rearL = { x: car.x + rx + px * 0.79, y: car.y + ry + py * 0.79 };
  const rearR = { x: car.x + rx - px * 0.79, y: car.y + ry - py * 0.79 };

  /* 轮胎印：纵向加速度超过 1g（重刹/锁胎、弹射起步、倒车急加速），
     前进倒车都有效 */
  if (car.prevRear && surf !== 2 && Math.abs(car.accel) > PHYS.skidG && spd > 3) {
    fx.addSkid(car.prevRear[0], rearL);
    fx.addSkid(car.prevRear[1], rearR);
  }
  car.prevRear = [rearL, rearR];

  /* 草地尘土与抖动 */
  if (surf === 2 && spd > 8) {
    car.shake = Math.min(5, spd * 0.06);
    const a = Math.random() * Math.PI * 2, r = 0.8 + Math.random() * 1.4;
    fx.addDust(
      car.x - Math.cos(car.angle) * 2.2 + Math.cos(a) * r,
      car.y - Math.sin(car.angle) * 2.2 + Math.sin(a) * r,
      -Math.cos(car.angle) * 9 + Math.cos(a) * 7,
      -Math.sin(car.angle) * 9 + Math.sin(a) * 7
    );
  } else {
    car.shake *= Math.pow(0.02, dt);
  }
}
