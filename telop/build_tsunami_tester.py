#!/usr/bin/env python3
"""tsunami.html + tsunami-art.js (固定画データ) を単一ファイルのテスターに合成する。"""
import re, pathlib
d = pathlib.Path(__file__).parent
html = (d / "tsunami.html").read_text(encoding="utf-8")
art = (d / "tsunami-art.js").read_text(encoding="utf-8")
html = html.replace('<script src="tsunami-art.js"></script>', "<script>\n" + art + "\n</script>")
# テスター用UIを差し込む
ui = """
<style>
  body { background:#2b2b30; }
  #tm-ui { position:fixed; left:10px; top:10px; z-index:10; font-family:sans-serif; }
  #tm-ui button { font-size:14px; margin:0 4px 6px 0; padding:5px 10px; }
  #tm-stage { position:absolute; right:12px; bottom:12px; }
  #tm-bg { position:fixed; inset:0; z-index:-1; }
</style>
<div id="tm-bg"></div>
<div id="tm-ui">
  <button data-demo="example">使用例の近似</button>
  <button data-demo="tohoku">東北太平洋側</button>
  <button data-demo="advisory_all">全区域 注意報</button>
  <button data-demo="none">発表なし</button>
  <button id="tm-legend">凡例 ON/OFF</button>
  <button id="tm-blinkbtn">点滅 ON/OFF</button>
  <button id="tm-fillbtn">塗り分け ON/OFF</button><br>
  <button data-bg="#000000">背景: 黒</button>
  <button data-bg="#2060c0">背景: 青 (映像想定)</button>
  <button data-bg="#3a7d3a">背景: 緑 (映像想定)</button>
  <button data-bg="transparent">背景: なし</button>
</div>
<div id="tm-stage"></div>
<script>
  document.getElementById("tsunami-mini").remove();
  document.getElementById("tm-stage").appendChild(document.createElement("div")).id = "tsunami-mini";
  let cur = TM_DEMOS.example, legend = true, blink = true, fill = false;
  function draw(){ const m = document.querySelector("#tm-stage #tsunami-mini"); m.id = "tsunami-mini"; renderTsunamiMini(Object.assign({}, cur, { legend, blink, fill })); }
  // renderTsunamiMini は #tsunami-mini を見るので stage 内の同ID要素でよい
  draw();
  document.querySelectorAll("[data-demo]").forEach(b => b.onclick = () => { cur = TM_DEMOS[b.dataset.demo]; draw(); });
  document.querySelectorAll("[data-bg]").forEach(b => b.onclick = () => { document.getElementById("tm-bg").style.background = b.dataset.bg; });
  document.getElementById("tm-legend").onclick = () => { legend = !legend; draw(); };
  document.getElementById("tm-blinkbtn").onclick = () => { blink = !blink; draw(); };
  document.getElementById("tm-fillbtn").onclick = () => { fill = !fill; draw(); };
</script>
"""
html = html.replace("</body>", ui + "</body>")
# 初期描画は main の #tsunami-mini に対して行われるが、テスターでは stage 側を使うため末尾で再描画される
(d / "tsunami-tester.html").write_text(html, encoding="utf-8")
print("tsunami-tester.html written", len(html.encode()) // 1024, "KB")
