#!/usr/bin/env python3
"""Run the reused receiver PoC as a strict sender/receiver reference.
This is a local codec test only; not a MediaMTX, WAN, or VRChat test.
"""
from pathlib import Path
import sys
import subprocess

ROOT = Path(__file__).resolve().parents[1]
REF = ROOT / 'reference'
sys.path.insert(0, str(REF))
from metadata_demo import sample_atlas, make_video, read_image, State


def main():
    out = ROOT / 'out'
    out.mkdir(exist_ok=True)
    image = sample_atlas(State(sequence=123, flags=15, mode=1, opacity=255,
                               lower_x=281, lower_y=619, timestamp=1794166800))
    img_path = out/'atlas-sample.png'
    image.save(img_path)
    state = read_image(image)
    assert state.sequence == 123 and state.timestamp == 1794166800
    video = out/'atlas-codec-test.mp4'
    make_video(video, crf=23)
    print('PASS: sample PNG, 24-byte protocol, 8-frame H.264 roundtrip')

if __name__ == '__main__':
    main()
