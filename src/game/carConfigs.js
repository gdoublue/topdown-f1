// 赛车真实性能与算法配置表：车型 / 涂装 / 车号 / 车手 / perf 物理参数
// 纯数据模块，不依赖 ai.js 的任何逻辑；ai.js 会再导出本表，调用方仍可从 "../game/ai.js" 取。
import { geminiDriver } from "./geminiDriver.js";

export const AI_CONFIGS = [
  {
    id: "apex-hunter",
    name: "法拉利 #16 (SF-24 · 机械抓地与弯道出弯之王)",
    shortName: "法拉利 #16",
    team: "法拉利",
    model: "SF-24",
    color: "#ff3b3b",
    livery: "ferrari",
    number: "16",
    driverName: "勒克莱尔 (LEC #16)",
    driverShort: "勒克莱尔",
    driverCode: "LEC",
    // 同队二号车：vs 模式每款车出 2 台，两台不能挂同一个车手名（计时塔会两行同名）
    driver2: {
      number: "55",
      driverName: "塞恩斯 (SAI #55)",
      driverShort: "塞恩斯",
      driverCode: "SAI"
    },
    driver: geminiDriver,
    perf: {
      maxSpeed: [100.0, 90.0, 33.6],
      latGrip: 48.2,
      maxOmega: 3.75,
      accelMult: 1.05,
      brakeMult: 1.03,
      steerRate: 13.5
    }
  },
  {
    id: "vector-pursuit",
    name: "红牛 #1 (RB20 · DRS大直线极速与高速弯之王)",
    shortName: "红牛 #1",
    team: "红牛",
    model: "RB20",
    color: "#00b4d8",
    livery: "redbull",
    number: "1",
    driverName: "维斯塔潘 (VER #1)",
    driverShort: "维斯塔潘",
    driverCode: "VER",
    driver2: {
      number: "11",
      driverName: "佩雷兹 (PER #11)",
      driverShort: "佩雷兹",
      driverCode: "PER"
    },
    driver: geminiDriver,
    perf: {
      maxSpeed: [101.5, 92.0, 34.0],
      latGrip: 47.6,
      maxOmega: 3.60,
      accelMult: 1.03,
      brakeMult: 1.04,
      steerRate: 13.8
    }
  },
  {
    id: "classic-baseline",
    name: "阿斯顿 #14 (AMR24 · 高下压力弯道粘地/原基准)",
    shortName: "阿斯顿 #14",
    team: "阿斯顿·马丁",
    model: "AMR24",
    color: "#10b981",
    livery: "aston",
    number: "14",
    driverName: "阿隆索 (ALO #14)",
    driverShort: "阿隆索",
    driverCode: "ALO",
    driver2: {
      number: "18",
      driverName: "斯特罗尔 (STR #18)",
      driverShort: "斯特罗尔",
      driverCode: "STR"
    },
    driver: geminiDriver,
    perf: {
      maxSpeed: [100.3, 87.5, 33.0],
      latGrip: 47.2,
      maxOmega: 3.55,
      accelMult: 0.99,
      brakeMult: 0.98,
      steerRate: 11.0
    }
  },
  {
    id: "mercedes-w15",
    name: "梅奔 #44 (W15 · 深刹时间最优与主动防撞)",
    shortName: "梅奔 #44",
    team: "梅赛德斯",
    model: "W15",
    color: "#e2e8f0",
    livery: "mercedes",
    number: "44",
    driverName: "汉密尔顿 (HAM #44)",
    driverShort: "汉密尔顿",
    driverCode: "HAM",
    driver2: {
      number: "63",
      driverName: "拉塞尔 (RUS #63)",
      driverShort: "拉塞尔",
      driverCode: "RUS"
    },
    driver: geminiDriver,
    perf: {
      maxSpeed: [103.2, 92.8, 33.6],
      latGrip: 46.5,
      maxOmega: 3.50,
      accelMult: 1.04,
      brakeMult: 1.08,
      steerRate: 12.5
    }
  },
    {
    id: "AiMotor",
    name: "Ai Motor",
    shortName: "ai",
    team: "Ai Motor",
    model: "Cyber",
    color: "#a855f7",        // 排位榜色条 / 小地图点位：紫色（原本白色，和梅奔撞色）
    livery: "cyber",
    number: "55",
    driverName: "Ai (AIM #55)",
    driverShort: "Ai",
    driverCode: "AIM",
    driver2: {
      number: "56",
      driverName: "Ai 二号 (AI2 #56)",
      driverShort: "Ai 二号",
      driverCode: "AI2"
    },
    driver: geminiDriver,
    perf: {
      maxSpeed: [101.5, 91.8, 33.6],
      latGrip: 47.0,
      maxOmega: 3.40,
      accelMult: 1.02,
      brakeMult: 1.08,
      steerRate: 13.5
    }
  },
  {
    id: "smooth-cruiser",
    name: "小米 SU8 Ultra #7 (1548PS · 三电机弹射与碳陶瓷深刹)",
    shortName: "SU8 Ultra #7",
    team: "小米",
    model: "SU8 Ultra",
    color: "#f5c518",
    livery: "su7ultra",
    heavyModel: true,          // 真车模 ~5MB：玩家不选它就不出场、不下载
    number: "7",
    driverName: "小米车手 (XIAO #7)",
    driverShort: "小米车手",
    driverCode: "XIAO",
    driver2: {
      number: "8",
      driverName: "小米车手二号 (XIA2 #8)",
      driverShort: "小米二号",
      driverCode: "XIA2"
    },
    driver: geminiDriver,
    perf: {
      maxSpeed: [133.2, 88.0, 63.6],
      latGrip: 16.2,
      maxOmega: 3.50,
      powerKW: 1740,
      massKg: 2300,
      launchAccel: 14.2,
      brakeMult: 0.29,
      steerRate: 9.5
    }
  },
    {
    id: "yangwang-u9x",
    name: "仰望 U9 Xtreme #9 (3000Ps · 1200V 四电机极速之王)",
    shortName: "U9X #9",
    team: "仰望",
    model: "U9 Xtreme",
    color: "#f59e0b",
    livery: "yangwang",
    heavyModel: true,          // 真车模 ~5MB：玩家不选它就不出场、不下载
    number: "9",
    driverName: "仰望车手 (U9X #9)",
    driverShort: "仰望车手",
    driverCode: "U9X",
    driver2: {
      number: "10",
      driverName: "仰望车手二号 (U9X2 #10)",
      driverShort: "仰望二号",
      driverCode: "U9X2"
    },
    driver: geminiDriver,
    perf: {
      maxSpeed: [137.8, 124.0, 33.6],
      latGrip: 17.0,
      maxOmega: 2.60,
      powerKW: 1600,
      massKg: 2475,
      launchAccel: 14.6,
      brakeMult: 0.32,
      steerRate: 9.5
    }
  },
  {
    // 车模移植自外部「3D 车辆物理模拟器」的越野卡车（TRAIL RIG）：
    // 高底盘 + 大行程悬挂 + 球状越野胎，直道上不慢但大抓地/低横摆极限，
    // 弯道必须早刹；草地极速远高于 F1，冲线后/脱困更从容。
    id: "trail-rig",
    name: "越野卡车 #23 (TRAIL RIG · 4×4 高底盘全地形)",
    shortName: "越野卡车 #23",
    team: "越野工坊",
    model: "TRAIL RIG",
    color: "#c2551d",
    livery: "offroad",
    pickOnly: true,            // 玩家不选它就不出场（与小米 / 仰望同一套按需参赛规则）
    number: "23",
    driverName: "越野手 (TRK #23)",
    driverShort: "越野手",
    driverCode: "TRK",
    driver2: {
      number: "24",
      driverName: "越野手二号 (TRK2 #24)",
      driverShort: "越野二号",
      driverCode: "TRK2"
    },
    driver: geminiDriver,
    perf: {
      maxSpeed: [63.0, 52.0, 38.0],
      latGrip: 16.8,
      maxOmega: 2.90,
      powerKW: 340,
      massKg: 1950,
      launchAccel: 9.8,
      brakeMult: 0.45,
      steerRate: 8.2
    }
  }
];
