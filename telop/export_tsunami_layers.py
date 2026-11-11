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
    coordinates = [point for item in land for ring in item["rings"] for point in ring]
    coordinates += [point for zone in zones.values() for line in zone["lines"] for point in line]
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

    alert_children = []
    for kind in ("major", "warning", "advisory"):
        items = []
        for code, name in states[kind]:
            mask = Image.new("L", (SIZE, SIZE), 0)
            draw = ImageDraw.Draw(mask)
            width = round((4.7 if kind == "major" else 2.4) * SCALE)
            for line in zones[code]["lines"]:
                if len(line) >= 2:
                    draw.line(project(line), fill=255, width=width, joint="curve")
            items.append(layer(f"{code} / {name}", mask, COLORS[kind]))
        alert_children.append(grouped(f"{LABELS[kind]} / {len(items)}区域", items))

    islands = []
    counts = {}
    for component in land:
        name = component.get("name") or "名称未設定"
        counts[name] = counts.get(name, 0) + 1
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
        islands.append({"name": f"{name} / 陸地成分 {counts[name]:02d}",
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

    legend = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    d = ImageDraw.Draw(legend)
    font_path = Path("C:/Windows/Fonts/meiryo.ttc")
    font = ImageFont.truetype(str(font_path), 31) if font_path.exists() else ImageFont.load_default()
    d.rounded_rectangle((70, 70, 700, 330), radius=24, fill=(16, 30, 43, 225))
    for i, kind in enumerate(("major", "warning", "advisory")):
        y = 104 + i * 70
        d.rounded_rectangle((105, y, 165, y + 32), radius=6, fill=COLORS[kind])
        d.text((190, y - 4), LABELS[kind], font=font, fill="#FFFFFF")
    legend_mask = legend.getchannel("A")
    legend_layer = layer("凡例（津波情報の色）", legend_mask, "#FFFFFF")
    # Preserve the panel and lettering together as RGBA rather than a flat white mask.
    legend_layer["image"] = legend.crop((legend_mask.getbbox()[0], legend_mask.getbbox()[1],
                                          legend_mask.getbbox()[2], legend_mask.getbbox()[3]))

    background = layer("海面背景（表示用・任意）", Image.new("L", (SIZE, SIZE), 255), "#153B59")
    background["visible"] = False
    return [
        legend_layer,
        grouped("予報区境界（全66区域・初期非表示）", zone_boundaries, visible=False),
        grouped("島・陸地（自然地形成分別）", islands),
        *alert_children,
        background,
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
    OUT.mkdir(parents=True, exist_ok=True)
    art, states = load_source()
    if len(art["zoneNames"]) != 66:
        raise ValueError(f"Expected 66 forecast areas, found {len(art['zoneNames'])}")
    layers = build_layers(art, states)
    ora = OUT / "tsunami-japan-2000.ora"
    write_ora(layers, ora, "津波ミニマップ・使用例・現行レイアウト")
    natural = build_natural_layers(art, states)
    natural_ora = OUT / "tsunami-japan-natural-2000.ora"
    write_ora(natural, natural_ora, "津波ミニマップ・使用例・自然地形")
    summary = [
        "# 津波ミニマップ・レイヤー画像",
        "",
        "- キャンバス: 2000×2000 px、RGBA、OpenRaster（GIMPで開けます）",
        "- 状態: `telop/tsunami.html` の組み込み `example` デモ。実時間の発表状態ではありません。",
        "- [現行レイアウト版](tsunami-japan-2000.ora) / [透過プレビューPNG](tsunami-japan-2000.png)",
        "- 地形・区域・色帯: 現行 `tsunami-art.js` の固定パスを使用。地図形状の変更はしていません。",
        "- 陸地は既存SVGの地形パス単位で分離し、予報区境界は全66区域を個別レイヤー化（初期非表示）しています。島名データがない地形片は、島名を推定せず都道府県と番号で命名しています。",
        "- 色帯レイヤーはデモに発表設定された区域だけを種別フォルダーに収録しています。色: 注意報 `#FAF500`、警報 `#FF2800`、特別警報（大津波警報）`#C800FF`。",
        "- 透過PNGはORAと同じ初期表示状態です。ORA内の海面背景レイヤーは任意で、初期非表示です。",
        "",
        "## 自然地形版",
        "",
        "[tsunami-japan-natural-2000.ora](tsunami-japan-natural-2000.ora) は `geojson.js` 由来の陸地成分と `tzones.js` の元海岸線から作成。線形の等距離投影（代表緯度の経度補正）で一様に配置し、座標のワープ、コーナー丸め、島の再配置はしていません。表示上の簡略化として、既存 `land_components.json` の陸地成分を使っています。色帯は元海岸線に沿う線幅で描き、陸地の上へは重ねていません。レイヤー数: {sum(1 for _ in walk(natural))}。",
        "プレビュー: [tsunami-japan-natural-2000.png](tsunami-japan-natural-2000.png)",
        "",
        "再生成: `python telop/export_tsunami_layers.py`",
        "",
        f"レイヤー数（フォルダーを除く）: {sum(1 for _ in walk(layers))}",
        "",
        "注意: 現行レイアウト版は既存640×510の地図を縦横比を保って配置しています。自然地形版にも地図投影由来の歪みは残ります。",
    ]
    (OUT / "README.md").write_text("\n".join(summary) + "\n", encoding="utf-8")
    print(f"Wrote {ora} ({ora.stat().st_size:,} bytes), {sum(1 for _ in walk(layers))} layers")
    print(f"Wrote {natural_ora} ({natural_ora.stat().st_size:,} bytes), {sum(1 for _ in walk(natural))} layers")


def walk(items):
    for item in items:
        if "children" in item:
            yield from walk(item["children"])
        else:
            yield item


if __name__ == "__main__":
    main()
