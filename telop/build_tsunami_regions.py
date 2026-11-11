#!/usr/bin/env python3
"""Bake the per-zone, per-severity offshore bands used by tsunami.html."""
import json
import math
import re
from pathlib import Path

from shapely import make_valid
from shapely.geometry import GeometryCollection, LineString, Point, Polygon
from shapely.ops import unary_union

HERE = Path(__file__).parent
ART = json.loads((HERE / "tsunami-art.js").read_text(encoding="utf-8")
                 .removeprefix("window.TSUNAMI_ART = ").rstrip(";\n"))
REGIONS_PATH = HERE / "tsunami-regions.json"
IZU = json.loads((HERE / "artifacts/izu-320/regions.json").read_text(encoding="utf-8"))
KINDS = ("advisory", "warning", "major")
RADII = {"advisory": 2.4, "warning": 2.4, "major": 4.7}


def points(path):
    return [(float(x), float(y)) for x, y in re.findall(r"[ML](-?[\d.]+) (-?[\d.]+)", path)]


def path_geometry(path):
    rings = [points(part) for part in re.split(r"(?=M)", path) if part.strip()]
    if not rings or len(rings[0]) < 3:
        return GeometryCollection()
    return make_valid(Polygon(rings[0], [ring for ring in rings[1:] if len(ring) >= 3]))


def offset(path_points, normals, caps, radius):
    return [(x + nx * min(radius, cap), y + ny * min(radius, cap))
            for (x, y), (nx, ny), cap in zip(path_points, normals, caps)]


land = unary_union([make_valid(Polygon(points(item["d"]))) for item in ART["landMain"] + ART["landInset"]
                    if len(points(item["d"])) >= 3])


def sea_normals(path_points):
    normals = []
    for i, (x, y) in enumerate(path_points):
        before, after = path_points[max(0, i - 1)], path_points[min(len(path_points) - 1, i + 1)]
        dx, dy = after[0] - before[0], after[1] - before[1]
        length = math.hypot(dx, dy) or 1
        nx, ny = -dy / length, dx / length
        if land.contains(Point(x + nx * 0.2, y + ny * 0.2)):
            nx, ny = -nx, -ny
        normals.append((nx, ny))
    return normals


def shape_path(path_points, normals, caps, radius):
    # A fixed offshore polygon replaces the runtime centered SVG stroke.
    inner = offset(path_points, normals, caps, 0.0)
    outer = offset(path_points, normals, caps, radius)
    coords = outer + inner[::-1]
    if len(coords) < 4 or all(math.dist(coords[0], p) < 1e-6 for p in coords[1:]):
        return GeometryCollection()
    geom = Polygon(coords)
    return make_valid(geom) if not geom.is_valid else geom


def extract_polygons(geom):
    if geom.is_empty:
        return
    if geom.geom_type == "Polygon":
        yield geom
    elif hasattr(geom, "geoms"):
        for part in geom.geoms:
            yield from extract_polygons(part)


def ring_path(ring):
    coords = list(ring.coords)
    return "M" + "L".join(f"{x:.4f} {y:.4f}" for x, y in coords[:-1]) + "Z"


def geom_paths(geom):
    paths = []
    for poly in extract_polygons(geom):
        if poly.area <= 1e-4:
            continue
        rings = [poly.exterior, *(ring for ring in poly.interiors if Polygon(ring).area > 1e-4)]
        paths.append("".join(ring_path(ring) for ring in rings))
    return paths


zones = ART["zones"]
codes = sorted(ART["zoneNames"], key=int)
assert len(codes) == 66 and set(codes) == set(zones)
source_lines = {code: unary_union([LineString(points(path)) for path in zones[code]["paths"]
                                   if len(points(path)) >= 2]) for code in codes}
regions = {}
for kind in KINDS:
    shapes = {}
    for code in codes:
        if code == "320":
            geoms = [path_geometry(path) for path in IZU["kinds"][kind]["paths"]]
        else:
            zone = zones[code]
            geoms = []
            if len(zone["norms"]) == len(zone["caps"]) == len(zone["paths"]):
                metadata = zip(zone["paths"], zone["norms"], zone["caps"])
            elif not zone["norms"] and not zone["caps"]:
                metadata = ((path, None, None) for path in zone["paths"])
            else:
                raise ValueError(f"{code}: path metadata length mismatch")
            for path, norm_str, cap_str in metadata:
                path_points = points(path)
                normals = ([tuple(map(float, item.split(","))) for item in norm_str.split()]
                           if norm_str else sea_normals(path_points))
                caps = list(map(float, cap_str.split())) if cap_str else [9.0] * len(path_points)
                if len(path_points) != len(normals) or len(path_points) != len(caps):
                    raise ValueError(f"{code} {kind}: path metadata length mismatch")
                geom = shape_path(path_points, normals, caps, RADII[kind])
                if not geom.is_empty:
                    geoms.append(geom)
        region = unary_union(geoms).difference(land) if geoms else GeometryCollection()
        shapes[code] = make_valid(region)
        if shapes[code].is_empty:
            raise ValueError(f"{code} {kind}: no fixed region paths")
    # Resolve only the offshore overlap at zone joins, assigning it to the nearest source coastline.
    for i, a in enumerate(codes):
        for b in codes[i + 1:]:
            overlap = shapes[a].intersection(shapes[b])
            if overlap.is_empty or overlap.area <= 1e-6:
                continue
            p = overlap.representative_point()
            loser = b if source_lines[a].distance(p) <= source_lines[b].distance(p) else a
            shapes[loser] = make_valid(shapes[loser].difference(overlap))
    remaining = [(round(shapes[a].intersection(shapes[b]).area, 5), a, b)
                 for i, a in enumerate(codes) for b in codes[i + 1:]
                 if shapes[a].intersection(shapes[b]).area > 0.01]
    if remaining:
        raise ValueError(f"{kind}: overlapping zone bands remain: {remaining[:8]}")
    for code in codes:
        paths = geom_paths(shapes[code])
        if not paths:
            raise ValueError(f"{code} {kind}: no fixed region paths after overlap trimming")
        regions.setdefault(code, {})[kind] = paths
    encoded = {code: unary_union([path_geometry(path) for path in regions[code][kind]]) for code in codes}
    spill = max(shape.intersection(land).area for shape in encoded.values())
    overlaps = [(a, b) for i, a in enumerate(codes) for b in codes[i + 1:]
                if encoded[a].intersection(encoded[b]).area > 0.01]
    if spill > 0.01 or overlaps:
        raise ValueError(f"{kind}: serialized regions enter land by {spill:.4f}px² or overlap: {overlaps[:8]}")

REGIONS_PATH.write_text(json.dumps(regions, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
ART["regions"] = regions
ART_PATH = HERE / "tsunami-art.js"
ART_PATH.write_text("window.TSUNAMI_ART = " + json.dumps(ART, ensure_ascii=False, separators=(",", ":")) + ";\n", encoding="utf-8")
print(f"fixed regions: {len(regions)} zones x {len(KINDS)} kinds / {sum(len(paths) for z in regions.values() for paths in z.values())} paths")
