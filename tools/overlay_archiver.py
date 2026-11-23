#!/usr/bin/env python3
"""Archive overlay frames for every Atlas state change.

The trigger is the ingest's state change log (state-changes.jsonl in
OVERLAY_STATE_DIR), not the video stream: every semantic state change gets
a sequence number, capture_overlay saves the distinct frames rendered for that
sequence under seq-frames/, and this archiver pairs them. Nothing the
sender displayed is skipped, however briefly it was on air.

Output: <archive>/frames/YYYY-MM-DD/HHMMSS_mmm[_p<n>].png  (capture PNG as-is)
        <archive>/transparent/YYYY-MM-DD/HHMMSS_mmm[_p<n>].png  (1920x1080 RGBA)
        <archive>/manifest-YYYY-MM-DD.jsonl

When a Discord webhook URL is configured (env OVERLAY_DISCORD_WEBHOOK_URL,
or DEBUG_DISCORD_WEBHOOK_URL in the kishou_server .env -- the same webhook
jma_server posts to), every saved frame is also posted to that webhook as a
PNG attachment at change time. Sends go through a coalescing queue: if
frames change faster than the send interval, only the newest unsent frame
is posted, so the channel sees the latest picture instead of a backlog.
Baseline frames (the state current at archiver startup) and fully
transparent frames (nothing displayed) are archived and logged in the
manifest but never posted. The transparent/ copy is what gets posted.
"""
import json
import ctypes
import select
import os
import sys
import struct
import threading
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime
import re
from PIL import Image

ARCHIVE_DIR = os.environ.get("OVERLAY_ARCHIVE_DIR", "/opt/kishou-server/archive")
STATE_DIR = os.environ.get("OVERLAY_STATE_DIR", "/opt/kishou-server/runtime")
CHANGE_LOG = os.path.join(STATE_DIR, "state-changes.jsonl")
SEQ_FRAMES_DIR = os.path.join(STATE_DIR, "seq-frames")
ENV_FILE = os.environ.get("OVERLAY_ENV_FILE", "/opt/kishou-server/.env")
WEBHOOK_MIN_INTERVAL = float(os.environ.get("OVERLAY_WEBHOOK_MIN_INTERVAL", "2.0"))
INOTIFY_MASK = 0x00000002 | 0x00000008 | 0x00000040 | 0x00000080 | 0x00000100 | 0x00000400 | 0x00000800


def load_webhook_url():
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
_send_lock = threading.Lock()
_send_pending = None  # (path, name, caption) -- newest unsent frame only


def enqueue_webhook(path, name, caption):
    global _send_pending
    if not WEBHOOK_URL:
        return
    with _send_lock:
        _send_pending = (path, name, caption)


def post_webhook_file(path, name, caption):
    """POST one PNG to the Discord webhook. Returns (status, retry_after)."""
    with open(path, "rb") as f:
        data = f.read()
    boundary = "----overlay-archiver-" + uuid.uuid4().hex
    payload = json.dumps({"content": caption}).encode("utf-8")
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
    req = urllib.request.Request(
        WEBHOOK_URL,
        data=body,
        headers={
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            # Discord (Cloudflare) rejects the default Python-urllib UA with 403.
            "User-Agent": "kishou-overlay-archiver/1.0 (Usuiensan/kishou_server)",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, 0.0
    except urllib.error.HTTPError as e:
        retry_after = 0.0
        if e.code == 429:
            try:
                retry_after = float(json.loads(e.read().decode("utf-8")).get("retry_after", 2))
            except Exception:
                retry_after = 2.0
        return e.code, retry_after


def webhook_sender():
    global _send_pending
    last_sent = 0.0
    while True:
        with _send_lock:
            item = _send_pending
            _send_pending = None
        if item is None:
            time.sleep(0.2)
            continue
        wait = WEBHOOK_MIN_INTERVAL - (time.time() - last_sent)
        if wait > 0:
            time.sleep(wait)
        path, name, caption = item
        try:
            status, retry_after = post_webhook_file(path, name, caption)
            if status == 429:
                print(f"overlay archiver: webhook rate limited, retry in {retry_after}s: {name}",
                      file=sys.stderr, flush=True)
                time.sleep(min(max(retry_after, 1.0), 60.0))
                status, _ = post_webhook_file(path, name, caption)
            if 200 <= status < 300:
                last_sent = time.time()
                print(f"overlay archiver: webhook sent: {name}", flush=True)
            else:
                print(f"overlay archiver: webhook failed: HTTP {status}: {name}",
                      file=sys.stderr, flush=True)
        except Exception as e:
            print(f"overlay archiver: webhook error: {e}: {name}", file=sys.stderr, flush=True)


def load_state():
    try:
        with open(os.path.join(ARCHIVE_DIR, "archiver-state.json"), encoding="utf-8") as f:
            value = json.load(f).get("seq")
            return value if isinstance(value, int) else None
    except (OSError, ValueError):
        return None


def save_state(seq):
    temporary = os.path.join(ARCHIVE_DIR, "archiver-state.json.tmp")
    with open(temporary, "w", encoding="utf-8") as f:
        json.dump({"seq": seq}, f)
    os.replace(temporary, os.path.join(ARCHIVE_DIR, "archiver-state.json"))


def read_records():
    records = []
    try:
        with open(CHANGE_LOG, encoding="utf-8") as f:
            for line in f:
                if not line.strip():
                    continue
                try:
                    records.append(json.loads(line))
                except ValueError:
                    continue
    except OSError:
        pass
    return records


def transparent_copy(source, target):
    image = Image.open(source).convert("RGBA")
    transparent = image.getchannel("A").getextrema()[1] == 0
    rgb = image.convert("RGB").resize((1920, 1080), Image.Resampling.LANCZOS)
    alpha = image.getchannel("A").resize((1920, 1080), Image.Resampling.LANCZOS)
    rgb.putalpha(alpha)
    rgb.save(target, "PNG")
    return transparent


def caption_summary(record):
    item = (record.get("added") or [None])[0]
    if item:
        # 見出しは電文の正式名称（title）を使う。「震度情報」等にまとめない。
        title = item.get("title") or ""
        if item.get("kind") == "eew":
            label = "最終報" if item.get("isFinal") else f"第{item.get('serial')}報"
            return f"{title or '緊急地震速報'} {label} {item.get('hypocenterName')} M{item.get('magnitude')} 深さ{item.get('depthKm')}km"
        if item.get("kind") == "intensity": return f"{title or '震源・震度に関する情報'} 最大震度{item.get('maxInt')}"
        if item.get("kind") == "tsunami": return title or "津波情報"
    removed = (record.get("removed") or [None])[0]
    return f"消去 {removed.get('kind')}" if removed else ""


def webhook_worthy(record):
    """Webhook通知基準（2026-11-23 本人指示）: 震度1・2のみの変化は投稿しない。

    フレームの保存自体は従来通り行う。震度見出し（vertical）は震度情報に
    付随するものとして扱い、EEW・津波・震度3以上・その他の変化は常に対象とする。
    """
    items = (record.get("added") or []) + (record.get("removed") or [])
    has_intensity = False
    for item in items:
        kind = item.get("kind")
        if kind == "intensity":
            if str(item.get("maxInt")) not in ("1", "2"):
                return True
            has_intensity = True
        elif kind == "vertical":
            continue
        else:
            return True
    return not has_intensity


def load_manifest_pages(day):
    pages = set()
    try:
        with open(os.path.join(ARCHIVE_DIR, f"manifest-{day}.jsonl"), encoding="utf-8") as f:
            for line in f:
                try:
                    item = json.loads(line)
                    if isinstance(item.get("seq"), int):
                        pages.add((item["seq"], item.get("page", 1)))
                except (ValueError, TypeError):
                    continue
    except OSError:
        pass
    return pages


def archive_record(record, baseline=False, page=1):
    seq = record["seq"]
    frame_source = os.path.join(SEQ_FRAMES_DIR, f"{seq}.png" if page == 1 else f"{seq}-p{page}.png")
    if not os.path.exists(frame_source):
        return False
    stamp = datetime.fromisoformat(record["ts"].replace("Z", "+00:00")).astimezone()
    day = stamp.strftime("%Y-%m-%d")
    suffix = "" if page == 1 else f"_p{page}"
    name = stamp.strftime("%H%M%S_") + f"{stamp.microsecond // 1000:03d}{suffix}.png"
    frame_rel = None
    posted_rel = None
    transparent = False
    posted = False
    if os.path.exists(frame_source):
        frame_dir = os.path.join(ARCHIVE_DIR, "frames", day)
        transparent_dir = os.path.join(ARCHIVE_DIR, "transparent", day)
        os.makedirs(frame_dir, exist_ok=True)
        os.makedirs(transparent_dir, exist_ok=True)
        frame_path = os.path.join(frame_dir, name)
        transparent_path = os.path.join(transparent_dir, name)
        with open(frame_source, "rb") as source, open(frame_path, "wb") as target:
            target.write(source.read())
        transparent = transparent_copy(frame_path, transparent_path)
        frame_rel = f"frames/{day}/{name}"
        posted = not baseline and not transparent and webhook_worthy(record)
        posted_rel = f"transparent/{day}/{name}" if posted else None
        if posted:
            caption = "アトラス変化 " + stamp.strftime("%Y-%m-%d %H:%M:%S.") + f"{stamp.microsecond // 1000:03d}"
            summary = caption_summary(record)
            if summary: caption += " " + summary
            if page > 1: caption += f" ページ{page}"
            enqueue_webhook(transparent_path, name, caption)
    manifest = os.path.join(ARCHIVE_DIR, f"manifest-{day}.jsonl")
    with open(manifest, "a", encoding="utf-8") as f:
        json.dump({"ts": record["ts"], "file": frame_rel, "seq": seq, "trigger": record.get("trigger"),
                   "added": record.get("added", []), "removed": record.get("removed", []), "active": record.get("active", {}),
                   "baseline": baseline, "transparent": transparent, "posted": posted, "posted_file": posted_rel,
                   "page": page}, f, ensure_ascii=False)
        f.write("\n")
    if page == 1:
        save_state(seq)
    return True


def archive_pages(record, seen_pages, deadline, baseline=False):
    seq = record["seq"]
    if time.time() >= deadline:
        return
    try:
        names = os.listdir(SEQ_FRAMES_DIR)
    except OSError:
        return
    pages = sorted(
        int(match.group(1)) for name in names
        if (match := re.fullmatch(rf"{re.escape(str(seq))}-p(\d+)\.png", name))
    )
    if (seq, 1) not in seen_pages and archive_record(record, baseline=baseline, page=1):
        seen_pages.add((seq, 1))
    for page in pages:
        key = (seq, page)
        if key in seen_pages:
            continue
        if archive_record(record, baseline=baseline, page=page):
            seen_pages.add(key)


def inotify_fd():
    try:
        libc = ctypes.CDLL(None, use_errno=True)
        init = libc.inotify_init1
        add_watch = libc.inotify_add_watch
        init.argtypes = [ctypes.c_int]
        init.restype = ctypes.c_int
        add_watch.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_uint32]
        add_watch.restype = ctypes.c_int
        fd = init(0)
        if fd < 0:
            return None
        if add_watch(fd, os.fsencode(STATE_DIR), INOTIFY_MASK) < 0:
            os.close(fd)
            return None
        return fd
    except (AttributeError, OSError, TypeError):
        return None


def relevant_inotify_event(data):
    offset = 0
    target = os.fsencode(os.path.basename(CHANGE_LOG))
    while offset + 16 <= len(data):
        _, _, _, name_length = struct.unpack_from("=iIII", data, offset)
        name_start = offset + 16
        name = data[name_start:name_start + name_length].split(b"\0", 1)[0]
        if not name or name == target:
            return True
        offset = name_start + name_length
    return False


def main():
    os.makedirs(ARCHIVE_DIR, exist_ok=True)
    os.makedirs(os.path.join(ARCHIVE_DIR, "frames"), exist_ok=True)
    if WEBHOOK_URL:
        threading.Thread(target=webhook_sender, daemon=True).start()
    processed = load_state()
    records = read_records()
    archived_pages = load_manifest_pages(datetime.now().astimezone().strftime("%Y-%m-%d"))
    page_records = {}
    page_baselines = {}
    page_deadlines = {}

    def track_record(record, baseline=False):
        page_records[record["seq"]] = record
        page_baselines[record["seq"]] = baseline
        page_deadlines[record["seq"]] = time.time() + 600

    if processed is None:
        latest = records[-1] if records else None
        if latest:
            archive_record(latest, baseline=True)
            processed = latest["seq"]
            track_record(latest, baseline=True)
        else:
            processed = 0
    else:
        latest = next((record for record in reversed(records) if record.get("seq") == processed), None)
        if latest:
            track_record(latest)
    print(f"overlay archiver: state={STATE_DIR} dir={ARCHIVE_DIR}", flush=True)
    offset = 0
    last_stat = None
    def read_pending():
        nonlocal offset, last_stat, processed

        def read_pages():
            now = time.time()
            for seq, deadline in list(page_deadlines.items()):
                if now >= deadline:
                    page_deadlines.pop(seq, None)
                    page_records.pop(seq, None)
                    page_baselines.pop(seq, None)
                elif seq in page_records:
                    archive_pages(page_records[seq], archived_pages, deadline, page_baselines[seq])

        try:
            stat = os.stat(CHANGE_LOG)
            if last_stat is not None and (stat.st_ino != last_stat[0] or stat.st_size < last_stat[1]): offset = 0
            last_stat = (stat.st_ino, stat.st_size)
            with open(CHANGE_LOG, encoding="utf-8") as f:
                f.seek(offset)
                lines = f.readlines()
                offset = f.tell()
            for line in lines:
                try: record = json.loads(line)
                except ValueError: continue
                if record.get("seq", 0) > processed:
                    read_pages()
                    track_record(record)
                    processed = record["seq"]
                read_pages()
            read_pages()
        except OSError as error:
            print(f"overlay archiver: change log read failed: {error}", file=sys.stderr, flush=True)

    watch_fd = inotify_fd()
    if watch_fd is None:
        while True:
            read_pending()
            time.sleep(0.2)
    try:
        while True:
            ready, _, _ = select.select([watch_fd], [], [], 5.0)
            if not ready:
                read_pending()
                continue
            try:
                event_data = os.read(watch_fd, 65536)
            except OSError:
                continue
            if relevant_inotify_event(event_data):
                read_pending()
    finally:
        os.close(watch_fd)


if __name__ == "__main__":
    main()
