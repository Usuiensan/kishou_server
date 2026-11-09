import json
import tempfile
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
from unittest.mock import patch
from urllib.request import Request, urlopen

from tools.atlas_service import TestController, expand_scenario, make_test_server, read_control_state, update_control_state


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


class AtlasServiceTest(unittest.TestCase):
    def test_mode_controls_validate_and_merge_fields(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "controls.json"
            self.assertEqual(read_control_state(path)["mode"], 1)
            values = update_control_state(path, {"mode": 2, "flags": 7})
            self.assertEqual(values, {"flags": 7, "mode": 2, "opacity": 255, "lower_x": 281, "lower_y": 619})
            with self.assertRaises(ValueError):
                update_control_state(path, {"mode": 256})

    def test_scenario_expands_repeat_steps_in_time_order(self):
        steps = expand_scenario([
            {"atSeconds": 5, "action": "events", "everySeconds": 5, "count": 2},
            {"atSeconds": 8, "action": "mode", "values": {"flags": 7}},
        ])
        self.assertEqual([item[0] for item in steps], [5, 8, 10])
        with self.assertRaises(ValueError):
            expand_scenario([{"atSeconds": 0, "action": "mode", "count": 2}])

    def test_manual_and_scenario_operations_use_the_same_dispatch(self):
        child = FakeChild()
        with tempfile.TemporaryDirectory() as directory, patch("tools.atlas_service.post_json", return_value={"accepted": True}) as post:
            controller = TestController("http://127.0.0.1:8765", Path(directory) / "controls.json", {"sender": child})
            controller.apply("events", {"events": [{"xml": "<Report/>"}]})
            controller.apply("mode", {"flags": 7})
            controller.run_scenario([
                {"atSeconds": 0, "action": "events", "events": [{"xml": "<Report/>"}]},
                {"atSeconds": 0, "action": "fault", "child": "sender", "state": "resume"},
            ])
            deadline = time.monotonic() + 2
            while controller.get_status()["running"] and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertFalse(controller.get_status()["running"])
            self.assertEqual(post.call_count, 2)
            self.assertEqual(child.actions, ["resume"])

    def test_loopback_control_api_updates_mode_events_and_status(self):
        class HealthHandler(BaseHTTPRequestHandler):
            def do_GET(self):
                body = b'{"ok":true}'
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
            controls = Path(directory) / "controls.json"
            controller = TestController(f"http://127.0.0.1:{health.server_port}", controls, {"sender": child})
            server = make_test_server("127.0.0.1", 0, controller,
                                      f"http://127.0.0.1:{health.server_port}", {"sender": child})
            thread = Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                base = f"http://127.0.0.1:{server.server_port}"
                with patch("tools.atlas_service.post_json", return_value={"accepted": True}) as post:
                    request = Request(base + "/test/events", data=b'{"events":[]}',
                                      headers={"content-type": "application/json"}, method="POST")
                    self.assertEqual(json.loads(urlopen(request).read())["accepted"], True)
                    request = Request(base + "/test/mode", data=b'{"mode":2,"flags":7}',
                                      headers={"content-type": "application/json"}, method="POST")
                    self.assertEqual(json.loads(urlopen(request).read())["controls"]["mode"], 2)
                    status = json.loads(urlopen(base + "/test/status").read())
                    self.assertEqual(status["controls"]["flags"], 7)
                    self.assertTrue(status["ingest"]["ok"])
                    self.assertEqual(post.call_count, 1)
            finally:
                server.shutdown()
                server.server_close()
                health.shutdown()
                health.server_close()


if __name__ == "__main__":
    unittest.main()
