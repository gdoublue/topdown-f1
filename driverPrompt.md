# 任务：为 Topdown F1 写一个可直接运行的自动驾驶算法 `driver(car, out, dt, otherCars)`

> **使用方法（给人看的）**：把本文件从「用户指令」到「输出前自检清单」整段复制给目标大模型，不要改动其中的常量与字段名。
> 代码会原样粘贴进游戏内的「🤖 自动驾驶」编辑器，或用 `node scripts/autopilot-bench.mjs --algo=你的文件.js` 跑无头台架。

---

## 用户指令

你是一名赛车运动控制工程师。请输出**一个完整的 JavaScript 函数体**，实现下面这套 2D 俯视视角、无悬挂/无轮胎滑移角建模的街机 F1 物理下的**时间最优自动驾驶**。

它必须：
1. **在任意一条赛道上都不冲出沥青**，草地占比 ≈ 0%（尤其注意最弱制动的那台车，见 §9）；
2. **圈速优于下面给出的参考基线**（蒙扎 / 法拉利 SF-24 / 3 圈：最快圈 **≤ 1:09.8**，且必须快于 §11 的参考骨架 **1:09.817**）；
3. 在 7 条赛道 × 7 台车（从 360 km/h、横向 4.9g 的 F1，到 496 km/h、横向只有 1.7g、满刹只有 2.0g 的电车）上都不崩、不违规、不抛异常、全部完赛；
4. 在有多名对手时不被堵死、能完成超车，且不把对手（也不把自己）顶出赛道。

---

## 0. 输出格式（硬要求，违反即作废）

- 只输出**一个** ```js 代码块，内容是一份可以直接粘贴保存为 `.js` 并运行的完整文件。
- 文件里必须存在**名为 `driver` 的函数**：`function driver(car, out, dt, otherCars) { ... }` 或 `const driver = (car, out, dt, otherCars) => { ... }`。函数名不能叫别的。
- **禁止**：`import` / `export` / `require` / TypeScript 语法 / `class` 导出的对外接口 / 任何 HTML；禁止访问 `window` / `document` / `localStorage` / `fetch` / `setTimeout` / `__gp` / `Function` / `eval`（见 §1.3）。
- 允许并且鼓励：在文件顶层写普通 `function` / `const` 辅助函数与常量，`driver` 内部调用它们。
- 允许使用：`Math`、`JSON`、`console`、`Number`、`Float32Array` / `Float64Array` / `Int32Array` / `Uint8Array`、`Map` / `Set`。
- 代码块之后最多再写 15 行说明（设计要点 / 相较参考骨架改了什么）。**不要写长篇教程。**

---

## 1. 运行环境（决定什么写法会崩）

### 1.1 代码怎么被编译

你的源码被塞进一个 `new Function` 里，注入的数据是**这个包装函数的形参**，最后取 `driver`：

```js
// 语义等价（真实实现在 src/ui/autopilot.js）
const factory = new Function(`
  return function (N, pts, nor, hw, curvS, lineX, lineY, DS, PHYS,
                   clamp, wrapAngle, getSuperCornerCap, evaluateTrafficAndOvertake,
                   CAR_LENGTH, CAR_WIDTH, getCarDistance, superDriver, track,
                   getApexReleaseCap, window, document, ...) {
    <你的源码>
    return (typeof driver === "function" ? driver : null);
  }`);
const fn = factory()(...注入值);
```

推论（都会真实影响你）：

- **顶层代码只在编译时执行一次**，之后每帧只调用 `driver`。顶层可以建常量、建缓存，但**顶层拿不到 `car`**。
- 顶层 `let/const` 是"编译期状态"：换赛道会自动重新编译 → 顶层状态被重置。想跨帧/跨赛道保留，挂在 **`car._xxx`** 上（每辆车独立、换车自然重置）。
- 函数被 `driver.call(空对象, car, out, dt, otherCars)` 调用，`this` 是空对象。

### 1.2 调用频率与预算

- 每个**物理子步**调用一次（正常 60~144 次/秒）；开倍速时一帧会切最多 **32 个物理子步**，即一帧最多调用 32 次。
- **`dt` 不是固定值**：单步上限为 `1/30` 秒（`MAX_SUBSTEP_DT`），高刷屏更小（约 1/144），倍速快进与在线掉帧补偿都会把时间拆成更小的子步。做积分 / 预测时用 `dt` 现场换算，不要假设 1/60。
- 因此：单次调用要 **< 0.2 ms**。禁止每帧 `new` 大数组、禁止 O(N²) 大循环、禁止 `console.log` 刷屏。
- 一次性重初始化（例如自己重算赛车线）只允许在**第一次调用**做，控制在几十毫秒内，并按 **`track.id` 或 `N` 或注入的 `pts` 引用**判断是否需要重建。
- 抛异常会中断该帧剩余的物理与渲染（画面像卡死）；编译失败则继续用上一次成功的算法。所以**任何除法、数组下标都要有保护**。

### 1.3 宿主全局被形参遮蔽（值为 `undefined`）

`window document localStorage sessionStorage indexedDB caches cookieStore fetch XMLHttpRequest WebSocket EventSource Worker SharedWorker serviceWorker navigator location history screen top parent self globalThis frames opener postMessage importScripts Function setTimeout setInterval clearTimeout clearInterval requestAnimationFrame cancelAnimationFrame __gp WebAssembly`

→ 想在游戏里"跨赛道保留状态"只能挂 `car._xxx`，不能挂 `window`。

---

## 2. 坐标系、单位、符号约定（写错方向 = 直接反打方向）

| 项 | 约定 |
|---|---|
| 世界单位 | 1 = 1 米；速度 m/s；加速度 m/s²；角度**弧度** |
| x 轴 | 向右 |
| **y 轴** | **向下**（屏幕坐标） |
| `car.angle` | 车头朝向，`0` = 指向 +x；**角度增大 = 屏幕上顺时针 = 车向右转** |
| `out.steer` | `-1 ~ 1`，**负 = 左，正 = 右**（与 `car.angle` 增大的方向一致，无需取反） |
| 法向 `nor[i]` | 单位向量，指向**行进方向的右侧**；`nor = (-tangent.y, tangent.x)` |
| 横向偏移 | `点 = pts[i] + nor[i] * off`，`off > 0` 在中心线**右侧** |
| `curvS[i]` | 有符号曲率（1/m，±9 点滑动平均）。**`curvS > 0` = 向右弯（顺时针），弯心在 `+nor` 一侧；`curvS < 0` = 向左弯，弯心在 `-nor` 一侧。** |
| 粗糙判别 | `|curvS| > 1/110` 就是系统认定的"要铺路缘石"的弯（半径 < 110 m）；`|curvS| > 0.008` ≈ 半径 < 125 m；曲率半径 `R = 1 / |k|` |
| 倒车 | `car.speed < 0`；所有速度运算请用 `Math.abs(car.speed)` |

---

## 3. 可读：`car`（你自己的车，**只读**）

写 `car.x = ...` / `car.speed = ...` / `car.finished = ...` 会被引擎**静默丢弃**并记一条越权写入——瞬移、改速、伪造完赛在引擎层不存在。**只有 `car._` 开头的字段可写**（`car._myState` 这类，等价于你的私有状态槽）。

| 字段 | 单位 | 含义 |
|---|---|---|
| `car.x` / `car.y` | 米 | 世界坐标（y 向下） |
| `car.angle` | rad | 车头朝向 |
| `car.speed` | m/s | **有符号**（倒车为负），×3.6 = km/h |
| `car.steer` | ≈ -0.55 ~ 0.55 | 平滑后的方向盘显示值（满舵约 ±0.55，**不是** ±1）；只用于抑制抖动，不是物理量 |
| `car.nearIdx` | 索引 | 最近中心线采样点下标 `0 ~ N-1` |
| `car.trackS` | 米 | 沿中心线的**精确**里程。环形赛道单圈内 `0 ~ track.length`；直线赛道会一路增长（沥青含冲线后缓冲区，可超过 `track.length`） |
| `car.raceDist` | 米 | 比赛总里程（排名用）。环形赛道发车格上为负（-12 / -20 …）；直线赛道从 0 开始 |
| `car.lap` | 圈 | 当前第几圈（从 1 开始） |
| `car.finished` | bool | 是否已冲线。冲线后：在线对战不再调用你；单人 / 对战 AI 仍调用但 `out.up` 被巡航逻辑接管（60~100 km/h），只有 `brake` / `steer` 生效 |
| `car.surf` | 0/1/2 | 0 沥青、1 路肩、2 草地 |
| `car.gLat` / `car.gLon` / `car.gTotal` | G | 平滑后的横向 / 纵向 / 合成加速度 |
| `car.braking` | bool | 上一步是否**真的在减速** |
| `car.inUp` / `car.inBrake` / `car.inSteer` | — | **上一步你自己写出去的值**（不是键盘）；`inBrake` 0/1/2 |
| `car.accel` | m/s² | 上一步实际纵向加速度（负 = 减速），**参与摩擦圆计算** |
| `car.best` / `car.last` / `car.total` / `car.lapTimes` | ms | 最快圈 / 上一圈 / 总时（`total` 只在冲线瞬间写入，比赛中一直是 0） |
| `car.gridPos` / `car.idx` | 索引 | 发车格位（0 = 杆位）/ 上一步的 `nearIdx` 历史值 |
| `car.id` / `car.name` / `car.perf` | — | 车辆信息 / 性能配置（见 §3.1） |
| `car.vTarget` | m/s | `Float32Array`，长度 N，**本车预计算的目标速度表**：已含弯速 + 反向刹车传播，但按 **78% 抓地**生成（保守）。可直接查 |
| `car.nickname` / `shortName` / `number` | — | 显示信息（单机下 `nickname` 为 `undefined`） |

### 3.1 `car.perf`（只读，字段可能缺失 → 用 `??` 回落到 `PHYS`）

| 字段 | 含义 |
|---|---|
| `perf.maxSpeed` | `[沥青, 路肩, 草地]` 三档**极速**（m/s） |
| `perf.latGrip` | 最大横向抓地（m/s²，÷9.81 = G） |
| `perf.maxOmega` | 低速最大转向角速度（rad/s） |
| `perf.brakeMult` | 刹车倍率：满刹减速度 = `PHYS.brake × brakeMult` |
| `perf.accelMult` / `perf.highSpeedAccel` | 油门加速倍率 / 100 m/s 以上推力倍率（燃油车曲线） |
| `perf.powerKW` / `perf.massKg` / `perf.launchAccel` | 电车功率模型参数（有 `powerKW` 时走功率限速，见 §6.4） |
| `perf.steerRate` | 只影响 `car.steer` 的平滑，**不影响物理转向** |
| `perf.cornerGripMult` | 调校面板「弯速极限」，**两张弯速表都会乘它**（默认视为 1） |

**车辆谱系（说明不能硬编码任何常量）**：沥青极速 100 ~ 137.8 m/s（360 ~ 496 km/h）；`latGrip` 16.2 ~ 48.2 m/s²（1.65g ~ 4.9g）；`brakeMult` 0.29 ~ 1.08 → 满刹减速度 **17.9 ~ 66.5 m/s²**（最弱的是 `smooth-cruiser` 17.9，其次 `yangwang-u9x` 19.7）。

---

## 4. 可读：`otherCars`（场上车辆数组，只读）

- 元素结构与 `car` **完全相同**；**数组里包含你自己**（一定要 `if (o === car) continue;`）。
- 只含**未完赛**的车，所以不用判断 `o.finished`。
- 数组被冻结（push / sort / 赋值无效），每项也是只读代理（改不动别人的车）。
- **顺序不固定**，不要用下标判断身份，用对象引用比较。
- 单机计时场景下 `otherCars.length === 1`（就是你自己），必须能正常工作。
- 线上房间：其他玩家的 `x / y / angle / speed / nearIdx / trackS / raceDist / lap / best / total / inBrake / inUp / inSteer` 实时同步，但坐标**落后约几十毫秒**、且 `gLat / gLon / accel / braking / surf` **不同步（恒为 0）**。做贴身判断请留 1~2 m 余量，并且**不要依赖对手的 `accel` / `surf`**。
- 双车几何请直接用 `getCarDistance(car, o)`（§8.3），不要自己拿 `angle` 手推。
- 碰撞代价（真实实现，务必利用）：包围盒 5.6 m × 2.0 m 重叠即算接触；**前后接触时后车立刻损失 45% 速度差**，**侧面擦碰双方每物理步 ×0.995**（60 fps 下约每秒掉 26% 速度）。所以"贴着蹭过去"是最亏的走法。

---

## 5. 可写：`out`（本帧控制量）

| 字段 | 类型 | 规则 |
|---|---|---|
| `out.steer` | `-1 ~ 1` | **方向盘占空比**（不是转角）。会被钳到 -1~1。**必须有速度才能转**：0→3 m/s 线性生效，静止打方向无效 |
| `out.up` | bool | 油门。**只在 `out.brake === 0`（严格数字 0）时才生效** |
| `out.brake` | **数字** `0 / 1 / 2` | `0` 松开、`1` 轻刹（45% 制动力）、`2` 重刹（100%）。**只有严格 `=== 2` 才是重刹**，其它任何正数（含 1.5、3）都按轻刹；`0` / 负数 = 松开；字符串 `"0"` 不满足 `=== 0`，油门会被忽略 |
| `out.left` / `out.right` | bool | 老式方向键模拟，**只在 `out.steer` 不是数字时才生效**。建议只写 `out.steer` |
| `out.targetX` / `out.targetY` / `out.targetSpeed` | 数字 | 仅用于「AI 探测线」可视化，不影响物理 |

**三条必须先内化的约定：**

1. **`out` 是整场比赛复用的同一个对象**。`up / brake / steer` 必须**每个分支都显式赋值**；提前 `return` 会让刹车保持上一步的状态（"车一直踩着刹车"的经典 bug）。
2. **车辆静止时按住 `brake = 2` 会倒车**（物理里 `speed <= 1` 且 `brake === 2` 就进入倒挡，倒车极速 15.4 m/s）。想"停住不动"应该用 `brake = 1`，或者只在需要脱困时才用 `2`。
3. **输出 NaN 会毁掉车辆状态**（坐标变 NaN，车从画面上消失）。所有输出前做 `Number.isFinite` 兜底。

---

## 6. 物理模型（精确实现，照此推导控制律）

### 6.1 转向

```
omega      = min(maxOmega, latAvail / max(|v|, 1)) * min(1, |v| / 3) * (surf === 2 ? 0.74 : 1)
car.angle += steerIn * omega * dt          // steerIn = clamp(out.steer, -1, 1)
```

- 即：**`out.steer` 直接线性控制横摆角速度**，上限是 `min(maxOmega, latGrip/|v|)`。
- 倒车时转向方向相反（内部还有 `·(speed < -1 ? -1 : 1)`）；正常向前行驶不用管这一项。
- 低速（< 3 m/s）转向能力线性衰减到 0；草地再 ×0.74。

### 6.2 摩擦圆（纵向吃横向）

```
longMax  = PHYS.brake * (perf.brakeMult ?? 1)
usedLong = min(1, |car.accel| / max(1, longMax))
latAvail = latGrip * sqrt(max(0.6, 1 - usedLong²))
```

→ **重刹时横向只剩 77.5%**（`sqrt(0.6)`）；轻刹（45% 制动力）≈ 87.4%；满油门加速（纵向利用率约 0.18）≈ 98.4%。所以"边重刹边满舵"会推头，刹车要在直线上完成、方向盘要在大减速之后回正。

**转向控制律必须用它，不能只用名义 `latGrip`**（这是最常见的"入弯推头冲出赛道"来源）：

```js
const brakeA = PHYS.brake * (perf.brakeMult ?? 1.0);              // 满刹减速度
const v = Math.abs(car.speed);
const usedLong = Math.min(1, Math.abs(car.accel || 0) / Math.max(1, brakeA));
const latAvail = latGrip * Math.sqrt(Math.max(PHYS.frictionLatFloor, 1 - usedLong * usedLong));
const omegaMax = Math.min(maxOmega, latAvail / Math.max(v, 1)) * Math.min(1, v / 3);  // 再乘 (surf===2 ? 0.74 : 1)
const steer = clamp((v * kappa) / Math.max(omegaMax, 1e-4), -1, 1);   // kappa 见 §11 骨架
```

用名义 `latGrip` 折算时，重刹状态下的转向上限会被高估约 **29%**（`1/0.775 - 1`），于是 `steer` 只算出 0.7~0.8 就"以为够了"，实际车根本转不过来 —— 表现就是刹车进弯、方向打满、车照直冲出弯心。

### 6.3 纵向（油门 / 刹车 / 滑行）

```
满刹减速度 = PHYS.brake * perf.brakeMult        (PHYS.brake = 61.6)
轻刹       = 满刹 * 0.45
滑行减速   = 2.24 + |v| * 0.02  (+ 11.2 在草地)
```

- 燃油车满油门加速度：对 `PHYS.accelCurve = [[0,11.6],[28,11.0],[56,8.5],[78.4,5.5],[100,1.5]]` 做**分段线性插值**，再乘 `perf.accelMult`；`v > 100 m/s` 时固定为 `1.5 × (perf.highSpeedAccel ?? 1) × accelMult`。
- 路肩：加速度 ×0.85；草地：加速度 ×0.6，并且速度会额外乘 `(1 - 0.4·dt)`。
- 超过极速会被强行拉回：`|v| > maxSpeed[surf]` 时按 120 m/s² 收敛到极速。

### 6.4 电车功率模型（`perf.powerKW != null`）

```
k = P / (m · vmax³)                       // P = powerKW×1000, m = massKg ?? 2200
a = min(P / (m · max(v, 2)) - k · v², launchAccel)   // 再 max(a, 0)
```

高速段推力按 `1/v` 衰减、`v²` 风阻——496 km/h 的车和 F1 的加速曲线完全不同，**必须按 `perf` 现场算，不能写死**。

### 6.5 路面判定（与画面严格一致）

```
d      = 到中心线的垂距, hwHere = hw[nearIdx]
kerb   = track.isLinear || kerbFlag[nearIdx] === 1   // 直线赛道全程算有路缘石
if      (d < hwHere)            surf = 0             // 沥青
else if (kerb)                  surf = d < hwHere + 1.5 ? 1 : 2   // 1.5m 路肩带，再外是草地
else                            surf = d < hwHere + 0.4 ? 0 : 2   // 白线 0.4m 容差之内仍算沥青
```

三档极速/加速/转向差异巨大（路肩 324 km/h、草地 121 km/h），**"离沥青边缘留多少余量"是圈速的第一杀手**：内置赛车线被限制在 `±(hw - 3.4)` 内。

### 6.6 赛道侧向约束

- `hw[i]` 是逐点半宽：常规 7.0 ~ 7.5 m，最紧弯心前后 ±110 m 会平滑加宽到 9.5 ~ 10 m；直线冲刺赛道恒为 18 m。
- 想要 0% 草地：横向偏移绝对值建议 **≤ hw - 2.2**（内置算法统一用 `hw - 2.15 ~ hw - 2.2` 作为安全墙）。

---

## 7. 注入的赛道数据与 `track` API

### 7.1 数组（长度都是 `N`，下标 `0 ~ N-1`）

| 名称 | 含义 |
|---|---|
| `N` | 中心线采样点数量。**每条赛道 592 ~ 2751，不要写死**；环形赛道取模，直线赛道钳制 |
| `pts[i]` | `{x, y}` 中心线第 i 点（米） |
| `nor[i]` | `{x, y}` 该点单位法向，指向行进方向右侧 |
| `hw[i]` | 该点半宽（米） |
| `curvS[i]` | 平滑有符号曲率（1/m），符号见 §2 |
| `lineX[i]` / `lineY[i]` | **预计算赛车线**：900 次拉普拉斯松弛得到的最小曲率线，横向被限制在 `±(hw - 3.4)` 内，弯中贴内侧。跟这条线通常最快 |
| `DS` | **平均**采样间距（米）。采样点按曲线参数均匀、**不是按米均匀**（同一条赛道直道可能是 18 m/点、弯里 8 m/点），所以 `round(距离 / DS)` 误差能到一倍 |
| `PHYS` | 全局物理常量（冻结副本）：`brake 61.6`、`lightBrakeFactor 0.45`、`latGrip 45`、`maxOmega 3.4`、`maxSpeed [100,90,33.6]`、`accelCurve`、`frictionLatFloor 0.6`、`coastDecel 2.24`、`grassCoastExtra 11.2`、`reverseAccel 16.8`、`maxReverse 15.4` … |
| `CAR_LENGTH` / `CAR_WIDTH` | `5.6` / `2.0`（车头车尾各 2.8 m、左右各 1.0 m） |

> 注入给你的 `pts / nor / hw / curvS / lineX / lineY / PHYS` 都是**每次编译的副本**，随便改（但只会让你自己算错）。

### 7.2 `track`（全部是 getter，切赛道自动变新值，无需重新编译）

| 字段 / 方法 | 说明 |
|---|---|
| `track.id` / `name` / `flag` | 赛道 id / 中文名 / 国旗 |
| `track.length` | 本场计赛长度（米）。环形 = 圈长（4318 ~ 7004）；直线冲刺 = 6000（沥青还往后延伸 5 km 缓冲区，`car.trackS` 会超过它） |
| `track.turns` / `laps` | 弯道数 / 本场圈数 |
| `track.isLinear` | `true` = 直线冲刺赛道（起点→终点不闭合，单程计赛） |
| `track.N` / `track.DS` / `track.HW` | 采样点数 / 平均间距 / 基础半宽 |
| `track.kerbFlag[i]` | `1` = 该点铺了红白路缘石（可以放心压） |
| **`track.idxAt(米)`** | **沿赛道物理距离 → 采样下标**：按真实里程二分，误差 ≤1 点；环形自动取模、直线自动钳制。**这是唯一正确的"前进 N 米"换算方式**，请替代 `% N` 与 `距离/DS` |

### 7.3 七条赛道的真实参数（实测，`N`/`DS` 都是运行时变量）

| id | 名称 | 长度 m | 弯数 | 基础半宽 | 圈数 | `isLinear` | `N` | `DS` |
|---|---|---|---|---|---|---|---|---|
| `shanghai` | 上海国际赛车场 | 5451.24 | 16 | 7.0（弯心 10.0） | 3 | false | 1494 | 3.65 |
| `monza` | 蒙扎 | 5793 | 11 | 7.0（9.5） | 3 | false | 656 | 8.83 |
| `silverstone` | 银石 | 5891 | 18 | 7.0（9.8） | 3 | false | 752 | 7.83 |
| `spa` | 斯帕-弗朗科尔尚 | 7004 | 19 | 7.2（10.0） | 3 | false | 768 | 9.12 |
| `redbullring` | 红牛环 | 4318 | 10 | 7.0（9.6） | 4 | false | 592 | 7.30 |
| `dragstrip` | 琼海直线竞速场 | 6000（沥青 11000） | 0 | 18.0 | 1 | **true** | 2751 | 4.00 |
| `stadiumring` | 云栖体育场环道 | 4500 | 2 | 7.5（9.5） | 3 | false | 890 | 5.06 |

> 这张表只用于让你理解量级：**代码里一律用 `N` / `DS` / `track.length` / `hw[i]`，不要写成常数**。

### 7.4 环形 vs 直线冲刺（最容易致命的地方）

- **环形**：前进 `step` 个点写 `(i + step) % N`（负数先 `+N`）。
- **直线冲刺**：不闭合，必须 `Math.min(i + step, N - 1)` 或 `track.idxAt(米)`。照环形写 `% N` 会让"前方"绕回起点，前车/弯道判断全部错乱；也不能用 `% N` 代替钳制去调 `evaluateTrafficAndOvertake`（越界会读 `undefined` 直接抛异常）。

---

## 8. 可用的工具函数（系统注入，直接调用）

### 8.1 基础

```js
clamp(v, a, b)          // 限制在 [a, b]
wrapAngle(a)            // 角度差归一化到 [-π, π]，算航向误差必用
```

### 8.2 `getSuperCornerCap(perf)` / `getApexReleaseCap(perf)`

- 返回 `Float32Array`（长度 `N`，单位 m/s）：**每个采样点的极限过弯速度**，只回答"这一点最快能跑多快"，不含刹车规划、不含交通。
- 值 = `min(沥青极速, √(A_LAT · R), maxOmega / k)`，其中 `k` = 该点附近窗口内**最大**曲率（用的是赛车线曲率），`R = 1/k`。

| | `getSuperCornerCap` | `getApexReleaseCap` |
|---|---|---|
| 观察窗口 | 前后各 30 m（对称） | **身后 2 m / 身前 10.5 m**（非对称） |
| 抓地利用率 `A_LAT` | `latGrip × min(1, 0.96 × cornerGripMult)` | `latGrip × min(1, 0.965 × cornerGripMult)` |
| 出弯 | 过弯心后仍被压约 30 m，保守 | 过弯心约 10 m 后即解除；识别到孤立弯时等效曲率 ×0.86（外抛走线） |

使用注意：
- **必须传真实的 `car.perf`**（`getApexReleaseCap(car.perf)`），手工拼假对象会得到错误限速。
- 返回的是**按 `perf` + 赛道双键缓存的共享只读数组**：`cap[i] = ...` 会污染同 `perf` 的其他车（含 AI）。不要写它。
- 下标是**采样点下标**，不是米：查"前方 40 米处的限速"要写 `cap[track.idxAt(car.trackS + 40)]`。
- 每帧调用零开销，不用自己缓存。

### 8.3 `getCarDistance(a, b)`

```js
{ sLon, dLat, gapFrontRear, gapLateral, distCenter }
```

| 字段 | 含义 |
|---|---|
| `sLon` | 纵向距离（米），在**两车平均航向**上测得：`> 0` = b 在 a 前方 |
| `dLat` | 横向偏移（米），垂直于平均航向；正负表示左右 |
| `gapFrontRear` | 车头车尾净空隙 = `|sLon| - 5.6`；`> 0` 前后错开 |
| `gapLateral` | 车侧净空隙 = `|dLat| - 2.0`；`> 0` 横向错开（并排不碰） |
| `distCenter` | 中心直线距离 |

两个净空隙**同时 < 0** = 包围盒重叠 = 接触。建议阈值：跟车从 `gapFrontRear > 8~12 m` 开始追；并排超车要求 `gapLateral > 0.8 m`；判断"正前方同车道"用 `sLon > 0 && gapLateral < 0`。

### 8.4 `evaluateTrafficAndOvertake(car, otherCars, ti, dt)`

内置跟车 / 超车决策。`ti` 必须是 `0 ~ N-1` 的合法采样下标（用 `track.idxAt` 取）。

```js
{ targetX, targetY, shouldSlow, speedCap, steerBias, emergencyBrake, isOvertaking }
```

| 字段 | 用法 |
|---|---|
| `targetX/Y` | 已叠加超车侧移的推荐瞄准点，可直接做纯追踪目标 |
| `shouldSlow` | 是否应跟车降速（同车道前车太近）；`false` 时别用 `speedCap` |
| `speedCap` | 跟车限速 ≈ 前车速度 ×0.97；无阻挡时为 `Infinity` |
| `steerBias` | `-0.14 ~ 0.14`，并排防挤碰偏置，直接加到 `out.steer` |
| `emergencyBrake` | 已贴上前车 → 立刻 `out.brake = 2` |
| `isOvertaking` | 侧向偏移已 > 0.6 m |

**有状态**：它读写 `car._latOffset` 做平滑侧移。**每帧只能调用一次**（不要对不同前瞻下标各调一次，也不要在 `superDriver` 之后调，会互相抢偏移量）。

### 8.5 `superDriver(car, out, dt, otherCars)`

游戏内置的完整算法（三点前瞻 + 弯速表 + 时间最优闭环刹车 + 超车状态机 + 脱困）。可以直接调用、也可以先调它再覆盖个别 `out` 字段。**允许作为兜底，但直接 wrapper 会被判为没有实现需求。**

---

## 9. 已知参考基线（你的目标是超过它）

无头台架（与游戏**同一份物理与注入**）实测，蒙扎 5793 m / 法拉利 SF-24 / 3 圈 / `seed=7`：

| 算法 | 最快圈 | 总时 | 草地 | 违规 / 异常 |
|---|---|---|---|---|
| 内置 `geminiDriver`（阿斯顿 / 小米 / AiMotor 在用） | **1:09.850** | 3:33.200 | 0% | 0 / 0 |
| 仓库示例脚本 `userscripts/自动驾驶脚本.js`（双调和走线 + 双向速度包络 + 走廊评分超车） | 1:09.900 | 3:33.367 | 0% | 0 / 0 |
| §11 的参考骨架 | 1:09.817 | 3:33.133 | 0% | 0 / 0 |
| 内置 `superDriver`（自动驾驶默认） | 1:10.717 | 3:35.767 | 0% | 0 / 0 |

**评价标准**：我会用
`node scripts/autopilot-bench.mjs --algo=你的文件.js --track=all --car=all --laps=1`（7 条赛道 × 7 台车）、
`--track=all --car=all --laps=3`（看稳定圈）、`--mode=vs`（多车缠斗）复测。验收线：

- 蒙扎 / 法拉利 SF-24 / 3 圈：**最快圈 ≤ 1:09.8 且快于 §11 骨架的 1:09.817**（连骨架都没超过视为未达标）；
- 全赛道 × 全车型：**0 违规、0 异常、全部完赛、草地 ≤ 0.5%**；
- 同一条赛道上不允许明显慢于 `superDriver`（±0.3 s 内即可，个别慢 1 s 视为退步）；
- 参考：同一次复测里，极弱制动车型（`yangwang-u9x`，满刹只有 19.7 m/s²）是最容易出界的一档——**刹车规划必须按 `perf.brakeMult` 现场算余量，不要按 F1 的经验值写死**。（`smooth-cruiser` 制动已修正为 17.9 m/s²，现在是全场最弱制动车，刹车余量要按它留足。）

内置 `superDriver` 的设计骨架（供参考，别照抄）：
1. 曲率自适应三段前瞻（near / mid / far 权重随 `|curvS|` 在 0.25~0.5 之间切换）+ 纯追踪曲率 `κ = 2 sin α / d`，再换算成 `steer = clamp(v·κ / omegaMax, -1, 1)`；
2. 用 `getSuperCornerCap` 表 + **逐帧前向扫描刹车包络**（`√(cap² + 2·a·d)`）做时间最优纵向控制，双包络（轻刹 / 重刹）分档 + `aReq` 判据；
3. 跟车：沿前车速度反解可跟随最高车速 `√(v_lead² + 2·0.9·brake·safeGap) + 0.12·closing`；
4. 超车：横向走廊打分（并排禁区重罚、内线加分、方向锁定 2.5 s）+ 侧向防撞 `guard`；
5. 脱困：低速累计 > 2.5 s → 倒车 0.9 s。

已有证据表明还有提升空间（示例脚本就比它快 0.8 s），所以**请认真做走线与刹车规划，不要只复制这个骨架**。

---

## 10. 必须避开的坑（每一条都会真实烧掉一圈时间或直接崩）

1. **`out` 复用** → 每个分支都显式写 `out.up / out.brake / out.steer`；不要用"只改需要改的字段"。
2. **`continue` 跳过赋值 / 提前 `return`** → 沿用上一帧的刹车。
3. **`out.brake = true`** → `true === 2` 为 false，只是轻刹；请用数字 0/1/2。
4. **`out.brake` 保持 2 停在原地** → 会倒车。
5. **`% N` 用在直线冲刺赛道** → 前方判断绕回起点；用 `track.idxAt`。
6. **`Math.round(米 / DS)` 当下标** → 采样点不是按米均匀，误差可达一倍。
7. **`lineX/lineY/cap` 数组写成常量下标或越界读** → 抛异常，整帧卡住。
8. **多点前瞻用"绝对坐标加权平均"，或权重和不等于 1** → 瞄准点被整体平移 `(Σwᵢ − 1) × 世界坐标`。世界坐标是几百到几千（如蒙扎车在 `(1694, 117)`），**权重多 0.04 就等于瞄准点偏 68 m**，车会像"突然不会转弯了"直着冲出弯，然后一路乱走。必须写成相对向量 `car + Σwᵢ(pᵢ − car)`，并保证 `Σwᵢ === 1`（`Math.max(0.08, 1 - wNear - wMid)` 这种"抬下限"写法会直接破坏归一）。
9. **转向控制律用名义 `latGrip` 而不用摩擦圆折减后的 `latAvail`** → 重刹时真实转向上限只有名义值的 77.5%，`steer` 会被系统性算小 22%~29%，满舵也进不去弯（典型症状：入弯推头、四轮全在沥青上也照样出界）。
10. **`evaluateTrafficAndOvertake` 一帧多调** → 超车偏移量互相打架，车会左右摇摆。
11. **`getApexReleaseCap` 与 `getSuperCornerCap` 混用** → 两张表窗口不同，混用会得到自相矛盾的限速。
12. **改写 `cap[i]`** → 污染同 `perf` 的所有车（含 AI），且是共享缓存。
13. **用手工 `{latGrip: ...}` 假对象查表** → 限速错误。
14. **顶层用 `car`** → `car` 在顶层不存在。
15. **顶层 `let` 存比赛状态** → 换赛道重编译即丢失；状态请挂 `car._xxx`。
16. **每帧 `new Float32Array(N)` 或 O(N²) 扫描** → 倍速下每秒数百次调用，直接掉帧、物理步长抖动。
17. **`console.log` 每帧打印** → 控制台被刷爆，帧率骤降。
18. **`window` / `localStorage` / `fetch`** → 一律 `undefined`（包括文档里旧说法的 `window.__myState`）。
19. **NaN**：`0/0`、`Math.sqrt(负数)`、`Infinity - Infinity` 都会让车消失。所有输出前 `Number.isFinite` 兜底。
20. **静止起步就满舵**：`|v| < 3 m/s` 时转向能力线性衰减，满舵只会空转，先直着给油。
21. **草地**：一旦掉上草地，极速 121 km/h、加速 ×0.6、转向 ×0.74 —— 一次出界基本等于丢掉这一圈。
22. **贴身蹭车**：侧面接触每步双方 ×0.995，两败俱伤；前后追尾后车直接掉 45% 速度差。

---

## 11. 参考骨架（正确性已验证，但明显未到极限；你的答案必须比它更完整）

```js
// 纯追踪 + 弯速表 + 刹车包络扫描 + 简单跟车。骨架级别，请在此之上做更强的走线与纵向规划。
function driver(car, out, dt, otherCars) {
  const v = Math.abs(car.speed);
  const perf = car.perf || {};
  const latGrip = perf.latGrip ?? PHYS.latGrip;
  const maxOmega = perf.maxOmega ?? PHYS.maxOmega;
  const brakeA = PHYS.brake * (perf.brakeMult ?? 1.0);
  const lightA = brakeA * PHYS.lightBrakeFactor;

  // ---- 私有状态（只写 car._ 前缀）----
  if (car._myAI == null) car._myAI = { stuck: 0, rev: 0, moved: false };

  // ---- 脱困：受困 2 s 后倒车 0.9 s ----
  if (car._myAI.rev > 0) {
    car._myAI.rev -= dt;
    out.up = false; out.brake = 2; out.steer = 0; out.left = false; out.right = false;
    return;
  }
  if (v > 3) car._myAI.moved = true;
  if (car._myAI.moved) {
    car._myAI.stuck = v < 1.5 ? car._myAI.stuck + dt : Math.max(0, car._myAI.stuck - dt * 2);
    if (car._myAI.stuck > 2.0) { car._myAI.rev = 0.9; car._myAI.stuck = 0; }
  }

  // ---- 1) 弯速上限表（只读，按 perf + 赛道缓存）----
  const cap = getApexReleaseCap(perf);

  // ---- 2) 纵向：向前扫刹车包络，求"此刻允许的最高速度" ----
  const scanM = (v * v) / (2 * brakeA) + 60;
  const steps = Math.min(Math.round(scanM / DS), N - 1);
  let envLight = cap[track.idxAt(car.trackS)];
  let envHeavy = envLight;
  for (let s = 1; s <= steps; s++) {
    const d = s * DS;
    const c = cap[track.idxAt(car.trackS + d)];
    const r1 = Math.sqrt(c * c + 2 * lightA * d);          // 轻刹可持续包络
    const r2 = Math.sqrt(c * c + 2 * brakeA * 0.98 * d);   // 物理极限兜底
    if (r1 < envLight) envLight = r1;
    if (r2 < envHeavy) envHeavy = r2;
  }

  // ---- 3) 跟车限速（otherCars 含自己）----
  let emergency = false;
  if (otherCars && otherCars.length > 1) {
    for (let i = 0; i < otherCars.length; i++) {
      const o = otherCars[i];
      if (o === car) continue;
      const geo = getCarDistance(car, o);
      if (geo.sLon <= 0 || geo.sLon > 40) continue;
      if (Math.abs(geo.dLat) > CAR_WIDTH + 0.9) continue;    // 横向已净空：不设限
      if (geo.gapFrontRear < 1.0 && v > o.speed + 0.5 && Math.abs(geo.dLat) < CAR_WIDTH + 0.35) emergency = true;
      const safeGap = Math.max(geo.gapFrontRear - 1.8, 0.4);
      const followCap = Math.sqrt(o.speed * o.speed + 2 * brakeA * 0.9 * safeGap) + Math.max(0, v - o.speed) * 0.12;
      if (followCap < envLight) envLight = followCap;
    }
  }

  // ---- 4) 转向：纯追踪 + 曲率前馈（用车辆自身 omega 上限换算占空比）----
  const look = Math.min(60, 10 + v * 0.5);
  const j = track.idxAt(car.trackS + look);
  const dx = lineX[j] - car.x, dy = lineY[j] - car.y;
  const dist = Math.hypot(dx, dy) || 1;
  const alpha = wrapAngle(Math.atan2(dy, dx) - car.angle);
  const kappa = (2 * Math.sin(alpha)) / dist;
  // 摩擦圆：重刹时横向抓地只剩 77.5%，转向上限必须按 latAvail 折算（见 §6.2）
  const usedLong = Math.min(1, Math.abs(car.accel || 0) / Math.max(1, brakeA));
  const latAvail = latGrip * Math.sqrt(Math.max(PHYS.frictionLatFloor, 1 - usedLong * usedLong));
  const omegaMax = Math.min(maxOmega, latAvail / Math.max(v, 1)) * Math.min(1, v / 3);
  let steer = clamp((v * kappa) / Math.max(omegaMax, 1e-4), -1, 1);
  out.steer = Number.isFinite(steer) ? steer : 0;
  out.left = out.steer < -0.05;
  out.right = out.steer > 0.05;

  // ---- 5) 输出（brake 只用数字；静止不保持重刹）----
  if (emergency) out.brake = 2;
  else if (v > envHeavy + 0.3) out.brake = 2;
  else if (v > envLight + 0.15) out.brake = 1;
  else out.brake = 0;
  if (v < 0.5 && out.brake === 2) out.brake = 1;            // 防止停车后倒车

  const capNow = cap[track.idxAt(car.trackS)];
  out.up = out.brake === 0 && v < capNow - 0.05;

  out.targetX = lineX[j];
  out.targetY = lineY[j];
  out.targetSpeed = envLight;
}
```

**骨架实测（同一台架）**：蒙扎 / 法拉利 SF-24 / 3 圈 → 最快圈 1:09.817、总时 3:33.133、草地 0%、0 违规 0 异常；
7 赛道 × 7 车型 → 49 场全部完赛、0 违规 0 异常、平均草地 0.33%；唯一短板是极弱制动车 `yangwang-u9x`（满刹 19.7 m/s²）
在银石会蹭到草地（最高 6.8%，其余车型全程 0%）。**这两点（稳定性 + 弱制动车的刹车余量）你必须做得比它好，圈速也要更快。**

---

## 12. 建议的思考路线（想拿"更快"，按这个方向做）

1. **走线**：`lineX/lineY` 是"最小曲率 + `hw-3.4` 走廊"的结果，不是时间最优。可用 `pts/nor/hw/kerbFlag/curvS` 自己重算：走廊放宽到 `hw-2.0`（有路缘石的路段可到 `hw-1.7`）、用双调和/拉普拉斯松弛得到更贴内线的线，再按"走线弧长 ÷ 该线曲率"打分择优。
2. **弯速**：`cap` 表用赛车线曲率生成，若你自己改线，需要按自己线的曲率重算弯速（`√(A_LAT·R)` 与 `maxOmega/k` 取小）。
3. **多点前瞻（想做三段/双前瞻融合时）**：必须用**相对向量**合成 `aim = car + Σ wᵢ (pᵢ − car)`，并保证 `Σ wᵢ === 1`；权重随 `|curvS|` 在近点/远点之间切换（弯中偏近、直道偏远），再按 `κ = 2·sin(α)/|aim−car|` 折算转向。**不要对 `pᵢ` 的绝对世界坐标做加权平均**（坐标是几百~几千，权重多 0.04 就能把瞄准点推出 60 m 以上，直接导致"直着冲出弯"）。
4. **纵向**：务必**前向扫描**而非只查当前点；用 `√(cap² + 2·a·d)` 反解"此刻允许速度"，轻刹/重刹双包络 + 需求减速度 `aReq` 分档，可实现"最晚刹车点"的连续解。
5. **出弯**：过弯心后曲率衰减即允许加速（`getApexReleaseCap` 的非对称窗口就是干这个的）；`v < cap` 时全油门，物理模型没有驱动/转向联合摩擦损失，弯中给油不吃横向抓地。
6. **交通**：把对手投影到"赛道横断面坐标"（横向偏移 = `(o.x - pts[i].x)·nor[i].x + (o.y - pts[i].y)·nor[i].y`），在走廊里做 0.3~0.4 m 步长的打分搜索（并排禁区重罚、内线加分、平滑度惩罚、方向锁定时长），配合 `getCarDistance` 的净空隙做纵向限速。
7. **防守/进攻**：`inBrake / inUp / inSteer` 是同步的，可预判对手是否在刹车；但要留 1~2 m 余量（线上对手坐标落后几十毫秒）。

---

## 13. 输出前自检清单（逐条打勾，不通过就改）

- [ ] 文件名级代码块里有 `driver` 函数，参数顺序是 `(car, out, dt, otherCars)`。
- [ ] 没有任何 `import` / `require` / `window` / `document` / `localStorage` / `fetch` / `Function` / `setTimeout`。
- [ ] 顶层没有引用 `car` / `out` / `otherCars`。
- [ ] 每个执行分支（含 `early return`、脱困、异常兜底）都显式写了 `out.up`、`out.brake`、`out.steer`。
- [ ] `out.brake` 只可能是数字 `0 / 1 / 2`；`out.up` 是布尔。
- [ ] 所有"前进 N 米"都用 `track.idxAt`；直线赛道没有 `% N`。
- [ ] 所有数组下标都做了范围保护；`evaluateTrafficAndOvertake` 的 `ti` 一定在 `0 ~ N-1`。
- [ ] 所有除法分母都有 `Math.max(…, 1e-4)` 之类的保护；`Math.acos/sqrt` 参数不会越界。
- [ ] 多点前瞻用的是 `car + Σwᵢ(pᵢ − car)`，且 `Σwᵢ === 1`（没有 `Math.max(下限, 1 − w1 − w2)` 这类会破坏归一的写法）。
- [ ] 转向控制律里的 `omegaMax` 用的是摩擦圆折减后的 `latAvail`（`latGrip · √max(0.6, 1 − usedLong²)`），不是名义 `latGrip`。
- [ ] `out.steer` / `out.brake` 在写出前经过 `Number.isFinite` 兜底。
- [ ] 状态只挂在 `car._` 前缀字段上，且用 `== null` 初始化（不要用 `if (!car._x)`，因为 0 会被误判）。
- [ ] 没有跨帧 `new` 大数组；主循环规模与 `N` 无关（用固定米数 → `idxAt` 换算）。
- [ ] `otherCars` 里排除了 `o === car`；`otherCars.length <= 1` 时也能正常跑。
- [ ] 静止时不保持 `brake = 2`（会倒车）。
- [ ] 横向目标没有超过 `±(hw - 2.2)`（0% 草地）。
- [ ] 代码里没有硬编码某条赛道的 `N` / `DS` / `hw` / 极速 / 抓地 / 刹车值（全部从 `perf` 与 `PHYS` 取）。
- [ ] 与 §11 骨架相比，你能具体说出改进了哪几点（走线 / 弯速 / 刹车规划 / 交通博弈），并且这些改进不是靠调大常数冒险。

**现在开始输出：先给唯一的 ```js 代码块，再给不超过 15 行的说明。**
