# A2 H.264 / RTSP over TCP

## 送出条件

`tools/atlas_ii.py` はAtlas完全状態を各フレームに描き、FFmpeg/libx264でCRF23・yuv420p・B-frame 0を使ってMediaMTXへRTSP/TCP publishします。A2データはcolour32 8×8セルでアトラス左下端から配置します。既定Atlasは1936×1168ですが、`examples/atlas-layouts.json` の `atlasSize` を16pxの倍数（幅640px以上、高さ32px以上）に変更できます。

`examples/mediamtx.production.example.yml` は8554/TCPの公開read、localhost限定publish、管理API無効を設定します。readは匿名公開のためストリームは誰でも取得できます。ルーター/Firewallでは8554/TCPのみを公開し、UPnPに依存しません。

RGB→YUV変換とH.264の色空間指定はBT.709・limited rangeに統一します。色空間未指定のHD映像では、BT.601で符号化した色をAVPro MediaFoundationがBT.709として復元するとcolour32の量子化境界を越え、CRC不一致が発生します。変換行列とメタデータの両方を指定し、BT.709復号後のCRCを検証します。

## Windowsで手動起動・停止

Node.js、Python 3/Pillow、Chrome、FFmpeg/libx264、MediaMTXを用意し、PowerShellで実行します。

```powershell
python tools/atlas_service.py `
  --mediamtx C:\path\to\mediamtx.exe `
  --config examples/mediamtx.production.example.yml `
  --runtime runtime `
  --url rtsp://127.0.0.1:8554/bosai `
  --chrome "C:\Program Files\Google\Chrome\Application\chrome.exe"
```

起動前にMediaMTX設定、依存コマンド、RTSP/ingest/testポートを検査します。MediaMTX、ingest、JMA/P2P収集器、Renderer、A2 senderを監視し、異常終了した子プロセスを指数バックオフ（最大60秒）で再起動します。サービスはHTMLを再生成してから起動します。手動停止は同じコンソールで `Ctrl+C`。ログは `runtime/logs/` です。

## ログオン時の自動起動と復旧

PowerShellで登録します。実環境に合わせてMediaMTXとChromeのパスを変更してください。

```powershell
$root = "C:\private\kishou_server"
$python = (Get-Command python).Source
$mediamtx = "C:\path\to\mediamtx.exe"
$chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
$args = "-B `"$root\tools\atlas_service.py`" --mediamtx `"$mediamtx`" --config `"$root\examples\mediamtx.production.example.yml`" --runtime `"$root\runtime`" --url rtsp://127.0.0.1:8554/bosai --chrome `"$chrome`""
$action = New-ScheduledTaskAction -Execute $python -Argument $args -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName "BosaiA2" -Action $action -Trigger $trigger -Settings $settings -Description "A2 RTSP sender" -Force
Start-ScheduledTask -TaskName "BosaiA2"
```

```powershell
Stop-ScheduledTask -TaskName "BosaiA2"
Start-ScheduledTask -TaskName "BosaiA2"
Unregister-ScheduledTask -TaskName "BosaiA2" -Confirm:$false
```

Task Scheduler retries a stopped task every minute, up to 999 times. Confirm the current task state with `Get-ScheduledTask -TaskName "BosaiA2"`; review component logs under `runtime/logs/`.

## URL・計測

- Windows VRChat: `rtspt://stream.usuiensan.dev:8554/bosai`
- Quest: `rtsp://stream.usuiensan.dev:8554/bosai`
- FFmpeg/VLC clients: `rtsp://stream.usuiensan.dev:8554/bosai`, RTSP transport TCP

実ビットレート、遅延、WAN/DDNS、80同時視聴、AVPro/Questの再生可否は実機計測が必要です。現時点の検証境界は `docs/05-acceptance.md` に記録します。
