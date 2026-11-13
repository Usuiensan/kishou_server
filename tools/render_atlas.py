#!/usr/bin/env python3
"""Render telop/atlas-1080.html in Chromium and save a validated RGB PNG."""
import argparse
import io
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
sys.path.insert(0, str(ROOT))
from tools.atlas_metrics import StageMetrics

CAPTURE = ROOT / "tools" / "capture_atlas.js"
ATLAS_SIZE = (1936, 1168)


def to_rgb_png(source: Path, output: Path, atlas_size=ATLAS_SIZE, rects=()) -> None:
    with Image.open(source) as image:
        write_rgb_png(image, output, atlas_size, rects)


def write_rgb_png(image: Image.Image, output: Path, atlas_size=ATLAS_SIZE,
                  rects=()) -> None:
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
        if rect.get("source", 0) != 0 or not all(key in rect for key in ("alphaX", "alphaY", "alphaW", "alphaH")):
            continue
        sx, sy, sw, sh = (round(rect[key] * scale) for key, scale in
                          zip(("srcX", "srcY", "srcW", "srcH"), (scale_x, scale_y, scale_x, scale_y)))
        ax, ay, aw, ah = (round(rect[key] * scale) for key, scale in
                          zip(("alphaX", "alphaY", "alphaW", "alphaH"), (scale_x, scale_y, scale_x, scale_y)))
        if (sw, sh) != (aw, ah) or (sx < ax + aw and ax < sx + sw and sy < ay + ah and ay < sy + sh):
            raise ValueError("alphaSrc must match src size and occupy a separate Atlas region")
        if min(sx, sy, ax, ay) < 0 or sx + sw > width or sy + sh > height or ax + aw > width or ay + ah > height:
            raise ValueError("Rect src/alphaSrc is outside the Atlas")
        mask = rgba.getchannel("A").crop((sx, sy, sx + sw, sy + sh))
        rgb.paste(Image.merge("RGB", (mask, mask, mask)), (ax, ay))
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(f"{output.stem}.{os.getpid()}.tmp.png")
    rgb.save(temporary, format="PNG")
    os.replace(temporary, output)


def active_layout(state: Path) -> list:
    config = json.loads(state.read_text(encoding="utf-8")).get("atlasIIConfig", {})
    return config.get("layouts", {}).get(config.get("activeLayout"), [])


def run(state: Path, output: Path, watch: bool = False,
        interval_ms: float = 1000 / 30, browser: str | None = None, node: str = "node",
        metrics_file: Path | None = None, capture_metrics_file: Path | None = None) -> None:
    state, output = state.resolve(), output.resolve()
    if not state.is_file():
        raise FileNotFoundError(f"state snapshot not found: {state}")
    config = json.loads(state.read_text(encoding="utf-8")).get("atlasIIConfig", {})
    atlas_size = tuple(config.get("atlasSize", ATLAS_SIZE))
    metrics = StageMetrics(metrics_file, "PNG decode, RGB conversion and atomic write") if metrics_file else None
    if not watch:
        with tempfile.TemporaryDirectory(prefix="atlas-capture-") as temporary:
            capture = Path(temporary) / "atlas-rgba.png"
            command = [node, str(CAPTURE), "--state", str(state), "--output", str(capture)]
            if browser:
                command.extend(("--browser", browser))
            if capture_metrics_file:
                command.extend(("--metrics-file", str(capture_metrics_file.resolve())))
            subprocess.run(command, cwd=ROOT, check=True)
            started = time.perf_counter()
            layout = active_layout(state)
            to_rgb_png(capture, output, atlas_size, layout)
            if metrics:
                metrics.record((time.perf_counter() - started) * 1000)
                metrics.write()
        with Image.open(output) as image:
            print(f"RGB {image.width}x{image.height}: {output}")
        return

    command = [node, str(CAPTURE), "--state", str(state), "--output", str(output),
               "--watch", "--interval-ms", str(interval_ms)]
    if capture_metrics_file:
        command.extend(("--metrics-file", str(capture_metrics_file.resolve())))
    if browser:
        command.extend(("--browser", browser))
    process = subprocess.Popen(command, cwd=ROOT, stdout=subprocess.PIPE, start_new_session=os.name != "nt")

    def _terminate_group() -> None:
        if os.name == "nt":
            process.terminate()
            return
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            process.terminate()

    # Route SIGTERM through cleanup so capture_atlas.js and Chrome exit too.
    previous_sigterm = None
    if os.name != "nt":
        def _raise_interrupt(_signum, _frame):
            raise KeyboardInterrupt
        previous_sigterm = signal.signal(signal.SIGTERM, _raise_interrupt)
    layout_stamp = state.stat().st_mtime_ns
    layout = active_layout(state)
    try:
        while True:
            header = process.stdout.read(4)
            if not header:
                break
            if len(header) != 4:
                raise RuntimeError("incomplete PNG frame header from Chromium renderer")
            length = int.from_bytes(header, "big")
            frame = process.stdout.read(length)
            if len(frame) != length:
                raise RuntimeError("incomplete PNG frame from Chromium renderer")
            conversion_started = time.perf_counter()
            with Image.open(io.BytesIO(frame)) as image:
                stamp = state.stat().st_mtime_ns
                if stamp != layout_stamp:
                    layout, layout_stamp = active_layout(state), stamp
                write_rgb_png(image, output, atlas_size, layout)
            if metrics:
                metrics.record((time.perf_counter() - conversion_started) * 1000)
        process.wait()
        if process.returncode:
            raise subprocess.CalledProcessError(process.returncode, command)
    except KeyboardInterrupt:
        _terminate_group()
    finally:
        if metrics:
            metrics.write()
        process.stdout.close()
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


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--watch", action="store_true", help="keep one Chromium session open and publish changed RGB PNGs")
    parser.add_argument("--interval-ms", type=float, default=1000 / 30)
    parser.add_argument("--browser", help="optional Chromium executable path")
    parser.add_argument("--node", default="node", help="Node.js executable")
    parser.add_argument("--metrics-file", type=Path, help="write rolling PNG-to-RGB timing metrics")
    parser.add_argument("--capture-metrics-file", type=Path, help="write Chromium capture metrics sidecar")
    args = parser.parse_args()
    run(args.state, args.output, args.watch, args.interval_ms, args.browser, args.node,
        args.metrics_file, args.capture_metrics_file)


if __name__ == "__main__":
    main()
