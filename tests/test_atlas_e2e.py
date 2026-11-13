import json
import io
import sys
import tempfile
import unittest
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
sys.path.insert(0, str(ROOT / "protocol"))
from atlas_e2e import (decode_colour32_frame, iter_raw_frames, parse_progress_frame_count,
                       read_stage_metrics, validate_concurrent_reader_frame_count,
                       validate_load_settings)  # noqa: E402
from atlas_ii import paint_packet  # noqa: E402


class AtlasVideoDecodeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.vectors = json.loads((ROOT / "protocol" / "atlas-ii-vectors.json").read_text("utf-8"))["vectors"]

    def frame_for(self, vector):
        packet = bytes.fromhex(vector["hex"])
        size = (vector["expect"]["atlasWidth"], vector["expect"]["atlasHeight"])
        image = paint_packet(Image.new("RGB", size, (16, 20, 28)), packet)
        return packet, image

    def test_rgb_frame_decoder_recovers_fixed_vector_hex_and_crc(self):
        for vector in self.vectors:
            with self.subTest(name=vector["name"]):
                packet, image = self.frame_for(vector)
                decoded_packet, decoded = decode_colour32_frame(image.tobytes(), image.size)
                self.assertEqual(decoded_packet.hex(), vector["hex"])
                self.assertEqual(len(decoded["rects"]), vector["expect"]["rectCount"])
                self.assertEqual(decoded["packetHex"], vector["hex"])
                self.assertEqual(decoded["rgbError"]["max"], 0)

    def test_nearest_colour_decode_tolerates_small_rgb_error_and_rejects_bad_frame_size(self):
        packet, image = self.frame_for(self.vectors[1])
        pixels = image.load()
        for y in range(image.height - 8, image.height):
            for x in range(8):
                red, green, blue = pixels[x, y]
                pixels[x, y] = (min(255, red + 10), max(0, green - 10), blue)
        decoded_packet, decoded = decode_colour32_frame(image.tobytes(), image.size)
        self.assertEqual(decoded_packet, packet)
        self.assertGreater(decoded["rgbError"]["max"], 0)
        with self.assertRaisesRegex(ValueError, "length"):
            decode_colour32_frame(image.tobytes()[:-3], image.size)

    def test_loopback_load_settings_allow_one_to_eighty_viewers_and_one_second_to_one_day(self):
        validate_load_settings(1, 1)
        validate_load_settings(86_400, 80)
        for duration, viewers in ((0, 1), (86_401, 1), (1, 0), (1, 81), (True, 1), (1, False)):
            with self.subTest(duration=duration, viewers=viewers), self.assertRaises(ValueError):
                validate_load_settings(duration, viewers)

    def test_concurrent_reader_progress_requires_observed_decoded_frames(self):
        self.assertEqual(parse_progress_frame_count(b"frame=0\nprogress=continue\nframe=37\nprogress=end\n"), 37)
        self.assertEqual(parse_progress_frame_count(b"progress=end\n"), 0)

    def test_concurrent_reader_must_receive_most_of_the_stream(self):
        validate_concurrent_reader_frame_count(800, 1000)
        with self.assertRaisesRegex(ValueError, "too few frames"):
            validate_concurrent_reader_frame_count(799, 1000)

    def test_stage_metrics_are_loaded_as_named_measurement_records(self):
        with tempfile.TemporaryDirectory() as directory:
            metrics_dir = Path(directory)
            (metrics_dir / "a2-encode.json").write_text(json.dumps({"sampleCount": 10}), encoding="utf-8")
            self.assertEqual(read_stage_metrics(metrics_dir), {"a2-encode": {"sampleCount": 10}})
            self.assertEqual(read_stage_metrics(metrics_dir / "missing"), {})

    def test_raw_video_frames_are_consumed_one_frame_at_a_time(self):
        stream = io.BytesIO(b"12345" + b"67890" + b"tail")
        self.assertEqual(list(iter_raw_frames(stream, 5)), [b"12345", b"67890"])


if __name__ == "__main__":
    unittest.main()
