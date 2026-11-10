# Proposed Metadata Protocol v1 (draft)

> Retired historical draft. It is not used by the A2 sender or current receiver contract; see `atlas-ii.md` for the active wire format.

This is a **new proposal**, not part of the existing atlas v8 contract. Sender and receiver must agree on the exact same version.

## Grid allocation

- Atlas data reserve: `(x=0, y=1128, w=1936, h=30)` in top-left-origin pixels.
- Each cell is an 8x8 RGB block. Encoding follows Kamishiro's 2021 two-bits each in R and G, B=255 for an occupied cell.
- Use three copies of the **same independent 24-byte state packet**, one per row. Each copy uses 48 cells.
- Data-cell origin for copy `row` and nibble `col`:
  `x = 8 + col*8`, `y = 1131 + row*8` (row=0,1,2; col=0..47). Center pixel `(x+4, y+4)`.
- RGB encoding: `R=(nibble&3)*85`, `G=(nibble>>2)*85`, `B=255`, 8-bit full range. Each byte is transmitted HIGH nibble first then LOW nibble.
- The grid leaves left/right and top/bottom safety margins. The 3 copies are meant for failover or majority vote; independent row CRCs are simpler to implement first.
- R/G samples must be interpreted in the appropriate transfer function (Gamma vs Linear). Perform a receiver calibration test and decide whether `.gamma` conversion is needed in Unity. Do not assume shader sampler values map directly to 0..255 channel values.

## 24-byte packet (little-endian fields unless noted)

| Offset | Size | Meaning |
|---|---:|---|
| 0 | 2 | Magic ASCII `V8` |
| 2 | 1 | Version `1` |
| 3 | 1 | Total packet length `24` |
| 4 | 4 | `sequence` unsigned integer |
| 8 | 1 | Flags bit0 LActive, bit1 TopVisible, bit2 LeftVisible, bit3 LowerVisible |
| 9 | 1 | Mode / reserve for future layouts |
| 10 | 1 | LowerOpacity (0..255) |
| 11 | 1 | Reserved (0) |
| 12 | 2 | LowerDestX: pixels from screen's left side |
| 14 | 2 | LowerDestY: pixels from screen's top side |
| 16 | 4 | Unix timestamp seconds (0 if unset) |
| 20 | 4 | CRC32/IEEE of bytes [0:20] |

`_LowerDestRect` can be derived as `(x/1920, 1-(y+461)/1080, 1639/1920, 461/1080)` when fixed-size lower overlay is used. Changes to size require a separate protocol update.

## Receiver policy

1. Read all three rows from the correct frame. Decode each to a 24-byte packet, validate magic/version/length and CRC32.
2. Prefer a valid packet with newest sequence. Ignore invalid payloads. Prefer identical valid copies when several pass.
3. Keep last known valid state temporarily on a missing frame; if age exceeds a configured limit, show a visible `更新停止` indicator instead of silently pretending the information is fresh.
4. Reset behavior on video change, stream interruption, or packet-version mismatch explicitly.
5. Tune polling from ~2–5 Hz initially for CPU readback. Shader-only rendering may read every displayed video frame. Measure actual timing in VRChat Build & Test.
6. Confirm packet semantics before tying it to real tsunami/earthquake alert decisions. Do not infer safety severity from bit patterns.

## Rationale

Three copies use 3*48=144 cells (12×? actually 3 rows × 48 columns), much less than the reserved 3*240=720 possible 8x8 cells. It favors simple, robust state control over bulk arbitrary data transmission.
