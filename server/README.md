# Top-down F1 在线服务端

Node.js 权威对战服务器：指纹会话 / 房间即时对战 / 每赛道排行榜 /（规划中）玩家算法沙箱。

## 快速启动

```bash
cd server
npm install
npm start            # 默认 http://localhost:8080 （WS 路径 /ws）
npm run dev          # 开发模式（--watch 自动重启）
```

客户端：游戏内选择 **🌐 在线对战** → 输入 `ws://<服务器IP>:8080` → 连接。
本机开发时 vite (5173) 与服务端 (8080) 分开运行即可，CORS 已放行。

## 配置（`config.js` / 环境变量）

| 项 | 默认 | 说明 |
|---|---|---|
| `PORT` | 8080 | HTTP + WebSocket 端口 |
| `SESSION_SALT` | dev 默认值 | **生产必须设置**，指纹加盐哈希 |
| `simTickHz` | 30 | 权威物理步频 |
| `snapshotHz` | 20 | 快照广播频率 |
| `maxPlayersPerRoom` / `maxRooms` | 8 / 64 | 房间容量限制 |
| `driverScriptMaxBytes` | 64KB | 玩家脚本大小上限（沙箱阶段启用） |
| `RTC` | 开启（`RTC=0` 关闭） | WebRTC DataChannel（UDP）状态通道 |
| `RTC_STUN` | `stun:stun.l.google.com:19302` | 逗号分隔；填 `none` 表示纯局域网（不产生外网流量） |
| `RTC_TURN` | 空 | 对称型 NAT / 企业网兜底，格式 `turn:user:pass@host:3478` |
| `RTC_PORT_BEGIN` / `RTC_PORT_END` | 40000 / 40100 | ICE UDP 端口区间，防火墙放行这一段 |

## 数据

- 存储：`server/data/gp.json`（原子写入；表结构预留 SQLite，见 `db/store.js` 注释）
- 备份：直接复制该文件；重置：删除后重启
- 进程退出（SIGINT/SIGTERM）自动落盘

## 双通道传输（WebSocket + WebRTC/UDP）

| 数据 | 通道 | 理由 |
|---|---|---|
| 大厅 / 房间 / 开赛 / 成绩 / 信令 | WebSocket | 低频、必须可靠有序 |
| 快照 `snapshot`、中继 `peer_state`、上行 `car_state` | **WebRTC DataChannel（UDP，无序 + 不重传）** | 高频、只认最新 |

为什么位姿要换成 UDP：TCP 是有序字节流，一个包迟到会把后面所有包一起堵住（队头阻塞）。
实测「1% 概率单包延迟 180ms」就能让远端车出现 **2.58 倍**的速度弹跳，而这种尖峰在丢包链路上是常态。
DataChannel 设成 `unordered + maxRetransmits:0` 后，晚到的旧坐标直接丢弃，下一包 16ms 后就到了。

**降级是自动的**：DataChannel 12 秒内没建起来、或中途失败，会自动全程回落 WebSocket，
游戏功能完全不受影响（控制台 `__gp.conn.transport` 会显示当前实际走的是 `udp` 还是 `websocket`）。

部署要点：

```bash
# 1. 装依赖（node-datachannel 带预编译二进制，win/linux 都有）
npm install

# 2. 公网部署：STUN 必填，UDP 端口区间要放行
RTC_STUN="stun:stun.l.google.com:19302" RTC_PORT_BEGIN=40000 RTC_PORT_END=40100 pm2 restart f1-server

# 3. 对称型 NAT / 企业网：加 TURN
RTC_TURN="turn:user:pass@turn.example.com:3478" pm2 restart f1-server

# 4. 不想要原生依赖 / 纯局域网：整体关闭
RTC=0 pm2 restart f1-server
```

- 防火墙：**TCP 8080**（大厅与信令）+ **UDP 40000-40100**（状态通道）。只放行 TCP 也能玩，只是位姿走 WebSocket。
- 服务端日志会打印建链与流量：`[rtc] sid_xxx UDP 下行 N 包 · 上行 M 包`，`M` 为 0 说明上行也在回落。
- 运维/排查：服务端每 15s 汇总一次；客户端控制台 `__gp.rtc.debugInfo()` 看 ICE 状态。

## 生产部署

```bash
# pm2 守护
npm i -g pm2
pm2 start index.js --name f1-server --time
pm2 save && pm2 startup
```

- 防火墙放行 TCP 8080；公网建议 nginx/wss 反代（`wss://` 客户端直接可连）
- 日志：`pm2 logs f1-server`

## REST API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查 |
| GET | `/api/leaderboard/:trackId` | 某赛道排行榜（top 20） |
| POST | `/api/leaderboard` | 在线单人练习成绩提交 `{ fingerprint, nickname, trackId, carId, bestLapMs, totalMs, laps }` |
| GET | `/api/rooms` | 房间列表 |

## 测试脚本

```bash
node test/smoke-ws.mjs           # 握手/建房/就绪/离开
node test/smoke-race.mjs         # 完整比赛生命周期（SMOKE_TRACK=dragstrip SMOKE_LAPS=1 加速）
node test/collision-fairness.mjs # 碰撞公平性回归（无需服务端）
```

## 公平性设计要点

- 比赛物理全部在服务器 30Hz 权威模拟，客户端只做预测/插值表现
- 追尾判定：被撞车速度严格不变，动量损失由后车承担（无"顶车超车"漏洞，见 collision-fairness.mjs）
- 排行榜：在线对战成绩服务器直接可信；单人练习成绩需通过各赛道理论最短圈校验（`TRACK_MIN_LAP_MS`）
- 玩家身份：客户端指纹加盐哈希，浏览器升级可能漂移（后续加模糊匹配）
