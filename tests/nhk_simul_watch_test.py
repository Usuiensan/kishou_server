#!/usr/bin/env python3
"""Unit tests for tools/nhk_simul_watch.py playlist/state logic.

Run: python3 -m unittest tests.nhk_simul_watch_test
"""

import importlib.util
import os
import struct
import tempfile
import unittest
import zlib

_spec = importlib.util.spec_from_file_location(
    "nhk_simul_watch",
    os.path.join(os.path.dirname(__file__), "..", "tools", "nhk_simul_watch.py"),
)
watch = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(watch)

LIVE_BODY = """#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:5
#EXT-X-MEDIA-SEQUENCE:100
#EXTINF:5.0,
seg-100.ts
#EXTINF:5.0,
seg-101.ts
"""

ENDED_BODY = LIVE_BODY + "#EXT-X-ENDLIST\n"
MASTER_BODY = """#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=620791
master-512k.m3u8
"""


class IsLivePlaylistTest(unittest.TestCase):
    def test_live_media_playlist(self):
        self.assertTrue(watch.is_live_playlist(LIVE_BODY))

    def test_ended_playlist_is_not_live(self):
        self.assertFalse(watch.is_live_playlist(ENDED_BODY))

    def test_master_playlist_is_not_live(self):
        self.assertFalse(watch.is_live_playlist(MASTER_BODY))

    def test_empty_body_is_not_live(self):
        self.assertFalse(watch.is_live_playlist(""))


class CheckLiveTest(unittest.TestCase):
    def setUp(self):
        self.orig_fetch = watch.fetch

    def tearDown(self):
        watch.fetch = self.orig_fetch

    def test_any_variant_live(self):
        def fake(url):
            if url.endswith("master-512k.m3u8"):
                return 200, LIVE_BODY
            return 404, ""
        watch.fetch = fake
        verdict, _ = watch.check_live()
        self.assertTrue(verdict)

    def test_all_404_is_down(self):
        watch.fetch = lambda url: (404, "")
        verdict, _ = watch.check_live()
        self.assertFalse(verdict)

    def test_network_failure_is_unknown_not_down(self):
        watch.fetch = lambda url: (None, "")
        verdict, _ = watch.check_live()
        self.assertIsNone(verdict)

    def test_partial_network_failure_with_404_is_down(self):
        def fake(url):
            if url.endswith("master-128k.m3u8"):
                return None, ""
            return 404, ""
        watch.fetch = fake
        verdict, _ = watch.check_live()
        self.assertFalse(verdict)


def _png_chunk(tag, data):
    return (
        struct.pack(">I", len(data))
        + tag
        + data
        + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    )


def make_png(width, height, color_type, pixel_fn, filter_type=0):
    """Minimal PNG (8-bit, non-interlaced); pixel_fn(x, y) -> bytes per pixel."""
    channels = {0: 1, 2: 3, 4: 2, 6: 4}[color_type]
    raw = bytearray()
    prev = bytearray(width * channels)
    for y in range(height):
        row = bytearray()
        for x in range(width):
            row += pixel_fn(x, y)
        if filter_type == 0:
            enc = bytes(row)
        elif filter_type == 1:  # Sub
            enc = bytes(
                (row[i] - (row[i - channels] if i >= channels else 0)) & 0xFF
                for i in range(len(row))
            )
        elif filter_type == 2:  # Up
            enc = bytes((row[i] - prev[i]) & 0xFF for i in range(len(row)))
        else:
            raise ValueError(filter_type)
        raw.append(filter_type)
        raw += enc
        prev = row
    ihdr = struct.pack(">IIBBBBB", width, height, 8, color_type, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + _png_chunk(b"IHDR", ihdr)
        + _png_chunk(b"IDAT", zlib.compress(bytes(raw)))
        + _png_chunk(b"IEND", b"")
    )


def rgba_png(alpha_fn, filter_type=0, width=256, height=256):
    return make_png(
        width, height, 6, lambda x, y: bytes((10, 20, 30, alpha_fn(x, y))), filter_type
    )


class AtlasFrameTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.orig_dir = watch.ATLAS_DIR
        watch.ATLAS_DIR = self.tmp.name
        day = os.path.join(self.tmp.name, "2026-11-16")
        os.makedirs(day)
        self.day = day

    def tearDown(self):
        watch.ATLAS_DIR = self.orig_dir
        self.tmp.cleanup()

    def _write(self, name, data, mtime):
        path = os.path.join(self.day, name)
        with open(path, "wb") as f:
            f.write(data)
        os.utime(path, (mtime, mtime))
        return path

    def test_visible_samples_counts_opaque_pixels(self):
        path = self._write("a.png", rgba_png(lambda x, y: 255), 1000)
        self.assertGreaterEqual(
            watch.png_visible_samples(path), watch.ATLAS_MIN_VISIBLE_SAMPLES
        )

    def test_near_transparent_frame_has_no_visible_samples(self):
        path = self._write("a.png", rgba_png(lambda x, y: 2), 1000)
        self.assertEqual(watch.png_visible_samples(path), 0)

    def test_filtered_rows_are_unfiltered(self):
        for ft in (1, 2):
            path = self._write(f"f{ft}.png", rgba_png(lambda x, y: 255, ft), 1000)
            self.assertGreaterEqual(
                watch.png_visible_samples(path), watch.ATLAS_MIN_VISIBLE_SAMPLES
            )

    def test_newest_junk_frame_is_skipped_for_older_visible_one(self):
        visible = self._write("000100_000.png", rgba_png(lambda x, y: 255), 1000)
        self._write("000200_000.png", rgba_png(lambda x, y: 0), 2000)
        self.assertEqual(watch.newest_atlas_frame(), visible)

    def test_only_junk_frames_returns_none(self):
        self._write("000100_000.png", rgba_png(lambda x, y: 1), 1000)
        self.assertIsNone(watch.newest_atlas_frame())

    def test_rgb_png_counts_as_visible(self):
        rgb = make_png(256, 256, 2, lambda x, y: bytes((200, 100, 50)))
        path = self._write("rgb.png", rgb, 1000)
        self.assertEqual(watch.newest_atlas_frame(), path)


if __name__ == "__main__":
    unittest.main()
