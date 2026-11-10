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
  -rtsp_transport tcp -f rtsp rtsp://127.0.0.1:8554/bosai
```

前提: 別プロセスが幅1936×高さ1168、rgb24の連続フレームをFFmpegのstdinへ送る。ダミー用のコマンドではなく、実アトラスフレームの投入が必要。`-profile:v high`/Level5.0のVRChat実機再生可否は未検証。互換性優先でprofile変更候補を比較する。

**Level注意**: `ceil(1936/16) × ceil(1168/16) = 121 × 73 = 8833`マクロブロック/フレーム。H.264 Level4.2のMaxFS 8704を超過するため、A2送出ではLevel 5.0相当を使います。VRChat実機との互換性は未確認です。

## MediaMTX

`examples/mediamtx.production.example.yml` は公開RTSP listener、loopback限定publish、匿名readを設定する。readを匿名公開するため配信映像は誰でも取得できます。管理APIは無効です。

Windowsでの本番起動例（`mediamtx.exe` とChromeのパスは環境に合わせる）:

```powershell
python tools/atlas_service.py `
  --mediamtx C:\path\to\mediamtx.exe `
  --config examples/mediamtx.production.example.yml `
  --url rtsp://127.0.0.1:8554/bosai `
  --chrome "C:\Program Files\Google\Chrome\Application\chrome.exe"
```

受信側URLは Windows `rtspt://stream.usuiensan.dev:8554/bosai`、Quest `rtsp://stream.usuiensan.dev:8554/bosai`。起動前にMediamtx、Node.js、Python/Pillow、FFmpeg/libx264、Chromeを用意します。停止は起動コンソールで Ctrl+C。A2 sender はサービス監視対象として子プロセス異常終了時に再起動します。

ユーザーログオン時の自動起動例（PowerShell、パスは実環境へ置換）:

```powershell
$action = New-ScheduledTaskAction -Execute "python" -Argument "C:\private\kishou_server\tools\atlas_service.py --mediamtx C:\path\to\mediamtx.exe --config C:\private\kishou_server\examples\mediamtx.production.example.yml --url rtsp://127.0.0.1:8554/bosai --chrome `"C:\Program Files\Google\Chrome\Application\chrome.exe`"" -WorkingDirectory "C:\private\kishou_server"
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName "BosaiA2" -Action $action -Trigger $trigger -Settings $settings -Description "Atlas II RTSP sender" -Force
Start-ScheduledTask -TaskName "BosaiA2"
```

停止は `Stop-ScheduledTask -TaskName "BosaiA2"`、自動起動解除は `Unregister-ScheduledTask -TaskName "BosaiA2" -Confirm:$false`。ログは `runtime/logs/` に出力します。

公開例: Windows VRChat `rtspt://stream.usuiensan.dev:8554/bosai`、Quest `rtsp://stream.usuiensan.dev:8554/bosai`。FFmpeg/VLCなど一般のクライアントでは `rtsp://` + TCP設定を使用する。

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
