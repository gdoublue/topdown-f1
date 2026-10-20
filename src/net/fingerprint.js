// 客户端指纹：canvas 渲染 + 硬件/环境特征加权哈希
// 注意：指纹会随浏览器升级漂移，服务端以指纹哈希为玩家身份键
export function getFingerprint() {
  const parts = [];
  try {
    parts.push(navigator.userAgent || "");
    parts.push(navigator.language || "");
    parts.push((navigator.languages || []).join(","));
    parts.push(navigator.platform || "");
    parts.push(String(navigator.hardwareConcurrency || 0));
    parts.push(`${screen.width}x${screen.height}x${screen.colorDepth}`);
    parts.push(String(window.devicePixelRatio || 1));
    parts.push(Intl.DateTimeFormat().resolvedOptions().timeZone || "");
  } catch { /* 环境信息拿不全就用 canvas 部分 */ }

  let canvasSig = "";
  try {
    const c = document.createElement("canvas");
    c.width = 200; c.height = 40;
    const g = c.getContext("2d");
    g.textBaseline = "top";
    g.font = "16px 'Arial'";
    g.fillStyle = "#f60";
    g.fillRect(0, 0, 100, 20);
    g.fillStyle = "#069";
    g.fillText("F1-GP-fp-\u5370\u00e9\u263a", 2, 2);
    g.fillStyle = "rgba(102,204,0,0.7)";
    g.fillText("F1-GP-fp-\u5370\u00e9\u263a", 4, 8);
    canvasSig = c.toDataURL().slice(-256);
  } catch { /* 无 canvas 环境 */ }

  return fnv1a(parts.join("|")) + "-" + fnv1a(canvasSig);
}

// FNV-1a 32 位哈希
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
