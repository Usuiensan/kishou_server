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

## Grouped blink experiment (not retained)

One experiment wrapped all alert zones of each severity in a shared SVG group and animated the group. This reduced the animation count from 339 (one per zone across three map copies) to 9 (three severities across three copies), while preserving the wall-clock phase and 10/10 RTSP clients. In matched 60-second/10-reader runs, however, Chromium capture fell from 8.97 to 7.49 FPS (screenshot duration average increased from 79.62 to 121.40 ms), Atlas paint fell from 29.95 to 27.26 FPS (duration average increased from 4.75 to 9.88 ms), and sampled CRC-valid frames fell from 239 to 207. Both runs had zero invalid frames.

The grouped opacity approach was discarded and the original per-zone animation restored because this measurement showed lower throughput. These results do not identify the rendering cause. Temporary grouped-run data remains in `tests/results/atlas-a2-load-10viewers-60s-grouped-blink/`.

## GPU capture comparison

The capture launcher was measured with its existing `--disable-gpu` option and once with that option removed. Both runs used a 60-second loopback RTSP recording and ten clients. With GPU disabled, capture measured 8.97 FPS (screenshot duration avg 79.62 ms), Atlas paint 29.95 FPS (avg 4.75 ms), and all 239 sampled A2 frames passed CRC. With GPU enabled, capture measured 6.14 FPS (screenshot duration avg 112.13 ms), Atlas paint 28.14 FPS (avg 9.42 ms), and all 238 sampled A2 frames passed CRC. FFmpeg reported 29.38 FPS at 0.982x with GPU disabled and 27.71 FPS at 0.985x with GPU enabled.

This single pair showed no throughput gain from enabling GPU and ran slower in the capture and paint stages, so the original `--disable-gpu` launch option was restored. The result is one machine/run comparison, not proof of the cause or behavior on other PCs. Raw GPU-enabled evidence is under `tests/results/atlas-a2-load-10viewers-60s-gpu/`.


## 80-viewer 60-second run

Command: `python -B tools/atlas_e2e.py --mediamtx <mediamtx.exe> --duration 60 --viewers 80 --output tests/results/atlas-a2-load-80viewers-60s`

All 80 loopback RTSP/TCP clients completed. The 60-second recording produced 240 sampled frames; all 240 passed A2 CRC and none were invalid. The stream remained H.264 1936×1168 yuv420p. Mean/max/frame-p95-max RGB error was 2.319/33.496/10.488. The 855,287-byte container corresponds to 114.04 kbit/s over the requested duration; RTSP/TCP overhead is excluded.

| Stage | Measured FPS | Interval average / max / p95 (ms) | Work duration average / max / p95 (ms) |
|---|---:|---:|---:|
| Chromium screenshot capture | 5.81 | 171.99 / 212.73 / 198.38 | 117.19 / 146.82 / 140.49 |
| PNG decode, RGB conversion, atomic write | 0.83 changed frames/s | 1211.62 / 3203 / 2437 | 440.45 / 2018.54 / 1354.23 |
| A2 packet encode | 27.77 | 36.01 / 78 / 62 | 0.36 / 7.19 / 0.97 |
| Atlas symbol paint | 27.81 | 35.95 / 94 / 62 | 9.62 / 47.77 / 16.63 |
| FFmpeg raw-frame pipe write | 27.81 | 35.95 / 79 / 63 | 12.70 / 47.38 / 22.82 |
| FFmpeg H.264 encode | 13.68 at last progress sample | — | speed 0.986x |

The last managed-process sample reported CPU: MediaMTX 4.4%, ingest 0.3%, Renderer 7.5%, A2 sender 18.6%. Working sets were 48.9 MiB, 51.5 MiB, 28.5 MiB, and 54.5 MiB. FFmpeg used 705.2 MiB; its CPU percentage was unavailable because it was absent from the start sample. Individual reader resource usage was not collected.

The 80-viewer loopback condition passed for 60 seconds. This is not long-duration, WAN, Quest, production, or per-reader resource evidence. Chromium capture and changed-frame PNG conversion slowed under this load; the end-to-end stream did not establish sustained 30 FPS.

Machine-readable evidence and recording: `tests/results/atlas-a2-load-80viewers-60s/atlas-a2-e2e.json`, `tests/results/atlas-a2-load-80viewers-60s/metrics/`, and `tests/results/atlas-a2-load-80viewers-60s/bosai-a2.mkv`.

## Ten-minute 10-viewer run

The loopback run recorded 600.039 seconds of H.264 1936×1168 yuv420p video. The preserved MKV was decoded after changing the analyzer to consume one raw frame at a time. At 4 FPS sampling, 2,366/2,366 frames passed A2 CRC; no invalid frames were found. Rect count was 4 throughout the sampled stream. RGB error mean/max/frame-p95-max was 3.888/44.654/11.402. The container was 10,194,429 bytes (135.91 kbit/s over the 600-second recording; RTSP/TCP overhead excluded).

This confirms ten minutes of recorded loopback output with CRC-valid samples. The interrupted analyzer did not preserve the original per-stage metrics or per-reader resource samples. This run does not establish multi-hour stability, WAN behavior, production performance, or reader-specific resource use.

Machine-readable decode evidence and recording: `tests/results/atlas-a2-load-10viewers-600s/atlas-a2-load-10viewers-600s-analysis.json` and `tests/results/atlas-a2-load-10viewers-600s/bosai-a2.mkv`.
