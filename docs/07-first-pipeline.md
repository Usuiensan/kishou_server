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

## 電文からアトラス表示データ

`lib/atlasData.js` は既存JMA XMLパーサーと整形関数を使い、EEW/津波の電文をTop文字列と既存コンポーネント向け入力へ変換する。実行例:

```powershell
node tools/atlas_data.js eew tests/samples/37_01_01_240613_VXSE43.xml
node tools/atlas_data.js tsunami tests/samples/32-39_11_02_250206_VTSE41.xml
```

続報は同じイベントの前回JSONを第3引数に渡す。取消はEEW/津波レイヤーを非表示にし、Topには既存整形関数の取消文を渡す。津波の地域区分はJMAパーサーのmajor/warning/advisoryを維持する。EEWでは既存JMAパーサーの予報区、震央座標と震源名を使う。

このJSONは描画入力で、HTMLをラスタ化した1936×1168 PNGではない。v8 HTMLにはEEW描画関数があるが津波コンポーネントや全画面アトラスとの接続は未完了。`/api/v2/latest` は津波を含まないため、本番の別プロセス接続はこのエンドポイントだけでは成立しない。XML取り込み方法とHTMLの描画実行環境を結線する作業、実画像を使ったRTSP試験、VRChat/AVPro実機、WAN接続、DDNS更新は未検証。
