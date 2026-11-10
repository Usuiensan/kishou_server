# 02 既存テロップ・アトラスv8との接続

## リポジトリの実査（2026-11-09）

確認したローカル `telop-mock`:

- `telop/HANDOFF-CODEX.md`（テロップ側の正本、既存の開発方針）
- `telop/tsunami.html` と `telop/tsunami-art.js` / `telop/tsunami-tester.html`
- `telop/eew.html` / `telop/eew-telop-tester.html`
- `telop/docs/tsunami-minimap.md`, `telop/docs/jma-eew-notes.md`, `telop/docs/okinawa-ogasawara-cases.md`
- `GUIDE.md` にUnity向け `/api/v2/latest` の記述あり。現物のレスポンス形・更新タイミングは必ずコードと実験用レスポンスで確認する。

v8生成元は `telop/build_atlas.py`、生成物は `telop/atlas-1080.html`。`telop/atlas-1080-v8.html` は参照用ファイルであり、現在の送出HTMLはビルダー生成物。

## v8の領域（左上原点・半開区間）

| 部品 | x | y | 幅 | 高さ |
|---|---:|---:|---:|---:|
| Top | 0 | 0 | 1920 | 158 |
| Left | 0 | 174 | 281 | 922 |
| EEW実体 | 11 | 174 | 258 | 922 |
| Lower Alpha | 297 | 174 | 1639 | 461 |
| Lower RGB | 297 | 651 | 1639 | 461 |
| Data | 0 | 1128 | 1936 | 30 |

- 各領域の間にある16px隙間を維持する。左帯実体は左帯スロットと重なる意図的な包含関係。
- Lower Alpha/RGBは **同一ローカルUVのペア**。Alphaは輝度で表す。視覚用補間はBilinear、ビット領域復号はセル中央のPoint相当。
- 上帯右側の16px（1920..1935）は未使用。基本映像ソースのatlas内領域は現在 **未定義**。映像本編をアトラスの任意の未使用領域へ詰めてはいけない。別ソース経路を合意する。

## XML入力からHTML描画

1. `tools/atlas_ingest.js` が既存パーサーを呼び、種別ごとのスナップショットだけ更新する。入力はloopback HTTP `/jma`。上流JMAフィードの取得は未実装。
2. `telop/atlas-live.js` が既存EEW・津波描画関数を使い、4レイヤーを合成する。
3. `tools/render_atlas.py` はChromiumを1回起動し、状態スナップショットの更新とアニメーションを含むHTMLを継続キャプチャしてRGB PNGを更新する。津波地図の点滅はキャプチャフレームごとに進め、FFmpegの入力fpsと同期する。DOM ready、スナップショット取得、フォント、寸法、ブラウザーエラーを確認する。
4. `tools/atlas_sender.py` がそのRGB PNGへ24B/3行制御データを描画し、FFmpegへ連続入力する。
5. `python tools/atlas_e2e.py --mediamtx <実行ファイル>` はサンプル電文→HTML→PNG→H.264→RTSP/TCP→受信録画を通し、代表画像と測定JSONを `tests/results/atlas-e2e/` へ保存する。

画面はChromiumの実HTMLキャプチャである。キャプチャは専用のStage全体を取得するため、領域別ネイティブ描画への移植やGPU最適化はしていない。30fps出力でも入力電文反映はHTMLの1秒ポーリング周期に従う。
