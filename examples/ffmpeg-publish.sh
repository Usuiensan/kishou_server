#!/usr/bin/env bash
set -euo pipefail
# Sender is responsible for streaming 1936x1168 RGB24 frames to STDIN.
# Example: python3 sender.py | bash examples/ffmpeg-publish.sh
# This command DOES NOT itself produce atlas frames.
exec ffmpeg -hide_banner -loglevel warning \
  -f rawvideo -pixel_format rgb24 -video_size 1936x1168 -framerate 30 -i pipe:0 \
  -an -c:v libx264 -preset veryfast -crf 23 -maxrate 3000k -bufsize 1500k \
  -pix_fmt yuv420p -profile:v high -level:v 5.0 \
  -g 30 -keyint_min 30 -sc_threshold 0 -bf 0 \
  -x264-params 'sliced-threads=0:repeat-headers=1' \
  -rtsp_transport tcp -f rtsp rtsp://127.0.0.1:8554/atlas
