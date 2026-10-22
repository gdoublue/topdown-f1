# 赛车 perf 参数说明

`AI_CONFIGS`（本文件同目录 `ai.js`）里每辆车的 `perf` 就是这辆车的全部物理性能。
装配时 `applyCarConfig()` 会给每辆车复制一份独立的 `perf`（`car.perf = { ...cfg.perf }`），
所以实时调校只影响本车，不会污染配置表。

> 玩家自定义自动驾驶脚本能看到的字段（`car.perf` 只读视图）另见仓库根目录
> `driverPrompt.md` / `autopilot-doc.md`；本文档说明的是**配置表里每个字段的物理含义、实际生效位置与已移除项**。

---

## 1. 生效链路

| 环节 | 代码位置 | 读到的字段 |
| --- | --- | --- |
| 纵向物理（油门 / 刹车 / 滑行） | `src/car/physics.js` `stepLongitudinal()` | `maxSpeed` `accelMult` `highSpeedAccel` `brakeMult` `powerKW` `massKg` `launchAccel` `naturalVmax` |
| 转向物理（抓地极限转向 + 摩擦圆） | `src/car/physics.js` `stepCar()` | `latGrip` `maxOmega` `brakeMult` `steerRate` |
| 内置 AI 弯速表（**当前唯一在用的 AI 算法**） | `src/game/geminiDriver.js` `getApexReleaseCap()` | `maxSpeed` `latGrip` `maxOmega` `cornerGripMult` |
| 内置 AI 刹车规划 | `src/game/geminiDriver.js` | `brakeMult` |
| `car.vTarget`（给玩家脚本 / 旧算法的目标速度表） | `src/game/ai.js` `buildCarVTarget()` | `maxSpeed` `latGrip` `maxOmega` `brakeMult` `cornerGripMult` |
| 旧算法（已不再被任何车使用） | `driveApexHunter` / `driveVectorPursuit` / `driveSmoothCruiser` | `car.vTarget`（间接吃上表字段） |
| 车卡面板 / 实时调校 | `src/ui/menuPanels.js`、`src/game/tuner.js` | `maxSpeed` `latGrip` + 调校项 |
| 服务端圈速校验（理论下限） | `server/services/lapValidation.js` → `estimateStraightTimeMs()` | `maxSpeed` `accelMult` `highSpeedAccel` `powerKW` `massKg` `launchAccel` `naturalVmax` |

`PHYS`（`src/config.js`）是所有字段的缺省底座：`PHYS.brake = 61.6 m/s² (≈6.3g)`、
`PHYS.latGrip = 45`、`PHYS.maxOmega = 3.4`、沥青极速默认 `100 m/s`。

---

## 2. 字段速查

| 字段 | 单位 | 缺省 | 作用 | 备注 |
| --- | --- | --- | --- | --- |
| `maxSpeed` | m/s ×3 | `PHYS.maxSpeed` | `[沥青, 路肩, 草地]` 三档极速，物理上作为**硬上限** | 显示换算 ×3.6 = km/h |
| `latGrip` | m/s² | 45 | 最大侧向加速度。过弯极限 `v = √(latGrip × R)` | ÷9.81 = g |
| `maxOmega` | rad/s | 3.4 | 低速转向角速度上限（发卡弯不甩头） | 同时进 AI 弯速表 |
| `steerRate` | 1/s | 11 | 方向盘平滑逼近速率 → `car.steer` | **只影响视觉前轮转角 / 轮胎印 / 音效判定，不改行驶轨迹** |
| `accelMult` | × | 1.0 | 燃油车加速曲线整体倍率（`PHYS.accelCurve × accelMult`） | **电车（有 `powerKW`）不读它，也就不用填** |
| `highSpeedAccel` | × | 1.0 | 超过曲线末速（100 m/s）后的推力倍率 | 配置表不填，调校面板可改 |
| `brakeMult` | × | 1.0 | 满刹减速度 = `PHYS.brake × brakeMult` | 同时参与摩擦圆归一与 AI 刹车规划 |
| `powerKW` | kW | 无 | 一旦存在 → 加速改走**功率限制模型** `a = P/(m·v) − k·v²` | 电车专用；填了它 `accelMult` 失效 |
| `massKg` | kg | 2200 | 功率模型的质量 | 仅电车 |
| `launchAccel` | m/s² | 14.0 | 起步抓地极限（功率模型的加速度上限） | 仅电车，≈0-100km/h 时间 |
| `naturalVmax` | m/s | = `maxSpeed[0]` | 风阻标定速度（无电子限速时的空气阻力平衡点） | 配置表不填；`maxSpeed[0]` 仍是硬封顶 |
| `cornerGripMult` | × | 1.0 | 弯速极限系数，同时缩放两张 AI 弯速表与 `car.vTarget` | 配置表不填，调校面板「弯速极限」运行时写入 |

---

## 3. 各车当前实际参数

换算约定：极速 ×3.6 = km/h；`latGrip / 9.81` = 横向 g；`brakeMult × 61.6 / 9.81` = 制动 g。

| 车（id） | maxSpeed m/s（沥青/路肩/草地） | 极速 km/h | latGrip | 横向 g | maxOmega | 加速 | 制动 | 制动 g | steerRate |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 法拉利 #16 `apex-hunter` | 100.0 / 90.0 / 33.6 | 360.0 | 48.2 | 4.91 | 3.75 | `accelMult 1.05` | 1.03 | 6.47 | 13.5 |
| 红牛 #1 `vector-pursuit` | 101.5 / 92.0 / 34.0 | 365.4 | 47.6 | 4.85 | 3.60 | `accelMult 1.03` | 1.04 | 6.53 | 13.8 |
| 阿斯顿 #14 `classic-baseline` | 100.3 / 87.5 / 33.0 | 361.1 | 47.2 | 4.81 | 3.55 | `accelMult 0.99` | 0.98 | 6.15 | 11.0 |
| 梅奔 #44 `mercedes-w15` | 103.2 / 92.8 / 33.6 | 371.5 | 46.0 | 4.69 | 3.30 | `accelMult 1.00` | 1.08 | 6.78 | 10.5 |
| Ai Motor `AiMotor` | 101.5 / 91.8 / 33.6 | 365.4 | 47.0 | 4.79 | 3.40 | `accelMult 1.02` | 1.08 | 6.78 | 13.5 |
| 小米 SU8 Ultra #7 `smooth-cruiser` | 133.2 / 88.0 / 63.6 | 479.5 | 16.2 | 1.65 | 3.50 | `powerKW 1740` `massKg 2300` `launchAccel 14.2` | 0.29 | 1.82 | 9.5 |
| 仰望 U9X #9 `yangwang-u9x` | 137.8 / 124.0 / 33.6 | 496.1 | 17.0 | 1.73 | 2.60 | `powerKW 1600` `massKg 2475` `launchAccel 14.6` | 0.32 | 2.01 | 9.5 |

---

## 4. 已移除的失效参数

### 4.1 `vtGripFactor` / `vtBrakeFactor`（原 6 台车填过，已删除）

- 只被 `buildCarVTarget()` 读取，仅用于生成 `car.vTarget`。
- 7 台车的 `driver` 现在全是 `geminiDriver`，它的弯速表来自 `getApexReleaseCap()`
  （固定 `0.965 × cornerGripMult`），也从不读 `car.vTarget`；唯一读 `car.vTarget` 的旧算法
  已无人引用。
- 即对驾驶行为与圈速零影响，已从配置表和 `buildCarVTarget()` 中移除，抓地/刹车规划系数改为代码内固定值
  （`gripFactor ?? 0.78`、`brakeFactor ?? 0.58`）。

### 4.2 电车（SU8 Ultra / U9X）的 `accelMult`（已删除）

- `stepLongitudinal()` / `estimateStraightTimeMs()` 一旦发现 `perf.powerKW != null` 就走
  `evAccelAt()` 功率模型，从不读 `accelMult`；调校面板同样对电车隐藏「加速系数」。
- 只有删掉 `powerKW`（退回燃油曲线）时它才可能生效，故配置表中已一并移除。

---

## 5. 与实车标称的差异

- `smooth-cruiser`（SU8 Ultra）**制动已按实车修正**：`brakeMult` 由 `1.90`（`117 m/s² ≈ 11.9g`）改为
  `0.29` → `61.6 × 0.29 = 17.9 m/s² ≈ 1.82g`，与碳陶刹车实车水平（≈1.8g）一致，
  也让它和 `yangwang-u9x`（`0.32` → 2.01g）处在同一量级。
- `smooth-cruiser` **极速仍高于实车标称**：`maxSpeed[0] = 133.2 m/s = 479.5 km/h`（游戏内取值），
  实车 SU7 Ultra 电子限速 350 km/h（应为 `97.2`）。当前有意保留该游戏内设定，未作修改。
- 其余车的极速 / 抓地 / 制动换算后均在合理量级。

---

## 6. 维护须知

1. **新增一辆车**：至少给 `maxSpeed`（3 档）、`latGrip`、`maxOmega`、`brakeMult`、`steerRate`；
   燃油车再加 `accelMult`，电车加 `powerKW` / `massKg` / `launchAccel`（**不要**再写 `accelMult`）。
2. **不要再加 `vtGripFactor` / `vtBrakeFactor`**：内置 AI 不吃这两个字段，加了也不会影响任何车。
3. **改了 `perf` 必须刷新缓存**：AI 弯速表按 `perf` 对象缓存（`getApexReleaseCap`、`_cruiseCornerCapCache`、
   `_superCornerCapCache`），原地改值不会自动失效 —— 调用 `refreshCarPerf(car)`（调校面板已自动调用）。
4. **改 `maxSpeed` / `accelMult` / `powerKW` 后留意服务端校验**：`server/services/lapValidation.js`
   用 `estimateStraightTimeMs()` 现场积分出直线赛道理论下限，数值极端化会连带影响成绩合法性判定。
