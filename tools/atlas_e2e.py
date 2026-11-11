#!/usr/bin/env python3
"""Run a loopback A2 service, ingest JMA/P2P samples, and CRC-check RTSP frames."""
import argparse
import json
from pathlib import Path
import signal
import socket
import struct
import subprocess
import sys
import tempfile
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "protocol"))
from atlas_ii_reference import parse_packet, symbols_to_bytes  # noqa: E402

PALETTE = [(85 * (symbol & 3), 85 * ((symbol >> 2) & 3), 255 * (symbol >> 4)) for symbol in range(32)]


def post(url: str, payload=None, content_type="application/json"):
    data = payload if isinstance(payload, bytes) else json.dumps(payload).encode() if payload is not None else None
    request = Request(url, data=data, headers={"content-type": content_type} if data is not None else {})
    try:
        with urlopen(request, timeout=15) as response:
            return json.loads(response.read()) if "json" in response.headers.get("content-type", "") else response.status
    except HTTPError as error:
        raise RuntimeError(f"POST {url} failed: {error.code} {error.read().decode(errors='replace')}") from error


def read_colour32_frame(frame: bytes, size: tuple[int, int]) -> dict:
    width, height = size
    if len(frame) != width * height * 3:
        raise ValueError("decoded RGB frame length does not match Atlas dimensions")
    columns = width // 8

    def symbol(index):
        col, row = index % columns, index // columns
        x, y = col * 8, height - (row + 1) * 8
        samples = [((y + py) * width + x + px) * 3 for py in range(2, 6) for px in range(2, 6)]
        pixel = tuple(sum(frame[offset + channel] for offset in samples) // len(samples) for channel in range(3))
        return min(range(32), key=lambda n: sum((a - b) ** 2 for a, b in zip(pixel, PALETTE[n])))

    symbols = [symbol(i) for i in range(45)]
    header = bytes(sum(((symbols[bit // 5] >> (bit % 5)) & 1) << (bit % 8)
                       for bit in range(byte * 8, byte * 8 + 8)) for byte in range(28))
    if header[:2] != b"A2" or header[2] != 2:
        raise ValueError("A2 header not recovered from the lower-left cells")
    length = struct.unpack_from("<H", header, 4)[0]
    cells = (length * 8 + 4) // 5
    packet = symbols_to_bytes([symbol(i) for i in range(cells)], length)
    decoded = parse_packet(packet, actual_atlas_size=size, actual_main_size=(1920, 1080))
    return {"length": length, "sequence": decoded["sequence"], "rectCount": len(decoded["rects"]),
            "crc32": packet[-4:].hex()}


def free_ports() -> None:
    for port in (8554, 8765, 8766):
        with socket.socket() as listener:
            try:
                listener.bind(("0.0.0.0" if port == 8554 else "127.0.0.1", port))
            except OSError as error:
                raise OSError(f"required loopback test port is busy: {port}") from error


def run(mediamtx: Path, chrome: str | None = None, ffmpeg: str = "ffmpeg", ffprobe: str = "ffprobe",
        duration: int = 15, output: Path | None = None) -> dict:
    free_ports()
    output = (output or ROOT / "tests" / "results" / "atlas-a2-e2e").resolve()
    output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="atlas-a2-e2e-") as temp:
        work = Path(temp)
        runtime = work / "runtime"
        config = work / "mediamtx.yml"
        config_text = (ROOT / "examples" / "mediamtx.production.example.yml").read_text(encoding="utf-8")
        config.write_text(config_text.replace("rtspAddress: 0.0.0.0:8554", "rtspAddress: 127.0.0.1:8554"), encoding="utf-8")
        command = [sys.executable, "-B", str(ROOT / "tools" / "atlas_service.py"), "--mediamtx", str(mediamtx.resolve()),
                   "--config", str(config), "--runtime", str(runtime), "--test-api"]
        if chrome:
            command += ["--chrome", chrome]
        log = (output / "service.log").open("w", encoding="utf-8")
        service = subprocess.Popen(command, cwd=ROOT, stdout=log, stderr=subprocess.STDOUT,
                                   creationflags=getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0))
        recorder = None
        try:
            base, ingest = "http://127.0.0.1:8766", "http://127.0.0.1:8765"
            deadline = time.monotonic() + 90
            while time.monotonic() < deadline:
                if service.poll() is not None:
                    raise RuntimeError(f"A2 service exited {service.returncode}; see {output / 'service.log'}")
                try:
                    with urlopen(base + "/test/status", timeout=2) as response:
                        if json.loads(response.read()).get("ingest", {}).get("ok"):
                            break
                except OSError:
                    time.sleep(.25)
            else:
                raise TimeoutError("A2 service did not become ready")

            sample_dir = ROOT / "tests" / "samples"
            accepted = []
            for name in ("37_01_01_240613_VXSE43.xml", "32-39_11_02_250206_VTSE41.xml",
                         "37_01_02_240613_VXSE43.xml", "37_01_03_240613_VXSE43.xml"):
                accepted.append(post(ingest + "/jma", (sample_dir / name).read_bytes(), "application/xml"))
                time.sleep(.6)
            p2p = {"code": 556, "earthquake": {"time": "2026/04/01 10:06:25"},
                   "issue": {"eventId": "a2-e2e-p2p", "serial": "1", "time": "2026/04/01 10:06:39"},
                   "areas": [{"pref": "茨城", "name": "茨城県北部", "scaleFrom": 50, "scaleTo": 50}]}
            accepted.append(post(ingest + "/p2p", p2p))
            video = output / "bosai-a2.mkv"
            recorder = subprocess.Popen([ffmpeg, "-hide_banner", "-loglevel", "warning", "-y",
                "-rtsp_transport", "tcp", "-i", "rtsp://127.0.0.1:8554/bosai", "-t", str(duration),
                "-map", "0:v:0", "-c:v", "copy", str(video)], cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            time.sleep(4.0)
            for layout in ("test-0-rects", "test-15-rects", "reverseL"):
                post(base + "/test/layout", {"activeLayout": layout})
                time.sleep(3.0)
            try:
                _, error = recorder.communicate(timeout=duration + 30)
            except subprocess.TimeoutExpired:
                recorder.kill()
                _, error = recorder.communicate()
                raise TimeoutError("RTSP receiver did not finish")
            if recorder.returncode:
                raise RuntimeError(f"FFmpeg RTSP receive failed: {error.decode(errors='replace')}")
            probe = json.loads(subprocess.run([ffprobe, "-v", "error", "-select_streams", "v:0", "-show_streams",
                "-of", "json", str(video)], check=True, capture_output=True, text=True).stdout)["streams"][0]
            size = (probe["width"], probe["height"])
            if (probe["codec_name"], probe["pix_fmt"]) != ("h264", "yuv420p"):
                raise AssertionError(f"unexpected stream codec/pix_fmt: {probe}")
            raw = subprocess.run([ffmpeg, "-hide_banner", "-loglevel", "error", "-i", str(video),
                "-vf", "setpts=PTS-STARTPTS,fps=4", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
                check=True, capture_output=True).stdout
            frame_bytes = size[0] * size[1] * 3
            frames = [raw[offset:offset + frame_bytes] for offset in range(0, len(raw), frame_bytes)
                      if len(raw[offset:offset + frame_bytes]) == frame_bytes]
            decoded = []
            invalid_frames = 0
            for frame in frames:
                try:
                    decoded.append(read_colour32_frame(frame, size))
                except ValueError:
                    invalid_frames += 1
            rect_counts = {item["rectCount"] for item in decoded}
            if not {0, 4, 15}.issubset(rect_counts):
                raise AssertionError(f"received A2 stream missed 0/15/reverseL Rect states: {sorted(rect_counts)}")
            health = json.loads(urlopen(ingest + "/health", timeout=5).read())
            state = json.loads((runtime / "atlas-state.json").read_text(encoding="utf-8"))
            if not any(item["action"] == "cancel" for item in state["layers"]["eew"]) or not state["layers"]["tsunami"]:
                raise AssertionError("EEW cancellation or active tsunami state was not retained")
            result = {"transport": "loopback RTSP/TCP /bosai", "acceptedInputs": accepted,
                      "stream": {key: probe.get(key) for key in ("codec_name", "width", "height", "pix_fmt", "level")},
                      "decodedFramesAt4fps": len(frames), "invalidFrames": invalid_frames,
                      "crcValidFrames": len(decoded),
                      "rectCounts": sorted(rect_counts),
                      "sequences": [item["sequence"] for item in decoded], "activeLayers": health["activeLayers"],
                      "sourceHealth": health["sourceHealth"], "recording": str(video)}
            (output / "atlas-a2-e2e.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            print(json.dumps(result, ensure_ascii=False, indent=2))
            return result
        finally:
            if recorder and recorder.poll() is None:
                recorder.kill()
                recorder.wait()
            if service.poll() is None:
                if sys.platform == "win32":
                    subprocess.run(["taskkill", "/PID", str(service.pid), "/T", "/F"],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
                else:
                    service.send_signal(signal.SIGINT)
                try:
                    service.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    service.kill()
                    service.wait()
            logs = runtime / "logs"
            if logs.is_dir():
                import shutil
                shutil.copytree(logs, output / "component-logs", dirs_exist_ok=True)
            log.close()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mediamtx", required=True, type=Path)
    parser.add_argument("--chrome")
    parser.add_argument("--ffmpeg", default="ffmpeg")
    parser.add_argument("--ffprobe", default="ffprobe")
    parser.add_argument("--duration", type=int, default=15)
    parser.add_argument("--output", type=Path, default=ROOT / "tests" / "results" / "atlas-a2-e2e")
    args = parser.parse_args()
    run(args.mediamtx, args.chrome, args.ffmpeg, args.ffprobe, args.duration, args.output)


if __name__ == "__main__":
    main()
