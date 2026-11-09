import sys
import unittest
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))

from atlas_sender import compose_atlas, ffmpeg_publish_command, load_state_values
from metadata_demo import State, read_image
from validate_atlas import ATLAS


class AtlasSenderTests(unittest.TestCase):
    def test_composite_keeps_top_left_data_grid_and_source_immutable(self):
        state = State(sequence=0x12345678, flags=15, mode=1, opacity=251,
                      lower_x=281, lower_y=619, timestamp=1794166800)
        source = Image.new("RGB", ATLAS, (10, 20, 30))

        frame = compose_atlas(source, state)

        self.assertEqual(frame.size, ATLAS)
        self.assertEqual(source.getpixel((12, 1135)), (10, 20, 30))
        self.assertEqual(frame.getpixel((12, 1135)), (85, 85, 255))  # 'V', high nibble 5.
        self.assertEqual(frame.getpixel((20, 1135)), (170, 85, 255))  # 'V', low nibble 6.
        self.assertEqual(read_image(frame), state)

    def test_composite_rejects_wrong_atlas_dimensions(self):
        with self.assertRaisesRegex(ValueError, "1936x1168"):
            compose_atlas(Image.new("RGB", (1920, 1080)), State())

    def test_publish_command_is_vbr_yuv420p_no_bframes_level_50(self):
        command = ffmpeg_publish_command("rtsp://127.0.0.1:8554/atlas", fps=30)
        self.assertIn("-crf", command)
        self.assertIn("-maxrate", command)
        self.assertIn("-bufsize", command)
        self.assertEqual(command[command.index("-pix_fmt") + 1], "yuv420p")
        self.assertEqual(command[command.index("-bf") + 1], "0")
        self.assertEqual(command[command.index("-level:v") + 1], "5.0")
        self.assertEqual(command[command.index("-g") + 1], "30")
        self.assertIn("-rtsp_transport", command)
        self.assertEqual(command[command.index("-rtsp_transport") + 1], "tcp")

    def test_state_sidecar_accepts_protocol_fields_and_rejects_invalid_values(self):
        state = State()
        sidecar = ROOT / "tests" / "results" / "sender-state-test.json"
        sidecar.parent.mkdir(parents=True, exist_ok=True)
        try:
            sidecar.write_text('{"flags":7,"opacity":200}', encoding="utf-8")
            self.assertEqual(load_state_values(sidecar, state), (7, 1, 200, 281, 619))
            sidecar.write_text('{"lower_x":-1}', encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "lower_x"):
                load_state_values(sidecar, state)
        finally:
            sidecar.unlink(missing_ok=True)


if __name__ == "__main__":
    unittest.main()
