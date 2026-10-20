// 服务端全局配置
export const SERVER_CONFIG = {
  port: Number(process.env.PORT) || 8081,
  wsPath: "/ws",

  // 模拟节奏（P3 房间对战启用；当前骨架阶段仅占位）
  simTickHz: 30,          // 权威物理步频
  snapshotHz: 30,         // 快照广播频率（每个物理 tick 一包，包小但节奏均匀）
  inputHz: 20,            // 客户端输入上行频率（约定值）

  // 房间限制
  maxPlayersPerRoom: 8,
  maxRooms: 64,

  // 心跳与超时（毫秒）
  heartbeatIntervalMs: 15000,
  clientTimeoutMs: 45000,

  // 玩家脚本限制（P3 启用）
  driverScriptMaxBytes: 64 * 1024,
  driverTickBudgetMs: 1,          // 每脚本每 tick CPU 配额

  // 指纹会话
  sessionSalt: process.env.SESSION_SALT || "topdown-f1-dev-salt",
};

// 各赛道理论最短单圈（毫秒）——排行榜合理性校验下限。
// 数值来自 scripts/ai-sim.mjs 内置 AI 全盛圈速 × 0.92 的经验安全系数。
// 新增赛道时在此补充；缺失时回退到 defaultMinLapMs。
export const TRACK_MIN_LAP_MS = {
  shanghai: 68000,
  monza: 58000,
  silverstone: 63000,
  spa: 85000,
  redbullring: 48000,
};
export const DEFAULT_MIN_LAP_MS = 60000;
