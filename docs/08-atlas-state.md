# Atlas II状態モデル

`createAtlasData()` はJMA/P2Pの一つの情報を `kind` (`eew` / `tsunami` / `intensity` / `vertical`)、`action` (`upsert` / `cancel`)、`event`、`payload` に変換します。`applyAtlasBulletin()` は同じ種別・イベントIDだけを更新し、他種別・別イベントを保持します。

EEW・津波は有効な取消が来るまでTTLで消さず、取得停止時に有効警報をゼロ化しません。EEW取消は短時間wireへ送るcancelled Eventとして60秒保持し、HTMLの有効警報表示とdisplay bitからは除外します。震度・縦見出しは従来どおり3時間後に期限切れになります。

`sourceHealth.jma` と `sourceHealth.p2p` は最終取得/接続状態、成功時刻、エラーを持ちます。A2送出timestampは毎フレームの時刻、JMA/P2P sourceHealthは元データ経路の鮮度、RTSP process/MediaMTX healthは送出状態を示します。RendererはJMA/P2Pのどちらかが停止または120秒以上未更新なら画面上に表示します。

## EEWの追加情報源（Axis / Wolfx / ProjectBS）

`tools/atlas_sources.js` はJMA/P2Pに加えて次の3源からEEWを受信し、`lib/parsers/eewJson.js` でJMA XMLと同じ内部形式へ変換して ingest の `POST /eew` へ渡します。同一イベントID・発表時刻・報数で既存経路と重なった場合は `applyAtlasBulletin()` の規則で新しい報だけが残ります。訓練報は取り込みません。`sourceHealth` には `axis` / `wolfx` / `projectbs` が報告された場合だけ加わり、Rendererは直近10分以内に報告があった任意源だけを未更新判定の対象にします。切断時の再接続は5秒から最大300秒まで間隔を広げます。

- **Wolfx**（登録・認証不要）: `wss://ws-api.wolfx.jp/all_eew` へ接続し `query_jmaeew` を送ります。`type: jma_eew` だけを取り込み、心拍には `ping` で応答します。区域は `WarnArea`（警報対象地域の一覧）を優先し、無い場合は生電文のEBIセグメントから取ります。利用条件は Wolfx Project のサービス条款に従い、自サーバーでの処理・表示は同条款第6条の通常利用に当たります（独立したデータ再提供は事前許可が必要）。
- **ProjectBS**（登録・認証不要）: `wss://telegram-cf.projectbs.cn/jmaeewws/` へ接続し `queryjson` を送ります。心拍のたびに `queryjson` で最新報を問い合わせます。なお2026-11-12時点で接続先はCloudflareのチャレンジ応答になっており、運営側の資料でも同APIは終了扱いのため、実データが流れない場合があります（接続自体は継続し、回復すれば自動で取り込みます）。
- **Axis**（Prioris、無料登録必須・非商用のみ・再配信不可）: 環境変数 `AXIS_TOKEN` がある場合だけ接続します。登録は https://axis.prioris.jp/ で行い、ログイン後の Channel で `eew` と `jmx-seismology` を選択し、Access Token のページでトークンを取得します。`jmx-seismology` の電文（XML）はそのまま `POST /jma` へ中継します。トークンの有効期限は約1か月で、`AXIS_TOKEN_FILE` にファイルパスを指定すると月末まで7日未満の時期に1日1回だけ公式リフレッシュAPIで更新し、同ファイルへ保存します（権限0600）。ファイルがあれば起動時はそちらを優先します。トークン自体をリポジトリやログへ保存しません。

`atlasIIConfig` は `examples/atlas-layouts.json` の設定を状態ファイルへ保存します。`mainVideoSize` はローカル動画テクスチャの寸法、`outputSize` はA2 Rectの論理キャンバス寸法として分けて扱います。選択layoutと完全Rect配列をA2 packetへ渡し、MAIN_VIDEO Rectのsource/alpha座標は `outputSize` 上で検証します。レイアウトは `full`、`reverseL`、`gate`、`reduced`、`alphaPair`。COPY/ALPHA_PAIRのsource範囲とAtlasデータセル非重複はencoder/参照decoderで検証します。

試験API（`--test-api`）付きで起動したingestは、状態へ `testMode: true` を記録します。Rendererは `testMode` の間だけ、Atlas下部の余白（全Rectのsource範囲の外）に「【実際の情報ではありません】」を表示します。通常起動では記録されず、表示もしません。

`telop/build_atlas.py` がHTMLを生成し、`atlas-live.js` は状態スナップショットから表示を合成します。HTMLの描画座標はデザイン基準1936×1168のまま、PNGは設定したAtlas実寸へ縮小/拡大してからA2データセルを描きます。

実情報の表示では、最大震度1以上の地震情報と有効な緊急地震速報を表示します。津波マップと津波線は津波警報または大津波警報がある場合だけ表示し、注意報のみの場合は隠します。上部テロップでは注意報の種類と対象地域を表示し、高さ不明の場合は予想高さの詳細行を描きません。

震度テロップは最新の地震情報だけを選び、概要・震源・震度別地域一覧を7.5秒ごとに切り替えて2周したら消します。同一地震の続報は、前回表示から変化した概要の行と追加・震度変更のあった地域だけを2周表示します。同じ内容の再受信や表示設定・津波表示の変更では再開せず、最新情報が期限切れになっても古い地震へ戻りません。この再生履歴はRendererの稼働中に保持します。大津波警報・津波警報は予報区を6件ずつ地図右側の表に表示し、7.5秒ごとに2周します。新しい続報で表示を最初から再開し、解除通知は15秒表示します。EEW/津波の取消イベントはA2 wireへ送信しながら、表示用の解除通知も保持します。
