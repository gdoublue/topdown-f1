// 上海国际赛车场 —— 3D 场景个性化配置与装饰钩子（每赛道一文件，便于单独维护调整）
// 几何剖面参数（hills/bankK/bankMax）在 src/track/tracks/shanghai.js 里；
// 立交桥位由 geometry.js 交叉检测自动生成（桥墩在 props.buildBridgePiers）。
// decorate(ctx)：共享景物布置完后调用；ctx 含 { THREE, group, opts, pts, N, nor, tan, hw,
//   kerbFlag, cumDist, curvS, isLinear, LAP_LENGTH, h, bank, bridges, roadElev, roadAt,
//   indexAtDistance, groundAt, sampleIndices, ribbonGeometry, quadSegmentsGeometry, hash01 }。

function makeBrakeMarkerTexture(THREE, label) {
  const cv = document.createElement("canvas");
  cv.width = 128; cv.height = 64;
  const c = cv.getContext("2d");
  c.fillStyle = "#14171d";
  c.fillRect(0, 0, 128, 64);
  c.strokeStyle = "#f2f4f7";
  c.lineWidth = 4;
  c.strokeRect(3, 3, 122, 58);
  c.fillStyle = "#ffffff";
  c.font = "bold 36px system-ui, -apple-system, sans-serif";
  c.textAlign = "center";
  c.textBaseline = "middle";
  c.fillText(label, 64, 34);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/* 上海国际赛车场标志性主看台“双翼”空中新闻中心与贵宾连桥（横跨发车大直道） */
function buildShanghaiSkyBridge(THREE, pts, nor, tan, hw, roadElev, indexAtDistance, sPos, isTwinWing = true) {
  const i = indexAtDistance(sPos);
  const p = pts[i], n = nor[i], t = tan[i];
  const baseElev = roadElev(i, 0);
  const span = hw[i] + 13.5;

  const bridge = new THREE.Group();
  const redMat = new THREE.MeshStandardMaterial({ color: 0xb81d24, roughness: 0.45, metalness: 0.25 });
  const silverMat = new THREE.MeshStandardMaterial({ color: 0xe6eaef, roughness: 0.35, metalness: 0.45 });
  const darkMetal = new THREE.MeshStandardMaterial({ color: 0x2a303c, roughness: 0.5, metalness: 0.5 });
  const glassMat = new THREE.MeshStandardMaterial({ color: 0x1e3a5f, roughness: 0.18, metalness: 0.75 });

  // 两侧中国红巨型圆筒承重塔柱
  for (const side of [1, -1]) {
    const tower = new THREE.Mesh(new THREE.CylinderGeometry(1.65, 1.85, 16.5, 14), redMat);
    tower.position.set(side * span, 7.2, 0);
    tower.castShadow = true;
    tower.receiveShadow = true;
    bridge.add(tower);

    const cap = new THREE.Mesh(new THREE.CylinderGeometry(2.1, 1.9, 1.2, 14), silverMat);
    cap.position.set(side * span, 15.6, 0);
    bridge.add(cap);
  }

  // 横跨赛道的流线型梭形主桥舱 + 蓝色玻璃幕墙窗带
  const deckW = span * 2 + 5.0;
  const deckDepth = isTwinWing ? 8.6 : 4.8;
  const deck = new THREE.Mesh(new THREE.BoxGeometry(deckW, 2.6, deckDepth), silverMat);
  deck.position.set(0, 12.2, 0);
  deck.castShadow = true;
  deck.receiveShadow = true;
  bridge.add(deck);

  const glass = new THREE.Mesh(new THREE.BoxGeometry(deckW - 3.0, 1.45, deckDepth + 0.16), glassMat);
  glass.position.set(0, 12.25, 0);
  bridge.add(glass);

  // 顶部飞翼形遮阳挑檐（双翼造型）
  if (isTwinWing) {
    const wing = new THREE.Mesh(new THREE.BoxGeometry(deckW + 6.0, 0.45, deckDepth + 3.8), silverMat);
    wing.position.set(0, 14.3, 0);
    wing.castShadow = true;
    bridge.add(wing);

    const redTrim = new THREE.Mesh(new THREE.BoxGeometry(deckW + 4.0, 0.32, 0.9), redMat);
    redTrim.position.set(0, 10.75, deckDepth * 0.5 + 0.1);
    bridge.add(redTrim);
    const redTrimBack = redTrim.clone();
    redTrimBack.position.z = -deckDepth * 0.5 - 0.1;
    bridge.add(redTrimBack);
  } else {
    // 1.17km 后直道横跨广告天桥
    const banner = new THREE.Mesh(new THREE.BoxGeometry(deckW - 4.0, 1.6, deckDepth + 0.25), redMat);
    banner.position.set(0, 12.2, 0);
    bridge.add(banner);
  }

  // 底部钢结构桁架托梁
  const truss = new THREE.Mesh(new THREE.BoxGeometry(deckW - 2.0, 0.75, deckDepth * 0.7), darkMetal);
  truss.position.set(0, 10.5, 0);
  bridge.add(truss);

  bridge.position.set(p.x, baseElev, p.y);
  bridge.rotation.y = Math.atan2(-n.y, n.x); // 局部 +x 对齐赛道法向横跨路面
  return bridge;
}

/* 上海国际赛车场特色荷叶形索膜结构看台伞顶（副看台区景观） */
function buildLotusCanopies(THREE, pts, nor, hw, groundAt, indexAtDistance) {
  const group = new THREE.Group();
  const canopyMat = new THREE.MeshStandardMaterial({
    color: 0xf4f6fa, roughness: 0.55, metalness: 0.08, side: THREE.DoubleSide,
  });
  const mastMat = new THREE.MeshStandardMaterial({ color: 0xc8cdd6, roughness: 0.4, metalness: 0.5 });
  const coneGeo = new THREE.ConeGeometry(8.5, 3.2, 9, 1, true);
  const mastGeo = new THREE.CylinderGeometry(0.28, 0.36, 9.5, 8);

  // 分布在 T1-T2 螺线弯外侧看台坡面与后直道末端看台区
  const sList = [530, 575, 620, 665, 710, 4730, 4775, 4820];
  for (let k = 0; k < sList.length; k++) {
    const i = indexAtDistance(sList[k]);
    const side = -1; // 弯道外侧
    const off = hw[i] + 24 + (k % 2) * 6;
    const x = pts[i].x + nor[i].x * side * off;
    const z = pts[i].y + nor[i].y * side * off;
    const gY = groundAt ? groundAt(x, z) : 0;

    const unit = new THREE.Group();
    const mast = new THREE.Mesh(mastGeo, mastMat);
    mast.position.y = 4.75;
    mast.castShadow = true;

    const roof = new THREE.Mesh(coneGeo, canopyMat);
    roof.position.y = 9.2;
    roof.rotation.z = 0.12;
    roof.scale.set(1.15, -1, 0.88); // 倒置碗状荷叶膜伞
    roof.castShadow = true;

    unit.add(mast, roof);
    unit.position.set(x, gY, z);
    unit.rotation.y = k * 0.7;
    group.add(unit);
  }
  return group;
}

/* 弯道外侧 F1 铺装缓冲区彩绘带（T1-T4 螺线弯、T7-T10 连续 S 弯、T14 重刹发夹弯） */
function buildRunoffAprons(THREE, pts, nor, N, hw, kerbFlag, curvS, cumDist, quadSegmentsGeometry, groundAt) {
  const group = new THREE.Group();
  const CRIMSON = new THREE.Color("#b32025");
  const BLUE = new THREE.Color("#1d4e89");
  const SLATE = new THREE.Color("#363b45");
  const colorAt = (i) => {
    const stripe = Math.floor((cumDist[i] ?? 0) / 6.0) % 3;
    const c = stripe === 0 ? CRIMSON : (stripe === 1 ? BLUE : SLATE);
    return [c.r, c.g, c.b];
  };
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.82,
    metalness: 0.0,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });

  for (const side of [1, -1]) {
    const segPairs = [];
    for (let i = 0; i < N; i++) {
      if (kerbFlag[i] !== 1) continue;
      // 仅在弯道外侧（side 与 -curvS 同号）铺设宽阔的彩绘沥青缓冲区
      if (side * curvS[i] > -0.002) continue;
      const next = (i + 1) % N;
      segPairs.push([i, next]);
    }
    if (!segPairs.length) continue;
    const geo = quadSegmentsGeometry(
      segPairs,
      i => side * (hw[i] + 5.2),
      i => side * (hw[i] + 1.55),
      0.052,
      colorAt,
      12
    );
    // 外沿（u=0，每个段 4 顶点的第 0、2 号顶点）平滑斜接至草坪地面高度，消除缓冲区外边缘悬空台阶
    if (groundAt) {
      const pos = geo.attributes.position;
      for (let s = 0; s < segPairs.length; s++) {
        const base = s * 4;
        for (const vi of [base, base + 2]) {
          const vx = pos.getX(vi), vz = pos.getZ(vi);
          pos.setY(vi, Math.min(pos.getY(vi), groundAt(vx, vz) + 0.04));
        }
      }
      geo.computeVertexNormals();
    }
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  return group;
}

/* 重刹区 150m / 100m / 50m 刹车距离提示牌（T1、T6、T11、T14 1.17km 大直道末端、T16） */
function buildBrakeMarkers(THREE, pts, nor, tan, hw, roadElev, indexAtDistance) {
  const group = new THREE.Group();
  const labels = ["150", "100", "50"];
  const mats = labels.map(l => new THREE.MeshStandardMaterial({
    map: makeBrakeMarkerTexture(THREE, l),
    roughness: 0.6,
    metalness: 0.05,
  }));
  const postMat = new THREE.MeshStandardMaterial({ color: 0x30343d, roughness: 0.7 });
  const boardGeo = new THREE.BoxGeometry(0.10, 0.85, 1.55);
  const postGeo = new THREE.CylinderGeometry(0.05, 0.05, 1.1, 6);

  // 各重刹弯道前的 150m / 100m / 50m 里程与外侧方向
  const zones = [
    { s50: 440, side: -1 },   // T1 螺线弯入弯重刹
    { s50: 1515, side: -1 },  // T6 发夹弯重刹
    { s50: 3065, side: 1 },   // T11 弯前重刹
    { s50: 4685, side: -1 },  // T14 1.17km 大直道尾速重刹区
    { s50: 5095, side: 1 },   // T16 进主直道前刹车区
  ];

  for (const z of zones) {
    for (let k = 0; k < 3; k++) {
      const s = z.s50 - (2 - k) * 50;
      const i = indexAtDistance(s);
      const p = pts[i], n = nor[i], t = tan[i];
      const off = hw[i] + 3.1;
      const wx = p.x + n.x * z.side * off;
      const wz = p.y + n.y * z.side * off;
      const wy = roadElev(i, z.side * off);

      const item = new THREE.Group();
      const board = new THREE.Mesh(boardGeo, mats[k]);
      board.position.y = 0.92;
      board.castShadow = true;
      const post = new THREE.Mesh(postGeo, postMat);
      post.position.y = 0.48;
      item.add(board, post);

      item.position.set(wx, wy, wz);
      // 牌面朝向迎面驶来的赛车（法向沿着赛道切线）
      item.rotation.y = -Math.atan2(t.y, t.x);
      group.add(item);
    }
  }
  return group;
}

export default {
  id: "shanghai",
  options: {
    // 上字形布局：螺线弯 (T1-T4) 与 1.17km 大直道，定制中国红/蓝/金/白赛事广告牌配色
    treeDensity: 1.25,
    cloudCount: 10,
    boardPalette: [0xc81d25, 0xf4f5f7, 0x1d4e89, 0xeeb932, 0x168065],
  },
  decorate(ctx) {
    if (!ctx || !ctx.THREE) return;
    const {
      THREE, group, pts, N, nor, tan, hw, kerbFlag, cumDist, curvS,
      roadElev, indexAtDistance, groundAt, quadSegmentsGeometry,
    } = ctx;

    // 1. 主看台双翼空中新闻中心与贵宾天桥（发车大直道 s=115m 与 s=265m）+ 后直道天桥 (s=4180m)
    group.add(buildShanghaiSkyBridge(THREE, pts, nor, tan, hw, roadElev, indexAtDistance, 115, true));
    group.add(buildShanghaiSkyBridge(THREE, pts, nor, tan, hw, roadElev, indexAtDistance, 265, true));
    group.add(buildShanghaiSkyBridge(THREE, pts, nor, tan, hw, roadElev, indexAtDistance, 4180, false));

    // 2. 弯道外侧上海大奖赛彩绘铺装缓冲区（T1-T4 螺线弯、T7-T10、T14 等）
    if (quadSegmentsGeometry && kerbFlag && curvS) {
      group.add(buildRunoffAprons(THREE, pts, nor, N, hw, kerbFlag, curvS, cumDist, quadSegmentsGeometry, groundAt));
    }

    // 3. 重刹区 150m / 100m / 50m 距离提示牌
    group.add(buildBrakeMarkers(THREE, pts, nor, tan, hw, roadElev, indexAtDistance));

    // 4. 标志性荷叶形索膜结构看台顶棚
    group.add(buildLotusCanopies(THREE, pts, nor, hw, groundAt, indexAtDistance));
  },
};
