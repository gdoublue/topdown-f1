# 自动驾驶算法调试流程（固定套路）

调一个新算法不再需要现写探针脚本。三个工具各管一件事，串起来就是固定流程：

| 步骤 | 工具 | 回答的问题 | 典型耗时 |
|---|---|---|---|
| 1 初筛 | `scripts/autopilot-bench.mjs`（`npm run algo:bench`） | 能不能跑完？圈速多少？和内置差多少？ | 1~30s |
| 2 定位 | `scripts/algo-doctor.mjs`（`npm run algo:doctor`） | **慢在哪一段**？纵向通道怎么用的？转向吃满了吗？ | 2~5s |
| 3 验收 | `scripts/algo-check.mjs`（`npm run algo:check`） | 全赛道 × 全车型能不能收？有没有回归？ | 1~3min |

三个工具共用同一套底座：`scripts/lib/algo-harness.mjs`（编译注入、物理步循环、遥测钩子），
与游戏内 `src/ui/autopilot.js` 的编译工厂、`src/game/driverSandbox.js` 的只读视图是同一份实现。

> 写脚本的语法约定、注入 API、与游戏内的差异：见 `scripts/autopilot-bench.md`。

---

## 0. 30 秒上手

```powershell
# 1) 初筛：能完赛吗、圈速多少
npm run algo:bench -- --algo=my.js --track=monza --car=apex-hunter --laps=3

# 2) 定位：分段用时 + 通道统计 + 自动诊断
npm run algo:doctor -- --algo=my.js --track=monza --car=apex-hunter --laps=3

# 3) 验收：全赛道全车型（默认参照 geminiDriver、2 圈）
npm run algo:check -- --algo=my.js --laps=2

# 4) 混战：整场 7 车同场（其余车内置 AI），看名次与交通损失
npm run algo:doctor -- --algo=my.js --track=monza --car=apex-hunter --mode=vs
```

也可以直接 `node scripts/algo-doctor.mjs --algo=...`，参数完全一样
（`npm run` 后面的 `--` 是 npm 的参数分隔符）。

> 如果终端里出现 `npm warn Unknown cli config "--algo"`（部分 shell + npm 11 会把 `--flag` 当成 npm 自己的配置吃掉），
> 直接改用 `node scripts/algo-doctor.mjs --algo=...` 这种写法；想确认参数到底传进来没有，可加 `--dump-args`。

---

## 1. 初筛：`autopilot-bench`

只关心「完赛 + 圈速 + 违规/异常 + 草地」。判读口径见 `autopilot-bench.md` §3。
建议先把这两条打勾，再进第 2 步：

- `违规/异常 = 0 / 0`、`草地 < 5%`
- 第 2、3 圈稳定（相邻圈差 < 0.5s）

---

## 2. 定位：`algo-doctor`

```powershell
# 默认：3 圈，参照 geminiDriver（内置最强算法）
npm run algo:doctor -- --algo=my.js --track=monza --car=apex-hunter

# 只看自己、不和别人比
npm run algo:doctor -- --algo=my.js --track=monza --car=apex-hunter --ref=none

# 30fps + 帧率抖动下的稳定性
npm run algo:doctor -- --algo=my.js --track=monza --dt=0.0333 --jitter

# 存一份 JSON（含每段明细，便于脚本处理）
npm run algo:doctor -- --algo=my.js --track=monza --json=doctor.json
```

真实输出（`userscripts/1022_pm.js`，蒙扎 / 法拉利）：

```
=== 算法体检 · 1022_pm ===
赛道 monza · 法拉利 #16 (apex-hunter) · 3 圈 · dt=1/60 · seed=1
最快圈 1:10.283 · 总时 3:34.533 · 极速 360 km/h · 草地 0% · 异常 0 · 越权 0
参照 geminiDriver：最快圈 1:09.850 · 本车 +0.433s · 草地 0%

[分段] 12 段（按赛道采样点等分）
  段 │     圈内s │      Δs │     均速 │    重刹% │    轻刹% │    油门% │    饱和% │    草%
 s2 │    5.86 │   +0.44 │   56.9 │      1 │      4 │     95 │     13 │     0
 s4 │    3.87 │   -0.19 │   64.6 │     16 │     13 │     64 │     37 │     0
 ...

[通道]
重刹 3.7% · 轻刹 4.3% · 油门 85.1% · 滑行 6.9% · 转向饱和 9.2%
重刹脉冲（≤2 帧就松开）44 次，占重刹帧 13%
油门时实际加速度 4.83 vs 模型 4.82 m/s²（100%）

[诊断]
 · 段 s2 每圈比参照慢 0.44s（均速 56.87 vs 60.56 m/s，重刹 0.9%、转向饱和 13.2%） → 优先改走线/前瞻
 · 已经领先的段：s4(-0.19s)、s8(-0.08s)（保持这套做法）
```

### 2.1 分段表怎么读

| 列 | 含义 | 判读 |
|---|---|---|
| `圈内s` | 该段每圈平均占用时间 | 和参照的 `Δs` 为正 = 这段亏时间 |
| `Δs` | 每圈和参照算法的时间差（已按圈数归一） | 只看 **> 0.05s** 的段，亏时间通常集中在 1~3 段 |
| `均速` | 该段平均车速（m/s） | 结合 `饱和%`/`重刹%` 判断是"限速太低"还是"跟不上" |
| `重刹%` / `轻刹%` / `油门%` | 该段三通道的帧占比 | 出弯段油门明显掉、重刹过多 → 刹车点偏早/出弯补油晚 |
| `饱和%` | `|inSteer| ≥ 0.98` 的帧占比（方向盘打满） | **> 12% 基本就是推头**：走线太紧/前瞻太长/弯速表太乐观 |
| `草%` | 该段在草地上的帧占比 | 任何 > 0 的段都值得看一眼 |

### 2.2 通道统计怎么读

| 指标 | 含义 | 异常时的改法 |
|---|---|---|
| `重刹% / 轻刹%` | 重刹（=2）/ 轻刹（=1）的帧占比 | 重刹 > 28% 通常是轻刹被完全跳过；轻刹是重刹的 45%，适合做"包络上的调制" |
| `重刹脉冲` | 重刹只持续 ≤2 帧就松开的次数 | **占比 > 30% 就是典型的 bang-bang 振荡**：`v > 目标 + 一点点 → 重刹` 这种写法要换成"按所需减速度 `aReq` 分档"或加死区 |
| `油门时实际加速度 vs 模型` | 只在「油门 + 不刹车」的帧比较：实际 `car.accel` vs 该车 `perf` 的满油门加速度 | **< 85% 说明很多帧其实在滑行/轻刹**（一次轻刹要 6 帧油门才补得回来），问题在刹车触发太敏感，不在油门 |
| `滑行%` | 既不油门也不刹车 | 偏高一般是死区太宽，或者刹车逻辑把 `up` 也关掉了 |
| `转向饱和%` | 见上 | 见上 |

### 2.3 混战（`--mode=vs`）与同款 1v1（`--mode=duel`）

```powershell
# 整场混战：其余车用各自的内置 AI（与游戏 vs 模式完全一致）
npm run algo:doctor -- --algo=my.js --track=monza --car=apex-hunter --mode=vs

# 同款车 1v1：排除车型差异，只比算法
npm run algo:doctor -- --algo=my.js --track=monza --car=apex-hunter --mode=duel
```

vs / duel 下报告会多三样东西：

- **头部名次**：`名次 P2/7（落后冠军 +1.12s）`（完赛按总时、未完赛按里程排序，与游戏一致）
- **交通暴露度**：`被挡（正前方 8m 内有车）x% · 并排贴身 y%`
- **混战专属诊断**：跟车安全距离是否够、并排是否过度回避、要不要先用 `duel` 隔离交通

判读要点：

- 混战的**分段用时含交通噪声**（跟车/被挡/避让），和 solo 比出现 0.1~0.5s 的段差很正常，别当成走线退步；
- 定位顺序：先用 `duel` 看纯算法差距，再跑 `vs`，两者之差就是"交通成本"；
- `vs` 里的对手用的是**各自的内置 AI**，不是你的算法，所以名次不能直接和你自己的另一版本比较名次差，要看总时差。

#### 两个算法同场肉搏（`--rival`）

```powershell
# 我的算法 vs 另一个脚本，同一场比赛直接对刷（其余 6 台是内置 AI）
node scripts/algo-doctor.mjs --algo=userscripts/A.js --rival=userscripts/B.js --mode=vs --track=monza --car=apex-hunter --laps=3
```

工具会自动跑**双向**（我占该车型的发车位、对手排到队尾；再互换一次）并给平均，输出：

```
[对决] 同场对手 gemini-driver（双向对刷，各占一次队尾）
  正向：我 P3/8 2:25.983 · 对手 P2/8 2:24.783　→　我慢 1.200s（最快圈慢 0.917s）
  反向：我 P2/8 2:25.183 · 对手 P6/8 2:28.700　→　我快 3.517s（最快圈快 1.700s）
  平均：我快 1.159s · 最快圈快 0.392s（双向均值，已消除发车位偏差）
```

三条口径要分清：

| 比法 | 命令 | 公平性 | 适合回答 |
|---|---|---|---|
| 同场肉搏 | `--rival=B.js --mode=vs` | 双向平均；但队尾起步在慢车（电车）上损失极大 | 真刀真枪谁先过线 |
| 分离对刷 | `--ref=B.js --mode=vs` | **对手表、发车位完全相同**，最公平 | 混战里谁的单圈/成绩更好（评分用这个） |
| 纯算法 | `--mode=duel --ref=B.js` | 同车、无其他车 | 只比算法本身 |

> 实践建议：评分/回归用 **`--ref` + `--mode=vs`**；想直观看两人肉搏过程/名次时用 **`--rival`**，
> 并且至少跑 3 圈——2 圈时"队尾起步"的交通损失往往大于算法差距本身。

### 2.4 自动诊断条目

doctor 会按阈值生成几条结论，常见三类：

- **`段 sX 每圈比参照慢 …`** → 这就是最该改的地方；括号里给了均速/重刹/饱和，便于判断是纵向还是横向问题。
- **`重刹脉冲 …`** / **`油门时实际加速度只有模型的 …%`** → 控速逻辑振荡，先修这个再谈极限。
- **`已经领先的段`** → 保持现在的做法，别为了"均匀"把优势段也改保守。

---

## 3. 验收：`algo-check`

```powershell
# 标准矩阵：全赛道 × 全车型，2 圈，参照 geminiDriver
npm run algo:check -- --algo=my.js --laps=2

# 只跑你关心的几条
npm run algo:check -- --algo=my.js --tracks=monza,silverstone --cars=apex-hunter,smooth-cruiser

# 自定义阈值（默认：草地 ≤ 1.5%、慢于参照 ≤ 2%）
npm run algo:check -- --algo=my.js --max-grass=1 --max-slow=1

# 留档 + 后续对比
npm run algo:check -- --algo=my.js --save=accept.json
```

判定项（任一不满足即 `FAIL`，进程退出码 = 1，可直接接 CI）：

1. 完赛（`finished`）
2. 无异常（`errors = 0`）
3. 无越权写入（`violations = 0`）
4. `草地% ≤ --max-grass`
5. `Δ% ≤ --max-slow`（`--ref=none` 时跳过）

输出末尾会给 `PASS n/m`、平均 Δ%、分赛道 Δ%，以及失败项清单：

```
PASS 46/49 · 平均 -1.35%（负 = 比参照快）
分赛道：monza -0.86% · silverstone -3.48% · stadiumring +0.36%
失败项：
 ✗ silverstone / 法拉利 #16：草地2.1%
```

CI 里检查算法改动：

```powershell
npm run algo:check -- --algo=userscripts/我的算法.js --laps=2 --save=accept.json
if ($LASTEXITCODE -ne 0) { exit 1 }
```

---

## 4. 症状 → 对策速查

| 症状（看 doctor） | 典型原因 | 改法 |
|---|---|---|
| 重刹脉冲占比 > 30%，实际加速度远低于模型 | 用「当前速度 vs 目标速度」直接分档，超一点点就重刹一帧 | 改成先算**所需减速度** `aReq = max((v² − cap²) / (2d))`，只有 `aReq` 超过轻刹能力才重刹；轻刹只用于小幅超速 |
| 某段 `饱和%` > 12% 且均速低 | 前瞻太长 / 弯速表偏乐观（把 96% 抓地当 100% 用） | 缩短纯追踪前瞻（`look ≈ 5 + 0.18v` 起步试）；或把抓地利用率降 1~2%；也可给曲率加前向窗口，提前 5m 压到弯心限速 |
| 某段均速低但 `重刹%`、`饱和%` 都不高 | 该段的**目标速度本身偏低**（走线太保守 / 弯速表窗口太宽） | 检查走线走廊宽度、`kmax` 的曲率窗口，别把出弯段限速留太久 |
| 出弯后直道段慢 | 出弯开油太晚（刹车档位没及时松） | 允许「轻刹 + 油门」重叠（`|alpha|` 小、车头已对准时同时给油）；出弯段禁用轻刹 |
| 草地 > 1.5%，集中在 1~2 段 | 刹车点太晚（重刹规划利用率 > 0.98）或走线贴边 | 刹车规划利用率降到 0.95~0.97；入弯压线但留 1.5~2m 余量 |
| 每圈抖动 > 0.3s | 用未平滑的瞬时量（`car.speed`/`car.accel`）做反馈 | 用 `car.gLat/gLon`（已平滑）或自己一阶滤波 |
| `--dt=0.0333 --jitter` 下明显变差 | 增益按 60fps 调死 | 所有时间相关项乘 `dt`；增益写成 `min(1, dt * k)` |

---

## 5. 参数速查

### algo-doctor

| 参数 | 说明 |
|---|---|
| `--algo=<文件\|内置名\|->` | 被测算法（必填）；`-` 从 stdin 读 |
| `--track=<id>` | 缺省 `shanghai` |
| `--car=<id>` | 缺省 `apex-hunter` |
| `--mode=solo\|vs\|duel` | 缺省 `solo`；`vs` = 整场混战（其余车内置 AI），`duel` = 同款车 1v1 |
| `--laps=<n>` | 缺省 3 |
| `--ref=<名字\|none>` | 参照算法（单独跑一场对照），缺省 `geminiDriver`；`none` = 不对比 |
| `--rival=<文件\|内置名>` | 同场对手：追加一台同款车直接肉搏，自动双向对刷取平均 |
| `--sections=<n>` | 分段数，缺省 12（2~48） |
| `--dt=<秒>` / `--jitter` / `--seed=<n>` | 步长 / 抖动 / 随机种子 |
| `--json[=<文件>]` | 输出 JSON（含每段明细与 `advice`） |
| `--dump-args` | 只打印原始参数，排查 shell / npm 吞参数 |
| `--verbose` / `--list` | 打印算法 `console.log` / 列出赛道车型算法 |

### algo-check

| 参数 | 说明 |
|---|---|
| `--algo=<文件\|内置名>` | 被测算法（必填） |
| `--tracks=all\|id,id` | 缺省 `all` |
| `--cars=all\|id,id` | 缺省 `all` |
| `--mode=solo\|vs\|duel` | 缺省 `solo`；`vs`/`duel` 时表格会多一列名次 |
| `--laps=<n>` | 缺省 2（1 圈含发车，不宜对比） |
| `--ref=<名字\|none>` | 参照算法（单独跑一场对照），缺省 `geminiDriver` |
| `--rival=<文件\|内置名>` | 同场对手（同车追加 + 双向对刷），Δ% 取两向平均；与 `--ref` 二选一，`--rival` 优先 |
| `--max-grass=<pct>` | 草地上限，缺省 1.5 |
| `--max-slow=<pct>` | 慢于参照的上限，缺省 2 |
| `--save=<文件>` | 保存每个用例的明细 JSON |
| `--quiet` | 只打印失败项与汇总 |
| `--dt` / `--jitter` / `--seed` | 同上 |

---

## 6. 口径与注意事项

- **1 圈一定含发车**（从发车位静止起步），所以对比、验收一律用 `--laps=2` 或更多，只看 `最快圈`。
- **固定 `seed`** 才有可比性；同一份代码重复跑有 ±0.05s 左右的噪声（引擎里发车格与完赛巡航用了 `Math.random`）。
- `--dt` / `--jitter` 用来验证鲁棒性，不作为日常调参依据。
- 参照算法默认 `geminiDriver`（内置最强）。想看"同车 1v1"用 `autopilot-bench --mode=duel`。
- 台架不模拟在线延迟与插值误差，缠斗相关的判断仍要进游戏验证（见 `autopilot-bench.md` §6）。
- doctor 的每段数据在 `--json` 里有完整字段（`sections[]`、`global`、`advice`），可以直接喂给脚本做趋势图。

---

## 7. 想加新指标

所有采集都在一个钩子里，改动集中在 `scripts/lib/algo-harness.mjs` 的 `runSolo({ onStep })`：

```js
onStep({ car, out, dt, step, simMs })   // 每个物理步调一次（已 stepCar，car 是真实对象）
```

- 想加**分段/通道**指标 → 改 `scripts/algo-doctor.mjs` 的 `makeCollector()`；
- 想加**判定项** → 改 `scripts/algo-check.mjs` 里的 `reasons` 组装；
- 想换**参照算法** → 三个脚本都支持 `--ref=<内置名|文件路径>`；
- 不要再复制一份编译/仿真循环：`loadAlgo()` / `runSolo()` 已经是唯一实现。
