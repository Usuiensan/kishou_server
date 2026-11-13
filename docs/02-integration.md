# JMA/P2P入力・画面描画・A2 Rect連携

## 入力

`tools/atlas_service.py` は `tools/atlas_sources.js` を独立子プロセスとして起動します。収集器は既存の `jma_server.js` を起動しないため、HTTPS API、既存PM2運用、Discord Bot、NERVには副作用を与えません。

- JMA: `https://www.data.jma.go.jp/developer/xml/feed/eqvol.xml` を30秒ごとに確認し、対象のEEW・地震・津波XMLを取得してloopbackの `/jma` へPOST。
- P2P: `wss://api.p2pquake.net/v2/ws` に接続し、code 556をloopback `/p2p` へPOST。他コードはA2状態へ渡しません。
- `/source-health` は各入力源の接続/取得成功と時刻を状態へ保存します。Rendererは最終成功から120秒を超えた入力源を「情報源未更新」と画面上へ表示します。
- 上流停止時にEEW/津波アラートをTTLで消さず、JMA取消・津波解除の明示電文だけを解除として扱います。EEW取消Eventはwire上で60秒保持し、表示フラグは解除します。

## 描画とRect

`telop/build_atlas.py` が既存EEW・津波・震度表示を含むHTMLを生成します。`tools/capture_atlas.js` はHTTP経由で状態を読み、ChromiumのPNGフレームをメモリ経由で `tools/render_atlas.py` へ渡します。Rendererは中間PNGファイルを作らず、RGB変換・リサイズ後のAtlas PNGだけを保存します。既定解像度は1936×1168、変更可能な解像度は16pxの倍数、最小640×32です。

`examples/atlas-layouts.json` のRectは左上原点のピクセル座標です。`source=1` は `mainVideoSize` の本編映像、`source=0` はAtlas画像。`mode=0` は完全不透明Rect用COPY、`mode=1` は透過判定を行う候補です。RGBAキャプチャの元αをRectのalphaSrcへグレースケールで格納し、各フレームでマスクが全面255かつRect opacityが255の場合だけCOPYへ解決します。それ以外はALPHA_PAIRとして同寸法・別領域のRGBとalphaSrcを送ります。色画素の輝度から透明度を推定しません。A2側は配列順に描画し、範囲、source/alphaSrcの寸法・非重複、Atlas実寸、MAIN_VIDEO実寸、最大15件、データセルとの重なりを送出前に検証します。

既定の `reverseL` はMAIN_VIDEO全画面Rectを先頭に置き、上帯、左帯、下段のALPHA_PAIRを重ねます。下段RGBはAtlas `(297,651,1639,461)`、対応するαマスクは `(297,174,1639,461)` に分離されています。構成は `full`、`gate`、`reduced`、`alphaPair` に切替できます。`test-0-rects` / `test-15-rects` は試験APIでのみ切り替えてください。

## A2 wire

`protocol/atlas-ii.md` と `protocol/atlas_ii_reference.py` がwire正本と参照デコーダーです。最初のcolour32セルはアトラス左下の8×8ピクセル（x=0、y=H−8）。5bit/セル、28Bヘッダ、単一CRC32、毎フレーム完全状態、sequenceは状態変更時のみ増分です。固定共有ベクトルは `protocol/atlas-ii-vectors.json` にあります。

## 受け入れ記録

単体テストと実RTSP/VRChat検証は区別します。ローカルMediaMTX結合試験の手順と最新実績は `docs/05-acceptance.md` を参照してください。Windows/Quest実機、WAN、DDNSは未確認として扱います。
