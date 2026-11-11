# Atlas II状態モデル

`createAtlasData()` はJMA/P2Pの一つの情報を `kind` (`eew` / `tsunami` / `intensity` / `vertical`)、`action` (`upsert` / `cancel`)、`event`、`payload` に変換します。`applyAtlasBulletin()` は同じ種別・イベントIDだけを更新し、他種別・別イベントを保持します。

EEW・津波は有効な取消が来るまでTTLで消さず、取得停止時に有効警報をゼロ化しません。EEW取消は短時間wireへ送るcancelled Eventとして60秒保持し、HTMLの有効警報表示とdisplay bitからは除外します。震度・縦見出しは従来どおり3時間後に期限切れになります。

`sourceHealth.jma` と `sourceHealth.p2p` は最終取得/接続状態、成功時刻、エラーを持ちます。A2送出timestampは毎フレームの時刻、JMA/P2P sourceHealthは元データ経路の鮮度、RTSP process/MediaMTX healthは送出状態を示します。RendererはJMA/P2Pのどちらかが停止または120秒以上未更新なら画面上に表示します。

`atlasIIConfig` は `examples/atlas-layouts.json` の設定を状態ファイルへ保存します。`atlasSize`、`mainVideoSize`、論理 `outputSize`、選択layout、完全Rect配列をA2 packetへ渡します。レイアウトは `full`、`reverseL`、`gate`、`reduced`、`alphaPair`。COPY/ALPHA_PAIRのsource範囲とAtlasデータセル非重複はencoder/参照decoderで検証します。

`telop/build_atlas.py` がHTMLを生成し、`atlas-live.js` は状態スナップショットから表示を合成します。HTMLの描画座標はデザイン基準1936×1168のまま、PNGは設定したAtlas実寸へ縮小/拡大してからA2データセルを描きます。

実情報の表示では、最大震度1以上の地震情報と有効な緊急地震速報を表示します。津波マップと津波線は津波警報または大津波警報がある場合だけ表示し、注意報のみの場合は隠します。上部テロップでは注意報の種類と対象地域を表示し、高さ不明の場合は予想高さの詳細行を描きません。

震度テロップは最新の地震情報だけを選び、概要・震源・震度別地域一覧を7.5秒ごとに切り替えて2周したら消します。同一地震の続報は、前回表示から変化した概要の行と追加・震度変更のあった地域だけを2周表示します。同じ内容の再受信や表示設定・津波表示の変更では再開せず、最新情報が期限切れになっても古い地震へ戻りません。この再生履歴はRendererの稼働中に保持します。大津波警報・津波警報は予報区を6件ずつ地図右側の表に表示し、7.5秒ごとに2周します。新しい続報で表示を最初から再開し、解除通知は15秒表示します。EEW/津波の取消イベントはA2 wireへ送信しながら、表示用の解除通知も保持します。
