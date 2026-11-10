#!/usr/bin/env python3
"""Exercise FFmpeg -> MediaMTX -> FFmpeg locally with a synthetic atlas update."""
import argparse
from pathlib import Path
import json
import os
import socket
import subprocess
import sys
import threading
import time

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "reference"))
sys.path.insert(0, str(ROOT / "tools"))
from metadata_demo import State, sample_atlas  # noqa: E402
from sender_smoke import decode_metadata_frames  # noqa: E402


def atomic_png(image: Image.Image, path: Path) -> None:
    temporary = path.with_name(path.stem + ".new.png")
    image.save(temporary, format="PNG")
    os.replace(temporary, path)


def replace_with_state(path: Path, values: dict) -> None:
    temporary = path.with_name(path.name + ".new")
    temporary.write_text(json.dumps(values), encoding="utf-8")
    os.replace(temporary, path)


def wait_for_rtsp(port: int, process: subprocess.Popen, timeout: float = 10) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError("MediaMTX exited before opening RTSP")
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.25):
                return
        except OSError:
            time.sleep(0.1)
    raise TimeoutError("MediaMTX did not open local RTSP port")


def probe(ffprobe: str, path: Path) -> dict:
    command = [ffprobe, "-v", "error", "-show_entries",
               "stream=codec_name,pix_fmt,width,height,level,has_b_frames,avg_frame_rate",
               "-show_entries", "format=duration,size,bit_rate", "-of", "json", str(path)]
    return json.loads(subprocess.run(command, check=True, capture_output=True,
                                     text=True).stdout)


def run(mediamtx: Path, ffmpeg: str = "ffmpeg", ffprobe: str = "ffprobe",
        output_dir: Path = ROOT / "tests" / "results" / "rtsp-smoke",
        duration: int = 12, update_after: int = 5) -> dict:
    if duration < update_after + 4:
        raise ValueError("duration must be at least update_after + 4 seconds")
    output_dir.mkdir(parents=True, exist_ok=True)
    source_path = output_dir / "atlas-source.png"
    state_path = output_dir / "state.json"
    atomic_png(sample_atlas(), source_path)
    state_values = {"flags": 15, "mode": 1, "opacity": 255,
                    "lower_x": 281, "lower_y": 619}
    replace_with_state(state_path, state_values)
    server_log = (output_dir / "mediamtx.log").open("w", encoding="utf-8")
    server = subprocess.Popen([str(mediamtx), str(ROOT / "examples" / "mediamtx.yml")],
                              cwd=output_dir, stdout=server_log, stderr=subprocess.STDOUT,
                              creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    publisher = recorder = None
    publisher_log = receiver_log = None
    try:
        wait_for_rtsp(8554, server)
        publisher_log = (output_dir / "publisher.log").open("w", encoding="utf-8")
        publisher_command = [sys.executable, "-B", str(ROOT / "tools" / "atlas_sender.py"),
                             "--atlas", str(source_path), "--state-json", str(state_path),
                             "--stream", "--duration", str(duration + 2), "--fps", "30",
                             "--sequence", "1"]
        publisher = subprocess.Popen(publisher_command, cwd=ROOT, stdout=publisher_log,
                                     stderr=subprocess.STDOUT,
                                     creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        time.sleep(2)
        segment_pattern = str(output_dir / "rtsp-%02d.mkv")
        receiver_command = [ffmpeg, "-hide_banner", "-loglevel", "warning",
                            "-rtsp_transport", "tcp", "-i", "rtsp://127.0.0.1:8554/atlas",
                            "-t", str(duration), "-map", "0:v:0", "-c:v", "copy",
                            "-f", "segment", "-segment_time", "1", "-reset_timestamps", "1",
                            "-segment_format", "matroska", segment_pattern]
        receiver_log = (output_dir / "receiver.log").open("w", encoding="utf-8")
        recorder = subprocess.Popen(receiver_command, cwd=ROOT, stdout=receiver_log,
                                    stderr=subprocess.STDOUT,
                                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))

        def change_display() -> None:
            time.sleep(update_after)
            changed = sample_atlas()
            draw = ImageDraw.Draw(changed)
            x0, y0, x1, y1 = 297, 651, 1936, 1112
            for y in range(y0, y1, 8):
                for x in range(x0, x1, 8):
                    color = (235, 235, 235) if ((x // 8 + y // 8) % 2) else (25, 30, 35)
                    draw.rectangle((x, y, x + 7, y + 7), fill=color)
            atomic_png(changed, source_path)
            replace_with_state(state_path, {"flags": 7, "mode": 1, "opacity": 200,
                                           "lower_x": 300, "lower_y": 619})

        updater = threading.Thread(target=change_display, daemon=True)
        updater.start()
        if recorder.wait(timeout=duration + 20) != 0:
            raise RuntimeError(f"FFmpeg RTSP reader failed; see {output_dir / 'receiver.log'}")
        updater.join(timeout=5)
        if publisher.wait(timeout=duration + 20) != 0:
            raise RuntimeError(f"FFmpeg publisher failed; see {output_dir / 'publisher.log'}")
    finally:
        for child in (recorder, publisher, server):
            if child is not None and child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait()
        for log_file in (publisher_log, receiver_log):
            if log_file:
                log_file.close()
        server_log.close()

    segments = sorted(output_dir.glob("rtsp-*.mkv"))
    if len(segments) < 4:
        raise AssertionError(f"expected several RTSP segments, found {len(segments)}")
    measurements = []
    seen_sequences = set()
    for segment in segments:
        info = probe(ffprobe, segment)
        stream = info["streams"][0]
        fmt = info["format"]
        states = decode_metadata_frames(segment, ffmpeg)
        seen_sequences.update(state.sequence for state in states)
        measurements.append({"file": segment.name, "seconds": float(fmt["duration"]),
                             "bytes": int(fmt["size"]),
                             "bitrate_bps": int(int(fmt["size"]) * 8 / float(fmt["duration"])),
                             "frames": len(states), "valid_packets": len(states),
                             "stream": stream})
    if not {1, 2}.issubset(seen_sequences):
        raise AssertionError(f"expected sequence change 1->2, got {sorted(seen_sequences)}")
    result = {"mediamtx": str(mediamtx), "duration_seconds": duration,
              "update_after_seconds": update_after, "fps": 30,
              "transport": "RTSP/TCP", "sequence_values": sorted(seen_sequences),
              "segments": measurements}
    report = output_dir / "rtsp-measurements.json"
    report.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"PASS: RTSP/TCP local loop, {sum(item['frames'] for item in measurements)} decoded frames, "
          f"metadata sequences {sorted(seen_sequences)}")
    print(f"Measurements: {report}")
    print(json.dumps(measurements, ensure_ascii=False, indent=2))
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mediamtx", required=True, type=Path)
    parser.add_argument("--ffmpeg", default="ffmpeg")
    parser.add_argument("--ffprobe", default="ffprobe")
    parser.add_argument("--output-dir", type=Path,
                        default=ROOT / "tests" / "results" / "rtsp-smoke")
    parser.add_argument("--duration", type=int, default=12)
    parser.add_argument("--update-after", type=int, default=5)
    args = parser.parse_args()
    run(args.mediamtx, args.ffmpeg, args.ffprobe, args.output_dir,
        args.duration, args.update_after)


if __name__ == "__main__":
    main()
