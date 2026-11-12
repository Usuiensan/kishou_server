#!/usr/bin/env python3
"""Supervise the standalone atlas ingest, Chromium renderer and RTSP publisher."""
import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from logging.handlers import RotatingFileHandler
import logging
import os
from pathlib import Path
import signal
import shutil
import socket
import subprocess
import sys
import threading
import time
from urllib.error import URLError
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from urllib.parse import urlparse
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
from atlas_ii import encode_packet, wire_state
from process_metrics import ProcessResourceSampler
STOP = threading.Event()
TEST_PRESETS = {
    "eew": "37_01_01_240613_VXSE43.xml",
    "eew-followup": "37_01_02_240613_VXSE43.xml",
    "eew-cancel": "37_01_03_240613_VXSE43.xml",
    "tsunami": "32-39_11_02_250206_VTSE41.xml",
    "earthquake": "32-39_11_05_240613_VXSE53.xml",
    "intensity-report": "32-35_01_01_100806_VXSE51.xml",
}
TSUNAMI_AREAS = json.loads((ROOT / "protocol" / "atlas-ii-tsunami-areas-v1.json").read_text(encoding="utf-8"))["zones"]
EEW_AREAS = json.loads((ROOT / "protocol" / "atlas-ii-eew-areas-v1.json").read_text(encoding="utf-8"))["zones"]


class Child:
    def __init__(self, name: str, command: list[str], logger: logging.Logger):
        self.name, self.command, self.logger = name, command, logger
        self.process = None
        self.restarts = 0
        self.restart_at = 0.0
        self.enabled = True
        self.lock = threading.RLock()

    def start(self) -> None:
        with self.lock:
            if self.process is not None and self.process.poll() is None:
                return
            self.process = subprocess.Popen(self.command, cwd=ROOT, stdout=subprocess.PIPE,
                                            stderr=subprocess.STDOUT, text=True, bufsize=1,
                                            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                                            start_new_session=os.name != "nt")
            threading.Thread(target=self._read_log, args=(self.process,), daemon=True).start()
            self.logger.info("started pid=%s command=%r", self.process.pid, self.command)

    def _read_log(self, process) -> None:
        for line in process.stdout:
            self.logger.info("%s", line.rstrip())

    def check(self, now: float) -> None:
        with self.lock:
            if self.process is not None and self.process.poll() is not None:
                code = self.process.returncode
                self.logger.error("exited code=%s", code)
                self.process = None
                self.restarts += 1
                self.restart_at = now + min(2 ** min(self.restarts, 6), 60)
            if self.enabled and self.process is None and now >= self.restart_at and not STOP.is_set():
                self.start()

    def suspend(self) -> None:
        with self.lock:
            self.enabled = False
            self.stop()

    def resume(self) -> None:
        with self.lock:
            self.enabled = True
            self.restart_at = 0.0

    def status(self) -> dict:
        with self.lock:
            return {"running": self.process is not None and self.process.poll() is None,
                    "enabled": self.enabled, "restarts": self.restarts,
                    "pid": self.process.pid if self.process and self.process.poll() is None else None}

    def stop(self) -> None:
        with self.lock:
            if not self.process or self.process.poll() is not None:
                return
            if os.name == "nt":
                subprocess.run(["taskkill", "/PID", str(self.process.pid), "/T", "/F"],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
            else:
                # Kill the whole process group: children such as the renderer
                # spawn grandchildren (capture + Chrome) that would otherwise
                # be orphaned and keep writing output files.
                try:
                    os.killpg(self.process.pid, signal.SIGTERM)
                except (ProcessLookupError, PermissionError):
                    self.process.terminate()
            try:
                self.process.wait(timeout=8)
            except subprocess.TimeoutExpired:
                if os.name != "nt":
                    try:
                        os.killpg(self.process.pid, signal.SIGKILL)
                    except (ProcessLookupError, PermissionError):
                        pass
                self.process.kill()
                self.process.wait()


def wait_for_file(path: Path, children: list[Child], timeout: float = 60, not_before_ns: int = 0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline and not STOP.is_set():
        if path.is_file() and path.stat().st_size and path.stat().st_mtime_ns >= not_before_ns:
            return
        for child in children:
            child.check(time.monotonic())
        time.sleep(.25)
    if not STOP.is_set():
        raise TimeoutError(f"timed out waiting for {path}")


def validate_a2_frame(image_path: Path, state_path: Path) -> int:
    with Image.open(image_path) as image:
        if image.mode != "RGB":
            raise ValueError("Atlas renderer must produce RGB")
        image_size = image.size
    state = wire_state(json.loads(state_path.read_text(encoding="utf-8")))
    return len(encode_packet(state, image_size))


def check_port_available(host: str, port: int) -> None:
    with socket.socket(socket.AF_INET6 if ":" in host else socket.AF_INET, socket.SOCK_STREAM) as server:
        server.bind((host, port))


def preflight(mediamtx: Path, config: Path, chrome: str | None, host: str, port: int,
              url: str, ffmpeg: str, test_api: bool, test_api_host: str, test_api_port: int) -> tuple[str, str]:
    mediamtx, config = mediamtx.resolve(), config.resolve()
    if not mediamtx.is_file() or not config.is_file():
        raise FileNotFoundError("MediaMTX executable and configuration file must exist")
    parsed = urlparse(url)
    if (parsed.scheme, parsed.hostname, parsed.port, parsed.path) != ("rtsp", "127.0.0.1", 8554, "/bosai"):
        raise ValueError("publish URL must be rtsp://127.0.0.1:8554/bosai")
    ffmpeg_path = shutil.which(ffmpeg) or (str(Path(ffmpeg).resolve()) if Path(ffmpeg).is_file() else None)
    if not ffmpeg_path:
        raise FileNotFoundError(f"FFmpeg executable not found: {ffmpeg}")
    encoder = subprocess.run([ffmpeg_path, "-hide_banner", "-h", "encoder=libx264"],
                              capture_output=True, text=True, check=False)
    if encoder.returncode or "libx264" not in encoder.stdout + encoder.stderr:
        raise RuntimeError("FFmpeg must include the libx264 encoder")
    if chrome and not Path(chrome).is_file():
        raise FileNotFoundError(f"Chrome executable not found: {chrome}")
    validation = subprocess.run([str(mediamtx), f"--validate-conf={config}"],
                                capture_output=True, text=True, check=False)
    if validation.returncode:
        raise RuntimeError(f"MediaMTX rejected its configuration: {validation.stderr or validation.stdout}")
    ports = [("0.0.0.0", 8554), (host, port)]
    if test_api:
        ports.append((test_api_host, test_api_port))
    seen = set()
    for bind_host, bind_port in ports:
        pair = (bind_host, bind_port)
        if pair in seen:
            raise ValueError(f"duplicate listener address: {bind_host}:{bind_port}")
        seen.add(pair)
        try:
            check_port_available(bind_host, bind_port)
        except OSError as error:
            raise OSError(f"required port is unavailable: {bind_host}:{bind_port}") from error
    node_path = shutil.which("node")
    if not node_path:
        raise FileNotFoundError("Node.js executable not found in PATH")
    return ffmpeg_path, node_path


def wait_for_rtsp(url: str, child: Child, timeout: float = 20) -> None:
    parsed = urlparse(url)
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline and not STOP.is_set():
        child.check(time.monotonic())
        try:
            with socket.create_connection((parsed.hostname, parsed.port), timeout=2) as client:
                client.settimeout(2)
                client.sendall(f"DESCRIBE {url} RTSP/1.0\r\nCSeq: 1\r\nAccept: application/sdp\r\n\r\n".encode("ascii"))
                if b"RTSP/1.0 200" in client.recv(4096):
                    return
        except OSError:
            pass
        time.sleep(.25)
    if not STOP.is_set():
        raise TimeoutError(f"RTSP publish did not become ready: {url}")


def start_live_sources(source: Child, test_api: bool) -> None:
    if test_api:
        source.suspend()
    else:
        source.start()


def expand_scenario(steps: list) -> list:
    if not isinstance(steps, list) or not steps:
        raise ValueError("scenario must contain steps")
    expanded = []
    for index, step in enumerate(steps):
        if not isinstance(step, dict):
            raise ValueError("each scenario step must be an object")
        if step.get("action") not in ("events", "display", "layout", "reset", "fault"):
            raise ValueError("scenario action must be events, display, layout, reset, or fault")
        at = step.get("atSeconds")
        every, count = step.get("everySeconds"), step.get("count", 1)
        if type(at) not in (int, float) or at < 0 or at > 86400:
            raise ValueError("atSeconds must be between 0 and 86400")
        if type(count) is not int or not 1 <= count <= 100:
            raise ValueError("count must be an integer from 1 to 100")
        if count > 1 and (type(every) not in (int, float) or every <= 0):
            raise ValueError("repeated steps require positive everySeconds")
        for repeat in range(count):
            scheduled = at + (every or 0) * repeat
            if scheduled > 86400:
                raise ValueError("repeated scenario steps cannot exceed 86400 seconds")
            expanded.append((scheduled, index, {k: v for k, v in step.items() if k not in ("atSeconds", "everySeconds", "count")}))
    if len(expanded) > 100:
        raise ValueError("scenario cannot expand beyond 100 operations")
    return sorted(expanded, key=lambda item: (item[0], item[1]))


def post_json(url: str, payload=None, headers=None):
    data = json.dumps(payload).encode("utf-8") if payload is not None else b""
    request = Request(url, data=data, headers={"content-type": "application/json", **(headers or {})}, method="POST")
    try:
        with urlopen(request, timeout=10) as response:
            return json.loads(response.read().decode("utf-8"))
    except HTTPError as error:
        raise RuntimeError(f"HTTP {error.code}: {error.read().decode('utf-8', errors='replace')}") from error


class TestController:
    def __init__(self, ingest_url: str, children: dict[str, Child]):
        self.ingest_url, self.children = ingest_url, children
        self.lock = threading.Lock()
        self.cancel = threading.Event()
        self.resume_event = threading.Event()
        self.resume_event.set()
        self.status = {"running": False, "paused": False, "step": 0, "error": None}

    def apply(self, action: str, payload):
        if action == "events":
            return post_json(f"{self.ingest_url}/test/events", payload)
        if action == "display":
            return post_json(f"{self.ingest_url}/test/display", payload)
        if action == "layout":
            return post_json(f"{self.ingest_url}/test/layout", payload)
        if action == "reset":
            return post_json(f"{self.ingest_url}/test/reset")
        if action == "fault":
            child, state = payload.get("child"), payload.get("state", payload.get("action"))
            if child not in self.children or state not in ("stop", "resume"):
                raise ValueError("fault needs a managed child and stop or resume action")
            (self.children[child].suspend if state == "stop" else self.children[child].resume)()
            return {"child": child, "state": state}
        raise ValueError("action must be events, display, layout, reset, or fault")

    def run_scenario(self, steps):
        operations = expand_scenario(steps)
        with self.lock:
            if self.status["running"]:
                raise RuntimeError("a scenario is already running")
            self.cancel.clear()
            self.resume_event.set()
            self.status = {"running": True, "paused": False, "step": 0, "currentStep": 1,
                           "total": len(operations), "remainingSeconds": 0,
                           "result": "running", "lastResult": None, "error": None}
        threading.Thread(target=self._scenario, args=(operations,), daemon=True).start()
        return {"started": True, "operations": len(operations)}

    def stop_scenario(self):
        with self.lock:
            if self.status["running"]:
                self.cancel.set()
                self.resume_event.set()
                return {"stopping": True}
            return {"stopping": False}

    def pause_scenario(self):
        with self.lock:
            if self.status["running"] and not self.status["paused"]:
                self.resume_event.clear()
                self.status["paused"] = True
                return {"paused": True}
            return {"paused": False}

    def resume_scenario(self):
        with self.lock:
            if self.status["running"] and self.status["paused"]:
                self.status["paused"] = False
                self.resume_event.set()
                return {"resumed": True}
            return {"resumed": False}

    def set_live_inputs_enabled(self, enabled):
        if type(enabled) is not bool:
            raise ValueError("enabled must be a boolean")
        source = self.children.get("jma-p2p-sources")
        if source is None:
            raise RuntimeError("live source process is unavailable")
        (source.resume if enabled else source.suspend)()
        return {"enabled": source.status()["enabled"]}

    def _scenario(self, operations):
        started = time.monotonic()
        try:
            for index, (at, _, operation) in enumerate(operations, 1):
                while True:
                    if self.cancel.is_set():
                        with self.lock:
                            self.status["result"] = "stopped"
                        return
                    if not self.resume_event.is_set():
                        paused_at = time.monotonic()
                        self.resume_event.wait()
                        started += time.monotonic() - paused_at
                        continue
                    remaining = started + at - time.monotonic()
                    with self.lock:
                        self.status["currentStep"] = index
                        self.status["remainingSeconds"] = round(max(0, remaining), 2)
                    if remaining <= 0:
                        break
                    self.cancel.wait(min(remaining, .05))
                result = self.apply(operation.get("action"), operation)
                with self.lock:
                    self.status["step"] = index
                    self.status["lastResult"] = result
            with self.lock:
                self.status["result"] = "completed"
        except Exception as error:
            with self.lock:
                self.status["error"] = str(error)
                self.status["result"] = "failed"
        finally:
            with self.lock:
                self.status["running"] = False
                self.status["paused"] = False

    def get_status(self):
        with self.lock:
            return dict(self.status)


def make_test_server(host: str, port: int, controller: TestController, ingest_url: str,
                    children: dict[str, Child], atlas_path: Path,
                    metrics_paths: dict[str, Path]):
    if host not in ("127.0.0.1", "::1", "localhost"):
        raise ValueError("test API must bind to loopback")
    resource_sampler = ProcessResourceSampler()

    class Handler(BaseHTTPRequestHandler):
        def reply(self, code, value):
            body = json.dumps(value).encode("utf-8")
            self.send_response(code)
            self.send_header("content-type", "application/json; charset=utf-8")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if self.path == "/" or self.path == "/index.html":
                body = Path(__file__).with_name("atlas_test_ui.html").read_bytes()
                self.send_response(200)
                self.send_header("content-type", "text/html; charset=utf-8")
                self.send_header("content-length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            if self.path == "/test/atlas.png":
                try:
                    body = atlas_path.read_bytes()
                except OSError:
                    self.reply(503, {"error": "Atlas preview is unavailable"})
                    return
                self.send_response(200)
                self.send_header("content-type", "image/png")
                self.send_header("content-length", str(len(body)))
                self.send_header("cache-control", "no-store")
                self.end_headers()
                self.wfile.write(body)
                return
            if self.path == "/test/metrics":
                metrics = {}
                for name, path in metrics_paths.items():
                    try:
                        value = json.loads(path.read_text(encoding="utf-8"))
                        metrics[name] = value if isinstance(value, dict) else None
                    except (OSError, json.JSONDecodeError):
                        metrics[name] = None
                processes = {name: child.status().get("pid") for name, child in children.items()}
                ffmpeg = metrics.get("ffmpeg")
                processes["ffmpeg"] = ffmpeg.get("pid") if isinstance(ffmpeg, dict) else None
                metrics["processes"] = resource_sampler.sample(processes)
                self.reply(200, metrics)
                return
            if self.path != "/test/status":
                if self.path == "/test/tsunami-areas":
                    self.reply(200, {"areas": TSUNAMI_AREAS})
                    return
                if self.path == "/test/eew-areas":
                    self.reply(200, {"areas": EEW_AREAS})
                    return
                if self.path == "/test/tsunami-map-preview":
                    body = (ROOT / "telop" / "tsunami-zonecheck.html").read_bytes()
                    self.send_response(200)
                    self.send_header("content-type", "text/html; charset=utf-8")
                    self.send_header("content-length", str(len(body)))
                    self.send_header("cache-control", "no-store")
                    self.end_headers()
                    self.wfile.write(body)
                    return
                self.reply(404, {"error": "not found"})
                return
            try:
                with urlopen(f"{ingest_url}/health", timeout=3) as response:
                    ingest = json.loads(response.read().decode("utf-8"))
            except (OSError, URLError) as error:
                ingest = {"ok": False, "error": str(error)}
            self.reply(200, {"ingest": ingest, "scenario": controller.get_status(),
                             "children": {name: child.status() for name, child in children.items()}})

        def do_POST(self):
            length = int(self.headers.get("content-length", "0"))
            if length > 10 * 1024 * 1024:
                self.reply(413, {"error": "request exceeds 10 MiB"})
                return
            raw = self.rfile.read(length)
            try:
                if self.path == "/test/events":
                    if self.headers.get("content-type", "").startswith("application/xml"):
                        payload = {"xml": raw.decode("utf-8")}
                    else:
                        payload = json.loads(raw.decode("utf-8"))
                    result = controller.apply("events", payload)
                elif self.path == "/test/display":
                    result = controller.apply("display", json.loads(raw.decode("utf-8")))
                elif self.path == "/test/layout":
                    result = controller.apply("layout", json.loads(raw.decode("utf-8")))
                elif self.path == "/test/reset":
                    result = controller.apply("reset", {})
                elif self.path == "/test/fault":
                    result = controller.apply("fault", json.loads(raw.decode("utf-8")))
                elif self.path.startswith("/test/presets/"):
                    preset = self.path.removeprefix("/test/presets/")
                    if preset not in TEST_PRESETS:
                        self.reply(404, {"error": "unknown preset"})
                        return
                    xml = (ROOT / "tests" / "samples" / TEST_PRESETS[preset]).read_text(encoding="utf-8")
                    result = controller.apply("events", {"events": [{"xml": xml}]})
                elif self.path == "/test/scenarios/run":
                    payload = json.loads(raw.decode("utf-8"))
                    if not isinstance(payload, dict):
                        raise ValueError("scenario body must be an object")
                    result = controller.run_scenario(payload.get("steps"))
                elif self.path == "/test/scenarios/stop":
                    result = controller.stop_scenario()
                elif self.path == "/test/scenarios/pause":
                    result = controller.pause_scenario()
                elif self.path == "/test/scenarios/resume":
                    result = controller.resume_scenario()
                elif self.path == "/test/live-inputs":
                    payload = json.loads(raw.decode("utf-8"))
                    if not isinstance(payload, dict):
                        raise ValueError("live input body must be an object")
                    result = controller.set_live_inputs_enabled(payload.get("enabled"))
                else:
                    self.reply(404, {"error": "not found"})
                    return
                self.reply(200, result)
            except RuntimeError as error:
                self.reply(409, {"error": str(error)})
            except (ValueError, TypeError, KeyError, OSError, URLError, json.JSONDecodeError) as error:
                self.reply(422, {"error": str(error)})

        def log_message(self, format, *args):
            return

    return ThreadingHTTPServer((host, port), Handler)


def run(mediamtx: Path, runtime: Path, config: Path, chrome: str | None,
        host: str, port: int, url: str, ffmpeg: str,
        test_api: bool = False, test_api_host: str = "127.0.0.1", test_api_port: int = 8766) -> None:
    STOP.clear()
    ffmpeg, node = preflight(mediamtx, config, chrome, host, port, url, ffmpeg,
                             test_api, test_api_host, test_api_port)
    subprocess.run([sys.executable, "-B", str(ROOT / "telop" / "build_atlas.py")], cwd=ROOT, check=True)
    started_ns = time.time_ns()
    runtime.mkdir(parents=True, exist_ok=True)
    log_dir = runtime / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)

    def logger_for(name: str) -> logging.Logger:
        logger = logging.getLogger(f"atlas.{name}")
        logger.setLevel(logging.INFO)
        logger.propagate = False
        handler = RotatingFileHandler(log_dir / f"{name}.log", maxBytes=5 * 1024 * 1024,
                                      backupCount=3, encoding="utf-8")
        handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
        logger.addHandler(handler)
        return logger

    state, image = runtime / "atlas-state.json", runtime / "atlas.png"
    metrics_dir = runtime / "metrics"
    metrics_paths = {
        "chromiumCapture": metrics_dir / "chromium-capture.json",
        "pngConversion": metrics_dir / "png-conversion.json",
        "a2Encode": metrics_dir / "a2-encode.json",
        "atlasPaint": metrics_dir / "atlas-paint.json",
        "ffmpegPipe": metrics_dir / "ffmpeg-pipe.json",
        "ffmpeg": metrics_dir / "ffmpeg.json",
    }
    media = Child("mediamtx", [str(mediamtx.resolve()), str(config.resolve())], logger_for("mediamtx"))
    ingest_command = [node, str(ROOT / "tools" / "atlas_ingest.js"), "--state",
                      str(state), "--host", host, "--port", str(port),
                      "--layout", str(ROOT / "examples" / "atlas-layouts.json")]
    if test_api:
        ingest_command.append("--test-api")
    ingest = Child("ingest", ingest_command, logger_for("ingest"))
    sources = Child("jma-p2p-sources", [node, str(ROOT / "tools" / "atlas_sources.js")], logger_for("sources"))
    renderer_command = [sys.executable, "-B", str(ROOT / "tools" / "render_atlas.py"),
                        "--state", str(state), "--output", str(image), "--watch", "--node", node]
    renderer_command += ["--metrics-file", str(metrics_paths["pngConversion"]),
                         "--capture-metrics-file", str(metrics_paths["chromiumCapture"])]
    if chrome:
        renderer_command += ["--browser", chrome]
    renderer = Child("renderer", renderer_command, logger_for("renderer"))
    sender_command = [sys.executable, "-B", str(ROOT / "tools" / "atlas_ii.py"),
                      "--atlas", str(image), "--stream", "--url", url,
                      "--state", str(state), "--ffmpeg", ffmpeg, "--metrics-dir", str(metrics_dir)]
    sender = Child("a2-sender", sender_command, logger_for("a2-sender"))
    children = [media, ingest, sources, renderer, sender]
    managed = {child.name: child for child in children}
    test_server = None
    test_thread = None

    def stop(_signal, _frame):
        STOP.set()
    signal.signal(signal.SIGINT, stop)
    if hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, stop)

    try:
        media.start()
        ingest.start()
        wait_for_file(state, [media, ingest], not_before_ns=started_ns)
        if STOP.is_set():
            return
        start_live_sources(sources, test_api)
        renderer.start()
        wait_for_file(image, [media, ingest, renderer], not_before_ns=started_ns)
        if STOP.is_set():
            return
        packet_bytes = validate_a2_frame(image, state)
        logger_for("a2-sender").info("preflight passed rendered_png=%s packet=%s bytes", image.stat().st_size, packet_bytes)
        sender.start()
        wait_for_rtsp(url, sender)
        logger_for("a2-sender").info("RTSP publish ready at %s", url)
        if test_api:
            controller = TestController(f"http://{host}:{port}", managed)
            test_server = make_test_server(test_api_host, test_api_port, controller,
                                           f"http://{host}:{port}", managed, image, metrics_paths)
            test_thread = threading.Thread(target=test_server.serve_forever, daemon=True)
            test_thread.start()
        while not STOP.wait(1):
            for child in children:
                child.check(time.monotonic())
    finally:
        if test_server:
            test_server.shutdown()
            test_server.server_close()
        if test_thread:
            test_thread.join(timeout=2)
        for child in reversed(children):
            child.stop()
        for name in ("mediamtx", "ingest", "sources", "renderer", "a2-sender"):
            logger = logging.getLogger(f"atlas.{name}")
            for handler in logger.handlers[:]:
                handler.close()
                logger.removeHandler(handler)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mediamtx", required=True, type=Path)
    parser.add_argument("--config", type=Path, default=ROOT / "examples" / "mediamtx.production.example.yml")
    parser.add_argument("--runtime", type=Path, default=ROOT / "runtime")
    parser.add_argument("--chrome")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--url", default="rtsp://127.0.0.1:8554/bosai")
    parser.add_argument("--ffmpeg", default="ffmpeg")
    parser.add_argument("--test-api", action="store_true", help="enable loopback-only test control API on port 8766")
    parser.add_argument("--test-api-host", default="127.0.0.1")
    parser.add_argument("--test-api-port", type=int, default=8766)
    args = parser.parse_args()
    run(args.mediamtx, args.runtime, args.config, args.chrome, args.host,
        args.port, args.url, args.ffmpeg, args.test_api, args.test_api_host, args.test_api_port)


if __name__ == "__main__":
    main()
