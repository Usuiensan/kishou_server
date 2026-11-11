import tempfile
import unittest
from pathlib import Path

from PIL import Image

from tools.render_atlas import to_rgb_png


class AtlasRenderSizeTests(unittest.TestCase):
    def test_renderer_resizes_design_capture_to_configured_atlas_size(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source, output = root / "source.png", root / "atlas.png"
            Image.new("RGB", (1936, 1168), (80, 120, 160)).save(source)
            to_rgb_png(source, output, (1920, 1088))
            with Image.open(output) as rendered:
                self.assertEqual(rendered.size, (1920, 1088))
                self.assertEqual(rendered.getpixel((500, 500)), (80, 120, 160))

    def test_renderer_rejects_atlas_dimensions_that_cannot_carry_cells(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source.png"
            Image.new("RGB", (1936, 1168)).save(source)
            with self.assertRaisesRegex(ValueError, "multiples"):
                to_rgb_png(source, root / "atlas.png", (641, 1088))


if __name__ == "__main__":
    unittest.main()
