import pathlib, struct, sys, unittest, zlib
ROOT=pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'reference'))
from metadata_demo import State, encode, decode, nibble_to_color, color_to_nibble, sample_atlas, read_image

class BackendContract(unittest.TestCase):
    def test_header_layout_and_crc(self):
        state=State(sequence=0x12345678,flags=0x0f,mode=1,opacity=251,lower_x=281,lower_y=619,timestamp=1794166800)
        packet=encode(state)
        self.assertEqual(len(packet),24)
        self.assertEqual(packet[:4],b'V8\x01\x18')
        self.assertEqual(packet[4:8],b'\x78\x56\x34\x12')
        self.assertEqual(struct.unpack_from('<H',packet,12)[0],281)
        self.assertEqual(struct.unpack_from('<H',packet,14)[0],619)
        self.assertEqual(struct.unpack_from('<I',packet,20)[0],zlib.crc32(packet[:20]))
        self.assertEqual(decode(packet),state)

    def test_three_rows_and_single_damage(self):
        im=sample_atlas(State(timestamp=1794166800))
        self.assertEqual(read_image(im).timestamp,1794166800)
        im.putpixel((12,1135),(0,0,0))  # One copy only; other rows remain valid.
        self.assertEqual(read_image(im).timestamp,1794166800)

    def test_cell_palette(self):
        for nibble in range(16):
            self.assertEqual(color_to_nibble(nibble_to_color(nibble)), nibble)

    def test_data_band_bounds(self):
        x0,y0 = 8,1131
        x1 = x0 + 48*8
        y1 = y0 + 3*8
        self.assertTrue(0 <= x0 < x1 <= 1936)
        self.assertTrue(1128 <= y0 < y1 <= 1158)

if __name__=='__main__':unittest.main()
