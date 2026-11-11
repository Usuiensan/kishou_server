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

画面のサンプル投入には、既存XMLの総合例に加えて「単一区域・津波注意報／津波警報／大津波警報」があります。これらは試験用の `bulletin` を `kind: "tsunami"` と組み合わせて送るため、現在の運用状態をリセットせず、同じ試験イベントIDの津波レイヤーを置換します。予報区は区域表の66区域から選べます。

EEWは「第1報 → 続報 → 取消」の順にボタンを押すと、同一電文系列の状態遷移を確認できます。震度速報は独立した既存XMLを投入します。これらのボタンも運用状態をリセットせず、試験APIへイベントを追加します。

試験APIからのイベント注入は上流JMA/P2Pそのものの受信証拠にはなりません。実上流、RTSP `/bosai`、Unity/VRChat/Questの確認状況は別に記録します。
