import sys
import unittest
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
from atlas_ii import encode_packet, wire_state
from atlas_ii_reference import parse_packet


class AtlasAlphaTests(unittest.TestCase):
    def test_fully_opaque_alpha_candidate_uses_copy_and_transparency_keeps_pair(self):
        config = {"activeLayout": "full", "atlasSize": [1936, 1168],
                  "mainVideoSize": [1920, 1080], "outputSize": [1920, 1080],
                  "layouts": {"full": [{"source": 0, "mode": 0, "visible": True,
                      "opacity": 255, "srcX": 16, "srcY": 400, "srcW": 8, "srcH": 8,
                      "dstX": 0, "dstY": 0, "dstW": 8, "dstH": 8,
                      "alphaX": 16, "alphaY": 16, "alphaW": 8, "alphaH": 8}]}}
        snapshot = {"atlasIIConfig": config,
                    "layers": {name: [] for name in ("eew", "tsunami", "intensity", "vertical")}}
        atlas = Image.new("RGB", (1936, 1168), "black")
        atlas.paste("white", (16, 16, 24, 24))
        copied = wire_state(snapshot, atlas)
        self.assertEqual(copied["rects"][0]["mode"], 0)

        atlas.putpixel((16, 16), (128, 128, 128))
        paired = wire_state(snapshot, atlas)
        self.assertEqual(paired["rects"][0]["mode"], 1)
        decoded = parse_packet(encode_packet(paired, atlas.size))
        self.assertEqual(decoded["rects"][0]["src"], (16, 400, 8, 8))
        self.assertEqual(decoded["rects"][0]["alphaSrc"], (16, 16, 8, 8))

        config["layouts"]["full"][0]["opacity"] = 128
        atlas.putpixel((16, 16), (255, 255, 255))
        self.assertEqual(wire_state(snapshot, atlas)["rects"][0]["mode"], 1)


if __name__ == "__main__":
    unittest.main()
