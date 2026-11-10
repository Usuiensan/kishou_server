"""Cross-repository tests for Atlas II colour32 v2 reference wire.

Run from repository root: python -m unittest discover -s tests -p 'test_atlas_ii_wire.py'
"""
import json
import struct
import sys
import unittest
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "protocol"))
from atlas_ii_reference import (  # noqa: E402
    HEADER, WireError, parse_packet, bytes_to_symbols, symbols_to_bytes
)


class AtlasIIWireTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.vectors = json.loads((ROOT / "protocol" / "atlas-ii-vectors.json").read_text("utf-8"))["vectors"]
        cls.zones = json.loads((ROOT / "protocol" / "atlas-ii-tsunami-areas-v1.json").read_text("utf-8"))["zones"]
        cls.eew_zones = json.loads((ROOT / "protocol" / "atlas-ii-eew-areas-v1.json").read_text("utf-8"))["zones"]

    def test_header_is_28_bytes(self):
        self.assertEqual(HEADER.size, 28)

    def test_tsunami_zone_map_is_exact_and_stable(self):
        self.assertEqual(len(self.zones), 66)
        self.assertEqual([v["index"] for v in self.zones], list(range(66)))
        codes = [v["code"] for v in self.zones]
        self.assertEqual(codes, sorted(set(codes)))
        self.assertEqual(self.zones[0]["code"], 100)
        self.assertEqual(self.zones[-1]["code"], 802)

    def test_eew_area_map_is_exact_and_unique(self):
        self.assertEqual(len(self.eew_zones), 188)
        ids = [area["areaId"] for area in self.eew_zones]
        names = [area["name"] for area in self.eew_zones]
        self.assertEqual(ids, sorted(set(ids)))
        self.assertEqual(len(names), len(set(names)))
        self.assertTrue(all(area["pref"] and area["name"] for area in self.eew_zones))

    def test_vectors_roundtrip_and_expected_layout(self):
        for item in self.vectors:
            with self.subTest(name=item["name"]):
                packet = bytes.fromhex(item["hex"])
                self.assertEqual(len(packet), item["byteLength"])
                symbols = bytes_to_symbols(packet)
                self.assertEqual(symbols, item["symbols"])
                self.assertEqual(len(symbols), item["symbolCount"])
                self.assertEqual(symbols_to_bytes(symbols, len(packet)), packet)
                self.assertEqual(zlib.crc32(packet[:-4]), int(item["crc32_hex"], 16))
                size = (item["expect"]["atlasWidth"], item["expect"]["atlasHeight"])
                decoded = parse_packet(packet, actual_atlas_size=size)
                self.assertEqual(decoded["sequence"], item["expect"]["sequence"])
                self.assertEqual(decoded["timestampMs"], int(item["expect"]["tsUnixMs"]))
                self.assertEqual(len(decoded["rects"]), item["expect"]["rectCount"])
                columns = (size[0] - 16) // 8
                self.assertEqual(decoded["usedRows"], (len(symbols) + columns - 1) // columns)

    def test_eew_warning_and_followup_and_tsunami(self):
        data = parse_packet(bytes.fromhex(self.vectors[1]["hex"]))
        record = data["eewEvents"][0]["areas"][0]
        self.assertEqual(record, {
            "areaId": 291, "scalePair": 0x76, "areaFlags": 0x0D,
            "arrivalOffsetSeconds": 12,
        })
        self.assertEqual(data["displayFlags"], 11)
        for code, severity in [(100, 1), (220, 2), (380, 3)]:
            idx = next(v["index"] for v in self.zones if v["code"] == code)
            self.assertEqual(data["tsunamiSeverity"][idx], severity)
        self.assertEqual(sum(x != 0 for x in data["tsunamiSeverity"]), 3)

    @staticmethod
    def _rewrite_crc(packet):
        packet[-4:] = struct.pack("<I", zlib.crc32(packet[:-4]))
        return bytes(packet)

    def test_corrupted_crc_is_rejected(self):
        packet = bytearray.fromhex(self.vectors[1]["hex"])
        packet[25] ^= 0x01
        with self.assertRaisesRegex(WireError, "CRC"):
            parse_packet(packet)

    def test_future_version_is_rejected_even_with_valid_crc(self):
        packet = bytearray.fromhex(self.vectors[0]["hex"])
        packet[2] = 99
        with self.assertRaisesRegex(WireError, "version"):
            parse_packet(self._rewrite_crc(packet))

    def test_actual_video_resolution_must_agree(self):
        packet = bytes.fromhex(self.vectors[0]["hex"])
        with self.assertRaisesRegex(WireError, "API size"):
            parse_packet(packet, actual_atlas_size=(1936, 1168))

    def test_bootstrap_capacity_is_bounded(self):
        packet = bytearray(201)
        struct.pack_into("<2sBBHIQHHHHBB", packet, 0,
                         b"A2", 2, 0, 201, 0, 0, 640, 32, 1920, 1080, 0, 0)
        struct.pack_into("<I", packet, 197, zlib.crc32(packet[:197]))
        with self.assertRaisesRegex(WireError, "overflows"):
            parse_packet(self._rewrite_crc(packet))

    def test_unknown_tsunami_reserved_bits_are_rejected(self):
        packet = bytearray.fromhex(self.vectors[1]["hex"])
        packet[28 + 18 + 2 + 16] |= 0x10
        with self.assertRaisesRegex(WireError, "tsunami padding"):
            parse_packet(self._rewrite_crc(packet))

    def test_new_region_requires_warning_target(self):
        packet = bytearray.fromhex(self.vectors[1]["hex"])
        signature = bytes.fromhex("2301760d0c00")
        index = packet.find(signature)
        self.assertGreater(index, 0)
        packet[index + 3] = 0x09  # newlyAdded=1, warningTarget=0
        with self.assertRaisesRegex(WireError, "newlyAdded without warningTarget"):
            parse_packet(self._rewrite_crc(packet))

    def test_unknown_eew_area_map_version_is_rejected(self):
        packet = bytearray.fromhex(self.vectors[1]["hex"])
        packet[28 + 18 + 2 + 17 + 1] = 99
        with self.assertRaisesRegex(WireError, "mapping version"):
            parse_packet(self._rewrite_crc(packet))

    def test_atlas_src_must_not_intersect_data_band(self):
        packet = bytearray.fromhex(self.vectors[1]["hex"])
        struct.pack_into("<H", packet, 28 + 2 + 2, 680)  # rect src.y
        struct.pack_into("<H", packet, 28 + 2 + 6, 40)   # rect src.h
        with self.assertRaisesRegex(WireError, "overlaps data cells"):
            parse_packet(self._rewrite_crc(packet))

    def test_extra_symbol_padding_must_be_zero(self):
        item = self.vectors[0]
        symbols = item["symbols"].copy()
        symbols[-1] ^= 1 << 4  # 32 B = 256 bits; last symbol has 1 data bit
        with self.assertRaisesRegex(WireError, "pad bits"):
            symbols_to_bytes(symbols, item["byteLength"])


if __name__ == "__main__":
    unittest.main()
