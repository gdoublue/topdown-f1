// 赛车物理：加减速、转向（抓地极限模型）、路面判定、轮胎印与粒子
import { PHYS } from "../config.js";
import { WORLD, pts, N, nor, tan, hw, cumDist, LAP_LENGTH, isLinear } from "../track/geometry.js";
import { clamp } from "../utils.js";

// 沿赛道中心线计算发车格精确坐标：
// 环形赛道：从起终点线向后方回退 distMeters；线性赛道：从起点向前推进（直线竞速并排同线发车）
function getGridSlotGeometry(distMeters, lateralOff, forward = false) {
  let accumulated = 0;
  let curr = 0; // 起终点线点 pts[0]
  const maxSteps = N;

  for (let step = 0; step < maxSteps; step++) {
    const next = forward
      ? Math.min(curr + 1, N - 1)
      : (curr - 1 + N) % N;
    const segLen = Math.hypot(pts[next].x - pts[curr].x, pts[next].y - pts[curr].y);
    if (accumulated + segLen >= distMeters) {
      const remain = distMeters - accumulated;
      const t = segLen > 1e-4 ? remain / segLen : 0;
      // 在 curr 和 next 之间平滑线性插值
      const cx = pts[curr].x + (pts[next].x - pts[curr].x) * t;
      const cy = pts[curr].y + (pts[next].y - pts[curr].y) * t;
      const tx = tan[curr].x * t + tan[next].x * (1 - t);
      const ty = tan[curr].y * t + tan[next].y * (1 - t);
      const tmag = Math.hypot(tx, ty) || 1;
      const nx = -ty / tmag;
      const ny = tx / tmag;

      return {
        x: cx + nx * lateralOff,
        y: cy + ny * lateralOff,
        angle: Math.atan2(ty, tx),
        idx: forward ? next : curr
      };
    }
    accumulated += segLen;
    curr = next;
    if (forward && curr >= N - 1) break;
  }

  // 兜底返回起终点线附近
  const fallbackIdx = forward ? Math.min(N - 2, 2) : (N - 2 + N) % N;
  return {
    x: pts[fallbackIdx].x + nor[fallbackIdx].x * lateralOff,
    y: pts[fallbackIdx].y + nor[fallbackIdx].y * lateralOff,
    angle: Math.atan2(tan[fallbackIdx].y, tan[fallbackIdx].x),
    idx: fallbackIdx
  };
}

export function createCar(gridPos = 0) {
  // 模拟真实 FIA F1 发车规格：
  // 杆位 (P1) 距离起跑线 12 米，后续每格前后交错距离为精确 8 米（真实 1x1 棋盘式格位，整套发车格纵向仅 24 米）
  // 左右横向错开 ±1.7 米，确保所有赛道（包括 7km 斯帕）发车时所有赛车在视野内紧凑同框呈现实况
  const POLE_OFFSET_M = 12.0;
  const GRID_INTERVAL_M = 8.0;
  const distBehindStart = POLE_OFFSET_M + gridPos * GRID_INTERVAL_M;

  let slot, raceDist0, trackS0;
  if (isLinear) {
    // 直线竞速：所有车同一基准线并排发车（公平冲刺），横向成对等距展开。
    // 车道间距 2.8m（车宽 2.0m + 0.8m 侧向间隙），并按当前沥青半宽收边，避免车辆摆出路面
    const laneGap = 2.8;
    const laneEdge = hw[0] - 1.6;
    const side = gridPos % 2 === 0 ? 1 : -1;
    const lateralOff = clamp(side * (laneGap * 0.5 + Math.floor(gridPos / 2) * laneGap),
      -laneEdge, laneEdge);
    slot = getGridSlotGeometry(POLE_OFFSET_M, lateralOff, true);
    raceDist0 = 0;
    trackS0 = POLE_OFFSET_M;
  } else {
    const lateralOff = (gridPos % 2 === 0 ? 1.7 : -1.7);
    slot = getGridSlotGeometry(distBehindStart, lateralOff);
    raceDist0 = -distBehindStart;
    trackS0 = (LAP_LENGTH - distBehindStart + LAP_LENGTH) % LAP_LENGTH;
  }

  return {
    x: slot.x,
    y: slot.y,
    angle: slot.angle,
    speed: 0, steer: 0,
    idx: slot.idx, nearIdx: slot.idx,
    prevSpeed: 0, accel: 0,
    braking: false, shake: 0,
    gLon: 0, gLat: 0, gTotal: 0,
    gridPos,
    raceDist: raceDist0,
    trackS: trackS0,
    prevWheels: null
  };
}

function distToSegmentSquared(px, py, ax, ay, bx, by) {
  const abx = bx - ax, aby = by - ay;
  const apx = px - ax, apy = py - ay;
  const len2 = abx * abx + aby * aby;
  if (len2 < 1e-6) return apx * apx + apy * apy;
  let t = (apx * abx + apy * aby) / len2;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const qx = ax + t * abx - px;
  const qy = ay + t * aby - py;
  return qx * qx + qy * qy;
}

export function nearestIndex(x, y, hintIdx = -1) {
  const idxAt = (i) => isLinear
    ? Math.min(Math.max(i, 0), N - 1)
    : ((i % N) + N) % N;

  let bi = hintIdx;
  if (hintIdx >= 0 && hintIdx < N) {
    const WIN = 20;
    let best = Infinity;
    for (let offset = -WIN; offset <= WIN; offset++) {
      const i = idxAt(hintIdx + offset);
      const dx = pts[i].x - x, dy = pts[i].y - y;
      const d = dx * dx + dy * dy;
      if (d < best) { best = d; bi = i; }
    }
    if (best >= 3600) bi = -1;
  }

  if (bi < 0 || bi >= N) {
    let best = Infinity, found = 0;
    for (let i = 0; i < N; i++) {
      const dx = pts[i].x - x, dy = pts[i].y - y;
      const d = dx * dx + dy * dy;
      if (d < best) { best = d; found = i; }
    }
    bi = found;
  }

  // 严格线段正交几何投影：求解到赛道中心线的最短垂直距离与精确沿赛道物理米数 s
  const prevI = idxAt(bi - 1);
  const nextI = idxAt(bi + 1);
  const dPrev = distToSegmentSquared(x, y, pts[prevI].x, pts[prevI].y, pts[bi].x, pts[bi].y);
  const dNext = distToSegmentSquared(x, y, pts[bi].x, pts[bi].y, pts[nextI].x, pts[nextI].y);
  const dExact = Math.sqrt(Math.min(dPrev, dNext));

  let segIdx = bi, segT = 0;
  if (dPrev < dNext) {
    segIdx = prevI;
    const abx = pts[bi].x - pts[prevI].x, aby = pts[bi].y - pts[prevI].y;
    const apx = x - pts[prevI].x, apy = y - pts[prevI].y;
    const len2 = abx * abx + aby * aby;
    segT = len2 > 1e-4 ? clamp((apx * abx + apy * aby) / len2, 0, 1) : 0;
  } else {
    segIdx = bi;
    const abx = pts[nextI].x - pts[bi].x, aby = pts[nextI].y - pts[bi].y;
    const apx = x - pts[bi].x, apy = y - pts[bi].y;
    const len2 = abx * abx + aby * aby;
    segT = len2 > 1e-4 ? clamp((apx * abx + apy * aby) / len2, 0, 1) : 0;
  }

  let s = 0;
  if (cumDist && cumDist.length > segIdx + 1) {
    const segDist = (cumDist[segIdx + 1] - cumDist[segIdx]) * segT;
    s = isLinear
      ? cumDist[segIdx] + segDist
      : (cumDist[segIdx] + segDist) % (LAP_LENGTH || 5000);
  }

  return { i: bi, d: dExact, s };
}

// 满油门加速度（m/s²，随速度查表衰减，路肩/草地按系数折减）
// highBoost：超过基准曲线末段（100 m/s）后的高速推力系数，
// 模拟大功率电车功率限制特性 a = P/(m·v)（普通 F1 取 1 保持原曲线）
function accelAt(v, surf, mult = 1.0, highBoost = 1.0) {
  const c = PHYS.accelCurve;
  let a = c[c.length - 1][1];
  for (let i = 1; i < c.length; i++) {
    if (v <= c[i][0]) {
      const v0 = c[i - 1][0], a0 = c[i - 1][1];
      a = a0 + (c[i][1] - a0) * (v - v0) / (c[i][0] - v0);
      break;
    }
  }
  if (v > c[c.length - 1][0]) a *= highBoost;
  if (surf === 1) a *= PHYS.accelKerbFactor;
  else if (surf === 2) a *= PHYS.accelGrassFactor;
  return a * mult;
}

// 纵向物理（油门/刹车/滑行），支持每辆赛车专属性能配置
// 电动车功率限制加速模型：a = min(起步抓地极限, P/(m·v) − 风阻)
// 风阻系数由标称极速反推（极速处 a = 0），功率差距在高速段自然指数级拉开（3000Ps vs 1500Ps）
function evAccelAt(perf, v, surf) {
  const P = perf.powerKW * 1000;
  const m = perf.massKg ?? 2200;
  // 风阻标定用自然极速（无电子限速时空气阻力与功率平衡的速度）；电子限速只作硬封顶
  const vmax = perf.naturalVmax ?? (perf.maxSpeed ? perf.maxSpeed[0] : PHYS.maxSpeed[0]);
  const k = P / (m * vmax * vmax * vmax);            // 风阻/质量系数（a=0 at 自然极速）
  let a = P / (m * Math.max(v, 2)) - k * v * v;      // v≥2 防低速发散（起步由抓地极限接管）
  a = Math.min(a, perf.launchAccel ?? 14.0);         // 四四驱弹射的起步抓地极限
  if (surf === 1) a *= PHYS.accelKerbFactor;
  else if (surf === 2) a *= PHYS.accelGrassFactor;
  return Math.max(a, 0);
}

export function stepLongitudinal(car, dt, input, surf) {
  const perf = car.perf || {};
  const maxSpeed = perf.maxSpeed ? perf.maxSpeed[surf] : PHYS.maxSpeed[surf];
  const accelMult = perf.accelMult ?? 1.0;
  const brakeMult = perf.brakeMult ?? 1.0;
  const up = input.up;
  const brake = input.brake;      // 0 无 / 1 轻刹 / 2 重刹（优先级高于油门）

  const prev = car.speed;
  car.braking = false;
  if (up && brake === 0) {
    // 电车（配置 powerKW）走功率限制模型；F1 走经验衰减曲线
    const a = perf.powerKW != null
      ? evAccelAt(perf, Math.max(0, car.speed), surf)
      : accelAt(Math.max(0, car.speed), surf, accelMult, perf.highSpeedAccel ?? 1.0);
    car.speed += a * dt;
    if (surf === 2) car.speed -= car.speed * PHYS.grassDrag * dt;
  } else if (brake > 0) {
    const baseBrake = PHYS.brake * brakeMult;
    const strength = brake === 2 ? baseBrake : baseBrake * PHYS.lightBrakeFactor;
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

// 完赛车辆输入：重刹减速 + 主动驶离赛车线靠边停（避免停在 racing line 上被后车冲撞推出赛道）
export function finishedCarInput(car) {
  const i = car.nearIdx ?? 0;
  const dxn = car.x - pts[i].x, dyn = car.y - pts[i].y;
  const lat = dxn * -tan[i].y + dyn * tan[i].x;          // 侧向偏移（+nor 方向为正）
  const target = hw[i] * 0.6;
  const steer = Math.abs(lat) < target ? (lat >= 0 ? 0.4 : -0.4) : 0;
  return { up: false, brake: Math.abs(car.speed) > 2 ? 2 : 1, steer };
}

export function stepCar(car, dt, input, fx) {
  const near = nearestIndex(car.x, car.y, car.nearIdx);
  const d = near.d;
  const hwHere = hw[near.i];
  const surf = d < hwHere - 1 ? 0 : (d < hwHere + 1.5 ? 1 : 2);   // 0 沥青 1 路肩 2 草地

  stepLongitudinal(car, dt, input, surf);

  const perf = car.perf || {};
  const latGrip = perf.latGrip ?? PHYS.latGrip;
  const maxOmega = perf.maxOmega ?? PHYS.maxOmega;
  const steerRate = perf.steerRate ?? 11;

  const spd = Math.abs(car.speed);
  const steerIn = typeof input.steer === "number"
    ? clamp(input.steer, -1, 1)
    : (input.right ? 1 : 0) - (input.left ? 1 : 0);

  // 抓地极限转向：最大侧向加速度 latGrip → ω = latGrip / v（低速另有上限）
  // 必须有速度才能转向：0→3 m/s 线性生效，原地无法转向
  const omega = Math.min(maxOmega, latGrip / Math.max(spd, 1))
    * Math.min(1, spd / 3)
    * (surf === 2 ? 0.74 : 1);
  car.angle += steerIn * omega * dt * (car.speed < -1 ? -1 : 1);
  car.steer += (steerIn * 0.55 - car.steer) * Math.min(1, dt * steerRate);

  // 实时 G 值遥测计算 (1G = 9.81 m/s²)
  const curGLon = car.accel / 9.81;
  const curGLat = (spd * Math.abs(steerIn * omega)) / 9.81;
  const curGTotal = Math.hypot(curGLon, curGLat);
  car.gLon = (car.gLon || 0) + (curGLon - (car.gLon || 0)) * Math.min(1, dt * 16);
  car.gLat = (car.gLat || 0) + (curGLat - (car.gLat || 0)) * Math.min(1, dt * 16);
  car.gTotal = (car.gTotal || 0) + (curGTotal - (car.gTotal || 0)) * Math.min(1, dt * 16);

  car.x += Math.cos(car.angle) * car.speed * dt;
  car.y += Math.sin(car.angle) * car.speed * dt;
  car.x = clamp(car.x, 10, WORLD.w - 10);
  car.y = clamp(car.y, 10, WORLD.h - 10);

  // 严格更新赛道连续物理米数里程（米，彻底消除发车与弯道处离散索引跳变颠倒）
  const nearNow = nearestIndex(car.x, car.y, near.i);
  car.nearIdx = nearNow.i;
  car.trackS = nearNow.s;

  if (isLinear) {
    // 线性赛道：里程就是沿直线的物理进度，无圈数/半程概念
    car.raceDist = Math.max(nearNow.s, car.raceDist || 0);
  } else {
    let effLap = car.lap || 1;
    let s = nearNow.s;
    const lapLen = LAP_LENGTH || 5000;
    if (effLap === 1 && !car.half && s > lapLen * 0.7) {
      s -= lapLen; // 发车格线后方阶段为负里程
    } else if (car.half && s < lapLen * 0.3) {
      // 已经物理越过起终点线，但 updateCarLap 尚未执行圈数跃迁
      effLap += 1;
    }
    car.raceDist = (effLap - 1) * lapLen + s;
  }

  /* 四轮独立精确几何位置（米，用于前/后轮真实独立刹车与极限转向滑移痕） */
  const cosA = Math.cos(car.angle), sinA = Math.sin(car.angle);
  const fxForward = cosA * 1.75, fyForward = sinA * 1.75;
  const rxBack = -cosA * 1.75, ryBack = -sinA * 1.75;
  const pxPerp = -sinA, pyPerp = cosA;

  // 前轮（半轴距 0.77m）与后轮（半轴距 0.79m）
  const fl = { x: car.x + fxForward + pxPerp * 0.77, y: car.y + fyForward + pyPerp * 0.77 };
  const fr = { x: car.x + fxForward - pxPerp * 0.77, y: car.y + fyForward - pyPerp * 0.77 };
  const rl = { x: car.x + rxBack + pxPerp * 0.79, y: car.y + ryBack + pyPerp * 0.79 };
  const rr = { x: car.x + rxBack - pxPerp * 0.79, y: car.y + ryBack - pyPerp * 0.79 };

  /* 轮胎印：由刹车制动强度或极限弯道侧滑产生，前后四轮完全独立记录与呈现，起步加速不留印 */
  if (car.prevWheels && surf !== 2 && spd > 3.5) {
    let skidIntensity = 0;
    // 1. 刹车制动工况（减速度大于约 1.2G 开始显痕，重刹越狠印越深）
    if (car.braking && car.accel < -11.5) {
      skidIntensity = clamp((-car.accel - 11.5) / 36, 0.18, 0.95);
    }
    // 2. 弯道极限离心力侧向滑动 (侧向 G 超过 3.8G 且在转弯)
    else if (car.gLat > 3.8 && Math.abs(car.steer) > 0.22) {
      skidIntensity = clamp((car.gLat - 3.8) / 1.1, 0.15, 0.65);
    }

    if (skidIntensity > 0) {
      // 前轮独立刹车印（前轮转向走线，宽度 0.35m）
      fx.addSkid(car.prevWheels.fl, fl, skidIntensity * 0.96, 0.35);
      fx.addSkid(car.prevWheels.fr, fr, skidIntensity * 0.96, 0.35);
      // 后轮独立刹车印（后轴驱动走线，宽度 0.42m）
      fx.addSkid(car.prevWheels.rl, rl, skidIntensity, 0.42);
      fx.addSkid(car.prevWheels.rr, rr, skidIntensity, 0.42);
    }
  }
  car.prevWheels = { fl, fr, rl, rr };

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

// 赛车物理包围盒几何尺寸：长 5.6m、宽 2.0m（车头距中心 +2.8m，车尾 -2.8m）
export const CAR_LENGTH = 5.6;
export const CAR_WIDTH = 2.0;

/**
 * 计算两车之间的真实间距与车头车尾净空隙
 * @param {object} carA 观察车（后车视角）
 * @param {object} carB 目标车（前车视角）
 */
export function getCarDistance(carA, carB) {
  const dx = carB.x - carA.x;
  const dy = carB.y - carA.y;
  const cosA = Math.cos(carA.angle);
  const sinA = Math.sin(carA.angle);

  // 投影到 carA 航向坐标系
  const sLon = dx * cosA + dy * sinA;   // 纵向距离：>0 表示 carB 在 carA 车头前方
  const dLat = -dx * sinA + dy * cosA;  // 侧向距离：垂直偏移

  // 车头到车尾真实净空隙（扣除各自 2.8m 车身半长，共 5.6m）
  const gapFrontRear = Math.abs(sLon) - CAR_LENGTH;
  // 车侧真实净侧隙（扣除各自 1.0m 车身半宽，共 2.0m）
  const gapLateral = Math.abs(dLat) - CAR_WIDTH;

  return { sLon, dLat, gapFrontRear, gapLateral, distCenter: Math.hypot(dx, dy) };
}

/**
 * 多车物理碰撞分离处理：防止车头穿透前车车尾、防止侧面穿模重叠
 */
export function resolveCarCollisions(cars) {
  if (!cars || cars.length <= 1) return;
  for (let i = 0; i < cars.length; i++) {
    for (let j = i + 1; j < cars.length; j++) {
      const a = cars[i];
      const b = cars[j];
      const geo = getCarDistance(a, b);

      // 只有在车长与车宽包围盒均重叠时发生接触
      if (geo.gapFrontRear < 0 && geo.gapLateral < 0) {
        const overlapX = -geo.gapLateral;
        const overlapY = -geo.gapFrontRear;

        const cosA = Math.cos(a.angle);
        const sinA = Math.sin(a.angle);

        let pushX = 0, pushY = 0;
        if (overlapY < overlapX * 1.5) {
          // 前后追尾碰撞：车头顶到前车车尾，平滑弹性推开
          const signY = geo.sLon >= 0 ? 1 : -1;
          const pushDist = Math.min(0.8, overlapY * 0.45);
          pushX = cosA * signY * pushDist;
          pushY = sinA * signY * pushDist;

          // 动量阻尼与冲量传递：后车平缓减速，前车获得冲量被推快
          if (geo.sLon > 0) {
            // a 在后，b 在前
            if (a.speed > b.speed) {
              const diff = a.speed - b.speed;
              a.speed -= diff * 0.45;
              b.speed += diff * 0.25;
            }
          } else {
            // b 在后，a 在前
            if (b.speed > a.speed) {
              const diff = b.speed - a.speed;
              b.speed -= diff * 0.45;
              a.speed += diff * 0.25;
            }
          }
        } else {
          // 侧面并排擦碰：沿横向平滑分离
          const signX = geo.dLat >= 0 ? 1 : -1;
          const pushDist = Math.min(0.4, overlapX * 0.4);
          pushX = -sinA * signX * pushDist;
          pushY = cosA * signX * pushDist;

          // 侧面擦碰轻微摩擦阻尼
          a.speed *= 0.995;
          b.speed *= 0.995;
        }

        b.x += pushX * 0.5;
        b.y += pushY * 0.5;
        a.x -= pushX * 0.5;
        a.y -= pushY * 0.5;
      }
    }
  }
}
