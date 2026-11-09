#!/usr/bin/env python3
"""Render telop/atlas-1080.html in Chromium and save a validated RGB PNG."""
import argparse
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
CAPTURE = ROOT / "tools" / "capture_atlas.js"
ATLAS_SIZE = (1936, 1168)


def to_rgb_png(source: Path, output: Path) -> None:
    with Image.open(source) as image:
        if image.size != ATLAS_SIZE:
            raise ValueError(f"expected 1936x1168 capture, got {image.size}")
        rgb = image.convert("RGB")
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(f"{output.stem}.{os.getpid()}.tmp.png")
    rgb.save(temporary, format="PNG")
    os.replace(temporary, output)


def run(state: Path, output: Path, watch: bool = False,
        interval_ms: float = 1000 / 30, browser: str | None = None) -> None:
    state, output = state.resolve(), output.resolve()
    if not state.is_file():
        raise FileNotFoundError(f"state snapshot not found: {state}")
    if not watch:
        with tempfile.TemporaryDirectory(prefix="atlas-capture-") as temporary:
            capture = Path(temporary) / "atlas-rgba.png"
            command = ["node", str(CAPTURE), "--state", str(state), "--output", str(capture)]
            if browser:
                command.extend(("--browser", browser))
            subprocess.run(command, cwd=ROOT, check=True)
            to_rgb_png(capture, output)
        with Image.open(output) as image:
            print(f"RGB {image.width}x{image.height}: {output}")
        return

    capture = output.with_name(f"{output.stem}.rgba.png")
    command = ["node", str(CAPTURE), "--state", str(state), "--output", str(capture),
               "--watch", "--interval-ms", str(interval_ms)]
    if browser:
        command.extend(("--browser", browser))
    process = subprocess.Popen(command, cwd=ROOT)
    last_mtime = None
    try:
        while process.poll() is None:
            try:
                mtime = capture.stat().st_mtime_ns
                if mtime != last_mtime:
                    to_rgb_png(capture, output)
                    last_mtime = mtime
            except FileNotFoundError:
                pass
            time.sleep(min(interval_ms / 1000 / 3, 0.01))
    except KeyboardInterrupt:
        process.terminate()
    finally:
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
        capture.unlink(missing_ok=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--watch", action="store_true", help="keep one Chromium session open and publish changed RGB PNGs")
    parser.add_argument("--interval-ms", type=float, default=1000 / 30)
    parser.add_argument("--browser", help="optional Chromium executable path")
    args = parser.parse_args()
    run(args.state, args.output, args.watch, args.interval_ms, args.browser)


if __name__ == "__main__":
    main()
