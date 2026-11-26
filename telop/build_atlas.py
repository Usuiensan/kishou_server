# -*- coding: utf-8 -*-
"""Build a self-contained 1936x1168 atlas with independent disaster layers."""
import json
import pathlib
import re

d = pathlib.Path(__file__).parent
html = (d / "eew.html").read_text(encoding="utf-8")
for name in ("geojson.js", "hkzones.js"):
    source = (d / name).read_text(encoding="utf-8")
    html = html.replace(f'<script src="{name}"></script>', f"<script>\n{source}\n</script>")

tsunami_html = (d / "tsunami.html").read_text(encoding="utf-8")
tsunami_css = re.search(r"<style>(.*?)</style>", tsunami_html, re.S).group(1)
tsunami_js = re.search(r'<script>\s*("use strict";.*?)(?=\/\* URL エントリ)', tsunami_html, re.S).group(1)
tsunami_art = (d / "tsunami-art.js").read_text(encoding="utf-8")
live_js = (d / "atlas-live.js").read_text(encoding="utf-8")

initial_state = {"version": 1, "updatedAt": 0,
                 "layers": {kind: [] for kind in ("eew", "tsunami", "intensity", "vertical")}}

css = r"""
body { background:#101216; margin:0; }
#stage { width:1936px; height:1168px; background:#000; transform-origin:top left; }
#lb-top { position:absolute; left:0; top:0; width:1920px; height:158px; box-sizing:border-box;
  background:#1d2129; color:#fff; z-index:5; }
#atlas-clock { position:absolute; left:24px; top:14px; width:240px; font-size:56px; font-weight:900; }
#atlas-source-status { display:none; position:absolute; right:24px; top:14px; padding:12px 20px; background:#a00000;
  color:#fff; font-size:30px; font-weight:900; z-index:9; }
#atlas-intensity { position:absolute; left:300px; top:2px; width:1580px; height:120px; overflow:hidden;
  display:flex; flex-direction:column; justify-content:flex-start; gap:0; padding:0; box-sizing:border-box; }
/* 情報テロップは半透明ザブトンを置かず、文字・札の黒縁で読ませる。
   中身があるときだけ高さを自動追随させ、縁取りが切れないよう余白を取る。 */
#atlas-intensity:has(> *) { height:auto; background:transparent; padding:16px 26px; gap:8px; }
#atlas-intensity > [data-atlas-second-line] { align-items:flex-start; }
#atlas-intensity > [data-atlas-second-line] ruby { ruby-position:under; }
.atlas-intensity-row { min-height:60px; display:grid; grid-template-columns:minmax(150px, max-content) 1fr; column-gap:36px; align-items:center;
  color:#fff; font-size:40px; font-weight:900; line-height:1; }
.atlas-summary-line { min-height:60px; display:flex; align-items:flex-end; color:#fff; font-size:40px; font-weight:900;
  line-height:1; white-space:nowrap; overflow:visible; }
.atlas-summary-line ruby { ruby-position:over; ruby-align:space-around; line-height:1; }
.atlas-summary-line rt { font-size:20px; line-height:1; }
.atlas-tsunami-line { min-height:60px; display:flex; align-items:center; gap:22px; color:#fff; font-size:40px; font-weight:900;
  line-height:1; white-space:nowrap; overflow:visible; }
.atlas-tsunami-badge, .atlas-tsunami-forecast-badge { height:60px; font-size:31px; display:flex; align-items:center; justify-content:center;
  box-sizing:border-box; padding:3px 12px; white-space:nowrap; border:4px solid #000; }
.atlas-tsunami-badge { color:#fff; }
.atlas-tsunami-forecast-badge { background:#fff; color:#111; }
/* 津波観測の札は紫 (マゼンタ) 地に黒文字。2行目の桁揃え用スペーサーは不可視。 */
.atlas-tsunami-observation-badge { background:#ff00ff; color:#111; }
.atlas-tsunami-observation-spacer { visibility:hidden; }
.atlas-tsunami-additional { color:#fff; }
.atlas-tsunami-text { color:#fff; }
.atlas-longperiod-line { min-height:60px; display:flex; align-items:center; gap:22px; color:#fff; font-size:40px; font-weight:900;
  line-height:1; white-space:nowrap; overflow:visible; }
.atlas-longperiod-badge, .atlas-longperiod-class-badge { height:60px; font-size:31px; display:flex; align-items:center; justify-content:center;
  box-sizing:border-box; padding:3px 12px; white-space:nowrap; flex:none; border:4px solid #000; }
.atlas-longperiod-badge { background:#ff2800; color:#fff; }
.atlas-longperiod-names { color:#fff; min-width:0; overflow:visible; white-space:pre; }
.atlas-intensity-badge { height:60px; display:flex; align-items:center; justify-content:center;
  justify-self:start; box-sizing:border-box; color:#fff; padding:3px 12px;
  font-size:31px; line-height:1; white-space:nowrap; border:4px solid #000; }
.atlas-intensity-row.bottom .atlas-intensity-badge { align-self:center; }
/* 継続行の札は同じ文言を不可視で置き、本物の札と同じ幅を確保する
   (地域列の開始位置を札のある行と揃えるため)。 */
.atlas-intensity-continuation { height:60px; display:flex; align-items:center; justify-content:center;
  box-sizing:border-box; padding:3px 12px; font-size:31px; line-height:1; white-space:nowrap;
  border:4px solid transparent; visibility:hidden; }
/* 札の白文字および上部テロップの札以外の文字には SVG フィルタ (#atlas-outline-body) による
   不透明100%の丸縁黒枠と字間を付ける。黒文字の札 (予想札・津波観測札および
   インラインで #111 が指定される札) には付けない。
   震度行の地名列 (.atlas-intensity-areas) だけは、白→黒→白の二重縁
   (#atlas-outline-wbw) と字間 0.10em を使う (2026-11-26 本人決定)。 */
.atlas-tsunami-badge .atlas-badge-text,
.atlas-longperiod-badge .atlas-badge-text,
.atlas-longperiod-class-badge .atlas-badge-text,
.atlas-intensity-badge .atlas-badge-text { filter: url(#atlas-outline-body); letter-spacing: 0.04em; }
.atlas-summary-line, .atlas-tsunami-additional, .atlas-tsunami-text,
.atlas-tsunami-change, .atlas-longperiod-names { filter: url(#atlas-outline-body); letter-spacing: 0.06em; }
.atlas-summary-line rt,
.atlas-longperiod-names rt, .atlas-tsunami-text rt, .atlas-tsunami-change rt { letter-spacing: 0.08em; }
.atlas-tsunami-forecast-badge .atlas-badge-text,
.atlas-tsunami-observation-badge .atlas-badge-text,
.atlas-badge-no-outline .atlas-badge-text { filter: none; }
.atlas-intensity-areas { filter: url(#atlas-outline-wbw); letter-spacing: 0.10em; white-space:pre; overflow:visible; }
.atlas-intensity-areas ruby { ruby-position:over; ruby-align:center; }
.atlas-intensity-areas rt { font-size:20px; line-height:1; letter-spacing: 0.10em; }
/* 震度行同士の行間は帯コンテナの gap 8px に 8px を足して 16px にする
   (津波・長周期など他の行種の間隔は変えない。2026-11-26 本人決定の中間間隔)。 */
.atlas-intensity-row + .atlas-intensity-row { margin-top: 8px; }
/* 地名のルビ: 地域を表す固有名詞は全てルビ付き (震度行の市区町村名・
   細分区域名、津波の区域名、長周期の観測点名)。本文40pxに対しルビ20px。 */
.atlas-longperiod-names ruby { ruby-position:over; ruby-align:center; }
.atlas-tsunami-text ruby { ruby-position:over; ruby-align:center; }
.atlas-longperiod-names rt, .atlas-tsunami-text rt { font-size:20px; line-height:1; }
/* 札にはルビを振らず、中身は上下中央に置く。札自体に4pxの黒枠線を付け、文字にも縁取りを付ける。 */
#lb-left { position:absolute; left:0; top:174px; width:281px; height:922px; background:#1d2129; }
#atlas-headline { display:none; position:absolute; left:11px; top:174px; width:46px; height:922px; overflow:hidden;
  writing-mode:vertical-rl; ruby-position:over; ruby-align:center; color:#fcee21; font-size:30px; font-weight:900; text-align:center; }
.atlas-headline-number { text-combine-upright:all; }
#eew-v { left:11px; top:174px; width:258px; height:922px; z-index:2; }
#eew-box { left:574.5px; top:747px; z-index:3; }
#eew-forecast-window { display:none; position:absolute; left:300px; top:747px; z-index:6;
  width:1580px; box-sizing:border-box; padding:16px 26px; border-radius:16px;
  background:rgba(0,0,0,.5); color:#fff; font-weight:900; }
.eew-forecast-line1 { font-size:34px; line-height:1.3; white-space:nowrap; }
.eew-forecast-line2 { font-size:30px; line-height:1; white-space:nowrap; margin-top:6px; height:52px; display:flex; align-items:flex-end; }
.eew-forecast-line2 ruby { ruby-position:over; ruby-align:space-around; }
.eew-forecast-line2 rt { font-size:15px; line-height:1; }
/* 上部配置 (予報ウィンドウ=top): 上部テロップと左端・幅・ザブトン様式を
   揃え、上マージンも同じにする。帯との同時表示時は 2行分の下に
   置き、3行目以降の高さは atlas-live.js が加える。 */
#eew-forecast-window.top { top:2px; }
#eew-forecast-window.top.below-summary { top:156px; }
#tsunami-mini { position:absolute; left:1357px; top:651px; width:460px; height:auto; overflow:hidden; z-index:3; }
#tsunami-mini.advisory-only { width:380px; }
#tsunami-mini svg { width:100%; height:auto; }
#tsunami-mini-left { display:none; position:absolute; left:11px; top:880px; width:258px; height:205px; overflow:hidden; z-index:3; }
#tsunami-mini-left svg { display:block; width:258px; height:205px; }
#tsunami-super { display:none; position:absolute; right:600px; top:430px; width:760px; max-height:660px; overflow:hidden;
  z-index:6; background:rgba(0,0,0,.92); color:#fff; font-weight:900; }
.tsunami-super-head, .tsunami-super-row { display:grid; grid-template-columns:1fr 180px 150px; align-items:stretch; }
.tsunami-super-head { height:48px; background:#222; font-size:25px; }
.tsunami-super-head span { display:flex; align-items:center; justify-content:center; border-left:2px solid #555; white-space:nowrap; }
.tsunami-super-head .tsunami-super-kind { justify-content:flex-start; padding-left:12px; }
.tsunami-super-row { height:54px; font-size:29px; border-bottom:2px solid #555; }
.tsunami-super-row span { min-width:0; display:flex; align-items:center; overflow:hidden; white-space:nowrap; }
.tsunami-super-area { padding-left:10px; }
.tsunami-super-arrival { justify-content:center; color:#fff000; background:#111; }
.tsunami-super-height { justify-content:center; background:#fff; color:#111; }
.tsunami-super-major .tsunami-super-kind { background:#c800ff; }
.tsunami-super-warning .tsunami-super-kind { background:#ff2800; }
.tsunami-super-major .tsunami-super-height { color:#c800ff; }
#atlas-alpha-mirror { position:absolute; inset:0; z-index:4; pointer-events:none; }
.atlas-alpha-eew { position:absolute; box-sizing:border-box; border:3px solid #fff; border-radius:8px; background:#fff; }
#rg-bits { position:absolute; left:0; top:1128px; width:1936px; height:30px; background:#000;
  box-sizing:border-box; overflow:hidden; z-index:5; }
#atlas-test-notice { display:none; position:absolute; left:0; top:1116px; width:1936px; height:40px;
  align-items:center; justify-content:center; background:#fcee21; color:#111; font-size:30px;
  font-weight:900; letter-spacing:2px; box-sizing:border-box; z-index:6; }
"""
html = html.replace("</head>", f"<style>{tsunami_css}\n{css}</style>\n</head>")
svg_filters = (
    '<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>'
    '<filter id="atlas-outline-body" x="-20%" y="-20%" width="140%" height="140%" color-interpolation-filters="sRGB">'
    '<feMorphology in="SourceAlpha" operator="dilate" radius="2.4" result="dilated"/>'
    '<feGaussianBlur in="dilated" stdDeviation="0.9" result="blurred"/>'
    '<feComponentTransfer in="blurred" result="solid"><feFuncA type="discrete" tableValues="0 0.15 0.65 1 1 1 1 1"/></feComponentTransfer>'
    '<feFlood flood-color="#000000" result="black"/>'
    '<feComposite in="black" in2="solid" operator="in" result="outline"/>'
    '<feMerge><feMergeNode in="outline"/><feMergeNode in="SourceGraphic"/></feMerge>'
    '</filter>'
    '<filter id="atlas-outline-wbw" x="-20%" y="-20%" width="140%" height="140%" color-interpolation-filters="sRGB">'
    '<feMorphology in="SourceAlpha" operator="dilate" radius="5.6" result="dilatedW"/>'
    '<feGaussianBlur in="dilatedW" stdDeviation="1.1" result="blurredW"/>'
    '<feComponentTransfer in="blurredW" result="solidW"><feFuncA type="discrete" tableValues="0 0.15 0.65 1 1 1 1 1"/></feComponentTransfer>'
    '<feFlood flood-color="#ffffff" result="white"/>'
    '<feComposite in="white" in2="solidW" operator="in" result="outlineW"/>'
    '<feMorphology in="SourceAlpha" operator="dilate" radius="3.2" result="dilatedB"/>'
    '<feGaussianBlur in="dilatedB" stdDeviation="0.9" result="blurredB"/>'
    '<feComponentTransfer in="blurredB" result="solidB"><feFuncA type="discrete" tableValues="0 0.15 0.65 1 1 1 1 1"/></feComponentTransfer>'
    '<feFlood flood-color="#000000" result="blackW"/>'
    '<feComposite in="blackW" in2="solidB" operator="in" result="outlineB"/>'
    '<feMerge><feMergeNode in="outlineW"/><feMergeNode in="outlineB"/><feMergeNode in="SourceGraphic"/></feMerge>'
    '</filter></defs></svg>'
)
overlays = (svg_filters +
            '<div id="lb-top"><span id="atlas-clock">--:--</span><div id="atlas-source-status" role="status" aria-live="assertive"></div><div id="atlas-intensity"></div></div>'
            '<div id="lb-left"></div><div id="atlas-headline"></div><div id="tsunami-mini"></div><div id="tsunami-mini-left"></div><div id="tsunami-super"></div><div id="eew-forecast-window"></div>')
html = html.replace('<div id="eew-box">', overlays + '<div id="eew-box">', 1)
html = html.replace('  <div id="eew-v">', '  <div id="atlas-alpha-mirror"></div>\n  <div id="eew-v">', 1)
html = re.sub(r'const q = new URLSearchParams\(location\.search\);.*?(?=</script>)',
              '/* entry replaced by atlas state polling */', html, flags=re.S)

tail = r"""
<script>
(function () {
  setEEWVerticalFrame({ left:11, top:174, w:258, h:922, mapH:190, font:34, ls:2, colW:68 });
  document.getElementById("v-label-inner").style.fontSize = "34px";
  document.getElementById("v-headline").style.transform = "translateX(-12px)";
  document.getElementById("v-areas").style.letterSpacing = "0px";
  function fit() {
    const scale = Math.min(innerWidth / 1936, (innerHeight - 60) / 1168);
    document.getElementById("stage").style.transform = `scale(${scale})`;
    document.getElementById("stage").style.marginBottom = `${1168 * scale - 1168 + 60}px`;
  }
  addEventListener("resize", fit);
  fit();
})();
</script>
"""
tail = tail.replace("</script>", "</script>\n<script>" + tsunami_art + "</script>\n<script>" + tsunami_js + "</script>\n<script>window.ATLAS_INITIAL_STATE = " + json.dumps(initial_state, ensure_ascii=False) + ";</script>\n<script>" + live_js + "</script>", 1)
html = html.replace("</body>", '<div id="rg-bits"></div><div id="atlas-test-notice">【実際の情報ではありません】</div>\n' + tail + "\n</body>")
(d / "atlas-1080.html").write_text(html, encoding="utf-8")
print("atlas written (1936x1168, state-driven EEW/intensity/vertical/tsunami)")
