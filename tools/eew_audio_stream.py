"""EEW (緊急地震速報・警報) 音声ストリーム生成と FFmpeg モノラル PCM フィーダー。"""

from __future__ import annotations

from collections import deque
from pathlib import Path
import re
import socket
import subprocess
import threading
import time

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_AUDIO_DIR = ROOT / "telop" / "audio" / "eew"
SAMPLE_RATE = 48000
CHANNELS = 1
SAMPLE_WIDTH = 2  # s16le
CHUNK_MS = 20
CHUNK_SAMPLES = SAMPLE_RATE * CHUNK_MS // 1000
CHUNK_BYTES = CHUNK_SAMPLES * CHANNELS * SAMPLE_WIDTH
SILENCE_CHUNK = b"\x00" * CHUNK_BYTES

PREF_NAMES = [
    "北海道", "青森県", "岩手県", "宮城県", "秋田県", "山形県", "福島県",
    "茨城県", "栃木県", "群馬県", "埼玉県", "千葉県", "東京都", "神奈川県",
    "新潟県", "富山県", "石川県", "福井県", "山梨県", "長野県", "岐阜県",
    "静岡県", "愛知県", "三重県", "滋賀県", "京都府", "大阪府", "兵庫県",
    "奈良県", "和歌山県", "鳥取県", "島根県", "岡山県", "広島県", "山口県",
    "徳島県", "香川県", "愛媛県", "高知県", "福岡県", "佐賀県", "長崎県",
    "熊本県", "大分県", "宮崎県", "鹿児島県", "沖縄県",
]

REGION_OF = {
    "青森県": "東北", "岩手県": "東北", "宮城県": "東北", "秋田県": "東北", "山形県": "東北", "福島県": "東北",
    "茨城県": "関東", "栃木県": "関東", "群馬県": "関東", "埼玉県": "関東", "千葉県": "関東", "東京都": "関東", "神奈川県": "関東",
    "富山県": "北陸", "石川県": "北陸", "福井県": "北陸",
    "岐阜県": "東海", "静岡県": "東海", "愛知県": "東海", "三重県": "東海",
    "滋賀県": "近畿", "京都府": "近畿", "大阪府": "近畿", "兵庫県": "近畿", "奈良県": "近畿", "和歌山県": "近畿",
    "鳥取県": "中国", "島根県": "中国", "岡山県": "中国", "広島県": "中国", "山口県": "中国",
    "徳島県": "四国", "香川県": "四国", "愛媛県": "四国", "高知県": "四国",
    "福岡県": "九州", "佐賀県": "九州", "長崎県": "九州", "熊本県": "九州", "大分県": "九州", "宮崎県": "九州", "鹿児島県": "九州",
    "沖縄県": "沖縄",
}

HK_ZONE_OF = [
    ("石狩地方", "北海道道央"), ("空知地方", "北海道道央"), ("後志地方", "北海道道央"),
    ("渡島地方", "北海道道南"), ("檜山地方", "北海道道南"), ("胆振地方", "北海道道南"),
    ("日高地方", "北海道道南"), ("奥尻島", "北海道道南"),
    ("上川地方", "北海道道北"), ("留萌地方", "北海道道北"), ("宗谷地方", "北海道道北"),
    ("利尻礼文", "北海道道北"),
    ("網走地方", "北海道道東"), ("北見地方", "北海道道東"), ("紋別地方", "北海道道東"),
    ("十勝地方", "北海道道東"), ("釧路地方", "北海道道東"), ("根室地方", "北海道道東"),
]

HK4 = ["北海道道央", "北海道道南", "北海道道北", "北海道道東"]

_PREF_RE = re.compile(
    "^(" + "|".join(sorted(PREF_NAMES, key=len, reverse=True)) + ")(.*)$"
)
_SUFFIX_RE = re.compile(
    r"(?:中北部|中南部|中東部|中西部|北西部|北東部|南西部|南東部|東部|西部|南部|北部|中部)$"
)


def _short_name(pref: str) -> str:
    return re.sub(r"[都府県]$", "", pref)


def _area_to_pref(area: str) -> str | None:
    s = str(area or "")
    for name in PREF_NAMES:
        if s == name or s.startswith(name):
            return name
    return None


def _hokkaido_zones(areas: list[str]) -> list[str]:
    found: list[str] = []
    for area in areas or []:
        s = str(area or "")
        for z in HK4:
            if z in s and z not in found:
                found.append(z)
        for key, z in HK_ZONE_OF:
            if key in s and z not in found:
                found.append(z)
    return [z for z in HK4 if z in found]


def _resolve_prefs(areas: list[str]) -> list[str]:
    prefs: list[str] = []
    for area in areas or []:
        pref = _area_to_pref(area) or ("北海道" if _hokkaido_zones([area]) else None)
        if pref and pref not in prefs:
            prefs.append(pref)
    return prefs


def _wrap_tokens(tokens: list[str], cap: int) -> list[str]:
    lines: list[str] = []
    cur = ""
    cur_u = 0
    for token in tokens:
        u = len(token)
        add = u + 1 if cur else u
        if cur and cur_u + add > cap:
            lines.append(cur)
            cur = token
            cur_u = u
        else:
            cur = f"{cur}　{token}" if cur else token
            cur_u += add
    if cur:
        lines.append(cur)
    return lines


def _horizontal_tokens(prefs: list[str], areas: list[str], grouped: bool, full_names: bool) -> list[str]:
    hk = _hokkaido_zones(areas)
    koshin = "山梨県" in prefs and "長野県" in prefs
    counts: dict[str, int] = {}
    for p in prefs:
        r = REGION_OF.get(p)
        if r and p != "新潟県":
            counts[r] = counts.get(r, 0) + 1
    out: list[str] = []
    emitted: set[str] = set()
    for p in prefs:
        if p == "北海道":
            out.extend(["北海道"] if grouped else (hk if hk else ["北海道"]))
            continue
        if p == "新潟県":
            out.append("新潟県" if full_names else "新潟")
            continue
        if p in ("山梨県", "長野県"):
            if grouped and koshin:
                if "甲信" not in emitted:
                    out.append("甲信")
                    emitted.add("甲信")
            else:
                out.append(p if full_names else _short_name(p))
            continue
        r = REGION_OF.get(p)
        if grouped and r and counts.get(r, 0) > 1:
            if r not in emitted:
                out.append("沖縄県" if (full_names and r == "沖縄") else r)
                emitted.add(r)
        else:
            out.append(("東京" if p == "東京都" else p) if full_names else _short_name(p))
    return out


def resolve_area_audio_names(areas: list[str]) -> list[str]:
    """下部スーパーインポーズの表示規則に従い、音声パーツ用の地域名配列を返す。"""
    prefs = _resolve_prefs(areas)
    display_tokens = _horizontal_tokens(prefs, areas, grouped=False, full_names=False)
    grouped = len(_wrap_tokens(display_tokens, 14)) > 2
    return _horizontal_tokens(prefs, areas, grouped=grouped, full_names=True)


def headline_place(name: str) -> str:
    """震央地名をテロップ見出しと同じ丸め規則で正規化する。"""
    s = str(name or "").strip()
    if not s:
        return ""
    m = _PREF_RE.match(s)
    if m and m.group(2) and "沖" not in m.group(2) and "近海" not in m.group(2):
        return m.group(1)
    return _SUFFIX_RE.sub("", s)


def build_eew_audio_playlist(
    hypocenter_name: str,
    areas: list[str],
    *,
    is_update: bool = False,
    repeat_count: int = 2,
    audio_dir: Path = DEFAULT_AUDIO_DIR,
) -> list[tuple[Path, int]]:
    """EEW データから (MP3パス, 後続ポーズms) の再生キューを組み立てる。"""
    place = headline_place(hypocenter_name)
    area_names = resolve_area_audio_names(areas)
    queue: list[tuple[Path, int]] = []

    for i in range(max(1, repeat_count)):
        start_file = "alert_update.mp3" if (is_update and i == 0) else "alert_start.mp3"
        queue.append((audio_dir / "phrases" / start_file, 120))
        if place:
            epi_path = audio_dir / "epicenters" / f"{place}で地震.mp3"
            if epi_path.is_file():
                queue.append((epi_path, 150))
        queue.append((audio_dir / "phrases" / "alert_warn.mp3", 120))
        for idx, area in enumerate(area_names):
            is_last = idx == len(area_names) - 1
            area_path = (
                audio_dir / "areas" / f"{area}.mp3"
                if is_last
                else audio_dir / "areas" / "cont" / f"{area}.mp3"
            )
            if not area_path.is_file() and not is_last:
                area_path = audio_dir / "areas" / f"{area}.mp3"
            if area_path.is_file():
                queue.append((area_path, 250 if is_last else 280))

    queue.append((audio_dir / "phrases" / "alert_end.mp3", 180))
    queue.append((audio_dir / "phrases" / "alert_action1.mp3", 120))
    queue.append((audio_dir / "phrases" / "alert_action2.mp3", 0))
    return queue


class AudioClipCache:
    """MP3 ファイルをモノラル s16le PCM にデコードしてキャッシュする。"""

    def __init__(self, ffmpeg: str = "ffmpeg", sample_rate: int = SAMPLE_RATE) -> None:
        self._ffmpeg = ffmpeg
        self._sample_rate = sample_rate
        self._cache: dict[Path, bytes] = {}
        self._lock = threading.Lock()

    def get_pcm(self, path: Path) -> bytes:
        with self._lock:
            cached = self._cache.get(path)
        if cached is not None:
            return cached
        proc = subprocess.run(
            [
                self._ffmpeg, "-hide_banner", "-loglevel", "error",
                "-i", str(path), "-f", "s16le",
                "-ar", str(self._sample_rate), "-ac", str(CHANNELS), "pipe:1",
            ],
            capture_output=True,
            check=True,
        )
        pcm = proc.stdout
        with self._lock:
            self._cache[path] = pcm
        return pcm


class EewAudioFeeder:
    """ローカル TCP 経由で FFmpeg へ常時モノラル PCM を供給するフィーダー。"""

    def __init__(self, ffmpeg: str = "ffmpeg", sample_rate: int = SAMPLE_RATE) -> None:
        self._sample_rate = sample_rate
        self._cache = AudioClipCache(ffmpeg=ffmpeg, sample_rate=sample_rate)
        self._server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._server.bind(("127.0.0.1", 0))
        self._server.listen(1)
        self._server.settimeout(0.2)
        self.port: int = self._server.getsockname()[1]

        self._lock = threading.Lock()
        self._chunks: deque[bytes] = deque()
        self._generation = 0
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        if self._thread is not None:
            return
        self._thread = threading.Thread(target=self._serve_loop, daemon=True)
        self._thread.start()

    def close(self) -> None:
        self._stop_event.set()
        try:
            self._server.close()
        except OSError:
            pass
        if self._thread is not None:
            self._thread.join(timeout=2.0)
            self._thread = None

    def stop(self) -> None:
        with self._lock:
            self._generation += 1
            self._chunks.clear()

    def play_pcm(self, pcm: bytes) -> None:
        """任意の PCM バイト列を即時再生する (テストおよび直接投入用)。"""
        with self._lock:
            self._generation += 1
            self._chunks.clear()
            self._enqueue_pcm_locked(pcm)

    def play(self, playlist: list[tuple[Path, int]]) -> None:
        """現在の再生を即座にカットし、新しいプレイリストを非同期デコードしつつ再生する。"""
        with self._lock:
            self._generation += 1
            gen = self._generation
            self._chunks.clear()

        def loader() -> None:
            for path, pause_ms in playlist:
                with self._lock:
                    if gen != self._generation or self._stop_event.is_set():
                        return
                try:
                    pcm = self._cache.get_pcm(path)
                except Exception:
                    continue
                pause_bytes = b"\x00" * (int(self._sample_rate * pause_ms / 1000) * CHANNELS * SAMPLE_WIDTH)
                with self._lock:
                    if gen != self._generation or self._stop_event.is_set():
                        return
                    self._enqueue_pcm_locked(pcm + pause_bytes)

        threading.Thread(target=loader, daemon=True).start()

    def _enqueue_pcm_locked(self, data: bytes) -> None:
        for i in range(0, len(data), CHUNK_BYTES):
            part = data[i:i + CHUNK_BYTES]
            if len(part) < CHUNK_BYTES:
                part += b"\x00" * (CHUNK_BYTES - len(part))
            self._chunks.append(part)

    def _next_chunk(self) -> bytes:
        with self._lock:
            if self._chunks:
                return self._chunks.popleft()
        return SILENCE_CHUNK

    def _serve_loop(self) -> None:
        while not self._stop_event.is_set():
            try:
                conn, _ = self._server.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            try:
                interval = CHUNK_MS / 1000.0
                next_due = time.monotonic()
                while not self._stop_event.is_set():
                    conn.sendall(self._next_chunk())
                    next_due += interval
                    delay = next_due - time.monotonic()
                    if delay > 0:
                        time.sleep(delay)
                    else:
                        next_due = time.monotonic()
            except OSError:
                pass
            finally:
                try:
                    conn.close()
                except OSError:
                    pass


class EewAudioTracker:
    """atlas-state スナップショットの変化を監視し、警報級 EEW の音声再生を制御する。"""

    def __init__(self, feeder: EewAudioFeeder, audio_dir: Path = DEFAULT_AUDIO_DIR) -> None:
        self._feeder = feeder
        self._audio_dir = audio_dir
        self._last_event_id: str | None = None
        self._last_key: str | None = None
        self._active_warning: bool = False

    def on_snapshot(self, snapshot: dict | None) -> None:
        if not isinstance(snapshot, dict):
            return
        entries = (snapshot.get("layers") or {}).get("eew") or []
        if not entries:
            if self._last_key is not None:
                self._last_event_id = None
                self._last_key = None
                self._active_warning = False
                self._feeder.stop()
            return

        entry = entries[-1]
        event = entry.get("event") or {}
        payload = entry.get("payload") or {}
        render = payload.get("render") or {}
        atlas_ii = payload.get("atlasII") or {}

        event_id = str(event.get("id") or atlas_ii.get("eventId") or "")
        serial = event.get("serial")
        published_at = event.get("publishedAt") or ""
        key = f"{event_id}:{serial}:{published_at}"

        is_cancel = (
            entry.get("action") == "cancel"
            or event.get("infoType") == "取消"
            or bool((atlas_ii.get("eventFlags") or 0) & 1)
        )
        if is_cancel:
            if self._last_key != key:
                was_warning = self._active_warning
                self._last_event_id = None
                self._last_key = key
                self._active_warning = False
                if was_warning:
                    cancel_path = self._audio_dir / "phrases" / "alert_cancel.mp3"
                    if cancel_path.is_file():
                        self._feeder.play([(cancel_path, 0)])
                        return
                self._feeder.stop()
            return

        # 警報級のみ音声を再生 (予報級 isWarning=False は鳴らさない)
        if render.get("isWarning") is False:
            return

        if key == self._last_key:
            return

        is_update = bool(self._last_event_id and event_id and event_id == self._last_event_id)
        self._last_event_id = event_id or self._last_event_id
        self._last_key = key
        self._active_warning = True

        hypocenter_name = str(render.get("hypocenterName") or "")
        areas = list(render.get("areas") or [])
        playlist = build_eew_audio_playlist(
            hypocenter_name,
            areas,
            is_update=is_update,
            audio_dir=self._audio_dir,
        )
        self._feeder.play(playlist)
