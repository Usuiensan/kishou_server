# Loopback RTSP stage measurements

Date: 2026-11-12  
Input: test-mode JMA XML fixtures and P2P code 556 fixture  
Transport: MediaMTX v1.21.3, RTSP/TCP, loopback  
Capture: 15 seconds, one recorder, 4 FPS A2 validation sampling

## Results

| Stage | Measured FPS | Interval average / max / p95 (ms) | Work duration average / max / p95 (ms) |
|---|---:|---:|---:|
| Chromium screenshot capture | 8.95 | 111.68 / 149.71 / 133.88 | 80.84 / 121.47 / 100.82 |
| PNG decode, RGB conversion, atomic write | 0.98 changed frames/s | 1023.84 / 2234 / 2234 | 53.87 / 67.47 / 64.64 |
| A2 packet encode | 29.71 | 33.66 / 78 / 47 | 0.16 / 0.40 / 0.26 |
| Atlas symbol paint | 29.67 | 33.71 / 78 / 47 | 5.33 / 10.89 / 8.98 |
| FFmpeg raw-frame pipe write | 29.72 | 33.65 / 110 / 47 | 6.39 / 64.64 / 9.89 |
| FFmpeg H.264 encode progress | 27.71 | — | speed 0.926x |

Chromium capture produced 90 samples and 19 changed frames. PNG conversion runs only for changed captures, so its 0.98 figure is the changed-frame output rate, not the encoder's sustainable FPS. FFmpeg reported `bitrate=N/A`; the 15-second MKV was 211,852 bytes, or 112.99 kbit/s by container bytes divided by the requested duration. This excludes RTSP/TCP overhead and is not a wire-rate measurement.

The service process sample at the end of the capture interval reported CPU: MediaMTX 0.9%, ingest 1.2%, Renderer 5.6%, A2 sender 36.8%. Working sets were 34.7 MB, 56.2 MB, 30.9 MB, and 55.7 MB respectively. The separate FFmpeg recorder used 740.7 MB; its CPU percentage was unavailable because it did not exist in the initial sample. Windows process samples are interval averages from process CPU-time deltas.

The recorded H.264 stream was 1936×1168 yuv420p. The 15-second integration test decoded 33 A2 samples, all with valid CRC, and observed Rect counts 0, 4, and 15. RGB error mean/max/frame-p95-max was 3.894/34.366/12.042.

## Interpretation and limits

The sender encode/paint/pipe loop stayed near 30 FPS in this run. Chromium screenshot capture was 8.95 FPS and FFmpeg reported 0.926x, so the complete pipeline did not meet real-time 30 FPS in this run. The screenshot/capture and H.264 encode path need profiling before claiming that target. This localhost run does not establish WAN, Quest, AVPro, or production performance.

Machine-readable evidence and recording: `tests/results/atlas-a2-e2e-stage-metrics/atlas-a2-e2e.json`, `tests/results/atlas-a2-e2e-stage-metrics/metrics/`, and `tests/results/atlas-a2-e2e-stage-metrics/bosai-a2.mkv`.

## Concurrent 60-second run

Command: `python -B tools/atlas_e2e.py --mediamtx <mediamtx.exe> --duration 60 --viewers 10 --output tests/results/atlas-a2-load-10viewers-60s`

All 10 RTSP/TCP clients completed. The recorder produced 1,272,297 bytes (169.64 kbit/s by container bytes / requested seconds; transport overhead excluded). At 4 FPS sampling, 239/239 frames had valid A2 CRC, with no invalid frames. The stream was H.264 1936×1168 yuv420p. Mean/max/frame-p95-max RGB error was 3.578/37.842/10.440.

| Stage | Measured FPS | Interval average / max / p95 (ms) | Work duration average / max / p95 (ms) |
|---|---:|---:|---:|
| Chromium screenshot capture | 8.97 | 111.49 / 141.78 / 138.01 | 79.62 / 113.15 / 104.09 |
| PNG decode, RGB conversion, atomic write | 0.91 changed frames/s | 1101.56 / 2328 / 2312 | 48.71 / 83.22 / 65.54 |
| A2 packet encode | 29.90 | 33.44 / 63 / 47 | 0.15 / 0.76 / 0.23 |
| Atlas symbol paint | 29.95 | 33.39 / 79 / 47 | 4.75 / 8.69 / 6.83 |
| FFmpeg raw-frame pipe write | 29.90 | 33.44 / 63 / 47 | 6.47 / 12.18 / 9.18 |
| FFmpeg H.264 encode progress | 29.38 | — | speed 0.982x |

End-of-run managed-process CPU samples were MediaMTX 1.2%, ingest 0.1%, Renderer 4.4%, and A2 sender 30.2%. Working sets were 39.8 MB, 55.6 MB, 31.3 MB, and 55.6 MB. The recorder used 740.8 MB; its CPU percentage was unavailable because it was not in the initial process sample. The ten additional readers are not individually included in the process sampler.

The 60-second run sustained ten loopback readers and CRC-valid output, but it does not prove 80-client, longer-duration, WAN, or production load. Chromium capture remained below 9 FPS and FFmpeg remained just below real-time speed.

Machine-readable evidence and recording: `tests/results/atlas-a2-load-10viewers-60s/atlas-a2-e2e.json`, `tests/results/atlas-a2-load-10viewers-60s/metrics/`, and `tests/results/atlas-a2-load-10viewers-60s/bosai-a2.mkv`.
