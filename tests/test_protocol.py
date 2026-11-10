import sys
from pathlib import Path
import unittest

BASE=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(BASE/"reference"))
from metadata_demo import State, encode, decode, sample_atlas, read_image, read_row, DATA_START_X, DATA_START_Y, CELL, NIBBLES
from validate_atlas import validate, mb_count, ATLAS, SCREEN, MAXFS_LEVEL_42, SOURCES, DESTINATIONS

class AtlasTests(unittest.TestCase):
    def test_geometry_exact(self):
        self.assertEqual(validate(),(8833,False))
        self.assertEqual(mb_count((1936,1136)),8591)

    def test_metadata_fits_in_reserved_rect(self):
        r=SOURCES["_DataSrcRect"]
        self.assertGreaterEqual(DATA_START_X,r.x)
        self.assertLessEqual(DATA_START_X+NIBBLES*CELL,r.x+r.w)
        self.assertGreaterEqual(DATA_START_Y,r.y)
        self.assertLessEqual(DATA_START_Y+3*CELL,r.y+r.h)

    def test_protocol_exact(self):
        s=State(sequence=1001,flags=8,opacity=198,lower_x=400,lower_y=500,timestamp=1794195000)
        packet=encode(s)
        self.assertEqual(len(packet),24)
        self.assertEqual(decode(packet),s)

    def test_crc_rejects_damage(self):
        b=bytearray(encode(State()))
        b[12]^=0x40
        with self.assertRaisesRegex(ValueError,"CRC mismatch"):
            decode(bytes(b))

    def test_png_decode(self):
        s=State(sequence=765,flags=1,lower_x=900,lower_y=10)
        self.assertEqual(read_image(sample_atlas(s)),s)

    def test_one_corrupt_row_fallback(self):
        s=State(sequence=999)
        im=sample_atlas(s)
        im.putpixel((DATA_START_X+CELL//2,DATA_START_Y+CELL//2),(16,22,33))
        self.assertEqual(read_image(im),s)
        with self.assertRaises(ValueError):
            read_row(im,0)

if __name__=="__main__":
    unittest.main()
