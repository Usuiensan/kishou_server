# 03 H.264 / RTSP over TCP / VBR

## 設計の前提

- 一定ビットレートCBRではなく **CRF + VBVで最大バーストを制限するVBR**を優先する。静止時のデータが減り、更新時だけ増える。
- 「視聴者ごとのABR」と「エンコーダが映像の内容に応じてVBR」は別機能。RTSPTは基本的に1品質のストリームを全員へ送る。
- 平均300〜500kbpsは**試験目標**であって達成保証ではない。画面内容・更新頻度・ビット深度・FPSで実際の帯域は変わる。
- まず x264で参照条件を作り、その後NVENC等へ切り替え、再圧縮後CRC・文字可読性で等価性を確認する。

## エンコーダ設定例（30fps）

```bash
ffmpeg -hide_banner -loglevel warning \
  -f rawvideo -pixel_format rgb24 -video_size 1936x1168 -framerate 30 -i pipe:0 \
  -an -c:v libx264 -preset veryfast -crf 23 -maxrate 3000k -bufsize 1500k \
  -pix_fmt yuv420p -profile:v high -level:v 5.0 \
  -g 30 -keyint_min 30 -sc_threshold 0 -bf 0 \
  -x264-params 'sliced-threads=0:repeat-headers=1' \
  -rtsp_transport tcp -f rtsp rtsp://127.0.0.1:8554/atlas
```

前提: 別プロセスが幅1936×高さ1168、rgb24の連続フレームをFFmpegのstdinへ送る。ダミー用のコマンドではなく、実アトラスフレームの投入が必要。`-profile:v high`/Level5.0のVRChat実機再生可否は未検証。互換性優先でprofile変更候補を比較する。

**Level注意**: `ceil(1936/16) × ceil(1168/16) = 121 × 73 = 8833`マクロブロック/フレーム。H.264 Level4.2のMaxFS 8704を超過。`-level 4.2`指定は仕様を満たす解決にならない。v8は5.0候補で試験し、4.2必須なら別のv9レイアウトとして設計する。

## MediaMTX

`examples/mediamtx.yml`を参照。初期設定はRTSP/TCPをloopbackのみにbindし、publish/readをloopback IPに限定する。WAN公開前には別ユーザーの読み取り認証を設定し、公開NICへbindする必要がある。Docker上はlocalhostのアドレス意味が異なるためhost-network or publish認可の再設計が必要。

公開例: `rtspt://stream.example.com:8554/atlas` （Windows VRChat用の候補）。FFmpeg/VLCなど一般のクライアントでは `rtsp://` + TCP設定を使用する。

## 低遅延と互換性

- Bフレームを0にして再並び替えを減らす。1秒GOPから始める。OBS/Windows AVProで破損報告のあるsliced-threadsを初期設定で無効化する。
- 30fpsに限定せず15fpsも測定する。アトラスには毎フレーム完全状態があるため、静止テロップの用途ならフレームレート低減が効果的な可能性がある。
- 緊急時に再エンコードプロセスを再起動してCBRやFPSを変えない。まず固定設定のVBRで済ませる。どうしても必要ならx264/NVENCのライブ再構成APIを単体検証し、ストリーム継続性を確認する。
- ffprobeでコーデック/解像度/平均フレームレート/実ビットレートを計測する。ffprobe単独のbit_rateが空の場合、測定区間のファイルサイズ÷秒数から測る。

## 帯域モデル

WAN上り目安 ≈ 実ビットレート(Mbps) × 同時視聴者数 × 1.2〜1.5（余裕係数）。

- 500kbps・80人: 映像40Mbps、余裕込み48〜60Mbps
- 1Mbps・80人: 映像80Mbps、余裕込み96〜120Mbps
- 3Mbps・80人: 映像240Mbps、余裕込み288〜360Mbps

プロセスの再エンコードは視聴者数に比例しないが、TCP接続数・帯域・ファイルディスクリプタ・自宅ルーターのNAT状態・回線混雑は比例して増える。測定で上限を決める。
