#!/usr/bin/env python3
"""予報区ごとの取り合い確認ページ: 区域ごとに なし/注意報/警報/大津波警報 を
個別に割り当てて描く。初期状態は交互割当 (隣り合う区域が別の色になる) で、
全境界の切り替わりを一目で確認できる。"""
import pathlib
d = pathlib.Path(__file__).parent
html = (d / "tsunami.html").read_text(encoding="utf-8")
art = (d / "tsunami-art.js").read_text(encoding="utf-8")
html = html.replace('<script src="tsunami-art.js"></script>', "<script>\n" + art + "\n</script>")
ui = """
<style>
  body { background:#2b2b30; font-family:sans-serif; }
  #tm-ui { position:fixed; left:10px; top:10px; z-index:10; width:300px; max-height:96vh; overflow-y:auto; background:#1c1c20; padding:8px; }
  #tm-ui button { font-size:13px; margin:0 4px 6px 0; padding:4px 8px; }
  #tm-stage { position:absolute; right:12px; bottom:12px; }
  #tm-bg { position:fixed; inset:0; z-index:-1; }
  .zrow { display:flex; align-items:center; gap:6px; margin:2px 0; color:#ddd; font-size:12px; }
  .zrow .nm { flex:1; white-space:nowrap; overflow:hidden; }
  .zrow button { min-width:86px; margin:0; }
  .st0 { background:#555; color:#fff; }
  .st1 { background:#faf500; color:#000; }
  .st2 { background:#ff2800; color:#fff; }
  .st3 { background:#c800ff; color:#fff; }
</style>
<div id="tm-bg"></div>
<div id="tm-ui">
  <div>
    <button id="zc-alt3">交互 (注意報/警報/大津波)</button>
    <button id="zc-alt4">交互 (なし込み)</button>
    <button id="zc-none">全区域 なし</button>
  </div>
  <div>
    <button data-bg="#000000">背景: 黒</button>
    <button data-bg="#2060c0">背景: 青</button>
    <button data-bg="transparent">背景: なし</button>
  </div>
  <div id="zc-list"></div>
</div>
<div id="tm-stage"></div>
<script>
  document.getElementById("tsunami-mini").remove();
  document.getElementById("tm-stage").appendChild(document.createElement("div")).id = "tsunami-mini";
  const CATS = ["なし", "注意報", "警報", "大津波警報"];
  const names = Object.values(ART.zoneNames);
  const state = {};   // zoneName -> 0..3
  function applyAlt(mod, off) { names.forEach((n, i) => state[n] = (i + (off || 0)) % mod); draw(); buildList(); }
  function draw() {
    const inp = { major: [], warning: [], advisory: [], legend: false, blink: false };
    for (const n of names) {
      if (state[n] === 1) inp.advisory.push(n);
      else if (state[n] === 2) inp.warning.push(n);
      else if (state[n] === 3) inp.major.push(n);
    }
    renderTsunamiMini(inp);
  }
  function buildList() {
    const list = document.getElementById("zc-list");
    list.innerHTML = "";
    names.forEach((n, i) => {
      const row = document.createElement("div"); row.className = "zrow";
      const nm = document.createElement("span"); nm.className = "nm"; nm.textContent = (i + 1) + ". " + n;
      const b = document.createElement("button"); b.className = "st" + state[n]; b.textContent = CATS[state[n]];
      b.onclick = () => { state[n] = (state[n] + 1) % 4; b.className = "st" + state[n]; b.textContent = CATS[state[n]]; draw(); };
      row.appendChild(nm); row.appendChild(b); list.appendChild(row);
    });
  }
  document.getElementById("zc-alt3").onclick = () => applyAlt(3, 1);
  document.getElementById("zc-alt4").onclick = () => applyAlt(4, 0);
  document.getElementById("zc-none").onclick = () => { names.forEach(n => state[n] = 0); draw(); buildList(); };
  document.querySelectorAll("[data-bg]").forEach(b => b.onclick = () => { document.getElementById("tm-bg").style.background = b.dataset.bg; });
  names.forEach((n, i) => state[n] = (i + 1) % 3 === 0 ? 3 : ((i + 1) % 3 === 2 ? 2 : 1));
  buildList(); draw();
</script>
"""
html = html.replace("</body>", ui + "</body>")
(d / "tsunami-zonecheck.html").write_text(html, encoding="utf-8")
print("tsunami-zonecheck.html written", len(html.encode()) // 1024, "KB")
