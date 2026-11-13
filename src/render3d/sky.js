// 纯程序化零资源物理天空穹顶与动态太阳系统（参考 Saltline 高阶大气与体积云光照模型）
// 核心包含：方位角水平向日插值、4级高次幂 Mie 漫射晕圈、自阴影浮雕立体云盖、HDR 物理太阳日轮与地平线消融雾
import * as THREE from "three";

// 生成 256x256 程序化高质量无缝随机噪声数据贴图（零外部图片资产依赖）
function createProceduralNoiseTexture() {
  const data = new Uint8Array(256 * 256 * 4);
  let t = 2654435769;
  const rng = () => {
    t ^= t << 13; t >>>= 0;
    t ^= t >>> 17;
    t ^= t << 5; t >>>= 0;
    return (t >>> 0) / 4294967296;
  };
  for (let i = 0; i < 256 * 256; i++) {
    data[i * 4] = Math.floor(rng() * 256);
    data[i * 4 + 1] = Math.floor(rng() * 256);
    data[i * 4 + 2] = Math.floor(rng() * 256);
    data[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, 256, 256, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

const VERTEX_SHADER = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  precision highp float;
  varying vec3 vDir;

  uniform sampler2D tNoise;
  uniform vec3 uSunDir;
  uniform vec3 uSunCol;
  uniform vec3 uZen;
  uniform vec3 uHor;
  uniform vec3 uHorAway;
  uniform vec3 uGround;
  uniform float uTime;
  uniform float uCloudCover;

  // 硬件加速双线性纹理采样 FBM 噪声函数（性能极高，平滑自然）
  float n2(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return texture2D(tNoise, (i + f + 0.5) / 256.0).r;
  }

  float fbm5(vec2 p) {
    float a = 0.5, s = 0.0;
    mat2 rot = mat2(1.6, 1.2, -1.2, 1.6);
    for (int i = 0; i < 5; i++) {
      s += a * n2(p);
      p = rot * p + 17.3;
      a *= 0.5;
    }
    return s / 0.96875;
  }

  float fbm3(vec2 p) {
    float a = 0.5, s = 0.0;
    mat2 rot = mat2(1.6, 1.2, -1.2, 1.6);
    for (int i = 0; i < 3; i++) {
      s += a * n2(p);
      p = rot * p + 17.3;
      a *= 0.5;
    }
    return s / 0.875;
  }

  // 计算当前视线与太阳水平投影的迎角（0 背日 .. 1 正对太阳）
  float skyToSun(vec3 d) {
    return clamp(dot(normalize(d.xz + vec2(1e-5)), normalize(uSunDir.xz)) * 0.5 + 0.5, 0.0, 1.0);
  }

  // 地平线大气色谱（向日侧柔和自然暖霞，消灭地平线上的多余第二日轮）
  vec3 calcHorizonColor(vec3 d) {
    float ts = skyToSun(d);
    vec3 c = mix(uHorAway, uHor * 1.10, pow(ts, 2.5));
    return c;
  }

  void main() {
    vec3 d = normalize(vDir);
    float h = max(d.y, 0.0);
    float mu = dot(d, uSunDir);
    float s = max(mu, 0.0);
    float ts = skyToSun(d);

    // 1. 基础晴空瑞利大气散射渐变
    vec3 hc = calcHorizonColor(d);
    vec3 midSky = mix(uHorAway * 0.85 + vec3(0.08, 0.12, 0.18), vec3(0.68, 0.56, 0.44), pow(ts, 3.0));
    vec3 clearSky = mix(hc, midSky, smoothstep(0.0, 0.18, h));
    clearSky = mix(clearSky, uZen, smoothstep(0.10, 0.65, h));

    // 2. 真实四级高次幂太阳漫射光晕（Aureole / Mie Glow）
    clearSky += uSunCol * (
      pow(s, 6.0) * 0.22 +
      pow(s, 48.0) * 0.65 +
      pow(s, 400.0) * 2.8 +
      pow(s, 4000.0) * 16.0
    );

    // 3. 真实大奖赛高空物理卷积云系统
    // 弯曲天穹投射：平滑将视线矢量投影到高空云层高度（消除地平线严重拉伸走样）
    float opticalDepth = 1.0 / (sqrt(h * h + 0.042) + h * 0.38);
    vec2 cuv = d.xz * opticalDepth * vec2(0.18, 0.24);
    vec2 wind = vec2(-0.007, 0.003) * uTime;
    vec2 q = cuv + wind;

    // 空间流体大尺度湍流扭曲
    vec2 warp = vec2(fbm3(q * 0.42 + vec2(1.2, 5.7)), fbm3(q * 0.42 + vec2(8.4, 2.1)));
    vec2 qq = q + (warp - 0.5) * 1.35;

    // 主积云密度场 (Cumulus Body)
    float dens = fbm5(qq);
    
    // 细微云絮脊线与羽化细节 (Wispy Ridges)
    float detail = 1.0 - abs(2.0 * fbm3(qq * 2.6 + 6.3) - 1.0);
    dens = dens * 0.82 + (detail - 0.5) * 0.18;

    // 高空轻盈卷云织物纤维 (High-Altitude Cirrus Veil)
    float cirrus = fbm3(cuv * vec2(1.2, 0.6) + wind * 1.8 + vec2(15.2, 7.6));
    float cirrusCov = smoothstep(0.48, 0.78, cirrus) * 0.32 * smoothstep(0.12, 0.50, h);

    // 宏观积云体裁切（根据 uCloudCover 控制云量）
    float macro = n2(q * 0.16 + 4.8);
    float cloudBody = dens * 0.70 + macro * 0.35;
    float cumulusCov = smoothstep(1.08 - uCloudCover * 0.95, 0.88, cloudBody);

    // 向地平线平滑消融（避免地平线突兀截断）
    float horizonFade = smoothstep(0.015, 0.22, h);
    cumulusCov *= horizonFade;

    // 太阳破口：太阳附近留有通透光洞，保证阳光照耀赛道
    float sunHole = smoothstep(0.975, 0.998, mu + (dens - 0.5) * 0.015);
    cumulusCov *= (1.0 - 0.90 * sunHole);

    // 总云量覆盖合成
    float totalCov = clamp(cumulusCov + cirrusCov * (1.0 - cumulusCov * 0.85), 0.0, 1.0);

    // 4. 云层物理真实受光：向阳立体自阴影与明亮洁白云体
    vec2 sunDir2D = normalize(uSunDir.xz + vec2(1e-5));
    float densTowardSun = fbm5(qq + sunDir2D * 0.22);
    float relief = clamp((dens - densTowardSun) * 3.8 + 0.5, 0.0, 1.0);
    float thickness = smoothstep(0.35, 0.75, cloudBody);

    // 洁白向日顶面（直射阳光高光）
    vec3 sunlit = uSunCol * vec3(1.35, 1.32, 1.28);

    // 云底柔和天青漫射阴影（物理真实的天空漫射光 + 地面微反弹，绝非脏黑烟尘）
    vec3 ambientSky = mix(uZen * 1.25 + vec3(0.24, 0.28, 0.34), vec3(0.85, 0.90, 0.96), 0.65);
    vec3 cloudShade = ambientSky * (0.78 + 0.28 * relief);

    // 迎日强向散射银边光晕 (Mie Forward Scatter / Silver Lining)
    float rim = cumulusCov * (1.0 - cumulusCov) * 4.0;
    float silverLining = pow(s, 5.0) * 1.8 + pow(s, 16.0) * 3.5;
    vec3 edgeGlow = uSunCol * rim * (0.45 + silverLining) * (0.6 + 0.4 * relief);

    // 云彩整体合成
    vec3 cloudCol = mix(cloudShade, sunlit, relief * 0.72 + 0.18) + edgeGlow;
    // 远距离云彩融入大气透视与地平线雾色
    cloudCol = mix(cloudCol, hc, exp(-h * 9.0) * 0.65);

    // 合成晴空与云层
    vec3 col = mix(clearSky, cloudCol, totalCov * 0.98);

    // 5. 真实 HDR 物理太阳日轮（105.0 高动态强度，配合 ACES 形成绝美耀斑）
    float veil = 1.0 - totalCov * 0.88;
    float sunDisk = smoothstep(0.99988, 0.99997, mu);
    col += uSunCol * sunDisk * 105.0 * veil;

    // 6. 地平线以下海雾与地貌环境反弹（消灭任何地平线接缝与黑块）
    if (d.y < 0.0) {
      float t = clamp(-d.y * 4.0, 0.0, 1.0);
      vec3 groundBounce = mix(uHorAway * 0.38, uGround, t);
      groundBounce += uHor * 0.45 * pow(ts, 5.0) * exp(d.y * 6.0);
      col = mix(hc + uSunCol * pow(s, 40.0) * 1.5, groundBounce, smoothstep(0.0, 1.0, t));
    }

    gl_FragColor = vec4(max(col, vec3(0.0)), 1.0);
  }
`;

export class ProceduralSkySystem {
  constructor(scene, options = {}) {
    this.scene = scene;
    this.renderer = options.renderer || null;
    this.elevationDeg = options.elevationDeg ?? 32; // 黄金时刻微倾阳光
    this.azimuthDeg = options.azimuthDeg ?? 48;     // 侧逆光角度
    this.cloudCover = options.cloudCover ?? 0.46;  // 立体云覆盖度

    this.sunDir = new THREE.Vector3();
    this.sunColor = new THREE.Color();
    this.zenithColor = new THREE.Color();
    this.horizonColor = new THREE.Color();
    this.horizonAwayColor = new THREE.Color();
    this.groundColor = new THREE.Color(0x1a2c1f);

    this.noiseTex = createProceduralNoiseTexture();

    const geo = new THREE.SphereGeometry(6800, 48, 24);
    this.uniforms = {
      tNoise: { value: this.noiseTex },
      uSunDir: { value: new THREE.Vector3() },
      uSunCol: { value: new THREE.Color() },
      uZen: { value: new THREE.Color() },
      uHor: { value: new THREE.Color() },
      uHorAway: { value: new THREE.Color() },
      uGround: { value: this.groundColor },
      uTime: { value: 0 },
      uCloudCover: { value: this.cloudCover },
    };

    const mat = new THREE.ShaderMaterial({
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      uniforms: this.uniforms,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    });

    this.dome = new THREE.Mesh(geo, mat);
    this.dome.renderOrder = -1000;
    this.scene.add(this.dome);

    // 太阳平行光（阴影相机覆盖整幅近景赛道）
    this.sunLight = new THREE.DirectionalLight(0xfff7ea, 3.2);
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.set(2048, 2048);
    this.sunLight.shadow.camera.left = -175;
    this.sunLight.shadow.camera.right = 175;
    this.sunLight.shadow.camera.top = 175;
    this.sunLight.shadow.camera.bottom = -175;
    this.sunLight.shadow.camera.near = 20;
    this.sunLight.shadow.camera.far = 880;
    this.sunLight.shadow.camera.updateProjectionMatrix();
    this.sunLight.shadow.bias = -0.00035;
    this.sunLight.shadow.normalBias = 0.022;
    this.sunLight.shadow.radius = 2.2;
    this.sunLight.shadow.intensity = 0.82;
    this.scene.add(this.sunLight);
    this.scene.add(this.sunLight.target);

    // 半球环境漫射光
    this.hemiLight = new THREE.HemisphereLight(0xd4e7f8, 0x223824, 1.15);
    this.scene.add(this.hemiLight);



    // 场景地平线浓雾：完全取自背日侧通透地平线散射，消除地平线切边
    this.fog = new THREE.Fog(0xb8d4e6, 2400, 7200);
    this.scene.fog = this.fog;

    this.updateSunMath();
    this.updateEnvironmentMap();
  }

  setCloudCover(v) {
    this.cloudCover = Math.max(0.05, Math.min(0.85, v));
    if (this.uniforms && this.uniforms.uCloudCover) {
      this.uniforms.uCloudCover.value = this.cloudCover;
    }
  }

  updateEnvironmentMap() {
    if (!this.renderer) return;
    try {
      const pmrem = new THREE.PMREMGenerator(this.renderer);
      const envScene = new THREE.Scene();
      const envDome = new THREE.Mesh(this.dome.geometry, this.dome.material);
      envScene.add(envDome);
      if (this.scene.environment && this.scene.environment.dispose) {
        this.scene.environment.dispose();
      }
      this.scene.environment = pmrem.fromScene(envScene, 0.04).texture;
      this.scene.environmentIntensity = 0.65;
      envScene.remove(envDome);
      pmrem.dispose();
    } catch (e) {
      console.warn("[sky] PMREM 烘焙环境贴图跳过:", e);
    }
  }

  setSunPosition(elevationDeg, azimuthDeg) {
    this.elevationDeg = elevationDeg;
    this.azimuthDeg = azimuthDeg;
    this.updateSunMath();
  }

  updateSunMath() {
    const elRad = THREE.MathUtils.degToRad(this.elevationDeg);
    const azRad = THREE.MathUtils.degToRad(this.azimuthDeg);

    this.sunDir.set(
      Math.cos(elRad) * Math.sin(azRad),
      Math.sin(elRad),
      Math.cos(elRad) * Math.cos(azRad)
    ).normalize();

    // 依据高度角计算物理色温
    if (this.elevationDeg < 14) {
      // 黄昏金红日落时分
      const t = Math.max(0, this.elevationDeg) / 14;
      this.zenithColor.setRGB(0.12 + t * 0.04, 0.22 + t * 0.16, 0.48 + t * 0.28);
      this.horizonColor.setRGB(1.0, 0.58 + t * 0.22, 0.32 + t * 0.45);
      this.horizonAwayColor.setRGB(0.68 + t * 0.12, 0.74 + t * 0.12, 0.84 + t * 0.10);
      this.sunColor.setRGB(1.0, 0.62 + t * 0.32, 0.30 + t * 0.62);
      this.sunLight.intensity = 2.2 + t * 1.0;
    } else {
      // 晴空明澈白昼
      const t = Math.min(1, (this.elevationDeg - 14) / 46);
      this.zenithColor.setRGB(0.14 - t * 0.04, 0.36 + t * 0.06, 0.74 + t * 0.08); // 纯正大气蔚蓝
      this.horizonColor.setRGB(0.96 - t * 0.14, 0.88 - t * 0.03, 0.80 + t * 0.14); // 暖日晕地平线
      this.horizonAwayColor.setRGB(0.72 + t * 0.05, 0.83 + t * 0.05, 0.91 + t * 0.04); // 清透天青色
      this.sunColor.setRGB(1.0, 0.96, 0.92);
      this.sunLight.intensity = 3.2 + t * 0.3;
    }

    this.uniforms.uSunDir.value.copy(this.sunDir);
    this.uniforms.uSunCol.value.copy(this.sunColor);
    this.uniforms.uZen.value.copy(this.zenithColor);
    this.uniforms.uHor.value.copy(this.horizonColor);
    this.uniforms.uHorAway.value.copy(this.horizonAwayColor);
    this.uniforms.uGround.value.copy(this.groundColor);

    this.sunLight.color.copy(this.sunColor);
    // 大气整体向下散射的漫射天光为清朗的天青白，而不是深蓝黑
    if (this.elevationDeg < 14) {
      this.hemiLight.color.setRGB(0.92, 0.65, 0.50);
      this.hemiLight.groundColor.setRGB(0.24, 0.18, 0.15);
      
    } else {
      this.hemiLight.color.setRGB(0.82, 0.90, 0.98);
      this.hemiLight.groundColor.setRGB(0.24, 0.28, 0.22);
      
    }
    this.fog.color.copy(this.horizonAwayColor);
  }

  update(dt, cameraPos) {
    this.uniforms.uTime.value += dt || 0.016;
    if (cameraPos) {
      this.dome.position.set(cameraPos.x, 0, cameraPos.z);
    }
  }

  getHorizonColor() {
    return this.horizonAwayColor;
  }

  getSunDirection() {
    return this.sunDir;
  }

  dispose() {
    this.scene.remove(this.dome);
    this.scene.remove(this.sunLight);
    this.scene.remove(this.sunLight.target);
    this.scene.remove(this.hemiLight);
    
    this.dome.geometry.dispose();
    this.dome.material.dispose();
    this.noiseTex.dispose();
  }
}
