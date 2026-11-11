import sys
import json
import tempfile
import unittest
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
from atlas_composite_check import decode_atlas, make_test_pattern, render_composite, write_unity_bundle  # noqa: E402
from atlas_ii import encode_packet, paint_packet  # noqa: E402
from atlas_ii_reference import parse_packet  # noqa: E402


class AtlasCompositeCheckTests(unittest.TestCase):
    def test_decodes_painted_a2_frame_through_shared_wire_parser(self):
        size = (640, 32)
        state = {"rects": [{"source": 1, "mode": 0, "visible": True, "opacity": 255,
                            "srcX": 0, "srcY": 0, "srcW": 1920, "srcH": 1080,
                            "dstX": 0, "dstY": 0, "dstW": 1920, "dstH": 1080}],
                 "mainVideoSize": [1920, 1080]}
        packet = encode_packet(state, size, sequence=17, sender_unix_ms=1234)
        atlas = paint_packet(Image.new("RGB", size, "black"), packet, (1920, 1080))
        recovered, decoded = decode_atlas(atlas)
        self.assertEqual(recovered, packet)
        self.assertEqual(decoded["sequence"], 17)
        self.assertEqual(decoded["rects"][0]["dst"], (0, 0, 1920, 1080))

    def test_pattern_is_full_hd_and_has_distinct_corner_markers(self):
        pattern = make_test_pattern()
        self.assertEqual(pattern.size, (1920, 1080))
        self.assertNotEqual(pattern.getpixel((10, 10)), pattern.getpixel((1910, 10)))
        self.assertNotEqual(pattern.getpixel((10, 10)), pattern.getpixel((10, 1070)))

    def test_composes_top_left_coordinates_in_packet_order(self):
        atlas = Image.new("RGB", (4, 4), (0, 0, 0))
        for point, color in { (0, 0): (255, 0, 0), (1, 0): (0, 255, 0),
                             (0, 1): (0, 0, 255), (1, 1): (255, 255, 255) }.items():
            atlas.putpixel(point, color)
        main = Image.new("RGB", (4, 4), (0, 0, 255))
        packet = {"atlas": (4, 4), "output": (4, 4), "rects": [
            {"control": 5, "opacity": 255, "src": (0, 0, 4, 4), "dst": (0, 0, 4, 4), "alphaSrc": None},
            {"control": 4, "opacity": 255, "src": (0, 0, 2, 2), "dst": (1, 1, 2, 2), "alphaSrc": None},
        ]}
        result = render_composite(atlas, main, packet)
        self.assertEqual(result.getpixel((0, 0)), (0, 0, 255))
        self.assertEqual(result.getpixel((1, 1)), (255, 0, 0))
        self.assertEqual(result.getpixel((2, 2)), (255, 255, 255))

    def test_alpha_pair_uses_luminance_and_opacity(self):
        atlas = Image.new("RGB", (4, 2), (0, 0, 0))
        for y in range(2):
            for x in range(2):
                atlas.putpixel((x, y), (255, 0, 0))
                atlas.putpixel((x + 2, y), (128, 128, 128))
        packet = {"atlas": (4, 2), "output": (2, 2), "rects": [
            {"control": 6, "opacity": 255, "src": (0, 0, 2, 2), "dst": (0, 0, 2, 2),
             "alphaSrc": (2, 0, 2, 2)},
        ]}
        result = render_composite(atlas, Image.new("RGB", (2, 2)), packet)
        red = result.getpixel((0, 0))[0]
        self.assertGreaterEqual(red, 126)
        self.assertLessEqual(red, 130)
        self.assertEqual(result.getpixel((0, 0))[1:], (0, 0))

    def test_unity_bundle_contains_same_rects_and_reference_images(self):
        size = (640, 32)
        state = {"rects": [{"source": 1, "mode": 0, "visible": True, "opacity": 255,
                            "srcX": 0, "srcY": 0, "srcW": 1920, "srcH": 1080,
                            "dstX": 0, "dstY": 0, "dstW": 1920, "dstH": 1080}],
                 "mainVideoSize": [1920, 1080]}
        raw = encode_packet(state, size, sequence=17, sender_unix_ms=1234)
        packet = parse_packet(raw, actual_atlas_size=size, actual_main_size=(1920, 1080))
        atlas = paint_packet(Image.new("RGB", size, "black"), raw, (1920, 1080))
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory)
            write_unity_bundle(target, atlas, Image.new("RGB", (1920, 1080)),
                               Image.new("RGB", (1920, 1080)), raw, packet)
            manifest = json.loads((target / "rects.json").read_text(encoding="utf-8"))
            self.assertEqual(manifest["sequence"], 17)
            self.assertEqual(manifest["rects"][0]["control"], 5)
            self.assertEqual(manifest["packetHex"], raw.hex())
            self.assertTrue(all((target / name).is_file() for name in
                                ("atlas.png", "main-video-test-pattern.png", "reference.png")))


if __name__ == "__main__":
    unittest.main()
