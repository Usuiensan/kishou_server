import struct
import sys
import unittest
from io import BytesIO
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))

from PIL import Image

from overlay_sender import (CAPTURE_HEIGHT, CAPTURE_WIDTH, FRAME_HEIGHT,
                            FRAME_WIDTH, OVERLAY_HEIGHT, OVERLAY_WIDTH,
                            capture_command, compose_overlay, ffmpeg_command,
                            read_frame, stream_frames)


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

    def test_capture_size_is_downscaled(self):
        frame = Image.new("RGBA", (CAPTURE_WIDTH, CAPTURE_HEIGHT), (10, 20, 30, 128))
        out = compose_overlay(frame)
        self.assertEqual(out.size, (FRAME_WIDTH, FRAME_HEIGHT))
        self.assertEqual(out.getpixel((640, 360)), (10, 20, 30))
        self.assertEqual(out.getpixel((640, OVERLAY_HEIGHT + 360)), (128, 128, 128))

    def test_rejects_wrong_canvas_size(self):
        with self.assertRaises(ValueError):
            compose_overlay(Image.new("RGBA", (1270, 720)))


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
        command = ffmpeg_command("rtsp://127.0.0.1:8554/bosai-overlay", 2)
        self.assertIn("1280x1440", command)
        self.assertEqual(command[command.index("-r") + 1], "2")
        self.assertIn("bt709", command)
        self.assertEqual(command[-1], "rtsp://127.0.0.1:8554/bosai-overlay")


if __name__ == "__main__":
    unittest.main()
