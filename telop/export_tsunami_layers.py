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
MIN_LAND_AREA_PX = 1.0
PREFECTURES = "北海道 青森県 岩手県 宮城県 秋田県 山形県 福島県 茨城県 栃木県 群馬県 埼玉県 千葉県 東京都 神奈川県 新潟県 富山県 石川県 福井県 山梨県 長野県 岐阜県 静岡県 愛知県 三重県 滋賀県 京都府 大阪府 兵庫県 奈良県 和歌山県 鳥取県 島根県 岡山県 広島県 山口県 徳島県 香川県 愛媛県 高知県 福岡県 佐賀県 長崎県 熊本県 大分県 宮崎県 鹿児島県 沖縄県".split()
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
    if len(island_names) != len(land):
        raise ValueError(f"Expected a name for each of {len(land)} land components, found {len(island_names)}")
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

    def project_float(points):
        return [(xoff + (lon * cos_lat - min_x) * scale,
                 yoff + (-lat - min_y) * scale) for lon, lat in points]

    def project(points):
        return [(round(x), round(y)) for x, y in project_float(points)]

    def projected_area(points):
        return abs(sum(points[i][0] * points[(i + 1) % len(points)][1] -
                       points[(i + 1) % len(points)][0] * points[i][1]
                       for i in range(len(points))) / 2)

    prefecture_land = {name: [] for name in PREFECTURES}
    for index, component in enumerate(land):
        pref = component.get("name") or "都道府県未設定"
        name = island_names[str(index)]
        float_rings = [project_float(ring) for ring in component["rings"]]
        if sum(projected_area(ring) for ring in float_rings) < MIN_LAND_AREA_PX:
            continue
        projected_rings = [[(round(x), round(y)) for x, y in ring] for ring in float_rings]
        mask = Image.new("L", (SIZE, SIZE), 0)
        draw = ImageDraw.Draw(mask)
        for points in projected_rings:
            draw.polygon(points, fill=255)
        land_rgba = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
        land_rgba.paste(Image.new("RGBA", (SIZE, SIZE), "#989898"), mask=mask)
        edge = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
        edge_draw = ImageDraw.Draw(edge)
        for points in projected_rings:
            edge_draw.line(points + [points[0]], fill="#151515", width=4, joint="curve")
        land_rgba.alpha_composite(edge)
        bbox = land_rgba.getbbox()
        prefecture_land.setdefault(pref, []).append({"name": name,
                                                     "image": land_rgba.crop(bbox), "x": bbox[0], "y": bbox[1]})

    forecast_groups = []
    for code, zone in zones.items():
        mask = Image.new("L", (SIZE, SIZE), 0)
        draw = ImageDraw.Draw(mask)
        for line in zone["lines"]:
            if len(line) >= 2:
                draw.line(project(line), fill=255, width=4, joint="curve")
        if mask.getbbox():
            forecast_groups.append(grouped(f"{code} / {zone['name']}",
                                           [layer("予報区境界線", mask, "#333333")]))

    prefecture_borders = {name: [] for name in PREFECTURES}
    subprefecture_borders = {}
    for name, lines in boundaries.items():
        mask = Image.new("L", (SIZE, SIZE), 0)
        draw = ImageDraw.Draw(mask)
        for line in lines:
            draw.line(project(line), fill=255, width=4, joint="curve")
        if mask.getbbox():
            border_layer = layer("境界線", mask, "#363636")
            if "振興局" in name:
                offices = name.removesuffix(" 境界").split("・")[1:]
                for office in offices:
                    subprefecture_borders.setdefault(office, []).append(border_layer)
            else:
                prefectures = name.removesuffix(" 境界").split("・")
                for pref, other in (prefectures, prefectures[::-1]):
                    prefecture_borders.setdefault(pref, []).append({**border_layer, "name": f"{other}との境界"})
    prefecture_groups = [
        grouped(pref, [
            grouped("陸地・島", prefecture_land[pref]),
            grouped("都道府県境界", prefecture_borders[pref]),
        ])
        for pref in PREFECTURES
    ]
    subprefecture_groups = [grouped(name, layers) for name, layers in subprefecture_borders.items()]
    return [
        grouped("都道府県別", prefecture_groups),
        grouped("北海道・振興局別", subprefecture_groups),
        grouped("津波予報区別", forecast_groups),
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
    land_layer_count = sum(len(pref["children"][0]["children"]) for pref in natural[0]["children"])
    land_component_count = len(json.loads((ROOT / "telop" / "land_components.json").read_text(encoding="utf-8")))
    prefecture_count = len(natural[0]["children"])
    subprefecture_count = len(natural[1]["children"])
    forecast_count = len(natural[2]["children"])
    prefecture_border_count = sum(len(pref["children"][1]["children"]) for pref in natural[0]["children"])
    subprefecture_border_count = sum(len(office["children"]) for office in natural[1]["children"])
    summary = [
        "# 津波ミニマップ・境界線レイヤー",
        "",
        "- キャンバス: 2000×2000 px、RGBA、OpenRaster（GIMPで開けます）",
        "- [OpenRaster（GIMP対応）](tsunami-japan-outline-2000.ora) / [透過PNGプレビュー](tsunami-japan-outline-2000.png)",
        f"- グループ: 都道府県 {prefecture_count}、北海道の振興局 {subprefecture_count}、津波予報区 {forecast_count}。各グループ内で陸地・島や境界線を個別に表示できます。",
        f"- レイヤー: 陸地 {land_layer_count}成分、都道府県境界線 {prefecture_border_count}、振興局境界線 {subprefecture_border_count}、予報区境界線 {forecast_count}。投影面積1px²未満の陸地成分{land_component_count - land_layer_count}個を除外しています。隣接地域で共有する境界線は各グループに複製しています。注意報・警報・特別警報の色線と凡例は含みません。",
        "- `land_components.json` の249成分すべてに地名を割り当て、レイヤー名にしています。島名・位置は国土地理院・海上保安庁「地名集日本 2021」、地理院地図標準地図、Wikidataの地名・座標を照合しました。人工島、半島、複数の島がつながった成分は、地図上で確認できる地名を付けています。地形は角を丸めず、座標も変形していません。",
        "- 行政界: 国土数値情報 N03-2024（北海道の振興局界を含む）、CC BY 4.0。",
        "",
        "再生成: `python telop/export_tsunami_layers.py`（`auxiliary-boundaries.json` と `island-layer-names.json` を使用。249成分分の名称がそろっていることを確認して出力します）",
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
