import importlib
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools"))
import overlay_archiver


class OverlayArchiverPageTest(unittest.TestCase):
    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        root = Path(self.tempdir.name)
        self.state_dir = root / "state"
        self.archive_dir = root / "archive"
        (self.state_dir / "seq-frames").mkdir(parents=True)
        os.environ.update({
            "OVERLAY_STATE_DIR": str(self.state_dir),
            "OVERLAY_ARCHIVE_DIR": str(self.archive_dir),
            "OVERLAY_ENV_FILE": str(root / ".env"),
        })
        import overlay_archiver
        self.archiver = importlib.reload(overlay_archiver)

    def tearDown(self):
        self.tempdir.cleanup()

    def record(self, seq=42):
        return {
            "ts": "2026-11-17T10:40:00.000Z",
            "seq": seq,
            "trigger": "test",
            "added": [{"kind": "intensity", "maxInt": 2}],
            "removed": [],
            "active": {},
        }

    def write_frame(self, name, color):
        from PIL import Image
        Image.new("RGBA", (16, 16), color).save(self.state_dir / "seq-frames" / name)

    def test_page_is_archived_and_enqueued(self):
        record = self.record()
        self.write_frame("42.png", (1, 2, 3, 255))
        self.write_frame("42-p2.png", (4, 5, 6, 255))
        queued = []
        self.archiver.WEBHOOK_URL = "https://example.invalid/webhook"
        with mock.patch.object(self.archiver, "enqueue_webhook", side_effect=lambda *item: queued.append(item)):
            self.archiver.archive_record(record)
            seen = {(record["seq"], 1)}
            self.archiver.archive_pages(record, seen, float("inf"))

        lines = (self.archive_dir / "manifest-2026-11-17.jsonl").read_text().splitlines()
        manifest = [json.loads(line) for line in lines]
        self.assertEqual([item["page"] for item in manifest], [1, 2])
        self.assertEqual(manifest[1]["seq"], 42)
        self.assertEqual(len(queued), 2)
        self.assertTrue(queued[1][1].endswith("_p2.png"))
        self.assertTrue(queued[1][2].endswith("ページ2"))

    def test_manifest_pages_are_restored_on_restart(self):
        record = self.record()
        self.write_frame("42.png", (1, 2, 3, 255))
        self.write_frame("42-p2.png", (4, 5, 6, 255))
        self.archiver.WEBHOOK_URL = "https://example.invalid/webhook"
        with mock.patch.object(self.archiver, "enqueue_webhook"):
            self.archiver.archive_record(record)
            self.archiver.archive_pages(record, {(42, 1)}, float("inf"))

        restarted = importlib.reload(self.archiver)
        seen = restarted.load_manifest_pages("2026-11-17")
        queued = []
        with mock.patch.object(restarted, "enqueue_webhook", side_effect=queued.append):
            restarted.archive_pages(record, seen, float("inf"))
        self.assertIn((42, 2), seen)
        self.assertEqual(queued, [])


if __name__ == "__main__":
    unittest.main()


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
