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
#atlas-intensity { position:absolute; left:300px; top:2px; width:1580px; height:155px; overflow:hidden;
  display:flex; flex-direction:column; justify-content:flex-start; gap:0; padding:0; box-sizing:border-box; }
.atlas-intensity-row { min-height:56px; display:grid; grid-template-columns:230px 1fr; column-gap:22px; align-items:center;
  color:#fff; font-size:52px; font-weight:900; line-height:1; }
.atlas-intensity-badge { height:74px; display:flex; align-items:center; justify-content:center;
  box-sizing:border-box; border:4px solid #101010; background:#00c83c; color:#fff;
  -webkit-text-stroke:0.24em #000; paint-order:stroke fill; font-size:60px; line-height:1; white-space:nowrap; }
.atlas-intensity-row.top .atlas-intensity-badge { border-bottom-width:0; }
.atlas-intensity-row.bottom .atlas-intensity-badge { align-self:start; }
.atlas-intensity-areas { white-space:pre; overflow:hidden; -webkit-text-stroke:0.24em #000; paint-order:stroke fill; }
.atlas-intensity-row.top .atlas-intensity-areas ruby { ruby-position:over; ruby-align:center; }
.atlas-intensity-row.bottom .atlas-intensity-areas ruby { ruby-position:under; ruby-align:center; }
.atlas-intensity-areas rt { font-size:22px; line-height:1; -webkit-text-stroke:0.24em #000; paint-order:stroke fill; }
#lb-left { position:absolute; left:0; top:174px; width:281px; height:922px; background:#1d2129; }
#atlas-headline { display:none; position:absolute; left:11px; top:174px; width:46px; height:922px; overflow:hidden;
  writing-mode:vertical-rl; ruby-position:over; ruby-align:center; color:#fcee21; font-size:30px; font-weight:900; text-align:center; }
.atlas-headline-number { text-combine-upright:all; }
#eew-v { left:11px; top:174px; width:258px; height:922px; z-index:2; }
#eew-box { left:574.5px; top:747px; z-index:3; }
#tsunami-mini { position:absolute; left:1357px; top:651px; width:579px; height:461px; overflow:hidden; z-index:3; }
#tsunami-mini svg { width:579px; height:461px; }
#tsunami-mini-left { display:none; position:absolute; left:11px; top:880px; width:258px; height:205px; overflow:hidden; z-index:3; }
#tsunami-mini-left svg { display:block; width:258px; height:205px; }
#atlas-alpha-mirror { position:absolute; inset:0; z-index:4; pointer-events:none; }
.atlas-alpha-eew { position:absolute; box-sizing:border-box; border:3px solid #fff; border-radius:8px; background:#fff; }
#rg-bits { position:absolute; left:0; top:1128px; width:1936px; height:30px; background:#000;
  box-sizing:border-box; overflow:hidden; z-index:5; }
"""
html = html.replace("</head>", f"<style>{tsunami_css}\n{css}</style>\n</head>")
overlays = ('<div id="lb-top"><span id="atlas-clock">--:--</span><div id="atlas-intensity"></div></div>'
            '<div id="lb-left"></div><div id="atlas-headline"></div><div id="tsunami-mini"></div><div id="tsunami-mini-left"></div>')
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
html = html.replace("</body>", '<div id="rg-bits"></div>\n' + tail + "\n</body>")
(d / "atlas-1080.html").write_text(html, encoding="utf-8")
print("atlas written (1936x1168, state-driven EEW/intensity/vertical/tsunami)")
