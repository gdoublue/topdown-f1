// 云栖体育场环道 —— 3D 场景个性化配置与装饰钩子（每赛道一文件，便于单独维护调整）
// 几何剖面参数（hills/bankK/bankMax）在 src/track/tracks/stadiumring.js 里；
// 立交桥位由 geometry.js 交叉检测自动生成（桥墩在 props.buildBridgePiers）。
// decorate(ctx)：共享景物布置完后调用；ctx 含 { THREE, group, opts, pts, N, nor, tan, hw,
//   kerbFlag, cumDist, curvS, isLinear, LAP_LENGTH, h, bank, bridges, roadElev, roadAt,
//   indexAtDistance, groundAt, sampleIndices, ribbonGeometry, quadSegmentsGeometry, hash01 }。
export default {
  id: "stadiumring",
  options: {
    treeDensity: 1.0,
    cloudCount: 7,

  },
  decorate(ctx) {
    // 11.5° banking 弯道（src/track/tracks/stadiumring.js bankK=60/bankMax=0.20）：如需加护墙/大屏在此装饰

  },
};
