# 防災アトラス送出サーバー

送出wireは Atlas II / A2 colour32 v2 です。Atlas v8 は常駐起動経路から外し、配信先を `/bosai` に統一しています。仕様は [`protocol/atlas-ii.md`](protocol/atlas-ii.md)、区域表と固定ベクトルも同じ `protocol/` 内にあります。

## Windowsで起動

必要なもの: Node.js、Python 3 と Pillow、FFmpeg/libx264、Chrome、MediaMTX。起動前にAtlasを再生成し、MediaMTX・A2入力・描画・送出を一つの監視プロセスで管理します。

```powershell
python tools/atlas_service.py `
  --mediamtx C:\path\to\mediamtx.exe `
  --config examples/mediamtx.production.example.yml `
  --url rtsp://127.0.0.1:8554/bosai `
  --chrome "C:\Program Files\Google\Chrome\Application\chrome.exe"
```

停止は起動コンソールで `Ctrl+C`。ログは `runtime/logs/` に出力します。タスクスケジューラでログオン時に起動し、障害時に再起動する登録・停止コマンドは [`docs/03-streaming.md`](docs/03-streaming.md) に記載しています。公開視聴URLは Windows VRChat `rtspt://stream.usuiensan.dev:8554/bosai`、Quest `rtsp://stream.usuiensan.dev:8554/bosai` です。MediaMTX設定は匿名readを許可するため、配信映像は公開されます。

## 入力とテスト

`atlas_service.py` が独立JMA Atom/P2P code 556収集器、`atlas_ingest.js`、Chromium描画、A2送出器、MediaMTXを起動・監視します。JMA/P2P収集器は既存の `jma_server.js` やDiscord Botを起動せず、既存パーサーにXML/JSONを渡します。情報源ごとの接続・最終応答は映像上に表示し、状態が2分以上更新されない場合は未更新と示します。

データ提供元: 緊急地震速報の一部は **Wolfx Project**（Axis / ProjectBS 経由を含む）および P2P地震情報から取得しています。本サービスは非公式の実験用表示であり、公式の警報を代替しません。Rectレイアウト、MAIN_VIDEO寸法、出力論理解像度、アトラス解像度は [`examples/atlas-layouts.json`](examples/atlas-layouts.json) で指定します。

既定レイアウトは `reverseL`、MAIN_VIDEO実寸と論理出力は1920×1080、符号化用Atlasは1936×1168です。別サイズに変更する場合は `atlasSize` を16pxの倍数（幅640px以上、高さ32px以上）に設定してください。用意済みの `full`、`reverseL`、`gate`、`reduced`、`alphaPair` を `activeLayout` で選択できます。

単体テスト:

```powershell
npm test
$env:PYTHONUTF8 = "1"
python -B -m unittest discover -s tests -p 'test_*.py'
```

`npm test` は既存テロップ生成テストも含みます。JMA/P2P収集器のネットワーク実データ、WAN/DDNS、Windows VRChat・Quest AVPro実機、長時間のMediaMTX配信は別途確認が必要です。
