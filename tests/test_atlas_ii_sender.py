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
from atlas_ii import (FFMPEG_COLOR_ARGS, encode_packet, paint_packet, parse_ffmpeg_progress,
                      collect_ffmpeg_progress, wire_state)  # noqa: E402
from atlas_ii_reference import bytes_to_symbols, parse_packet, symbols_to_bytes  # noqa: E402


class AtlasIISenderTests(unittest.TestCase):
    def test_ffmpeg_progress_is_reported_as_measured_output(self):
        metrics = parse_ffmpeg_progress({"frame": "31", "fps": "29.97", "bitrate": "842.1kbits/s",
                                         "out_time": "00:00:01.033000", "speed": "0.998x",
                                         "progress": "continue"})
        self.assertEqual(metrics["stage"], "FFmpeg encode")
        self.assertEqual(metrics["frame"], 31)
        self.assertEqual(metrics["fps"], 29.97)
        self.assertEqual(metrics["bitrate"], "842.1kbits/s")
        self.assertEqual(metrics["speed"], "0.998x")

    def test_ffmpeg_progress_blocks_are_written_atomically_as_metrics(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "ffmpeg.json"
            collect_ffmpeg_progress(io.StringIO("frame=30\nfps=29.8\nbitrate=900kbits/s\nprogress=continue\n"), path)
            metrics = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(metrics["frame"], 30)
            self.assertEqual(metrics["fps"], 29.8)
            self.assertEqual(metrics["bitrate"], "900kbits/s")

    @unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "FFmpeg tools are not installed")
    def test_stream_timestamps_follow_raw_frame_arrival_gaps(self):
        with tempfile.TemporaryDirectory() as temp:
            video = Path(temp) / "timed.mkv"
            command = [shutil.which("ffmpeg"), "-hide_banner", "-loglevel", "error",
                       "-stats_period", "0.1", "-progress", "pipe:1",
                       "-use_wallclock_as_timestamps", "1", "-f", "rawvideo",
                       "-pixel_format", "rgb24", "-video_size", "64x64", "-i", "pipe:0",
                       "-fps_mode", "passthrough", "-c:v", "libx264", "-bf", "0",
                       "-pix_fmt", "yuv420p", str(video)]
            process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=subprocess.PIPE)
            frame = bytes((64, 128, 192)) * 64 * 64
            try:
                for delay in (0, 0.1, 0.4, 0.1):
                    if delay:
                        time.sleep(delay)
                    process.stdin.write(frame)
                    process.stdin.flush()
                process.stdin.close()
                error = process.stderr.read()
                progress = process.stdout.read().decode(errors="replace")
                self.assertEqual(process.wait(), 0, error.decode(errors="replace"))
                self.assertIn("progress=end", progress)
                self.assertRegex(progress, r"(?m)^fps=.+$")
                self.assertRegex(progress, r"(?m)^bitrate=.+$")
            finally:
                process.stderr.close()
                process.stdout.close()
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
