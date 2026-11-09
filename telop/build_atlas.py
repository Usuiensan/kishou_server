# -*- coding: utf-8 -*-
"""Build a self-contained 1936x1168 atlas with independent disaster layers."""
import json
import pathlib
import re
import subprocess
import tempfile

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

samples = pathlib.Path(__file__).resolve().parents[1] / "tests" / "samples"
with tempfile.TemporaryDirectory() as temp_dir:
    state_path = pathlib.Path(temp_dir) / "atlas-state.json"
    for kind, filename in (
        ("eew", "37_01_01_240613_VXSE43.xml"),
        ("tsunami", "32-39_11_02_250206_VTSE41.xml"),
        ("intensity", "32-39_11_05_240613_VXSE53.xml"),
        ("vertical", "32-39_11_05_240613_VXSE53.xml"),
    ):
        subprocess.run(
            ["node", str(samples.parent.parent / "tools" / "atlas_data.js"), kind,
             str(samples / filename), str(state_path)],
            check=True, stdout=subprocess.DEVNULL,
        )
    initial_state = json.loads(state_path.read_text(encoding="utf-8"))

css = r"""
body { background:#101216; margin:0; }
#stage { width:1936px; height:1168px; background:#000; transform-origin:top left; }
#lb-top { position:absolute; left:0; top:0; width:1920px; height:158px; box-sizing:border-box;
  background:#1d2129; border-bottom:3px solid #3a4152; color:#fff; z-index:5; }
#atlas-clock { position:absolute; left:24px; top:14px; width:240px; font-size:52px; font-weight:900; }
#atlas-intensity { position:absolute; left:300px; top:8px; width:1580px; height:142px; overflow:hidden;
  display:flex; flex-direction:column; justify-content:space-between; gap:3px; padding:4px 0; box-sizing:border-box; }
.atlas-intensity-row { min-height:56px; display:grid; grid-template-columns:150px 1fr; column-gap:22px; align-items:center;
  color:#fff; font-size:36px; font-weight:900; line-height:1.3; }
.atlas-intensity-badge { min-height:46px; display:flex; align-items:center; justify-content:center;
  box-sizing:border-box; border:4px solid #101010; background:#00c83c; color:#fff;
  text-shadow:-2px -2px #111,2px -2px #111,-2px 2px #111,2px 2px #111; }
.atlas-intensity-areas { white-space:pre; overflow:hidden; }
.atlas-intensity-areas ruby { ruby-position:over; ruby-align:center; }
.atlas-intensity-areas rt { font-size:16px; line-height:1; }
#lb-left { position:absolute; left:0; top:174px; width:281px; height:922px; background:#101216; }
#atlas-headline { position:absolute; left:11px; top:174px; width:46px; height:922px; overflow:hidden;
  writing-mode:vertical-rl; ruby-position:over; ruby-align:center; color:#fcee21; font-size:30px; font-weight:900; text-align:center; }
#eew-v { left:66px; top:174px; width:205px; height:922px; z-index:2; }
#eew-box { left:417px; top:747px; z-index:3; }
#tsunami-mini { position:absolute; left:1236px; top:651px; width:579px; height:461px; overflow:hidden; z-index:3; }
#tsunami-mini svg { width:579px; height:461px; }
#atlas-alpha-mirror { position:absolute; inset:0; z-index:4; pointer-events:none; }
.atlas-alpha-eew { position:absolute; box-sizing:border-box; border:3px solid #fff; border-radius:8px; background:#fff; }
#rg-bits { position:absolute; left:0; top:1128px; width:1936px; height:30px; background:#0d1a0b;
  border:2px solid #9dff70; box-sizing:border-box; overflow:hidden; z-index:5; }
#rg-bits .cell { display:inline-block; width:14px; height:26px; margin:1px 1px 0 0; vertical-align:top; }
#rg-bits .on { background:#c9ffb0; } #rg-bits .off { background:#274d1c; }
"""
html = html.replace("</head>", f"<style>{tsunami_css}\n{css}</style>\n</head>")
overlays = ('<div id="lb-top"><span id="atlas-clock">--:--</span><div id="atlas-intensity"></div></div>'
            '<div id="lb-left"></div><div id="atlas-headline"></div><div id="tsunami-mini"></div>')
html = html.replace('<div id="eew-box">', overlays + '<div id="eew-box">', 1)
html = html.replace('  <div id="eew-v">', '  <div id="atlas-alpha-mirror"></div>\n  <div id="eew-v">', 1)
html = re.sub(r'const q = new URLSearchParams\(location\.search\);.*?(?=</script>)',
              '/* entry replaced by atlas state polling */', html, flags=re.S)

tail = r"""
<script>
(function () {
  const bits = document.getElementById("rg-bits");
  let seed = 20261109;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  bits.innerHTML = Array.from({length:129}, () => '<span class="cell ' + (rnd() > .5 ? 'on' : 'off') + '"></span>').join('');
  setEEWVerticalFrame({ left:66, top:174, w:205, h:922, mapH:140, font:22, ls:2, colW:54 });
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
