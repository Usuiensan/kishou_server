# Concurrent RTSP reader receipt proof (loopback)

The test harness previously treated a zero FFmpeg exit code as a successful additional reader, without checking that the reader received frames. Its concurrent clients now use H.264 packet copy and report FFmpeg's observed frame count; each must receive at least 80% of the sender's output count.

- 10 viewers for 60 seconds: 9/9 additional readers received 1,798–1,800 of 1,849 sender frames; the independent 4 fps decode validated A2 CRC on 240/240 frames.
- 80 viewers for 60 seconds: 79/79 additional readers received 1,540–1,790 of 1,807 sender frames; the independent 4 fps decode validated A2 CRC on 239/239 frames.
- These are localhost MediaMTX results. They do not establish WAN, Quest, AVPro, production, or hour-long behavior.

Raw results: `rtsp-10viewers-copy-60s-2026-11-12.json` and `rtsp-80viewers-copy-60s-2026-11-12.json`.
