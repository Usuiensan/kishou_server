#!/usr/bin/env python3
"""Supervise the standalone atlas ingest, Chromium renderer and RTSP publisher."""
import argparse
from logging.handlers import RotatingFileHandler
import logging
import os
from pathlib import Path
import signal
import subprocess
import sys
import threading
import time

ROOT = Path(__file__).resolve().parents[1]
STOP = threading.Event()


class Child:
    def __init__(self, name: str, command: list[str], logger: logging.Logger):
        self.name, self.command, self.logger = name, command, logger
        self.process = None
        self.restarts = 0
        self.restart_at = 0.0

    def start(self) -> None:
        self.process = subprocess.Popen(self.command, cwd=ROOT, stdout=subprocess.PIPE,
                                        stderr=subprocess.STDOUT, text=True, bufsize=1,
                                        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        threading.Thread(target=self._read_log, args=(self.process,), daemon=True).start()
        self.logger.info("started pid=%s command=%r", self.process.pid, self.command)

    def _read_log(self, process) -> None:
        for line in process.stdout:
            self.logger.info("%s", line.rstrip())

    def check(self, now: float) -> None:
        if self.process is not None and self.process.poll() is not None:
            code = self.process.returncode
            self.logger.error("exited code=%s", code)
            self.process = None
            self.restarts += 1
            self.restart_at = now + min(2 ** min(self.restarts, 6), 60)
        if self.process is None and now >= self.restart_at and not STOP.is_set():
            self.start()

    def stop(self) -> None:
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


def run(mediamtx: Path, runtime: Path, config: Path, chrome: str | None,
        host: str, port: int, url: str, ffmpeg: str) -> None:
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
    media = Child("mediamtx", [str(mediamtx.resolve()), str(config.resolve())], logger_for("mediamtx"))
    ingest = Child("ingest", ["node", str(ROOT / "tools" / "atlas_ingest.js"), "--state",
                               str(state), "--host", host, "--port", str(port)], logger_for("ingest"))
    renderer_command = [sys.executable, "-B", str(ROOT / "tools" / "render_atlas.py"),
                        "--state", str(state), "--output", str(image), "--watch"]
    if chrome:
        renderer_command += ["--browser", chrome]
    renderer = Child("renderer", renderer_command, logger_for("renderer"))
    sender_command = [sys.executable, "-B", str(ROOT / "tools" / "atlas_sender.py"),
                      "--atlas", str(image), "--stream", "--url", url,
                      "--sequence-state", str(runtime / "sequence.json"), "--ffmpeg", ffmpeg]
    sender = Child("sender", sender_command, logger_for("sender"))
    children = [media, ingest, renderer, sender]

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
        while not STOP.wait(1):
            for child in children:
                child.check(time.monotonic())
    finally:
        for child in reversed(children):
            child.stop()
        for name in ("mediamtx", "ingest", "renderer", "sender"):
            logger = logging.getLogger(f"atlas.{name}")
            for handler in logger.handlers[:]:
                handler.close()
                logger.removeHandler(handler)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mediamtx", required=True, type=Path)
    parser.add_argument("--config", type=Path, default=ROOT / "examples" / "mediamtx.yml")
    parser.add_argument("--runtime", type=Path, default=ROOT / "runtime")
    parser.add_argument("--chrome")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--url", default="rtsp://127.0.0.1:8554/atlas")
    parser.add_argument("--ffmpeg", default="ffmpeg")
    args = parser.parse_args()
    run(args.mediamtx, args.runtime, args.config, args.chrome, args.host,
        args.port, args.url, args.ffmpeg)


if __name__ == "__main__":
    main()
