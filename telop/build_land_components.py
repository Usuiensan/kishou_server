#!/usr/bin/env python3
"""陸地ポリゴンを県単位から「地続きの塊」単位へ一体化する。
geojson.js の県別ポリゴンを全て union し、連結成分ごとに land_components.json へ出す。
県境は成分の内部で消えるため、後段の簡略化・丸み加工で県境の隙間や穴が生じない。
name は成分と最も大きく重なる県 (タグ用; 描画には未使用)。"""
import json, pathlib
from shapely.geometry import Polygon, MultiPolygon
from shapely.ops import unary_union
from shapely import make_valid

d = pathlib.Path(__file__).parent
src = (d / "geojson.js").read_text(encoding="utf-8")
prefs = json.loads(src[src.index("["):src.rindex("]") + 1])

def to_poly(rings):
    if not rings or len(rings[0]) < 4:
        return None
    try:
        p = Polygon(shell=rings[0], holes=[r for r in rings[1:] if len(r) >= 4])
    except Exception:
        return None
    if not p.is_valid:
        p = make_valid(p)
    if p.is_empty or p.area == 0:
        return None
    return p

pref_geoms = {}
member_count = 0
for pref in prefs:
    polys = []
    for rings in pref["polys"]:
        p = to_poly(rings)
        if p is not None:
            polys.append(p)
            member_count += 1
    if polys:
        pref_geoms[pref["name"]] = unary_union(polys)

all_union = unary_union(list(pref_geoms.values()))

def collect_polys(g, acc):
    if g.is_empty:
        return
    if g.geom_type == "Polygon":
        if g.area > 0:
            acc.append(g)
    elif hasattr(g, "geoms"):
        for part in g.geoms:
            collect_polys(part, acc)

components = []
collect_polys(all_union, components)

out = []
for comp in components:
    # 内側のリング (県境のずれによる細隙・湖) は出さない。描画側はリングを
    # 個別に塗るため、内側リングを塗っても陸地が続くだけで見た目は変わらない。
    rings = [[list(c) for c in comp.exterior.coords]]
    best_name, best_area = None, 0.0
    for name, g in pref_geoms.items():
        a = g.intersection(comp).area
        if a > best_area:
            best_name, best_area = name, a
    out.append({"name": best_name, "rings": rings})

out.sort(key=lambda c: -len(c["rings"]))
(d / "land_components.json").write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
total_rings = sum(len(c["rings"]) for c in out)
print(f"member polys {member_count} -> components {len(out)}, rings {total_rings}")
for c in out[:6]:
    xs = [p[0] for r in c["rings"] for p in r]; ys = [p[1] for r in c["rings"] for p in r]
    print(f"  comp name={c['name']} rings={len(c['rings'])} lon {min(xs):.1f}-{max(xs):.1f} lat {min(ys):.1f}-{max(ys):.1f}")
