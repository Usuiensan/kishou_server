import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
import overlay_archiver
from PIL import Image


class ArchivePageTest(unittest.TestCase):
    def test_late_pages_are_archived_without_null_manifest(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory) / "state"
            archive = Path(directory) / "archive"
            frames = state / "seq-frames"
            frames.mkdir(parents=True)
            archive.mkdir()
            record = {"seq": 7, "ts": "2026-11-18T09:00:00.000Z", "trigger": "jma", "added": [], "removed": [], "active": {}}
            with mock.patch.object(overlay_archiver, "STATE_DIR", str(state)), \
                 mock.patch.object(overlay_archiver, "ARCHIVE_DIR", str(archive)), \
                 mock.patch.object(overlay_archiver, "SEQ_FRAMES_DIR", str(frames)), \
                 mock.patch.object(overlay_archiver, "WEBHOOK_URL", ""):
                seen = set()
                deadline = overlay_archiver.time.time() + 10
                overlay_archiver.archive_pages(record, seen, deadline)
                self.assertFalse((archive / "manifest-2026-11-18.jsonl").exists())
                Image.new("RGBA", (2, 2), (0, 0, 0, 0)).save(frames / "7.png")
                overlay_archiver.archive_pages(record, seen, deadline)
                manifest = archive / "manifest-2026-11-18.jsonl"
                self.assertTrue(manifest.exists())
                self.assertNotIn('"file": null', manifest.read_text())
                Image.new("RGBA", (2, 2), (255, 0, 0, 255)).save(frames / "7-p2.png")
                overlay_archiver.archive_pages(record, seen, deadline)
                rows = [json.loads(line) for line in manifest.read_text().splitlines()]
                self.assertEqual([row["page"] for row in rows], [1, 2])


if __name__ == "__main__":
    unittest.main()
