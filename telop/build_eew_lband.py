#!/usr/bin/env python3
"""1920x1080 逆L字レイアウトのデモ: 上部帯 + 左領域に縦型 EEW を収める。
上部帯 158px (48px×行間1.35×2行+余白)。本編を 16:9 のまま最大化する条件 (左幅 = 上帯×16/9) から左領域 281px、本編 1639x922。"""
import re, pathlib
d = pathlib.Path(__file__).parent
html = (d / "eew.html").read_text(encoding="utf-8")
gj = (d / "geojson.js").read_text(encoding="utf-8")
hk = (d / "hkzones.js").read_text(encoding="utf-8")
html = html.replace('<script src="geojson.js"></script>', "<script>\n" + gj + "\n</script>")
html = html.replace('<script src="hkzones.js"></script>', "<script>\n" + hk + "\n</script>")

extra = r"""
<style>
  body { background:#101216; margin:0; }
  #stage { width:1920px; height:1080px; background:#14161a; transform-origin: top left; }
  #lb-top { position:absolute; left:0; top:0; width:1920px; height:158px; background:#1d2129;
    border-bottom:3px solid #3a4152; color:#aeb8c6; font-weight:900; font-size:48px; line-height:1.35;
    display:flex; align-items:center; padding-left:36px; box-sizing:border-box; letter-spacing:2px; }
  #lb-video { position:absolute; left:281px; top:158px; width:1639px; height:922px; background:#39424e;
    color:#cfd8e3; font-weight:900; font-size:44px; display:flex; align-items:center; justify-content:center; }
  #lb-left { position:absolute; left:0; top:158px; width:281px; height:922px; background:#101216; }
  #lb-ui { font-family:sans-serif; color:#ddd; padding:10px; }
  #lb-ui button { font-size:14px; margin:0 6px 6px 0; padding:6px 12px; }
</style>
"""
html = html.replace("</head>", extra + "</head>")
html = html.replace('<div id="eew-box">',
  '<div id="lb-top"><div>上部帯（関連情報エリア）2行分の高さ<br>2行目: 関連情報のテキストが入る</div></div><div id="lb-left"></div><div id="lb-video">本編映像 1639 × 922 (16:9)</div>\n  <div id="eew-box">')

ui = r"""
<div id="lb-ui">
  <button onclick="notoStage(0)">能登 第1報</button>
  <button onclick="notoStage(1)">能登 続報 (2回目)</button>
  <button onclick="notoStage(2)">能登 続報 (3回目)</button>
  <button onclick="one(DEMOS.aomori_oki)">青森県東方沖</button>
  <button onclick="one(DEMOS.ibaraki)">茨城県南部</button>
  <label style="font-size:13px"><input type="checkbox" id="lb-textblink"> 追加地域のテキストも点滅</label>
  <span style="font-size:12px;color:#999">1920×1080 逆L字: 上部帯 158 (2行分) / 左領域 281 / 本編 1639×922 = 16:9 で最大 / 縦EEW は元比率 (158:565) のまま左領域いっぱいに拡大 (258×922、左右の余白 約11ずつ)</span>
</div>
<script>
function fit() {
  const s = Math.min(window.innerWidth / 1920, (window.innerHeight - 60) / 1080);
  document.getElementById("stage").style.transform = "scale(" + s + ")";
  document.getElementById("stage").style.marginBottom = (1080 * s - 1080 + 60) + "px";
}
window.addEventListener("resize", fit);
setEEWVerticalFrame({ left: 11, top: 158, w: 258, h: 922, mapH: 137, font: 39, ls: 3.3, colW: 62 });
const NOTO = [DEMOS.noto_first, DEMOS.noto_mid, DEMOS.noto_final];
let notoIdx = 0;
function notoStage(i) { if (i === 0 || notoIdx === i) renderEEWVertical(NOTO[i]); else renderEEWVerticalUpdate(NOTO[i]); notoIdx = i; }
function one(d) { renderEEWVertical(d); }
renderEEWVertical(NOTO[0]);
document.getElementById("lb-textblink").onchange = (e) => { window.setEEWTextBlink(e.target.checked); notoStage(notoIdx); };
fit();
</script>
"""
html = re.sub(r'const q = new URLSearchParams\(location\.search\);.*?(?=\</script\>)',
              '/* entry replaced by L-band demo */', html, flags=re.S)
html = html.replace("</body>", ui + "\n</body>")
(d / "eew-lband-1080.html").write_text(html, encoding="utf-8")
print("eew-lband-1080.html written")
