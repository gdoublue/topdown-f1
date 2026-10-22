# 自动驾驶算法 · 参数说明

在「选车面板 / 在线练习房 / 在线房间」打开 **🤖 自动驾驶**，比赛中也可以点顶栏的 🤖 胶囊或按 **B** 直接开关。把你的算法粘进编辑器，就能接管自己的赛车：单人计时、对战 AI、在线练习、在线房间全部通用。

> 入口函数必须叫 `driver`，通过 `out.up` / `out.brake` / `out.steer` 控制车辆；`car` 与 `otherCars` 是只读视图，写物理字段会被引擎丢弃。

**目录**：[入口函数](#entry) · [car](#car) · [otherCars](#others) · [车距与车身尺寸](#spacing) · [out](#out) · [赛道数据](#track) · [工具函数](#tools) · [getApexReleaseCap](#apexcap) · [跟车/超车返回值](#traffic) · [坐标系与单位](#coord) · [物理边界](#physics) · [示例](#example) · [注意事项](#tips)

---

## 1. 入口函数：名字必须是 driver {#entry}

编辑器里的代码会被当作一个函数体编译，最终取名为 `driver` 的函数：

```js
function driver(car, out, dt, otherCars) {
  // car: 你的车（只读）
  // out: 输出控制量（写入，每帧复用的同一个对象）
  // dt : 本步物理步长（秒）
  // otherCars: 场上未完赛车辆（只读数组，含你自己）
}
```

也可以写成 `const driver = (car, out, dt, otherCars) => { ... }`。

**函数名不需要、也不应该叫 superDriver** —— 内置算法默认也是用 `const driver = ...` 绑定的；名字写错会在编辑器下方直接报错「没有找到 driver(...)」，不会静默回退。

想复用内置算法（例如只改一点点），可以在自己的 `driver` 里调用 `superDriver(car, out, dt, otherCars)`，然后再按需要覆盖 `out` 的字段。

### 四个参数速查

| 参数 | 方向 | 说明 |
| --- | --- | --- |
| `car` | 只读 | 你自己的车：位置、朝向、速度、赛道索引等，明细见 [第 2 节](#car)。 |
| `out` | 可写 | 本帧控制量：`out.up` / `out.brake` / `out.steer`，见 [第 4 节](#out)。 |
| `dt` | 只读 | 本次物理步长（秒）。每个物理子步 ≤ 1/30 秒：正常 60fps 约 1/60，倍速快进与在线掉帧补偿都会拆成更小的子步，不要假设固定值。做积分 / 预测时用它换算。 |
| `otherCars` | 只读 | 场上车辆数组（**包含你自己**，只含未完赛车），每项结构与 `car` 相同，见 [第 3 节](#others)。 |

### 运行机制（这几点最容易踩坑）

- **`out` 是每帧复用的同一个对象**：`out.up` / `out.brake` / `out.steer` 每个物理步都必须显式赋值，不写就会沿用上一步的值（例如提前 `return` 时刹车会一直踩着）。
- **改完代码立即生效**：停止输入约 0.4 秒后自动编译，编译通过后**下一个物理步就换成新算法**（不用重新开关，也不用重开赛）；编辑区下方的状态栏显示 `✓ 算法编译通过` / `✗ 具体错误`。
- **调用时机**：每个物理子步调用一次。3 秒倒计时、以及本地弹窗打开时**本地比赛暂停**（结算 / 选赛道 / 本面板），不调用。**在线房间里的服务器对局不会因为你的面板暂停**：打开面板时你的车会停在赛道上，对手继续跑，改代码请挑直道或提前改。
- **冲线之后**：在线对战不再调用；单人 / 对战 AI 仍会调用，但 `out.up` 会被巡航逻辑接管（自动降到 60~100 km/h），只有 `out.brake` / `out.steer` 还按你写的结果执行。
- **倍速快进会放大调用频率**：本地模式按 `+` / `-` 切 2×~16× 时，一帧会切多个物理子步（最多 32 步/帧），算法要够轻，别在里面做大数组分配或长循环。在线对战不受倍速影响。
- **抛异常会中断该帧**：异常会让这一帧剩下的物理与渲染全部跳过（画面像卡住）。有风险的除法、数组越界用 `try/catch` 或条件判断挡住。
- **输出 NaN 会毁掉车辆状态**：`out.steer = NaN` 会让车坐标变 NaN，画面上直接消失。算完用 `Number.isFinite(v) ? v : 0` 兜底。
- **编译失败不会停车**：状态栏显示 `✗` 时，车继续用上一次编译成功的算法；从未成功过则退回该车内置 AI，而不是停在原地。
- **代码自动保存**：编辑器内容与开关状态存在浏览器本地（localStorage），刷新页面不丢；「恢复默认 superDriver」按钮可一键还原。
- **`car` 只能读**：只有 `_` 开头的字段（`car._myState` 这类）可以写；改 `x` / `speed` / `finished` / `perf` 会被引擎**直接丢弃**并记一次越权写入（控制台每个字段提示一次），物理状态一分都不会变 —— 瞬移、伪造完赛在引擎层面已经做不到。想调车请用游戏里的调校面板。

---

## 2. 可以读取：car（你的车，只读；写入会被丢弃） {#car}

| 字段 | 单位 | 含义 |
| --- | --- | --- |
| `car.x` / `car.y` | 米 | 世界坐标。原点在左上，**y 轴向下**。 |
| `car.angle` | 弧度 | 车头朝向。`0` = 指向 +x；角度增大的方向在屏幕上是顺时针。 |
| `car.speed` | m/s | 有符号速度，倒车为负。×3.6 得 km/h。 |
| `car.steer` | ≈ -0.55 ~ 0.55 | 平滑后的方向盘位置（满舵约 ±0.55，不是 ±1），可用于抑制抖动。 |
| `car.nearIdx` | 索引 | 最近的中心线采样点序号 `0 ~ N-1`，走线计算的主入口。 |
| `car.trackS` | 米 | 沿中心线的里程。环形赛道单圈内 0 ~ 赛道长度；直线冲刺赛道会一路增长（沥青含冲线后缓冲区，可超过 `track.length`）。 |
| `car.raceDist` | 米 | 比赛总里程，可用来做排名判断。环形赛道发车格上为负（-12 / -20 …）；直线冲刺从 0 开始。 |
| `car.lap` | 圈 | 当前第几圈（从 1 开始）。 |
| `car.finished` | bool | 是否已冲线。冲线后车辆自动进入 60~100 km/h 巡航：在线对战算法不再被调用，单人 / 对战 AI 仍会被调用但油门被巡航接管（见第 1 节）。 |
| `car.surf` | 0 / 1 / 2 | 当前路面：`0` 沥青、`1` 路肩（仅铺了路缘石的弯）、`2` 草地。 |
| `car.gLat` / `car.gLon` / `car.gTotal` | G | 平滑后的横向 / 纵向 / 合成加速度，可判断是否已吃满抓地。 |
| `car.braking` | bool | 上一步是否**真的在减速**（踩死刹车停稳后为 false）。 |
| `car.inBrake` | 0 / 1 / 2 | 上一步的**刹车踏板输入**：0 松开、1 轻刹、2 重刹（停稳也保留）。 |
| `car.inUp` | bool | 上一步是否踩油门。 |
| `car.inSteer` | -1 ~ 1 | 上一步的方向输入，与车身横摆方向一致。 |
| `car.accel` | m/s² | 上一步的实际纵向加速度（负值 = 减速）。 |
| `car.best` / `car.last` / `car.total` | 毫秒 | 最快圈 / 上一圈 / 总用时（`null` = 还没有成绩）。注意 `total` 只在冲线那一刻写入，**比赛中一直是 0**：想要“已用时间”用 `raceDist` 或自己累计 `dt`。`car.lapTimes` 是每圈数组。 |
| `car.gridPos` / `car.idx` | 索引 | 发车格位（0 = 杆位）/ 上一步的最近采样点下标（`nearIdx` 的历史值，可算横向移动量）。 |
| `car.id` / `car.name` / `car.color` | - | 车辆 id、全名、主题色，用于分支或调试打印。 |
| `car.perf` | - | 本车性能配置，见下表。 |
| `car.vTarget` | m/s | 本车预计算的目标速度表（`Float32Array`，长度 N，默认 78% 抓地）。可直接查，但一般不如两张 `*Cap` 表好用。 |
| `car.nickname` / `car.shortName` / `car.number` | - | 显示用信息（`nickname` 只在多人 / 在线有值，单机时是 `undefined`）。 |

### car.perf 常用字段

| 字段 | 含义 |
| --- | --- |
| `perf.maxSpeed` | `[沥青, 路肩, 草地]` 三档极速（m/s）。 |
| `perf.latGrip` | 最大横向抓地（m/s²，÷9.81 得 G）。 |
| `perf.maxOmega` | 低速最大转向角速度（rad/s）。 |
| `perf.brakeMult` | 刹车倍率，满刹 = `PHYS.brake × brakeMult`。 |
| `perf.accelMult` / `perf.highSpeedAccel` | 油门加速倍率 / 高速段推力倍率（燃油车曲线）。 |
| `perf.powerKW` / `perf.massKg` / `perf.launchAccel` | 电车功率模型参数（有 `powerKW` 时走功率限速）。 |
| `perf.steerRate` | 方向盘跟随速度，只影响 `car.steer` 的平滑（不改物理转向角速度）。 |
| `perf.cornerGripMult` | 调校面板的「弯速极限」，**会同时缩放两张弯速表**（`A_LAT = latGrip × min(1, 系数 × cornerGripMult)`）。 |
| `perf.vtGripFactor` / `perf.vtBrakeFactor` | 只用于生成 `car.vTarget`；两张 `*Cap` 表用各自固定系数（0.96 / 0.965），不吃这两个字段。 |

---

## 3. 可以读取：otherCars（场上车辆，只读） {#others}

`otherCars` 是一个数组，元素是车辆状态对象，字段结构与 `car` 相同（`x / y / angle / speed / nearIdx / trackS / raceDist / lap / finished / perf / nickname …`）。单机 / 对战 AI / 观战里这些车都在本地完整模拟，[第 2 节](#car) 的所有字段都是实时的。

> **数组里包含你自己**（与内置算法一致），判断“别人”要写成 `for (const o of otherCars) { if (o === car) continue; ... }`。

> **对手的车同样是只读的**：`o.speed = 0` / `o.x = ...` 这类写入会被引擎丢弃，数组本身也是冻结的（push / 排序都不生效）——只能读，不能推别人。

在线房间里其他玩家的车只有一部分字段是同步的：几何量 `x / y / angle / speed` + 进度 `nearIdx / trackS / raceDist / lap / finished` + 成绩 `best / total` + 踏板 `inBrake / inUp / inSteer` 都是实时的，但 `gLat / gLon / accel / braking / surf` 这类只有本地才有的物理量不会同步（保持 0）。

### 每辆车能读到的“肉眼可见”状态

| 字段 | 单位 | 说明 | 在线同步 |
| --- | --- | --- | --- |
| `o.speed` | m/s | 有符号速度（倒车为负），×3.6 得 km/h。 | ✓ |
| `o.angle` | 弧度 | 车头朝向。算相对方位：`wrapAngle(Math.atan2(o.y - car.y, o.x - car.x) - car.angle)`。 | ✓ |
| `o.nearIdx` / `o.trackS` | 索引 / 米 | 对方在中心线上的位置（在线时由服务器里程反算，精度约 ±1 个采样点）。 | ✓ |
| `o.inBrake` | 0 / 1 / 2 | **刹车踏板**：0 松开、1 轻刹（45%）、2 重刹。停稳后仍能看出他在踩着刹车。 | ✓ |
| `o.inUp` | bool | **油门**是否踩下。 | ✓ |
| `o.inSteer` | -1 ~ 1 | **方向输入**，与车身横摆方向一致，可预判对方是进弯还是回正。 | ✓ |
| `o.braking` | bool | 是否真的在减速（物理结果，与 `inBrake` 互补）。 | ✗ 仅本地 |
| `o.gLat` / `o.gLon` / `o.accel` / `o.surf` | G / m/s² / 0-2 | 横向 / 纵向加速度、路面类型，可判断对手是否吃满抓地。 | ✗ 仅本地 |

刹车灯也用了这份数据：`inBrake > 0` 时尾灯点亮，所以线上对手踩刹车你能直接看见红光。在线对手的 `o.perf` 是**按车型推断**的默认配置，不一定是对方的真实调校，别拿它算对手的极限。

### 三条使用约定

- **只含未完赛车**：已冲线的车会被幽灵化并从数组里移除，所以不用判断 `o.finished`。
- **含车辆状态与踏板输入，但不含算法内部状态**：你拿不到对手的前瞻点、目标速度等，只能从速度 / 朝向 / 踏板推测意图。
- **顺序不固定**：按车辆创建顺序排列（单机 = AI_CONFIGS 的顺序，与发车格位无关），不要依赖下标含义，判断身份请用对象引用比较（`o === car`）。

### 在线对战的精度说明

在线房间里，你自己的车在本地完整模拟（数据实时且精确）；**其他玩家的车是“过去式”**：位姿按 60Hz 上报（30fps 的客户端退化为逐帧）、服务端 30Hz 快照转发，本地默认延后约 80ms 播放 + 样条插值；链路抖动时自适应延迟最多垫到约 150ms，恢复后再慢慢回到 80ms。踏板输入随快照中继。所以对手坐标永远落后约几十毫秒，且碰撞结果只在各自客户端生效——做贴身超车判断建议留 1~2m 余量。AI 补位车由服务器 30Hz 模拟，位姿更规整，但仍受同样的播放延迟影响。

### 示例：找最近的前车并跟车

```js
function driver(car, out, dt, otherCars) {
  let lead = null, leadGap = Infinity;

  for (const o of otherCars) {
    if (o === car) continue;                       // 数组包含自己，先排除
    const geo = getCarDistance(car, o);            // 统一航向坐标系下的相对位置
    if (geo.sLon <= 0) continue;                   // sLon > 0 才说明对方在前方
    if (geo.gapLateral > 1.8) continue;            // 横向错开超过一个车身，不算同车道
    if (geo.sLon < leadGap) { lead = o; leadGap = geo.sLon; }
  }

  if (lead && leadGap < 12) {
    out.up = false;                                // 距离太近，松油门
    if (leadGap < 7 && lead.speed < car.speed) out.brake = 1;
  } else {
    out.up = true;
    out.brake = 0;
  }
  // 方向照常跟赛车线（直线冲刺赛道请改用 track.idxAt(car.trackS + 12)）
  const j = (car.nearIdx + 3) % N;
  out.steer = clamp(wrapAngle(Math.atan2(lineY[j] - car.y, lineX[j] - car.x) - car.angle) * 1.6, -1, 1);
}
```

也可以用现成的 `evaluateTrafficAndOvertake(car, otherCars, car.nearIdx, dt)`，它内部已经处理了“排除自己 + 选前车 + 变线超车”，返回目标点和限速建议。

### 示例：看到前车刹车灯就提前收油

```js
function driver(car, out, dt, otherCars) {
  let closing = false;
  for (const o of otherCars) {
    if (o === car) continue;
    const geo = getCarDistance(car, o);
    const ahead = geo.sLon > 0 && geo.sLon < 25;   // 正前方 25m 内
    const sameLane = geo.gapLateral < 1.6;          // 横向不足一个车身
    if (ahead && sameLane && (o.inBrake > 0 || o.speed < car.speed - 8)) closing = true;
  }

  out.up = !closing;                 // 前车在刹车 / 明显比我慢 → 先松油
  out.brake = closing && car.speed > 40 ? 1 : 0;
  out.steer = 0;                     // 方向另算
}
```

---

### 车身尺寸与间距：怎么判断“能不能过” {#spacing}

每辆车按 **5.6m × 2.0m** 的矩形包围盒处理（`CAR_LENGTH = 5.6`、`CAR_WIDTH = 2.0`）：车头在中心 **+2.8m**、车尾 **-2.8m**，左右各 **1.0m**。跟车 / 并排 / 变线的判断全部基于这个盒子，不需要自己再猜车长。

### getCarDistance(a, b) 的返回值

| 字段 | 含义 | 怎么用 |
| --- | --- | --- |
| `sLon` | 纵向距离（米），在**两车平均航向**上测得 | `> 0` 表示 b 在 a 前方；`< 0` 表示在后面 |
| `dLat` | 横向偏移（米），垂直于平均航向 | 正负表示对方在左 / 右，绝对值看偏离多少 |
| `gapFrontRear` | 车头车尾**净空隙** = `Math.abs(sLon) - 5.6` | `> 0`：前后完全错开；`< 0`：纵向重叠 |
| `gapLateral` | 车侧**净空隙** = `Math.abs(dLat) - 2.0` | `> 0`：横向错开（并排也不碰）；`< 0`：横向重叠 |
| `distCenter` | 两车中心直线距离 | 粗略排序“谁离我最近” |

### 判定规则

```text
前后跟车：gapFrontRear > 0 才算真正错开

  A  [======>]
                        gapFrontRear = |sLon| - 5.6
            [======>]  B

并排行驶：gapLateral > 0 才不会碰到

  A  [======>]
  B  [======>]          gapLateral = |dLat| - 2.0

两个净空隙同时 < 0  →  包围盒重叠 = 接触（物理会分离 + 后车掉速）
```

```js
const geo = getCarDistance(car, o);

if (geo.gapFrontRear > 0) { /* 前后错开：可以放心变线 */ }
if (geo.gapLateral > 0) { /* 横向错开：不算同车道，不用跟车 */ }
if (geo.gapFrontRear < 0 && geo.gapLateral < 0) { /* 已经贴上，赶紧减速/让线 */ }
```

### 建议的安全余量

| 场景 | 建议阈值 |
| --- | --- |
| 跟车（开始全力追） | `gapFrontRear > 8 ~ 12m` |
| 并排超车（可以贴上去） | `gapLateral > 0.8m` |
| 变线完成 | 横向移动约 **2.0m**（一个车宽）+ 0.5m 余量 |
| 判断正前方同车道 | `sLon > 0 && gapLateral < 0`（横向重叠才算正前方） |

注意：`sLon` / `dLat` 用的是“两车平均航向”坐标系，交换 a / b 时符号严格取反（追尾判定不依赖调用顺序）。只有当两车航向**几乎相反**（夹角大于约 160°，例如一方完全掉头 / 打滑转了半圈）时，平均航向会退化并退回 a 的航向，此时“前后 / 左右”的划分才变模糊，建议改用 `distCenter` 做粗略避让。

---

## 4. 可以写入：out（控制输出） {#out}

| 字段 | 类型 | 作用 |
| --- | --- | --- |
| `out.steer` | -1 ~ 1 | 方向盘。负 = 左，正 = 右。**转向需要速度**：0→3 m/s 线性生效，静止打不了方向。 |
| `out.up` | bool | 油门。只有在 `brake === 0`（数字 0）时才生效。 |
| `out.brake` | 0 / 1 / 2 | 0 松开、1 轻刹（45% 制动力）、2 重刹（100%）。刹车优先级高于油门。 |
| `out.left` / `out.right` | bool | 旧式方向键模拟。**只在你把 `out.steer` 写成非数字时才生效**，建议直接用 `out.steer`。 |
| `out.targetX` / `out.targetY` / `out.targetSpeed` | 数字 | 只用于「AI 探测线」可视化（视图工具里打开开关），不影响物理。**单人计时 / 在线练习不绘制；在线对战里这个开关本身被隐藏**，所以真正能看到的是对战 AI / 全 AI 观战。 |

约定：`out.up` 按真值判断（写 `1` / `"x"` 也算踩油门）；`out.brake` 必须是**数字**：**只有严格等于 `2` 才是重刹**，其它任何正数（含 `1`、`1.5`、`3`）都按轻刹 45% 处理，`0` / 负数 = 松开（注意 `"0"` 这种字符串不满足 `brake === 0`，油门会被忽略）；`out.steer` 会被钳到 -1~1。

---

## 5. 可以读取：赛道数据（自动注入） {#track}

| 名称 | 含义 |
| --- | --- |
| `N` | 中心线采样点数量。`pts` / `nor` / `hw` / `curvS` 的下标范围 `0 ~ N-1`（环形赛道需取模）。 |
| `pts[i]` | `{x, y}` 中心线第 i 个点（米）。 |
| `nor[i]` | `{x, y}` 该点单位法向（指向行进方向右侧）。横向偏移 = `pts[i] + nor[i] × off`。 |
| `hw[i]` | 该点赛道半宽（米）。路面内 0 ~ hw，外侧是路肩 / 草地。 |
| `curvS[i]` | 平滑后的有符号曲率（1/m，±9 点滑动平均）。`Math.abs(curvS) > 1/110` 就是系统判定“要铺路缘石”的弯道，可直接拿来做弯道阈值；半径 = `1 / Math.abs(curvS)`。 |
| `lineX[i]` / `lineY[i]` | 预计算的最优赛车线：横向被限制在 ±(hw - 3.4) 内（即离沥青边缘至少 3.4m），弯中贴内侧。跟这条线通常最快。 |
| `DS` | **平均**采样间距（米）。采样点按曲线参数均匀、不是按米均匀（直道一段可能是弯道的两倍长），所以 `idx + 距离 / DS` 只是近似——精确换算请用 `track.idxAt(米)`。直线冲刺赛道的 DS 按整条沥青（11km）算，不等于 `track.length / N`。 |
| `PHYS` | 全局物理常量：`brake`(61.6)、`lightBrakeFactor`(0.45)、`latGrip`、`maxOmega`、`maxSpeed`、`accelCurve` 等。 |
| `CAR_LENGTH` / `CAR_WIDTH` | 车身包围盒 **5.6m × 2.0m**（车头车尾各 2.8m、左右各 1.0m），详见 [车距与车身尺寸](#spacing)。 |

### track：赛道元信息

| 字段 | 说明 |
| --- | --- |
| `track.id` / `track.name` / `track.flag` | 当前赛道 id、中文名、国旗。 |
| `track.length` | 本场计赛长度（米）。环形赛道 = 圈长；直线冲刺赛道 = 6km 计时里程（沥青还往后延伸 5km 缓冲区，`car.trackS` 会超过它）。 |
| `track.turns` | 弯道数量。 |
| `track.laps` | 本场圈数（跟随菜单 / 练习房 / 房间设置）。 |
| `track.isLinear` | 是否直线冲刺赛道（起点→终点不闭合）。 |
| `track.N` / `track.DS` / `track.HW` | 采样点数 / 采样间距（米）/ 基础半宽（米）。 |
| `track.kerbFlag[i]` | `1` = 该采样点铺了红白路缘石（可以放心压）。 |
| `track.idxAt(米)` | 沿赛道的物理距离 → 采样下标（按真实里程二分，误差 ≤1 个点）；环形赛道自动取模，直线赛道自动钳制到 0 ~ N-1。**两种赛道都能安全用**，推荐替代手写 `% N` 和 `距离 / DS`。 |

`track` 的每个字段都是实时读取的：换赛道后自动变成新赛道的数据，**不需要重新编译算法**。例如 `const j = track.idxAt(car.trackS + 30);` 直接拿到 30 米后的采样点。

### 没有注入、别写错名字的东西

| 你可能会想写 | 正确写法 |
| --- | --- |
| `isLinear` | `track.isLinear` |
| `HW` / `LAP_LENGTH` | `track.HW` / `track.length`（每条赛道不同） |
| `rcurvS`（未平滑原始曲率）、全局 `vTarget`（AI 目标速度表） | 不注入；曲率统一用 `curvS`，弯速用两张 `*Cap` 表（每辆车自带目标速度表 `car.vTarget`，但那只是默认 78% 抓地） |
| `import` / `require` / 访问其他模块 | 不支持。代码会被包成纯函数体编译，**宿主全局已被屏蔽**：`window` / `document` / `localStorage` / `fetch` / `__gp` / `eval` / `Function` 等一律取不到（`typeof` 是 undefined），只能用注入的标识符 + `Math` / `JSON` / `console` / 类型化数组这些标准库 |

**注入给你的数据都是副本**：`pts` / `nor` / `hw` / `curvS` / `lineX` / `lineY` / `PHYS` 每次编译复制一份，随便改也影响不到引擎和同场其他车（只会让你自己算错）。

### 环形赛道 vs 直线冲刺

- `N`、`DS` 每条赛道都不一样，不要把下标写成常数、也不要把“米”直接当下标用。
- **环形**：前进 `step` 个采样点写 `(i + step) % N`（负数要先 `+N` 再取模）。
- **直线冲刺**：赛道不闭合，必须 `Math.min(i + step, N - 1)` 或 `track.idxAt(米)`；照环形写 `% N` 会让“前方”绕回起点，前车 / 弯道判断直接错乱。

---

## 6. 可直接调用的工具函数 {#tools}

| 函数 | 说明 |
| --- | --- |
| `clamp(v, a, b)` | 把 v 限制在 [a, b]。 |
| `wrapAngle(a)` | 把角度差归一化到 [-π, π]，算航向误差必用。 |
| `getSuperCornerCap(perf)` | 返回每个采样点的弯中极限速度表（`Float32Array`，单位 m/s，96% 抓地利用率，**±30m 对称窗口**）。直接查表当目标速度。 |
| `getApexReleaseCap(perf)` | 内置 geminiDriver 在用的「过弯心即释放」弯速表：**非对称窗口 −2m ~ +10.5m**、孤立弯出弯允许外抛走线（等效曲率 ×0.86）、抓地利用率 96.5%。出弯约 10m 就解除限速，比上面那张表更快。 |
| `evaluateTrafficAndOvertake(car, otherCars, ti, dt)` | 内置跟车 / 超车决策。返回 `{ targetX, targetY, shouldSlow, speedCap, steerBias, emergencyBrake, isOvertaking }`。 |
| `getCarDistance(a, b)` | 返回 `{ sLon, dLat, gapFrontRear, gapLateral, distCenter }`。sLon > 0 表示 b 在 a 前方；gap 为净空隙（负值 = 包围盒重叠）。 |
| `superDriver(car, out, dt, otherCars)` | 游戏内置的完整算法（三点前瞻 + `getSuperCornerCap` 弯速表 + 时间最优闭环刹车 + 超车状态机），也是自动驾驶的默认源码。可以直接调用，或者先调用它再覆盖个别 `out` 字段。 |

**两张弯速表怎么选：** `getSuperCornerCap` 用前后各 30m 的对称窗口，弯后 30m 内仍会被弯心限速压着，偏保守；`getApexReleaseCap` 是 geminiDriver 在用的非对称窗口（只看身后 2m、身前 10.5m），过弯心约 10m 后就允许加速，且识别到孤立弯时会按外抛走线把等效曲率打 0.86 折，出弯更快。想追极限用后者，想稳一点用前者。两个函数都按 `perf` + 当前赛道做缓存，每帧调用没有额外开销。

### 6.1 getApexReleaseCap(perf) 是什么 {#apexcap}

它不是 car 或 out 上的字段，也不是参数，而是系统注入到你算法作用域里的一个**查询函数**：传入一份车辆性能配置，返回这辆车在当前赛道上**每个采样点的极限过弯速度表**。内置算法里只有 `geminiDriver` 查这张表；`superDriver`（自动驾驶默认算法）用的是上面那张对称窗口的 `getSuperCornerCap`，两张表不能混用。

```js
const cap = getApexReleaseCap(car.perf);   // Float32Array，长度 = N，单位 m/s（×3.6 = km/h）
const j   = track.idxAt(car.trackS + 30);  // 前方 30m 处的采样点（两种赛道都安全）
const vLimit = cap[j];                     // 前方 30m 处最多能跑多快
if (Math.abs(car.speed) > vLimit) out.brake = 1;
```

**它回答的是什么问题：** 只回答「**这一个采样点，最多能用多快的速度通过**」——不考虑交通、不考虑你现在在哪。交通 / 超车 / 走线偏移请用 `evaluateTrafficAndOvertake(...)` 和 `lineX / lineY`。它本质上就是一张长度为 `N` 的只读速度表，查表是 O(1)。

### 名字里的“Apex Release”（过弯心即释放）

| 项 | getSuperCornerCap | getApexReleaseCap |
| --- | --- | --- |
| 观察窗口 | 前后各 30m（对称） | **身后 2m / 身前 10.5m**（非对称） |
| 出弯表现 | 过弯心后仍被弯心限速压约 30m，保守 | 过弯心约 10m 后即解除限速，可提前加油 |
| 孤立弯出弯 | 无额外处理 | 判定为非连续弯，等效曲率 ×0.86（外抛走线放大半径） |
| 抓地利用率 | 96% | **96.5%**（更贴近极限） |
| 使用方 | `superDriver`（自动驾驶默认算法） | `geminiDriver`（阿斯顿 AMR24 / 小米 SU8 Ultra / Ai Motor 在用） |

每点的值 = `min(沥青极速, √(A_LAT × R), maxOmega / k)`，其中 `k` 是该点附近窗口内的最大曲率，`R = 1/k`，`A_LAT = latGrip × min(1, 0.965 × cornerGripMult)`。连续 S 弯不做 0.86 折损。

### 三条使用约定

- **按 `perf` 对象 + 当前赛道双键缓存**：每帧调用没有额外开销，换赛道后自动失效重建，不用手动清。
- **返回的是共享缓存数组，只读**：不要写 `cap[i] = ...`，所有用同一份 `perf` 的车（含 AI）共用这张表，改了会污染别人。
- **必须传真实的性能对象**：`getApexReleaseCap(car.perf)`；手工拼一个假对象会得到错误限速（缺字段时回落到 `PHYS` 默认值）。

### 最小用法：纯追踪 + 这张表控速

```js
function driver(car, out, dt) {
  const v = Math.abs(car.speed);

  // 方向：朝赛车线前瞻点打（track.idxAt 环形取模 / 直线钳制，两种赛道都安全）
  const j = track.idxAt(car.trackS + 12 + v * 0.55);
  const err = wrapAngle(Math.atan2(lineY[j] - car.y, lineX[j] - car.x) - car.angle);
  out.steer = clamp(err * 1.8, -1, 1);

  // 纵向：查表，超速就刹
  const cap = getApexReleaseCap(car.perf);
  const vLimit = cap[j];
  out.brake = v > vLimit + 6 ? 2 : v > vLimit + 1 ? 1 : 0;
  out.up = out.brake === 0 && v < vLimit;
}
```

### 6.2 evaluateTrafficAndOvertake(car, otherCars, ti, dt) 返回值 {#traffic}

| 字段 | 类型 / 单位 | 怎么用 |
| --- | --- | --- |
| `targetX` / `targetY` | 米 | 已经叠加了超车侧移的推荐目标点，可以直接当纯追踪的瞄准点。 |
| `shouldSlow` | bool | 是否应跟车降速（同车道前车太近）。为 `false` 时别用 `speedCap`。 |
| `speedCap` | m/s | 跟车限速（约等于前车速度 ×0.97）；无阻挡时为 `Infinity`。 |
| `steerBias` | -0.14 ~ 0.14 | 并排时的防挤碰方向偏置，直接加到你的 `out.steer` 上。 |
| `emergencyBrake` | bool | 贴到前车了，立刻 `out.brake = 2`。 |
| `isOvertaking` | bool | 当前侧向偏移已超过 0.6m（正在抽头 / 变线），可用来切换策略。 |

```js
const v  = Math.abs(car.speed);
const ti = track.idxAt(car.trackS + 16 + v * 0.5);   // 前瞻下标必须落在 0 ~ N-1
const tr = evaluateTrafficAndOvertake(car, otherCars, ti, dt);

out.brake = tr.emergencyBrake ? 2 : (tr.shouldSlow && v > tr.speedCap ? 1 : 0);
const err = wrapAngle(Math.atan2(tr.targetY - car.y, tr.targetX - car.x) - car.angle);
out.steer = clamp(err * 1.8 + tr.steerBias, -1, 1);
out.up    = out.brake === 0;
```

**有状态**：这个函数会读写 `car._latOffset` 来平滑侧移，所以每帧只调用一次（不要在同一帧里对多个前瞻下标各调一次，也不要在内置 `superDriver` 之后再调用它，两者会抢同一个偏移量）。**`ti` 必须在 0 ~ N-1 内**：越界会读到 `undefined` 的 `pts[ti]` 直接抛异常（不是返回 NaN），直线冲刺赛道更是不能用 `% N` 代替钳制。

---

## 7. 坐标系与单位 {#coord}

- 世界单位：**1 = 1 米**，速度 m/s，加速度 m/s²，角度弧度。
- x 向右、**y 向下**（屏幕坐标），所以 `angle` 增大 = 屏幕上顺时针。
- 侧向偏移约定：`pts[i] + nor[i] × off`，`off > 0` 在中心线右侧（相对行进方向）。
- 超出路面：`|off| < hw` 沥青；有路缘石的路段 `hw ~ hw+1.5` 是路肩；没有路缘石的路段白线外 0.4m 内仍算沥青；再往外是草地（极速、加速、转向都会骤降）。

---

## 8. 物理边界（写这些值不会突破） {#physics}

- 满刹减速度 = `PHYS.brake × perf.brakeMult`（默认约 61.6 m/s² ≈ 6.3g），轻刹为其 45%。
- 转向角速度 `ω = min(maxOmega, 可用横向抓地 / v) × min(1, v/3)`；刹车会占用摩擦圆，重刹时可用横向抓地会下降到约 77%。
- `out.brake > 0` 时 `out.up` 无效；倒车需要用 `brake = 2` 停稳后继续按住。
- 草地会大幅降低极速、加速，并削弱转向（×0.74）。

---

## 9. 最小可用示例（纯追踪 + 弯速限速） {#example}

```js
// 沿内置赛车线走：近点控方向，弯速表控油门/刹车
function driver(car, out, dt) {
  const v = Math.abs(car.speed);

  // 1) 前瞻点：速度越快看得越远（track.idxAt 自动处理环形取模 / 直线钳制）
  const look = 12 + v * 0.55;                    // 米
  const j = track.idxAt(car.trackS + look);

  // 2) 转向：朝赛车线打方向
  const dx = lineX[j] - car.x;
  const dy = lineY[j] - car.y;
  const err = wrapAngle(Math.atan2(dy, dx) - car.angle);
  out.steer = clamp(err * 1.8, -1, 1);

  // 3) 纵向：查弯速表，超了就刹
  const cap = getSuperCornerCap(car.perf)[j];    // m/s
  if (v > cap + 6) out.brake = 2;
  else if (v > cap + 1) out.brake = 1;
  else out.brake = 0;

  out.up = out.brake === 0 && v < cap;
}
```

---

## 10. 注意事项 {#tips}

- **调用频率**：每个物理子步一次（正常约 60 次/秒）。按 `+` / `-` 开倍速快进时同一帧会切多个子步（最多 32 步/帧），调用次数同步放大，因此不要在函数里做重循环、大数组分配或 `console.log`。在线对战固定实时，不受倍速影响。
- **状态保存在 car 上**：内置算法用 `car._cruiseStuck` 之类的字段存记忆；你自己的算法也可以挂 `car._myState` 这类字段。同一辆车在换赛道、改代码重新编译时对象不会被重建，所以 `car._xxx` 能跨重编译保留；换车 / 重开时新车辆对象会自然重置。
- **重编译会重置顶层变量**：换赛道或修改代码会重新执行整段代码，写在顶层的 `let` / `const` 会回到初始值。想在多次重编译之间保留状态，请挂到 `car._xxx`；算法内部拿不到 `window` / `localStorage`，不能靠它们跨局保存。
- **不要再读 keyboard input**：开启自动驾驶后键盘输入完全不生效，你的车只认 `out`（`car.inUp` / `car.inBrake` 反映的就是你自己上一帧写出去的值）。
- **在线对战**：算法在你本地运行，你的车在本地模拟并把状态 / 成绩上报。服务器会拒绝“单帧位移超过物理上限”的位置与里程上报（瞬移在联网里同样无效），完赛成绩还要过合理性校验：环形赛道按人工标定的理论最短圈，直线赛道按该车物理积分出的理论最快用时——高极速电车不会再被固定阈值一刀切。**在线对局的服务器模拟不因你的弹窗暂停**：开着面板改代码时，你的车会停在赛道上，对手继续跑。
- **切换赛道**：`lineX` / `pts` / `getSuperCornerCap` 等会在换赛道后重建，系统会自动用新数据重新编译你的代码，不需要重开页面。注意重编译等于重新执行整段代码，顶层的 `let` / `const` 状态会被重置。
- **开关入口**：选车面板 / 在线练习房 / 在线房间里的「🤖 自动驾驶」按钮，或比赛中点顶栏的 🤖 胶囊、按快捷键 **B**（全 AI 观战模式没有自己的车，胶囊会隐藏）。在线对战换到别人视角时，若自动驾驶没开，会用本地算法临时接管且不写偏好设置；切回自己的车会自动交还键盘。开 / 关状态存在浏览器里，中途切换立即生效。
- **调试手段**：`console.log` 可用（浏览器 F12 控制台）；把前瞻点写进 `out.targetX/targetY`，在对战 AI / 观战里打开视图工具的「AI 探测线」就能在赛道上看到瞄准点（单人计时与在线练习不绘制，在线对战里这个开关被隐藏）。手机端视图工具默认折叠在小地图下方，点标题栏展开。浏览器控制台（不是算法作用域）里还有 `window.__gp`（`__gp.cars` / `__gp.race` / `__gp.input` 等，属于内部接口，可能随版本变动）——想直接看车的数据，最快的方法就是 `console.table(__gp.cars)`。算法内部已经看不到 `window`，这条只适合在 F12 里手动排查。
- **离线批量测速（无头台架）**：仓库里的 `scripts/autopilot-bench.mjs` 用真实物理跑你的算法，不用开浏览器：`node scripts/autopilot-bench.mjs --algo=我的算法.js --track=all --car=all`（`--mode=vs|duel` 还能测缠斗）。它跑的就是加固后的引擎，越权写入会被拦截并逐条列出，所以成绩只代表“只控制自己的车”能达到的水平；`--raw` 可复现加固前的行为（裸对象），只用于对照审计。**逐步教程（写法 / 调试套路 / 报错速查 / 基线回归）见仓库的 `scripts/autopilot-bench.md`**。
