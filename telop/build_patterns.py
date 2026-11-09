#!/usr/bin/env python3
"""公差×丸みの全8パターンを1ページで切り替える比較ページを合成する。
事前に patterns/art-<key>.js を build_art.js の環境変数で生成しておくこと:
  for spec in "0.9 0.25 0" "0.9 0.25 1" "1.8 0.5 0" "1.8 0.5 1" \\
              "2.6 0.7 0" "2.6 0.7 1" "3.2 0.9 0" "3.2 0.9 1"; do
    set -- $spec; key="$1"; [ "$3" = "1" ] && key="$1s"
    TM_TOL=$1 TM_TOL_SMALL=$2 TM_SMOOTH=$3 TM_OUT=patterns/art-$key.js node build_art.js
  done
  0.9w は西デフォルメ版: TM_TOL=0.9 TM_TOL_SMALL=0.25 TM_SMOOTH=1 TM_WEST=1 \\
    TM_OUT=patterns/art-0.9w.js node build_art.js"""
import pathlib
d = pathlib.Path(__file__).parent
html = (d / "tsunami.html").read_text(encoding="utf-8")

KEYS = ["0.9w", "0.9", "0.9s", "1.8", "1.8s", "2.6", "2.6s", "3.2", "3.2s"]
LABELS = {"0.9w": "公差0.9＋丸み＋西デフォルメ", "0.9": "公差0.9", "0.9s": "公差0.9＋丸み", "1.8": "公差1.8", "1.8s": "公差1.8＋丸み",
          "2.6": "公差2.6", "2.6s": "公差2.6＋丸み", "3.2": "公差3.2", "3.2s": "公差3.2＋丸み"}
scripts = ["<script>window.__PATTERNS = {};</script>"]
for k in KEYS:
    art = (d / "patterns" / f"art-{k}.js").read_text(encoding="utf-8")
    art = art.replace("window.TSUNAMI_ART", f'window.__PATTERNS["{k}"]', 1)
    scripts.append("<script>\n" + art + "\n</script>")
html = html.replace('<script src="tsunami-art.js"></script>', "\n".join(scripts))
html = html.replace(
    'const ART = window.TSUNAMI_ART || { landMain:[], landInset:[], coast:[], zones:{}, zoneNames:{}, zonePref:{} };',
    'let ART = window.__PATTERNS["0.9w"];')

buttons = "\n  ".join(f'<button data-pat="{k}">{LABELS[k]}</button>' for k in KEYS)
ui = """
<style>
  body { background:#2b2b30; }
  #tm-ui { position:fixed; left:10px; top:10px; z-index:10; font-family:sans-serif; color:#fff; max-width:46em; }
  #tm-ui button { font-size:14px; margin:0 4px 6px 0; padding:5px 10px; }
  #tm-ui button.on { background:#ffd94a; }
  #tm-stage { position:absolute; right:12px; bottom:12px; }
  #tm-bg { position:fixed; inset:0; z-index:-1; }
</style>
<div id="tm-bg"></div>
<div id="tm-ui">
  <!--__BUTTONS__-->
  <br>
  <button data-demo="example">使用例の近似</button>
  <button data-demo="tohoku">東北太平洋側</button>
  <button data-demo="advisory_all">全区域 注意報</button>
  <button data-demo="none">発表なし</button>
  <button id="tm-legend">凡例 ON/OFF</button>
  <button id="tm-blinkbtn">点滅 ON/OFF</button><br>
  <button data-bg="#000000">背景: 黒</button>
  <button data-bg="#2060c0">背景: 青 (映像想定)</button>
  <button data-bg="#3a7d3a">背景: 緑 (映像想定)</button>
  <button data-bg="transparent">背景: なし</button>
</div>
<div id="tm-stage"></div>
<script>
  document.getElementById("tsunami-mini").remove();
  document.getElementById("tm-stage").appendChild(document.createElement("div")).id = "tsunami-mini";
  let cur = TM_DEMOS.example, legend = true, blink = true, pat = "0.9w";
  function draw(){ ART = window.__PATTERNS[pat]; renderTsunamiMini(Object.assign({}, cur, { legend, blink }));
    document.querySelectorAll("[data-pat]").forEach(b => b.classList.toggle("on", b.dataset.pat === pat)); }
  draw();
  document.querySelectorAll("[data-pat]").forEach(b => b.onclick = () => { pat = b.dataset.pat; draw(); });
  document.querySelectorAll("[data-demo]").forEach(b => b.onclick = () => { cur = TM_DEMOS[b.dataset.demo]; draw(); });
  document.querySelectorAll("[data-bg]").forEach(b => b.onclick = () => { document.getElementById("tm-bg").style.background = b.dataset.bg; });
  document.getElementById("tm-legend").onclick = () => { legend = !legend; draw(); };
  document.getElementById("tm-blinkbtn").onclick = () => { blink = !blink; draw(); };
</script>
"""
ui = ui.replace("<!--__BUTTONS__-->", buttons)
html = html.replace("</body>", ui + "</body>")
assert 'let ART = window.__PATTERNS["0.9w"];' in html, "ART差し替え失敗"
assert "ART = window.__PATTERNS[pat];" in html, "draw() の参照が壊れている"
assert html.count('data-pat=') == 9, "パターンボタンが9個ない"
(d / "patterns.html").write_text(html, encoding="utf-8")
print("patterns.html written", len(html.encode()) // 1024, "KB")
