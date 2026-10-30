// 蒙扎国家赛车场 —— 3D 场景个性化配置与装饰钩子（每赛道一文件，便于单独维护调整）
// 几何剖面参数（hills/bankK/bankMax）在 src/track/tracks/monza.js 里；
// 立交桥位由 geometry.js 交叉检测自动生成（桥墩在 props.buildBridgePiers）。
// decorate(ctx)：共享景物布置完后调用；ctx 含 { THREE, group, opts, pts, N, nor, tan, hw,
//   kerbFlag, cumDist, curvS, isLinear, LAP_LENGTH, h, bank, bridges, roadElev, roadAt,
//   indexAtDistance, groundAt, sampleIndices, ribbonGeometry, quadSegmentsGeometry, hash01 }。
export default {
  id: "monza",
  options: {
    treeDensity: 0.8,   // 皇家公园：开阔疏林
    cloudCount: 8,

  },
  decorate(ctx) {
    // 历史性高速赛道，保持简洁

  },
};
