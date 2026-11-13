import tempfile
import unittest
from pathlib import Path

from PIL import Image

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


if __name__ == "__main__":
    unittest.main()
