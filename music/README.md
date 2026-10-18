# F1 赛车音频素材 · 说明书

素材用途：`game_car/index.html`（SHANGHAI GP 俯视 F1 小游戏）的音效层。
下载日期：2026-10-18 · 外网下载经本地代理 `127.0.0.1:7890`。

---

## 一、文件清单

### 1. 引擎循环层（可直接放进游戏，最重要）

| 文件 | 时长 | 规格 | 授权 |
|---|---:|---|---|
| `engine_loop_0.wav` | 0.86 s | 44.1 kHz / 16 bit / 单声道 | **CC0** |
| `engine_loop_1.wav` | 0.67 s | 同上 | **CC0** |
| `engine_loop_2.wav` | 0.68 s | 同上 | **CC0** |
| `engine_loop_3.wav` | 0.62 s | 同上 | **CC0** |
| `engine_loop_4.wav` | 0.63 s | 同上 | **CC0** |
| `engine_loop_5.wav` | 0.63 s | 同上 | **CC0** |

来源：OpenGameArt《racing car engine sound loops》，作者 **domasx2**（2011，为 BanditRacer 制作）。
<https://opengameart.org/content/racing-car-engine-sound-loops>

这 6 个文件是**同一段引擎录音的不同音高**，已做过半平滑循环处理，专为游戏 loop 设计，是这批素材里唯一"开箱即用"的。

### 2. 真实 F1 引擎实录（氛围 / 起步 / 回放）

全部录制于 Goodwood Festival of Speed 爬山赛，作者 **Edvvc**，许可 **CC BY-SA 3.0**。

| 文件 | 时长 | 对应赛车 / 引擎 | 声音特点 |
|---|---:|---|---|
| `f1_1985_lola_hart_turbo.ogg` | 30.09 s | Beatrice Lola-Hart THL 1，1.5 L 涡轮 L4 | 低频厚、涡轮哨音明显，起步最"史诗" |
| `f1_1988_mclaren_honda_turbo.ogg` | 23.98 s | McLaren-Honda MP4/4，1.5 L 涡轮 V6（Bruno Senna 驾驶） | 涡轮泄压阀 + 电子涡轮啸叫 |
| `f1_1996_williams_renault_v10.ogg` | 13.97 s | Williams-Renault FW18，3.0 L V10 | 经典高转尖啸，最"F1"的一代 |
| `f1_2006_redbull_cosworth_v8.ogg` | 47.57 s | Toro Rosso STR1，2.4 L V8（David Coulthard 烧胎） | 时间最长，含烧胎 + 高转拉升，可剪多段 |
| `f1_2009_ferrari_f60_v8.ogg` | 19.54 s | Ferrari F60，2.4 L V8 | 中高频亮、音量最大（260 kbps） |
| `f1_2009_brawn_bgp001_v8.ogg` | 14.46 s | Brawn-Mercedes BGP 001，2.4 L V8 | 干净、底噪低，适合做循环切片源 |

原页面（含作者、坐标、拍摄日期）：
`https://commons.wikimedia.org/wiki/File:<文件名去掉扩展名>.ogg`

### 3. 轮胎音效

| 文件 | 时长 | 规格 | 授权 |
|---|---:|---|---|
| `tire_screech_loop.ogg` | 3.00 s | 44.1 kHz / 单声道 / 96 kbps | **CC BY 3.0** |

来源：OpenGameArt《Car tire squeal skid loop》，作者 **audible-edge（Tom Haigh）**，由 qubodup 提交。
<https://opengameart.org/content/car-tire-squeal-skid-loop>
原始文件为 96 kHz / 24 bit / 单声道 864 KB，此处已转成 44.1 kHz / 16 bit Vorbis 以便浏览器加载，内容无缝可循环。

---

## 二、授权说明（重要）

| 许可 | 文件 | 你要做什么 |
|---|---|---|
| CC0 1.0 | `engine_loop_*.wav` | 无需署名，可商用，随便改 |
| CC BY 3.0 | `tire_screech_loop.ogg` | **必须署名**作者 audible-edge (Tom Haigh) 并附许可链接 |
| CC BY-SA 3.0 | `f1_*.ogg` | **必须署名** Edvvc 并附许可链接；**改编后的音频本身**（剪辑/变调/混音成品）需以 CC BY-SA 3.0 相同许可分发 |

注意：CC BY-SA 的"传染性"只覆盖音频的衍生作品，**不影响你的游戏代码和美术**。但如果你把处理过的引擎声当成独立音频文件分发出去，那份音频必须保持 CC BY-SA 3.0。

### 可直接粘进游戏 credits 的署名文本

```
音频素材 / Audio credits
- Engine loop samples by domasx2 (CC0 1.0)
  https://opengameart.org/content/racing-car-engine-sound-loops
- Formula One engine recordings by Edvvc (CC BY-SA 3.0)
  https://commons.wikimedia.org/wiki/Category:Sounds_of_Formula_One_cars
- Tire squeal loop by audible-edge / Tom Haigh (CC BY 3.0)
  https://opengameart.org/content/car-tire-squeal-skid-loop
```

### 商标提示
素材本身是机械声，没有商标问题；但"HART""McLaren""Ferrari""Red Bull""Brawn"等是车队/厂商商标。游戏正式发布时建议把车队名改成虚构名称（你在用的 `SHANGHAI GP` 标题同理，"F1" 是 Formula One 的注册商标）。

---

## 三、怎么用（引擎声）

### 1. 循环层：用 `playbackRate` 跟随转速
`engine_loop_*.wav` 只有 0.6–0.9 s，**不要按原速播**，音高要跟车速挂钩：

- 怠速：`playbackRate ≈ 0.7`
- 红线：`playbackRate ≈ 2.6 ~ 3.0`

```js
// 一次加载，永久复用
const buf = await fetch('./music/engine_loop_1.wav')
  .then(r => r.arrayBuffer())
  .then(a => ctx.decodeAudioData(a));

const src = ctx.createBufferSource();
src.buffer = buf;
src.loop = true;

const lp = ctx.createBiquadFilter();     // 转速越高，音色越亮
lp.type = 'lowpass';
lp.frequency.value = 900;

const gain = ctx.createGain();           // 车速越高越响
gain.gain.value = 0.0;

src.connect(lp).connect(gain).connect(ctx.destination);
src.start();

// 每帧调用：speed 为 0..1 归一化速度
function updateEngine(speed) {
  src.playbackRate.setTargetAtTime(0.7 + speed * 2.0, ctx.currentTime, 0.05);
  lp.frequency.setTargetAtTime(700 + speed * 4200, ctx.currentTime, 0.05);
  gain.gain.setTargetAtTime(0.12 + speed * 0.5, ctx.currentTime, 0.1);
}
```

### 2. 双层交叉淡化（更真实）
- 低速层 `engine_loop_1.wav`（音高偏低）
- 高速层 `engine_loop_5.wav`（音高偏高）
- 按速度线性交叉两者的 gain，比单层变调更不容易出现"电子音"的塑料感。

### 3. 加一点失真和涡轮
```
gain → WaveShaper(软削波) → 输出      // 引擎的颗粒感
+ 白噪声 → BandPass(1.2k~6k) → gain   // 涡轮啸叫，速度越高越响
```

### 4. 真实录音（`f1_*.ogg`）不要直接 loop
它们录于爬山赛现场，含观众声、远近变化和一次完整的加速扫频，首尾对不上。适合用途：
- 起跑倒计时结束的 1 次性爆发（`f1_1985_lola_hart_turbo.ogg` 最带感）
- 冲线 / 最快圈回放
- 菜单、加载页背景

想拿它做循环，先剪出稳定段：

```bash
# 取 6s~12s 的稳定高转段，做 0.5s 头尾交叉淡化
ffmpeg -i f1_2009_brawn_bgp001_v8.ogg -ss 6 -t 6 \
  -af "afade=t=in:d=0.3,afade=t=out:st=5.7:d=0.3" \
  -c:a libvorbis -q:a 6 engine_loop_brawn.ogg
```

---

## 四、这套素材还缺什么

游戏完整音效建议 7 层，目前有 3 类（引擎循环 / 引擎实录 / 轮胎尖叫），还缺：

| 缺的 | 建议怎么补 |
|---|---|
| 碰撞 / 撞击 | OpenGameArt《SuperTuxKart sound effects》整包 CC0，含 crash、countdown、beep、engine start |
| 风噪 | 可用白噪声 + lowpass 现场合成，不必下载 |
| 观众 / 起跑氛围 | Zapsplat、Pixabay 的 grand prix 现场录音 |
| UI 提示音 | 振荡器现场合成即可（60 行代码搞定） |

### 本次没下载成功的（站点限制，非链接失效）

| 站点 | 原因 |
|---|---|
| Zapsplat（CC0 的 formula-one 标签） | 必须注册登录才能下 WAV |
| Pixabay（`grandprix` / `formula-ford`） | 直链为带签名的动态地址，且有机器人验证，脚本抓不到 |
| Freesound | 下载原文件需登录 |
| noisefx.net / sfxengine.com / deadsounds.com | 可免费下，但**未写明许可条款**，不建议正式发布版使用 |

需要时手动打开上面链接点 "Free download" 即可，下载后放进本目录。

---

## 五、常用处理命令（本机已装 ffmpeg）

```bash
# 转成 mp3（兼容 Safari 等不吃 ogg 的浏览器）
ffmpeg -i xxx.ogg -c:a libmp3lame -b:a 192k xxx.mp3

# 统一 44.1k / 单声道 / 16bit
ffmpeg -i in.wav -ar 44100 -ac 1 -c:a pcm_s16le out.wav

# 响度归一（所有音效听感一致）
ffmpeg -i in.ogg -af loudnorm=I=-16:TP=-1.5:LRA=11 -c:a libvorbis -q:a 6 out.ogg

# 批量转 mp3
for f in *.ogg; do ffmpeg -y -i "$f" -c:a libmp3lame -b:a 192k "${f%.ogg}.mp3"; done
```

---

## 六、状态

- [x] 素材已下载到 `game_car/music/`
- [x] 文件完整性已校验（WAV `RIFF` 头 / OGG `OggS` 头，ffprobe 可正常解析）
- [ ] **尚未接入 `index.html`** —— 需要 `AudioContext` + 上面第三节的引擎层代码
