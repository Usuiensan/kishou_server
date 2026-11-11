"""Build code-320 fixed tsunami bands and review-only SVG sheets."""
import json
import math
import re
import subprocess
import tempfile
from pathlib import Path

HERE = Path(__file__).parent
ART_PATH = HERE / "tsunami-art.js"
OUT = HERE / "artifacts" / "izu-320"
ART = json.loads(ART_PATH.read_text(encoding="utf-8").removeprefix("window.TSUNAMI_ART = ").rstrip(";\n"))
KINDS = {"advisory": (2.4, "#FAF500", "津波注意報"), "warning": (2.4, "#FF2800", "津波警報"), "major": (4.7, "#C800FF", "大津波警報")}
NEIGHBORS = ("310", "311", "312", "321", "330", "380")


def points(path):
    vals = [float(x) for x in re.findall(r"-?\d+(?:\.\d+)?", path)]
    p = list(zip(vals[::2], vals[1::2]))
    if len(p) > 1 and math.dist(p[0], p[-1]) < 1e-5:
        p.pop()
    return p


def area(poly):
    return sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(poly, poly[1:] + poly[:1])) / 2


def offset(poly, distance):
    sign = 1 if area(poly) > 0 else -1
    result = []
    for i, p in enumerate(poly):
        prev, nxt = poly[i - 1], poly[(i + 1) % len(poly)]
        def normal(a, b):
            dx, dy = b[0] - a[0], b[1] - a[1]
            length = math.hypot(dx, dy) or 1
            return sign * dy / length, -sign * dx / length
        n1, n2 = normal(prev, p), normal(p, nxt)
        mx, my = n1[0] + n2[0], n1[1] + n2[1]
        ml = math.hypot(mx, my)
        if ml < 1e-6:
            mx, my, ml = n1[0], n1[1], 1
        mx, my = mx / ml, my / ml
        scale = min(distance / max(0.25, mx * n1[0] + my * n1[1]), distance * 2.5)
        result.append((p[0] + mx * scale, p[1] + my * scale))
    return result


def dpath(poly):
    return "M" + "L".join(f"{x:.3f} {y:.3f}" for x, y in poly) + "Z"


def fixed_paths(lines, radius):
    # shortcut: use the 10 coastlines retained by the current art build; revisit if its island selection changes.
    result = []
    for line in lines:
        p = points(line)
        if len(p) < 4:
            continue
        outer = offset(p, radius)
        result.append(dpath(outer) + dpath(list(reversed(p))))
    return result


regions = {"source": "telop/tsunami-art.js zones[320] coastlines, transformed with current art layout", "code": 320, "area": "伊豆諸島", "displayOnly": True, "kinds": {}}
for kind, (radius, color, label) in KINDS.items():
    regions["kinds"][kind] = {"label": label, "color": color, "fillRule": "evenodd", "outerBandPx": radius, "paths": fixed_paths(ART["zones"]["320"]["paths"], radius)}
assert len(regions["kinds"]) == 3 and all(len(v["paths"]) == 10 for v in regions["kinds"].values())
assert regions["kinds"]["major"]["outerBandPx"] == 2 * regions["kinds"]["advisory"]["outerBandPx"] - 0.1
assert all(d.count("M") == 2 and d.count("Z") == 2 for v in regions["kinds"].values() for d in v["paths"])
OUT.mkdir(parents=True, exist_ok=True)
(OUT / "regions.json").write_text(json.dumps(regions, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def sheet(kind, adjacent=False):
    radius, color, _ = KINDS[kind]
    paths = []
    if adjacent:
        for code in NEIGHBORS:
            for d in ART["zones"][code]["paths"]:
                paths.append(f'<path d="{d}" fill="none" stroke="#007FAF" stroke-width="{radius * 2}" stroke-linecap="round" stroke-linejoin="round"/>')
    for d in regions["kinds"][kind]["paths"]:
        paths.append(f'<path d="{d}" fill="{color}" fill-rule="evenodd"/>')
    # Match the production draw order: coast color underneath outlines, then land fill.
    coast = ''.join(f'<path d="{e["d"]}" fill="none" stroke="#151515" stroke-width="1.5"/>' for e in ART["landMain"] + ART["landInset"])
    land = ''.join(f'<path d="{e["d"]}" fill="#989898" fill-rule="evenodd"/>' for e in ART["landMain"] + ART["landInset"])
    outline = ''.join(f'<path d="{e["d"]}" fill="none" stroke="#151515" stroke-width="1.5"/>' for e in ART["landMain"] + ART["landInset"])
    note = f'<text x="18" y="25" font-family="sans-serif" font-size="13" fill="#222">{kind} {"adjacent 310 311 312 321 330 380" if adjacent else "solo"}</text>'
    return f'<svg xmlns="http://www.w3.org/2000/svg" width="640" height="510" viewBox="0 0 640 510"><rect width="640" height="510" fill="#fff"/>{note}{"".join(paths)}{coast}{land}{outline}</svg>\n'


for k in KINDS:
    for mode in ("solo", "adjacent"):
        # shortcut: ImageMagick supplies SVG rasterization; keep the delivered review at the 460px display width.
        with tempfile.NamedTemporaryFile(mode="w", suffix=".svg", encoding="utf-8", delete=False) as src:
            src.write(sheet(k, mode == "adjacent"))
            temp_svg = Path(src.name)
        try:
            subprocess.run(["magick", str(temp_svg), "-resize", "460x367", str(OUT / f"{k}-{mode}.png")], check=True)
        finally:
            temp_svg.unlink(missing_ok=True)
subprocess.run(["magick", "montage", *[str(OUT / f"{k}-{m}.png") for k in KINDS for m in ("solo", "adjacent")], "-tile", "2x3", "-geometry", "460x367+8+8", str(OUT / "contact-sheet.png")], check=True)
print(f"created {OUT}: 3 fixed datasets, 6 display-size PNGs; retained coastlines={len(ART['zones']['320']['paths'])}")
