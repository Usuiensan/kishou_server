# 防災アトラス送出サーバー

送出wireは Atlas II / A2 colour32 v2 です。Atlas v8 は常駐起動経路から外し、配信先を `/bosai` に統一しています。仕様は [`protocol/atlas-ii.md`](protocol/atlas-ii.md)、区域表と固定ベクトルも同じ `protocol/` 内にあります。

## Windowsで起動

必要なもの: Node.js、Python 3 と Pillow、FFmpeg/libx264、Chromium/Chrome、MediaMTX。

```powershell
python telop/build_atlas.py
python tools/atlas_service.py `
  --mediamtx C:\path\to\mediamtx.exe `
  --config examples/mediamtx.production.example.yml `
  --url rtsp://127.0.0.1:8554/bosai `
  --chrome "C:\Program Files\Google\Chrome\Application\chrome.exe"
```

停止は起動コンソールで `Ctrl+C`。ログは `runtime/logs/` に出力します。タスクスケジューラでログオン時に起動し、障害時に再起動する登録・停止コマンドは [`docs/03-streaming.md`](docs/03-streaming.md) に記載しています。公開視聴URLは Windows VRChat `rtspt://stream.usuiensan.dev:8554/bosai`、Quest `rtsp://stream.usuiensan.dev:8554/bosai` です。MediaMTX設定は匿名readを許可するため、配信映像は公開されます。

## 入力とテスト

`tools/atlas_ingest.js` はloopbackの `/jma` でJMA XML、`/p2p` でP2P code 556 JSONを受け、EEW・津波・震度の状態を保存します。Chromium rendererが既存テロップHTMLを画像化し、`tools/atlas_ii.py` がRect/区域情報とcolour32セルを付けてCRF 23のH.264をMediaMTXへ送ります。現時点ではJMA/P2P常時取得プロセスとの接続、Rect配置の運用設定、実際のMAIN_VIDEO寸法/source、公開RTSP配信が未確認です。

単体テスト:

```powershell
npm test
$env:PYTHONUTF8 = "1"
python -B -m unittest discover -s tests -p 'test_*.py'
```

`npm test` は既存テロップ生成テストも含みます。JMA上流、WAN/DDNS、Windows VRChat・Quest AVPro実機、長時間のMediaMTX配信は別途確認が必要です。
