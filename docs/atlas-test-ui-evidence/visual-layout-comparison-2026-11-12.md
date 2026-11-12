# Atlas renderer baseline comparison

Compared the renderer at the goal start SHA `7253779d27311c7c02756475fa0134096e9a73bc` with the current renderer using Chrome 156.0.8078.80 and identical 1936×1168 snapshots. CSS animation was disabled for both screenshots to make the comparison deterministic. Both snapshots use `testMode: false`, which excludes the intentionally added test warning.

For the tsunami warning fixture from `tests/samples/32-39_11_02_250206_VTSE41.xml`, the screenshots differ in 13,609 pixels, all inside the left mini-map bounds `(25, 892)–(257, 1082)`. Outside that rectangle, the pixel diff is zero. The left mini-map is visible in the current screenshot because the live renderer now sets `display: block` when its existing visibility condition is true; the baseline left it hidden by the stylesheet's `display: none`. This is the intended behavior change. The right-side map, tables, header, and remaining canvas match pixel-for-pixel in this fixture.

For the JMA EEW fixture from `tests/samples/37_01_01_240613_VXSE43.xml`, baseline and current screenshots are pixel-identical (0 differing pixels). The horizontal EEW box occupies the same `(574.5, 747, 803, 268)` CSS-pixel rectangle in both.

Artifacts:

- `visual-baseline/before.png` — goal-start renderer
- `visual-baseline/after.png` — current renderer
- `visual-baseline/state.json` — shared test snapshot
- `visual-baseline/before-eew.png` / `visual-baseline/after-eew.png` — identical EEW baseline/current captures
- `visual-baseline/state-eew.json` — shared EEW test snapshot
- `visual-baseline/pixel-diff.json` — measured pixel difference

Reproduce with `node tools/capture_atlas.js --state <state.json> --html <goal-start-atlas-1080.html> --freeze-animations --output <before.png>` and `node tools/capture_atlas.js --state <state.json> --freeze-animations --output <after.png>`. Retrieve the baseline HTML from the recorded start SHA. This comparison covers tsunami warning and horizontal EEW layouts; it does not compare every event/layout combination or Quest/AVPro rendering.
