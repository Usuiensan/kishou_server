# eew.html から tester/index.html と単一ファイル版を再生成する
import pathlib
t = pathlib.Path(__file__).parent
src = (t / "eew.html").read_text(encoding="utf-8")
prev = (t / "tester" / "index.html").read_text(encoding="utf-8")
css = prev[prev.index("  /* ===== テスター用コントロールパネル ===== */"):prev.index("</style>")]
html = prev[prev.index('<div id="panel">'):prev.index('<div id="stage">')]
js = prev[prev.index("<script>\n\"use strict\";\nconst PRESETS"):prev.index("</body>")]
out = src.replace("</style>", css + "</style>", 1)
out = out.replace('<div id="stage">', html + '<div id="stage">', 1)
out = out.replace("</div>\n<script src=\"geojson.js\">", "</div></div>\n<script src=\"geojson.js\">", 1)
out = out.replace("</body>", js + "</body>", 1)
(t / "tester" / "index.html").write_text(out, encoding="utf-8")
(t / "tester" / "hkzones.js").write_text((t / "hkzones.js").read_text(encoding="utf-8"), encoding="utf-8")
geo = (t / "tester" / "geojson.js").read_text(encoding="utf-8")
hk = (t / "hkzones.js").read_text(encoding="utf-8")
single = out.replace('<script src="geojson.js"></script>', "<script>\n" + geo + "</script>", 1)
single = single.replace('<script src="hkzones.js"></script>', "<script>\n" + hk + "</script>", 1)
(t / "eew-telop-tester.html").write_text(single, encoding="utf-8")
print("tester rebuilt (hkzones inlined:", "HKZONES" in single, ")")
