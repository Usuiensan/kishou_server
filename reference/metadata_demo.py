#!/usr/bin/env python3
"""Atlas v8 public display-metadata proof of concept.

Not an actual Unity SDK implementation. Requires Pillow; ffmpeg for --video.
Examples:
  python tools/metadata_demo.py --output out/sample_atlas.png
  python tools/metadata_demo.py --roundtrip out/sample_atlas.png
  python tools/metadata_demo.py --video out/atlas_test.mp4
"""
import argparse
import binascii
from dataclasses import dataclass
from pathlib import Path
import struct
import subprocess
import tempfile
import zlib

from PIL import Image, ImageDraw

from validate_atlas import ATLAS, SOURCES

MAGIC = b"V8"
VERSION = 1
LENGTH = 24
DATA_START_X = 8
DATA_START_Y = 1131
CELL = 8
REPETITIONS = 3
NIBBLES = LENGTH * 2

@dataclass(frozen=True)
class State:
    sequence: int = 42
    flags: int = 15  # L/top/left/lower enabled
    mode: int = 1
    opacity: int = 255
    lower_x: int = 281
    lower_y: int = 619
    timestamp: int = 0


def encode(state: State) -> bytes:
    body=struct.pack("<2sBBIBBBBHHI", MAGIC, VERSION, LENGTH,
                     state.sequence, state.flags, state.mode, state.opacity, 0,
                     state.lower_x, state.lower_y, state.timestamp)
    assert len(body)==20
    return body+struct.pack("<I", zlib.crc32(body))


def decode(data: bytes) -> State:
    if len(data)!=LENGTH:
        raise ValueError("wrong payload length")
    if data[:2]!=MAGIC or data[2]!=VERSION or data[3]!=LENGTH:
        raise ValueError("invalid magic/version/length")
    expected=struct.unpack_from("<I",data,20)[0]
    actual=zlib.crc32(data[:20])
    if expected!=actual:
        raise ValueError(f"CRC mismatch: expected={expected:08x}, calculated={actual:08x}")
    magic,ver,length,seq,flags,mode,opacity,reserved,x,y,ts=struct.unpack("<2sBBIBBBBHHI",data[:20])
    if reserved!=0:
        raise ValueError("reserved byte must be 0")
    return State(seq,flags,mode,opacity,x,y,ts)


def nibble_to_color(n: int):
    assert 0<=n<=15
    return ((n&3)*85, (n>>2)*85, 255)


def color_to_nibble(rgb):
    r,g,_b=rgb[:3]
    low=max(0,min(3,round(r/85)))
    high=max(0,min(3,round(g/85)))
    return (high<<2)|low


def paint_packet(image: Image.Image, packet: bytes):
    assert len(packet)==LENGTH
    painter=ImageDraw.Draw(image)
    nibbles=[]
    for b in packet:
        nibbles.extend((b>>4,b&15))
    for row in range(REPETITIONS):
        for col,n in enumerate(nibbles):
            x=DATA_START_X+col*CELL
            y=DATA_START_Y+row*CELL
            painter.rectangle((x,y,x+CELL-1,y+CELL-1),fill=nibble_to_color(n))
    return image


def read_row(image: Image.Image, row: int) -> State:
    if image.size!=ATLAS:
        raise ValueError(f"Wrong image size {image.size} expected {ATLAS}")
    nibbles=[]
    for col in range(NIBBLES):
        x=DATA_START_X+col*CELL+CELL//2
        y=DATA_START_Y+row*CELL+CELL//2
        nibbles.append(color_to_nibble(image.getpixel((x,y))))
    packet=bytes((nibbles[i]<<4)|nibbles[i+1] for i in range(0,len(nibbles),2))
    return decode(packet)


def read_image(image: Image.Image) -> State:
    valid=[]
    errors=[]
    for row in range(REPETITIONS):
        try:
            valid.append(read_row(image,row))
        except ValueError as exc:
            errors.append(f"row {row}: {exc}")
    if not valid:
        raise ValueError("No valid packet copies. "+ "; ".join(errors))
    # Protect against accidental row disagreement; all copies on this demo must match.
    if any(v!=valid[0] for v in valid):
        raise ValueError("multiple valid copies have different content")
    return valid[0]


def sample_atlas(state=State()):
    image=Image.new("RGB",ATLAS,(16,17,20))
    p=ImageDraw.Draw(image)
    palette={
        "_TopSrcRect":"#344b7a",
        "_LeftSrcRect":"#294b44",
        "_EewSrcRect":"#d26f25",
        "_LowerAlphaSrcRect":"#838383",
        "_LowerRgbSrcRect":"#316fa9",
        "_DataSrcRect":"#000000",
    }
    for name,rect in SOURCES.items():
        p.rectangle((rect.x,rect.y,rect.x+rect.w-1,rect.y+rect.h-1),fill=palette[name])
    p.text((40,40),"Top band",fill="white")
    p.text((325,700),"Lower RGB",fill="white")
    paint_packet(image,encode(state))
    return image


def make_video(path:Path, crf:int=23):
    path.parent.mkdir(parents=True,exist_ok=True)
    with tempfile.TemporaryDirectory() as folder:
        folder=Path(folder)
        for i in range(8):
            sample_atlas(State(sequence=100+i,flags=(15 if i%2 else 7))).save(folder/f"frame_{i:03d}.png")
        cmd=["ffmpeg","-hide_banner","-loglevel","error","-y",
             "-framerate","4","-i",str(folder/"frame_%03d.png"),
             "-c:v","libx264","-preset","fast","-crf",str(crf),
             "-pix_fmt","yuv420p","-level:v","5.0","-movflags","+faststart",str(path)]
        subprocess.run(cmd,check=True)
        decoded=folder/"decoded"
        decoded.mkdir()
        subprocess.run(["ffmpeg","-hide_banner","-loglevel","error","-y",
                        "-i",str(path),str(decoded/"frame_%03d.png")],check=True)
        got=sorted(decoded.glob("frame_*.png"))
        if len(got)!=8:
            raise AssertionError(f"Unexpected decoded frame count {len(got)}")
        for i,frame in enumerate(got):
            with Image.open(frame) as image:
                rec=read_image(image)
                expected=State(sequence=100+i,flags=(15 if i%2 else 7))
                if rec!=expected:
                    raise AssertionError(f"Frame {i} mismatch: {rec} vs {expected}")
        print(f"PASS: {len(got)} decoded H.264 frames, CRC and state exact, CRF={crf}; output={path}")


def main():
    a=argparse.ArgumentParser()
    a.add_argument("--output",type=Path,help="Write static test atlas PNG")
    a.add_argument("--roundtrip",type=Path,help="Decode existing test atlas PNG")
    a.add_argument("--video",type=Path,help="Produce H.264 test video and verify every decoded frame")
    a.add_argument("--crf",type=int,default=23)
    args=a.parse_args()
    if args.output:
        args.output.parent.mkdir(parents=True,exist_ok=True)
        sample_atlas().save(args.output)
        print("Created",args.output)
    if args.roundtrip:
        with Image.open(args.roundtrip) as im:
            print("Decoded:",read_image(im))
    if args.video:
        make_video(args.video,args.crf)
    if not any((args.output,args.roundtrip,args.video)):
        a.print_help()

if __name__=="__main__":
    main()
