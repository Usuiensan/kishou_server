# A2診断・試験入力

通常配信の起動は `docs/03-streaming.md` を使います。診断APIはloopback限定で、通常起動時には無効です。

## 診断API付き起動

```powershell
python tools/atlas_service.py `
  --mediamtx C:\path\to\mediamtx.exe `
  --config examples/mediamtx.production.example.yml `
  --test-api
```

診断画面は `http://127.0.0.1:8766/`。APIはJMA/P2P入力状態、Rect layout、表示フラグ、子プロセス状態を表示します。

表示切替は描画の許可設定です。実際の表示はイベントの有無やL字表示などの条件にも依存します。レイアウトは選択後に「レイアウトを適用」を押します。画面内の映像確認にはMediaMTXのWebRTC/WHEPが必要です。上記の本番用設定例ではWebRTCを無効にしているため、映像確認は利用できません。

```powershell
python tools/atlas_test.py status
python tools/atlas_test.py layout reverseL
python tools/atlas_test.py event tests\samples\37_01_01_240613_VXSE43.xml
python tools/atlas_test.py reset
```

試験用layout `test-0-rects` と `test-15-rects` は同APIから選べます。実際の送出前に元の `activeLayout` へ戻してください。

## 主なloopback操作

- `POST /test/events`: JMA XMLまたはAtlasイベントを状態へ投入
- `POST /test/display`: A2 display sectionの表示bitを変更
- `POST /test/layout`: `examples/atlas-layouts.json` に定義されたRect planを選択
- `POST /test/fault`: 管理対象のMediaMTX、ingest、source、Renderer、A2 senderを停止/再開
- `POST /test/scenarios/run`: 時刻指定のevents/display/layout/reset/faultを順番に実行
- `GET /test/status`: ingest health、JMA/P2P鮮度、現在layout、シナリオ、子プロセスを取得

試験APIからのイベント注入は上流JMA/P2Pそのものの受信証拠にはなりません。実上流、RTSP `/bosai`、Unity/VRChat/Questの確認状況は別に記録します。
