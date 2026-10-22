# 无头调试自动驾驶脚本（autopilot-bench）

在终端里用**真实物理引擎**跑你的 `driver` 脚本，秒级拿到圈速，不用开浏览器。
本文档讲：怎么写、怎么跑、怎么看结果、怎么定位问题，以及开发者怎么用它做新车/新赛道的公平性回归。

> 工具位置：`scripts/autopilot-bench.mjs`（`npm run algo:bench`）
> 算法可用的全部字段/函数：`autopilot-doc.md`（游戏内「📖 参数说明」页面直接渲染同一份 Markdown）

---

## 0. 30 秒上手

```powershell
# 1) 从游戏内「🤖 自动驾驶」编辑器里 Ctrl+A / Ctrl+C，存成 my_driver.js
# 2) 跑一场
npm run algo:bench -- --algo=my_driver.js --track=monza --car=apex-hunter

# 3) 想知道各车适配情况
npm run algo:bench -- --algo=my_driver.js --track=monza --car=all

# 4) 想知道和内置算法差多少
npm run algo:bench -- --algo=my_driver.js --algo=superDriver --track=monza --car=apex-hunter --laps=3

# 5) 先感受一下：仓库自带的示例算法跑全部赛车
npm run algo:bench:sample
```

输出长这样（下面是仓库自带示例算法 vs 内置 `superDriver` 的真实结果）：

```
算法           │ 赛车              │ 最快圈    │ 总时       │ 各圈                        │ 平均      │ 极速      │ 草地  │ 违规/异常
────────────────────────────────────────────────────────────────────────────────────────────────────────────
自动驾驶脚本   │ 法拉利 #16        │ 1:09.900  │ 3:33.367   │ 1:13.567 1:09.900 1:09.900  │ 298 km/h  │ 360 km/h  │ 0%    │ 0 / 0
superDriver    │ 法拉利 #16        │ 1:10.717  │ 3:35.767   │ 1:14.300 1:10.717 1:10.750  │ 295 km/h  │ 360 km/h  │ 0%    │ 0 / 0

合计 2 场 · 仿真 429.1s · 实际耗时 569ms（754× 实时）
```

> 命令里的 `--` 是 npm 的分隔符：`--` 之后的参数才会传给脚本。也可以直接
> `node scripts/autopilot-bench.mjs --algo=...`，参数完全一样。

---

## 1. 脚本长什么样

### 硬性约定

- 必须有一个名为 **`driver`** 的函数：`driver(car, out, dt, otherCars)`（`const driver = (…) => {…}` 也行）。
- **只能写 `out` 和 `car._xxx`**：
  - `out.up` / `out.brake` / `out.steer` 是控制量，每个物理步都要显式赋值（`out` 是复用对象）。
  - `car` / `otherCars` 是**只读视图**：写 `car.x` / `car.speed` / `car.perf` 会被引擎丢弃并记录一条越权写入。
  - 自己的状态请挂 `car._myState`（每辆车独立，换车/重开自然重置）。
- 不能访问宿主全局：`window` / `document` / `localStorage` / `fetch` / `__gp` / `Function` / `setTimeout` 一律是 `undefined`。
- 不能用 `import` / `require`；只有注入的 API + `Math` / `JSON` / `console` / 类型化数组等标准库。

### 最小可跑示例（纯追踪 + 刹车距离扫描）

```js
// my_driver.js —— 实测：蒙扎 1:10.2 / 银石 1:15.0 / 上赛 1:18.0 / 直线赛道 1:05.0
function driver(car, out, dt) {
  const v = Math.abs(car.speed);
  const perf = car.perf || {};
  const cap = getSuperCornerCap(car.perf);      // 每个采样点的弯中极限速度表（m/s）

  // 1) 纵向：向前扫一段"刹车距离"，算出此刻允许的最高速度
  const brakeA = PHYS.brake * (perf.brakeMult ?? 1) * 0.85;
  const scanM = (v * v) / (2 * brakeA) + 30;
  const steps = Math.min(Math.round(scanM / DS), N - 1);
  let vLimit = cap[car.nearIdx];
  for (let s = 1; s <= steps; s++) {
    const d = s * DS;
    const allowed = Math.sqrt(cap[track.idxAt(car.trackS + d)] ** 2 + 2 * brakeA * d);
    if (allowed < vLimit) vLimit = allowed;
  }
  out.brake = v > vLimit + 3 ? 2 : v > vLimit ? 1 : 0;
  out.up = out.brake === 0 && v < vLimit;

  // 2) 转向：纯追踪 + 曲率前馈（用车辆自己的转向上限换算成方向盘开度）
  const j = track.idxAt(car.trackS + 12 + v * 0.55);   // 环形取模 / 直线钳制都安全
  const dx = lineX[j] - car.x, dy = lineY[j] - car.y;
  const dist = Math.hypot(dx, dy) || 1;
  const alpha = wrapAngle(Math.atan2(dy, dx) - car.angle);
  const kappa = (2 * Math.sin(alpha)) / dist;          // 需要的路径曲率
  const latGrip = perf.latGrip ?? PHYS.latGrip;
  const maxOmega = perf.maxOmega ?? PHYS.maxOmega;
  const omegaMax = Math.min(maxOmega, latGrip / Math.max(v, 1)) * Math.min(1, v / 3);
  out.steer = clamp((v * kappa) / Math.max(omegaMax, 1e-4), -1, 1);

  // 3) 可选：把瞄准点写进「AI 探测线」，在游戏里能看到你在瞄哪
  out.targetX = lineX[j];
  out.targetY = lineY[j];
  out.targetSpeed = vLimit;
}
```

两个容易踩的坑，上面的写法已经规避：

- **不要用 `Math.round(距离 / DS)` 换算下标**：采样点按曲线参数均匀、不是按米均匀（蒙扎直线段 18m/点、弯里 8m/点），
  误差能到一倍。统一用 `track.idxAt(car.trackS + 米)`。
- **刹车要扫前方一段**，只查当前点或下一格必然晚刹；按 `√(cap² + 2·a·d)` 反推"此刻允许的速度"。

---

## 2. 常用命令

> 下表里的参数都接在 `npm run algo:bench -- ` 后面（或 `node scripts/autopilot-bench.mjs ` 后面）。

| 目的 | 命令 |
|---|---|
| 单车单赛道 | `--algo=my.js --track=monza --car=apex-hunter` |
| 全车对比（新车/算法适配） | `--algo=my.js --track=monza --car=all` |
| 全赛道（默认每站 1 圈） | `--algo=my.js --track=all --car=apex-hunter --laps=1` |
| 多算法同场对比 | `--algo=my.js --algo=superDriver --algo=geminiDriver` |
| 缠斗（整场对局，其余车用内置 AI） | `--mode=vs` |
| 只比算法（同款车 1v1） | `--mode=duel --car=apex-hunter` |
| 模拟 30fps 低端机 / 帧率抖动 | `--dt=0.0333` / `--jitter` |
| 复现某次结果 | `--seed=7 --dt=0.016666` |
| 保存结果给 CI / 做回归 | `--json=baseline.json`，之后加 `--baseline=baseline.json` |
| 看每圈、异常、违规、console | `--verbose` |
| 看有哪些赛道/车/内置算法 | `--list` |
| 从 stdin 读源码 | `Get-Content my.js -Raw \| node scripts/autopilot-bench.mjs --algo=-` |
| 复现"加固前"的越权行为（只审计） | `--raw` |

内置算法名：`superDriver`、`geminiDriver`、`apexHunter`、`vectorPursuit`、`classicBaseline`、`smoothCruiser`。

---

## 3. 输出怎么读

```
算法 │ 赛车 │ 最快圈 │ 总时 │ 各圈 │ 平均 │ 极速 │ 草地 │ 违规/异常 (+Δ)
```

| 列 | 含义 |
|---|---|
| 最快圈 / 总时 | 引擎自己算的 `car.best` / `car.total`（毫秒级），与游戏内一致；`—` = 没跑完（DNF） |
| 各圈 | 每圈用时；**第 1 圈含发车**（从发车位起步），通常比后面慢 2~4s |
| 平均 | 最快圈的平均速度 = 赛道长度 / 最快圈 |
| 极速 | 本场最高速度（km/h） |
| 草地 | 车轮在草地上（`car.surf === 2`）的帧占比，> 5% 基本就是跑飞了 |
| 违规/异常 | `⚠N` = N 类越权写入（引擎已拦截，明细在下面）；`✗N` = 异常次数；正常应为 `0 / 0` |
| Δ | 只有 `--baseline` 时出现：相对基线的**最快圈差值**，负数 = 变快 |

其他提示：

- `同场：P2 红牛 #1(内置) 1:15.217` 只有 `--mode=vs/duel` 才有。
- `⚠ 3 类越权写入（引擎已拦截）：car.x 被引擎拦截 · 共 21600 次…` → 把那些字段改成 `car._xxx`，
  否则**成绩虽然是干净的，但你在游戏里也是同样的写法**（写入会一直被丢弃）。
- 末尾 `合计 N 场 · 仿真 Xs · 实际耗时 Yms（Z× 实时）`：`Z` 是引擎仿真速度；
  如果某一场的"实际耗时"明显偏高，通常说明你的算法在这一场做了很重的一次性计算（建表/建线）。

---

## 4. 调试套路（按顺序来最省时间）

1. **先保证能完赛**：`--car=apex-hunter --mode=solo --laps=2`，要求 `违规/异常 = 0 / 0`、
   草地 < 5%、有总时。跑不完先别管圈速。
2. **看每圈**：第 1 圈慢是正常的；如果第 2、3 圈还在变快/变慢（> 0.5s），说明控制有振荡或者预热不足。
3. **二分定位问题**：
   - 只控方向（`out.up = true; out.brake = 0;`）→ 还跑飞 = 转向/前瞻有问题；
   - 只控速度（`out.steer = 0`，方向照抄 `lineX`）→ 还跑飞 = 刹车规划有问题。
4. **打日志**：`console.log` 可用，`--verbose` 会实时打印；**别放在热路径**（每物理步都会调用），
   建议用计数器：
   ```js
   car._n = (car._n || 0) + 1;
   if (car._n % 60 === 0) console.log("v=" + Math.abs(car.speed).toFixed(1) + " surf=" + car.surf);
   ```
   台架每场最多保留 300 条日志，结果里只带前 20 条；要全量就用 `--verbose`。
5. **复现与鲁棒性**：固定 `--seed`（发车位 / 巡航速度 / 你的 `Math.random`），
   再用 `--dt=0.0333 --jitter` 跑一遍——帧率抖动下崩掉，多半是控制增益太激进或用了未平滑的量
   （`car.accel` / `car.gLat` 是平滑过的，`car.speed` 是瞬时值）。
6. **升级到交通**：`--mode=vs`（其余车用内置 AI）看名次和"同场"，`--mode=duel` 只比算法。
   贴身超车判断记得留 1~2m 余量（在线对局里对手坐标还是几十毫秒前的）。
7. **性能预算**：算法每个物理子步都会跑（60 次/秒/车；16× 倍速最多 32 步/帧）。
   台架的"实际耗时"能反映算法本身的成本，别在里面做大数组分配或字符串拼接。
8. **收尾**：把结果用 `--json=跑速基线.json` 存一份，之后每次改都加 `--baseline=跑速基线.json` 对比，
   避免"越调越慢还以为自己变快了"。

---

## 5. 报错速查

| 现象 | 原因 / 处理 |
|---|---|
| `✗ 没有找到 driver(car, out, dt, otherCars) 函数` | 函数名不是 `driver`（比如写成了 `superDriver` / `main`），或者被包在别的函数里 |
| `✗ 语法错误：Unexpected token …` | 语法问题。台架与游戏用同一套编译，先确认编辑器里能显示 `✓ 算法编译通过` |
| `window is not defined` / `localStorage is not defined` | 用了宿主全局，算法作用域里已被屏蔽 |
| `Function is not a function` / `setTimeout is not a function` | 同上（`Function` / 定时器也是被屏蔽的） |
| 车完全不动 | 某个分支没写 `out.up` / `out.brake`（`out` 是复用的，会沿用上一步；抛异常后也会用"松油滑行"代替） |
| 一直 DNF、草地 90%+ | 转向跟不上 / 刹车太晚。先把速度压到 30 m/s 看能不能贴线跑完，再逐级放开 |
| 一进弯就掉速到 ≈24 m/s 且回不来 | 跟踪误差兜底被触发（`trackErr > 6`），说明你的走线或前瞻离实际位置太远 |
| 圈速随机抖动 0.3s+ | 用了未平滑的瞬时量做反馈，或没处理 `dt` 变化（`--jitter` 能放大这个问题） |
| 违规里出现 `car.x` / `car.speed` / `car.finished` | 改成 `car._xxx` 存自己的状态；这些字段引擎不接受写入 |
| 结果 `Δ 新增` / `Δ 无法对比` | 基线里没有这条（赛道/车/算法名不匹配），或者两边有一边是 DNF |

---

## 6. 与游戏内的差异（必须知道）

**一致的部分**

- 物理：`stepCar`（纵向/转向/摩擦圆/路面）、`resolveCarCollisions`、`updateCarLap` 全部原样调用，
  调用顺序与 `main.js` 的物理子步一致。
- 计时：从绿灯 0 开始（跳过 3 秒倒计时），发车格起步，`car.best/total` 由引擎自己写。
- 算法环境：与游戏内同一套注入参数、同一套加固（只读视图 / 只读数据副本 / 屏蔽宿主全局）。
- 完赛后仍会调用算法（单人/对战 AI 的行为），但 `out.up` 被巡航逻辑接管。

**不一致的部分**

- 没有渲染、键盘、弹窗、HUD；不会写 `localStorage`。
- 步长固定（默认 1/60）；游戏里是帧间隔（≤1/30），倍速快进会切成子步。要贴近低端机用 `--dt=0.0333`。
- **不模拟在线对局**：在线是"自车本地模拟 + 服务器 30Hz 快照 + 80ms 播放延迟"，台架里没有对手的插值误差，
  也不会有"客户端碰撞只影响自己"的掉速。在线自车的物理与 `solo` 同源，所以 solo 成绩仍有参考价值，
  但**别用台架预演贴身缠斗**。
- 服务器还会拒绝单帧位移超限的位置/里程上报（瞬移在联网里无效），这一层台架不模拟。

---

## 7. 开发者：新车 / 新赛道的公平性检查

推荐流程（每次改车、改物理常量、加赛道都跑一遍）：

```powershell
# 1) 同一算法跑全部赛车（把"车"作为唯一变量）
npm run algo:bench -- --algo=superDriver --track=monza --car=all --laps=1

# 2) 同款车 1v1：排除车的差异，只看算法（你的 vs 该车内置）
npm run algo:bench -- --algo=my.js --track=monza --car=all --laps=1 --mode=duel

# 3) 存基线（工具自己写文件，不用 shell 重定向）
npm run algo:bench -- --algo=superDriver --track=all --car=all --laps=1 --json=baseline.json

# 4) 改完车/物理后再跑，直接看 Δ
npm run algo:bench -- --algo=superDriver --track=all --car=all --laps=1 --baseline=baseline.json
```

判读口径：

- **车差异**：同一算法下，同类车（F1 组）的最快圈差距应在 1~2s 内；实测蒙扎 1 圈
  `1:13.5 ~ 1:15.2`（F1 组），民用车 `1:19 ~ 1:34`。新车如果比同组最快还快 1s 以上，基本就是性能给多了。
- **算法差异**：`--mode=duel` 里 "P1/P2 + 总时差" 是最干净的对比（同车、同胎、同格位差 8m）。
- **回归**：`Δ 最快圈` 超过 0.3s 必须能解释（改了什么物理/走线/限速）；草地% 突然上升通常意味着
  走线数据或弯速表被改坏了。
- **稳定性**：同一组参数连跑 3 个 `--seed`，最好成绩与 worst 相差应 < 0.2s，否则说明算法对发车位很敏感。

---

## 8. 原理与边界

- 台架**不改物理**：只是把 `main.js` 的循环（倒计时除外）搬进 Node，每步 `driver → stepCar → 计圈 → 碰撞`。
- 注入参数、编译工厂、只读视图都从游戏模块 import（`src/ui/autopilot.js` / `src/game/driverSandbox.js`），
  所以"游戏里能用的东西"和"台架里能用的东西"只有一份定义，不会漂移。
- 严格模式（默认）下越权写入由**引擎**拦截，不是台架事后修补；`--raw` 才是"注入真实对象"的复现模式。
- 不是安全沙箱：`({}).constructor.constructor` 这类刻意逃逸仍可能拿到全局；它挡的是常规写法。

---

## 附录 A：注入 API 速查

| 名称 | 说明 |
|---|---|
| `N` | 采样点数量（下标 0 ~ N-1） |
| `pts[i]` / `nor[i]` | 中心线点 / 单位法向（指向行进方向右侧） |
| `hw[i]` | 该点半宽（米） |
| `curvS[i]` | 平滑后的有符号曲率（`|curvS| > 1/110` ≈ 弯道） |
| `lineX[i]` / `lineY[i]` | 预计算赛车线（离沥青边缘至少 3.4m） |
| `DS` | **平均**采样间距；换算索引请用 `track.idxAt` |
| `PHYS` | 物理常量（`brake` / `latGrip` / `maxOmega` / `accelCurve` …，已冻结副本） |
| `clamp` / `wrapAngle` | 限幅 / 角度归一化 |
| `getSuperCornerCap(perf)` | 对称 ±30m 窗口的弯速表（96% 抓地，`superDriver` 用） |
| `getApexReleaseCap(perf)` | 过弯心即释放的非对称弯速表（96.5%，`geminiDriver` 用） |
| `evaluateTrafficAndOvertake(car, otherCars, ti, dt)` | 跟车/超车决策（有状态，每帧只调一次） |
| `getCarDistance(a, b)` | `{ sLon, dLat, gapFrontRear, gapLateral, distCenter }` |
| `superDriver(car, out, dt, otherCars)` | 内置完整算法，可先调用再覆盖个别字段 |
| `track.idxAt(米)` / `track.isLinear` / `track.length` / `track.kerbFlag[i]` … | 赛道元信息（实时读取） |
| `CAR_LENGTH` / `CAR_WIDTH` | 车身包围盒 5.6m × 2.0m |

字段级说明（`car.*`、`o.*`、`out.*`、返回值明细）见 `autopilot-doc.md`（`autopilot-doc.html` 是它的渲染页）。

## 附录 B：参数表

| 参数 | 说明 |
|---|---|
| `--algo=<文件\|名字\|->` | 算法源码 / 内置算法名 / `-` 读 stdin；**可重复**；可写 `别名=路径` |
| `--track=<id\|all>` | 缺省 `shanghai`；`all` = 全部赛道（未显式给 `--laps` 时每站 1 圈） |
| `--car=<id\|all>` | 缺省 `all` = 全部赛车各跑一场 |
| `--laps=<n>` | 缺省 3 |
| `--mode=solo\|vs\|duel` | 缺省 `solo` |
| `--dt=<秒>` | 缺省 `1/60`；`0.0333` 模拟 30fps |
| `--jitter` | 步长 ±40% 抖动 |
| `--seed=<n>` | 缺省 1；控制发车位、巡航速度与算法里的 `Math.random` |
| `--random-grid` | 随机发车位（缺省固定，便于对比） |
| `--raw` | 复现加固前行为（裸对象 + 真实数组），只审计不拦截 |
| `--ignore-errors` | 异常后继续跑（松油滑行），否则 3 次异常中止本场 |
| `--max-seconds=<n>` | 单场仿真上限（秒），缺省 `圈数 × 240 + 120` |
| `--json` / `--json=<文件>` | 输出结果数组到 stdout / 直接写 UTF-8 文件（推荐后者，绕开 shell 重定向编码） |
| `--baseline=<json>` | 与之前保存的结果对比，表格里加 `Δ 最快圈`（兼容带日志前缀 / UTF-16 的文件） |
| `--verbose` | 打印每圈、异常、违规明细、`console.log` |
| `--list` | 列出赛道 / 赛车 / 内置算法 |
