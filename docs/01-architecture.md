# 01 構成・責務分離

```
JMA sample XML / local producer
          | HTTP POST /jma (loopback only)
          v
 tools/atlas_ingest.js ----> state.json (independent EEW/tsunami/intensity/vertical layers)
          |                                  |
          |                                  v
          |                         atlas-live.js + existing telop components
          |                                  |
          |                         Chromium stage capture (persistent)
          |                                  v
          |                           RGB PNG 1936x1168
          |                                  |
          +--------------------------> atlas_sender.py + metadata-v1
                                             | raw RGB frames
                                             v
                                      FFmpeg H.264 VBR
                                             | RTSP/TCP publish
                                             v
                              MediaMTX (loopback-only by default)
                                             |
                                local FFmpeg/VLC playback
```

## 正しいプロセス境界

- 送出サービスは別プロセス。稼働中の `jma-api`、本体 `main`、`ssl/` を変更しない。
- XML入力はloopback HTTP受け口。上流のJMA自動取得はまだ接続していない。
- `atlas_ingest.js` は既存パーサーを使い、受信電文の種別レイヤーだけ更新する。1秒ごとに種別別TTLを適用する。
- `atlas-live.js` は既存のEEW・津波描画関数を呼び、EEW、津波、震度、縦見出しを合成する。
- Rendererは一つのChromiumを維持してStage全体をキャプチャする。状態JSONは1秒間隔で取り込み、30fpsのPNG更新を行う。
- `atlas_sender.py` は画面の実変化でsequenceを進め、毎フレームtimestampを付け、metadata-v1を各フレームの3行へ埋め込む。
- `atlas_service.py` がMediaMTX、入力、Renderer、senderを監視し、終了時に指数バックオフで再起動する。ログは5MB×3世代でローテーションする。
- `atlas_service.py --test-api` を明示した場合だけ、loopback限定の試験操作APIを8766番で起動する。XML/合成イベントは通常の状態適用経路へ流し、mode/flagsはsenderの状態サイドカーへ反映する。シナリオ中もRenderer・FFmpeg・RTSPは継続し、障害再現を選んだ場合だけ対象子プロセスを停止・再開する。
- MediaMTXの初期設定はloopback bind/read/publishに限定。WAN公開・DDNSはこのローカルパイプラインに含めない。

## 通常/異常

| 条件 | 動作 |
|---|---|
| 新しいJMA電文 | 対象レイヤーだけ更新。他レイヤーは保持 |
| EEW続報・取消 | EEWイベントのみ更新・削除 |
| 表示期限切れ | 各レイヤーのTTLに従って独立して削除 |
| XML入力が途絶 | 古い状態を保持し、期限切れ後にそのレイヤーだけ消す |
| 子プロセス異常終了 | `atlas_service.py` が最大60秒の指数バックオフで再起動 |
| WAN/VRChat接続 | 今回未検証。外部公開と受信機実機は別工程 |

デモ用の擬似警報は実配信と混同しない。CRCは伝送誤り検知であり、署名・送信者認証ではない。
試験APIは試験配信でのみ有効化し、通常運用では無効のままにする。
