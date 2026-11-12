import json
import socket
import tempfile
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
from unittest.mock import patch
from urllib.request import Request, urlopen

from PIL import Image
from tools.atlas_service import (TestController, check_port_available, expand_scenario,
                                 make_test_server, preflight, validate_a2_frame, wait_for_rtsp)


class FakeChild:
    def __init__(self):
        self.actions = []
        self.process = None
        self.enabled = True
        self.restarts = 0

    def suspend(self):
        self.actions.append("stop")

    def resume(self):
        self.actions.append("resume")

    def status(self):
        return {"running": False, "enabled": self.enabled, "restarts": self.restarts}

    def check(self, _now):
        pass


class AtlasServiceTest(unittest.TestCase):
    def test_scenario_expands_repeat_steps_in_time_order(self):
        steps = expand_scenario([
            {"atSeconds": 5, "action": "events", "everySeconds": 5, "count": 2},
            {"atSeconds": 8, "action": "layout", "activeLayout": "reverseL"},
        ])
        self.assertEqual([item[0] for item in steps], [5, 8, 10])
        with self.assertRaises(ValueError):
            expand_scenario([{"atSeconds": 0, "action": "layout", "count": 2}])

    def test_startup_preflight_validates_a2_packet_capacity(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            atlas, state = root / "atlas.png", root / "state.json"
            Image.new("RGB", (1280, 720)).save(atlas)
            state.write_text(json.dumps({"rects": []}), encoding="utf-8")
            self.assertGreater(validate_a2_frame(atlas, state), 0)
            Image.new("RGB", (640, 32)).save(atlas)
            rect = {"source": 0, "mode": 1, "visible": True, "opacity": 255,
                    "srcX": 0, "srcY": 0, "srcW": 1, "srcH": 1,
                    "dstX": 0, "dstY": 0, "dstW": 1, "dstH": 1,
                    "alphaX": 2, "alphaY": 0, "alphaW": 1, "alphaH": 1}
            state.write_text(json.dumps({"rects": [rect] * 15}), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "overflows"):
                validate_a2_frame(atlas, state)

    def test_preflight_port_check_finds_an_existing_listener(self):
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            with self.assertRaises(OSError):
                check_port_available("127.0.0.1", listener.getsockname()[1])

    def test_preflight_rejects_non_bosai_publish_before_launch(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            mediamtx, config = root / "mediamtx.exe", root / "mediamtx.yml"
            mediamtx.touch()
            config.touch()
            with self.assertRaisesRegex(ValueError, "publish URL"):
                preflight(mediamtx, config, None, "127.0.0.1", 8765,
                          "rtsp://127.0.0.1:8554/atlas", "ffmpeg", False,
                          "127.0.0.1", 8766)

    def test_wait_for_rtsp_requires_a_successful_describe(self):
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            listener.listen()
            port = listener.getsockname()[1]

            def respond():
                client, _ = listener.accept()
                with client:
                    client.recv(4096)
                    client.sendall(b"RTSP/1.0 200 OK\r\nCSeq: 1\r\nContent-Length: 0\r\n\r\n")

            thread = Thread(target=respond, daemon=True)
            thread.start()
            wait_for_rtsp(f"rtsp://127.0.0.1:{port}/bosai", FakeChild(), timeout=2)
            thread.join(timeout=1)

    def test_manual_and_scenario_operations_use_the_same_dispatch(self):
        child = FakeChild()
        with tempfile.TemporaryDirectory() as directory, patch("tools.atlas_service.post_json", return_value={"accepted": True}) as post:
            controller = TestController("http://127.0.0.1:8765", {"a2-sender": child})
            controller.apply("events", {"events": [{"xml": "<Report/>"}]})
            controller.apply("layout", {"activeLayout": "reverseL"})
            controller.run_scenario([
                {"atSeconds": 0, "action": "events", "events": [{"xml": "<Report/>"}]},
                {"atSeconds": 0, "action": "fault", "child": "a2-sender", "state": "resume"},
            ])
            deadline = time.monotonic() + 2
            while controller.get_status()["running"] and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertFalse(controller.get_status()["running"])
            self.assertEqual(post.call_count, 3)
            self.assertEqual(child.actions, ["resume"])

    def test_loopback_test_api_updates_layout_events_and_status(self):
        class HealthHandler(BaseHTTPRequestHandler):
            def do_GET(self):
                body = b'{"ok":true,"atlasIIConfig":{"activeLayout":"full","layouts":{"full":[],"reverseL":[]}}}'
                self.send_response(200)
                self.send_header("content-length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *_args):
                pass

        health = ThreadingHTTPServer(("127.0.0.1", 0), HealthHandler)
        health_thread = Thread(target=health.serve_forever, daemon=True)
        health_thread.start()
        child = FakeChild()
        with tempfile.TemporaryDirectory() as directory:
            controller = TestController(f"http://127.0.0.1:{health.server_port}", {"a2-sender": child})
            atlas = Path(directory) / "atlas.png"
            Image.new("RGB", (640, 32), (1, 2, 3)).save(atlas)
            metric_file = Path(directory) / "metrics" / "capture.json"
            metric_file.parent.mkdir()
            metric_file.write_text(json.dumps({"stage": "Chromium capture", "fps": 30}), encoding="utf-8")
            metric_paths = {"chromiumCapture": metric_file, "ffmpeg": Path(directory) / "missing.json"}
            server = make_test_server("127.0.0.1", 0, controller,
                                      f"http://127.0.0.1:{health.server_port}", {"a2-sender": child},
                                      atlas, metric_paths)
            thread = Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                base = f"http://127.0.0.1:{server.server_port}"
                page = urlopen(base + "/").read().decode("utf-8")
                for label in ("Rectレイアウト", "緊急地震速報・横型", "津波", "地震テロップ", "震度速報", "EEW続報", "EEW取消", "単一区域・津波注意報", "単一区域・津波警報", "単一区域・大津波警報"):
                    self.assertIn(label, page)
                self.assertIn("シナリオ実行", page)
                self.assertIn("/bosai/whep", page)
                self.assertIn("streamVideo", page)
                self.assertIn("atlasPreview", page)
                self.assertIn("receiveMetrics", page)
                self.assertIn("requestVideoFrameCallback", page)
                self.assertIn("metadata.presentedFrames", page)
                self.assertIn("p95", page)
                areas = json.loads(urlopen(base + "/test/eew-areas").read())["areas"]
                self.assertEqual(len(areas), 188)
                self.assertIn("areaId", areas[0])
                response = urlopen(base + "/test/atlas.png")
                self.assertEqual(response.headers.get_content_type(), "image/png")
                self.assertEqual(response.headers.get("cache-control"), "no-store")
                self.assertEqual(response.read()[:8], b"\x89PNG\r\n\x1a\n")
                metrics = json.loads(urlopen(base + "/test/metrics").read())
                self.assertEqual(metrics["chromiumCapture"]["fps"], 30)
                self.assertIsNone(metrics["ffmpeg"])
                self.assertFalse(metrics["processes"]["a2-sender"]["available"])
                self.assertFalse(metrics["processes"]["ffmpeg"]["available"])
                self.assertIn("tsunamiArea", page)
                with patch("tools.atlas_service.post_json", return_value={"accepted": True}) as post:
                    request = Request(base + "/test/events", data=b'{"events":[]}',
                                      headers={"content-type": "application/json"}, method="POST")
                    self.assertEqual(json.loads(urlopen(request).read())["accepted"], True)
                    request = Request(base + "/test/layout", data=b'{"activeLayout":"reverseL"}',
                                      headers={"content-type": "application/json"}, method="POST")
                    self.assertEqual(json.loads(urlopen(request).read())["accepted"], True)
                    status = json.loads(urlopen(base + "/test/status").read())
                    self.assertEqual(status["ingest"]["atlasIIConfig"]["activeLayout"], "full")
                    self.assertTrue(status["ingest"]["ok"])
                    areas = json.loads(urlopen(base + "/test/tsunami-areas").read())["areas"]
                    self.assertEqual(len(areas), 66)
                    for preset in ("eew", "eew-followup", "eew-cancel", "tsunami", "earthquake", "intensity-report"):
                        request = Request(base + f"/test/presets/{preset}", data=b'{}',
                                          headers={"content-type": "application/json"}, method="POST")
                        self.assertEqual(json.loads(urlopen(request).read())["accepted"], True)
                    self.assertEqual(post.call_count, 8)
            finally:
                server.shutdown()
                server.server_close()
                atlas.unlink(missing_ok=True)
                health.shutdown()
                health.server_close()


if __name__ == "__main__":
    unittest.main()
