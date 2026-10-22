import fs from "node:fs";

let s = fs.readFileSync("userscripts/1022_pm.js", "utf8");

function rep(anchor, add, before = false) {
  if (!s.includes(anchor)) throw new Error("anchor missing: " + anchor.slice(0, 60));
  s = s.replace(anchor, before ? add + anchor : anchor + add);
}

rep("    const st = car._toState;", `
    if (!st.pb || st.pb.M !== M_N) {
      const M = M_N;
      st.pb = { M, n: 0,
        al: new Float64Array(M), lat: new Float64Array(M), cnt: new Int32Array(M),
        b2: new Int32Array(M), b1: new Int32Array(M), off: new Int32Array(M),
        edge: new Int32Array(M), cap: new Int32Array(M), sat: new Int32Array(M) };
    }`);

rep("    let brakeCmd = 0;", `
    const pb0 = st.pb;
    pb0.cnt[idx]++;
    pb0.al[idx] += Math.abs(alpha);
    pb0.lat[idx] += Math.abs(carLatNow - model.off[idx]);
    if (offLineDist > 0.95) pb0.off[idx]++;
    if (edgeExcess > 0) pb0.edge[idx]++;
    if (trackErr > 2.8) pb0.cap[idx]++;
`, true);

rep("    const heavyTh = Math.max(", `
    if (aReq > lightA * 1.02) st.pb.b2[idx]++;
`, true);

rep("    out.steer = Number.isFinite(steer) ? steer : 0;", `
    const pb = st.pb; pb.n++;
    if (brakeCmd === 1) pb.b1[idx]++;
    if (pb.n % 700 === 0) {
      const SEC = 12, per = Math.ceil(M_N / SEC), rows = [];
      for (let q = 0; q < SEC; q++) {
        let n = 0, al = 0, lat = 0, b2 = 0, b1 = 0, off = 0, edge = 0, cap = 0, sat = 0;
        for (let i = q * per; i < Math.min(M_N, (q + 1) * per); i++) {
          n += pb.cnt[i]; al += pb.al[i]; lat += pb.lat[i];
          b2 += pb.b2[i]; b1 += pb.b1[i]; off += pb.off[i]; edge += pb.edge[i]; cap += pb.cap[i]; sat += pb.sat[i];
        }
        const k = Math.max(1, n);
        rows.push("q" + q + " al=" + (al / k * 57.3).toFixed(1) + "deg lat=" + (lat / k).toFixed(2)
          + " b2=" + (b2 / k * 100).toFixed(0) + "% b1=" + (b1 / k * 100).toFixed(0) + "%"
          + " off=" + (off / k * 100).toFixed(0) + "% edge=" + (edge / k * 100).toFixed(0) + "%"
          + " cap=" + (cap / k * 100).toFixed(0) + "% sat=" + (sat / k * 100).toFixed(0) + "%");
      }
      console.log("[probe] n=" + pb.n + "\\n  " + rows.join("\\n  "));
    }
`, true);

fs.writeFileSync("tmp-probe.js", s);
console.log("probe written");
