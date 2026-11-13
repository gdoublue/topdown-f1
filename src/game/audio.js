// 避免 HMR 重载时旧 AudioContext 驻留导致声音重叠
if (typeof window !== "undefined" && window.__carAudioCtx) {
  try { window.__carAudioCtx.close(); } catch (e) {}
}

// 音频系统：
// 1. 赛车引擎：100% 纯程序化 DSP 引擎音效，彻底消除所有外部音频文件（彻底删除老旧的 bg_music.mp3、tire_screech_loop.ogg 及 CLIP_FILES 实录）。
//    杜绝任何声音双层重叠！
// 2. 独立温厚刹车磨盘声（纯程序化粉红噪声 + 550Hz 低通滤波，碳陶刹车质感，绝不尖叫）。
// 3. 连续富有节奏的排气管回火放炮声（Overrun Backfire Pops）：收油与减速滑行时触发清脆空腔爆鸣（360Hz~560Hz）。
// 4. 程序化发车/过圈/完赛音效（数字合成蜂鸣/钟鸣），绝不播放任何过去的发动机录音。
// 5. 严格的面板与生命周期静音策略：在主界面、选车/选赛道弹窗、结算大屏、调校面板打开或尚未发车时，绝对瞬间静音！
import { PHYS } from "../config.js";
import { clamp } from "../utils.js";

// 纯电车型（按涂装判定）：小米 SU8 Ultra / 仰望 U9 Xtreme
const ELECTRIC_LIVERIES = new Set(["su7ultra", "yangwang"]);
const EV_ACCEL_FILE = "./music/ev_accel_loop.mp3";
const OFFROAD_FILE = "./music/offroad_engine_loop.mp3";

// Web Audio 上下文与主混音总线
let actx = null, master = null;
let evLayer = null, offroadLayer = null;
let ready = false, started = false, muted = false;
let rpm = 0;

// ==========================================
// F1 / 赛车纯程序化 DSP 引擎音效网络（唯一声源，绝不重叠）
// ==========================================
let f1MixBus = null;
let f1IdleLayer = null, f1MidLayer = null, f1HighLayer = null;
let f1Shaper = null, f1HP = null, f1LP = null;
let f1Formant1 = null, f1Formant2 = null, f1Formant3 = null;
let f1DryGain = null, f1Convolver = null, f1WetGain = null;

// 独立低频刹车磨盘声网络（纯程序化，低通 550Hz，温和碳陶摩擦质感）
let brakeSource = null, brakeFilter = null, brakeGain = null;

// 轮胎极限甩尾侧滑声（纯程序化，低通 1000Hz 橡胶搓地质感，绝无尖锐啸叫）
let skidSource = null, skidFilter = null, skidGain = null;

// 变速箱与回火放炮状态跟踪
let currentGear = 1;
let shiftCutTimer = 0;
let overrunActive = false;
let overrunCooldown = 0;
let overrunPopCount = 0;

// ----------------------------------------------------
// DSP 配方 1：圆润平滑软饱和曲线（极度温和，保留低频丰厚度，杜绝任何高频毛刺）
// ----------------------------------------------------
function createWaveShaperCurve(amount = 1.3) {
  const n_samples = 44100;
  const curve = new Float32Array(n_samples);
  for (let i = 0; i < n_samples; ++i) {
    const x = (i * 2) / n_samples - 1;
    // 电子管非对称软饱和：赋予引擎深沉沙哑的赛车破音喉音质感，彻底消除电子数码单薄感
    curve[i] = Math.tanh(amount * x) * 0.90 + Math.sin(x * Math.PI) * 0.08 + Math.tanh(amount * 0.4 * x * x) * 0.04;
  }
  return curve;
}

// ----------------------------------------------------
// DSP 配方 2：真正雄浑低吼、排气管撕裂嘶吼的赛车内燃机做功波形（纯正机械轰鸣，彻底拔除蚊子音）
// ----------------------------------------------------
function generateEngineBuffer(actx, baseRpm, durTarget = 0.45) {
  const sr = actx.sampleRate;
  const crankF = baseRpm / 60.0;
  const cyclePeriod = 2.0 / crankF;
  const nCycles = Math.max(1, Math.round(durTarget / cyclePeriod));
  const exactDur = nCycles * cyclePeriod;
  const nSamples = Math.round(exactDur * sr);
  
  const buffer = actx.createBuffer(1, nSamples, sr);
  const data = buffer.getChannelData(0);
  
  // 经典 Crossplane V8 / 赛道 Flatplane 混合点火角度（0°, 90°, 270°, 180°, 450°, 540°, 360°, 630°）
  // 赛车运动史上最富盛名、最雄浑澎湃的轰鸣做功间隔！
  const cylinders = 8;
  const fireDelays = [0.0, 0.125, 0.375, 0.250, 0.625, 0.750, 0.500, 0.875];
  const cylJitter  = [-0.008, 0.012, -0.005, 0.010, -0.010, 0.008, -0.006, 0.007];
  const cylGain    = [1.02, 0.98, 1.01, 0.97, 1.03, 0.98, 1.00, 0.99];
  
  const w = cyclePeriod / cylinders;
  for (let c = 0; c < cylinders; c++) {
    const tOff = (fireDelays[c] + cylJitter[c]) * cyclePeriod;
    const g = cylGain[c];
    
    for (let i = 0; i < nSamples; i++) {
      const t = i / sr;
      const tau = ((t - tOff) % cyclePeriod + cyclePeriod) % cyclePeriod;
      const sub = (tau % w) / w;
      
      // 非对称真实排气做功气浪：冲击膨胀波 + 歧管回压真空抽吸
      let pulse = 0;
      if (sub < 0.26) {
        pulse = 0.5 * (1 - Math.cos((sub / 0.26) * Math.PI));
      } else {
        const v = (sub - 0.26) / 0.74;
        pulse = 0.5 * (1 + Math.cos(v * Math.PI)) - 0.16 * Math.sin(v * 2 * Math.PI);
      }
      data[i] += pulse * g;
    }
  }
  
  // 注入深沉有力的轰鸣做功阶数（主能量扎根在 60Hz ~ 450Hz 嘶吼咆哮区）
  const orders = [
    [0.5, 0.25], // 凸轮轴机械心跳（突突声的底气）
    [1.0, 0.40], // 曲轴旋转重低音力量（体量感与惯性）
    [2.0, 0.60], // 双侧排气歧管共鸣撕裂感（轰鸣厚度）
    [4.0, 1.00], // 主点火咆哮基频（核心澎湃主音）
    [6.0, 0.22], // 柔和二次谐波（赋予赛车金属质感，圆润不刺耳）
    [8.0, 0.10]  // 微量高阶泛音
  ];
  for (let k = 0; k < orders.length; k++) {
    const [order, amp] = orders[k];
    const freq = crankF * order;
    const omega = 2 * Math.PI * freq;
    for (let i = 0; i < nSamples; i++) {
      data[i] += amp * Math.sin(omega * (i / sr));
    }
  }
  
  // 去除直流偏移（DC Offset），确保波形零点对称，声压能量完全释放
  let mean = 0;
  for (let i = 0; i < nSamples; i++) mean += data[i];
  mean /= nSamples;
  for (let i = 0; i < nSamples; i++) data[i] -= mean;

  let maxVal = 0;
  for (let i = 0; i < nSamples; i++) {
    const y = Math.tanh(1.25 * data[i]);
    data[i] = y;
    if (Math.abs(y) > maxVal) maxVal = Math.abs(y);
  }
  if (maxVal > 0) {
    for (let i = 0; i < nSamples; i++) data[i] = (data[i] / maxVal) * 0.92;
  }
  
  return buffer;
}

// ----------------------------------------------------
// DSP 配方 3：柔和空间脉冲响应卷积核（舒适开阔混响）
// ----------------------------------------------------
function generateReverbIR(actx, dur = 0.20, decay = 0.05) {
  const sr = actx.sampleRate;
  const nSamples = Math.round(dur * sr);
  const buffer = actx.createBuffer(2, nSamples, sr);
  const left = buffer.getChannelData(0);
  const right = buffer.getChannelData(1);
  
  const taps = [
    [0.008, 0.35, 0.30],
    [0.016, 0.25, 0.28],
    [0.026, 0.18, 0.16]
  ];
  for (const [delayS, gL, gR] of taps) {
    const idx = Math.round(delayS * sr);
    if (idx < nSamples) {
      left[idx] += gL;
      right[idx] += gR;
    }
  }
  
  let prevL = 0, prevR = 0;
  let maxV = 0;
  for (let i = 0; i < nSamples; i++) {
    const t = i / sr;
    const env = Math.exp(-t / decay);
    const nL = (Math.random() * 2 - 1) * env * 0.15;
    const nR = (Math.random() * 2 - 1) * env * 0.15;
    prevL = nL * 0.18 + prevL * 0.82;
    prevR = nR * 0.18 + prevR * 0.82;
    left[i] += prevL;
    right[i] += prevR;
    if (Math.abs(left[i]) > maxV) maxV = Math.abs(left[i]);
    if (Math.abs(right[i]) > maxV) maxV = Math.abs(right[i]);
  }
  if (maxV > 0) {
    for (let i = 0; i < nSamples; i++) {
      left[i] = (left[i] / maxV) * 0.70;
      right[i] = (right[i] / maxV) * 0.70;
    }
  }
  return buffer;
}

// ----------------------------------------------------
// DSP 配方 4：柔和低频粉红噪声（程序化刹车与轮胎摩擦专用）
// ----------------------------------------------------
function generateNoiseBuffer(actx, dur = 1.0) {
  const sr = actx.sampleRate;
  const nSamples = Math.round(dur * sr);
  const buffer = actx.createBuffer(1, nSamples, sr);
  const data = buffer.getChannelData(0);
  let b0 = 0, b1 = 0;
  for (let i = 0; i < nSamples; i++) {
    const white = Math.random() * 2 - 1;
    b0 = 0.95 * b0 + white * 0.05;
    b1 = 0.90 * b1 + white * 0.10;
    data[i] = (b0 + b1) * 2.8;
  }
  return buffer;
}

// ----------------------------------------------------
// 初始化并搭建整个 Web Audio DSP 实时音频图
// ----------------------------------------------------
async function start() {
  if (started) return;
  started = true;
  try {
    actx = new (window.AudioContext || window.webkitAudioContext)();
    window.__carAudioCtx = actx;
    if (actx.state === "suspended") await actx.resume();
    master = actx.createGain();
    master.gain.value = 0.85;
    master.connect(actx.destination);

    // ==========================================
    // 搭建 F1 / 赛车 DSP 引擎总线
    // ==========================================
    f1MixBus = actx.createGain();
    f1MixBus.gain.value = 0; // 默认静音

    // 1. 生成 3 层纯正澎湃赛车 V8 / 赛道机器波形（深沉浑厚，饱满轰鸣，杜绝任何高频蚊子嗡鸣）
    // 基频对应：怠速 ~120Hz、中转 ~240Hz、红线高转 ~386Hz（加速最高封顶 ~480Hz）
    const idleBuf = generateEngineBuffer(actx, 1800, 0.45);
    const midBuf  = generateEngineBuffer(actx, 3600, 0.35);
    const highBuf = generateEngineBuffer(actx, 5800, 0.25);

    const createLoopSource = (buf) => {
      const src = actx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      const g = actx.createGain();
      g.gain.value = 0;
      src.connect(g).connect(f1MixBus);
      src.start();
      return { src, gain: g };
    };

    f1IdleLayer = createLoopSource(idleBuf);
    f1MidLayer  = createLoopSource(midBuf);
    f1HighLayer = createLoopSource(highBuf);

    // 2. 软饱和波形塑形饱和器
    f1Shaper = actx.createWaveShaper();
    f1Shaper.curve = createWaveShaperCurve(1.3);
    f1Shaper.oversample = "2x";
    f1MixBus.connect(f1Shaper);

    // 3. 排气共振腔声学 Formant 滤波器网络（重塑低喉音轰鸣与撕裂排气质感）
    f1HP = actx.createBiquadFilter();
    f1HP.type = "highpass";
    f1HP.frequency.value = 45; // 允许 50Hz~90Hz 深沉重低音轰鸣通过，切除超低频直流漂移
    f1HP.Q.value = 0.7;

    f1Formant1 = actx.createBiquadFilter();
    f1Formant1.type = "peaking";
    f1Formant1.frequency.value = 140; // 胸腔低沉重低音轰鸣体感 (Deep Chest Roar)
    f1Formant1.Q.value = 1.3;
    f1Formant1.gain.value = 4.0;

    f1Formant2 = actx.createBiquadFilter();
    f1Formant2.type = "peaking";
    f1Formant2.frequency.value = 280; // 排气管筒体共鸣撕裂感 (Exhaust Pipe Barrel Roar)
    f1Formant2.Q.value = 1.4;
    f1Formant2.gain.value = 3.6;

    f1Formant3 = actx.createBiquadFilter();
    f1Formant3.type = "peaking";
    f1Formant3.frequency.value = 650; // 机械做功喉音 (Throaty Mechanical Growl，远离 1600Hz 刺耳峰)
    f1Formant3.Q.value = 1.5;
    f1Formant3.gain.value = 2.0;

    // 动态低通滤波器：初始 1400Hz，随油门动态开合至 2200Hz
    // 牢牢封死高频毛刺，彻底告别单薄尖刺的蚊子声！
    f1LP = actx.createBiquadFilter();
    f1LP.type = "lowpass";
    f1LP.frequency.value = 1400;

    // 串联滤波链
    f1Shaper.connect(f1HP);
    f1HP.connect(f1Formant1);
    f1Formant1.connect(f1Formant2);
    f1Formant2.connect(f1Formant3);
    f1Formant3.connect(f1LP);

    // 4. 赛车座舱与赛道真实空间混响（告别“贴在耳膜上的单声道蚊子叫”，营造 2 米开外的实体机械声场）
    const reverbIR = generateReverbIR(actx, 0.22, 0.06);
    f1Convolver = actx.createConvolver();
    f1Convolver.buffer = reverbIR;

    f1DryGain = actx.createGain();
    f1DryGain.gain.value = 0.76;
    f1WetGain = actx.createGain();
    f1WetGain.gain.value = 0.24;

    f1LP.connect(f1DryGain).connect(master);
    f1LP.connect(f1Convolver).connect(f1WetGain).connect(master);

    // ==========================================
    // 独立温和刹车声音总线（碳陶刹车盘机械咬合，低通 550Hz，纯程序化）
    // ==========================================
    const noiseBuf = generateNoiseBuffer(actx, 1.2);
    brakeSource = actx.createBufferSource();
    brakeSource.buffer = noiseBuf;
    brakeSource.loop = true;
    brakeFilter = actx.createBiquadFilter();
    brakeFilter.type = "lowpass";
    brakeFilter.frequency.value = 920; // 920Hz 清爽碳陶磨盘咬合感
    brakeGain = actx.createGain();
    brakeGain.gain.value = 0;
    brakeSource.connect(brakeFilter).connect(brakeGain).connect(master);
    brakeSource.start();

    // ==========================================
    // 独立轮胎极限甩尾侧滑声（纯程序化粉红噪声 + 1000Hz 低通，无尖叫）
    // ==========================================
    skidSource = actx.createBufferSource();
    skidSource.buffer = noiseBuf;
    skidSource.loop = true;
    skidFilter = actx.createBiquadFilter();
    skidFilter.type = "lowpass";
    skidFilter.frequency.value = 1000;
    skidGain = actx.createGain();
    skidGain.gain.value = 0;
    skidSource.connect(skidFilter).connect(skidGain).connect(master);
    skidSource.start();

    // ==========================================
    // 纯电 / 越野 车型专属加载（含容错）
    // ==========================================
    const load = async (url) => {
      const r = await fetch(url);
      const a = await r.arrayBuffer();
      return await actx.decodeAudioData(a);
    };

    const loopLayer = async (url) => {
      const buf = await load(url);
      const src = actx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      const g = actx.createGain();
      g.gain.value = 0;
      src.connect(g).connect(master);
      src.start();
      return { src, gain: g };
    };

    try { evLayer = await loopLayer(EV_ACCEL_FILE); } catch (e) { evLayer = null; }
    try { offroadLayer = await loopLayer(OFFROAD_FILE); } catch (e) { offroadLayer = null; }

    ready = true;
  } catch (e) {
    ready = false;
  }
}

// ----------------------------------------------------
// 触发减速滑行排气管清脆空腔回火放炮声（Overrun Backfire Pops）
// 每次减速滑行连续有节奏地爆鸣（350Hz~580Hz 空腔爆裂音），清晰且富有力量感
// ----------------------------------------------------
function triggerOverrunCrackle(t, intensity = 1.0) {
  if (!actx || !ready) return;
  try {
    const dur = 0.065 + Math.random() * 0.035;
    const nSamples = Math.round(dur * actx.sampleRate);
    const buf = actx.createBuffer(1, nSamples, actx.sampleRate);
    const d = buf.getChannelData(0);
    
    const decay = 0.020 + Math.random() * 0.008;
    for (let i = 0; i < nSamples; i++) {
      const time = i / actx.sampleRate;
      const env = Math.exp(-time / decay);
      // 1. 点火爆燃瞬态高频碎裂感 (Transient Ignition Snap)
      const snap = Math.sin(2 * Math.PI * 1450 * time) * Math.exp(-time / 0.006) * (Math.random() * 2 - 1) * 0.45;
      // 2. 尾段排气管共鸣空腔音 (Hollow Exhaust Body Resonance)
      const hollow = Math.sin(2 * Math.PI * (380 + Math.random() * 80) * time) * 0.55;
      // 3. 气浪冲击重低音 (Sub-bass Thump)
      const thump = Math.sin(2 * Math.PI * (150 - 70 * (time / dur)) * time) * 0.40;
      const noise = (Math.random() * 2 - 1) * 0.25;
      d[i] = Math.tanh(1.3 * (snap + hollow + thump + noise) * env);
    }
    
    const src = actx.createBufferSource();
    src.buffer = buf;
    
    const bp = actx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 420 + Math.random() * 160;
    bp.Q.value = 1.8;
    
    const g = actx.createGain();
    const vol = (0.26 + Math.random() * 0.08) * clamp(intensity, 0.6, 1.25);
    g.gain.setValueAtTime(vol, t);
    
    src.connect(bp).connect(g).connect(master);
    src.start(t);
  } catch (e) {}
}

// 首次交互时解锁 AudioContext（浏览器自动播放策略）
export function setupAudio() {
  const kick = () => { if (!started) start(); };
  window.addEventListener("keydown", kick);
  window.addEventListener("pointerdown", kick);
  window.addEventListener("keydown", (e) => {
    if (e.key.length === 1 && e.key.toLowerCase() === "m" && actx) {
      muted = !muted;
      master.gain.setTargetAtTime(muted ? 0 : 0.85, actx.currentTime, 0.05);
    }
  });
}

// ----------------------------------------------------
// 显式瞬间静音函数：弹窗/面板弹出或离开比赛时瞬间静音所有音频
// ----------------------------------------------------
export function silenceAudio() {
  if (!actx) return;
  const t = actx.currentTime;
  rpm = 0.05;
  overrunActive = false;
  if (f1MixBus) f1MixBus.gain.setTargetAtTime(0, t, 0.015);
  if (f1IdleLayer) f1IdleLayer.gain.gain.setTargetAtTime(0, t, 0.015);
  if (f1MidLayer)  f1MidLayer.gain.gain.setTargetAtTime(0, t, 0.015);
  if (f1HighLayer) f1HighLayer.gain.gain.setTargetAtTime(0, t, 0.015);
  if (brakeGain)   brakeGain.gain.setTargetAtTime(0, t, 0.015);
  if (skidGain)    skidGain.gain.setTargetAtTime(0, t, 0.015);
  if (evLayer) evLayer.gain.gain.setTargetAtTime(0, t, 0.015);
  if (offroadLayer) offroadLayer.gain.gain.setTargetAtTime(0, t, 0.015);
}

// ----------------------------------------------------
// 7速序列式变速箱齿比模型
// ----------------------------------------------------
const GEAR_BOUNDS = [
  [0.00, 0.22, 0.30, 1.00], // 1 挡
  [0.18, 0.36, 0.55, 1.00], // 2 挡
  [0.32, 0.50, 0.62, 1.00], // 3 挡
  [0.46, 0.64, 0.68, 1.00], // 4 挡
  [0.60, 0.77, 0.72, 1.00], // 5 挡
  [0.74, 0.89, 0.76, 1.00], // 6 挡
  [0.86, 1.05, 0.80, 1.00]  // 7 挡
];

function calculateGearAndRpm(spdNorm) {
  let targetGear = 0;
  for (let i = GEAR_BOUNDS.length - 1; i >= 0; i--) {
    if (spdNorm >= GEAR_BOUNDS[i][0]) {
      targetGear = i;
      break;
    }
  }
  const [minS, maxS, minR, maxR] = GEAR_BOUNDS[targetGear];
  const sFraction = clamp((spdNorm - minS) / (maxS - minS), 0, 1);
  const inGearRpm = minR + sFraction * (maxR - minR);
  return { gear: targetGear + 1, inGearRpm };
}

const NO_CTRL = { up: false, brake: 0 };

// ----------------------------------------------------
// 每帧驱动：严格遵循游戏生命周期（面板打开/未开赛强制绝对静音）
// ----------------------------------------------------
export function updateAudio(car, input, dt, racing) {
  if (!ready || !actx) return;
  const t = actx.currentTime;

  // ====================================================
  // 【核心保障】任何面板打开、未发车、结算弹窗时瞬间绝对静音！
  // ====================================================
  if (!racing || !car) {
    silenceAudio();
    return;
  }

  // 开赛状态处理
  const ctrl = input || NO_CTRL;
  const spd = Math.abs(car.speed || 0);
  const vmax = PHYS.maxSpeed[0];
  const spdNorm = clamp(spd / vmax, 0, 1);
  const electric = ELECTRIC_LIVERIES.has(car.livery);
  const offroad = !electric && car.livery === "offroad";
  const throttle = Boolean(ctrl.up && ctrl.brake === 0);
  const braking = Boolean(car.braking || ctrl.brake > 0);

  // 齿比与挡内转速计算
  const { gear: newGear, inGearRpm } = calculateGearAndRpm(spdNorm);
  
  // 换挡切火（Shift Cut）动作
  if (newGear !== currentGear) {
    currentGear = newGear;
    shiftCutTimer = 0.04;
    triggerOverrunCrackle(t, 0.6);
  }
  if (shiftCutTimer > 0) {
    shiftCutTimer -= dt;
  }

  // 目标转速平滑逼近
  const targetRpm = throttle ? inGearRpm : Math.max(0.08, inGearRpm * 0.78);
  const rpmSpeed = throttle ? 5.2 : 3.4;
  rpm += (targetRpm - rpm) * Math.min(1, dt * rpmSpeed);

  // ----------------------------------------------------
  // 连续有节奏的回火放炮逻辑（Overrun Crackle Sequence）
  // 踩油门加速时激活充能；一旦松开油门（无论滑行还是刹车）且车速转速较高，持续放炮！
  // ----------------------------------------------------
  if (throttle && rpm > 0.40) {
    overrunActive = true;
    overrunPopCount = 0;
    overrunCooldown = 0.05;
  } else if (overrunActive) {
    if (spdNorm < 0.15 || rpm < 0.22 || overrunPopCount >= 6) {
      overrunActive = false;
    } else {
      overrunCooldown -= dt;
      if (overrunCooldown <= 0) {
        overrunPopCount++;
        triggerOverrunCrackle(t, clamp(rpm * 1.3, 0.6, 1.2));
        overrunCooldown = 0.08 + Math.random() * 0.14;
      }
    }
  }

  if (electric) {
    // 纯电车型：关闭内燃机，开启单层电动机加速
    if (f1MixBus) f1MixBus.gain.setTargetAtTime(0, t, 0.05);
    if (offroadLayer) offroadLayer.gain.gain.setTargetAtTime(0, t, 0.1);
    if (evLayer) {
      const evVol = (0.05 + rpm * 0.15) * (throttle ? 1 : 0.45);
      evLayer.gain.gain.setTargetAtTime(evVol, t, 0.06);
      evLayer.src.playbackRate.setTargetAtTime(0.72 + rpm * 0.75, t, 0.05);
    }
  } else if (offroad) {
    // 越野卡车：关闭内燃机，开启柴油机实录
    if (f1MixBus) f1MixBus.gain.setTargetAtTime(0, t, 0.05);
    if (evLayer) evLayer.gain.gain.setTargetAtTime(0, t, 0.1);
    if (offroadLayer) {
      const vol = 0.14 + rpm * 0.18;
      offroadLayer.gain.gain.setTargetAtTime(vol, t, 0.08);
      offroadLayer.src.playbackRate.setTargetAtTime(0.78 + rpm * 0.65, t, 0.06);
    }
  } else {
    // ----------------------------------------------------
    // F1 / 赛车温润澎湃男中音引擎声（大众化舒适耐听调校，唯一声浪）
    // ----------------------------------------------------
    if (evLayer) evLayer.gain.gain.setTargetAtTime(0, t, 0.08);
    if (offroadLayer) offroadLayer.gain.gain.setTargetAtTime(0, t, 0.08);
    if (f1MixBus) f1MixBus.gain.setTargetAtTime(1.0, t, 0.04);

    const shiftCutAttn = shiftCutTimer > 0 ? 0.50 : 1.0;
    
    // 【关键】没开/停在原地没踩油门时（spdNorm < 0.02 && !throttle），怠速音量保持轻柔极低的 0.035
    // 踩下油门开走时才随转速澎湃轰鸣！
    const isStationaryIdle = spdNorm < 0.02 && !throttle;
    const throttleGain = throttle ? 1.0 : (isStationaryIdle ? 0.32 : 0.65);
    const overallVol = (isStationaryIdle ? 0.045 : (0.13 + rpm * 0.16)) * throttleGain * shiftCutAttn;

    // 三层波形平滑过渡
    let wIdle = clamp(1.0 - rpm * 2.5, 0, 1);
    let wMid  = clamp(1.0 - Math.abs(rpm - 0.50) * 2.2, 0, 1);
    let wHigh = clamp((rpm - 0.38) * 1.8, 0, 1);

    const wSum = (wIdle + wMid + wHigh) || 1;
    wIdle /= wSum;
    wMid  /= wSum;
    wHigh /= wSum;

    // 音高动态范围微调：自然随转速拉升，最高基频封顶在 ~480Hz（经典耐力赛/勒芒/V8 赛车撕裂嘶吼，绝对不是 800Hz 蚊子叫）
    if (f1IdleLayer) {
      const idleRate = clamp(0.90 + rpm * 0.25, 0.85, 1.18);
      f1IdleLayer.src.playbackRate.setTargetAtTime(idleRate, t, 0.03);
      f1IdleLayer.gain.gain.setTargetAtTime(overallVol * wIdle * 1.0, t, 0.04);
    }
    if (f1MidLayer) {
      const midRate = clamp(0.85 + rpm * 0.32, 0.82, 1.22);
      f1MidLayer.src.playbackRate.setTargetAtTime(midRate, t, 0.03);
      f1MidLayer.gain.gain.setTargetAtTime(overallVol * wMid * 1.0, t, 0.04);
    }
    if (f1HighLayer) {
      const highRate = clamp(0.82 + rpm * 0.38, 0.80, 1.25);
      f1HighLayer.src.playbackRate.setTargetAtTime(highRate, t, 0.03);
      f1HighLayer.gain.gain.setTargetAtTime(overallVol * wHigh * 1.05, t, 0.04);
    }

    // 动态低通滤波器开度：怠速 1200Hz，全油门最高 2200Hz
    // 温和厚实、饱满澎湃，彻底切除 2.4kHz 以上所有容易引起“蚊子在耳边”刺耳尖叫的频段
    if (f1LP) {
      const targetLpFreq = throttle
        ? (1600 + rpm * 600)
        : (1150 + rpm * 450);
      f1LP.frequency.setTargetAtTime(targetLpFreq, t, 0.04);
    }
  }

  // ----------------------------------------------------
  // 【刹车声音】专业碳陶刹车盘机械摩擦（低通 550Hz，温和低沉咬合，绝无高频尖叫）
  // ----------------------------------------------------
  if (brakeGain) {
    const brakeIntensity = ctrl.brake || (braking ? 0.85 : 0);
    const targetBrakeVol = (braking && spdNorm > 0.12)
      ? clamp(spdNorm * brakeIntensity * 0.22, 0, 0.22)
      : 0;
    brakeGain.gain.setTargetAtTime(targetBrakeVol, t, braking ? 0.05 : 0.12);
  }

  // ----------------------------------------------------
  // 轮胎极限甩尾侧滑声（程序化低频粉红噪声，低通 1000Hz）
  // ----------------------------------------------------
  if (skidGain) {
    let severeSkid = 0;
    if (Math.abs(car.steer) > 0.60 && spdNorm > 0.65) {
      severeSkid = Math.min(1, (Math.abs(car.steer) - 0.60) * (spdNorm - 0.65) * 6.0);
    }
    const targetSkidVol = severeSkid > 0 ? (0.05 + severeSkid * 0.12) : 0;
    skidGain.gain.setTargetAtTime(targetSkidVol, t, severeSkid > 0 ? 0.08 : 0.20);
  }
}

// 切换视角赛车时，瞬时同步引擎音频转速到该车
export function syncCarAudio(car) {
  if (!car) return;
  const spd = Math.abs(car.speed || 0);
  rpm = clamp(spd / PHYS.maxSpeed[0] * 0.85, 0, 1);
}

// 倒计时 / 提示蜂鸣（纯振荡器合成）
export function beep(freq, dur, vol = 0.16) {
  if (!ready || !actx) return;
  try {
    const o = actx.createOscillator();
    const g = actx.createGain();
    o.type = "sine";
    o.frequency.value = freq;
    g.gain.setValueAtTime(vol, actx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, actx.currentTime + dur);
    o.connect(g).connect(master);
    o.start();
    o.stop(actx.currentTime + dur + 0.02);
  } catch (e) {}
}

// ----------------------------------------------------
// 纯数字程序化事件音（彻底抛弃旧实录文件，绝不播放任何过去的旧文件！）
// ----------------------------------------------------
export function startSound() {
  // 发车信号提示音：清脆悦耳的双音上行鸣音
  if (!ready || !actx) return;
  beep(880, 0.12, 0.18);
  setTimeout(() => { beep(1320, 0.22, 0.20); }, 75);
}

export function lapSound() {
  // 过圈计时提示：清爽的双音电子钟鸣
  if (!ready || !actx) return;
  beep(980, 0.10, 0.16);
  setTimeout(() => { beep(1470, 0.18, 0.18); }, 65);
}

export function finishSound() {
  // 冲线完赛提示：欢快庆祝的胜利三连音
  if (!ready || !actx) return;
  beep(784, 0.12, 0.18);
  setTimeout(() => { beep(988, 0.14, 0.20); }, 85);
  setTimeout(() => { beep(1318, 0.32, 0.22); }, 180);
}

// 碰撞与擦碰音效（厚重阻尼撞击）
export function bumpSound() {
  if (!ready || !actx) return;
  try {
    const o = actx.createOscillator();
    const g = actx.createGain();
    o.type = "triangle";
    o.frequency.setValueAtTime(120, actx.currentTime);
    o.frequency.exponentialRampToValueAtTime(30, actx.currentTime + 0.12);
    g.gain.setValueAtTime(0.26, actx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, actx.currentTime + 0.12);
    o.connect(g).connect(master);
    o.start();
    o.stop(actx.currentTime + 0.13);
  } catch (e) {}
}

// 调试/测试用状态
export function audioState() {
  return { ready, started, muted, rpm: Math.round(rpm * 100) / 100, gear: currentGear, music: false };
}

if (import.meta && import.meta.hot) {
  import.meta.hot.dispose(() => {
    try { actx?.close(); } catch (e) {}
    try { window.__carAudioCtx?.close(); } catch (e) {}
  });
}
