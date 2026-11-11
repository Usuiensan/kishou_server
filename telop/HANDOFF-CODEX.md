# 引き継ぎ資料:津波ミニマップ / テロップコンポーネント (Codex 向け)

作成: 2026-11-09。ユーザー (うすい) の指示により、津波ミニマップの作業を Codex へ全面引き継ぐ。本書が背景・仕様・現状・既知の問題の正本。以後の判断は本書と `telop/docs/` を根拠にすること。

## 1. リポジトリと作業場所

- リポジトリ: **Usuiensan/kishou_server** (GitHub, private ではない通常リポジトリ)
- 作業ブランチ: **`telop-mock`** (main は kishou_server 本体。テロップ開発は telop-mock で行う)
- ローカルワークツリー: `~/workspace/work-kishou-space/` (telop/ が作業ディレクトリ)
- 注意: ローカルの git ブランチは古い系統のまま。GitHub 上の telop-mock が正。push は GitHub API 経由で行われてきた (この VM の git push は未整備)。作業前に GitHub の telop-mock 最新を取得すること。
- kishou_server 本体 (main) は GCE で稼働中の気象情報 bot (PM2 `jma-api`)。**`ssl/` ディレクトリには絶対に触らない**。テロップは実験系で本番 bot とは独立。

## 2. プロダクトの目的

VRChat 向け防災テロップ overlay の実験開発。NHK の津波情報ミニマップを、実データから再現可能な HTML/JS コンポーネントとして実装する。レンダラは kishou_server の JSON を入力にする想定だが、現在は静的デモで開発中。

成果物:
- `telop/tsunami.html` — 津波ミニマップ本体 (描画器 + デモプリセット)。入力 API: `renderTsunamiMini({major:[区域名], warning:[], advisory:[], legend, blink, sink})` ※ sink は廃止済み (後述)
- `telop/tsunami-art.js` — 固定画データ (ビルダが生成。手編集禁止)
- `telop/tsunami-tester.html` — 単一ファイルテスター (`build_tsunami_tester.py` が生成)
- `telop/patterns.html` — 簡略化パラメータ比較ページ (`build_patterns.py` が生成)
- `telop/tsunami-zonecheck.html` — 区域ごとの割当確認ページ (`build_zonecheck.py` が生成)
- `telop/eew.html` ほか — 緊急地震速報コンポーネント。**ユーザーが「いい感じ」と承認済み。壊さないこと**。仕様は `telop/docs/jma-eew-notes.md`

## 3. ビルド手順

```bash
cd telop
# 固定画の再生成 (正式パラメータ)
TM_TOL=0.9 TM_TOL_SMALL=0.25 TM_SMOOTH=1 TM_DROP_TINY=0.05 TM_DROP_NEAR=0.06 node build_art.js
# 全区域・警報種別の固定塗り領域を生成 (shapely入り地理処理venv)
~/workspace/.venv-geo/bin/python build_tsunami_regions.py
# テスター / チェックページ / 送出用Atlas
python3 build_tsunami_tester.py
python3 build_zonecheck.py
python3 build_atlas.py
# パターン比較ページは区域色帯の変更対象外 (patterns/*.js の再生成が前提、下記)
python3 build_patterns.py
# パターン用アート (10種)
for spec in "0.9 0.25 0" "0.9 0.25 1" "1.8 0.5 0" "1.8 0.5 1" "2.6 0.7 0" "2.6 0.7 1" "3.2 0.9 0" "3.2 0.9 1"; do
  set -- $spec; key="$1"; [ "$3" = "1" ] && key="$1s"
  TM_TOL=$1 TM_TOL_SMALL=$2 TM_SMOOTH=$3 TM_OUT=patterns/art-$key.js node build_art.js
done
TM_TOL=0.9 TM_TOL_SMALL=0.25 TM_SMOOTH=1 TM_DROP_TINY=0.05 TM_OUT=patterns/art-0.9d.js node build_art.js
TM_TOL=0.9 TM_TOL_SMALL=0.25 TM_SMOOTH=1 TM_DROP_TINY=0.05 TM_DROP_NEAR=0.06 TM_OUT=patterns/art-0.9e.js node build_art.js
# 陸地コンポーネントの再生成 (必要な場合のみ。shapely は venv)
~/workspace/.venv-geo/bin/python build_land_components.py
```

環境: Node 24 / Python 3.12。shapely はシステムに無く `~/workspace/.venv-geo` のみ。

## 4. データ出典

- 陸地: `telop/geojson.js` (dataofjapan/land の都道府県ポリゴン)。`build_land_components.py` が shapely で全県を union し、**249 の連結成分**にしたものが `telop/land_components.json`。県境で陸地が割れないための要。**県単位で処理し直すと県境に隙間・穴が開く (過去に発生)**
- 予報区: `telop/tzones.js` — 気象庁「津波予報区」GIS データ (https://www.data.jma.go.jp/developer/gis/20240520_AreaTsunami_GIS.zip、原本は `~/workspace/tsunami-zones/`)。66 区域 (帰属未定 4 件は除外)
- 区域の公式境界定義: 気象庁「津波予報区の境界一覧表」(岬・市町村で定義。例: 東京湾内湾 = 千葉県 (富津岬西端以北の東京湾沿岸)・東京都 (特別区)・神奈川県 (観音崎東端以北))。境界位置の最終根拠はこれ
- 北海道の EEW 4 区分ポリゴン: `telop/hkzones.js` (国土数値情報 N03-2024 から生成。津波ではなく EEW 用)

## 5. 確定仕様 (ユーザー承認済み。変更不可)

- 色 (業界統一色、CUDO): 大津波警報 **#c800ff** / 津波警報 **#ff2800** / 津波注意報 **#faf500**。陸地は白ベタ + 自身の輪郭を #151515 で縁取り。背景は透過 (映像に重ねる)
- 線幅: ベース幅は区域の属する図 (本土 3.9 / 沖縄列島 4.1 / 小笠原 4.1)。**注意報と警報は同じ太さ**。大津波警報だけ ×1.9
- 点滅: 周期 3.0 秒、ON 75% / OFF 25% (2025-07-30 の NHK 実測)
- 凡例: 右側に縦積みチップ (発表中の種別のみ)。開始 x=436、チップ高 14、ラベル 30px
- レイアウト: viewBox 550×550 相当。本土図 + 左下に沖縄列島の別枠 + 下に小笠原の別枠 (ブラケット・ラベル「沖縄」「小笠原」)。仕切り線は直線 3 本 (座標は `build_art.js` の TM_DECOR / `tsunami.html` 側を確認)
- 「NHK」の文字はどこにも書かない
- デモ: example (気象庁使用例の近似) / tohoku / advisory_all / warning_all / major_all / none

## 6. アーキテクチャ (現行)

**固定画方式**: 実行時に投影・変形はしない。`build_art.js` が全幾何をベイクする。

1. 変形: 本土は実測アフィン (NHK フレームへの当てはめ、11 ランドマーク、残差平均 10px)。伊豆諸島は拡大+列シフト。沖縄列島は 2 アンカーの相似配置 + テーパー拡大。小笠原は専用プロジェクタ + 拡大
2. 陸地の削除ルール: 本土ルートで最大辺 <0.05° の微小島を削除 (`TM_DROP_TINY`)、本土 4 大陸塊から 0.06° 以内かつ最大辺 <0.40° の近接離島を削除 (`TM_DROP_NEAR`、実測根拠は NHK 西日本図)
3. 一括移動 (海峡を広げる): 四国 [0,+14] / 九州 [−14,+7] / 淡路 [−3.5,+7] px
4. 密集地の押し広げ: px 空間で島同士の目標間隔 15px まで緩和 (瀬戸内・長崎の 2 ボックス)、届かない島は間引き (閾値 8px、最大辺 14px 以上の島は落とさない)
5. **区域線は陸地輪郭への帰属で作る** (最重要): 最終配置の陸地輪郭の全頂点を「元の区域線の参照点に最も近い区域」へ帰属させ、区域ごとの run に切り直す。境界では線がスパッと切れ、重なり・欠けが構造的に起きない。帰属率 100% (2149/2149)、66 区域すべてに run あり。短い割り込み (両側が同じ区域で 3 頂点以下) は埋める
6. **線は海側へ寄せる**: 輪郭頂点ごとに海側法線と「対岸までの距離の半分」の上限 (caps) を固定画へ同梱。描画時に種別幅の半分 −0.3 だけ法線方向へずらす (caps で頭打ち)。これで陸地に侵食せず、大津波の太線でも向かい合う線が交差しない

パラメータの意味と履歴は `telop/docs/tsunami-minimap.md` に全て記録してある (必読)。

## 7. ユーザーの確定判断と却下履歴 (蒸し返し禁止)

- **区域の塗りつぶし: 却下** (線のみ)
- **線を陸地ベタで半分隠す方式 (sink): 却下** —「レイヤーが地面の後ろなだけ。線が細く見える」
- **線の太さをいじるな** (細線化で隙間を作る案は却下済み)。ただし線の「位置」を海側へ寄せる方式はユーザーの指示で採用 (第 6 節 6)
- 注意報・警報は同幅、大津波だけ太く — ユーザーの明示
- 陸地への侵食をやめ、そのぶん陸地同士の隙間をあける — ユーザーの明示 (一括移動・押し広げの増量で対応済み)
- EEW の区域並びは気象庁の電文順そのまま (並べ替えしない)
- 沖縄・小笠原の映像調査は終了 (追加調査不要)

## 8. 現状と既知の問題 (2026-11-09 13:45 時点、監査は Muse が実施)

ユーザーは現行版の見た目全体に不満で引き継ぎとなった。以下は Muse の監査結果 (大津波警報・全区域 = 最も条件の厳しい表示で全域タイル確認):

- 構造面は健全: 線の途切れなし (オホーツクの途切れは割り込み埋めで解消)、区域境界の重なり・食い違いなし、東京湾内湾は湾奥まで描画される
- **残る見た目の問題**: 大津波幅 (7.4px) では狭い水域が色で埋まる — 有明海・八代海 (宇土半島周辺)、津軽海峡・陸奥湾、瀬戸内中心部、東京湾口。550px の図に 7.4px の線では物理的に避けにくいが、ユーザーは「ぐちゃぐちゃ」と評価している。改善するなら線幅ではなく図の変形 (水域の拡大) 側の検討が必要
- 細い半島 (宇土・富津など) では線が半島を包む帯になる
- ユーザーから個別指摘のあった箇所: 52. 有明・八代海 (線の形)、6. オホーツク海沿岸 (途切れ → 対策済みだが再確認推奨)
- パターン比較ページ (patterns) の 10 種は全て現行ビルダで再生成済み。既定は「0.9e 公差0.9+丸み+微小島・近接離島削除」

## 9. 検証方法 (必須)

- スクリーンショット: Playwright の chrome-headless-shell (`~/.cache/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell`、`--no-sandbox` 必須)。素の `--screenshot` は透過を白で潰すため、`telop/shotblue.html` (背景 #2060c0) 等のラッパー経由で撮る
- **数値検証だけで「直った」と言わない**。全体図を実フレームとして目視してから報告する (ユーザーの強い要求)
- 拡大 crop を作るときは対象の座標を path の bbox で裏取りしてから撮る (座標当てが何度も外れた)
- crop ページはアートを埋め込むため、再ビルドのたびに作り直す (古いアートのまま撮ってしまう事故が多発した)
- ボタン等の機能検証は、自動クリックして結果を DOM (document.title 等) に出して `--dump-dom` で読む方式が確実

## 10. ユーザーとの作業ルール

- 応答は簡潔・直接・結論先行。事実と推論を分ける。過剰な整形・謝罪の羅列は不要
- **検証は自分の仕事**。ユーザーにチェックの手間をかけさせない (確認ページを渡して済ませるな)
- 同じ対象の修正が 3 ターン続けて「不可」になったら、個別修正をやめて前提・やり方自体を疑う (ユーザーの明示ルール)
- 「できた」と出す前に、全体を 1 枚の絵として実物と見比べる
- マージ/デプロイはレビューして問題なければ都度承認なしで可 (ユーザーの 2026-10-30 決定)。ただし force push・main 直接 push・削除・権限変更は禁止

## 11. 関連ドキュメント

- `telop/docs/tsunami-minimap.md` — 津波ミニマップの全履歴と判断記録 (必読)
- `telop/docs/jma-eew-notes.md` — EEW の仕様・実測記録
- `telop/docs/okinawa-ogasawara-cases.md` — 沖縄・小笠原の発表事例
- `~/workspace/research_notes/tsunami-map-display-rules-20261108-1729/report.md` — 色統一の業界合意の調査 (色は気象庁仕様ではなく伊藤啓+CUDO と放送局の合意、2011 年移行)
