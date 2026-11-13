#!/usr/bin/env python3
"""Render telop/atlas-1080.html in Chromium and save a validated RGB PNG."""
import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
CAPTURE = ROOT / "tools" / "capture_atlas.js"
ATLAS_SIZE = (1936, 1168)


def to_rgb_png(source: Path, output: Path, atlas_size=ATLAS_SIZE, rects=()) -> None:
    with Image.open(source) as image:
        write_rgb_png(image, output, atlas_size, rects)


def write_rgb_png(image: Image.Image, output: Path, atlas_size=ATLAS_SIZE, rects=()) -> None:
    if image.size != ATLAS_SIZE:
        raise ValueError(f"expected design capture 1936x1168, got {image.size}")
    width, height = atlas_size
    if width < 640 or height < 32 or width % 16 or height % 16:
        raise ValueError("Atlas size must be 16px multiples, at least 640x32")
    rgba = image.convert("RGBA")
    if rgba.size != atlas_size:
        rgba = rgba.resize(atlas_size, Image.Resampling.LANCZOS)
    rgb = rgba.convert("RGB")
    scale_x, scale_y = width / ATLAS_SIZE[0], height / ATLAS_SIZE[1]
    for rect in rects:
        if rect.get("source", 0) != 0:
            continue
        sx, sy, sw, sh = (round(rect[key] * scale) for key, scale in
                          zip(("srcX", "srcY", "srcW", "srcH"), (scale_x, scale_y, scale_x, scale_y)))
        source_alpha = rgba.getchannel("A").crop((sx, sy, sx + sw, sy + sh))
        alpha_keys = ("alphaX", "alphaY", "alphaW", "alphaH")
        if all(key in rect for key in alpha_keys):
            ax, ay, aw, ah = (round(rect[key] * scale) for key, scale in
                              zip(alpha_keys, (scale_x, scale_y, scale_x, scale_y)))
            overlaps = sx < ax + aw and ax < sx + sw and sy < ay + ah and ay < sy + sh
            if (sw, sh) != (aw, ah) or overlaps:
                raise ValueError("alphaSrc must match src size and occupy a separate Atlas region")
            if min(sx, sy, ax, ay) < 0 or sx + sw > width or sy + sh > height or ax + aw > width or ay + ah > height:
                raise ValueError("Rect src/alphaSrc is outside the Atlas")
            rgb.paste(Image.merge("RGB", (source_alpha, source_alpha, source_alpha)), (ax, ay))
        elif (rect.get("mode", 0) == 1 or rect.get("opacity", 255) != 255 or
              source_alpha.getextrema() != (255, 255)):
            raise ValueError("transparent Rect requires an alphaSrc reservation")
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(f"{output.stem}.{os.getpid()}.tmp.png")
    rgb.save(temporary, format="PNG")
    os.replace(temporary, output)


def active_layout(state: Path) -> list:
    config = json.loads(state.read_text(encoding="utf-8")).get("atlasIIConfig", {})
    return config.get("layouts", {}).get(config.get("activeLayout"), [])


def run(state: Path, output: Path, watch: bool = False,
        interval_ms: float = 1000 / 30, browser: str | None = None, node: str = "node") -> None:
    state, output = state.resolve(), output.resolve()
    if not state.is_file():
        raise FileNotFoundError(f"state snapshot not found: {state}")
    config = json.loads(state.read_text(encoding="utf-8")).get("atlasIIConfig", {})
    atlas_size = tuple(config.get("atlasSize", ATLAS_SIZE))
    layout = active_layout(state)
    if not watch:
        with tempfile.TemporaryDirectory(prefix="atlas-capture-") as temporary:
            capture = Path(temporary) / "atlas-rgba.png"
            command = [node, str(CAPTURE), "--state", str(state), "--output", str(capture)]
            if browser:
                command.extend(("--browser", browser))
            subprocess.run(command, cwd=ROOT, check=True)
            to_rgb_png(capture, output, atlas_size, layout)
        with Image.open(output) as image:
            print(f"RGB {image.width}x{image.height}: {output}")
        return

    capture = output.with_name(f"{output.stem}.rgba.png")
    command = [node, str(CAPTURE), "--state", str(state), "--output", str(capture),
               "--watch", "--interval-ms", str(interval_ms)]
    if browser:
        command.extend(("--browser", browser))
    process = subprocess.Popen(command, cwd=ROOT, start_new_session=os.name != "nt")

    def _terminate_group() -> None:
        if os.name == "nt":
            process.terminate()
            return
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            process.terminate()

    # A plain SIGTERM kill of this process would bypass the finally block and
    # orphan capture_atlas.js (and its Chrome), which keeps overwriting the
    # capture file. Route SIGTERM through KeyboardInterrupt so cleanup runs.
    previous_sigterm = None
    if os.name != "nt":
        def _raise_interrupt(_signum, _frame):
            raise KeyboardInterrupt
        previous_sigterm = signal.signal(signal.SIGTERM, _raise_interrupt)
    last_mtime = None
    state_stamp = state.stat().st_mtime_ns
    try:
        while process.poll() is None:
            try:
                mtime = capture.stat().st_mtime_ns
                if mtime != last_mtime:
                    try:
                        current_state_stamp = state.stat().st_mtime_ns
                        if current_state_stamp != state_stamp:
                            layout = active_layout(state)
                            state_stamp = current_state_stamp
                        to_rgb_png(capture, output, atlas_size, layout)
                        last_mtime = mtime
                    except PermissionError:
                        pass
            except FileNotFoundError:
                pass
            time.sleep(min(interval_ms / 1000 / 3, 0.01))
    except KeyboardInterrupt:
        _terminate_group()
    finally:
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            if os.name != "nt":
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except (ProcessLookupError, PermissionError):
                    pass
            process.kill()
        if previous_sigterm is not None:
            signal.signal(signal.SIGTERM, previous_sigterm)
            process.wait()
        capture.unlink(missing_ok=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--watch", action="store_true", help="keep one Chromium session open and publish changed RGB PNGs")
    parser.add_argument("--interval-ms", type=float, default=1000 / 30)
    parser.add_argument("--browser", help="optional Chromium executable path")
    parser.add_argument("--node", default="node", help="Node.js executable")
    args = parser.parse_args()
    run(args.state, args.output, args.watch, args.interval_ms, args.browser, args.node)


if __name__ == "__main__":
    main()
