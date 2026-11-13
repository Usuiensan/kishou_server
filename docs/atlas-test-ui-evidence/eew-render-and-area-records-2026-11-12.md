# EEW AreaRecord and Renderer evidence — 2026-11-12

All inputs below used `testMode`; no live JMA/P2P input was enabled.

## AreaRecord values and rendered Atlas

The test event covered four JMA areas: an arrival estimate at +5 seconds, already arrived, PLUM with no time, and unknown arrival/scale with the upper scale marked `以上`. `atlasII.wire_state` encoded the snapshot into a 133-byte Atlas II v2 packet. The shared reference decoder accepted its CRC and reproduced all four AreaRecords exactly. See `eew-area-records-roundtrip-2026-11-12.json`.

The reproducible input is `eew-area-records-state-2026-11-12.json`. Chrome 156 rendered this snapshot at 1936×1168 with the horizontal EEW component visible and no browser errors; `eew-area-records-render-2026-11-12.png` is the capture. The raster shows warning target areas. Arrival-kind, arrival-offset, and upper-scale fields are packet metadata and are verified in the decoded records rather than printed into the legacy telop.

## Concurrent events, layout transition, and follow-up

The browser loaded two concurrent EEW events from `eew-two-events-state-2026-11-12.json`. The current renderer displayed the newest event. Applying the L-layout control produced both horizontal and vertical components during the one-second transition; after 1.15 seconds only the vertical component remained. A second report from `eew-followup-state-2026-11-12.json` added Chiba northwestern area; the horizontal renderer added four `blink-new` map paths. Browser state and counts are in `eew-render-states-2026-11-12.json`.

Captures: `eew-horizontal-two-events-2026-11-12.png`, `eew-reverse-l-transition-2026-11-12.png`, `eew-reverse-l-vertical-2026-11-12.png`, and `eew-followup-blink-2026-11-12.png`.

These captures verify the desktop Chromium renderer with synthetic test events. They are not VRChat, Quest, AVPro, or WAN results.
