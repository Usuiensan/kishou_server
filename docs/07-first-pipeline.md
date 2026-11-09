# 初回送出パイプライン

## 送出側の契約

`tools/atlas_sender.py` は別プロセスで動作し、レンダラーが出力するRGB PNG (1936×1168) を入力にする。`reference/metadata_demo.py` のパケット生成・描画処理をそのまま使い、状態サイドカー `--state-json` と画像の変更を検出して sequence を増やす。timestamp は送出中にUNIX秒で更新する。

サイドカーの例:

```json
{"flags":15,"mode":1,"opacity":255,"lower_x":281,"lower_y":619}
```

ライブ更新時は一時ファイルへ書いてから元のPNG/JSONを置き換える。FFmpegはCRF 23 + VBV上限3000k/バッファ1500k、yuv420p、B-frameなし、30fps/30 GOP、Level 5.0で起動する。MediaMTXのpublish権限はlocalhostに限定した `examples/mediamtx.yml` を使う。

## 実行

```powershell
python tools/atlas_sender.py --atlas path\to\atlas.png --snapshot tests\results\atlas.png
python tools/atlas_sender.py --atlas path\to\atlas.png --state-json path\to\state.json --stream
```

`--stream` は `rtsp://127.0.0.1:8554/atlas` へ送る。MediaMTXを別プロセスで起動する。送出側はMediaMTXや既存 `jma-api` を起動・変更しない。

## 検証結果 (2026-11-09)

- `python -m unittest discover -s tests -v`: 14件成功。
- `python tools/sender_smoke.py`: 固定条件で60フレームをH.264/yuv420p圧縮・復号。3複製×60フレーム=180行のCRCと全フィールドが一致。ffprobe: 1936×1168、30fps、Level 5.0、B-frameなし、2.0秒、MP4全体50616 bit/s。
- `python tools/rtsp_smoke.py --mediamtx <MediaMTX v1.21.3 の実行ファイル>`: MediaMTX→FFmpegのRTSP/TCP読み出しに成功。344フレームを受信し、画面変更とサイドカー更新でsequenceが1から2へ進んだ。
- ffprobeの各区間のsize/durationから算出した合成画像ビットレート: 静止区間約48 kbit/s、変更の入った区間約583 kbit/s。高密度チェッカーパターンを表示した後は約1.11–1.60 Mbit/s、最終0.47秒区間は約2.32 Mbit/s。
- FFmpeg: N-124716-g054dffd133-20260531。MediaMTX: v1.21.3。MediaMTX実行ファイルは一時領域から起動し、リポジトリへ追加していない。

成果物は `tests/results/atlas-synthetic-composite.png`, `tests/results/atlas-codec-test.txt`, `tests/results/rtsp-smoke/rtsp-measurements.json`。画像はプロトコル試験用の色面デモであり、実アトラスの表示検証には使えない。ビットレートも合成画像での測定値で、実デザインの予測値ではない。

## 電文から同時表示HTMLへ

`lib/atlasData.js` は既存JMA XMLパーサーと整形関数を使い、EEW/津波の電文をTop文字列と既存コンポーネント向け入力へ変換する。実行例:

```powershell
python telop/build_atlas.py
python -m http.server 8080 --directory telop
# ブラウザで http://127.0.0.1:8080/atlas-1080.html を開く

node tools/atlas_data.js eew tests/samples/37_01_01_240613_VXSE43.xml telop/atlas-state.json
node tools/atlas_data.js tsunami tests/samples/32-39_11_02_250206_VTSE41.xml telop/atlas-state.json
node tools/atlas_data.js intensity tests/samples/32-39_11_05_240613_VXSE53.xml telop/atlas-state.json
node tools/atlas_data.js vertical tests/samples/32-39_11_02_250206_VTSE41.xml telop/atlas-state.json
```

ビルドHTMLには4種の実サンプル電文から作る初期スナップショットが埋め込まれ、直接開いても同時表示を確認できる。HTTP配信中は同じディレクトリの `atlas-state.json` があれば1秒ごとに読み直す。単独の電文コマンドは1件の電文JSONを出力し、出力先を追加すると既存スナップショットへそのレイヤーだけ適用する。

## 試験操作API

手動操作と時刻指定シナリオは同じ試験操作を使う。配信サービス起動時に `--test-api` を指定した場合だけ `http://127.0.0.1:8766` を開く。試験APIを有効にした状態は試験配信専用とし、通常配信では指定しない。

```powershell
python tools/atlas_service.py --mediamtx path\to\mediamtx.exe --test-api
python tools/atlas_test.py event tests\samples\37_01_01_240613_VXSE43.xml
python tools/atlas_test.py mode --mode 2 --flags 7
python tools/atlas_test.py status
```

- `POST /test/events`: XML本文、`{"events":[{"xml":"..."}]}`、または `{ "kind":"eew", "bulletin": <正規化済みJMA電文> }` を受ける。XML列は指定順に適用する。
- `POST /test/mode`: `flags`, `mode`, `opacity`, `lower_x`, `lower_y` の一部を更新する。`mode` はv8メタデータの制御値で、EEW/津波などのレイヤー切替ではない。senderは同じRTSP publishプロセスのまま次のフレームへ反映する。
- `POST /test/scenarios/run`: 秒オフセット付き `steps` を順に実行。各操作は `events`, `mode`, `reset`, `fault`。反復は `everySeconds` と `count` で指定する。手動APIと同じ操作関数を呼ぶ。
- `POST /test/reset`: 表示レイヤーとmetadata制御値を初期値へ戻す。
- `POST /test/fault`: `{"child":"sender","action":"stop"}` で送出障害を再現し、`action:"resume"` で監視ループに再起動させる。シナリオでは `fault` 操作を使う。
- `GET /test/status`: 各子プロセス、現在の制御値、入力サービス、シナリオ進行状態を返す。

シナリオ例 (`scenario.json`):

```json
{"steps":[
  {"atSeconds":5,"action":"events","events":[{"xmlFile":"tests/samples/37_01_01_240613_VXSE43.xml"}]},
  {"atSeconds":10,"action":"events","events":[{"xmlFile":"tests/samples/37_01_02_240613_VXSE43.xml"}]},
  {"atSeconds":15,"action":"mode","values":{"mode":2,"flags":7}},
  {"atSeconds":20,"action":"reset"}
]}
```

障害再現を含むシナリオでは `{ "atSeconds":25, "action":"fault", "child":"sender", "state":"stop" }` とし、再開する場合は後続ステップの `state` を `resume` にする。

```powershell
python tools/atlas_test.py scenario scenario.json
```

`xmlFile` はクライアント側でXML内容に置き換えてAPIへ送る。シナリオ操作は起動中の試験サービスに限る。

このJSONは描画入力であり、ラスタ化済みPNGではない。現在の描画・RTSP接続は上記 `render_atlas.py` と `atlas_sender.py` の経路を使う。自動JMA取得は未接続で、入力はloopback APIまたは試験CLIから行う。ローカルRTSP結合試験の記録は `docs/05-acceptance.md` を参照。VRChat/AVPro実機、WAN接続、DDNS更新は未検証。
