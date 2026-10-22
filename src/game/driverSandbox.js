// 玩家算法沙箱：定义"算法能碰到什么"，是整个引擎唯一的边界。
//
// 规则（与 autopilot-doc.md 的描述一致）：
//   · car 是只读代理：只有 `_` 前缀（文档约定的自定义状态）可写；
//     物理字段（x / y / speed / nearIdx / finished / perf …）的写入会被丢弃并记一条违规，
//     绝对不会进到引擎状态里 —— 也就是说"瞬移 / 改速度 / 伪造完赛"在引擎层面失效。
//   · otherCars 是冻结的只读代理数组：推不动别人的车，也改不了别人的 AI 记忆字段。
//   · car.perf 返回稳定的只读视图（同一份 perf 永远同一个代理），
//     这样 getSuperCornerCap(car.perf) 仍会命中按 perf 对象建表的缓存（见 perfAliasOf）。
//
// 注意：这不是"安全沙箱"（同进程 JS 无法彻底隔离），目标是**公平性**：
// 让算法只能通过 out 控制自己的车，改不到任何游戏数值。
// 宿主全局（window / document / localStorage / fetch / __gp）的屏蔽在编译期做，
// 见 src/ui/autopilot.js 的 compile()。

const carViews = new WeakMap();     // 真车 -> 只读代理（同一辆车永远同一个代理，保证 o === car）
const perfViews = new WeakMap();    // 真 perf -> 只读代理
const perfAlias = new WeakMap();    // 只读代理 -> 真 perf（缓存键归一化）

// 算法调用时的 this：空的无原型对象。
// 非严格模式函数被裸调用时 this 会自动变成全局对象（等于把 window 递过去），
// 显式给一个空接收者才算把这条路也堵上（顺带让 this.constructor 也拿不到 Function）。
export const DRIVER_THIS = Object.freeze(Object.create(null));

const violations = new Map();       // key -> { key, count }
const MAX_KINDS = 40;               // 只保留前 40 类，避免作弊脚本把内存刷爆
let warned = 0;

function record(key) {
  const hit = violations.get(key);
  if (hit) { hit.count++; return; }
  if (violations.size >= MAX_KINDS) return;
  violations.set(key, { key, count: 1 });
  // 只提示一次（每个字段），避免每帧刷屏；玩家在 F12 里能看到自己越权写了什么
  if (warned < MAX_KINDS) {
    warned++;
    console.warn(`[自动驾驶] 算法试图写入只读字段 ${key}：已忽略（算法只能写 car._xxx 与 out）`);
  }
}

/** 取走并清空本轮记录的违规（台架 / 调试用） */
export function drainDriverViolations() {
  const out = [...violations.values()];
  violations.clear();
  warned = 0;
  return out;
}

export function resetDriverViolations() {
  violations.clear();
  warned = 0;
}

/**
 * 把只读视图还原成真实 perf 对象。
 * 弯速表缓存以 perf 对象为键：算法手里是视图，引擎手里是真对象，
 * 不做归一化会各自建一张表（内存翻倍、调校后视图表不刷新）。
 */
export function perfAliasOf(perf) {
  return perfAlias.get(perf) || perf;
}

function perfView(perf) {
  if (!perf || typeof perf !== "object") return perf;
  let view = perfViews.get(perf);
  if (view) return view;

  let maxSpeedView = null;
  view = new Proxy(perf, {
    get(target, key) {
      if (key === "maxSpeed" && Array.isArray(target.maxSpeed)) {
        // 冻结副本：改它没有意义，也影响不到物理
        if (!maxSpeedView
          || maxSpeedView.length !== target.maxSpeed.length
          || maxSpeedView.some((v, i) => v !== target.maxSpeed[i])) {
          maxSpeedView = Object.freeze([...target.maxSpeed]);
        }
        return maxSpeedView;
      }
      return target[key];
    },
    set(_t, key) { record(`car.perf.${String(key)}`); return true; },
    deleteProperty(_t, key) { record(`car.perf.${String(key)}`); return true; },
    defineProperty(_t, key) { record(`car.perf.${String(key)}`); return true; },
    setPrototypeOf() { return true; },
  });

  perfViews.set(perf, view);
  perfAlias.set(view, perf);
  return view;
}

function carView(car) {
  if (!car || typeof car !== "object") return car;
  let view = carViews.get(car);
  if (view) return view;

  view = new Proxy(car, {
    get(target, key) {
      if (key === "perf") return perfView(target.perf);
      return target[key];
    },
    set(target, key, value) {
      // 只有 _ 前缀是算法自己的状态（car._myState 之类），其余一律只读
      if (typeof key === "string" && key.charCodeAt(0) === 95 /* '_' */) {
        target[key] = value;
        return true;
      }
      record(`car.${String(key)}`);
      return true;
    },
    deleteProperty(target, key) {
      if (typeof key === "string" && key.charCodeAt(0) === 95) {
        delete target[key];
        return true;
      }
      record(`car.${String(key)}`);
      return true;
    },
    defineProperty(target, key, desc) {
      if (typeof key === "string" && key.charCodeAt(0) === 95) {
        return Reflect.defineProperty(target, key, desc);
      }
      record(`car.${String(key)}`);
      return true;
    },
    setPrototypeOf() { return true; },
  });

  carViews.set(car, view);
  return view;
}

/** 单车只读视图（main / netrace / 台架统一走这里） */
export function driverCarView(car) {
  return carView(car);
}

/**
 * 场上车辆数组的只读视图。
 * 每次调用返回一个新的冻结数组：算法即使 push / sort / 赋值也动不到引擎的复用数组。
 */
export function driverCarsView(cars) {
  if (!Array.isArray(cars)) return cars;
  const out = new Array(cars.length);
  for (let i = 0; i < cars.length; i++) out[i] = carView(cars[i]);
  return Object.freeze(out);
}
