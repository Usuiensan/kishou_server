import shutil
import io
import json
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
sys.path.insert(0, str(ROOT / "protocol"))
from atlas_ii import (FFMPEG_COLOR_ARGS, collect_ffmpeg_progress, encode_packet,
                      paint_packet, parse_ffmpeg_progress, wire_state)  # noqa: E402
from atlas_ii_reference import bytes_to_symbols, parse_packet, symbols_to_bytes  # noqa: E402
from atlas_e2e import decode_colour32_frame  # noqa: E402


class AtlasIISenderTests(unittest.TestCase):
    def test_stream_with_metrics_dir_runs_without_unbound_stage_timer(self):
        # Regression: the service always passes --metrics-dir, and the stream
        # loop used stage_started before assignment (UnboundLocalError).
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            atlas = root / "atlas.png"
            Image.new("RGB", (1936, 1168), (0, 0, 0)).save(atlas)
            state = root / "state.json"
            state.write_text(json.dumps({"display": {}, "layers": {
                "eew": [], "tsunami": [], "intensity": [], "vertical": []}}),
                encoding="utf-8")
            stub = root / "ffmpeg-stub"
            stub.write_text("#!/bin/sh\nexec cat > /dev/null\n", encoding="utf-8")
            stub.chmod(0o755)
            metrics = root / "metrics"
            result = subprocess.run(
                [sys.executable, "-B", str(ROOT / "tools" / "atlas_ii.py"),
                 "--atlas", str(atlas), "--stream", "--duration", "1",
                 "--fps", "5", "--state", str(state),
                 "--ffmpeg", str(stub), "--metrics-dir", str(metrics),
                 "--url", "rtsp://127.0.0.1:8554/bosai"],
                capture_output=True, text=True, timeout=60)
            self.assertEqual(result.returncode, 0, result.stderr[-800:])
            self.assertTrue((metrics / "a2-encode.json").exists())

    def test_shared_vectors_encode_and_decode_byte_for_byte(self):
        vectors = json.loads((ROOT / "protocol" / "atlas-ii-vectors.json").read_text("utf-8"))["vectors"]
        for vector in vectors:
            with self.subTest(name=vector["name"]):
                packet = bytes.fromhex(vector["hex"])
                decoded = parse_packet(packet)
                state = {"rects": [{
                    "source": rect["control"] & 1,
                    "mode": (rect["control"] >> 1) & 1,
                    "visible": bool(rect["control"] & 4),
                    "opacity": rect["opacity"],
                    "srcX": rect["src"][0], "srcY": rect["src"][1],
                    "srcW": rect["src"][2], "srcH": rect["src"][3],
                    "dstX": rect["dst"][0], "dstY": rect["dst"][1],
                    "dstW": rect["dst"][2], "dstH": rect["dst"][3],
                    **({"alphaX": rect["alphaSrc"][0], "alphaY": rect["alphaSrc"][1],
                        "alphaW": rect["alphaSrc"][2], "alphaH": rect["alphaSrc"][3]}
                       if rect["alphaSrc"] is not None else {}),
                } for rect in decoded["rects"]]}
                if packet[3] & 1:
                    state["display"] = decoded["displayFlags"]
                if packet[3] & 2:
                    state["tsunami"] = decoded["tsunamiSeverity"]
                if packet[3] & 4:
                    state["eew"] = decoded["eewEvents"]
                encoded = encode_packet(state, decoded["atlas"], output_size=decoded["output"],
                                        sequence=decoded["sequence"], sender_unix_ms=decoded["timestampMs"])
                self.assertEqual(encoded, packet)

    @unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "FFmpeg tools are not installed")
    def test_stream_timestamps_follow_raw_frame_arrival_gaps(self):
        with tempfile.TemporaryDirectory() as temp:
            video = Path(temp) / "timed.mkv"
            command = [shutil.which("ffmpeg"), "-hide_banner", "-loglevel", "error",
                       "-use_wallclock_as_timestamps", "1", "-f", "rawvideo",
                       "-pixel_format", "rgb24", "-video_size", "64x64", "-i", "pipe:0",
                       "-fps_mode", "passthrough", "-c:v", "libx264", "-bf", "0",
                       "-pix_fmt", "yuv420p", str(video)]
            process = subprocess.Popen(command, stdin=subprocess.PIPE, stderr=subprocess.PIPE)
            frame = bytes((64, 128, 192)) * 64 * 64
            try:
                for delay in (0, 0.1, 0.4, 0.1):
                    if delay:
                        time.sleep(delay)
                    process.stdin.write(frame)
                    process.stdin.flush()
                process.stdin.close()
                error = process.stderr.read()
                self.assertEqual(process.wait(), 0, error.decode(errors="replace"))
            finally:
                process.stderr.close()
                if process.poll() is None:
                    process.kill()
                    process.wait()
            output = subprocess.run([shutil.which("ffprobe"), "-v", "error", "-select_streams", "v:0",
                                     "-show_entries", "packet=pts_time", "-of", "csv=p=0", str(video)],
                                    check=True, capture_output=True, text=True)
            timestamps = [float(line) for line in output.stdout.splitlines() if line.strip()]
            self.assertEqual(len(timestamps), 4)
            self.assertTrue(all(later > earlier for earlier, later in zip(timestamps, timestamps[1:])))
            self.assertGreaterEqual(timestamps[2] - timestamps[1], 0.25)

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
        decoded = parse_packet(packet, actual_atlas_size=(1280, 720))
        self.assertEqual(decoded["output"], (1600, 900))
        self.assertEqual(len(decoded["rects"]), 1)

    def test_default_main_video_rect_uses_output_canvas_coordinates(self):
        snapshot = {"display": {}, "atlasIIConfig": {
            "mainVideoSize": [3840, 2160], "outputSize": [1600, 900],
        }, "layers": {"eew": [], "tsunami": [], "intensity": [], "vertical": []}}
        state = wire_state(snapshot)
        rect = state["rects"][0]
        self.assertEqual((rect["srcW"], rect["srcH"]), (1600, 900))
        packet = encode_packet(state, (1280, 720), output_size=tuple(state["outputSize"]))
        decoded = parse_packet(packet, actual_atlas_size=(1280, 720))
        self.assertEqual(decoded["rects"][0]["src"][2:], (1600, 900))

    def test_default_rect_layout_has_main_video_and_alpha_pair(self):
        config = json.loads((ROOT / "examples" / "atlas-layouts.json").read_text(encoding="utf-8"))
        snapshot = {"display": {}, "atlasIIConfig": config,
                    "layers": {"eew": [], "tsunami": [], "intensity": [], "vertical": []}}
        state = wire_state(snapshot)
        packet = encode_packet(state, (1936, 1168), output_size=tuple(state["outputSize"]))
        decoded = parse_packet(packet, actual_atlas_size=(1936, 1168))
        self.assertEqual(len(decoded["rects"]), 4)
        self.assertEqual(decoded["rects"][0]["control"] & 1, 1)
        self.assertTrue(decoded["rects"][3]["control"] & 2)
        self.assertEqual(decoded["rects"][3]["src"][2:], decoded["rects"][3]["alphaSrc"][2:])
        self.assertNotEqual(decoded["rects"][3]["src"], decoded["rects"][3]["alphaSrc"])
        self.assertEqual(decoded["rects"][3]["src"][1] - decoded["rects"][3]["alphaSrc"][1], 477)
        config["atlasSize"] = [1920, 1088]
        resized = wire_state({**snapshot, "atlasIIConfig": config})
        resized_packet = encode_packet(resized, (1920, 1088), output_size=tuple(resized["outputSize"]))
        resized_decoded = parse_packet(resized_packet, actual_atlas_size=(1920, 1088))
        self.assertEqual(resized_decoded["atlas"], (1920, 1088))

    def test_alpha_pair_rejects_same_or_overlapping_rgb_and_mask_regions(self):
        base = {"source": 0, "mode": 1, "visible": True, "opacity": 255,
                "srcX": 32, "srcY": 128, "srcW": 16, "srcH": 16,
                "dstX": 0, "dstY": 0, "dstW": 16, "dstH": 16}
        for alpha in ((32, 128, 16, 16), (40, 128, 16, 16), (32, 128, 8, 16)):
            with self.subTest(alpha=alpha), self.assertRaisesRegex(ValueError, "alphaSrc must be same-sized and disjoint"):
                encode_packet({"rects": [{**base, "alphaX": alpha[0], "alphaY": alpha[1],
                                            "alphaW": alpha[2], "alphaH": alpha[3]}]}, (1280, 720))

    def test_copy_rejects_non_opaque_rect_opacity(self):
        rect = {"source": 0, "mode": 0, "visible": True, "opacity": 128,
                "srcX": 32, "srcY": 128, "srcW": 16, "srcH": 16,
                "dstX": 0, "dstY": 0, "dstW": 16, "dstH": 16}
        with self.assertRaisesRegex(ValueError, "COPY requires fully opaque Rect opacity"):
            encode_packet({"rects": [rect]}, (1280, 720))

    def test_maximum_rect_count_and_invalid_mode(self):
        rect = {"source": 0, "mode": 0, "visible": True, "opacity": 255,
                "srcX": 0, "srcY": 0, "srcW": 1, "srcH": 1,
                "dstX": 0, "dstY": 0, "dstW": 1, "dstH": 1}
        packet = encode_packet({"rects": [rect] * 15}, (1280, 720))
        self.assertEqual(parse_packet(packet)["rects"].__len__(), 15)
        with self.assertRaisesRegex(ValueError, "source/mode"):
            encode_packet({"rects": [{**rect, "mode": 2}]}, (1280, 720))

    def test_packet_length_accepts_65535_and_rejects_the_next_size(self):
        def state(area_count):
            return {"rects": [], "display": 7, "tsunami": [0] * 66, "eew": [{
                "eventId": "maxi", "eventFlags": 0, "issueUnixSeconds": 0,
                "serial": 1, "maxScalePair": 0,
                "areas": [{"areaId": i, "scalePair": 0, "areaFlags": 0,
                           "arrivalOffsetSeconds": -32768} for i in range(area_count)],
            }]}
        packet = encode_packet(state(10911), (65520, 112))
        self.assertEqual(len(packet), 65535)
        self.assertEqual(parse_packet(packet, actual_atlas_size=(65520, 112))["atlas"], (65520, 112))
        with self.assertRaisesRegex(ValueError, "packet exceeds u16 wire length"):
            encode_packet(state(10912), (65520, 112))

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
            source = Path(temp) / "in.png"
            encoded = Path(temp) / "encoded.mp4"
            raw = Path(temp) / "decoded.rgb"
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
