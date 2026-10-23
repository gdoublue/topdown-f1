// 服务端全局配置
export const SERVER_CONFIG = {
  port: Number(process.env.PORT) || 8081,
  wsPath: "/ws",

  // 模拟节奏（P3 房间对战启用；当前骨架阶段仅占位）
  simTickHz: 30,          // 权威物理步频
  snapshotHz: 30,         // 快照广播频率（每个物理 tick 一包，包小但节奏均匀）
  inputHz: 30,            // 客户端输入上行频率（与快照同频，保证每个 tick 都有新坐标）

  // 房间限制
  maxPlayersPerRoom: 8,
  maxSpectatorsPerRoom: 8,   // 观赛位上限定：观赛不占发车位，8 人满房也能进来看
  maxRooms: 64,

  // WebSocket 资源限制
  maxConnections: 1024,       // 与 64 房 × 16 人（8 车手 + 8 观赛）的理论上限一致
  wsMaxPayload: 64 * 1024,    // 控制消息最大 64KB；ws 默认 100MB 会被单包打爆内存
  wsMessageRatePerSec: 120,   // 每会话令牌恢复速率（正常上报 60Hz + 控制消息）
  wsMessageBurst: 180,        // 令牌桶容量：允许短暂突发

  // 心跳与超时（毫秒）
  heartbeatIntervalMs: 15000,
  clientTimeoutMs: 45000,

  // 玩家脚本限制（P3 启用）
  driverScriptMaxBytes: 64 * 1024,
  driverTickBudgetMs: 1,          // 每脚本每 tick CPU 配额

  // WebRTC DataChannel（UDP）状态通道。
  // 位姿类数据走 unordered + 不重传的数据通道：丢一包无所谓（下一个 16ms 还有一包），
  // 重传只会让旧数据迟到 —— 那正是 TCP 队头阻塞导致"别人看你一顿一顿"的根源。
  // 房间 / 开赛 / 成绩 / 信令仍然走 WebSocket；DataChannel 建不起来时静默回落，游戏不中断。
  rtc: {
    // RTC=0 可整体关闭（不想装原生依赖的部署环境）
    enabled: process.env.RTC !== "0",
    // STUN：公网部署必填，否则双方拿不到公网映射，只能连局域网候选。
    // 纯局域网/本机部署可以填 none 跳过（更快，也不产生任何外网流量）
    iceServers: (process.env.RTC_STUN === "none"
      ? ""
      : (process.env.RTC_STUN || "stun:stun.l.google.com:19302"))
      .split(",").map(s => s.trim()).filter(Boolean),
    // 固定 UDP 端口区间：防火墙放行这一段即可（需要 UDP 出站 + 入站）
    portRangeBegin: Number(process.env.RTC_PORT_BEGIN || 40000),
    portRangeEnd: Number(process.env.RTC_PORT_END || 40100),
    maxMessageSize: 4096,        // 位姿包远小于 1KB，超大包直接丢弃
    // TURN（可选）：对称型 NAT / 企业网下 UDP 直连失败时兜底
    turn: process.env.RTC_TURN || "",   // 形如 "turn:user:pass@host:3478"
  },

  // 指纹会话
  sessionSalt: process.env.SESSION_SALT || "topdown-f1-dev-salt",
};

// 各赛道理论最短单圈（毫秒）——排行榜合理性校验下限。
// 标定依据：node scripts/ai-sim.mjs <track>（内置 AI 最快车 RB20 的全盛圈速），
// 再按 0.83~0.89 的经验系数留出"玩家算法 / 调校"的余量。
// 新增或改赛道（长度/走线变动）后**必须重新标定**，否则会出现
// "成绩合法却被判无效"（下限比实际能跑出来的圈速还慢）。
// 实测 AI 最快圈：shanghai 76.7s / monza 69.9s / silverstone 77.3s / spa 84.4s / redbullring 54.7s
// 缺失时回退到 DEFAULT_MIN_LAP_MS。
export const TRACK_MIN_LAP_MS = {
  shanghai: 68000,      // AI 76.7s（0.89）
  monza: 58000,         // AI 69.9s（0.83）
  silverstone: 63000,   // AI 77.3s（0.81）
  // 原来是 85000 —— 比内置 AI 的 84.4s 还慢，任何正常成绩都过不了校验
  // （自动驾驶 85.2s 会被判无效）。按 AI × 0.85 重新标定为 72s，余量与其他赛道一致。
  spa: 72000,           // AI 84.4s（0.85）
  redbullring: 48000,   // AI 54.7s（0.88）
};
export const DEFAULT_MIN_LAP_MS = 60000;
