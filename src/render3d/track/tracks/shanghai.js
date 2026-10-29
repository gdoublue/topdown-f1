// 上海国际赛车场 —— 3D 场景个性化配置与装饰钩子（每赛道一文件，便于单独维护调整）
// 几何剖面参数（hills/bankK/bankMax）在 src/track/tracks/shanghai.js 里；
// 立交桥位由 geometry.js 交叉检测自动生成（桥墩在 props.buildBridgePiers）。
// decorate(ctx)：共享景物布置完后调用；ctx 含 { THREE, group, opts, pts, N, nor, tan, hw,
//   kerbFlag, cumDist, curvS, isLinear, LAP_LENGTH, h, bank, bridges, roadElev, roadAt,
//   indexAtDistance, groundAt, sampleIndices, ribbonGeometry, quadSegmentsGeometry, hash01 }。
export default {
  id: "shanghai",
  options: {
    // 上字形布局：螺线弯 (T1-T4) 与 1.17km 大直道，按默认风格呈现

  },
  decorate(ctx) {
    // 需要赛道专属装饰时往 ctx.group 添加网格；ctx.roadElev(i, off) 可取路面高度

  },
};
