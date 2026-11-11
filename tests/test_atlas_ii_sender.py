import shutil
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
sys.path.insert(0, str(ROOT / "protocol"))
from atlas_ii import FFMPEG_COLOR_ARGS, encode_packet, paint_packet, wire_state  # noqa: E402
from atlas_ii_reference import bytes_to_symbols, parse_packet, symbols_to_bytes  # noqa: E402


class AtlasIISenderTests(unittest.TestCase):
    def test_ingest_snapshot_is_projected_to_complete_wire_sections(self):
        snapshot = {"display": {}, "layers": {
            "eew": [{"payload": {"atlasII": {"eventId": "e1", "areas": []}}}],
            "tsunami": [{"payload": {"atlasII": [0, 2] + [0] * 64}}],
            "intensity": [], "vertical": [],
        }}
        state = wire_state(snapshot)
        self.assertEqual(len(state["tsunami"]), 66)
        self.assertEqual(state["tsunami"][1], 2)
        self.assertEqual(state["display"], 0b11110)
        self.assertEqual(state["eew"][0]["eventId"], "e1")
        self.assertEqual(state["rects"][0]["source"], 1)
        self.assertEqual(state["mainVideoSize"], [1920, 1080])

    def test_eew_cancel_is_sent_while_display_flags_clear(self):
        snapshot = {"display": {}, "layers": {
            "eew": [{"action": "cancel", "payload": {"atlasII": {
                "eventId": "e1", "eventFlags": 1, "areas": []}}}],
            "tsunami": [], "intensity": [], "vertical": [],
        }}
        state = wire_state(snapshot)
        self.assertEqual(state["eew"][0]["eventFlags"] & 1, 1)
        self.assertEqual(state["display"] & 0b110, 0)

    def test_configured_rect_plan_and_main_video_dimensions_reach_wire(self):
        snapshot = {"display": {}, "atlasIIConfig": {
            "activeLayout": "custom", "mainVideoSize": [1280, 720], "outputSize": [1600, 900],
            "layouts": {"custom": [{"source": 1, "mode": 0, "visible": True, "opacity": 255,
                "srcX": 0, "srcY": 0, "srcW": 1280, "srcH": 720,
                "dstX": 0, "dstY": 0, "dstW": 1600, "dstH": 900}]},
        }, "layers": {"eew": [], "tsunami": [], "intensity": [], "vertical": []}}
        state = wire_state(snapshot)
        packet = encode_packet(state, (1280, 720), output_size=tuple(state["outputSize"]))
        decoded = parse_packet(packet, actual_atlas_size=(1280, 720), actual_main_size=(1280, 720))
        self.assertEqual(decoded["output"], (1600, 900))
        self.assertEqual(len(decoded["rects"]), 1)

    def test_default_rect_layout_has_main_video_and_alpha_pair(self):
        config = json.loads((ROOT / "examples" / "atlas-layouts.json").read_text(encoding="utf-8"))
        snapshot = {"display": {}, "atlasIIConfig": config,
                    "layers": {"eew": [], "tsunami": [], "intensity": [], "vertical": []}}
        state = wire_state(snapshot)
        packet = encode_packet(state, (1936, 1168), output_size=tuple(state["outputSize"]))
        decoded = parse_packet(packet, actual_atlas_size=(1936, 1168), actual_main_size=(1920, 1080))
        self.assertEqual(len(decoded["rects"]), 4)
        self.assertEqual(decoded["rects"][0]["control"] & 1, 1)
        self.assertTrue(decoded["rects"][3]["control"] & 2)
        config["atlasSize"] = [1920, 1088]
        resized = wire_state({**snapshot, "atlasIIConfig": config})
        resized_packet = encode_packet(resized, (1920, 1088), output_size=tuple(resized["outputSize"]))
        resized_decoded = parse_packet(resized_packet, actual_atlas_size=(1920, 1088), actual_main_size=(1920, 1080))
        self.assertEqual(resized_decoded["atlas"], (1920, 1088))

    def test_maximum_rect_count_and_invalid_mode(self):
        rect = {"source": 0, "mode": 0, "visible": True, "opacity": 255,
                "srcX": 0, "srcY": 0, "srcW": 1, "srcH": 1,
                "dstX": 0, "dstY": 0, "dstW": 1, "dstH": 1}
        packet = encode_packet({"rects": [rect] * 15}, (1280, 720))
        self.assertEqual(parse_packet(packet)["rects"].__len__(), 15)
        with self.assertRaisesRegex(ValueError, "source/mode"):
            encode_packet({"rects": [{**rect, "mode": 2}]}, (1280, 720))

    def test_packet_is_painted_at_real_dimensions_and_decodes(self):
        state = {"rects": [], "display": 3, "tsunami": [0] * 66, "eew": []}
        packet = encode_packet(state, (1280, 720), sequence=4, sender_unix_ms=1_767_323_045_000)
        atlas = paint_packet(Image.new("RGB", (1280, 720), (12, 34, 56)), packet)
        self.assertEqual(atlas.getpixel((4, 720 - 4)),
                         (85 * (bytes_to_symbols(packet)[0] & 3),
                          85 * ((bytes_to_symbols(packet)[0] >> 2) & 3),
                          255 * (bytes_to_symbols(packet)[0] >> 4)))
        columns = 1280 // 8
        symbols = []
        palette = [(85 * (s & 3), 85 * ((s >> 2) & 3), 255 * (s >> 4)) for s in range(32)]
        for i in range((len(packet) * 8 + 4) // 5):
            x, y = (i % columns) * 8 + 4, 720 - (i // columns + 1) * 8 + 4
            pixel = atlas.getpixel((x, y))
            symbols.append(min(range(32), key=lambda n: sum((a - b) ** 2 for a, b in zip(pixel, palette[n]))))
        recovered = symbols_to_bytes(symbols, len(packet))
        self.assertEqual(recovered, packet)
        self.assertEqual(parse_packet(recovered, actual_atlas_size=(1280, 720))["sequence"], 4)

    @unittest.skipUnless(shutil.which("ffmpeg"), "ffmpeg is not installed")
    def test_h264_yuv420p_recovery(self):
        areas = [{"areaId": code, "scalePair": 0x53, "areaFlags": 12 if code % 2 == 0 else 4,
                  "arrivalOffsetSeconds": 5} for code in range(100, 150)]
        state = {"rects": [], "display": 0x1F, "tsunami": [0, 1, 2, 3] * 16 + [0, 1],
                 "eew": [{"eventId": "20261110000123", "eventFlags": 0x0E,
                          "issueUnixSeconds": 1794243600, "serial": 3, "maxScalePair": 0x53,
                          "areas": areas}]}
        packet = encode_packet(state, (1280, 720), sequence=91, sender_unix_ms=1_767_323_045_000)
        atlas = paint_packet(Image.new("RGB", (1280, 720), (32, 64, 96)), packet)
        with tempfile.TemporaryDirectory() as temp:
            source, encoded, raw = (Path(temp) / name for name in ("in.png", "encoded.mp4", "decoded.rgb"))
            atlas.save(source)
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(source), "-frames:v", "1",
                            "-c:v", "libx264", "-crf", "23", "-pix_fmt", "yuv420p", *FFMPEG_COLOR_ARGS, str(encoded)], check=True)
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(encoded), "-frames:v", "1",
                            "-vf", "scale=in_color_matrix=bt709", "-f", "rawvideo", "-pix_fmt", "rgb24", str(raw)], check=True)
            pixels = raw.read_bytes()
        columns = 1280 // 8
        palette = [(85 * (s & 3), 85 * ((s >> 2) & 3), 255 * (s >> 4)) for s in range(32)]
        symbols = []
        for i in range((len(packet) * 8 + 4) // 5):
            x, y = (i % columns) * 8 + 4, 720 - (i // columns + 1) * 8 + 4
            offset = (y * 1280 + x) * 3
            pixel = pixels[offset:offset + 3]
            symbols.append(min(range(32), key=lambda n: sum((a - b) ** 2 for a, b in zip(pixel, palette[n]))))
        recovered = symbols_to_bytes(symbols, len(packet))
        self.assertEqual(parse_packet(recovered, actual_atlas_size=(1280, 720))["sequence"], 91)


if __name__ == "__main__":
    unittest.main()
