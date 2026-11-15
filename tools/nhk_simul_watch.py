#!/usr/bin/env python3
"""NHK news simulcast watcher.

The NHK news simulcast (newssimul-stream.nhk.jp) only carries video while
an emergency simulcast is running. Its master playlist answers 200 even
when idle, but the media playlists under it (master-128k/256k/512k.m3u8)
return 404 until the simulcast starts. This watcher polls those media
playlists once a minute and posts to the kishou_server Discord webhook
(the same DEBUG_DISCORD_WEBHOOK_URL the overlay archiver uses) on
transitions:

- down -> live : "started" message, with the newest overlay atlas image
  attached (start only). The image is the archiver's posted form
  (transparent-converted PNG under archive/transparent/), and frames
  that are (nearly) fully transparent are skipped so a black image is
  never attached.
- live -> down : "ended" message, text only.

A check that fails at the network level (DNS/connect/timeout) is treated
as "unknown" and never as "ended", so a transient outage cannot produce
a false end notice. State is kept in a JSON file so restarts do not
re-notify.

Environment overrides (defaults match production):
  NHK_SIMUL_MASTER_URL  master playlist URL (variants live next to it)
  NHK_SIMUL_VARIANTS    comma-separated media playlist file names
  NHK_SIMUL_POLL_SEC    poll interval seconds (default 60)
  NHK_SIMUL_STATE_FILE  state JSON path
  NHK_SIMUL_ATLAS_DIR   overlay archiver transparent/ directory (atlas source)
  NHK_SIMUL_ENV_FILE    .env file holding DEBUG_DISCORD_WEBHOOK_URL
  NHK_SIMUL_WEBHOOK_URL webhook URL override (wins over env file)
  NHK_SIMUL_DRY_RUN     "1" = log notifications instead of posting
  NHK_SIMUL_ONCE        "1" = check once and exit
"""

import json
import os
import struct
import sys
import time
import urllib.error
import urllib.request
import uuid
import zlib
from datetime import datetime, timedelta, timezone

JST = timezone(timedelta(hours=9))

MASTER_URL = os.environ.get(
    "NHK_SIMUL_MASTER_URL",
    "https://newssimul-stream.nhk.jp/hls/live/2010561/nhknewssimul/master.m3u8",
)
VARIANTS = [
    v.strip()
    for v in os.environ.get(
        "NHK_SIMUL_VARIANTS", "master-128k.m3u8,master-256k.m3u8,master-512k.m3u8"
    ).split(",")
    if v.strip()
]
POLL_SEC = float(os.environ.get("NHK_SIMUL_POLL_SEC", "60"))
STATE_FILE = os.environ.get(
    "NHK_SIMUL_STATE_FILE", "/opt/kishou-server/runtime/nhk-simul-watch-state.json"
)
ATLAS_DIR = os.environ.get(
    "NHK_SIMUL_ATLAS_DIR",
    os.environ.get(
        "NHK_SIMUL_FRAMES_DIR", "/opt/kishou-server/archive/transparent"
    ),
)
ENV_FILE = os.environ.get("NHK_SIMUL_ENV_FILE", "/opt/kishou-server/.env")
DRY_RUN = os.environ.get("NHK_SIMUL_DRY_RUN", "") == "1"
ONCE = os.environ.get("NHK_SIMUL_ONCE", "") == "1"

USER_AGENT = "kishou-nhk-simul-watch/1.0 (Usuiensan/kishou_server)"
MAX_ATTACH_BYTES = 24 * 1024 * 1024
# Atlas candidates are checked newest-first; a frame counts as visible
# when enough sampled pixels are opaque. A fully transparent frame is
# encoder noise on an empty canvas and renders as a black image.
ATLAS_MAX_CANDIDATES = 40
ATLAS_SAMPLE_STRIDE = 8
ATLAS_MIN_VISIBLE_SAMPLES = 300


def now_jst():
    return datetime.now(JST)


def fmt_jst(dt):
    return dt.strftime("%Y-%m-%d %H:%M JST")


def is_live_playlist(body):
    """A media playlist counts as live when it lists segments and is not ended."""
    return (
        "#EXTM3U" in body
        and ".ts" in body
        and "#EXT-X-ENDLIST" not in body
    )


def fetch(url, timeout=10):
    """Return (status, body). status is None on a network-level failure."""
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, ""
    except Exception:
        return None, ""


def check_live():
    """Return (verdict, detail): verdict is True (live), False (down) or
    None (unknown -- every request failed at the network level)."""
    base = MASTER_URL.rsplit("/", 1)[0]
    saw_response = False
    details = []
    for name in VARIANTS:
        status, body = fetch(f"{base}/{name}")
        if status is None:
            details.append(f"{name}:network-error")
            continue
        saw_response = True
        details.append(f"{name}:{status}")
        if status == 200 and is_live_playlist(body):
            return True, ", ".join(details)
    if not saw_response:
        return None, ", ".join(details)
    return False, ", ".join(details)


def load_webhook_url():
    url = os.environ.get("NHK_SIMUL_WEBHOOK_URL", "").strip()
    if url:
        return url
    url = os.environ.get("OVERLAY_DISCORD_WEBHOOK_URL", "").strip()
    if url:
        return url
    try:
        with open(ENV_FILE, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line.startswith("DEBUG_DISCORD_WEBHOOK_URL="):
                    return line.split("=", 1)[1].strip().strip('"').strip("'")
    except OSError:
        pass
    return ""


WEBHOOK_URL = load_webhook_url()


def post_webhook(content, attach_path=None):
    """POST one message to the Discord webhook. Returns HTTP status."""
    if DRY_RUN:
        print(f"nhk-simul-watch: [dry-run] would post: {content!r} attach={attach_path}", flush=True)
        return 200
    if not WEBHOOK_URL:
        print("nhk-simul-watch: webhook not configured, message dropped", file=sys.stderr, flush=True)
        return 0
    if attach_path:
        with open(attach_path, "rb") as f:
            data = f.read()
        name = os.path.basename(attach_path)
        boundary = "----nhk-simul-watch-" + uuid.uuid4().hex
        payload = json.dumps({"content": content}).encode("utf-8")
        body = b"".join([
            f"--{boundary}\r\n".encode(),
            b'Content-Disposition: form-data; name="payload_json"\r\n',
            b"Content-Type: application/json\r\n\r\n",
            payload,
            b"\r\n",
            f"--{boundary}\r\n".encode(),
            f'Content-Disposition: form-data; name="file"; filename="{name}"\r\n'.encode(),
            b"Content-Type: image/png\r\n\r\n",
            data,
            b"\r\n",
            f"--{boundary}--\r\n".encode(),
        ])
        headers = {
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "User-Agent": USER_AGENT,
        }
    else:
        body = json.dumps({"content": content}).encode("utf-8")
        headers = {"Content-Type": "application/json", "User-Agent": USER_AGENT}
    req = urllib.request.Request(WEBHOOK_URL, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status
    except urllib.error.HTTPError as e:
        if e.code == 429:
            try:
                retry_after = float(json.loads(e.read().decode("utf-8")).get("retry_after", 2))
            except Exception:
                retry_after = 2.0
            time.sleep(min(max(retry_after, 1.0), 60.0))
            try:
                with urllib.request.urlopen(req, timeout=30) as resp:
                    return resp.status
            except urllib.error.HTTPError as e2:
                return e2.code
        return e.code


def png_visible_samples(path):
    """Count sampled opaque pixels in an 8-bit non-interlaced PNG.

    Returns -1 when the PNG cannot be assessed (unusual layout or a
    decode error); callers treat that as visible, so the check only
    ever filters out frames that are provably (near-)transparent.
    """
    try:
        with open(path, "rb") as f:
            data = f.read()
        if not data.startswith(b"\x89PNG\r\n\x1a\n"):
            return -1
        width = height = color_type = None
        idat = bytearray()
        pos = 8
        while pos + 8 <= len(data):
            (length,) = struct.unpack(">I", data[pos:pos + 4])
            tag = data[pos + 4:pos + 8]
            chunk = data[pos + 8:pos + 8 + length]
            if tag == b"IHDR":
                width, height, depth, color_type, _comp, _filt, interlace = (
                    struct.unpack(">IIBBBBB", chunk)
                )
                if depth != 8 or interlace != 0:
                    return -1
            elif tag == b"IDAT":
                idat += chunk
            elif tag == b"IEND":
                break
            pos += 12 + length
        channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}.get(color_type)
        if width is None or channels is None or color_type == 3:
            return -1
        raw = zlib.decompress(bytes(idat))
        stride = width * channels
        if len(raw) < (stride + 1) * height:
            return -1
        # Unfilter scanlines (bpp = channels at 8-bit depth).
        rows = []
        prev = bytearray(stride)
        off = 0
        for _y in range(height):
            ftype = raw[off]
            line = bytearray(raw[off + 1:off + 1 + stride])
            off += 1 + stride
            if ftype == 1:
                for i in range(channels, stride):
                    line[i] = (line[i] + line[i - channels]) & 0xFF
            elif ftype == 2:
                for i in range(stride):
                    line[i] = (line[i] + prev[i]) & 0xFF
            elif ftype == 3:
                for i in range(stride):
                    left = line[i - channels] if i >= channels else 0
                    line[i] = (line[i] + ((left + prev[i]) >> 1)) & 0xFF
            elif ftype == 4:
                for i in range(stride):
                    a = line[i - channels] if i >= channels else 0
                    b = prev[i]
                    c = prev[i - channels] if i >= channels else 0
                    p = a + b - c
                    pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                    pred = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                    line[i] = (line[i] + pred) & 0xFF
            elif ftype != 0:
                return -1
            rows.append(line)
            prev = line
        if color_type == 6:
            alpha_off = 3
        elif color_type == 4:
            alpha_off = 1
        else:
            # No alpha channel: the image is fully opaque by definition.
            return (width // ATLAS_SAMPLE_STRIDE + 1) * (height // ATLAS_SAMPLE_STRIDE + 1)
        visible = 0
        for y in range(0, height, ATLAS_SAMPLE_STRIDE):
            row = rows[y]
            for x in range(0, width, ATLAS_SAMPLE_STRIDE):
                if row[x * channels + alpha_off] >= 128:
                    visible += 1
        return visible
    except Exception:
        return -1


def newest_atlas_frame():
    """Newest visible atlas PNG from the archiver's transparent/ tree.

    Nearly transparent frames (empty-canvas encoder noise) are skipped;
    returns None when no candidate has visible content.
    """
    candidates = []
    for root, _dirs, files in os.walk(ATLAS_DIR):
        for name in files:
            if name.lower().endswith(".png"):
                path = os.path.join(root, name)
                try:
                    candidates.append((os.path.getmtime(path), path))
                except OSError:
                    continue
    candidates.sort(reverse=True)
    for _mtime, path in candidates[:ATLAS_MAX_CANDIDATES]:
        try:
            if os.path.getsize(path) > MAX_ATTACH_BYTES:
                continue
        except OSError:
            continue
        samples = png_visible_samples(path)
        if samples < 0 or samples >= ATLAS_MIN_VISIBLE_SAMPLES:
            return path
    return None


def load_state():
    try:
        with open(STATE_FILE, encoding="utf-8") as f:
            state = json.load(f)
        if isinstance(state.get("live"), bool):
            return state
    except Exception:
        pass
    return None


def save_state(state):
    os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
    tmp = STATE_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False)
    os.replace(tmp, STATE_FILE)


def notify_start(since_dt, first_observation=False):
    atlas = newest_atlas_frame()
    lines = [
        "🟢 NHKニュース同時配信の開始を検知しました",
        f"検知時刻: {fmt_jst(since_dt)}",
        f"入口: {MASTER_URL}",
    ]
    if first_observation:
        lines.append("（監視開始時点で既に配信中でした）")
    if atlas:
        lines.append("開始時点の配信アトラスを添付します。")
    status = post_webhook("\n".join(lines), attach_path=atlas)
    print(f"nhk-simul-watch: start notified (HTTP {status}, atlas={'yes' if atlas else 'no'})", flush=True)


def notify_end(end_dt, since_iso):
    lines = [
        "⚪ NHKニュース同時配信の終了を検知しました",
        f"検知時刻: {fmt_jst(end_dt)}",
    ]
    if since_iso:
        try:
            since_dt = datetime.fromisoformat(since_iso)
            delta = end_dt - since_dt
            total_min = int(delta.total_seconds() // 60)
            lines.append(f"継続時間: 約{total_min // 60}時間{total_min % 60}分")
        except Exception:
            pass
    status = post_webhook("\n".join(lines))
    print(f"nhk-simul-watch: end notified (HTTP {status})", flush=True)


def step(state):
    """Run one poll. Returns the (possibly new) state dict."""
    verdict, detail = check_live()
    now = now_jst()
    print(f"nhk-simul-watch: check {fmt_jst(now)} verdict={verdict} ({detail})", flush=True)
    if verdict is None:
        state["last_check"] = now.isoformat()
        return state
    if state is None:
        state = {"live": verdict, "since": now.isoformat() if verdict else None,
                 "last_check": now.isoformat()}
        if verdict:
            notify_start(now, first_observation=True)
            state["since"] = now.isoformat()
        return state
    was_live = state.get("live", False)
    if verdict and not was_live:
        notify_start(now)
        state["live"] = True
        state["since"] = now.isoformat()
    elif not verdict and was_live:
        notify_end(now, state.get("since"))
        state["live"] = False
        state["since"] = None
    state["last_check"] = now.isoformat()
    return state


def main():
    print(
        f"nhk-simul-watch: started (poll {POLL_SEC:.0f}s, webhook={'set' if WEBHOOK_URL else 'unset'}"
        f"{', dry-run' if DRY_RUN else ''})",
        flush=True,
    )
    state = load_state()
    if state is not None:
        print(f"nhk-simul-watch: resumed state live={state.get('live')}", flush=True)
    while True:
        try:
            state = step(state)
            save_state(state)
        except Exception as e:
            print(f"nhk-simul-watch: error: {e}", file=sys.stderr, flush=True)
        if ONCE:
            return
        time.sleep(POLL_SEC)


if __name__ == "__main__":
    main()
