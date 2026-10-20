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

## 数据

- 存储：`server/data/gp.json`（原子写入；表结构预留 SQLite，见 `db/store.js` 注释）
- 备份：直接复制该文件；重置：删除后重启
- 进程退出（SIGINT/SIGTERM）自动落盘

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
