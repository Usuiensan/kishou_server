import json
import os
import struct
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock
from io import BytesIO
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))

from PIL import Image

from overlay_sender import (CAPTURE_HEIGHT, CAPTURE_WIDTH, DEFAULT_FPS,
                            FRAME_HEIGHT, FRAME_WIDTH, OVERLAY_HEIGHT,
                            OVERLAY_WIDTH, capture_command, compose_overlay,
                            ffmpeg_command, poll_state_snapshots, read_frame,
                            start_state_watcher, stream_frames)


def solid(rgba):
    return Image.new("RGBA", (OVERLAY_WIDTH, OVERLAY_HEIGHT), rgba)


def framed(image):
    buffer = BytesIO()
    image.save(buffer, format="PNG")
    payload = buffer.getvalue()
    return struct.pack(">I", len(payload)) + payload


class ComposeOverlayTest(unittest.TestCase):
    def test_stacks_rgb_over_alpha(self):
        frame = solid((10, 20, 30, 128))
        out = compose_overlay(frame)
        self.assertEqual(out.size, (FRAME_WIDTH, FRAME_HEIGHT))
        self.assertEqual(out.getpixel((0, 0)), (10, 20, 30))
        self.assertEqual(out.getpixel((OVERLAY_WIDTH - 1, OVERLAY_HEIGHT - 1)), (10, 20, 30))
        self.assertEqual(out.getpixel((0, OVERLAY_HEIGHT)), (128, 128, 128))
        self.assertEqual(out.getpixel((OVERLAY_WIDTH - 1, FRAME_HEIGHT - 1)), (128, 128, 128))

    def test_fully_transparent_canvas_is_all_black(self):
        out = compose_overlay(solid((200, 100, 50, 0)))
        self.assertEqual(out.getpixel((0, OVERLAY_HEIGHT)), (0, 0, 0))

    def test_idle_canvas_carries_standby_mark(self):
        # A fully transparent (idle) canvas must still carry a visible
        # standby mark at the bottom-right of both halves, so receivers
        # can confirm at a glance that the overlay stream is alive.
        out = compose_overlay(solid((0, 0, 0, 0)))
        rgb_region = out.crop((OVERLAY_WIDTH - 300, OVERLAY_HEIGHT - 100,
                               OVERLAY_WIDTH, OVERLAY_HEIGHT)).convert("L")
        alpha_region = out.crop((OVERLAY_WIDTH - 300, FRAME_HEIGHT - 100,
                                 OVERLAY_WIDTH, FRAME_HEIGHT)).convert("L")
        self.assertEqual(rgb_region.getextrema()[1], 255)
        self.assertEqual(alpha_region.getextrema()[1], 255)
        self.assertEqual(out.getpixel((0, 0)), (0, 0, 0))
        self.assertEqual(out.getpixel((0, OVERLAY_HEIGHT)), (0, 0, 0))

    def test_idle_capture_size_carries_standby_mark(self):
        frame = Image.new("RGBA", (CAPTURE_WIDTH, CAPTURE_HEIGHT), (0, 0, 0, 0))
        out = compose_overlay(frame)
        alpha_region = out.crop((OVERLAY_WIDTH - 300, FRAME_HEIGHT - 100,
                                 OVERLAY_WIDTH, FRAME_HEIGHT)).convert("L")
        self.assertEqual(alpha_region.getextrema()[1], 255)

    def test_idle_mark_disabled_by_env(self):
        import os
        from unittest import mock
        with mock.patch.dict(os.environ, {"OVERLAY_IDLE_MARK": "0",
                                          "OVERLAY_TEST_MARK": "0"}):
            out = compose_overlay(solid((200, 100, 50, 0)))
        alpha_region = out.crop((OVERLAY_WIDTH - 300, FRAME_HEIGHT - 100,
                                 OVERLAY_WIDTH, FRAME_HEIGHT)).convert("L")
        self.assertEqual(alpha_region.getextrema()[1], 0)

    def test_test_mark_present_on_content_frame(self):
        # The semi-transparent test mark rides every frame, content or
        # not: alpha glyphs sit at TEST_MARK_ALPHA in the bottom-right.
        out = compose_overlay(solid((200, 100, 50, 128)))
        alpha_region = out.crop((OVERLAY_WIDTH - 300, FRAME_HEIGHT - 100,
                                 OVERLAY_WIDTH, FRAME_HEIGHT)).convert("L")
        self.assertIn(150, list(alpha_region.getdata()))

    def test_idle_frame_carries_both_marks(self):
        out = compose_overlay(solid((0, 0, 0, 0)))
        alpha_region = out.crop((OVERLAY_WIDTH - 300, FRAME_HEIGHT - 160,
                                 OVERLAY_WIDTH, FRAME_HEIGHT)).convert("L")
        values = list(alpha_region.getdata())
        self.assertIn(255, values)   # STANDBY, fully opaque
        self.assertIn(150, values)   # test mark, semi-transparent

    def test_test_mark_disabled_by_env(self):
        import os
        from unittest import mock
        with mock.patch.dict(os.environ, {"OVERLAY_TEST_MARK": "0"}):
            out = compose_overlay(solid((200, 100, 50, 128)))
        alpha_region = out.crop((OVERLAY_WIDTH - 300, FRAME_HEIGHT - 100,
                                 OVERLAY_WIDTH, FRAME_HEIGHT)).convert("L")
        self.assertNotIn(150, list(alpha_region.getdata()))

    def test_capture_size_is_downscaled(self):
        frame = Image.new("RGBA", (CAPTURE_WIDTH, CAPTURE_HEIGHT), (10, 20, 30, 128))
        out = compose_overlay(frame)
        self.assertEqual(out.size, (FRAME_WIDTH, FRAME_HEIGHT))
        self.assertEqual(out.getpixel((640, 360)), (10, 20, 30))
        self.assertEqual(out.getpixel((640, OVERLAY_HEIGHT + 360)), (128, 128, 128))

    def test_rejects_wrong_canvas_size(self):
        with self.assertRaises(ValueError):
            compose_overlay(Image.new("RGBA", (1270, 720)))


class DeliveryRateTest(unittest.TestCase):
    def test_default_delivery_is_30fps(self):
        self.assertEqual(DEFAULT_FPS, 30)

    def test_ffmpeg_command_uses_30fps_and_matching_gop(self):
        command = ffmpeg_command("rtsp://127.0.0.1:8554/bosai-overlay", DEFAULT_FPS, 54321)
        self.assertEqual(command[command.index("-r") + 1], "30")
        self.assertEqual(command[command.index("-g") + 1], "60")

    def test_capture_default_interval_is_100ms(self):
        source = (Path(__file__).resolve().parents[1] / "tools" / "capture_overlay.js").read_text(encoding="utf-8")
        self.assertIn("interval: 100", source)


class CaptureOverlayScriptTest(unittest.TestCase):
    def test_script_keeps_only_the_two_overlay_elements(self):
        source = (Path(__file__).resolve().parents[1] / "tools" / "capture_overlay.js").read_text(encoding="utf-8")
        for marker in ("#eew-box", "#atlas-intensity", "zoom: 1.5",
                       "width: 1920, height: 1080", "#atlas-alpha-mirror",
                       "#tsunami-mini", "#eew-v"):
            self.assertIn(marker, source)


class CaptureCommandTest(unittest.TestCase):
    def test_spawns_overlay_capture_for_state(self):
        command = capture_command("node", Path("/tmp/atlas-state.json"), None)
        self.assertEqual(command[0], "node")
        self.assertTrue(command[1].endswith("capture_overlay.js"))
        self.assertEqual(command[2:], ["--state", "/tmp/atlas-state.json"])

    def test_passes_browser_through(self):
        command = capture_command("node", Path("/tmp/atlas-state.json"), "/usr/local/bin/chrome")
        self.assertEqual(command[-2:], ["--browser", "/usr/local/bin/chrome"])


class FrameIoTest(unittest.TestCase):
    def test_read_frame_round_trip_and_eof(self):
        stream = BytesIO(framed(solid((1, 2, 3, 255))))
        frame = read_frame(stream)
        self.assertEqual(frame.size, (OVERLAY_WIDTH, OVERLAY_HEIGHT))
        self.assertIsNone(read_frame(stream))

    def test_stream_frames_repeats_latest_frame_at_fps(self):
        # One input frame held for ~0.25s at 50fps must be written many
        # times: the RTSP session needs a constant frame flow even when
        # the telop is static.
        import os
        import threading
        import time as time_module

        class CountingSink:
            def __init__(self):
                self.bytes = 0
                self.writes = 0

            def write(self, data):
                self.bytes += len(data)
                self.writes += 1
                return len(data)

            def flush(self):
                pass

        read_end, write_end = os.pipe()

        def feed():
            with os.fdopen(write_end, "wb") as writer:
                writer.write(framed(solid((7, 7, 7, 255))))
                writer.flush()
                time_module.sleep(0.25)

        feeder = threading.Thread(target=feed)
        feeder.start()
        with os.fdopen(read_end, "rb") as source:
            sink = CountingSink()
            forwarded = stream_frames(source, sink, fps=50)
        feeder.join()
        frame_bytes = FRAME_WIDTH * FRAME_HEIGHT * 3
        self.assertEqual(sink.bytes, forwarded * frame_bytes)
        self.assertEqual(sink.writes, forwarded)
        self.assertGreaterEqual(forwarded, 3)


class FfmpegCommandTest(unittest.TestCase):
    def test_command_is_fixed_size_2fps_bt709(self):
        command = ffmpeg_command("rtsp://127.0.0.1:8554/bosai-overlay", 2, 54321)
        self.assertIn("1280x1440", command)
        self.assertEqual(command[command.index("-r") + 1], "2")
        self.assertIn("bt709", command)
        self.assertEqual(command[-1], "rtsp://127.0.0.1:8554/bosai-overlay")


if __name__ == "__main__":
    unittest.main()


class FfmpegAudioTest(unittest.TestCase):
    def test_command_carries_constant_mono_audio(self):
        command = ffmpeg_command("rtsp://127.0.0.1:8554/bosai", 30, 54321)
        self.assertIn("tcp://127.0.0.1:54321", command)
        self.assertIn("s16le", command)
        self.assertEqual(command[command.index("-ar") + 1], "48000")
        self.assertEqual(command[command.index("-map", command.index("-map") + 1) + 1], "1:a:0")
        self.assertEqual(command[command.index("-map") + 1], "0:v:0")
        self.assertEqual(command[command.index("-c:a") + 1], "aac")
        self.assertEqual(command[command.index("-b:a") + 1], "96k")
        self.assertNotIn("-an", command)


class RecordingTracker:
    def __init__(self):
        self.snapshots = []

    def on_snapshot(self, snapshot):
        self.snapshots.append(snapshot)


class StateWatcherTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.state = Path(self.tmp.name) / "state.json"
        self.stop = threading.Event()
        self.errors = []

    def tearDown(self):
        self.stop.set()
        self.tmp.cleanup()

    def write_state(self, payload, bump_ns):
        self.state.write_text(json.dumps(payload), encoding="utf-8")
        stat = self.state.stat()
        os.utime(self.state, ns=(stat.st_atime_ns, stat.st_mtime_ns + bump_ns))

    def test_delivers_initial_and_updated_snapshots(self):
        self.write_state({"layers": {"eew": []}}, 0)
        tracker = RecordingTracker()
        thread = start_state_watcher(self.state, tracker, self.stop,
                                      self.errors, interval=0.02)
        try:
            deadline = time.time() + 5
            while not tracker.snapshots and time.time() < deadline:
                time.sleep(0.01)
            self.assertEqual(len(tracker.snapshots), 1)
            self.write_state({"layers": {"eew": [{"event": {"id": "x"}}]}}, 1_000_000)
            while len(tracker.snapshots) < 2 and time.time() < deadline:
                time.sleep(0.01)
            self.assertEqual(len(tracker.snapshots), 2)
            self.assertEqual(tracker.snapshots[1]["layers"]["eew"][0]["event"]["id"], "x")
            self.assertEqual(self.errors, [])
        finally:
            self.stop.set()
            thread.join(timeout=2)

    def test_json_error_is_recorded_and_stops_watcher(self):
        self.state.write_text("{not json", encoding="utf-8")
        tracker = RecordingTracker()
        failed = []
        thread = start_state_watcher(self.state, tracker, self.stop,
                                      self.errors,
                                      on_error=lambda: failed.append(True),
                                      interval=0.02)
        thread.join(timeout=5)
        self.assertEqual(len(self.errors), 1)
        self.assertIsInstance(self.errors[0], json.JSONDecodeError)
        self.assertTrue(self.stop.is_set())
        self.assertEqual(failed, [True])

    def test_poll_raises_on_missing_state_file(self):
        tracker = RecordingTracker()
        with self.assertRaises(FileNotFoundError):
            poll_state_snapshots(self.state, tracker, self.stop, interval=0.02)


class FakeStdin:
    def __init__(self, events):
        self.events = events

    def close(self):
        self.events.append("process.stdin.close")


class FakeProcess:
    def __init__(self, events, command):
        self.events = events
        self.command = command
        self.stdin = FakeStdin(events)
        self.stdout = BytesIO()
        self._poll = None

    def poll(self):
        return self._poll

    def terminate(self):
        self.events.append("process.terminate")
        self._poll = -15

    def wait(self):
        self.events.append("process.wait")
        self._poll = 0
        return 0


class FakeFeeder:
    instances = []

    def __init__(self, ffmpeg="ffmpeg", events=None):
        self.port = 54321
        self.events = events if events is not None else []
        FakeFeeder.instances.append(self)

    def start(self):
        self.events.append("feeder.start")

    def close(self):
        self.events.append("feeder.close")

    def stop(self):
        self.events.append("feeder.stop")


class MainAudioWiringTest(unittest.TestCase):
    def run_main(self, argv, state_payload=None):
        import overlay_sender
        events = []
        processes = []

        def fake_feeder(ffmpeg="ffmpeg"):
            return FakeFeeder(ffmpeg=ffmpeg, events=events)

        class FakeTracker:
            def __init__(self, feeder):
                events.append("tracker.created")
                self.feeder = feeder

            def on_snapshot(self, snapshot):
                events.append("tracker.snapshot")

        def fake_popen(command, **kwargs):
            process = FakeProcess(events, command)
            processes.append(process)
            events.append("popen:" + ("capture" if "capture_overlay" in command[1] else "ffmpeg"))
            return process

        def fake_stream(source, sink, fps):
            events.append("stream_frames")
            return 0

        with tempfile.TemporaryDirectory() as tmp:
            full_argv = ["overlay_sender.py", "--url", "rtsp://127.0.0.1:8554/bosai"]
            if state_payload is not None:
                state = Path(tmp) / "state.json"
                state.write_text(json.dumps(state_payload), encoding="utf-8")
                full_argv += ["--state", str(state)]
            with mock.patch.object(sys, "argv", full_argv), \
                    mock.patch.object(overlay_sender, "EewAudioFeeder", fake_feeder), \
                    mock.patch.object(overlay_sender, "EewAudioTracker", FakeTracker), \
                    mock.patch.object(overlay_sender.subprocess, "Popen", fake_popen), \
                    mock.patch.object(overlay_sender, "stream_frames", fake_stream):
                overlay_sender.main()
        return events, processes

    def test_without_state_feeder_runs_but_tracker_does_not(self):
        events, processes = self.run_main([])
        self.assertIn("feeder.start", events)
        self.assertNotIn("tracker.created", events)
        ffmpeg_command_used = processes[0].command
        self.assertIn("tcp://127.0.0.1:54321", ffmpeg_command_used)
        self.assertLess(events.index("feeder.close"), events.index("process.wait"))

    def test_with_state_tracker_created_and_close_order(self):
        events, processes = self.run_main([], state_payload={"layers": {"eew": []}})
        self.assertIn("tracker.created", events)
        self.assertLess(events.index("feeder.close"), events.index("process.wait"))
