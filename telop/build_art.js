// 固定画ビルダー: geojson.js + tzones.js から最終座標 (viewBox 640x510) に
// 焼き込んだ tsunami-art.js を生成する。実行: node build_art.js
// 構造: 本土 = 既存プロジェクタ + アフィン warp (実フレーム fit 済み)。
// 列島 = 単一の相似配置 (2アンカーで決定)。小笠原 = ブラケット内への単一配置。
// 島の拡大は「島グループ」単位で陸地と区域線が同じ中心を共有する (ずれ防止)。
const fs = require("fs");
const path = require("path");
const D = __dirname;

// ---- 入力データ ----
const sandbox = { window: {} };
const geoSrc = fs.readFileSync(path.join(D, "geojson.js"), "utf8");
const tzSrc = fs.readFileSync(path.join(D, "tzones.js"), "utf8");
new Function("window", geoSrc + "\n" + tzSrc + "\nwindow.__PREF = (typeof PREF_GEOJSON !== 'undefined') ? PREF_GEOJSON : window.PREF_GEOJSON;")(sandbox.window);
// geojson.js は const PREF_GEOJSON を定義する。window 経由で取るため再評価する
const PREF = (() => { const w = {}; new Function("window", geoSrc.replace("const PREF_GEOJSON", "window.PREF_GEOJSON"))(w); return w.PREF_GEOJSON; })();
const TZONES = (() => { const w = {}; new Function("window", tzSrc)(w); return w.TZONES; })();

// ---- 本土プロジェクタ + warp (現行踏襲) ----
const MAIN = { x: 165, y: 20, w: 370, h: 395, lonMin: 128.6, lonMax: 146.6, latMin: 30.6, latMax: 45.9 };
const AFFINE = [1.3445, -0.0203, -182.379, 0.0732, 1.1385, -31.857];
function projector(p) {
  const midLat = (p.latMin + p.latMax) / 2 * Math.PI / 180;
  const kx = Math.cos(midLat);
  const spanX = (p.lonMax - p.lonMin) * kx, spanY = p.latMax - p.latMin;
  const s = Math.min(p.w / spanX, p.h / spanY);
  const ox = p.x + (p.w - spanX * s) / 2, oy = p.y + (p.h - spanY * s) / 2;
  return (lon, lat) => [ox + (lon - p.lonMin) * kx * s, oy + (p.latMax - lat) * s];
}
const projMain0 = projector(MAIN);
const T_main = (lon, lat) => {
  const [x, y] = projMain0(lon, lat);
  const A = AFFINE;
  return [A[0] * x + A[1] * y + A[2], A[3] * x + A[4] * y + A[5]];
};

// ---- 列島の単一相似配置 ----
const CHAIN = { aLL: [131.0, 31.4], aXY: [264, 102], bLL: [123.0, 24.5], bXY: [84, 248] };
const T_chain = (() => {
  const kx = Math.cos(27.9 * Math.PI / 180);
  const P = (ll) => [ll[0] * kx, -ll[1]];
  const pa = P(CHAIN.aLL), pb = P(CHAIN.bLL);
  const dpx = pb[0] - pa[0], dpy = pb[1] - pa[1];
  const dtx = CHAIN.bXY[0] - CHAIN.aXY[0], dty = CHAIN.bXY[1] - CHAIN.aXY[1];
  const s = Math.hypot(dtx, dty) / Math.hypot(dpx, dpy);
  const th = Math.atan2(dty, dtx) - Math.atan2(dpy, dpx);
  const cos = Math.cos(th), sin = Math.sin(th);
  return (lon, lat) => {
    const [px, py] = P([lon, lat]);
    const dx = px - pa[0], dy = py - pa[1];
    return [CHAIN.aXY[0] + s * (dx * cos - dy * sin), CHAIN.aXY[1] + s * (dx * sin + dy * cos)];
  };
})();

// ---- 小笠原の単一配置 ----
// ブラケット内の西寄りに置く (ラベル (x315-) と島列が重ならないように -26 ずらす)
const T_oga0 = projector({ x: 262, y: 417, w: 105, h: 76, lonMin: 140.9, lonMax: 142.65, latMin: 24.6, latMax: 28.1 });
const T_oga = (lon, lat) => { const [x, y] = T_oga0(lon, lat); return [x - 26, y]; };

// ---- ユーティリティ ----
function bbox(coords) {
  let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
  for (const c of coords) { x0 = Math.min(x0, c[0]); x1 = Math.max(x1, c[0]); y0 = Math.min(y0, c[1]); y1 = Math.max(y1, c[1]); }
  return { x0, x1, y0, y1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, sx: x1 - x0, sy: y1 - y0 };
}
function pathStr(pts, close) {
  return pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join("") + (close ? "Z" : "");
}
// 伊豆諸島の並べ直し (現行 tmFeatureFx の izu 変換をそのまま焼き込む)
function izuShift(cx, cy) {
  const qx = Math.round(cx / 0.05) * 0.05, qy = Math.round(cy / 0.05) * 0.05;
  const t = 34.75 - qy;
  return { qx, qy, dLon: (139.3 + (qx - 139.3) * 0.55 + t * 0.10) - qx, dLat: (34.32 - t * 0.20) - qy };
}
const isIzu = (cx, cy) => cx >= 138.3 && cx <= 140.9 && cy >= 30.4 && cy < 34.8;

// 特徴 (陸地ポリゴン or 区域線) を集める。route: main|chain|oga
const features = []; // {kind:"land"|"line", zone?:code, coords, route, bb}
// データ上の塵を落とす。陸地: 最大辺 0.02° 未満 (拡大してもサブピクセル) か
// 最小辺 0.0015° 未満 (零幅スリーバ)。南鳥島・沖ノ鳥島の点ポリゴンもここで落ちる。
// 区域線: 真の点セグメントのみ (短い実セグメントは拡大で効くため残す)。
const isDust = (bb) => Math.max(bb.sx, bb.sy) < 0.02 || Math.min(bb.sx, bb.sy) < 0.0015;
const isDustLine = (bb) => bb.sx < 0.0015 && bb.sy < 0.0015;
for (const pref of PREF) {
  for (const poly of pref.polys) {
    const bb = bbox(poly[0]);
    if (isDust(bb)) continue;
    let route = "main";
    if (bb.cx > 139.5 && bb.cy < 29.0) route = "oga";
    else if (bb.cx < 131.3 && bb.cy < 31.05) route = "chain";
    if (route === "oga" && bb.cx > 143.5) continue;   // 南鳥島 (154°E) は小笠原の画に入らない
    features.push({ kind: "land", coords: poly, route, bb });
  }
}
const zoneNames = {};
for (const [code, z] of Object.entries(TZONES)) {
  zoneNames[code] = z.name;
  const all = z.lines.flat();
  const zb = bbox(all);
  let route = "main";
  if (zb.cx > 139.5 && zb.cy < 29.0) route = "oga";
  else if (zb.cx < 131.3 && zb.cy < 31.05) route = "chain";
  for (const line of z.lines) { const lb = bbox(line); if (isDustLine(lb)) continue; if (route === "oga" && lb.cx > 143.5) continue; features.push({ kind: "line", zone: code, coords: line, route, bb: lb }); }
}

// 島グループ化 (chain/oga のみ): 中心が近い特徴同士で拡大中心を共有する
for (const routeName of ["chain", "oga"]) {
  const fs_ = features.filter(f => f.route === routeName);
  const parent = fs_.map((_, i) => i);
  const find = (i) => parent[i] === i ? i : (parent[i] = find(parent[i]));
  for (let i = 0; i < fs_.length; i++) for (let j = i + 1; j < fs_.length; j++) {
    const a = fs_[i].bb, b = fs_[j].bb;
    if (Math.abs(a.cx - b.cx) < 0.12 && Math.abs(a.cy - b.cy) < 0.12) parent[find(i)] = find(j);
  }
  const groups = new Map();
  fs_.forEach((f, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(f); });
  for (const g of groups.values()) {
    const land = g.find(f => f.kind === "land");
    const c = land ? land.bb : { cx: g.reduce((s, f) => s + f.bb.cx, 0) / g.length, cy: g.reduce((s, f) => s + f.bb.cy, 0) / g.length };
    for (const f of g) f.groupCenter = [c.cx, c.cy];
  }
}

// 変換: route + 拡大 (島グループ中心まわり。本土は現行ルール)
function transformFeature(f) {
  const T = f.route === "chain" ? T_chain : f.route === "oga" ? T_oga : T_main;
  let k = 0, shift = null, center = null;
  if (f.route === "main") {
    if (f.bb.sx < 0.65 && f.bb.sy < 0.65) {
      if (isIzu(f.bb.cx, f.bb.cy)) { k = 3.2; shift = izuShift(f.bb.cx, f.bb.cy); center = [shift.qx, shift.qy]; }
      else { k = 1.8; center = [Math.round(f.bb.cx / 0.05) * 0.05, Math.round(f.bb.cy / 0.05) * 0.05]; }
    }
  } else if (f.route === "chain") {
    // 列島は全島を誇張する (実物の別枠も強変形)。大きい島ほど倍率を下げる
    // テーパーにし、崖 (0.6° 境界で倍率が跳ぶ) をなくす
    const m = Math.max(f.bb.sx, f.bb.sy);
    k = m >= 1.2 ? 1 : 1 + 1.2 * (1 - m / 1.2);
    center = f.groupCenter;
  } else { // oga
    k = 4.2; center = f.groupCenter;
  }
  const mapPt = (c) => {
    let [lon, lat] = c;
    if (k && center) {
      lon = center[0] + (lon - center[0]) * k + (shift ? shift.dLon : 0);
      lat = center[1] + (lat - center[1]) * k + (shift ? shift.dLat : 0);
    }
    return T(lon, lat);
  };
  if (f.kind === "land") return f.coords.map(ring => pathStr(ring.map(mapPt), true));
  return [pathStr(f.coords.map(mapPt), false)];
}

// ---- 出力 ----
const landMain = [], landInset = [], coast = [];
const zones = {}; // code -> {a: "m"|"c"|"o", paths: []}
for (const f of features) {
  const paths = transformFeature(f);
  if (f.kind === "land") {
    if (f.route === "main") landMain.push(...paths); else landInset.push(...paths);
  } else {
    if (!zones[f.zone]) zones[f.zone] = { a: f.route === "main" ? "m" : f.route === "chain" ? "c" : "o", paths: [] };
    zones[f.zone].paths.push(...paths);
    if (f.route === "main") coast.push(...paths); // 本土の下地は区域線 (従来どおり)
  }
}
const art = { landMain, landInset, coast, zones, zoneNames };
const out = "window.TSUNAMI_ART = " + JSON.stringify(art) + ";\n";
fs.writeFileSync(path.join(D, "tsunami-art.js"), out);
const kb = (s) => Math.round(Buffer.byteLength(s) / 1024);
console.log(`tsunami-art.js: ${kb(out)} KB / landMain ${landMain.length} / landInset ${landInset.length} / coast ${coast.length} / zones ${Object.keys(zones).length}`);
// 配置の自己検証: 列島・小笠原の陸地 bbox
function pathsBBox(ps) {
  let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
  for (const p of ps) for (const m of p.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)) {
    const x = +m[1], y = +m[2]; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  return `x${x0.toFixed(0)}-${x1.toFixed(0)} y${y0.toFixed(0)}-${y1.toFixed(0)}`;
}
console.log("landInset bbox:", pathsBBox(landInset));
console.log("landMain bbox:", pathsBBox(landMain));
