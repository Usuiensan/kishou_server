#!/usr/bin/env python3
"""Atlas II colour32 packet encoder and atlas-cell painter."""
import argparse
import hashlib
import json
import struct
import subprocess
import time
import zlib
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
import sys
sys.path.insert(0, str(ROOT / "protocol"))
from atlas_ii_reference import bytes_to_symbols, parse_packet

HEADER = struct.Struct("<2sBBHIQHHHHBB")
RECT = struct.Struct("<BB8H")
AREA = struct.Struct("<HBBh")
EVENT = struct.Struct("<BIHBHB")


def wire_state(snapshot: dict) -> dict:
    """Project the ingest worker snapshot into the full-state Atlas II sections."""
    if not isinstance(snapshot, dict):
        raise ValueError("Atlas state JSON must be an object")
    if "layers" not in snapshot:
        return snapshot
    layers = snapshot["layers"]
    if not all(isinstance(layers.get(key), list) for key in ("eew", "tsunami", "intensity", "vertical")):
        raise ValueError("Atlas ingest snapshot has invalid layers")
    tsunami = [0] * 66
    for entry in layers["tsunami"]:
        for index, severity in enumerate(entry.get("payload", {}).get("atlasII", [])):
            tsunami[index] = max(tsunami[index], severity)
    eew = [entry["payload"]["atlasII"] for entry in layers["eew"] if "atlasII" in entry.get("payload", {})]
    active_eew = [event for event in eew if not event.get("eventFlags", 0) & 1]
    display_options = snapshot.get("display", {})
    display = 0
    display |= int(bool(layers["intensity"] or layers["vertical"]) and display_options.get("earthquakeTelop", True))
    display |= int(bool(active_eew) and display_options.get("eewHorizontal", True)) << 1
    display |= int(bool(active_eew) and display_options.get("eewVertical", True)) << 2
    display |= int(any(tsunami) and display_options.get("tsunamiMap", True)) << 3
    display |= int(any(tsunami) and display_options.get("tsunamiLines", True)) << 4
    config = snapshot.get("atlasIIConfig", {})
    main_size = config.get("mainVideoSize", [1920, 1080])
    atlas_width, atlas_height = config.get("atlasSize", [1936, 1168])
    layouts = config.get("layouts", {})
    if layouts and config.get("activeLayout") not in layouts:
        raise ValueError(f"unknown Atlas II layout: {config.get('activeLayout')}")
    rects = (layouts[config["activeLayout"]] if config.get("activeLayout") in layouts else config.get("rects"))
    if rects is None:
        rects = [{"source": 1, "mode": 0, "visible": True, "opacity": 255,
                  "srcX": 0, "srcY": 0, "srcW": main_size[0], "srcH": main_size[1],
                  "dstX": 0, "dstY": 0, "dstW": 1920, "dstH": 1080}]
    if (atlas_width, atlas_height) != (1936, 1168):
        scale_x, scale_y = atlas_width / 1936, atlas_height / 1168
        rects = [dict(rect) for rect in rects]
        for rect in rects:
            if rect.get("source", 0) != 0:
                continue
            for key in ("srcX", "srcW", "alphaX", "alphaW"):
                if key in rect: rect[key] = round(rect[key] * scale_x)
            for key in ("srcY", "srcH", "alphaY", "alphaH"):
                if key in rect: rect[key] = round(rect[key] * scale_y)
    return {"rects": rects, "mainVideoSize": main_size, "display": int(display),
            "outputSize": config.get("outputSize", [1920, 1080]), "atlasSize": [atlas_width, atlas_height],
            "tsunami": tsunami, "eew": eew}


def encode_packet(state: dict, atlas_size: tuple[int, int], output_size=(1920, 1080),
                  sequence=0, sender_unix_ms=None) -> bytes:
    """Encode full state; state keys follow atlas-ii.md wire section names."""
    width, height = atlas_size
    rects = state.get("rects", [])
    if len(rects) > 15:
        raise ValueError("at most 15 Rects are supported")
    for rect in rects:
        if rect.get("source", 0) not in (0, 1) or rect.get("mode", 0) not in (0, 1):
            raise ValueError("Rect source/mode must be 0 or 1")
        if type(rect.get("visible", True)) is not bool:
            raise ValueError("Rect visible must be boolean")
        if type(rect.get("opacity", 255)) is not int or not 0 <= rect.get("opacity", 255) <= 255:
            raise ValueError("Rect opacity must be a byte")
        fields = ("srcX", "srcY", "srcW", "srcH", "dstX", "dstY", "dstW", "dstH")
        if any(type(rect.get(key)) is not int or not 0 <= rect[key] <= 65535 for key in fields):
            raise ValueError("Rect coordinates must be u16 integers")
        if rect.get("mode", 0) and any(type(rect.get(key)) is not int or not 0 <= rect[key] <= 65535
                for key in ("alphaX", "alphaY", "alphaW", "alphaH")):
            raise ValueError("Rect alpha coordinates must be u16 integers")
    mask = (1 if "display" in state else 0) | (2 if "tsunami" in state else 0) | (4 if "eew" in state else 0)
    body = bytearray(HEADER.pack(b"A2", 2, mask, 0, sequence & 0xFFFFFFFF,
                                 int(time.time() * 1000) if sender_unix_ms is None else sender_unix_ms,
                                 width, height, *output_size, len(rects), 0))
    for rect in rects:
        ctl = ((rect.get("source", 0) & 1) | ((rect.get("mode", 0) & 1) << 1) |
               ((1 if rect.get("visible", True) else 0) << 2))
        coords = tuple(rect[k] for k in ("srcX", "srcY", "srcW", "srcH", "dstX", "dstY", "dstW", "dstH"))
        body.extend(RECT.pack(ctl, rect.get("opacity", 255), *coords))
        if ctl & 2:
            body.extend(struct.pack("<4H", *(rect[k] for k in ("alphaX", "alphaY", "alphaW", "alphaH"))))
    if mask & 1:
        if type(state["display"]) is not int or state["display"] & ~31:
            raise ValueError("display flags must use bits 0..4")
        body.extend(struct.pack("<H", state["display"]))
    if mask & 2:
        zones = state["tsunami"]
        if len(zones) != 66:
            raise ValueError("tsunami must contain exactly 66 area states")
        packed = bytearray(17)
        for i, severity in enumerate(zones):
            if type(severity) is not int or not 0 <= severity <= 3:
                raise ValueError("tsunami severity must be 0..3")
            packed[i // 4] |= severity << (2 * (i % 4))
        body.extend(packed)
    if mask & 4:
        events = state["eew"]
        if len(events) > 255:
            raise ValueError("at most 255 EEW events are supported")
        body.extend(bytes((1, 1, len(events))))
        for event in events:
            eid = event["eventId"].encode("utf-8")
            areas = sorted(event.get("areas", []), key=lambda x: x["areaId"])
            if len(eid) > 255 or not eid or len(areas) > 65535:
                raise ValueError("invalid EEW event size")
            body.extend(EVENT.pack(event["eventFlags"], event["issueUnixSeconds"], event["serial"],
                                   event["maxScalePair"], len(areas), len(eid)))
            body.extend(eid)
            for area in areas:
                body.extend(AREA.pack(area["areaId"], area["scalePair"], area["areaFlags"], area["arrivalOffsetSeconds"]))
    total = len(body) + 4
    if total > 65535:
        raise ValueError("packet exceeds u16 wire length")
    struct.pack_into("<H", body, 4, total)
    body.extend(struct.pack("<I", zlib.crc32(body)))
    packet = bytes(body)
    parse_packet(packet, actual_atlas_size=atlas_size, actual_main_size=state.get("mainVideoSize"))
    return packet


def paint_packet(atlas: Image.Image, packet: bytes, main_video_size=None) -> Image.Image:
    """Paint LSB-first 5-bit symbols in 8x8 cells from the lower-left."""
    width, height = atlas.size
    parse_packet(packet, actual_atlas_size=(width, height), actual_main_size=main_video_size)
    symbols = bytes_to_symbols(packet)
    columns = width // 8
    result = atlas.copy()
    pixels = result.load()
    for i, symbol in enumerate(symbols):
        col, row = i % columns, i // columns
        x, y = col * 8, height - (row + 1) * 8
        color = (85 * (symbol & 3), 85 * ((symbol >> 2) & 3), 255 * ((symbol >> 4) & 1))
        for py in range(y, y + 8):
            for px in range(x, x + 8):
                pixels[px, py] = color
    return result


def read_atlas(path: Path) -> Image.Image:
    for attempt in range(10):
        try:
            with Image.open(path) as source:
                if source.mode != "RGB":
                    raise ValueError("Atlas II input must be RGB")
                return source.copy()
        except PermissionError:
            if attempt == 9:
                raise
            time.sleep(0.01)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--atlas", required=True, type=Path)
    parser.add_argument("--state", required=True, type=Path, help="JSON with rects/display/tsunami/eew sections")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--snapshot", type=Path, help="write one encoded PNG")
    mode.add_argument("--stream", action="store_true", help="publish Atlas II frames over RTSP/TCP")
    parser.add_argument("--url", default="rtsp://127.0.0.1:8554/bosai")
    parser.add_argument("--fps", type=int, default=30)
    parser.add_argument("--duration", type=float)
    parser.add_argument("--ffmpeg", default="ffmpeg")
    parser.add_argument("--output", type=Path, help="snapshot output PNG")
    parser.add_argument("--sequence", type=int, default=0)
    args = parser.parse_args()
    image = read_atlas(args.atlas)
    image_size = image.size
    if args.snapshot:
        if not args.output:
            parser.error("--snapshot requires --output")
        state = wire_state(json.loads(args.state.read_text(encoding="utf-8")))
        packet = encode_packet(state, image_size, output_size=tuple(state["outputSize"]), sequence=args.sequence)
        painted = paint_packet(image, packet, state.get("mainVideoSize"))
        args.output.parent.mkdir(parents=True, exist_ok=True)
        painted.save(args.output, format="PNG")
        print(json.dumps({"packetBytes": len(packet), "symbols": (len(packet) * 8 + 4) // 5,
                          "atlas": image_size, "crc32": packet[-4:].hex()}, ensure_ascii=False))
        return
    if args.fps <= 0 or not args.url.startswith("rtsp://"):
        parser.error("RTSP URL and positive --fps are required")
    # Fixed frame-rate grid: timestamps stay strictly monotonic. Wallclock
    # input timestamps (tried in PR #25) collided at millisecond resolution
    # and produced non-monotonic DTS, which made muxers/players drop frames.
    # Blink phase does not depend on these stamps: the renderer bakes the
    # wall-clock phase into each atlas image.
    command = [args.ffmpeg, "-hide_banner", "-loglevel", "warning", "-f", "rawvideo",
               "-pixel_format", "rgb24", "-video_size", f"{image_size[0]}x{image_size[1]}",
               "-framerate", str(args.fps), "-i", "pipe:0", "-an", "-c:v", "libx264",
               "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", "-bf", "0",
               "-rtsp_transport", "tcp", "-f", "rtsp", args.url]
    process = subprocess.Popen(command, stdin=subprocess.PIPE)
    started, next_frame, interval = time.monotonic(), time.monotonic(), 1 / args.fps
    previous, sequence, frames = None, args.sequence, 0
    current, image_stamp = image, None
    state, state_stamp = None, None
    try:
        while args.duration is None or time.monotonic() - started < args.duration:
            stamp = args.atlas.stat().st_mtime_ns
            if stamp != image_stamp:
                current = read_atlas(args.atlas)
                image_stamp = stamp
            if current.size != image_size:
                raise ValueError(f"atlas resolution changed during stream: {current.size} != {image_size}")
            stamp = args.state.stat().st_mtime_ns
            if stamp != state_stamp:
                state = wire_state(json.loads(args.state.read_text(encoding="utf-8")))
                state_stamp = stamp
                digest = hashlib.sha256(json.dumps(state, sort_keys=True).encode()).digest()
                if previous is not None and digest != previous:
                    sequence = (sequence + 1) & 0xFFFFFFFF
                previous = digest
            packet = encode_packet(state, current.size, output_size=tuple(state["outputSize"]),
                                   sequence=sequence, sender_unix_ms=int(time.time() * 1000))
            process.stdin.write(paint_packet(current, packet, state.get("mainVideoSize")).tobytes())
            frames += 1
            next_frame += interval
            delay = next_frame - time.monotonic()
            if delay > 0:
                time.sleep(delay)
            else:
                next_frame = time.monotonic()
        process.stdin.close()
        if process.wait():
            raise subprocess.CalledProcessError(process.returncode, command)
    finally:
        if process.poll() is None:
            process.terminate()
            process.wait()
        print(f"Published {frames} Atlas II frames to {args.url}")


if __name__ == "__main__":
    main()
