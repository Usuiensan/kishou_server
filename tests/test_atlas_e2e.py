import json
import sys
import unittest
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
sys.path.insert(0, str(ROOT / "protocol"))
from atlas_e2e import decode_colour32_frame  # noqa: E402
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

    def test_nearest_colour_decode_tolerates_small_rgb_error_and_rejects_bad_frame_size(self):
        packet, image = self.frame_for(self.vectors[1])
        pixels = image.load()
        for y in range(image.height - 8, image.height):
            for x in range(8):
                red, green, blue = pixels[x, y]
                pixels[x, y] = (min(255, red + 10), max(0, green - 10), blue)
        decoded_packet, _ = decode_colour32_frame(image.tobytes(), image.size)
        self.assertEqual(decoded_packet, packet)
        with self.assertRaisesRegex(ValueError, "length"):
            decode_colour32_frame(image.tobytes()[:-3], image.size)


if __name__ == "__main__":
    unittest.main()
