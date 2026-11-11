# A2送出アーキテクチャ

本番ストリーム `/bosai` はAtlas II / A2 colour32 v2のみを送ります。Atlas v8、24B metadata、旧senderは本番の起動経路から除外しています。

```text
JMA Atom ─┐
          ├─ tools/atlas_sources.js ── loopback ── tools/atlas_ingest.js
P2P WS ───┘                                        │
                                                  ├─ atlas-state.json
                                                  │    ├─ sourceHealth (JMA/P2P)
                                                  │    └─ atlasIIConfig (Rect plan/寸法)
                                                  ▼
                                   Chromium renderer → RGB Atlas PNG
                                                  ▼
                                    A2 packet + lower-left colour32
                                                  ▼
                                     FFmpeg libx264 CRF23/yuv420p/TCP
                                                  ▼
                                        MediaMTX RTSP `/bosai`
```

- `tools/atlas_service.py` はMediaMTX、ingest、独立JMA/P2P収集器、Renderer、A2送出器を起動し、子プロセスを指数バックオフで再起動します。停止時は子プロセスツリーを終了します。
- `tools/atlas_sources.js` はJMA Atom feedを30秒ごとに取得し、EEW・地震・津波の対象XMLを既存パーサーへ渡します。P2P WebSocketはcode 556だけを転送します。`jma_server.js`、Discord Bot、HTTPS APIは起動せず、副作用を分離します。
- `tools/atlas_ingest.js` はJMA/P2Pを種別別状態へ統合します。津波・EEWは入力断で自動解除せず、明示解除をA2に送ります。取消EEWはcancelled Eventとして60秒保持します。
- JMA/P2Pそれぞれの成功・切断時刻を保存します。Rendererは120秒以上更新されない入力源を画面上で未更新と表示します。A2 timestampは毎フレーム更新し、sequenceは送出状態の変化でのみ増えます。
- `examples/atlas-layouts.json` に `activeLayout`、MAIN_VIDEO実寸、出力論理解像度、Atlas実寸とRect配列を記述します。`full`、`reverseL`、`gate`、`reduced`、`alphaPair` に加えて0/15 Rect試験構成があります。
- `tools/render_atlas.py` は既存の防災テロップデザインを1936×1168で描画し、設定したAtlas解像度へ再サンプルします。A2データセルはその後、左下x=0,y=0から上へ配置されます。
- `tools/atlas_ii.py` はRectと表示/EEW/津波状態を完全パケットにし、CRC32後にセル化します。各フレームに完全状態が入り、FFmpegはCRF23・yuv420p・RTSP/TCPでMediaMTXへ送ります。
- MediaMTXは外部8554/TCP read、loopback限定publish、管理API無効です。公開readの映像は誰でも取得できます。

## 検証境界

ソース単体テスト、colour32/H.264復元テスト、RTSP結合テスト、外部WAN、VRChat Windows/Quest実機は別々の検証段階です。現在の未実施項目はREADMEと `docs/05-acceptance.md` に記録します。
