#!/usr/bin/env python3
"""Unit tests for tools/nhk_simul_watch.py playlist/state logic.

Run: python3 -m unittest tests.nhk_simul_watch_test
"""

import importlib.util
import os
import unittest

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


if __name__ == "__main__":
    unittest.main()
