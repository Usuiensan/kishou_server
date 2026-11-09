#!/usr/bin/env python3
"""Create a synthetic atlas PNG and verify the metadata through H.264."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "reference"))
sys.path.insert(0, str(ROOT / "tools"))
from metadata_demo import State, read_image, read_row, sample_atlas  # noqa: E402
from validate_atlas import ATLAS  # noqa: E402
from atlas_sender import compose_atlas  # noqa: E402


def decode_metadata_frames(video_path: Path, ffmpeg: str = "ffmpeg", include_rows: bool = False):
    crop_width, crop_height = 384, 24
    crop_size = crop_width * crop_height * 3
    decode_command = [ffmpeg, "-hide_banner", "-loglevel", "error", "-i", str(video_path),
                      "-vf", "crop=384:24:8:1131", "-f", "rawvideo",
                      "-pix_fmt", "rgb24", "pipe:1"]
    decoded = subprocess.run(decode_command, check=True, capture_output=True).stdout
    if len(decoded) % crop_size:
        raise AssertionError(f"decoded metadata crop has partial frame: {len(decoded)} bytes")
    states = []
    row_results = []
    for frame, offset in enumerate(range(0, len(decoded), crop_size)):
        crop = Image.frombytes("RGB", (crop_width, crop_height),
                               decoded[offset:offset + crop_size])
        rows = []
        errors = []
        for row in range(3):
            atlas = Image.new("RGB", ATLAS)
            atlas.paste(crop.crop((0, row * 8, crop_width, (row + 1) * 8)),
                        (8, 1131 + row * 8))
            try:
                rows.append(read_row(atlas, row))
            except ValueError as error:
                rows.append(None)
                errors.append({"row": row, "error": str(error)})
        valid = [state for state in rows if state is not None]
        if not valid:
            raise AssertionError(f"frame {frame}: all metadata rows failed CRC: {errors}")
        if any(state != valid[0] for state in valid[1:]):
            raise AssertionError(f"frame {frame}: valid metadata replicas disagree: {rows!r}")
        states.append(valid[0])
        row_results.append({"valid": len(valid), "errors": errors})
    return (states, row_results) if include_rows else states


def run(ffmpeg: str = "ffmpeg", ffprobe: str = "ffprobe",
        output_dir: Path = ROOT / "tests" / "results") -> dict:
    output_dir.mkdir(parents=True, exist_ok=True)
    png_path = output_dir / "atlas-synthetic-composite.png"
    video_path = output_dir / "atlas-codec-test.mp4"
    log_path = output_dir / "atlas-codec-test.txt"
    base = sample_atlas()
    initial = State(sequence=100, flags=15, mode=1, opacity=255,
                    lower_x=281, lower_y=619, timestamp=1794166800)
    first = compose_atlas(base, initial)
    first.save(png_path, format="PNG")
    if read_image(first) != initial:
        raise AssertionError("synthetic composite PNG failed metadata readback")

    changed_base = base.copy()
    changed_base.paste((180, 45, 35), (297, 651, 1936, 1112))
    updated = State(sequence=101, flags=7, mode=1, opacity=255,
                    lower_x=281, lower_y=619, timestamp=1794166801)
    input_hash = hashlib.sha256()
    frame_count = 60
    command = [ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
               "-f", "rawvideo", "-pixel_format", "rgb24", "-video_size",
               f"{ATLAS[0]}x{ATLAS[1]}", "-framerate", "30", "-i", "pipe:0",
               "-frames:v", str(frame_count), "-an", "-c:v", "libx264",
               "-preset", "veryfast", "-crf", "23", "-maxrate", "3000k",
               "-bufsize", "1500k", "-pix_fmt", "yuv420p", "-profile:v", "high",
               "-level:v", "5.0", "-g", "30", "-keyint_min", "30",
               "-sc_threshold", "0", "-bf", "0", "-x264-params",
               "sliced-threads=0:repeat-headers=1", "-movflags", "+faststart",
               str(video_path)]
    with subprocess.Popen(command, stdin=subprocess.PIPE, stderr=subprocess.PIPE) as encoder:
        for index in range(frame_count):
            state = initial if index < 30 else updated
            frame = compose_atlas(base if index < 30 else changed_base, state)
            raw = frame.tobytes()
            input_hash.update(raw)
            encoder.stdin.write(raw)
        encoder.stdin.close()
        stderr = encoder.stderr.read()
        status = encoder.wait()
    if status:
        raise subprocess.CalledProcessError(status, command, stderr=stderr)

    actual_states = decode_metadata_frames(video_path, ffmpeg)
    got_frames = len(actual_states)
    if got_frames != frame_count:
        raise AssertionError(f"expected {frame_count} decoded frames, got {got_frames}")
    for index, actual in enumerate(actual_states):
        expected = initial if index < 30 else updated
        if actual != expected:
            raise AssertionError(f"frame {index}: {actual!r} != {expected!r}")

    probe_command = [ffprobe, "-v", "error", "-show_entries",
                     "stream=codec_name,pix_fmt,width,height,level,has_b_frames,avg_frame_rate",
                     "-show_entries", "format=duration,size,bit_rate", "-of", "json",
                     str(video_path)]
    probe = json.loads(subprocess.run(probe_command, check=True, capture_output=True,
                                     text=True).stdout)
    result = {
        "ffmpeg": subprocess.run([ffmpeg, "-version"], check=True, capture_output=True,
                                  text=True).stdout.splitlines()[0],
        "ffprobe": subprocess.run([ffprobe, "-version"], check=True, capture_output=True,
                                   text=True).stdout.splitlines()[0],
        "video_parameters": {"fps": 30, "crf": 23, "maxrate": "3000k",
                             "bufsize": "1500k", "pixel_format": "yuv420p",
                             "level": "5.0", "b_frames": 0, "gop": 30},
        "input_sha256": input_hash.hexdigest(),
        "frames": got_frames,
        "crc_and_fields_passed": got_frames * 3,
        "ffprobe": probe,
        "png": str(png_path),
        "video": str(video_path),
    }
    log_path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n",
                        encoding="utf-8")
    print(f"PASS: {got_frames} H.264/yuv420p frames; {got_frames * 3} metadata row CRCs/fields exact")
    print(f"PNG: {png_path}")
    print(f"Log: {log_path}")
    print(json.dumps(probe, ensure_ascii=False, indent=2))
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ffmpeg", default="ffmpeg")
    parser.add_argument("--ffprobe", default="ffprobe")
    parser.add_argument("--output-dir", type=Path, default=ROOT / "tests" / "results")
    args = parser.parse_args()
    run(args.ffmpeg, args.ffprobe, args.output_dir)


if __name__ == "__main__":
    main()
