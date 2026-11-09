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
const CHAIN = { aLL: [131.0, 31.4], aXY: [278, 82], bLL: [123.0, 24.5], bXY: [98, 228] };
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
// ポリゴン削減: 最終座標 (px) で Douglas-Peucker 簡略化する。
// 輪郭は最も遠い点で割って開いてから両半分を簡略化する (閉輪郭の潰れ回避)。
function dpSimplify(pts, tol) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = pts[a], [bx, by] = pts[b];
    const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy);
    let dmax = 0, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const d = len === 0 ? Math.hypot(pts[i][0] - ax, pts[i][1] - ay)
        : Math.abs((pts[i][0] - ax) * dy - (pts[i][1] - ay) * dx) / len;
      if (d > dmax) { dmax = d; idx = i; }
    }
    if (dmax > tol) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}
// 丸み加工 (Chaikin のコーナーカット1回)。GIS ポリゴンの角を取り、
// 放送CGの描画線に寄せる。自己交差した特徴は加工なしに戻す (ベタに穴が開くため)
function chaikin(pts, closed) {
  if (pts.length < 3) return pts;
  const out = [];
  const n = pts.length, seg = closed ? n : n - 1;
  if (!closed) out.push(pts[0]);
  for (let i = 0; i < seg; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    out.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25]);
    out.push([a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75]);
  }
  if (!closed) out.push(pts[n - 1]);
  return out;
}
function segInt(a, b, c, d) {
  const o = (p, q, r) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  const o1 = o(a, b, c), o2 = o(a, b, d), o3 = o(c, d, a), o4 = o(c, d, b);
  return o1 !== o2 && o3 !== o4;
}
function selfIntersects(pts, closed) {
  const n = pts.length, seg = closed ? n : n - 1;
  for (let i = 0; i < seg; i++) for (let j = i + 2; j < seg; j++) {
    if (closed && i === 0 && j === seg - 1) continue;
    if (segInt(pts[i], pts[(i + 1) % n], pts[j], pts[(j + 1) % n])) return true;
  }
  return false;
}
// パターン切替 (比較用): TM_TOL / TM_TOL_SMALL / TM_SMOOTH=0 で無効化 / TM_OUT
const TM_TOL = parseFloat(process.env.TM_TOL || "1.8");
const TM_TOL_SMALL = parseFloat(process.env.TM_TOL_SMALL || "0.5");
const TM_SMOOTH = process.env.TM_SMOOTH !== "0";
function smooth(pts, closed) {
  if (!TM_SMOOTH) return pts;
  const c = chaikin(pts, closed);
  return selfIntersects(c, closed) ? pts : c;
}
function simplifyRing(pts, tol) {
  if (pts.length < 4) return pts;
  let far = 1, fd = -1;
  for (let i = 1; i < pts.length; i++) { const d = (pts[i][0] - pts[0][0]) ** 2 + (pts[i][1] - pts[0][1]) ** 2; if (d > fd) { fd = d; far = i; } }
  const a = dpSimplify(pts.slice(0, far + 1), tol);
  const b = dpSimplify([...pts.slice(far), pts[0]], tol);
  const out = [...a.slice(0, -1), ...b.slice(0, -1)];
  return out.length >= 3 ? out : pts;
}
// ---- 西日本デフォルメ (TM_WEST=1) ----
// 淡路・中国・四国・九州の入り組んだ海岸だけをデフォルメする。頂点ごとに
// 西フラグ (元 lon/lat で判定) を持ち回り、簡略化は西の頂点だけ公差を大きく、
// 丸みは全体1回の後に西の辺だけもう1回かける。本土 (本州は1成分) のように
// 東西にまたがる輪郭でも、西の区間だけが変形し東側はベースと一致する。
const TM_WEST = process.env.TM_WEST === "1";
const TM_TOL_WEST = parseFloat(process.env.TM_TOL_WEST || "3.0");
const TM_TOL_WEST_SMALL = parseFloat(process.env.TM_TOL_WEST_SMALL || "1.2");
const WEST_LL = { lonMin: 128.4, lonMax: 135.45, latMin: 30.7, latMax: 34.85 };
const isWestLL = (lon, lat) => TM_WEST && lon >= WEST_LL.lonMin && lon <= WEST_LL.lonMax && lat >= WEST_LL.latMin && lat <= WEST_LL.latMax;
// items: [{p:[x,y], w:西フラグ}]。DP は頂点ごとの公差で超過分を判定する
function dpSimplifyF(items, tolB, tolW) {
  if (items.length < 3) return items;
  const keep = new Uint8Array(items.length); keep[0] = keep[items.length - 1] = 1;
  const stack = [[0, items.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = items[a].p, [bx, by] = items[b].p;
    const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy);
    let best = 0, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const d = len === 0 ? Math.hypot(items[i].p[0] - ax, items[i].p[1] - ay)
        : Math.abs((items[i].p[0] - ax) * dy - (items[i].p[1] - ay) * dx) / len;
      const excess = d - (items[i].w ? tolW : tolB);
      if (excess > best) { best = excess; idx = i; }
    }
    if (idx >= 0) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  return items.filter((_, i) => keep[i]);
}
function simplifyRingF(items, tolB, tolW) {
  if (items.length < 4) return items;
  let far = 1, fd = -1;
  for (let i = 1; i < items.length; i++) { const d = (items[i].p[0] - items[0].p[0]) ** 2 + (items[i].p[1] - items[0].p[1]) ** 2; if (d > fd) { fd = d; far = i; } }
  const a = dpSimplifyF(items.slice(0, far + 1), tolB, tolW);
  const b = dpSimplifyF([...items.slice(far), items[0]], tolB, tolW);
  const out = [...a.slice(0, -1), ...b.slice(0, -1)];
  return out.length >= 3 ? out : items;
}
function chaikinF(items, closed) {
  if (items.length < 3) return items;
  const out = [];
  const n = items.length, seg = closed ? n : n - 1;
  if (!closed) out.push(items[0]);
  for (let i = 0; i < seg; i++) {
    const a = items[i], b = items[(i + 1) % n], w = a.w || b.w;
    out.push({ p: [a.p[0] * 0.75 + b.p[0] * 0.25, a.p[1] * 0.75 + b.p[1] * 0.25], w });
    out.push({ p: [a.p[0] * 0.25 + b.p[0] * 0.75, a.p[1] * 0.25 + b.p[1] * 0.75], w });
  }
  if (!closed) out.push(items[n - 1]);
  return out;
}
// 西の辺だけコーナーカットする (他の辺は元の頂点をそのまま通す)
function chaikinLocalF(items, closed) {
  if (items.length < 3) return items;
  const out = [];
  const n = items.length, seg = closed ? n : n - 1;
  for (let i = 0; i < seg; i++) {
    const a = items[i], b = items[(i + 1) % n];
    if (a.w || b.w) {
      out.push({ p: [a.p[0] * 0.75 + b.p[0] * 0.25, a.p[1] * 0.75 + b.p[1] * 0.25], w: true });
      out.push({ p: [a.p[0] * 0.25 + b.p[0] * 0.75, a.p[1] * 0.25 + b.p[1] * 0.75], w: true });
    } else out.push(a);
  }
  if (!closed) out.push(items[n - 1]);
  return out;
}
function smoothF(items, closed) {
  let cur = items;
  if (TM_SMOOTH) {
    const c = chaikinF(cur, closed);
    if (!selfIntersects(c.map(i => i.p), closed)) cur = c;
  }
  if (TM_WEST) {
    const c = chaikinLocalF(cur, closed);
    if (!selfIntersects(c.map(i => i.p), closed)) cur = c;
  }
  return cur;
}

// 伊豆諸島の並べ直し (現行 tmFeatureFx の izu 変換をそのまま焼き込む)
function izuShift(cx, cy) {
  const qx = Math.round(cx / 0.05) * 0.05, qy = Math.round(cy / 0.05) * 0.05;
  const t = 34.75 - qy;
  return { qx, qy, dLon: (139.3 + (qx - 139.3) * 0.55 + t * 0.10) - qx, dLat: (34.32 - t * 0.8) - qy };
}
const isIzu = (cx, cy) => cx >= 138.3 && cx <= 140.9 && cy >= 30.4 && cy < 34.8;

// 特徴 (陸地ポリゴン or 区域線) を集める。route: main|chain|oga
const features = []; // {kind:"land"|"line", zone?:code, coords, route, bb}
// データ上の塵を落とす。陸地: 最大辺 0.02° 未満 (拡大してもサブピクセル) か
// 最小辺 0.0015° 未満 (零幅スリーバ)。南鳥島・沖ノ鳥島の点ポリゴンもここで落ちる。
// 区域線: 真の点セグメントのみ (短い実セグメントは拡大で効くため残す)。
const isDust = (bb) => Math.max(bb.sx, bb.sy) < 0.02 || Math.min(bb.sx, bb.sy) < 0.0015;
const isDustLine = (bb) => bb.sx < 0.0015 && bb.sy < 0.0015;
// 陸地は県単位ではなく地続きの塊 (成分) 単位で扱う (land_components.json,
// build_land_components.py が県ポリゴンを union して生成)。県境が成分内部で
// 消えるため、簡略化・丸み加工で県境の隙間や穴が生じない。
const LAND_COMPONENTS = JSON.parse(fs.readFileSync(path.join(D, "land_components.json"), "utf8"));
const droppedBBs = [];   // 落とした陸地成分の bbox (lon/lat)。区域線の浮き判定に使う
// 微小島の削除 (TM_DROP_TINY=閾値°): 本土側で最大辺が閾値未満の陸地成分を
// 落とす。列島・小笠原は拡大率が大きく小島自体が画の内容なので対象外。
// 区域線は本土・主要島の海岸に付くため影響しない
const TM_DROP_TINY = parseFloat(process.env.TM_DROP_TINY || "0");
// 近接離島の削除 (TM_DROP_NEAR=距離° / TM_NEAR_SIZE_CAP=大きさ°): 本土 (本州・
// 北海道・九州・四国) から TM_DROP_NEAR 以内にあり、最大辺が CAP 未満の島を落とす。
// NHKの地図では瀬戸内海などの沿岸離島がほぼ消える一方、淡路 (0.41°)・天草 (0.49°)
// 級は残るため、距離と大きさの両条件にする。距離は island_meta.json
// (shapely で実測した成分ごとの本土距離) を使う
const TM_DROP_NEAR = parseFloat(process.env.TM_DROP_NEAR || "0");
const TM_NEAR_SIZE_CAP = parseFloat(process.env.TM_NEAR_SIZE_CAP || "0.40");
const ISLAND_META = (() => { try { return JSON.parse(fs.readFileSync(path.join(D, "island_meta.json"), "utf8")); } catch { return {}; } })();
for (const [compIdx, comp] of LAND_COMPONENTS.entries()) {
  const bb = bbox(comp.rings.flat());
  if (isDust(bb)) { droppedBBs.push(bb); continue; }
  // 西デフォルメ時: 瀬戸内海の微小島 (最大辺 0.05° 未満) は落として海面を空ける。
  // 淡路・小豆島などの主要島は残る。区域線は海岸側に付くため影響しない
  if (TM_WEST && bb.cx >= 132.8 && bb.cx <= 135.3 && bb.cy >= 33.85 && bb.cy <= 34.6
      && Math.max(bb.sx, bb.sy) < 0.05) { droppedBBs.push(bb); continue; }
  let route = "main";
  if (bb.cx > 139.5 && bb.cy < 29.0) route = "oga";
  else if (bb.cx < 131.3 && bb.cy < 31.05) route = "chain";
  if (route === "oga" && bb.cx > 143.5) { droppedBBs.push(bb); continue; }   // 南鳥島 (154°E) は小笠原の画に入らない
  if (TM_DROP_TINY > 0 && route === "main" && Math.max(bb.sx, bb.sy) < TM_DROP_TINY) { droppedBBs.push(bb); continue; }   // 微小島の削除
  if (TM_DROP_NEAR > 0 && route === "main") {   // 近接離島の削除
    const meta = ISLAND_META[String(compIdx)];
    if (meta && meta.dist < TM_DROP_NEAR && meta.size < TM_NEAR_SIZE_CAP) { droppedBBs.push(bb); continue; }
  }
  features.push({ kind: "land", name: comp.name, coords: comp.rings, route, bb, meta: ISLAND_META[String(compIdx)] });
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

// ---- 拡大パラメータの割当 (陸地が決め、区域線は陸地に付ける) ----
// 区域線はセグメント単位の小さな特徴なので、特徴ごとに拡大を決めると
// 陸地と違う中心・倍率になり線が海岸から浮く (佐渡・瀬戸内で顕著だった)。
// 陸地の拡大を先に確定し、区域線は最寄りの陸地 (ホスト) の拡大を共有する。
// ホストのない区域線は、落とした島をなぞる線か浮いた断片なので落とす
// (湾を横切る長い線だけは拡大なしで残す)。
function landFx(f) {
  const hostLL = [f.bb.cx, f.bb.cy];
  if (f.route === "main") {
    // 淡路島は拡大しない: ×1.8 すると北東端が明石海峡を、南西端が鳴門海峡を
    // 食って両側の線がくっつく。原寸でも 11px 級で描ける大きさがある
    if (f.name === "兵庫県" && f.bb.sx > 0.3 && f.bb.sx < 0.6) return { k: 0, center: null, shift: null, hostLL };
    // 本土に近い大きな離島は拡大すると海峡を越えて本土に重なる (天草など)
    if (f.meta && f.meta.dist < 0.06 && f.meta.size >= 0.4) return { k: 0, center: null, shift: null, hostLL };
    if (f.bb.sx < 0.65 && f.bb.sy < 0.65) {
      if (isIzu(f.bb.cx, f.bb.cy)) { const s = izuShift(f.bb.cx, f.bb.cy); return { k: 1.8, center: [s.qx, s.qy], shift: s, hostLL }; }
      return { k: 1.8, center: [Math.round(f.bb.cx / 0.05) * 0.05, Math.round(f.bb.cy / 0.05) * 0.05], shift: null, hostLL };
    }
    return { k: 0, center: null, shift: null, hostLL };
  }
  if (f.route === "chain") {
    const m = Math.max(f.bb.sx, f.bb.sy);
    return { k: m >= 1.2 ? 1 : 1 + 1.2 * (1 - m / 1.2), center: f.groupCenter, shift: null, hostLL };
  }
  return { k: 4.2, center: f.groupCenter, shift: null, hostLL };
}
function bbGap(a, b) {
  const dx = Math.max(0, Math.max(a.x0 - b.x1, b.x0 - a.x1));
  const dy = Math.max(0, Math.max(a.y0 - b.y1, b.y0 - a.y1));
  return Math.hypot(dx, dy);
}
// 陸地の頂点群への最近傍検索 (0.05° グリッド)。bbox 矩形同士の距離では
// 本州の矩形が内海全体を含むため判定できないので、実頂点で測る
function pointGrid(entries) {   // entries: [{pts, tag}]
  const cell = 0.05, grid = new Map();
  for (const e of entries) for (const p of e.pts) {
    const key = Math.floor(p[0] / cell) + ":" + Math.floor(p[1] / cell);
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push({ p, tag: e.tag });
  }
  return { cell, grid };
}
function nearestInGrid(g, pt, maxR) {
  const { cell, grid } = g;
  const cx = Math.floor(pt[0] / cell), cy = Math.floor(pt[1] / cell);
  const rings = Math.ceil(maxR / cell);
  let best = null, bestD = maxR;
  for (let r = 0; r <= rings; r++) {
    for (let ix = cx - r; ix <= cx + r; ix++) for (let iy = cy - r; iy <= cy + r; iy++) {
      if (r > 0 && Math.abs(ix - cx) !== r && Math.abs(iy - cy) !== r) continue;
      const arr = grid.get(ix + ":" + iy);
      if (!arr) continue;
      for (const e of arr) {
        const d = Math.hypot(e.p[0] - pt[0], e.p[1] - pt[1]);
        if (d < bestD) { bestD = d; best = e.tag; }
      }
    }
    if (best && bestD <= r * cell) break;
  }
  return best ? { tag: best, dist: bestD } : null;
}
const CLUTTER_LL_SPREAD = [   // 島を押し広げる範囲 (瀬戸内・長崎。天草含む)
  { x0: 132.8, x1: 135.3, y0: 33.85, y1: 34.6 },
  { x0: 128.85, x1: 130.35, y0: 32.4, y1: 33.65 },
];
const CLUTTER_LL_ALL = [...CLUTTER_LL_SPREAD, { x0: 139.55, x1: 140.1, y0: 34.95, y1: 35.8 }];   // +東京湾
const inBoxLL = (cx, cy, boxes) => boxes.some(b => cx >= b.x0 && cx <= b.x1 && cy >= b.y0 && cy <= b.y1);
function pointInRing(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if (((yi > pt[1]) !== (yj > pt[1])) && (pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
{
  const lands = features.filter(f => f.kind === "land");
  for (const f of lands) f.fx = landFx(f);
  const keptGrid = pointGrid(lands.map(L => ({ pts: L.coords.flat(), tag: L })));
  const droppedGrid = pointGrid(droppedBBs.map((bb, i) => ({ pts: [[bb.cx, bb.cy]], tag: i })));
  let hosted = 0, droppedLines = 0, freeLines = 0;
  for (const f of features) {
    if (f.kind !== "line") continue;
    let host = null, hostDist = 1e9;
    for (const pt of f.coords) {
      const n = nearestInGrid(keptGrid, pt, 0.12);
      if (n && n.dist < hostDist) { hostDist = n.dist; host = n.tag; }
    }
    if (host && hostDist <= 0.06) { f.fx = host.fx; f.hostRef = host; hosted++; continue; }
    let nearDropped = false;
    for (const pt of f.coords) { if (nearestInGrid(droppedGrid, pt, 0.35)) { nearDropped = true; break; } }
    if (nearDropped || Math.max(f.bb.sx, f.bb.sy) < 0.3) { f.drop = true; droppedLines++; }
    else { f.fx = { k: 0, center: null, shift: null }; freeLines++; }
  }
  console.log(`区域線: ホスト付き ${hosted} / 落とした ${droppedLines} / 拡大なしで残置 ${freeLines}`);
  // 区域線の陸側オフセットは廃止 (2026-11-09): 最終的な線は陸地の輪郭への
  // 帰属で作るため、参照点は海岸上のままが正しい
}

// 変換: route + 拡大 (島グループ中心まわり。本土は現行ルール)
function transformFeature(f) {
  const T = f.route === "chain" ? T_chain : f.route === "oga" ? T_oga : T_main;
  let k = 0, shift = null, center = null;
  if (f.fx) { k = f.fx.k; center = f.fx.center; shift = f.fx.shift; }
  else if (f.route === "main") {
    if (f.bb.sx < 0.65 && f.bb.sy < 0.65) {
      if (isIzu(f.bb.cx, f.bb.cy)) { k = 1.8; shift = izuShift(f.bb.cx, f.bb.cy); center = [shift.qx, shift.qy]; }
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
  // 塗り分け用の所属タグ。東京都の島嶼は予報区名をそのままタグにする
  const prefTag = () => {
    if (f.name !== "東京都") return f.name;
    if (f.route === "oga") return "小笠原諸島";
    if (isIzu(f.bb.cx, f.bb.cy) && f.bb.sx < 0.65 && f.bb.sy < 0.65) return "伊豆諸島";
    return f.name;
  };
  if (f.kind === "land") return f.coords.map(ring => {
    if (TM_WEST) {
      const items = ring.map(c => ({ p: mapPt(c), w: isWestLL(c[0], c[1]) }));
      const pb = bbox(items.map(i => i.p));
      const small = Math.min(pb.sx, pb.sy) < 3;   // 小さい島は潰さない (西でも公差を抑える)
      const tolB = small ? TM_TOL_SMALL : TM_TOL;
      const tolW = small ? TM_TOL_WEST_SMALL : TM_TOL_WEST;
      return { d: pathStr(smoothF(simplifyRingF(items, tolB, tolW), true).map(i => i.p), true), p: prefTag() };
    }
    const pts = ring.map(mapPt);
    const pb = bbox(pts);
    const tol = Math.min(pb.sx, pb.sy) < 3 ? TM_TOL_SMALL : TM_TOL;   // 小さい島は潰さない
    return { d: pathStr(smooth(simplifyRing(pts, tol), true), true), p: prefTag() };
  });
  if (TM_WEST) {
    const items = f.coords.map(c => ({ p: mapPt(c), w: isWestLL(c[0], c[1]) }));
    return [pathStr(smoothF(dpSimplifyF(items, TM_TOL, TM_TOL_WEST), false).map(i => i.p), false)];
  }
  let pts = f.coords.map(mapPt);
  if (f.offDeg) {   // 陸側オフセット 2.2px (経緯度方向ベクトルを px へ換算)
    const ox = f.offDeg[0] * 27.6, oy = -f.offDeg[1] * 23.3;
    const L = Math.hypot(ox, oy) || 1;
    pts = pts.map(p => [p[0] + ox / L * 2.2, p[1] + oy / L * 2.2]);
  }
  return [pathStr(smooth(dpSimplify(pts, TM_TOL), false), false)];
}

// ---- 出力 ----
const entries = [];
for (const f of features) {
  if (f.drop) continue;
  entries.push({ f, paths: transformFeature(f) });
}
// ---- 島の押し広げ (混沌部・最終 px 空間): 島と島・島と本土の海岸間隔が
// 目標 9px になるまで島を平行移動する。区域線は幅 3.9px で海岸の両側へ
// 約2pxずつはみ出すので、9px あけば線の間に海が見える。太さは変えず
// 位置のデフォルメだけで隙間を取る。島の区域線 (ホスト=その島) も一緒に動く。
// 経緯度空間では拡大・簡略化で最終間隔が読めないため、変換後の px で測る
{
  const CLUTTER_PX_SPREAD = [
    { x0: 140, x1: 270, y0: 315, y1: 395 },   // 瀬戸内
    { x0: 35, x1: 190, y0: 325, y1: 465 },    // 長崎・五島・天草
    { x0: 320, x1: 360, y0: 350, y1: 395 },   // 伊豆諸島
  ];
  const inPx = (x, y) => CLUTTER_PX_SPREAD.some(b => x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1);
  const ptsOf = d => { const a = []; for (const m of d.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)) a.push([+m[1], +m[2]]); return a; };
  const landEntries = entries.filter(e => e.f.kind === "land");
  // 大陸塊の一括移動: 海峡の水面そのものを実際より広げるデフォルメ。
  // 四国を南へ (瀬戸内・鳴門が広がる)、九州を南へ (豊後水道が広がる)、
  // 淡路を南西へ (明石が広がる)。九州の西移動は天草との重なりを避けるため外した。
  // 区域線はホスト共有で一緒に動く
  const BULK = (() => {
    const d = { shikoku: [0, 14], kyushu: [0, 7], awaji: [-3.5, 7] };
    if (process.env.TM_BULK) {
      const [s, k, a] = process.env.TM_BULK.split("|").map(v => v.split(",").map(Number));
      if (s) d.shikoku = s; if (k) d.kyushu = k; if (a) d.awaji = a;
    }
    return d;
  })();
  const bulkOf = (f) => {
    if (f.route !== "main") return null;
    if (f.name === "高知県") return BULK.shikoku;                    // 四国 (最大重なり県で代表)
    if (f.name === "宮崎県") return BULK.kyushu;                     // 九州
    if (f.name === "兵庫県" && f.bb.sx > 0.3 && f.bb.sx < 0.6) return BULK.awaji;   // 淡路島
    if (f.meta && f.meta.dist < 0.06 && f.meta.size >= 0.4) return [-14, 0]; // 天草の主要島群を西へ離す
    return null;
  };
  for (const e of landEntries) {
    e.pts = e.paths.flatMap(o => ptsOf(o.d));
    const xs = e.pts.map(p => p[0]), ys = e.pts.map(p => p[1]);
    e.bb = { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
    e.cx = (e.bb.x0 + e.bb.x1) / 2; e.cy = (e.bb.y0 + e.bb.y1) / 2;
    e.shift = bulkOf(e.f) || [0, 0];
  }
  const islands = landEntries.filter(e => e.f.route === "main" && Math.max(e.bb.x1 - e.bb.x0, e.bb.y1 - e.bb.y0) <= 26 && inPx(e.cx, e.cy));
  const islandSet = new Set(islands);
  const TARGET = 19, IZU_TARGET = 9, CELL = 6;
  // 緩和法: 近すぎるペアに小さな反発を何十回も累積させる (一括で大きく
  // 押すと相手が入れ替わって振動し、密集地では解けないため)
  for (let it = 0; it < 40; it++) {
    const grid = new Map();
    for (const e of landEntries) for (const p of e.pts) {
      const q = [p[0] + e.shift[0], p[1] + e.shift[1]];
      const k = Math.floor(q[0] / CELL) + ":" + Math.floor(q[1] / CELL);
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push({ q, e });
    }
    let movedAny = false;
    for (const isl of islands) {
      let bpO = null, bpI = null, bE = null, bd = 1e18;
      for (const p of isl.pts) {
        const q = [p[0] + isl.shift[0], p[1] + isl.shift[1]];
        const cx = Math.floor(q[0] / CELL), cy = Math.floor(q[1] / CELL);
        for (let ix = cx - 2; ix <= cx + 2; ix++) for (let iy = cy - 2; iy <= cy + 2; iy++) {
          const arr = grid.get(ix + ":" + iy);
          if (!arr) continue;
          for (const o of arr) {
            if (o.e === isl) continue;
            const d = (o.q[0] - q[0]) ** 2 + (o.q[1] - q[1]) ** 2;
            if (d < bd) { bd = d; bpO = o.q; bpI = q; bE = o.e; }
          }
        }
      }
      bd = Math.sqrt(bd);
      const target = isIzu(isl.f.bb.cx, isl.f.bb.cy) ? IZU_TARGET : TARGET;
      if (bpO && bd < target) {
        let dx = bpI[0] - bpO[0], dy = bpI[1] - bpO[1];
        const L = Math.hypot(dx, dy) || 1;
        const step = Math.min(0.35, (target - bd) * 0.3);
        const apply = (e, s) => {
          let nx = e.shift[0] + dx / L * step * s, ny = e.shift[1] + dy / L * step * s;
          const tot = Math.hypot(nx, ny);
          if (tot > 24) { nx *= 24 / tot; ny *= 24 / tot; }
          e.shift = [nx, ny];
        };
        if (bE && islandSet.has(bE)) { apply(isl, 0.5); apply(bE, -0.5); }
        else apply(isl, 1);
        movedAny = true;
      }
    }
    if (!movedAny) break;
  }
  const shiftOf = new Map();
  for (const e of landEntries) if (Math.hypot(...e.shift) > 0.3) shiftOf.set(e.f, e.shift);
  for (const e of entries) {
    if (e.f.kind === "line" && e.f.hostRef && shiftOf.has(e.f.hostRef)) e.shift = shiftOf.get(e.f.hostRef);
    else if (e.f.kind === "land" && shiftOf.has(e.f)) e.shift = shiftOf.get(e.f);
  }
  console.log(`島の押し広げ(px): 対象 ${islands.length} / 移動 ${shiftOf.size}`);
  // ---- 間引き: 緩和後も海岸間隔 4.5px 未満 (線同士がくっつく) の島は、
  // 小さい方を落として隙間を空ける。最大辺 14px 以上の島 (淡路・甑島級) は
  // 落とさず、相手が島なら相手を落とす。相手が本土で自分も大きい場合は
  // そのまま残す (一点の近接は許容)。落とした島の区域線も一緒に落とす
  {
    const droppedE = new Set();
    const nearestOf = (isl) => {
      let bd = 1e18, bE = null;
      for (const p of isl.pts) {
        const q = [p[0] + isl.shift[0], p[1] + isl.shift[1]];
        for (const e of landEntries) {
          if (e === isl || droppedE.has(e)) continue;
          for (const op of e.pts) {
            const oq = [op[0] + e.shift[0], op[1] + e.shift[1]];
            const d = (oq[0] - q[0]) ** 2 + (oq[1] - q[1]) ** 2;
            if (d < bd) { bd = d; bE = e; }
          }
        }
      }
      return { d: Math.sqrt(bd), e: bE };
    };
    const sizeOf = e => Math.max(e.bb.x1 - e.bb.x0, e.bb.y1 - e.bb.y0);
    let droppedIslands = 0;
    const skipSet = new Set();   // 大きい島 vs 本土など、落とせない組は飛ばして他を処理する
    for (let round = 0; round < 30; round++) {
      let worst = null, worstD = 8.0, worstE = null;
      for (const isl of islands) {
        if (droppedE.has(isl) || skipSet.has(isl)) continue;
        const n = nearestOf(isl);
        if (n.d < worstD) { worstD = n.d; worst = isl; worstE = n.e; }
      }
      if (!worst) break;
      if (isIzu(worst.f.bb.cx, worst.f.bb.cy)) { skipSet.add(worst); continue; } // 伊豆の島はつないだまま残す
      if (worst.f.name === "兵庫県" && worst.f.bb.sx > 0.3 && worst.f.bb.sx < 0.6) { skipSet.add(worst); continue; }   // 淡路島は落とさない
      if (worst.f.meta && worst.f.meta.dist < 0.06 && worst.f.meta.size >= 0.4) { skipSet.add(worst); continue; } // 天草級の近接主要島は残す
      const otherIsIsland = worstE && islandSet.has(worstE) && !droppedE.has(worstE);
      let victim = null;
      if (otherIsIsland) victim = sizeOf(worstE) <= sizeOf(worst) ? worstE : (sizeOf(worst) >= 14 ? worstE : worst);
      else if (sizeOf(worst) < 14) victim = worst;
      if (!victim) { skipSet.add(worst); continue; }   // 大きい島 vs 本土: 残す
      droppedE.add(victim);
      victim.dropOut = true;
      droppedIslands++;
    }
    const droppedFeat = new Set([...droppedE].map(e => e.f));
    for (const e of entries) if (e.f.kind === "line" && e.f.hostRef && droppedFeat.has(e.f.hostRef)) e.dropOut = true;
    console.log(`島の間引き(px): ${droppedIslands} 島`);
  }
}
// 移動後に本土ポリゴンの内側へ完全に入った小成分は、海岸ではなく重複陸地なので除く。
// 内部リングの縁に区域線が描かれて「内陸の短い線」に見えるのを防ぐ。
{
  const landNow = entries.filter(e => e.f.kind === "land");
  const pts = d => [...d.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)].map(m => [+m[1], +m[2]]);
  const kyushu = landNow.find(e => e.f.name === "宮崎県");
  if (kyushu) {
    const points = (e) => e.paths.flatMap(o => pts(o.d).map(p => [p[0] + e.shift[0], p[1] + e.shift[1]]));
    const main = points(kyushu);
    const removed = [];
    for (const e of landNow) {
      if (e === kyushu || e.f.route !== "main" || e.dropOut) continue;
      const P = points(e);
      if (!P.length || Math.max(e.bb.x1 - e.bb.x0, e.bb.y1 - e.bb.y0) > 6) continue;
      if (P.every(p => pointInRing(p, main))) {
        e.dropOut = true;
        removed.push(e.f.name);
        for (const line of entries) if (line.f.kind === "line" && line.f.hostRef === e.f) line.dropOut = true;
      }
    }
    if (removed.length) console.log(`九州本土内に重なった小成分を除外: ${removed.length} (${[...new Set(removed)].join("、")})`);
  }
}
const translateD = (d, s) => !s ? d : d.replace(/(-?[\d.]+) (-?[\d.]+)/g, (m, x, y) => (+x + s[0]).toFixed(1) + " " + (+y + s[1]).toFixed(1));
const ptsOfD = (d) => [...d.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)].map(m => [+m[1], +m[2]]);
// ---- 区域線は全海岸で「陸地の輪郭への帰属」から作る ----
// 陸地 (県ポリゴン) と区域線 (予報区ポリゴン) は別原図の独立簡略化のため、
// そのままでは境界で線同士が重なったり食い違ったりし (取り合いができない)、
// 湾の輪を海ループと誤認して落とすような事故も起きる。最終配置の陸地輪郭を
// 唯一の海岸線とし、各頂点を「元の区域線の参照点に最も近い区域」へ帰属させて
// 区域ごとの run に切り直す。帰属が切り替わる頂点がそのまま区域境界になる
// ため、境界では線がスパッと切れ、湾奥を含む全海岸に欠けなく線が乗る。
// 海上の区域境界 (湾口を横切る線など) は輪郭に無いので描かれない (放送と同じ)
const zoneRuns = new Map();    // zone -> [path strings]
const zoneNorms = new Map();   // zone -> [normal strings] (path と同じ並び)
const zoneCaps = new Map();    // zone -> [cap strings]
const zoneRouteOf = new Map(); // zone -> "m"|"c"|"o"
{
  // 参照点: 全区域線エントリの最終 px 頂点 (区域つき)。グリッドで近傍検索
  const CELL = 4, grid = new Map();
  const refPts = [];
  for (const e of entries) {
    if (e.f.kind !== "line") continue;
    for (const d of e.paths) for (const p of ptsOfD(translateD(d, e.shift))) refPts.push({ p, zone: e.f.zone });
  }
  for (const r of refPts) {
    const key = Math.floor(r.p[0] / CELL) + ":" + Math.floor(r.p[1] / CELL);
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(r);
  }
  // オフセット上限: 海側法線の前方にある対岸までの距離の半分。
  // 法線の後ろにある陸地 (細い半島の反対側) を対岸扱いすると、線が陸側へ残る。
  const capsOf = new Map();   // path object -> [cap,...]
  {
    const vGrid = new Map();
    const allV = [];
    const normalsOf = P => P.map((p, i) => {
      const a = P[(i - 1 + P.length) % P.length], b = P[(i + 1) % P.length];
      let tx = b[0] - a[0], ty = b[1] - a[1];
      const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
      let nx = -ty, ny = tx;
      if (pointInRing([p[0] + nx * 2, p[1] + ny * 2], P)) { nx = -nx; ny = -ny; }
      return [Math.round(nx * 100) / 100, Math.round(ny * 100) / 100];
    });
    for (const le of entries) {
      if (le.dropOut || le.f.kind !== "land") continue;
      le.paths.forEach((o, pi) => {
        const P = ptsOfD(translateD(o.d, le.shift));
        const N = normalsOf(P);
        const ringKey = allV.length;
        P.forEach((p, idx) => {
          const rec = { p, n: N[idx], ringKey, idx, len: P.length };
          allV.push(rec);
          const key = Math.floor(p[0] / 4) + ":" + Math.floor(p[1] / 4);
          if (!vGrid.has(key)) vGrid.set(key, []);
          vGrid.get(key).push(rec);
        });
        o.__ringKey = ringKey; o.__P = P; o.__N = N;
      });
    }
    for (const le of entries) {
      if (le.dropOut || le.f.kind !== "land") continue;
      for (const o of le.paths) {
        const P = o.__P, caps = new Array(P.length).fill(9);
        P.forEach((p, idx) => {
          const cx = Math.floor(p[0] / 4), cy = Math.floor(p[1] / 4);
          let best = 24;   // 12px 先まで探す
          for (let ix = cx - 3; ix <= cx + 3; ix++) for (let iy = cy - 3; iy <= cy + 3; iy++) {
            const arr = vGrid.get(ix + ":" + iy); if (!arr) continue;
            for (const r of arr) {
              if (r.ringKey === o.__ringKey) {
                const dd = Math.min(Math.abs(r.idx - idx), P.length - Math.abs(r.idx - idx));
                if (dd <= 4) continue;
              }
              const dx = r.p[0] - p[0], dy = r.p[1] - p[1];
              const along = dx * o.__N[idx][0] + dy * o.__N[idx][1];
              const dist = Math.hypot(dx, dy);
              if (along > 0 && along / dist >= 0.65 && along < best) best = along;
            }
          }
          caps[idx] = Math.max(0, Math.min(9, best / 2 - 0.1));
        });
        capsOf.set(o, caps);
      }
    }
  }
  const RADIUS = 6;
  const nearestZone = (p) => {
    const cx = Math.floor(p[0] / CELL), cy = Math.floor(p[1] / CELL);
    const rings = Math.ceil(RADIUS / CELL);
    let best = null, bestD = RADIUS;
    for (let ix = cx - rings; ix <= cx + rings; ix++) for (let iy = cy - rings; iy <= cy + rings; iy++) {
      const arr = grid.get(ix + ":" + iy);
      if (!arr) continue;
      for (const r of arr) {
        const d = Math.hypot(r.p[0] - p[0], r.p[1] - p[1]);
        if (d < bestD) { bestD = d; best = r.zone; }
      }
    }
    return best;
  };
  let totalV = 0, coveredV = 0;
  const routeCls = (route) => route === "main" ? "m" : route === "chain" ? "c" : "o";
  for (const le of entries) {
    if (le.dropOut || le.f.kind !== "land") continue;
    for (const o of le.paths) {
      const P = ptsOfD(translateD(o.d, le.shift));
      if (P.length < 3) continue;
      const N = o.__N;
      const attr = P.map(p => { totalV++; const z = nearestZone(p); if (z) coveredV++; return z; });
      // 単独頂点の反転 (A B A) を均す
      for (let k = 0; k < 2; k++) for (let i = 0; i < P.length; i++) {
        const prev = attr[(i - 1 + P.length) % P.length], next = attr[(i + 1) % P.length];
        if (prev && prev === next && attr[i] !== prev) attr[i] = prev;
      }
      // 短い割り込みの除去: 両側が同じ区域に挟まれた 3 頂点以下の他区域
      // (または無帰属) は両側の区域に寄せる。岬などで帰属が一瞬だけ他区域に
      // 跳び、その run が短すぎて捨てられると線が途切れて見えるため
      for (let pass = 0; pass < 5; pass++) {
        const segs = [];
        for (let i = 0; i < P.length; i++) {
          if (segs.length && segs[segs.length - 1].zone === attr[i]) segs[segs.length - 1].end = i;
          else segs.push({ zone: attr[i], start: i, end: i });
        }
        if (segs.length < 3) break;
        let flipped = false;
        for (let s = 1; s < segs.length - 1; s++) {
          const a = segs[s - 1], b = segs[s], c = segs[s + 1];
          if (a.zone && a.zone === c.zone && b.zone !== a.zone && (b.end - b.start + 1) <= 3) {
            for (let i = b.start; i <= b.end; i++) attr[i] = a.zone;
            flipped = true;
          }
        }
        // リングの継ぎ目 (先頭と末尾が同じ区域) に挟まれた割り込み
        const first = segs[0], last = segs[segs.length - 1];
        if (!flipped && first.zone && first.zone === last.zone) {
          if (segs.length >= 3 && segs[1].zone !== first.zone && (segs[1].end - segs[1].start + 1) <= 3 && segs[1] !== last) {
            for (let i = segs[1].start; i <= segs[1].end; i++) attr[i] = first.zone;
            flipped = true;
          }
        }
        if (!flipped) break;
      }
      // run 切り出し (区域が切り替わる頂点を共有して隙間を作らない)
      const runs = [];
      let cur = null;
      const flush = () => {
        if (cur && cur.idxs.length >= 2) runs.push(cur);
        cur = null;
      };
      for (let i = 0; i < P.length; i++) {
        const z = attr[i];
        if (!z) { flush(); continue; }
        if (cur && cur.zone === z) cur.idxs.push(i);
        else { const prevIdx = cur ? cur.idxs[cur.idxs.length - 1] : null; flush(); cur = { zone: z, idxs: prevIdx !== null ? [prevIdx, i] : [i] }; }
      }
      flush();
      // 輪郭全周がひとつの区域なら、run は配列先頭で切れるため、閉じる最後の辺を明示的に足す。
      if (runs.length === 1 && runs[0].zone && runs[0].idxs.length === P.length) runs[0].idxs.push(0);
      // 輪郭の配列先頭が区域内にある場合、末尾側と先頭側の同一区域runをつなぐ。
      if (runs.length > 1 && runs[0].zone === runs.at(-1).zone) {
        const first = runs.shift(), last = runs.pop();
        runs.unshift({ zone: first.zone, idxs: [...last.idxs, ...first.idxs] });
      }
      for (const run of runs) {
          const pts = run.idxs.map(i => P[i]);
          let L = 0; for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
          if (L >= 1.0) {
            if (!zoneRuns.has(run.zone)) { zoneRuns.set(run.zone, []); zoneNorms.set(run.zone, []); zoneCaps.set(run.zone, []); }
            zoneRuns.get(run.zone).push("M" + pts.map(p => p[0].toFixed(1) + " " + p[1].toFixed(1)).join("L"));
            zoneNorms.get(run.zone).push(run.idxs.map(i => N[i][0] + "," + N[i][1]).join(" "));
            const caps = capsOf.get(o) || [];
            zoneCaps.get(run.zone).push(run.idxs.map(i => (caps[i] !== undefined ? caps[i] : 9).toFixed(1)).join(" "));
            if (!zoneRouteOf.has(run.zone)) zoneRouteOf.set(run.zone, routeCls(le.f.route));
          }
      }
    }
  }
  console.log(`海岸の区域帰属: 頂点 ${coveredV}/${totalV} (${(100 * coveredV / totalV).toFixed(1)}%) / 区域 ${zoneRuns.size}`);
}
const landMain = [], landInset = [], coast = [];
const zones = {}; // code -> {a: "m"|"c"|"o", paths: []}
for (const e of entries) {
  const f = e.f;
  if (e.dropOut) continue;
  if (f.kind === "land") {
    const paths = e.paths.map(o => ({ d: translateD(o.d, e.shift), p: o.p }));
    if (f.route === "main") landMain.push(...paths); else landInset.push(...paths);
  }
  // 区域線はエントリからではなく、海岸帰属の run から構築する (下)
}
for (const [zone, runs] of zoneRuns) {
  zones[zone] = { a: zoneRouteOf.get(zone) || "m", paths: runs, norms: zoneNorms.get(zone) || [], caps: zoneCaps.get(zone) || [] };
  coast.push(...runs);
}
// 予報区 -> 塗り分け先 (県名または東京都の島嶼タグ)。複数県にまたがる
// 湾内区域 (312 東京湾内湾, 391 伊勢・三河湾, 712 有明・八代海) は塗らない
// (海岸線の色で示す。塗りは補助表示)。
const ZONE_PREF = {
  100:"北海道",101:"北海道",102:"北海道",110:"北海道",111:"北海道",120:"北海道",
  200:"青森県",201:"青森県",202:"青森県",210:"岩手県",220:"宮城県",230:"秋田県",
  240:"山形県",250:"福島県",300:"茨城県",310:"千葉県",311:"千葉県",312:null,
  320:"伊豆諸島",321:"小笠原諸島",330:"神奈川県",340:"新潟県",341:"新潟県",
  350:"富山県",360:"石川県",361:"石川県",370:"福井県",380:"静岡県",390:"愛知県",
  391:null,400:"三重県",500:"京都府",510:"大阪府",520:"兵庫県",521:"兵庫県",
  522:"兵庫県",530:"和歌山県",540:"鳥取県",550:"島根県",551:"島根県",560:"岡山県",
  570:"広島県",580:"徳島県",590:"香川県",600:"愛媛県",601:"愛媛県",610:"高知県",
  700:"山口県",701:"山口県",710:"福岡県",711:"福岡県",712:null,720:"佐賀県",
  730:"長崎県",731:"長崎県",740:"熊本県",750:"大分県",751:"大分県",760:"宮崎県",
  770:"鹿児島県",771:"鹿児島県",772:"鹿児島県",773:"鹿児島県",
  800:"沖縄県",801:"沖縄県",802:"沖縄県",
};
const art = { landMain, landInset, coast, zones, zoneNames, zonePref: ZONE_PREF };
const out = "window.TSUNAMI_ART = " + JSON.stringify(art) + ";\n";
fs.writeFileSync(path.join(D, process.env.TM_OUT || "tsunami-art.js"), out);
const kb = (s) => Math.round(Buffer.byteLength(s) / 1024);
const ptsOf = (s) => (String(s).match(/[ML]/g) || []).length;
const totalPts = [...landMain, ...landInset].reduce((s, e) => s + ptsOf(e.d), 0)
  + coast.reduce((s, d) => s + ptsOf(d), 0)
  + Object.values(zones).reduce((s, z) => s + z.paths.reduce((t, d) => t + ptsOf(d), 0), 0);
console.log(`tsunami-art.js: ${kb(out)} KB / landMain ${landMain.length} / landInset ${landInset.length} / coast ${coast.length} / zones ${Object.keys(zones).length} / 総頂点 ${totalPts}`);
// 配置の自己検証: 列島・小笠原の陸地 bbox
function pathsBBox(ps) {
  let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
  for (const p of ps) { const s = typeof p === "string" ? p : p.d; for (const m of s.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)) {
    const x = +m[1], y = +m[2]; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  } }
  return `x${x0.toFixed(0)}-${x1.toFixed(0)} y${y0.toFixed(0)}-${y1.toFixed(0)}`;
}
console.log("landInset bbox:", pathsBBox(landInset));
console.log("landMain bbox:", pathsBBox(landMain));
