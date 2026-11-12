# Loopback WebRTC/WHEP measurement and reconnect evidence — 2026-11-12

Test setup: MediaMTX v1.21.3 running on loopback, the test-mode Atlas service publishing H.264 to RTSP, and Chrome receiving `http://127.0.0.1:8889/bosai/whep`. The downloaded Windows AMD64 release archive was checked against the GitHub release asset SHA-256 before execution. The test API was loopback-only; live JMA/P2P sources were disabled.

## Continuous receive

A real Chrome WHEP session ran for 60 seconds. It received 1936×1168 frames at a measured 23.8 FPS, average interval 42.0 ms, maximum 83.4 ms, p95 66.7 ms. The browser counted 35 presented-frame drops. A2 packet verification passed 30/30 samples (100%); there were no duplicate or out-of-order A2 timestamps, no out-of-order sequences, and no malformed headers. The sender and MediaMTX remained running with zero automatic restarts. See `whep-live-60s-2026-11-12.json`.

This measured receive rate is below the 30 FPS target. The test does not claim a speed improvement or production/WAN/Quest performance.

## Disconnect, held frame, and recovery

The loopback-only test API stopped MediaMTX while Chrome was receiving. The UI showed the last valid frame in its canvas at 1936×1168. A frame sampled from the frozen video element and the held canvas had the same FNV-1a checksum (`0a4b8f12`), proving that the displayed frame content was preserved. After MediaMTX and the RTSP publisher returned, the same tab used the reconnect control and returned to a valid WHEP frame in 3942 ms. The held canvas was hidden after recovery, the A2 verdict returned to normal, and the next CRC check passed. Full data is in `whep-reconnect-2026-11-12.json`; the held-frame screenshot is `whep-last-valid-2026-11-12.png`.

## Metrics sidecar failure found and fixed

An earlier outage run exposed Windows `PermissionError`/`EPERM` while replacing the JSON metrics sidecars. Those unhandled telemetry write errors terminated the renderer and A2 sender, causing a real stream interruption. The metrics writer now retries transient replacement locks and reports a persistent sidecar failure without raising into the render/send loop. The new regressions in `tests/test_render_atlas.py` cover retry, persistent failure, and continued stage recording. The updated 60-second receive/reconnect runs produced no metrics replacement errors. Intentional MediaMTX stops still cause the RTSP publisher process to restart; that behavior is part of the tested recovery path.
