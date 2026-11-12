import json
import socket
import tempfile
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import ipaddress
from pathlib import Path
from threading import Event, Thread
from unittest.mock import MagicMock, patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from PIL import Image
from tools.atlas_service import (TestController, check_port_available, expand_scenario, start_live_sources,
                                 make_test_server, preflight, validate_a2_frame, wait_for_rtsp, Child)


class FakeChild:
    def __init__(self):
        self.actions = []
        self.process = None
        self.enabled = True
        self.restarts = 0

    def suspend(self):
        self.actions.append("stop")
        self.enabled = False

    def resume(self):
        self.actions.append("resume")
        self.enabled = True

    def start(self):
        self.actions.append("start")

    def status(self):
        return {"running": False, "enabled": self.enabled, "restarts": self.restarts}

    def check(self, _now):
        pass


class AtlasServiceTest(unittest.TestCase):
    @patch('tools.atlas_service.socket.create_connection')
    @patch('tools.atlas_service.socket.getaddrinfo', return_value=[(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('8.8.8.8', 8554))])
    @patch('tools.atlas_service.urlopen')
    def test_network_diagnostic_compares_public_ip_dns_router_and_outbound_tcp(self, open_url, resolve, connect):
        from tools.atlas_service import run_network_diagnostic
        open_url.return_value=io.BytesIO(b'8.8.8.8')
        connect.return_value.__enter__.return_value=None
        result=run_network_diagnostic('1.1.1.1')
        self.assertEqual(result['ddnsMatchesPublicIPv4'],True)
        self.assertEqual(result['routerWanMatchesPublicIPv4'],False)
        self.assertEqual(result['outboundTcp8554'],True)
        self.assertEqual(result['inboundFirewallChecked'],False)
        self.assertEqual(resolve.call_args.args[0],'stream.usuiensan.dev')

    def test_network_diagnostic_rejects_non_ipv4_router_input(self):
        from tools.atlas_service import run_network_diagnostic
        with self.assertRaisesRegex(ValueError,'IPv4'):
            run_network_diagnostic('localhost')

    def test_fault_control_stops_and_resumes_the_selected_source_process(self):
        source = FakeChild()
        controller = TestController("http://127.0.0.1:8765", {"jma-p2p-sources": source})
        self.assertEqual(controller.apply("fault", {"child": "jma-p2p-sources", "action": "stop"}),
                         {"child": "jma-p2p-sources", "state": "stop"})
        self.assertEqual(source.actions, ["stop"])
        self.assertEqual(controller.apply("fault", {"child": "jma-p2p-sources", "action": "resume"}),
                         {"child": "jma-p2p-sources", "state": "resume"})
        self.assertEqual(source.actions, ["stop", "resume"])

    def test_child_status_keeps_unexpected_exit_code_and_ignores_manual_stop(self):
        class ExitedProcess:
            def __init__(self, code):
                self.returncode = code

            def poll(self):
                return self.returncode

        child = Child("unit", [], MagicMock())
        child.process = ExitedProcess(7)
        child.check(10)
        self.assertEqual(child.status()["lastExitCode"], 7)
        self.assertEqual(child.status()["restarts"], 1)

        child.enabled = False
        child.process = ExitedProcess(-15)
        child.check(11)
        self.assertEqual(child.status()["lastExitCode"], 7)
        self.assertEqual(child.status()["restarts"], 1)

    def test_test_api_starts_with_live_sources_disabled(self):
        source = FakeChild()
        start_live_sources(source, test_api=True)
        self.assertEqual(source.actions, ["stop"])
        source = FakeChild()
        start_live_sources(source, test_api=False)
        self.assertEqual(source.actions, ["start"])

    def test_test_api_refuses_non_loopback_bind(self):
        with self.assertRaisesRegex(ValueError, "loopback"):
            make_test_server("0.0.0.0", 0, None, "http://127.0.0.1:8765", {}, Path("atlas.png"), {})

    def test_layout_config_is_validated_as_an_a2_packet_before_forwarding(self):
        controller = TestController("http://127.0.0.1:8765", {})
        rect = {"source": 1, "mode": 0, "visible": True, "opacity": 255,
                "srcX": 0, "srcY": 0, "srcW": 1920, "srcH": 1080,
                "dstX": 0, "dstY": 0, "dstW": 1920, "dstH": 1080}
        config = {"activeLayout": "full", "atlasSize": [1936, 1168],
                  "mainVideoSize": [1920, 1080], "outputSize": [1920, 1080],
                  "layouts": {"full": [rect], "inactive": [{"source": 9}]}}
        with patch("tools.atlas_service.post_json", return_value={"accepted": True}) as post:
            controller.apply("layout", {"activeLayout": "full", "atlasIIConfig": config})
            post.assert_called_once()
            invalid = {**config, "layouts": {"full": [{**rect, "srcW": 65535}]}}
            with self.assertRaisesRegex(ValueError, "outside texture"):
                controller.apply("layout", {"activeLayout": "full", "atlasIIConfig": invalid})
            self.assertEqual(post.call_count, 1)
            invalid = {**config, "layouts": {"full": [{**rect, "source": True}]}}
            with self.assertRaisesRegex(ValueError, "source/mode"):
                controller.apply("layout", {"activeLayout": "full", "atlasIIConfig": invalid})
            self.assertEqual(post.call_count, 1)
            invalid = {**config, "atlasSize": [639, 32]}
            with self.assertRaises(ValueError):
                controller.apply("layout", {"activeLayout": "full", "atlasIIConfig": invalid})
            self.assertEqual(post.call_count, 1)
            with self.assertRaises(ValueError):
                controller.apply("layout", {"activeLayout": "inactive", "atlasIIConfig": config})
            self.assertEqual(post.call_count, 1)

    def test_scenario_expands_repeat_steps_in_time_order(self):
        steps = expand_scenario([
            {"atSeconds": 5, "action": "events", "everySeconds": 5, "count": 2},
            {"atSeconds": 8, "action": "layout", "activeLayout": "reverseL"},
        ])
        self.assertEqual([item[0] for item in steps], [5, 8, 10])
        with self.assertRaises(ValueError):
            expand_scenario([{"atSeconds": 0, "action": "layout", "count": 2}])
        self.assertEqual(expand_scenario([{"atSeconds": 0, "action": "clock", "advanceMs": 1000}])[0][2]["advanceMs"], 1000)

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
            controller.apply("clock", {"advanceMs": 1000})
            controller.run_scenario([
                {"atSeconds": 0, "action": "events", "events": [{"xml": "<Report/>"}]},
                {"atSeconds": 0, "action": "fault", "child": "a2-sender", "state": "resume"},
            ])
            deadline = time.monotonic() + 2
            while controller.get_status()["running"] and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertFalse(controller.get_status()["running"])
            self.assertEqual(controller.get_status()["result"], "completed")
            self.assertEqual(post.call_count, 4)
            self.assertEqual(post.call_args_list[2].args[0], "http://127.0.0.1:8765/test/clock")
            self.assertEqual(child.actions, ["resume"])

    def test_scenario_can_pause_resume_and_stop_between_steps(self):
        started = Event()
        calls = []
        controller = TestController("http://127.0.0.1:8765", {})
        def apply(_action, payload):
            calls.append(payload["id"])
            started.set()
            return {"accepted": True, "id": payload["id"]}
        controller.apply = apply
        controller.run_scenario([
            {"atSeconds": 0, "action": "events", "id": "first"},
            {"atSeconds": 0.2, "action": "events", "id": "second"},
            {"atSeconds": 0.4, "action": "events", "id": "third"},
        ])
        self.assertTrue(started.wait(1))
        self.assertTrue(controller.pause_scenario()["paused"])
        time.sleep(0.3)
        self.assertEqual(calls, ["first"])
        self.assertTrue(controller.get_status()["paused"])
        self.assertEqual(controller.get_status()["result"], "running")
        self.assertEqual(controller.get_status()["currentStep"], 2)
        self.assertEqual(controller.get_status()["total"], 3)
        self.assertEqual(controller.get_status()["lastResult"]["id"], "first")
        self.assertGreaterEqual(controller.get_status()["remainingSeconds"], 0)
        self.assertLessEqual(controller.get_status()["remainingSeconds"], 0.2)
        self.assertTrue(controller.resume_scenario()["resumed"])
        deadline = time.monotonic() + 2
        while controller.get_status()["step"] < 2 and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertEqual(calls[:2], ["first", "second"])
        self.assertTrue(controller.stop_scenario()["stopping"])
        deadline = time.monotonic() + 1
        while controller.get_status()["running"] and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertEqual(calls, ["first", "second"])
        self.assertFalse(controller.get_status()["running"])
        self.assertFalse(controller.get_status()["paused"])
        self.assertEqual(controller.get_status()["result"], "stopped")
        controller.run_scenario([{"atSeconds": 0, "action": "events", "id": "rerun"}])
        deadline = time.monotonic() + 1
        while controller.get_status()["running"] and time.monotonic() < deadline:
            time.sleep(0.01)
        self.assertEqual(calls[-1], "rerun")
        self.assertEqual(controller.get_status()["result"], "completed")

    def test_scenario_replays_delayed_reordered_cancel_and_recovery_events(self):
        controller = TestController("http://127.0.0.1:8765", {})
        sent = []
        with patch("tools.atlas_service.post_json", side_effect=lambda _url, payload: sent.append((time.monotonic(), payload)) or {"accepted": True}):
            controller.run_scenario([
                {"atSeconds": 0, "action": "events", "events": [{"serial": 1, "infoType": "発表"}]},
                {"atSeconds": 0.08, "action": "events", "events": [{"serial": 2, "infoType": "発表"}]},
                {"atSeconds": 0.04, "everySeconds": 0.03, "count": 2, "action": "events", "events": [{"serial": 3, "infoType": "発表"}]},
                {"atSeconds": 0.12, "action": "events", "events": [{"serial": 4, "infoType": "取消"}]},
                {"atSeconds": 0.16, "action": "events", "events": [{"serial": 5, "infoType": "発表"}]},
            ])
            deadline = time.monotonic() + 2
            while controller.get_status()["running"] and time.monotonic() < deadline:
                time.sleep(0.005)
        self.assertEqual([payload["events"][0]["serial"] for _, payload in sent], [1, 3, 3, 2, 4, 5])
        self.assertEqual([payload["events"][0]["infoType"] for _, payload in sent], ["発表", "発表", "発表", "発表", "取消", "発表"])
        self.assertGreaterEqual(sent[-1][0] - sent[0][0], 0.12)
        self.assertEqual(controller.get_status()["result"], "completed")

    def test_scenario_checks_expected_result_and_state(self):
        controller = TestController("http://127.0.0.1:8765", {})
        controller.apply = lambda _action, _payload: {"accepted": True, "kinds": ["eew"]}
        health = MagicMock()
        health.__enter__.return_value.read.return_value = b'{"testMode":true,"activeLayers":{"eew":1,"tsunami":0}}'
        with patch("tools.atlas_service.urlopen", return_value=health):
            controller.run_scenario([{"atSeconds": 0, "action": "events", "expect": {
                "result": {"accepted": True}, "testMode": True, "activeLayers": {"eew": 1}}}])
            deadline = time.monotonic() + 1
            while controller.get_status()["running"] and time.monotonic() < deadline:
                time.sleep(0.005)
        status = controller.get_status()
        self.assertEqual(status["result"], "completed")
        self.assertEqual(len(status["checks"]), 1)
        self.assertTrue(status["checks"][0]["passed"])

        health.__enter__.return_value.read.return_value = b'{"testMode":true,"activeLayers":{"eew":1}}'
        with patch("tools.atlas_service.urlopen", return_value=health):
            controller.run_scenario([{"atSeconds": 0, "action": "events", "expect": {"activeLayers": {"eew": 2}}}])
            deadline = time.monotonic() + 1
            while controller.get_status()["running"] and time.monotonic() < deadline:
                time.sleep(0.005)
        self.assertEqual(controller.get_status()["result"], "failed")
        self.assertFalse(controller.get_status()["checks"][0]["passed"])

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
        source = FakeChild()
        children = {"a2-sender": child, "jma-p2p-sources": source}
        with tempfile.TemporaryDirectory() as directory:
            controller = TestController(f"http://127.0.0.1:{health.server_port}", children)
            atlas = Path(directory) / "atlas.png"
            Image.new("RGB", (640, 32), (1, 2, 3)).save(atlas)
            metric_file = Path(directory) / "metrics" / "capture.json"
            metric_file.parent.mkdir()
            metric_file.write_text(json.dumps({"stage": "Chromium capture", "fps": 30}), encoding="utf-8")
            metric_paths = {"chromiumCapture": metric_file, "ffmpeg": Path(directory) / "missing.json"}
            log_dir = Path(directory) / "logs"
            log_dir.mkdir()
            (log_dir / "ingest.log").write_text("INFO accepted bulletin\nERROR rejected fixture\n", encoding="utf-8")
            server = make_test_server("127.0.0.1", 0, controller,
                                      f"http://127.0.0.1:{health.server_port}", children,
                                      atlas, metric_paths)
            thread = Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                base = f"http://127.0.0.1:{server.server_port}"
                page = urlopen(base + "/").read().decode("utf-8")
                self.assertIn("WAN / DDNS / Firewall診断", page)
                ui_script = urlopen(base + "/test/atlas_test_ui.js")
                self.assertEqual(ui_script.headers.get_content_type(), "text/javascript")
                ui_source = ui_script.read().decode("utf-8")
                self.assertIn("function submitCustomEEW", ui_source)
                verify_script = urlopen(base + "/test/atlas_test_ui_verify.js")
                self.assertEqual(verify_script.headers.get_content_type(), "text/javascript")
                verify_source = verify_script.read().decode("utf-8")
                self.assertIn("function verifyStreamFrame", verify_source)
                with patch("tools.atlas_service.run_network_diagnostic", return_value={"targetHost":"stream.usuiensan.dev","inboundFirewallChecked":False}) as diagnostic:
                    request = Request(base + "/test/network-diagnostic", data=b'{"routerWanIPv4":"192.168.1.2"}',
                                      headers={"content-type":"application/json"}, method="POST")
                    self.assertFalse(json.loads(urlopen(request).read())["inboundFirewallChecked"])
                    diagnostic.assert_called_once_with("192.168.1.2")
                request = Request(base + "/test/network-diagnostic", data=b'{"host":"127.0.0.1"}',
                                  headers={"content-type":"application/json"}, method="POST")
                with self.assertRaises(HTTPError) as invalid:
                    urlopen(request)
                self.assertEqual(invalid.exception.code,422)
                for tester_path, marker in (
                    ("/test/tools/tsunami-tester.html", "津波ミニマップ"),
                    ("/test/tools/tsunami-zonecheck.html", "id=\"zc-list\""),
                    ("/test/tools/eew-telop-tester.html", "EEWテロップ"),
                    ("/test/tools/tester/index.html", "EEWテロップ・テスター"),
                    ("/test/tools/tester/geojson.js", "PREF_GEOJSON"),
                    ("/test/tools/tester/hkzones.js", "HKZONES"),
                ):
                    tester_response = urlopen(base + tester_path)
                    self.assertIn(marker, tester_response.read().decode("utf-8"))
                with self.assertRaises(HTTPError):
                    urlopen(base + "/test/tools/atlas_ii.py")
                self.assertIn("/test/tools/tsunami-tester.html", page)
                map_preview = urlopen(base + "/test/tsunami-map-preview")
                self.assertEqual(map_preview.headers.get_content_type(), "text/html")
                self.assertIn('id="zc-list"', map_preview.read().decode("utf-8"))
                for label in ("Rectレイアウト", "緊急地震速報・横型", "津波", "地震テロップ", "震度速報", "EEW続報", "EEW取消", "単一区域・津波注意報", "単一区域・津波警報", "単一区域・大津波警報"):
                    self.assertIn(label, page)
                for label in ("シナリオ実行・再実行", "一時停止", "再開", "停止"):
                    self.assertIn(label, page)
                self.assertIn("実データ入力", page)
                for action, key in (("pause", "paused"), ("resume", "resumed"), ("stop", "stopping")):
                    request = Request(base + f"/test/scenarios/{action}", data=b"{}",
                                      headers={"content-type": "application/json"}, method="POST")
                    self.assertFalse(json.loads(urlopen(request).read())[key])
                request = Request(base + "/test/live-inputs", data=b'{"enabled":false}',
                                  headers={"content-type": "application/json"}, method="POST")
                self.assertEqual(json.loads(urlopen(request).read())["enabled"], False)
                request = Request(base + "/test/live-inputs", data=b'{"enabled":true}',
                                  headers={"content-type": "application/json"}, method="POST")
                self.assertEqual(json.loads(urlopen(request).read())["enabled"], True)
                self.assertIn("/bosai/whep", verify_source)
                self.assertIn("streamVideo", page)
                self.assertIn("atlasPreview", page)
                self.assertIn("receiveMetrics", page)
                self.assertIn("requestVideoFrameCallback", verify_source)
                self.assertIn("metadata.presentedFrames", verify_source)
                self.assertIn("p95", ui_source + verify_source)
                logs = json.loads(urlopen(base + "/test/logs?component=ingest&query=ERROR").read())
                self.assertEqual(logs["lineCount"], 1)
                self.assertIn("rejected fixture", logs["content"])
                saved_logs = urlopen(base + "/test/logs?component=ingest&query=ERROR&download=1")
                self.assertIn("attachment; filename=\"atlas-ingest-logs.txt\"", saved_logs.headers.get("content-disposition"))
                self.assertIn("rejected fixture", saved_logs.read().decode("utf-8"))
                with self.assertRaises(HTTPError):
                    urlopen(base + "/test/logs?component=..%2Fstate.json")
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
                    self.assertEqual(status["environment"]["protocolVersion"], 2)
                    self.assertTrue(status["environment"]["platform"])
                    self.assertTrue(status["environment"]["python"])
                    self.assertTrue(status["environment"]["gitSha"])
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
