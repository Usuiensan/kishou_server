#!/usr/bin/env python3
"""Run real JMA XML through atlas rendering, metadata, H.264 and local RTSP."""
import argparse
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from urllib.request import Request, urlopen

from PIL import Image, ImageChops

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
from sender_smoke import decode_metadata_frames  # noqa: E402


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def wait_file(path: Path, process: subprocess.Popen, timeout: float = 30) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"process exited ({process.returncode}); see its log")
        if path.is_file() and path.stat().st_size:
            return
        time.sleep(.1)
    raise TimeoutError(f"timed out waiting for {path}")


def post_xml(url: str, sample: Path) -> dict:
    request = Request(url, sample.read_bytes(), {"content-type": "application/xml"})
    with urlopen(request, timeout=5) as response:
        return json.load(response)


def probe(ffprobe: str, video: Path) -> dict:
    return json.loads(subprocess.run([ffprobe, "-v", "error", "-show_streams", "-show_format",
                                      "-of", "json", str(video)], check=True,
                                     capture_output=True, text=True).stdout)


def bitrate_profile(ffprobe: str, video: Path) -> dict:
    packets = json.loads(subprocess.run([ffprobe, "-v", "error", "-select_streams", "v:0",
                                         "-show_packets", "-show_entries", "packet=pts_time,size",
                                         "-of", "json", str(video)], check=True,
                                        capture_output=True, text=True).stdout)["packets"]
    buckets = {}
    for packet in packets:
        second = int(float(packet["pts_time"]))
        buckets[second] = buckets.get(second, 0) + int(packet["size"])
    return {"average_bps": int(video.stat().st_size * 8 / float(probe(ffprobe, video)["format"]["duration"])),
            "peak_one_second_bps": max(size * 8 for size in buckets.values()),
            "one_second_buckets": len(buckets)}


def run(mediamtx: Path, output: Path, chrome: str | None = None,
        ffmpeg: str = "ffmpeg", ffprobe: str = "ffprobe", duration: int = 20) -> dict:
    output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="atlas-e2e-") as temp:
        work = Path(temp)
        state = work / "atlas-state.json"
        image = work / "atlas.png"
        sequence = work / "sequence.json"
        rtsp_port, ingest_port = free_port(), free_port()
        config = (ROOT / "examples" / "mediamtx.yml").read_text(encoding="utf-8").replace(
            "rtspAddress: 127.0.0.1:8554", f"rtspAddress: 127.0.0.1:{rtsp_port}")
        config_path = work / "mediamtx.yml"
        config_path.write_text(config, encoding="utf-8")
        logs = {}
        children = []

        def start(name: str, command: list[str], cwd: Path = ROOT) -> subprocess.Popen:
            log = (output / f"{name}.log").open("w", encoding="utf-8")
            logs[name] = log
            process = subprocess.Popen(command, cwd=cwd, stdout=log, stderr=subprocess.STDOUT,
                                       creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            children.append(process)
            return process

        try:
            server = start("mediamtx", [str(mediamtx), str(config_path)], work)
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                if server.poll() is not None:
                    raise RuntimeError("MediaMTX failed to start; see mediamtx.log")
                try:
                    with socket.create_connection(("127.0.0.1", rtsp_port), timeout=.2):
                        break
                except OSError:
                    time.sleep(.1)
            else:
                raise TimeoutError("MediaMTX did not open RTSP")

            ingress = start("ingest", ["node", str(ROOT / "tools" / "atlas_ingest.js"),
                                        "--state", str(state), "--port", str(ingest_port)])
            # The chosen free port is passed explicitly; allow startup before posting XML.
            time.sleep(.3)
            renderer_command = [sys.executable, "-B", str(ROOT / "tools" / "render_atlas.py"),
                                "--state", str(state), "--output", str(image), "--watch"]
            if chrome:
                renderer_command += ["--browser", chrome]
            renderer = start("renderer", renderer_command)
            wait_file(image, renderer)
            sender = start("sender", [sys.executable, "-B", str(ROOT / "tools" / "atlas_sender.py"),
                                       "--atlas", str(image), "--stream", "--duration", str(duration + 3),
                                       "--url", f"rtsp://127.0.0.1:{rtsp_port}/atlas",
                                       "--sequence-state", str(sequence)])
            time.sleep(2)
            video = output / "atlas-rtsp.mkv"
            receiver = start("receiver", [ffmpeg, "-hide_banner", "-loglevel", "warning",
                                           "-y",
                                           "-rtsp_transport", "tcp", "-i",
                                           f"rtsp://127.0.0.1:{rtsp_port}/atlas", "-t", str(duration),
                                           "-map", "0:v:0", "-c:v", "copy", str(video)])
            base = f"http://127.0.0.1:{ingest_port}"
            time.sleep(.4)
            changes = [
                ("01-eew.png", "37_01_01_240613_VXSE43.xml"),
                ("02-eew-tsunami.png", "32-39_11_02_250206_VTSE41.xml"),
                ("03-eew-tsunami-intensity.png", "32-39_11_05_240613_VXSE53.xml"),
                ("04-eew-update.png", "37_01_02_240613_VXSE43.xml"),
                ("05-eew-cancel.png", "37_01_03_240613_VXSE43.xml"),
                ("06-tsunami-update.png", "32-39_11_06_250206_VTSE41.xml"),
            ]
            sample_dir = ROOT / "tests" / "samples"
            accepted = []
            for name, sample in changes:
                accepted.append(post_xml(f"{base}/jma", sample_dir / sample))
                time.sleep(1.7)
                shutil.copy2(image, output / name)
            health = json.loads(urlopen(f"{base}/health", timeout=5).read())
            if health["activeLayers"] != {"eew": 0, "tsunami": 1, "intensity": 1, "vertical": 1}:
                raise AssertionError(f"unexpected final active layers: {health}")
            if receiver.wait(timeout=duration + 20) != 0:
                raise RuntimeError("RTSP recorder failed; see receiver.log")
            if sender.poll() is None:
                sender.terminate()
            sender.wait(timeout=10)
            frames, row_results = decode_metadata_frames(video, ffmpeg, include_rows=True)
            if len(frames) < 300:
                raise AssertionError(f"too few decoded stream frames: {len(frames)}")
            sequences = [item.sequence for item in frames]
            if sequences[-1] <= sequences[0] or max(sequences) < 5:
                raise AssertionError(f"display updates did not advance sequence: {sorted(set(sequences))}")
            stream_info = probe(ffprobe, video)
            stream = next(item for item in stream_info["streams"] if item["codec_type"] == "video")
            if (stream.get("width"), stream.get("height"), stream.get("pix_fmt"), stream.get("level")) != (1936, 1168, "yuv420p", 50):
                raise AssertionError(f"unexpected encoded stream: {stream}")
            # Extract the final decoded video frame and compare it to the live renderer.
            decoded_png = output / "decoded-final.png"
            subprocess.run([ffmpeg, "-hide_banner", "-loglevel", "error",
                            "-i", str(video), "-frames:v", str(len(frames)), "-update", "1",
                            "-y", str(decoded_png)],
                           check=True, capture_output=True)
            with Image.open(decoded_png) as decoded, Image.open(image) as rendered:
                left, right = decoded.convert("RGB"), rendered.convert("RGB")
                # Metadata is expected to differ because it is overlaid only in the sender.
                left.paste((0, 0, 0), (0, 1128, 1936, 1158))
                right.paste((0, 0, 0), (0, 1128, 1936, 1158))
                difference = ImageChops.difference(left, right).convert("L")
                mean_error = sum(value * count for value, count in enumerate(difference.histogram())) / (1936 * 1168)
                if mean_error > 8:
                    raise AssertionError(f"decoded image differs from rendered atlas: mean={mean_error:.2f}")
            result = {"input": "JMA XML samples", "accepted_bulletins": accepted,
                      "final_active_layers": health["activeLayers"], "recording": str(video),
                      "decoded_frames": len(frames), "metadata_rows_crc_checked": len(frames) * 3,
                      "metadata_rows_passed": sum(row["valid"] for row in row_results),
                      "metadata_rows_recovered": sum(len(row["errors"]) for row in row_results),
                      "metadata_row_errors": [{"frame": frame, **error}
                                              for frame, row in enumerate(row_results)
                                              for error in row["errors"]],
                      "metadata_sequences": sorted(set(sequences)), "stream": stream,
                      "format": stream_info["format"], "bitrate": bitrate_profile(ffprobe, video),
                      "decoded_vs_rendered_mean_error": mean_error,
                      "screenshots": [name for name, _ in changes],
                      "transport": "RTSP/TCP loopback"}
            (output / "atlas-e2e.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            print(json.dumps(result, ensure_ascii=False, indent=2))
            return result
        finally:
            for process in reversed(children):
                if process.poll() is None:
                    process.terminate()
                    try:
                        process.wait(timeout=6)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait()
            for log in logs.values():
                log.close()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mediamtx", required=True, type=Path)
    parser.add_argument("--output", type=Path, default=ROOT / "tests" / "results" / "atlas-e2e")
    parser.add_argument("--chrome")
    parser.add_argument("--ffmpeg", default="ffmpeg")
    parser.add_argument("--ffprobe", default="ffprobe")
    parser.add_argument("--duration", type=int, default=20)
    args = parser.parse_args()
    run(args.mediamtx, args.output, args.chrome, args.ffmpeg, args.ffprobe, args.duration)


if __name__ == "__main__":
    main()
