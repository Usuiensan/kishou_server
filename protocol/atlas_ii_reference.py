"""Reference (non-production) Atlas II colour32 wire v2 decoder.

Pure Python stdlib. Use for shared test vectors, NOT as a replacement for
VRChat/UdonSharp runtime validation. Area-ID identity requires a separately
verified JMA mapping table; this decoder validates the wire, not that table.
"""
from __future__ import annotations

import struct
import zlib

HEADER = struct.Struct("<2sBBHIQHHHHBB")
AREA = struct.Struct("<HBBh")
EVENT = struct.Struct("<BIHBHB")
SCALE_FROM_MAX = 10
SCALE_TO_MAX = 11


class WireError(ValueError):
    pass


def require(ok, message):
    if not ok:
        raise WireError(message)


def bytes_to_symbols(payload: bytes) -> list[int]:
    """LSB-first bitstream; each cell is one unsigned 5-bit symbol."""
    return [
        sum(
            ((payload[k // 8] >> (k % 8)) & 1) << j
            for j in range(5)
            for k in (start + j,)
            if k < len(payload) * 8
        )
        for start in range(0, len(payload) * 8, 5)
    ]


def symbols_to_bytes(symbols: list[int], byte_length: int) -> bytes:
    require(byte_length >= 0, "invalid byte length")
    count = (byte_length * 8 + 4) // 5
    require(len(symbols) == count, "symbol count mismatch")
    require(all(type(x) is int and 0 <= x <= 31 for x in symbols), "bad symbol")
    data = bytearray(byte_length)
    for i in range(byte_length * 8):
        data[i // 8] |= ((symbols[i // 5] >> (i % 5)) & 1) << (i % 8)
    for i in range(byte_length * 8, len(symbols) * 5):
        require((symbols[i // 5] >> (i % 5)) & 1 == 0, "nonzero pad bits")
    return bytes(data)


def _rect_intersects(a, b):
    x, y, w, h = a
    X, Y, W, H = b
    return x < X + W and X < x + w and y < Y + H and Y < y + h


def parse_packet(raw: bytes, *, actual_atlas_size=None, actual_main_size=None) -> dict:
    """Strict wire parser. Optional actual sizes are trusted from the players.

    MAIN_VIDEO requires actual_main_size for src bounds checking.
    """
    data = bytes(raw)
    require(len(data) >= 32, "short packet")
    magic, version, mask, length, seq, ts_ms, width, height, ow, oh, count, reserved = HEADER.unpack_from(data)
    require(magic == b"A2" and version == 2, "magic/version mismatch")
    require(mask & ~7 == 0 and reserved == 0, "unknown header flags")
    require(length == len(data) and length <= 65535, "length mismatch")
    require(count <= 15, "too many rects")
    require(width >= 640 and width % 16 == 0 and height >= 32 and height % 16 == 0, "invalid atlas size")
    require(ow > 0 and oh > 0, "invalid output size")
    if actual_atlas_size is not None:
        require(tuple(actual_atlas_size) == (width, height), "atlas API size mismatch")
    columns, maxrows = (width - 16) // 8, (height - 16) // 8
    cell_count = (length * 8 + 4) // 5
    used_rows = (cell_count + columns - 1) // columns
    require(columns >= 45 and used_rows <= maxrows, "data overflows atlas")
    received_crc = struct.unpack_from("<I", data, length - 4)[0]
    require(received_crc == zlib.crc32(data[:-4]), "CRC32 mismatch")
    limit = length - 4
    pos = 28

    def need(n):
        require(pos + n <= limit, "truncated section")

    def check_src(rect, dimensions, label):
        x, y, w, h = rect
        require(w > 0 and h > 0 and x + w <= dimensions[0] and y + h <= dimensions[1],
                label + " is outside texture")

    rects = []
    data_strips = []
    for row in range(used_rows):
        cells_in_row = min(columns, cell_count - row * columns)
        data_strips.append((8, height - 16 - row * 8, cells_in_row * 8, 8))
    for _ in range(count):
        need(18)
        ctl, opacity, *coords = struct.unpack_from("<BB8H", data, pos)
        size = 26 if ctl & 2 else 18
        need(size)
        require((ctl & ~7) == 0, "invalid rect control")
        source = ctl & 1
        src = tuple(coords[:4])
        dst = tuple(coords[4:8])
        alpha = struct.unpack_from("<4H", data, pos + 18) if ctl & 2 else None
        require(dst[2] > 0 and dst[3] > 0 and dst[0] + dst[2] <= ow and dst[1] + dst[3] <= oh,
                "dst outside output")
        dims = (width, height) if source == 0 else actual_main_size
        require(dims is not None, "MAIN_VIDEO dimensions required")
        check_src(src, dims, "src")
        if alpha is not None:
            check_src(alpha, dims, "alphaSrc")
        if source == 0:
            for region in (src, alpha):
                if region is not None:
                    require(not any(_rect_intersects(region, strip) for strip in data_strips),
                            "ATLAS Rect overlaps data cells")
        rects.append({"control": ctl, "opacity": opacity, "src": src, "dst": dst, "alphaSrc": alpha})
        pos += size
    display = 0
    if mask & 1:
        need(2)
        display = struct.unpack_from("<H", data, pos)[0]
        require(display & ~31 == 0, "unknown display flags")
        pos += 2
    tsunami = [0] * 66
    if mask & 2:
        need(17)
        t = data[pos:pos + 17]
        require(t[16] & 0xF0 == 0, "unknown tsunami padding")
        tsunami = [(t[i // 4] >> ((i % 4) * 2)) & 3 for i in range(66)]
        pos += 17
    events = []
    if mask & 4:
        need(3)
        ver, mapping, event_count = struct.unpack_from("<BBB", data, pos)
        require(ver == 1 and mapping == 1, "EEW section/mapping version mismatch")
        pos += 3
        ids = set()
        for _ in range(event_count):
            need(EVENT.size)
            flags, issue, serial, scale, area_count, idlen = EVENT.unpack_from(data, pos)
            pos += EVENT.size
            require(flags & ~15 == 0, "unknown event flags")
            require((scale & 15) <= SCALE_FROM_MAX and (scale >> 4) <= SCALE_TO_MAX,
                    "bad max scale")
            need(idlen)
            try:
                eid = data[pos:pos + idlen].decode("utf-8", errors="strict")
            except UnicodeDecodeError as exc:
                raise WireError("bad UTF-8 event id") from exc
            require(idlen > 0 and eid not in ids, "duplicate/empty event id")
            ids.add(eid)
            pos += idlen
            require(not (flags & 1) or area_count == 0, "cancelled event has areas")
            records = []
            previous_id = -1
            for _ in range(area_count):
                need(AREA.size)
                area_id, scale_byte, aflags, delta = AREA.unpack_from(data, pos)
                pos += AREA.size
                require(area_id > previous_id, "EEW area IDs not sorted and unique")
                previous_id = area_id
                require((scale_byte & 15) <= SCALE_FROM_MAX and (scale_byte >> 4) <= SCALE_TO_MAX,
                        "invalid area scale")
                require(aflags & ~15 == 0, "unknown area bits")
                require(not (aflags & 8) or (aflags & 4), "newlyAdded without warningTarget")
                require((flags & 8) or not (aflags & 8), "newlyAdded without comparable history")
                records.append({"areaId": area_id, "scalePair": scale_byte,
                                "areaFlags": aflags, "arrivalOffsetSeconds": delta})
            events.append({"eventId": eid, "eventFlags": flags, "issueUnixSeconds": issue,
                           "serial": serial, "maxScalePair": scale, "areas": records})
    require(pos == limit, "trailing/unknown payload bytes")
    return {"sequence": seq, "timestampMs": ts_ms, "atlas": (width, height),
            "output": (ow, oh), "rects": rects, "displayFlags": display,
            "tsunamiSeverity": tsunami, "eewEvents": events, "usedRows": used_rows}
