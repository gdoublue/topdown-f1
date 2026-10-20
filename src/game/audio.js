// 音频：引擎六层“换挡”循环、轮胎尖叫、倒计时蜂鸣、F1 实录事件音、背景音乐
// 素材授权见 music/README.md（domasx2 CC0 / Edvvc CC BY-SA 3.0 / audible-edge CC BY 3.0）
import { PHYS } from "../config.js";
import { clamp } from "../utils.js";

const BG_MUSIC = "./music/bg_music.mp3";
const BG_VOLUME = 0.16;

const ENGINE_FILES = [0, 1, 2, 3, 4, 5].map(i => "./music/engine_loop_" + i + ".wav");
const SCREECH_FILE = "./music/tire_screech_loop.ogg";
const CLIP_FILES = [
  "./music/f1_1985_lola_hart_turbo.ogg",          // GO 起步爆发
  "./music/f1_1988_mclaren_honda_turbo.ogg",      // 完赛 rotation
  "./music/f1_1996_williams_renault_v10.ogg",     // 完赛 rotation
  "./music/f1_2006_redbull_cosworth_v8.ogg",      // 完赛 rotation
  "./music/f1_2009_brawn_bgp001_v8.ogg",          // 完赛 rotation
  "./music/f1_2009_ferrari_f60_v8.ogg"            // FINISH 冲线
];
const GO_CLIP = 0, FINISH_CLIP = 5;
const LAP_ROTATION = [1, 2, 3, 4];

let actx = null, master = null, lp = null, screechGain = null, bgGain = null, bgOn = false;
let layers = [], clipBuf = [];
let ready = false, started = false, muted = false;
let rpm = 0, lapIdx = 0;

async function start() {
  if (started) return;
  started = true;
  try {
    actx = new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === "suspended") await actx.resume();
    master = actx.createGain();
    master.gain.value = 0.85;
    master.connect(actx.destination);

    const load = async (url) => {
      const r = await fetch(url);
      const a = await r.arrayBuffer();
      return await actx.decodeAudioData(a);
    };

    // 引擎：6 段不同音高的循环 = 6 个“挡位”
    lp = actx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 700;
    lp.connect(master);
    for (const f of ENGINE_FILES) {
      const buf = await load(f);
      const src = actx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      const g = actx.createGain();
      g.gain.value = 0;
      src.connect(g).connect(lp);
      src.start();
      layers.push({ src, gain: g });
    }

    // 轮胎尖叫
    {
      const buf = await load(SCREECH_FILE);
      const src = actx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      screechGain = actx.createGain();
      screechGain.gain.value = 0;
      src.connect(screechGain).connect(master);
      src.start();
    }

    // 背景音乐（只在油门生效时播放，循环；初始静音）
    {
      const buf = await load(BG_MUSIC);
      const src = actx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      bgGain = actx.createGain();
      bgGain.gain.value = 0;
      src.connect(bgGain).connect(master);
      src.start();
    }

    // F1 实录（一次性事件音）
    for (const f of CLIP_FILES) clipBuf.push(await load(f));

    ready = true;
  } catch (e) {
    ready = false;   // 资源加载失败（如 file:// 直开）时静默禁用
  }
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

// 每帧调用：转速、换挡、轮胎声
// 注：ctrl 可能来自 AI 输入池（倍速/切视角/在线模式索引不匹配时可能是 undefined），
// 这里统一兜底成"松油门滑行"，避免一帧异常把整个渲染循环打断。
const NO_CTRL = { up: false, brake: 0 };

export function updateAudio(car, input, dt, racing) {
  if (!ready || !car) return;
  const ctrl = input || NO_CTRL;
  const t = actx.currentTime;
  const spd = Math.abs(car.speed);
  const vmax = PHYS.maxSpeed[0];

  const target = racing
    ? clamp(spd / vmax * 0.85 + (ctrl.up ? 0.15 : 0), 0, 1)
    : 0.06;   // 怠速
  rpm += (target - rpm) * Math.min(1, dt * 3.5);

  // 六层换挡：当前挡位循环播放并随转速变调，其余静音
  const gear = Math.min(5, Math.floor(rpm * 6));
  const local = clamp(rpm * 6 - gear, 0, 1);
  const vol = 0.10 + rpm * 0.18;
  for (let i = 0; i < layers.length; i++) {
    const L = layers[i];
    const active = i === gear;
    L.src.playbackRate.setTargetAtTime(0.75 + local * 1.25, t, 0.03);
    L.gain.gain.setTargetAtTime(active ? vol : 0, t, 0.045);
  }
  lp.frequency.setTargetAtTime(650 + rpm * 4300, t, 0.06);

  // 轮胎尖叫：重刹或高速猛打方向
  const skid = racing && ((car.braking && spd > vmax * 0.5) ||
    (Math.abs(car.steer) > 0.45 && spd > vmax * 0.83)) ? 1 : 0;
  screechGain.gain.setTargetAtTime(skid ? 0.22 : 0, t, skid ? 0.05 : 0.12);

  // 背景音乐：只在油门实际生效（比赛中按住 J/W 且未刹车）时播放
  const musicOn = racing && ctrl.up && ctrl.brake === 0;
  bgOn = musicOn;
  bgGain.gain.setTargetAtTime(musicOn ? BG_VOLUME : 0, t, musicOn ? 0.25 : 0.4);
}

// 切换视角赛车时，瞬时同步引擎音频转速到该车
export function syncCarAudio(car) {
  if (!car) return;
  const spd = Math.abs(car.speed);
  rpm = clamp(spd / PHYS.maxSpeed[0] * 0.85, 0, 1);
}

// 倒计时 / 提示蜂鸣（振荡器合成）
export function beep(freq, dur, vol = 0.16) {
  if (!ready) return;
  const o = actx.createOscillator();
  const g = actx.createGain();
  o.type = "square";
  o.frequency.value = freq;
  g.gain.setValueAtTime(vol, actx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, actx.currentTime + dur);
  o.connect(g).connect(master);
  o.start();
  o.stop(actx.currentTime + dur + 0.02);
}

// 播放一段 F1 实录：淡入 + 定长淡出
function playClip(i, seconds, vol) {
  if (!ready || !clipBuf[i]) return;
  const src = actx.createBufferSource();
  src.buffer = clipBuf[i];
  const g = actx.createGain();
  const t = actx.currentTime;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(vol, t + 0.15);
  g.gain.linearRampToValueAtTime(0, t + Math.max(0.4, seconds - 1));
  src.connect(g).connect(master);
  src.start(t);
  src.stop(t + seconds);
}

export function startSound() { playClip(GO_CLIP, 5.5, 0.2); }        // 起步
export function finishSound() { playClip(FINISH_CLIP, 7, 0.22); }    // 冲线
export function lapSound() {                                          // 过圈
  playClip(LAP_ROTATION[lapIdx++ % LAP_ROTATION.length], 4, 0.18);
}

// 碰撞与擦碰音效（沉闷阻尼冲击）
export function bumpSound() {
  if (!ready) return;
  try {
    const o = actx.createOscillator();
    const g = actx.createGain();
    o.type = "triangle";
    o.frequency.setValueAtTime(150, actx.currentTime);
    o.frequency.exponentialRampToValueAtTime(35, actx.currentTime + 0.12);
    g.gain.setValueAtTime(0.24, actx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, actx.currentTime + 0.12);
    o.connect(g).connect(master);
    o.start();
    o.stop(actx.currentTime + 0.13);
  } catch (e) {}
}

// 调试/测试用状态
export function audioState() {
  return { ready, started, muted, rpm: Math.round(rpm * 100) / 100, music: bgOn };
}
