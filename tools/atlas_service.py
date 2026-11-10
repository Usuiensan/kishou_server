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
import subprocess
import sys
import threading
import time
from urllib.error import URLError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
STOP = threading.Event()
DEFAULT_CONTROLS = {"flags": 15, "mode": 1, "opacity": 255, "lower_x": 281, "lower_y": 619}
CONTROL_LIMITS = {"flags": 255, "mode": 255, "opacity": 255, "lower_x": 65535, "lower_y": 65535}
TEST_PRESETS = {
    "eew": "37_01_01_240613_VXSE43.xml",
    "tsunami": "32-39_11_02_250206_VTSE41.xml",
    "earthquake": "32-39_11_05_240613_VXSE53.xml",
}


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
                                            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
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
                    "enabled": self.enabled, "restarts": self.restarts}

    def stop(self) -> None:
        with self.lock:
            if not self.process or self.process.poll() is not None:
                return
            if os.name == "nt":
                subprocess.run(["taskkill", "/PID", str(self.process.pid), "/T", "/F"],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
            else:
                self.process.terminate()
            try:
                self.process.wait(timeout=8)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()


def wait_for_file(path: Path, children: list[Child], timeout: float = 60) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline and not STOP.is_set():
        if path.is_file() and path.stat().st_size:
            return
        for child in children:
            child.check(time.monotonic())
        time.sleep(.25)
    if not STOP.is_set():
        raise TimeoutError(f"timed out waiting for {path}")


def update_control_state(path: Path, values: dict) -> dict:
    if not isinstance(values, dict) or not values or set(values) - CONTROL_LIMITS.keys():
        raise ValueError("mode values must contain flags, mode, opacity, lower_x, or lower_y")
    current = read_control_state(path)
    for name, value in values.items():
        if type(value) is not int or not 0 <= value <= CONTROL_LIMITS[name]:
            raise ValueError(f"{name} must be an integer from 0 to {CONTROL_LIMITS[name]}")
        current[name] = value
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(current) + "\n", encoding="utf-8")
    os.replace(temporary, path)
    return current


def read_control_state(path: Path) -> dict:
    values = DEFAULT_CONTROLS.copy()
    if path.exists():
        supplied = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(supplied, dict) or set(supplied) - CONTROL_LIMITS.keys():
            raise ValueError("control state contains unsupported fields")
        values.update(supplied)
    for name, value in values.items():
        if type(value) is not int or not 0 <= value <= CONTROL_LIMITS[name]:
            raise ValueError(f"control state field {name} must be an integer from 0 to {CONTROL_LIMITS[name]}")
    return values


def expand_scenario(steps: list) -> list:
    if not isinstance(steps, list) or not steps:
        raise ValueError("scenario must contain steps")
    expanded = []
    for index, step in enumerate(steps):
        if not isinstance(step, dict):
            raise ValueError("each scenario step must be an object")
        if step.get("action") not in ("events", "display", "mode", "reset", "fault"):
            raise ValueError("scenario action must be events, display, mode, reset, or fault")
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
    with urlopen(request, timeout=10) as response:
        return json.loads(response.read().decode("utf-8"))


class TestController:
    def __init__(self, ingest_url: str, controls_path: Path, children: dict[str, Child]):
        self.ingest_url, self.controls_path, self.children = ingest_url, controls_path, children
        self.lock = threading.Lock()
        self.cancel = threading.Event()
        self.status = {"running": False, "step": 0, "error": None}

    def apply(self, action: str, payload):
        if action == "events":
            return post_json(f"{self.ingest_url}/test/events", payload)
        if action == "display":
            return post_json(f"{self.ingest_url}/test/display", payload)
        if action == "mode":
            values = payload.get("values", payload)
            return {"controls": update_control_state(self.controls_path, values)}
        if action == "reset":
            result = post_json(f"{self.ingest_url}/test/reset")
            return {**result, "controls": update_control_state(self.controls_path, DEFAULT_CONTROLS)}
        if action == "fault":
            child, state = payload.get("child"), payload.get("state", payload.get("action"))
            if child not in self.children or state not in ("stop", "resume"):
                raise ValueError("fault needs a managed child and stop or resume action")
            (self.children[child].suspend if state == "stop" else self.children[child].resume)()
            return {"child": child, "state": state}
        raise ValueError("action must be events, display, mode, reset, or fault")

    def run_scenario(self, steps):
        operations = expand_scenario(steps)
        with self.lock:
            if self.status["running"]:
                raise RuntimeError("a scenario is already running")
            self.cancel.clear()
            self.status = {"running": True, "step": 0, "error": None}
        threading.Thread(target=self._scenario, args=(operations,), daemon=True).start()
        return {"started": True, "operations": len(operations)}

    def _scenario(self, operations):
        started = time.monotonic()
        try:
            for index, (at, _, operation) in enumerate(operations, 1):
                if self.cancel.wait(max(0, started + at - time.monotonic())):
                    break
                self.apply(operation.get("action"), operation)
                with self.lock:
                    self.status["step"] = index
        except Exception as error:
            with self.lock:
                self.status["error"] = str(error)
        finally:
            with self.lock:
                self.status["running"] = False

    def get_status(self):
        with self.lock:
            return dict(self.status)


def make_test_server(host: str, port: int, controller: TestController, ingest_url: str, children: dict[str, Child]):
    if host not in ("127.0.0.1", "::1", "localhost"):
        raise ValueError("test API must bind to loopback")

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
            if self.path != "/test/status":
                self.reply(404, {"error": "not found"})
                return
            try:
                with urlopen(f"{ingest_url}/health", timeout=3) as response:
                    ingest = json.loads(response.read().decode("utf-8"))
            except (OSError, URLError) as error:
                ingest = {"ok": False, "error": str(error)}
            self.reply(200, {"ingest": ingest, "scenario": controller.get_status(),
                             "controls": read_control_state(controller.controls_path),
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
                elif self.path == "/test/mode":
                    result = controller.apply("mode", json.loads(raw.decode("utf-8")))
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
    controls_path = runtime / "atlas-controls.json"
    media = Child("mediamtx", [str(mediamtx.resolve()), str(config.resolve())], logger_for("mediamtx"))
    ingest_command = ["node", str(ROOT / "tools" / "atlas_ingest.js"), "--state",
                      str(state), "--host", host, "--port", str(port)]
    if test_api:
        ingest_command.append("--test-api")
    ingest = Child("ingest", ingest_command, logger_for("ingest"))
    renderer_command = [sys.executable, "-B", str(ROOT / "tools" / "render_atlas.py"),
                        "--state", str(state), "--output", str(image), "--watch",
                        "--controls", str(controls_path)]
    if chrome:
        renderer_command += ["--browser", chrome]
    renderer = Child("renderer", renderer_command, logger_for("renderer"))
    sender_command = [sys.executable, "-B", str(ROOT / "tools" / "atlas_ii.py"),
                      "--atlas", str(image), "--stream", "--url", url,
                      "--state", str(state), "--ffmpeg", ffmpeg]
    sender = Child("a2-sender", sender_command, logger_for("a2-sender"))
    children = [media, ingest, renderer, sender]
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
        wait_for_file(state, [media, ingest])
        if STOP.is_set():
            return
        renderer.start()
        wait_for_file(image, [media, ingest, renderer])
        if STOP.is_set():
            return
        sender.start()
        if test_api:
            controller = TestController(f"http://{host}:{port}", controls_path, managed)
            test_server = make_test_server(test_api_host, test_api_port, controller,
                                           f"http://{host}:{port}", managed)
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
        for name in ("mediamtx", "ingest", "renderer", "a2-sender"):
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
