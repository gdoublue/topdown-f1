// 斯帕-弗朗科尔尚 —— 3D 场景个性化配置与装饰钩子（每赛道一文件，便于单独维护调整）
// 几何剖面参数（hills/bankK/bankMax）在 src/track/tracks/spa.js 里；
// 斯帕使用 OSM 真实赛道几何 + EU-DEM 真实海拔剖面（见 src/track/spaData.js）：
// 单圈 7004m、落差 102m（Les Combes 最高、Paul Frère 最低），地面跟随真实地形。
// 立交桥位由 geometry.js 交叉检测自动生成（桥墩在 props.buildBridgePiers）。
// decorate(ctx)：共享景物布置完后调用；ctx 含 { THREE, group, opts, pts, h, bank, bridges,
//   roadElev, roadAt, indexAtDistance, isLinear, LAP_LENGTH, groundAt, terrainAt }。
import { pts, N, nor } from "../../../track/geometry.js";
import { hash01 } from "../shared.js";

// 阿登森林：远近两层针叶林带（InstancedMesh，两个 draw call）
function buildForest(THREE, groundAt, offsetMin, offsetSpan, count, hMin, hSpan, colorShift) {
  const foliage = new THREE.InstancedMesh(
    new THREE.ConeGeometry(1, 1, 6),
    new THREE.MeshLambertMaterial({ color: 0xffffff }),
    count
  );
  const trunks = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.24, 0.32, 1, 5),
    new THREE.MeshLambertMaterial({ color: 0x5a3d26 }),
    count
  );
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const greens = offsetMin < 100
    ? [new THREE.Color(0x24502c), new THREE.Color(0x2f6234), new THREE.Color(0x1e4226), new THREE.Color(0x396b38)]
    : [new THREE.Color(0x1d3f26), new THREE.Color(0x264b2b), new THREE.Color(0x18351f), new THREE.Color(0x2f5730)];
  let k = 0;
  for (let i = 0; i < N && k < count; i += 2) {
    for (const side of [1, -1]) {
      if (k >= count) break;
      const r = hash01(i, side * 13);
      if (r > 0.70) continue;                       // 留出林间空地
      const off = (offsetMin + hash01(i, side * 17) * offsetSpan) * side;
      const jx = (hash01(i, side * 19) - 0.5) * 26;
      const jz = (hash01(i, side * 23) - 0.5) * 26;
      const x = pts[i].x + nor[i].x * off + jx;
      const z = pts[i].y + nor[i].y * off + jz;
      // 距任意路段 ≥18m：避免另一条弯道的路基穿过树冠
      let ok = true;
      for (let j = 0; j < N; j += 4) {
        const dx = pts[j].x - x, dz = pts[j].y - z;
        if (dx * dx + dz * dz < 324) { ok = false; break; }
      }
      if (!ok) continue;
      const gY = groundAt(x, z);
      const th = hMin + hash01(i, side * 29) * hSpan;
      const tw = th * (0.28 + r * 0.12);
      const trunkH = th * 0.2;
      q.setFromAxisAngle(up, r * Math.PI * 2);
      m.compose(new THREE.Vector3(x, gY + trunkH + th / 2, z), q, s.set(tw, th, tw));
      foliage.setMatrixAt(k, m);
      foliage.setColorAt(k, greens[(Math.floor(r * 4) + colorShift) % 4]);
      m.compose(new THREE.Vector3(x, gY + trunkH / 2, z), q, s.set(1, trunkH, 1));
      trunks.setMatrixAt(k, m);
      k++;
    }
  }
  foliage.count = k;
  trunks.count = k;
  foliage.instanceMatrix.needsUpdate = true;
  trunks.instanceMatrix.needsUpdate = true;
  if (foliage.instanceColor) foliage.instanceColor.needsUpdate = true;
  foliage.castShadow = trunks.castShadow = true;
  foliage.frustumCulled = trunks.frustumCulled = false;
  const g = new THREE.Group();
  g.add(foliage, trunks);
  return g;
}

export default {
  id: "spa",
  options: {
    treeDensity: 6,     // 阿登森林：近路密林
    treeCap: 1000,
    cloudCount: 12,
    boardPalette: [0xd0342c, 0xf2f3f5, 0xf0b429, 0x1d9d74, 0x2f6db3],
  },
  decorate(ctx) {
    if (!ctx || !ctx.THREE) return;
    const { THREE, group, groundAt } = ctx;
    if (!groundAt) return;
    // 近层：60~220m 的林带（补齐共享层只覆盖 62m 以内的树）
    group.add(buildForest(THREE, groundAt, 60, 160, 620, 7, 9, 0));
    // 远层：220~520m 的深色山林，撑起阿登丘陵的天际线
    group.add(buildForest(THREE, groundAt, 220, 300, 420, 10, 12, 2));
  },
};
