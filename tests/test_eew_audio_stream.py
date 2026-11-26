import json
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))

from eew_audio_stream import (  # noqa: E402
    SAMPLE_RATE,
    EewAudioFeeder,
    EewAudioTracker,
    build_eew_audio_playlist,
    headline_place,
    resolve_area_audio_names,
)


class EewAudioStreamTests(unittest.TestCase):
    def test_headline_place_and_area_resolution_match_noto_scenario(self):
        self.assertEqual(headline_place("石川県能登地方"), "石川県")
        self.assertEqual(headline_place("能登半島沖"), "能登半島沖")
        self.assertEqual(headline_place("留萌地方中北部"), "留萌地方")

        # 第1報
        self.assertEqual(resolve_area_audio_names(["石川県能登"]), ["石川県"])
        # 第2報
        self.assertEqual(
            resolve_area_audio_names([
                "石川県能登", "富山県西部", "新潟県上越", "富山県東部", "石川県加賀", "新潟県佐渡",
                "長野県北部", "新潟県中越", "岐阜県飛騨", "群馬県南部",
            ]),
            ["石川県", "富山県", "新潟県", "長野県", "岐阜県", "群馬県"],
        )
        # 第3報 (2行14文字超で地方まとめ)
        self.assertEqual(
            resolve_area_audio_names([
                "石川県能登", "石川県加賀", "富山県西部", "富山県東部", "福井県嶺北", "福井県嶺南",
                "新潟県上越", "新潟県佐渡", "新潟県中越", "新潟県下越",
                "長野県北部", "長野県南部", "長野県中部", "山梨県中・西部",
                "福島県会津", "福島県中通り", "宮城県南部", "宮城県中部", "山形県村山", "山形県置賜", "山形県庄内",
                "栃木県南部", "栃木県北部", "茨城県南部", "茨城県北部", "埼玉県北部", "埼玉県南部", "埼玉県秩父",
                "群馬県北部", "群馬県南部", "千葉県北西部",
                "岐阜県飛騨", "岐阜県美濃中西部", "岐阜県美濃東部", "静岡県東部", "愛知県西部", "三重県北部",
                "滋賀県北部", "奈良県", "兵庫県北部",
            ]),
            ["北陸", "新潟県", "甲信", "東北", "関東", "東海", "近畿"],
        )
        # 東京都は個別列挙時に「東京」へ短縮する
        self.assertEqual(resolve_area_audio_names(["東京都２３区", "神奈川県東部"]), ["東京", "神奈川県"])
        # 地方化が発動した場合は北海道の一部のみであっても「北海道」にまとめる
        self.assertEqual(
            resolve_area_audio_names([
                "釧路地方北部", "青森県下北", "岩手県沿岸北部", "宮城県北部", "福島県中通り",
                "茨城県北部", "栃木県北部", "群馬県北部", "埼玉県北部", "千葉県北西部", "東京都２３区",
                "新潟県上越", "富山県東部", "石川県能登", "山梨県中・西部", "長野県北部",
            ]),
            ["北海道", "東北", "関東", "新潟県", "北陸", "甲信"],
        )

    def test_playlist_files_exist_for_noto_first_and_update(self):
        pl1 = build_eew_audio_playlist("石川県能登地方", ["石川県能登"], is_update=False)
        self.assertEqual(pl1[0][0].name, "alert_start.mp3")
        self.assertEqual(pl1[1][0].name, "石川県で地震.mp3")
        self.assertTrue(all(p.is_file() for p, _ in pl1))

        pl2 = build_eew_audio_playlist("能登半島沖", ["石川県能登", "福井県嶺北", "新潟県上越", "長野県北部", "山梨県中・西部", "宮城県南部", "茨城県南部", "静岡県東部", "滋賀県北部"], is_update=True)
        self.assertEqual(pl2[0][0].name, "alert_update.mp3")
        self.assertEqual(pl2[1][0].name, "能登半島沖で地震.mp3")
        area_items = [(p, pause) for p, pause in pl2 if "areas" in p.parts]
        self.assertTrue(all(p.parent.name == "areas" for p, _ in area_items))
        self.assertEqual(area_items[-1][1], 250)
        self.assertTrue(all(p.is_file() for p, _ in pl2))

    def test_tracker_triggers_only_for_warning_eew_and_cuts_on_update_or_cancel(self):
        calls = []

        class StubFeeder:
            def play(self, playlist):
                calls.append(("play", [p.name for p, _ in playlist]))

            def stop(self):
                calls.append(("stop", None))

        tracker = EewAudioTracker(StubFeeder())

        # 予報級は無視
        tracker.on_snapshot({"layers": {"eew": [{
            "event": {"id": "e1", "serial": 1, "publishedAt": "2026-01-01T00:00:00Z"},
            "payload": {"render": {"isWarning": False, "hypocenterName": "石川県能登地方", "areas": ["石川県能登"]}},
        }]}})
        self.assertEqual(calls, [])

        # 警報第1報
        tracker.on_snapshot({"layers": {"eew": [{
            "event": {"id": "e2", "serial": 1, "publishedAt": "2026-01-01T00:01:00Z"},
            "payload": {"render": {"isWarning": True, "hypocenterName": "石川県能登地方", "areas": ["石川県能登"]}},
        }]}})
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][0], "play")
        self.assertEqual(calls[0][1][0], "alert_start.mp3")

        # 同一イベント・同一報は無視
        tracker.on_snapshot({"layers": {"eew": [{
            "event": {"id": "e2", "serial": 1, "publishedAt": "2026-01-01T00:01:00Z"},
            "payload": {"render": {"isWarning": True, "hypocenterName": "石川県能登地方", "areas": ["石川県能登"]}},
        }]}})
        self.assertEqual(len(calls), 1)

        # 警報続報 -> alert_update.mp3 で再生切り替え
        tracker.on_snapshot({"layers": {"eew": [{
            "event": {"id": "e2", "serial": 2, "publishedAt": "2026-01-01T00:01:15Z"},
            "payload": {"render": {"isWarning": True, "hypocenterName": "石川県能登地方", "areas": ["石川県能登", "富山県西部"]}},
        }]}})
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[1][0], "play")
        self.assertEqual(calls[1][1][0], "alert_update.mp3")

        # 取消 -> alert_cancel.mp3 を再生
        tracker.on_snapshot({"layers": {"eew": [{
            "action": "cancel",
            "event": {"id": "e2", "serial": 3, "infoType": "取消", "publishedAt": "2026-01-01T00:01:30Z"},
            "payload": {"render": {"isWarning": True, "hypocenterName": "石川県能登地方", "areas": []}},
        }]}})
        self.assertEqual(calls[-1], ("play", ["alert_cancel.mp3"]))

    def test_feeder_streams_silence_then_cuts_to_pcm_on_play(self):
        feeder = EewAudioFeeder(sample_rate=SAMPLE_RATE)
        feeder.start()
        try:
            sock = socket.create_connection(("127.0.0.1", feeder.port), timeout=5)
            try:
                # 通常時はゼロ埋め無音を受信
                chunk = sock.recv(1920)
                self.assertEqual(len(chunk), 1920)
                self.assertTrue(all(b == 0 for b in chunk))

                # PCM を投入すると非ゼロの音声データに切り替わる
                tone = b"\x01\x02" * 2400
                feeder.play_pcm(tone)
                received = b""
                deadline = time.monotonic() + 2.0
                while time.monotonic() < deadline and b"\x01\x02" not in received:
                    received += sock.recv(1920)
                self.assertIn(b"\x01\x02", received)
            finally:
                sock.close()
        finally:
            feeder.close()

    @unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "FFmpeg tools are not installed")
    def test_ffmpeg_command_produces_video_and_stereo_aac_audio(self):
        from atlas_ii import ffmpeg_command  # noqa: E402

        feeder = EewAudioFeeder(sample_rate=SAMPLE_RATE)
        feeder.start()
        try:
            with tempfile.TemporaryDirectory() as tmp:
                out = Path(tmp) / "bosai.mkv"
                cmd = ffmpeg_command(str(out), (64, 64), feeder.port, ffmpeg=shutil.which("ffmpeg"), output_format="matroska")
                self.assertNotIn("-an", cmd)
                self.assertIn("aac", cmd)

                proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stderr=subprocess.PIPE)
                frame = bytes((32, 64, 96)) * 64 * 64
                try:
                    for _ in range(5):
                        proc.stdin.write(frame)
                        proc.stdin.flush()
                        time.sleep(0.1)
                    proc.stdin.close()
                    feeder.close()
                    err = proc.stderr.read().decode(errors="replace")
                    self.assertEqual(proc.wait(timeout=15), 0, err)
                finally:
                    if proc.poll() is None:
                        proc.kill()
                        proc.wait()

                probe = subprocess.run(
                    [shutil.which("ffprobe"), "-v", "error", "-show_entries",
                     "stream=codec_type,codec_name,channels,channel_layout,sample_rate", "-of", "json", str(out)],
                    check=True, capture_output=True, text=True,
                )
                streams = json.loads(probe.stdout)["streams"]
                video = [s for s in streams if s["codec_type"] == "video"]
                audio = [s for s in streams if s["codec_type"] == "audio"]
                self.assertEqual(len(video), 1)
                self.assertEqual(len(audio), 1)
                self.assertEqual(audio[0]["codec_name"], "aac")
                self.assertEqual(audio[0]["channels"], 2)
                self.assertEqual(audio[0]["channel_layout"], "stereo")
                self.assertEqual(int(audio[0]["sample_rate"]), SAMPLE_RATE)
        finally:
            feeder.close()


if __name__ == "__main__":
    unittest.main()
