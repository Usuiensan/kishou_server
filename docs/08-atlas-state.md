# Atlas II状態モデル

`createAtlasData()` はJMA/P2Pの一つの情報を `kind` (`eew` / `tsunami` / `intensity` / `vertical`)、`action` (`upsert` / `cancel`)、`event`、`payload` に変換します。`applyAtlasBulletin()` は同じ種別・イベントIDだけを更新し、他種別・別イベントを保持します。

EEW・津波は有効な取消が来るまでTTLで消さず、取得停止時に有効警報をゼロ化しません。EEW取消は短時間wireへ送るcancelled Eventとして60秒保持し、HTMLの有効警報表示とdisplay bitからは除外します。震度・縦見出しは従来どおり3時間後に期限切れになります。

EEW 警報級エントリの保持時間は固定秒数ではなく、その報のアナウンス（音声メッセージ）の終了+10秒です（`lib/atlasData.js` の `eewRetentionMs`）。受信時に `lib/eewAudio.js` のプレイリスト構築規則と `lib/eewAudioDurations.js`（パーツ実尺の実測一覧、`tools/export_eew_voice.js` が再生成）から総尺を求めてエントリへ `retentionMs` として確定し、`pruneAtlasSnapshot()` はそれを使います。続報が来れば続報のアナウンスで再計算されます。音声の鳴らない予報級は従来どおり30秒、取消は上記の60秒保持のままです。

## 表示基準ゲート（2026-11-24 ユーザー決定）

`applyAtlasBulletin()` は本番モード（`testMode` でなく訓練でもない）でのみ、次を状態に入れません。テスト・訓練は従来どおり全件入ります。

- EEW: 予報級で予想最大震度が3以下（`lib/eewAnnounce.js` の投稿基準の震度集合＝不明・4・5弱・5強・6弱・6強・7 に入らない）。一度表示した EEW の続報は予想が下がっても受け続けます。表示していない EEW の取消も入れません。
- 地震情報（`intensity` / `vertical`）: 実震度1・2だけのもの。ただし長周期地震動を含む場合と、その地震の EEW が表示・投稿に出た場合は入れます。表示中のイベントの続報・取消は従来どおり受けます。

状態に入った EEW のイベント ID はスナップショットの `eewOutputEvents`（イベント ID → 受信時刻、24時間保持）に記録され、後続の地震情報の判定と、画像 Webhook（`tools/overlay_archiver.py` が同じ記録を読む）の判定に使われます。Discord テキスト Webhook 側は `jma_server.js` が `EewTracker` の投稿済み記録から同じ意味の `eewPosted` を付け、`lib/discordWebhook.js` が判定します。

`sourceHealth.jma` と `sourceHealth.p2p` は最終取得/接続状態、成功時刻、エラーを持ちます。A2送出timestampは毎フレームの時刻、JMA/P2P sourceHealthは元データ経路の鮮度、RTSP process/MediaMTX healthは送出状態を示します。RendererはJMA/P2Pのどちらかが停止または120秒以上未更新なら画面上に表示します。

## EEWの追加情報源（Axis / Wolfx / ProjectBS）

`tools/atlas_sources.js` はJMA/P2Pに加えて次の3源からEEWを受信し、`lib/parsers/eewJson.js` でJMA XMLと同じ内部形式へ変換して ingest の `POST /eew` へ渡します。同一イベントID・発表時刻・報数で既存経路と重なった場合は `applyAtlasBulletin()` の規則で新しい報だけが残ります。訓練報は取り込みません。`sourceHealth` には `axis` / `wolfx` / `projectbs` が報告された場合だけ加わり、Rendererは直近10分以内に報告があった任意源だけを未更新判定の対象にします。切断時の再接続は5秒から最大300秒まで間隔を広げます。

震度速報は Wolfx の `jma_eqlist` から VXSE51 の詳細を取得し、発表時刻10分以内かつ `issued` の報だけを `wolfx-eq` 経路へ送ります。JMA と意味内容が同一なら既存の比較で自動的に無変更となります。

- **Wolfx**（登録・認証不要）: `wss://ws-api.wolfx.jp/all_eew` へ接続し `query_jmaeew` を送ります。`type: jma_eew` だけを取り込み、心拍には `ping` で応答します。区域は `WarnArea`（警報対象地域の一覧）を優先し、無い場合は生電文のEBIセグメントから取ります。利用条件は Wolfx Project のサービス条款に従い、自サーバーでの処理・表示は同条款第6条の通常利用に当たります（独立したデータ再提供は事前許可が必要）。
- **ProjectBS**（登録・認証不要）: `wss://telegram-cf.projectbs.cn/jmaeewws/` へ接続し `queryjson` を送ります。心拍のたびに `queryjson` で最新報を問い合わせます。なお2026-11-12時点で接続先はCloudflareのチャレンジ応答になっており、運営側の資料でも同APIは終了扱いのため、実データが流れない場合があります（接続自体は継続し、回復すれば自動で取り込みます）。
- **Axis**（Prioris、無料登録必須・非商用のみ・再配信不可）: 環境変数 `AXIS_TOKEN` がある場合だけ接続します。登録は https://axis.prioris.jp/ で行い、ログイン後の Channel で `eew` と `jmx-seismology` を選択し、Access Token のページでトークンを取得します。`jmx-seismology` の電文（XML）はそのまま `POST /jma` へ中継します。トークンの有効期限は約1か月で、`AXIS_TOKEN_FILE` にファイルパスを指定すると月末まで7日未満の時期に1日1回だけ公式リフレッシュAPIで更新し、同ファイルへ保存します（権限0600）。ファイルがあれば起動時はそちらを優先します。トークン自体をリポジトリやログへ保存しません。

`atlasIIConfig` は `examples/atlas-layouts.json` の設定を状態ファイルへ保存します。`mainVideoSize` はローカル動画テクスチャの寸法、`outputSize` はA2 Rectの論理キャンバス寸法として分けて扱います。選択layoutと完全Rect配列をA2 packetへ渡し、MAIN_VIDEO Rectのsource/alpha座標は `outputSize` 上で検証します。レイアウトは `full`、`reverseL`、`gate`、`reduced`、`alphaPair`。COPY/ALPHA_PAIRのsource範囲とAtlasデータセル非重複はencoder/参照decoderで検証します。

試験API（`--test-api`）付きで起動したingestは、状態へ `testMode: true` を記録します。Rendererは `testMode` の間だけ、Atlas下部の余白（全Rectのsource範囲の外）に「【実際の情報ではありません】」を表示します。通常起動では記録されず、表示もしません。

`telop/build_atlas.py` がHTMLを生成し、`atlas-live.js` は状態スナップショットから表示を合成します。HTMLの描画座標はデザイン基準1936×1168のまま、PNGは設定したAtlas実寸へ縮小/拡大してからA2データセルを描きます。

実情報の表示では、最大震度1以上の地震情報と有効な緊急地震速報を表示します。津波マップと津波線は津波警報または大津波警報がある場合だけ表示し、注意報のみの場合は隠します。上部テロップでは注意報の種類と対象地域を表示し、高さ不明の場合は予想高さの詳細行を描きません。

津波の同一イベントで前号よりレベルが下がった予報区は、一覧、変更、津波観測、各地域の詳細の順に表示します。変更は旧レベルと新レベルの組ごとに、見出しと区域名の2行で表示します。

上部テロップでは、津波を先頭の1ブロックに置き、その下に地震を最大3ブロックまで並べます。各ブロックは最大2行です。地震は表示対象になった順に並び、4件目以降は空きを待ちます。各地震は概要、震度別地域一覧、長周期地震動の順に2周します。続報を受け取った地震は、次のページ境界から最新の全ページを表示し直します。縦見出しは先頭の地震に対応します。津波は有効なフレームがある間は表示を続け、更新時は可能な範囲でページ位置を維持します。

全ブロックは同時にページを進めます。表示時間はページを表示するときに本文、ルビ、地点数、地点と値の組数から求め、5〜12秒の範囲で0.5秒単位にします。本文の文字数からは空白や区切り記号を除き、時刻や小数の表記に含まれる記号は数えます。警報級EEWのボックスをイベントごとに初めて表示したときは、そのページの締切を2秒延長します。延長後の上限は14秒です。表示内容の更新とブロックの詰め直しはページ境界で行います。

地図右側の大津波警報・津波警報の表は、予報区を6件ずつ7.5秒ごとに2周表示します。新しい続報があると最初から表示します。EEW・津波の取消イベントはA2 wireへ送り、津波の解除通知は保持期間中に上部テロップで表示します。

## 受信XML電文のアーカイブ

`tools/atlas_ingest.js` は `POST /jma` で受け取ったXMLを、パース結果（受理・filtered・却下）にかかわらず受信バイトのまま保存する（`lib/jmaXmlArchive.js`）。保存対象はサーバーが表示処理のために受信している種別（フィードの表示対象種別と Axis リレー）だけで、アーカイブのために追加の種別は取得しない。保存先は既定で state ファイルと同じディレクトリの `jma-xml/` で、`--xml-archive-dir` で変更できる。ファイル名は受信時刻（UTC・ミリ秒）と本文のSHA-256だけで構成し、同一内容は1件だけ残す。合計が上限（既定500MB。対象種別の平常時実測 約0.083MB/日で約10年分＋大規模イベント年の余裕）を超えたら最古から削除する。保存は有界の非同期キューで直列化し、取り込み応答を待たせない。保存先ファイルシステムの空きが下限（既定1GB、`--xml-archive-min-free-bytes`）を割ると、状態ファイルの書き込みを守るため保存を打ち切る。欠落は理由別にログへ計数する。

リポジトリ内の `jma-xml-corpus/` は実装・検証用の静的な参照セットで、この自動アーカイブとは別管理である。
