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

    def test_test_api_serves_current_atlas_image(self):
        import io as _io
        import sys as _sys
        _sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "protocol"))
        from atlas_ii_reference import parse_packet, symbols_to_bytes

        child = FakeChild()
        with tempfile.TemporaryDirectory() as directory:
            image_path = Path(directory) / "atlas.png"
            state_path = Path(directory) / "atlas-state.json"
            controller = TestController("http://127.0.0.1:8765", {"a2-sender": child})
            server = make_test_server("127.0.0.1", 0, controller, "http://127.0.0.1:8765",
                                      {"a2-sender": child}, image_path, state_path)
            thread = Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                base = f"http://127.0.0.1:{server.server_port}"
                with self.assertRaises(Exception):
                    urlopen(base + "/atlas.png")
                Image.new("RGB", (640, 320), (16, 32, 48)).save(image_path)
                state_path.write_text(json.dumps({
                    "rects": [], "display": 3, "tsunami": [0] * 66, "eew": [],
                    "mainVideoSize": [640, 320], "outputSize": [640, 320],
                }), encoding="utf-8")
                with urlopen(base + "/atlas.png?t=1234567890") as response:
                    self.assertEqual(response.headers.get_content_type(), "image/png")
                    body = response.read()
                image = Image.open(_io.BytesIO(body)).convert("RGB")
                self.assertEqual(image.size, (640, 320))
                columns = 640 // 8
                palette = [(85 * (s & 3), 85 * ((s >> 2) & 3), 255 * (s >> 4)) for s in range(32)]

                def read_symbols(count):
                    symbols = []
                    for i in range(count):
                        x, y = (i % columns) * 8 + 4, 320 - (i // columns + 1) * 8 + 4
                        pixel = image.getpixel((x, y))
                        symbols.append(min(range(32), key=lambda n: sum(
                            (a - b) ** 2 for a, b in zip(pixel, palette[n]))))
                    return symbols

                # bootstrap header without the strict pad check (bit 224 belongs to byte 28)
                raw_symbols = read_symbols(45)
                bits = []
                for s in raw_symbols:
                    bits.extend((s >> b) & 1 for b in range(5))
                header_bytes = bytes(sum(bits[i * 8 + b] << b for b in range(8)) for i in range(28))
                total = header_bytes[4] | (header_bytes[5] << 8)
                packet = symbols_to_bytes(read_symbols((total * 8 + 4) // 5), total)
                decoded = parse_packet(packet, actual_atlas_size=(640, 320), actual_main_size=(640, 320))
                self.assertEqual(decoded["displayFlags"], 3)
                self.assertEqual(decoded["rects"], [])
            finally:
                server.shutdown()
                server.server_close()

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
            server = make_test_server("127.0.0.1", 0, controller,
                                      f"http://127.0.0.1:{health.server_port}", {"a2-sender": child})
            thread = Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                base = f"http://127.0.0.1:{server.server_port}"
                page = urlopen(base + "/").read().decode("utf-8")
                for label in ("Rectレイアウト", "緊急地震速報・横型", "津波", "地震テロップ"):
                    self.assertIn(label, page)
                self.assertIn("シナリオ実行", page)
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
                    for preset in ("eew", "tsunami", "earthquake"):
                        request = Request(base + f"/test/presets/{preset}", data=b'{}',
                                          headers={"content-type": "application/json"}, method="POST")
                        self.assertEqual(json.loads(urlopen(request).read())["accepted"], True)
                    self.assertEqual(post.call_count, 5)
            finally:
                server.shutdown()
                server.server_close()
                health.shutdown()
                health.server_close()


if __name__ == "__main__":
    unittest.main()
