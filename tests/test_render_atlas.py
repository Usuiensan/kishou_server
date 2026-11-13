import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image
from tools.atlas_metrics import StageMetrics, write_metrics

from tools.render_atlas import to_rgb_png, write_rgb_png


class AtlasRenderSizeTests(unittest.TestCase):
    def test_renderer_writes_atlas_from_in_memory_capture(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "atlas.png"
            write_rgb_png(Image.new("RGBA", (1936, 1168), (80, 120, 160, 0)), output, (1936, 1168))
            with Image.open(output) as rendered:
                self.assertEqual(rendered.mode, "RGB")
                self.assertEqual(rendered.getpixel((500, 500)), (80, 120, 160))

    def test_renderer_resizes_design_capture_to_configured_atlas_size(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, output = root / "source.png", root / "atlas.png"
            Image.new("RGB", (1936, 1168), (80, 120, 160)).save(source)
            to_rgb_png(source, output, (1920, 1088))
            with Image.open(output) as rendered:
                self.assertEqual(rendered.size, (1920, 1088))
                self.assertEqual(rendered.getpixel((500, 500)), (80, 120, 160))

    def test_alpha_pair_copies_source_alpha_into_a_distinct_grayscale_region(self):
        capture = Image.new("RGBA", (1936, 1168), (255, 0, 0, 0))
        capture.putpixel((100, 100), (255, 0, 0, 0))
        capture.putpixel((101, 100), (0, 0, 255, 128))
        capture.putpixel((102, 100), (0, 255, 0, 255))
        rect = {"source": 0, "srcX": 100, "srcY": 100, "srcW": 3, "srcH": 1,
                "alphaX": 100, "alphaY": 300, "alphaW": 3, "alphaH": 1}
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "atlas.png"
            write_rgb_png(capture, output, rects=[rect])
            with Image.open(output) as rendered:
                self.assertEqual(rendered.getpixel((100, 100)), (255, 0, 0))
                self.assertEqual(rendered.getpixel((101, 100)), (0, 0, 255))
                self.assertEqual([rendered.getpixel((x, 300)) for x in (100, 101, 102)],
                                 [(0, 0, 0), (128, 128, 128), (255, 255, 255)])

    def test_transparent_copy_requires_an_alpha_region(self):
        capture = Image.new("RGBA", (1936, 1168), (0, 0, 0, 0))
        rect = {"source": 0, "mode": 0, "opacity": 255,
                "srcX": 100, "srcY": 100, "srcW": 3, "srcH": 1}
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError, "transparent Rect requires an alphaSrc reservation"):
                write_rgb_png(capture, Path(directory) / "atlas.png", rects=[rect])

    def test_renderer_rejects_atlas_dimensions_that_cannot_carry_cells(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.png"
            Image.new("RGB", (1936, 1168)).save(source)
            with self.assertRaisesRegex(ValueError, "multiples"):
                to_rgb_png(source, root / "atlas.png", (641, 1088))

    def test_stage_metrics_report_measured_rate_and_duration_percentiles(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "metrics" / "renderer.json"
            metrics = StageMetrics(path, "renderer")
            for index in range(20):
                metrics.record(index + 1, monotonic=10 + index * .02, unix_ms=1000 + index * 20)
            result = metrics.write(monotonic=10.4)
            self.assertEqual(result["fps"], 50)
            self.assertEqual(result["intervalMs"], {"average": 20, "max": 20, "p95": 20})
            self.assertEqual(result["durationMs"], {"average": 10.5, "max": 20, "p95": 19})
            self.assertEqual(json.loads(path.read_text(encoding="utf-8")), result)

    def test_metrics_replace_retries_transient_windows_lock(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "metrics.json"
            real_replace = os.replace
            def transient_replace(source, destination):
                if transient_replace.calls < 2:
                    transient_replace.calls += 1
                    raise PermissionError("locked")
                return real_replace(source, destination)
            transient_replace.calls = 0
            with patch("tools.atlas_metrics.os.replace", side_effect=transient_replace) as replace:
                self.assertTrue(write_metrics(path, {"fps": 30}))
            self.assertEqual(replace.call_count, 3)
            self.assertEqual(json.loads(path.read_text(encoding="utf-8")), {"fps": 30})

    def test_metrics_write_failure_does_not_stop_stage_and_is_reported(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "metrics.json"
            metrics = StageMetrics(path, "sender")
            with patch("tools.atlas_metrics.write_metrics", return_value=False):
                metrics.record(1, monotonic=1, unix_ms=1000)
            metrics.record(2, monotonic=2.1, unix_ms=2100)
            stored = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(stored["writeErrors"], 1)
            self.assertEqual(stored["lastWriteError"], "sidecar write failed")


if __name__ == "__main__":
    unittest.main()
