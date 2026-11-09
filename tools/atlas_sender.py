#!/usr/bin/env python3
"""Compose v8 metadata over a rendered atlas PNG and publish it via FFmpeg."""
import argparse
from dataclasses import replace
import hashlib
import json
import os
import subprocess
import sys
import time
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "reference"))
from metadata_demo import State, encode, paint_packet  # noqa: E402
from validate_atlas import ATLAS  # noqa: E402


def compose_atlas(source: Image.Image, state: State) -> Image.Image:
    """Copy an RGB v8 atlas and paint the protocol's three metadata rows."""
    if source.size != ATLAS:
        raise ValueError(f"atlas must be 1936x1168, got {source.width}x{source.height}")
    if source.mode != "RGB":
        raise ValueError(f"atlas must be RGB, got {source.mode}")
    return paint_packet(source.copy(), encode(state))


def ffmpeg_publish_command(url: str, fps: int = 30, crf: int = 23,
                           maxrate: str = "3000k", bufsize: str = "1500k",
                           ffmpeg: str = "ffmpeg") -> list[str]:
    if fps <= 0:
        raise ValueError("fps must be positive")
    if not url.startswith("rtsp://"):
        raise ValueError("publish URL must use rtsp://")
    return [
        ffmpeg, "-hide_banner", "-loglevel", "warning",
        "-f", "rawvideo", "-pixel_format", "rgb24", "-video_size",
        f"{ATLAS[0]}x{ATLAS[1]}", "-framerate", str(fps), "-i", "pipe:0",
        "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", str(crf),
        "-maxrate", maxrate, "-bufsize", bufsize, "-pix_fmt", "yuv420p",
        "-profile:v", "high", "-level:v", "5.0", "-g", str(fps),
        "-keyint_min", str(fps), "-sc_threshold", "0", "-bf", "0",
        "-x264-params", "sliced-threads=0:repeat-headers=1",
        "-rtsp_transport", "tcp", "-f", "rtsp", url,
    ]


def load_atlas(path: Path) -> Image.Image:
    with Image.open(path) as image:
        if image.size != ATLAS:
            raise ValueError(f"atlas must be 1936x1168, got {image.width}x{image.height}")
        if image.mode != "RGB":
            raise ValueError(f"atlas must be RGB, got {image.mode}")
        return image.copy()


def write_snapshot(atlas_path: Path, output_path: Path, state: State) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    compose_atlas(load_atlas(atlas_path), state).save(output_path, format="PNG")


def load_state_values(path: Path, fallback: State) -> tuple[int, int, int, int, int]:
    values = {"flags": fallback.flags, "mode": fallback.mode,
              "opacity": fallback.opacity, "lower_x": fallback.lower_x,
              "lower_y": fallback.lower_y}
    if path.exists():
        supplied = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(supplied, dict) or set(supplied) - set(values):
            raise ValueError("state JSON must contain only flags, mode, opacity, lower_x, lower_y")
        values.update(supplied)
    limits = {"flags": 0xFF, "mode": 0xFF, "opacity": 0xFF,
              "lower_x": 0xFFFF, "lower_y": 0xFFFF}
    for name, value in values.items():
        if type(value) is not int or not 0 <= value <= limits[name]:
            raise ValueError(f"state field {name} must be an integer from 0 to {limits[name]}")
    return tuple(values[name] for name in ("flags", "mode", "opacity", "lower_x", "lower_y"))


def next_frame_deadline(previous: float, now: float, interval: float) -> tuple[float, int]:
    deadline = previous + interval
    if deadline > now:
        return deadline, 0
    skipped = int((now - deadline) // interval) + 1
    return deadline + skipped * interval, skipped


def sequence_for_display(sequence: int, previous_digest: str | None, current_digest: str) -> tuple[int, bool]:
    if previous_digest is None or previous_digest == current_digest:
        return sequence, False
    return (sequence + 1) & 0xFFFFFFFF, True


def display_fingerprint(pixels: bytes, controls: tuple[int, int, int, int, int]) -> str:
    digest = hashlib.sha256(pixels)
    digest.update(bytes(controls[:3]))
    digest.update(controls[3].to_bytes(2, 'little'))
    digest.update(controls[4].to_bytes(2, 'little'))
    return digest.hexdigest()


def save_sequence_state(path: Path, sequence: int, digest: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps({"sequence": sequence, "displaySha256": digest}) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def publish(atlas_path: Path, url: str, state: State, fps: int = 30,
            duration: float | None = None, ffmpeg: str = "ffmpeg",
            state_path: Path | None = None, sequence_state_path: Path | None = None) -> None:
    base = load_atlas(atlas_path)
    last_pixels = base.tobytes()
    last_mtime = atlas_path.stat().st_mtime_ns
    last_controls = load_state_values(state_path, state) if state_path else (
        state.flags, state.mode, state.opacity, state.lower_x, state.lower_y)
    last_state_mtime = state_path.stat().st_mtime_ns if state_path and state_path.exists() else None
    sequence = state.sequence
    fingerprint = display_fingerprint(last_pixels, last_controls)
    previous_fingerprint = None
    if sequence_state_path and sequence_state_path.exists():
        saved = json.loads(sequence_state_path.read_text(encoding="utf-8"))
        sequence = saved.get("sequence")
        previous_fingerprint = saved.get("displaySha256")
        if type(sequence) is not int or not 0 <= sequence <= 0xFFFFFFFF or not isinstance(previous_fingerprint, str):
            raise ValueError("sequence state file is invalid")
        sequence, changed_on_restart = sequence_for_display(sequence, previous_fingerprint, fingerprint)
        if changed_on_restart:
            save_sequence_state(sequence_state_path, sequence, fingerprint)
    elif sequence_state_path:
        save_sequence_state(sequence_state_path, sequence, fingerprint)
    command = ffmpeg_publish_command(url, fps=fps, ffmpeg=ffmpeg)
    process = subprocess.Popen(command, stdin=subprocess.PIPE)
    started = time.monotonic()
    next_frame = started
    frame_number = 0
    dropped_frames = 0
    interval = 1 / fps
    try:
        while duration is None or time.monotonic() - started < duration:
            now = time.time()
            mtime = atlas_path.stat().st_mtime_ns
            changed = False
            if mtime != last_mtime:
                latest = load_atlas(atlas_path)
                latest_pixels = latest.tobytes()
                if latest_pixels != last_pixels:
                    changed = True
                    base, last_pixels = latest, latest_pixels
                last_mtime = mtime
            controls = last_controls
            if state_path:
                state_mtime = state_path.stat().st_mtime_ns if state_path.exists() else None
                if state_mtime != last_state_mtime:
                    controls = load_state_values(state_path, state)
                    changed = changed or controls != last_controls
                    last_controls, last_state_mtime = controls, state_mtime
            if changed:
                sequence = (sequence + 1) & 0xFFFFFFFF
                fingerprint = display_fingerprint(last_pixels, controls)
                if sequence_state_path:
                    save_sequence_state(sequence_state_path, sequence, fingerprint)
            frame_state = replace(state, sequence=sequence, timestamp=int(now),
                                  flags=controls[0], mode=controls[1],
                                  opacity=controls[2], lower_x=controls[3],
                                  lower_y=controls[4])
            process.stdin.write(compose_atlas(base, frame_state).tobytes())
            frame_number += 1
            next_frame, skipped = next_frame_deadline(next_frame, time.monotonic(), interval)
            dropped_frames += skipped
            delay = next_frame - time.monotonic()
            if delay > 0:
                time.sleep(delay)
        process.stdin.close()
        code = process.wait()
        if code:
            raise subprocess.CalledProcessError(code, command)
    except (BrokenPipeError, OSError):
        if process.poll() is None:
            process.terminate()
        raise
    finally:
        if process.poll() is None:
            process.terminate()
            process.wait()
        elapsed = time.monotonic() - started
        print(f"Published {frame_number} frames to {url}; {frame_number / elapsed:.2f} fps, skipped {dropped_frames} frame slots")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--atlas", required=True, type=Path,
                        help="RGB PNG rendered at exactly 1936x1168")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--snapshot", type=Path, help="write one metadata-composited PNG")
    mode.add_argument("--stream", action="store_true", help="publish to MediaMTX via FFmpeg")
    parser.add_argument("--url", default="rtsp://127.0.0.1:8554/atlas")
    parser.add_argument("--fps", type=int, default=30)
    parser.add_argument("--duration", type=float, help="stop after N seconds (smoke tests)")
    parser.add_argument("--state-json", type=Path,
                        help="optional atomic JSON sidecar for flags/mode/opacity/lower_x/lower_y")
    parser.add_argument("--sequence-state", type=Path,
                        help="persist sequence and rendered-state digest across sender restarts")
    parser.add_argument("--sequence", type=int, default=1)
    parser.add_argument("--flags", type=int, default=15)
    parser.add_argument("--mode", type=int, default=1,
                        help="v8 control-packet mode; not an emergency-information layer selector")
    parser.add_argument("--opacity", type=int, default=255)
    parser.add_argument("--lower-x", type=int, default=281)
    parser.add_argument("--lower-y", type=int, default=619)
    parser.add_argument("--timestamp", type=int, default=0,
                        help="snapshot timestamp; live mode always uses current Unix seconds")
    parser.add_argument("--ffmpeg", default="ffmpeg")
    args = parser.parse_args()
    state = State(sequence=args.sequence, flags=args.flags, mode=args.mode,
                  opacity=args.opacity, lower_x=args.lower_x, lower_y=args.lower_y,
                  timestamp=args.timestamp)
    if args.snapshot:
        write_snapshot(args.atlas, args.snapshot, state)
    else:
        publish(args.atlas, args.url, state, args.fps, args.duration, args.ffmpeg,
                args.state_json, args.sequence_state)


if __name__ == "__main__":
    main()
