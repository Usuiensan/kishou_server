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


def to_rgb_png(source: Path, output: Path, atlas_size=ATLAS_SIZE) -> None:
    with Image.open(source) as image:
        if image.size != ATLAS_SIZE:
            raise ValueError(f"expected design capture 1936x1168, got {image.size}")
        rgb = image.convert("RGB")
    width, height = atlas_size
    if width < 640 or height < 32 or width % 16 or height % 16:
        raise ValueError("Atlas size must be 16px multiples, at least 640x32")
    if rgb.size != atlas_size:
        rgb = rgb.resize(atlas_size, Image.Resampling.LANCZOS)
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(f"{output.stem}.{os.getpid()}.tmp.png")
    rgb.save(temporary, format="PNG")
    os.replace(temporary, output)


def run(state: Path, output: Path, watch: bool = False,
        interval_ms: float = 1000 / 30, browser: str | None = None, node: str = "node") -> None:
    state, output = state.resolve(), output.resolve()
    if not state.is_file():
        raise FileNotFoundError(f"state snapshot not found: {state}")
    config = json.loads(state.read_text(encoding="utf-8")).get("atlasIIConfig", {})
    atlas_size = tuple(config.get("atlasSize", ATLAS_SIZE))
    if not watch:
        with tempfile.TemporaryDirectory(prefix="atlas-capture-") as temporary:
            capture = Path(temporary) / "atlas-rgba.png"
            command = [node, str(CAPTURE), "--state", str(state), "--output", str(capture)]
            if browser:
                command.extend(("--browser", browser))
            subprocess.run(command, cwd=ROOT, check=True)
            to_rgb_png(capture, output, atlas_size)
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
    try:
        while process.poll() is None:
            try:
                mtime = capture.stat().st_mtime_ns
                if mtime != last_mtime:
                    try:
                        to_rgb_png(capture, output, atlas_size)
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
