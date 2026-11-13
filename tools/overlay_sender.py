#!/usr/bin/env python3
"""Fixed-pair overlay sender (see protocol/overlay-fixed.md).

Frames are length-prefixed PNG (4-byte big-endian length + PNG bytes, the
same framing capture_atlas.js emits). With --state, frames come from
tools/capture_overlay.js, which this process spawns; it renders only the
overlay elements (horizontal EEW box and the top two-line telop) from the
shared atlas state snapshot at 1920x1080. Without --state, frames are read
from stdin instead. Each frame is downscaled to a 1280x720 RGBA telop
canvas, stacked into a 1280x1440 image (top: RGB, bottom: alpha as
grayscale), throttled to the target fps, and published over RTSP through
ffmpeg.
"""
import argparse
import struct
import subprocess
import sys
import time
from io import BytesIO
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]

OVERLAY_WIDTH = 1280
OVERLAY_HEIGHT = 720
FRAME_WIDTH = 1280
FRAME_HEIGHT = 1440
DEFAULT_FPS = 2

# Match the Atlas II sender: untagged BT.601 conversion corrupts colours.
FFMPEG_COLOR_ARGS = ["-vf", "scale=out_color_matrix=bt709:out_range=tv",
                     "-colorspace", "bt709", "-color_primaries", "bt709",
                     "-color_trc", "bt709", "-color_range", "tv"]


CAPTURE_WIDTH = 1920
CAPTURE_HEIGHT = 1080


def compose_overlay(frame: Image.Image) -> Image.Image:
    """Stack a telop canvas into the fixed 1280x1440 pair.

    Accepts the capture size (1920x1080) or the overlay size (1280x720);
    the capture size is downscaled first. Anything else is rejected.
    """
    if frame.size == (CAPTURE_WIDTH, CAPTURE_HEIGHT):
        # Resize colour and alpha separately: a joint RGBA resize goes
        # through premultiplied alpha and shifts solid colours by one step.
        source = frame.convert("RGBA")
        rgb = source.convert("RGB").resize((OVERLAY_WIDTH, OVERLAY_HEIGHT), Image.LANCZOS)
        alpha = source.getchannel("A").resize((OVERLAY_WIDTH, OVERLAY_HEIGHT), Image.LANCZOS)
        stacked = Image.new("RGB", (FRAME_WIDTH, FRAME_HEIGHT))
        stacked.paste(rgb, (0, 0))
        stacked.paste(alpha.convert("RGB"), (0, OVERLAY_HEIGHT))
        return stacked
    if frame.size != (OVERLAY_WIDTH, OVERLAY_HEIGHT):
        raise ValueError(
            f"overlay canvas must be {CAPTURE_WIDTH}x{CAPTURE_HEIGHT} or "
            f"{OVERLAY_WIDTH}x{OVERLAY_HEIGHT}, got {frame.size}")
    rgba = frame.convert("RGBA")
    rgb = rgba.convert("RGB")
    alpha = rgba.getchannel("A").convert("RGB")
    stacked = Image.new("RGB", (FRAME_WIDTH, FRAME_HEIGHT))
    stacked.paste(rgb, (0, 0))
    stacked.paste(alpha, (0, OVERLAY_HEIGHT))
    return stacked


def read_frame(stream) -> Image.Image | None:
    """Read one length-prefixed PNG frame; None at clean EOF."""
    header = stream.read(4)
    if not header:
        return None
    if len(header) != 4:
        raise ValueError("truncated frame header")
    (length,) = struct.unpack(">I", header)
    payload = stream.read(length)
    if len(payload) != length:
        raise ValueError("truncated frame payload")
    return Image.open(BytesIO(payload))


def ffmpeg_command(url: str, fps: int) -> list[str]:
    return ["ffmpeg", "-hide_banner", "-loglevel", "warning",
            "-f", "rawvideo", "-pix_fmt", "rgb24",
            "-s", f"{FRAME_WIDTH}x{FRAME_HEIGHT}", "-r", str(fps),
            "-i", "pipe:0", "-an", "-c:v", "libx264",
            "-pix_fmt", "yuv420p", "-preset", "veryfast",
            "-g", str(fps * 2), *FFMPEG_COLOR_ARGS,
            "-f", "rtsp", url]


def stream_frames(source, sink, fps: int, now=time.monotonic) -> int:
    """Publish at a constant fps, repeating the latest frame between updates.

    The capture only emits a frame when the telop changes, so forwarding
    one-for-one would starve the RTSP session (MediaMTX drops publishers
    that send nothing). A reader thread keeps the newest composed frame;
    the main loop writes it every interval. Returns the number of frames
    written when the source reaches EOF.
    """
    import threading

    interval = 1.0 / fps
    latest: dict = {"frame": None, "done": False, "error": None}

    def reader() -> None:
        try:
            while True:
                frame = read_frame(source)
                if frame is None:
                    break
                latest["frame"] = compose_overlay(frame)
        except Exception as error:  # surfaced on the main thread below
            latest["error"] = error
        finally:
            latest["done"] = True

    threading.Thread(target=reader, daemon=True).start()
    forwarded = 0
    next_due = now()
    while not latest["done"]:
        if latest["error"] is not None:
            raise latest["error"]
        frame = latest["frame"]
        if frame is not None:
            sink.write(frame.tobytes())
            sink.flush()
            forwarded += 1
        next_due += interval
        delay = next_due - now()
        if delay > 0:
            time.sleep(delay)
        else:
            next_due = now()
    if latest["error"] is not None:
        raise latest["error"]
    if latest["frame"] is not None:
        sink.write(latest["frame"].tobytes())
        sink.flush()
        forwarded += 1
    return forwarded


def capture_command(node: str, state: Path, browser: str | None) -> list[str]:
    command = [node, str(ROOT / "tools" / "capture_overlay.js"),
               "--state", str(state)]
    if browser:
        command += ["--browser", browser]
    return command


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", required=True, help="RTSP publish URL")
    parser.add_argument("--fps", type=int, default=DEFAULT_FPS)
    parser.add_argument("--ffmpeg", default="ffmpeg")
    parser.add_argument("--state", type=Path,
                        help="atlas state snapshot; spawns capture_overlay.js as the frame source")
    parser.add_argument("--node", default="node")
    parser.add_argument("--browser")
    args = parser.parse_args()
    if args.fps <= 0 or not args.url.startswith("rtsp://"):
        parser.error("RTSP URL and positive --fps are required")
    command = ffmpeg_command(args.url, args.fps)
    command[0] = args.ffmpeg
    process = subprocess.Popen(command, stdin=subprocess.PIPE)
    capture = None
    source = sys.stdin.buffer
    if args.state:
        capture = subprocess.Popen(
            capture_command(args.node, args.state, args.browser),
            stdout=subprocess.PIPE)
        source = capture.stdout
    try:
        stream_frames(source, process.stdin, args.fps)
    finally:
        if capture is not None:
            capture.terminate()
            capture.wait()
        if process.stdin:
            process.stdin.close()
        process.wait()


if __name__ == "__main__":
    main()
