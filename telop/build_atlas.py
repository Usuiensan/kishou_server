# -*- coding: utf-8 -*-
"""アトラス案 v8: キャンバス 1936x1168。追加領域 (右帯/下帯) はなし。
すきま16 とデータビットのみ。表示要素は 1:1 のまま。"""
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
  #stage { width:1936px; height:1168px; background:#14161a; transform-origin: top left; }
  #lb-top { position:absolute; left:0; top:0; width:1920px; height:158px; background:#1d2129;
    border-bottom:3px solid #3a4152; color:#aeb8c6; font-weight:900; font-size:48px; line-height:1.35;
    display:flex; align-items:center; padding-left:36px; box-sizing:border-box; letter-spacing:2px; z-index:5; }
  #lb-left { position:absolute; left:0; top:174px; width:281px; height:922px; background:#101216; }
  .region { position:absolute; box-sizing:border-box; border:3px solid #7fd4ff; background:rgba(80,150,220,.22);
    color:#eaf6ff; z-index:4; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:8px; }
  .region.alpha { border-color:#ffb84d; background:rgba(220,150,60,.18); color:#fff1d6; }
  .region.extra { border-color:#9dff70; background:rgba(110,220,80,.13); color:#e6ffd4; }
  .region .rt { font-size:36px; font-weight:900; letter-spacing:3px; text-shadow:0 2px 6px rgba(0,0,0,.7); }
  .region .rs { font-size:22px; font-weight:700; opacity:.9; text-shadow:0 2px 6px rgba(0,0,0,.7); }
  .gaplab { position:absolute; color:#8a93a3; font-size:19px; font-weight:700; z-index:3; }
  #rg-bits { position:absolute; left:0; top:1128px; width:1936px; height:30px; background:#0d1a0b;
    border:2px solid #9dff70; box-sizing:border-box; z-index:4; overflow:hidden; }
  #rg-bits .cell { display:inline-block; width:14px; height:26px; margin:1px 1px 0 0; vertical-align:top; }
  #rg-bits .on { background:#c9ffb0; } #rg-bits .off { background:#274d1c; }
  #bits-lab { position:absolute; left:8px; top:1098px; color:#d8ffc4; font-size:20px; font-weight:700; z-index:5;
    text-shadow:0 1px 4px rgba(0,0,0,.8); }
  #lb-ui { font-family:sans-serif; color:#ddd; padding:10px; }
</style>
"""
html = html.replace("</head>", extra + "</head>")
regions = ('<div id="lb-top"><div>上部帯（関連情報エリア）2行分の高さ<br>2行目: 関連情報のテキストが入る</div></div>'
           '<div id="lb-left"></div>'
           '<div class="region alpha" style="left:297px; top:174px; width:1639px; height:461px;"><span class="rt">上段: 透明度（輝度）</span><span class="rs">1639 × 461 @(297,174)</span></div>'
           '<div class="region" style="left:297px; top:651px; width:1639px; height:461px;"><span class="rt">下段 RGB</span><span class="rs">1639 × 461 @(297,651)</span></div>'
           ''
           ''
           '<div id="bits-lab">データビット 1936 × 30 @(0,1128)</div><div id="rg-bits"></div>'
           '<div class="gaplab" style="left:950px; top:157px;">16</div>'
           '<div class="gaplab" style="left:283px; top:640px; writing-mode:vertical-rl;">16</div>'
           '<div class="gaplab" style="left:950px; top:634px;">16</div>'
           ''
           '<div class="gaplab" style="left:950px; top:1110px;">16</div>\n  ')
html = html.replace('<div id="eew-box">', regions + '<div id="eew-box">')

ui = r"""
<div id="lb-ui">
  <span style="font-size:12px;color:#999">アトラス 1936×1168 / 上帯 1920×158 / 左帯 281×922 @(0,174) / 透明度 1639×461 @(297,174) / 下段RGB 1639×461 @(297,651) / データビット 1936×30 @(0,1128) / 領域間は全て すきま16 / 表示要素は 1:1</span>
</div>
<script>
(function () {
  const bits = document.getElementById("rg-bits");
  let seed = 20261109;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  let s = "";
  for (let i = 0; i < 129; i++) s += '<span class="cell ' + (rnd() > 0.5 ? "on" : "off") + '"></span>';
  bits.innerHTML = s;
})();
function fit() {
  const s = Math.min(window.innerWidth / 1936, (window.innerHeight - 60) / 1168);
  document.getElementById("stage").style.transform = "scale(" + s + ")";
  document.getElementById("stage").style.marginBottom = (1168 * s - 1168 + 60) + "px";
}
window.addEventListener("resize", fit);
setEEWVerticalFrame({ left: 11, top: 174, w: 258, h: 922, mapH: 137, font: 39, ls: 3.3, colW: 62 });
renderEEWVertical(DEMOS.noto_first);
fit();
</script>
"""
html = re.sub(r'const q = new URLSearchParams\(location\.search\);.*?(?=\</script\>)',
              '/* entry replaced by atlas */', html, flags=re.S)
html = html.replace("</body>", ui + "\n</body>")
(d / "atlas-1080.html").write_text(html, encoding="utf-8")
print("atlas written (1936x1168)")
