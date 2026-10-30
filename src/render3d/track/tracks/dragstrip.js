// 琼海直线竞速测试场 —— 3D 场景个性化配置与装饰钩子（每赛道一文件，便于单独维护调整）
// 几何剖面参数（hills/bankK/bankMax）在 src/track/tracks/dragstrip.js 里；
// 立交桥位由 geometry.js 交叉检测自动生成（桥墩在 props.buildBridgePiers）。
// decorate(ctx)：共享景物布置完后调用；ctx 含 { THREE, group, opts, pts, N, nor, tan, hw,
//   kerbFlag, cumDist, curvS, isLinear, LAP_LENGTH, h, bank, bridges, roadElev, roadAt,
//   indexAtDistance, groundAt, sampleIndices, ribbonGeometry, quadSegmentsGeometry, hash01 }。
export default {
  id: "dragstrip",
  options: {
    treeDensity: 0.5,   // 冲刺道：开阔平直
    cloudCount: 6,

  },
  decorate(ctx) {
    // linear 赛道：路牙全程铺设由 kerbFlag/props 处理；无桥无横坡

  },
};
