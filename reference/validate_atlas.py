"""Validate the user-supplied Atlas v8 rectangle and H.264 geometry contract.

Run: python tools/validate_atlas.py
"""
from dataclasses import dataclass
from math import ceil

ATLAS = (1936, 1168)
SCREEN = (1920, 1080)
MAXFS_LEVEL_42 = 8704

@dataclass(frozen=True)
class Rect:
    x: int
    y: int
    w: int
    h: int

    def uv(self, size):
        width, height = size
        return (self.x / width, 1 - (self.y + self.h) / height,
                self.w / width, self.h / height)

    def inside(self, size):
        width, height = size
        return self.x >= 0 and self.y >= 0 and self.w > 0 and self.h > 0 and self.x + self.w <= width and self.y + self.h <= height

    def overlaps(self, other):
        return (self.x < other.x + other.w and self.x + self.w > other.x
                and self.y < other.y + other.h and self.y + self.h > other.y)

SOURCES = {
    "_TopSrcRect": Rect(0, 0, 1920, 158),
    "_LeftSrcRect": Rect(0, 174, 281, 922),
    "_EewSrcRect": Rect(11, 174, 258, 922),
    "_LowerAlphaSrcRect": Rect(297, 174, 1639, 461),
    "_LowerRgbSrcRect": Rect(297, 651, 1639, 461),
    "_DataSrcRect": Rect(0, 1128, 1936, 30),
}

DESTINATIONS = {
    "MainVideoL": Rect(281, 158, 1639, 922),
    "Top": Rect(0, 0, 1920, 158),
    "Left": Rect(0, 158, 281, 922),
    "EEW": Rect(11, 158, 258, 922),
    "LowerDefault": Rect(281, 619, 1639, 461),
}

# ShaderLab vector constants from the user's v8 message.
SOURCE_UVS = {
    "_TopSrcRect": (0.0, 0.864726027, 0.991735537, 0.135273973),
    "_LeftSrcRect": (0.0, 0.061643836, 0.145144628, 0.789383562),
    "_EewSrcRect": (0.005681818, 0.061643836, 0.133264463, 0.789383562),
    "_LowerAlphaSrcRect": (0.153409091, 0.456335616, 0.846590909, 0.394691781),
    "_LowerRgbSrcRect": (0.153409091, 0.047945205, 0.846590909, 0.394691781),
    "_DataSrcRect": (0.0, 0.008561644, 1.0, 0.025684932),
}


def mb_count(size):
    return ceil(size[0] / 16) * ceil(size[1] / 16)


def validate():
    for k, rect in SOURCES.items():
        assert rect.inside(ATLAS), (k, rect)
        assert all(abs(a-b)<1e-8 for a,b in zip(rect.uv(ATLAS),SOURCE_UVS[k])), k
    for k, rect in DESTINATIONS.items():
        assert rect.inside(SCREEN), (k, rect)

    # EEW is deliberately a subrect of Left. All other unique storage areas are separated.
    for a, ra in SOURCES.items():
        for b, rb in SOURCES.items():
            if a >= b: continue
            if "_EewSrcRect" in (a,b) and "_LeftSrcRect" in (a,b):
                continue
            assert not ra.overlaps(rb), (a,b)

    n=mb_count(ATLAS)
    return n, n<=MAXFS_LEVEL_42


if __name__ == "__main__":
    blocks, fits=validate()
    print(f"Atlas {ATLAS[0]}x{ATLAS[1]}: {blocks} MB/frame; Level 4.2 max: {MAXFS_LEVEL_42}; fits={fits}")
    for name, rect in SOURCES.items():
        print(name, rect, "uv", tuple(round(x,9) for x in rect.uv(ATLAS)))
