#!/usr/bin/env python3
"""Fixed-pair overlay sender (see protocol/overlay-fixed.md).

Reads length-prefixed PNG frames (4-byte big-endian length + PNG bytes, the
same framing capture_atlas.js emits) from stdin. Each frame must be a
1270x720 RGBA telop canvas. Frames are stacked into a 1270x1440 image
(top: RGB, bottom: alpha as grayscale), throttled to the target fps, and
published over RTSP through ffmpeg.
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

OVERLAY_WIDTH = 1270
OVERLAY_HEIGHT = 720
FRAME_WIDTH = 1270
FRAME_HEIGHT = 1440
DEFAULT_FPS = 2

# Match the Atlas II sender: untagged BT.601 conversion corrupts colours.
FFMPEG_COLOR_ARGS = ["-vf", "scale=out_color_matrix=bt709:out_range=tv",
                     "-colorspace", "bt709", "-color_primaries", "bt709",
                     "-color_trc", "bt709", "-color_range", "tv"]


def compose_overlay(frame: Image.Image) -> Image.Image:
    """Stack a 1270x720 RGBA telop canvas into the fixed 1270x1440 pair."""
    if frame.size != (OVERLAY_WIDTH, OVERLAY_HEIGHT):
        raise ValueError(
            f"overlay canvas must be {OVERLAY_WIDTH}x{OVERLAY_HEIGHT}, got {frame.size}")
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
    """Compose and forward frames, dropping frames above the fps budget.

    Returns the number of frames forwarded. The first frame is always
    forwarded so a static telop still reaches receivers.
    """
    interval = 1.0 / fps
    next_due = None
    forwarded = 0
    while True:
        frame = read_frame(source)
        if frame is None:
            return forwarded
        moment = now()
        if next_due is not None and moment < next_due:
            continue
        sink.write(compose_overlay(frame).tobytes())
        sink.flush()
        forwarded += 1
        next_due = moment + interval if next_due is None else max(next_due + interval, moment)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", required=True, help="RTSP publish URL")
    parser.add_argument("--fps", type=int, default=DEFAULT_FPS)
    args = parser.parse_args()
    if args.fps <= 0 or not args.url.startswith("rtsp://"):
        parser.error("RTSP URL and positive --fps are required")
    process = subprocess.Popen(ffmpeg_command(args.url, args.fps), stdin=subprocess.PIPE)
    try:
        stream_frames(sys.stdin.buffer, process.stdin, args.fps)
    finally:
        if process.stdin:
            process.stdin.close()
        process.wait()


if __name__ == "__main__":
    main()
