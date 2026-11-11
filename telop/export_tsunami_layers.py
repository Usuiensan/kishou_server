#!/usr/bin/env python3
"""Export the current tsunami demo as a 2000px OpenRaster document."""
import json
import math
import re
import zipfile
from pathlib import Path
from xml.etree.ElementTree import Element, SubElement, tostring

from PIL import Image, ImageChops, ImageDraw
from PIL import ImageFont

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "telop" / "artifacts" / "tsunami-layered-2000"
OUTLINE_OUT = ROOT / "telop" / "artifacts" / "tsunami-outline-2000"
SIZE = 2000
SCALE = SIZE / 640
Y_OFFSET = round((SIZE - 510 * SCALE) / 2)
COLORS = {"advisory": "#FAF500", "warning": "#FF2800", "major": "#C800FF"}
LABELS = {"advisory": "津波注意報", "warning": "津波警報", "major": "特別警報（大津波警報）"}


def load_source():
    art_text = (ROOT / "telop" / "tsunami-art.js").read_text(encoding="utf-8")
    prefix = "window.TSUNAMI_ART = "
    if not art_text.startswith(prefix):
        raise ValueError("Unexpected tsunami-art.js format")
    art = json.loads(art_text[len(prefix):].strip().removesuffix(";"))
    page = (ROOT / "telop" / "tsunami.html").read_text(encoding="utf-8")
    demo = re.search(r"example:\s*\{(.*?)\}\s*,\s*// 2011", page, re.S)
    if not demo:
        raise ValueError("Cannot find the current example preset in tsunami.html")
    states = {}
    for kind in COLORS:
        match = re.search(rf"\b{kind}:\s*\[(.*?)\]", demo.group(1), re.S)
        if not match:
            raise ValueError(f"Cannot find {kind} zones in the example preset")
        names = re.findall(r'"([^"\n]+)"', match.group(1))
        name_to_code = {name: code for code, name in art["zoneNames"].items()}
        missing = [name for name in names if name not in name_to_code]
        if missing:
            raise ValueError(f"Unknown {kind} zones: {missing}")
        states[kind] = [(name_to_code[name], name) for name in names]
    return art, states


def points_from_svg(d):
    tokens = re.findall(r"[MLZ]|[-+]?(?:\d*\.\d+|\d+\.?\d*)", d)
    rings, ring, command, i = [], [], None, 0
    while i < len(tokens):
        token = tokens[i]
        if token in ("M", "L", "Z"):
            command = token
            i += 1
            if command == "Z":
                if ring:
                    rings.append(ring)
                    ring = []
                continue
        if command not in ("M", "L") or i + 1 >= len(tokens):
            raise ValueError(f"Unsupported SVG path near {tokens[i:i + 4]}")
        x, y = float(tokens[i]), float(tokens[i + 1])
        point = (round(x * SCALE), round(y * SCALE + Y_OFFSET))
        if command == "M" and ring:
            rings.append(ring)
            ring = []
        ring.append(point)
        command = "L"
        i += 2
    if ring:
        rings.append(ring)
    return rings


def path_mask(paths, fill=True, stroke_width=0):
    mask = Image.new("L", (SIZE, SIZE), 0)
    for d in paths:
        rings = points_from_svg(d)
        if fill:
            # Each SVG path uses even-odd filling; toggle rings to retain holes.
            current = Image.new("L", (SIZE, SIZE), 0)
            for ring in rings:
                ring_mask = Image.new("L", (SIZE, SIZE), 0)
                ImageDraw.Draw(ring_mask).polygon(ring, fill=255)
                current = ImageChops.difference(current, ring_mask)
            mask = ImageChops.lighter(mask, current)
        if stroke_width:
            draw = ImageDraw.Draw(mask)
            for ring in rings:
                if len(ring) > 1:
                    draw.line(ring + [ring[0]], fill=255, width=stroke_width, joint="curve")
    return mask


def rgba_layer(mask, color, name):
    rgba = Image.new("RGBA", mask.size, color)
    rgba.putalpha(mask)
    bbox = mask.getbbox()
    if not bbox:
        return None
    return {"name": name, "image": rgba.crop(bbox), "x": bbox[0], "y": bbox[1]}


def grouped(name, children, visible=True):
    return {"name": name, "children": children, "visible": visible}


def layer(name, mask, color):
    result = rgba_layer(mask, color, name)
    if result is None:
        raise ValueError(f"Empty layer: {name}")
    return result


def build_layers(art, states):
    land_layers = []
    counts = {}
    for part, entries in (("本土・主図", art["landMain"]), ("島嶼・別枠", art["landInset"])):
        for item in entries:
            pref = item.get("p", "名称未設定")
            counts[pref] = counts.get(pref, 0) + 1
            outline = layer(
                f"{part} / {pref} / 地形パーツ {counts[pref]:02d}",
                path_mask([item["d"]], fill=True, stroke_width=11),
                "#989898",
            )
            land_layers.append(outline)

    zone_layers = []
    for code, zone in art["zones"].items():
        name = art["zoneNames"][code]
        mask = path_mask(zone["paths"], fill=False, stroke_width=11)
        if mask.getbbox():
            zone_layers.append(layer(f"{code} / {name}", mask, "#282828"))

    alert_groups = []
    for kind in ("major", "warning", "advisory"):
        entries = []
        for code, name in states[kind]:
            mask = path_mask(art["regions"][code][kind], fill=True)
            entries.append(layer(f"{code} / {name}", mask, COLORS[kind]))
        alert_groups.append(grouped(f"{LABELS[kind]} / {len(entries)}区域", entries))

    background = layer("海面背景（表示用・任意）", Image.new("L", (SIZE, SIZE), 255), "#153B59")
    background["visible"] = False
    return [
        grouped("予報区境界（全66区域・初期非表示）", zone_layers, visible=False),
        grouped("島・陸地（地形パーツ別）", land_layers),
        *alert_groups,
        background,
    ]


def build_natural_layers(art, states):
    """Project the untouched source coastlines uniformly; do not use tsunami-art.js paths."""
    land = json.loads((ROOT / "telop" / "land_components.json").read_text(encoding="utf-8"))
    zone_text = (ROOT / "telop" / "tzones.js").read_text(encoding="utf-8")
    prefix = "window.TZONES="
    if not zone_text.startswith(prefix):
        raise ValueError("Unexpected tzones.js format")
    zones = json.loads(zone_text[len(prefix):].strip().removesuffix(";"))
    boundaries = json.loads((OUTLINE_OUT / "auxiliary-boundaries.json").read_text(encoding="utf-8"))
    island_names = json.loads((OUTLINE_OUT / "island-layer-names.json").read_text(encoding="utf-8"))
    coordinates = [point for item in land for ring in item["rings"] for point in ring]
    coordinates += [point for zone in zones.values() for line in zone["lines"] for point in line]
    coordinates += [point for lines in boundaries.values() for line in lines for point in line]
    lon0 = (min(p[0] for p in coordinates) + max(p[0] for p in coordinates)) / 2
    lat0 = (min(p[1] for p in coordinates) + max(p[1] for p in coordinates)) / 2
    cos_lat = math.cos(math.radians(lat0))
    xs = [p[0] * cos_lat for p in coordinates]
    ys = [-p[1] for p in coordinates]
    min_x, min_y = min(xs), min(ys)
    margin = 120
    scale = min((SIZE - margin * 2) / (max(xs) - min(xs)), (SIZE - margin * 2) / (max(ys) - min(ys)))
    xoff = (SIZE - (max(xs) - min(xs)) * scale) / 2
    yoff = (SIZE - (max(ys) - min(ys)) * scale) / 2

    def project(points):
        return [(round(xoff + (lon * cos_lat - min_x) * scale),
                 round(yoff + (-lat - min_y) * scale)) for lon, lat in points]

    islands = []
    for index, component in enumerate(land):
        pref = component.get("name") or "都道府県未設定"
        name = island_names.get(str(index))
        if not name:
            points = [point for ring in component["rings"] for point in ring]
            lon = (min(point[0] for point in points) + max(point[0] for point in points)) / 2
            lat = (min(point[1] for point in points) + max(point[1] for point in points)) / 2
            name = f"名称未収録（東経{lon:.3f}°・北緯{lat:.3f}°）"
        mask = Image.new("L", (SIZE, SIZE), 0)
        draw = ImageDraw.Draw(mask)
        for ring in component["rings"]:
            points = project(ring)
            draw.polygon(points, fill=255)
        land_rgba = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
        land_rgba.paste(Image.new("RGBA", (SIZE, SIZE), "#989898"), mask=mask)
        edge = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
        edge_draw = ImageDraw.Draw(edge)
        for ring in component["rings"]:
            points = project(ring)
            edge_draw.line(points + [points[0]], fill="#151515", width=4, joint="curve")
        land_rgba.alpha_composite(edge)
        bbox = land_rgba.getbbox()
        islands.append({"name": f"{pref} / {name}",
                        "image": land_rgba.crop(bbox), "x": bbox[0], "y": bbox[1]})

    zone_boundaries = []
    for code, zone in zones.items():
        mask = Image.new("L", (SIZE, SIZE), 0)
        draw = ImageDraw.Draw(mask)
        for line in zone["lines"]:
            if len(line) >= 2:
                draw.line(project(line), fill=255, width=4, joint="curve")
        if mask.getbbox():
            zone_boundaries.append(layer(f"{code} / {zone['name']}", mask, "#333333"))

    prefecture_lines, subprefecture_lines = [], []
    for name, lines in boundaries.items():
        mask = Image.new("L", (SIZE, SIZE), 0)
        draw = ImageDraw.Draw(mask)
        for line in lines:
            draw.line(project(line), fill=255, width=4, joint="curve")
        if mask.getbbox():
            target = subprefecture_lines if name.startswith("北海道・") else prefecture_lines
            target.append(layer(name, mask, "#363636"))
    return [
        grouped("補助線 / 予報区境界（全66区域）", zone_boundaries),
        grouped("補助線 / 都道府県境", prefecture_lines),
        grouped("補助線 / 北海道・振興局境", subprefecture_lines),
        grouped("島・陸地（自然地形成分別）", islands),
    ]


def write_ora(layers, out_path, title):
    root = Element("image", {"version": "0.0.3", "w": str(SIZE), "h": str(SIZE), "name": title})
    stack = SubElement(root, "stack", {"name": "root"})
    flattened = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    layer_number = 0
    files = {}

    def add_items(parent, items):
        nonlocal layer_number
        for item in items:
            if "children" in item:
                folder = SubElement(parent, "stack", {
                    "name": item["name"], "visibility": "visible" if item.get("visible", True) else "hidden",
                    "opacity": "1.0", "composite-op": "svg:src-over",
                })
                add_items(folder, item["children"])
                continue
            layer_number += 1
            filename = f"data/layer{layer_number:04d}.png"
            files[filename] = item["image"]
            SubElement(parent, "layer", {
                "name": item["name"], "src": filename,
                "x": str(item["x"]), "y": str(item["y"]),
                "opacity": "1.0", "visibility": "visible" if item.get("visible", True) else "hidden",
                "composite-op": "svg:src-over",
            })

    add_items(stack, layers)

    def composite(items, enabled=True):
        for item in reversed(items):
            if not enabled or not item.get("visible", True):
                continue
            if "children" in item:
                composite(item["children"])
            else:
                flattened.alpha_composite(item["image"], (item["x"], item["y"]))

    composite(layers)
    thumb = flattened.copy()
    thumb.thumbnail((256, 256), Image.Resampling.LANCZOS)
    with zipfile.ZipFile(out_path, "w") as archive:
        archive.writestr("mimetype", "image/openraster", compress_type=zipfile.ZIP_STORED)
        archive.writestr("stack.xml", tostring(root, encoding="utf-8", xml_declaration=True))
        for filename, image in files.items():
            from io import BytesIO
            buffer = BytesIO()
            image.save(buffer, format="PNG", optimize=True)
            archive.writestr(filename, buffer.getvalue(), compress_type=zipfile.ZIP_STORED)
        buffer = __import__("io").BytesIO()
        flattened.save(buffer, format="PNG", optimize=True)
        archive.writestr("mergedimage.png", buffer.getvalue(), compress_type=zipfile.ZIP_STORED)
        buffer = __import__("io").BytesIO()
        thumb.save(buffer, format="PNG", optimize=True)
        archive.writestr(" Thumbnails/thumbnail.png".strip(), buffer.getvalue(), compress_type=zipfile.ZIP_STORED)
    flattened.save(out_path.with_suffix(".png"), format="PNG", optimize=True)


def main():
    OUTLINE_OUT.mkdir(parents=True, exist_ok=True)
    art, states = load_source()
    if len(art["zoneNames"]) != 66:
        raise ValueError(f"Expected 66 forecast areas, found {len(art['zoneNames'])}")
    natural = build_natural_layers(art, states)
    natural_ora = OUTLINE_OUT / "tsunami-japan-outline-2000.ora"
    write_ora(natural, natural_ora, "津波ミニマップ・陸地と境界線")
    summary = [
        "# 津波ミニマップ・境界線レイヤー",
        "",
        "- キャンバス: 2000×2000 px、RGBA、OpenRaster（GIMPで開けます）",
        "- [OpenRaster（GIMP対応）](tsunami-japan-outline-2000.ora) / [透過PNGプレビュー](tsunami-japan-outline-2000.png)",
        "- レイヤー: 陸地成分、津波予報区境界66区域、都道府県どうしの境界、北海道の振興局どうしの境界。注意報・警報・特別警報の色線と凡例は含みません。",
        "- 地形は `land_components.json` と `tzones.js` の座標を同じ線形等距離投影で描画し、角の丸め・地形変形はしていません。島名の網羅的な対応表が既存データにないため、陸地成分レイヤーは都道府県名と成分番号で識別します。",
        "- 行政界: 国土数値情報 N03-2024（北海道の振興局界を含む）、CC BY 4.0。",
        "",
        "再生成: `python telop/export_tsunami_layers.py`（補助境界データは `auxiliary-boundaries.json` を使用）",
        "",
        f"レイヤー数（フォルダーを除く）: {sum(1 for _ in walk(natural))}",
    ]
    (OUTLINE_OUT / "README.md").write_text("\n".join(summary) + "\n", encoding="utf-8")
    print(f"Wrote {natural_ora} ({natural_ora.stat().st_size:,} bytes), {sum(1 for _ in walk(natural))} layers")


def walk(items):
    for item in items:
        if "children" in item:
            yield from walk(item["children"])
        else:
            yield item


if __name__ == "__main__":
    main()
