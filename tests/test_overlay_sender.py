import struct
import sys
import unittest
from io import BytesIO
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))

from PIL import Image

from overlay_sender import (FRAME_HEIGHT, FRAME_WIDTH, OVERLAY_HEIGHT,
                            OVERLAY_WIDTH, compose_overlay, ffmpeg_command,
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

    def test_rejects_wrong_canvas_size(self):
        with self.assertRaises(ValueError):
            compose_overlay(Image.new("RGBA", (1280, 720)))


class FrameIoTest(unittest.TestCase):
    def test_read_frame_round_trip_and_eof(self):
        stream = BytesIO(framed(solid((1, 2, 3, 255))))
        frame = read_frame(stream)
        self.assertEqual(frame.size, (OVERLAY_WIDTH, OVERLAY_HEIGHT))
        self.assertIsNone(read_frame(stream))

    def test_stream_frames_throttles_to_fps(self):
        source = BytesIO(b"".join(framed(solid((i, i, i, 255))) for i in range(5)))
        sink = BytesIO()
        ticks = iter([0.0, 0.1, 0.2, 0.6, 1.2])
        forwarded = stream_frames(source, sink, fps=2, now=lambda: next(ticks))
        # fps=2 -> frames at t=0.0, 0.6, 1.2 pass; t=0.1 and 0.2 are dropped.
        self.assertEqual(forwarded, 3)
        self.assertEqual(len(sink.getvalue()), 3 * FRAME_WIDTH * FRAME_HEIGHT * 3)


class FfmpegCommandTest(unittest.TestCase):
    def test_command_is_fixed_size_2fps_bt709(self):
        command = ffmpeg_command("rtsp://127.0.0.1:8554/bosai-overlay", 2)
        self.assertIn("1270x1440", command)
        self.assertEqual(command[command.index("-r") + 1], "2")
        self.assertIn("bt709", command)
        self.assertEqual(command[-1], "rtsp://127.0.0.1:8554/bosai-overlay")


if __name__ == "__main__":
    unittest.main()
