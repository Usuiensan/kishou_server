# A2受け入れ状況

## AtlasテストUIの起動と操作

PowerShellでリポジトリのルートを開き、MediaMTX実行ファイルのパスを指定して起動します。試験APIを有効にするとJMA/P2Pのライブ入力は起動せず、試験専用の入力経路が使われます。

```powershell
python -B tools/atlas_service.py --mediamtx C:\path\to\mediamtx.exe --test-api
```

ブラウザーで `http://127.0.0.1:8766/` を開きます。終了するときは起動したPowerShellで `Ctrl+C` を押します。Atlas IIレイアウトと送出映像は実際のローカルサービスから取得され、テストUIのイベント投入は本番ingestとは分離されています。

画面は次の用途に分かれています。

- **表示切替・配信確認**: レイヤーの表示許可、WHEP/動画URLへの接続、受信A2検証、Atlas/Rect/合成映像の表示、PNG・録画・ログ保存、処理段階とプロセスの計測。
- **サンプル・自由生成**: EEW、津波、地震情報を投入します。津波66区域とEEW細分区域は検索・個別編集・一括編集ができ、シナリオ編集欄では試験イベントの順序や期待状態を設定します。
- **地図・回帰試験**: 津波66区域の独立プレビュー、順次表示、画像保存、保存済みシナリオの実行、停止・一時停止・再開、破損入力、仮想時計、リセットを操作します。
- **運用診断**: 子プロセス、入力鮮度、ログ、ネットワーク診断を確認します。WAN診断は送信元PCからのDNS/外向きTCP確認で、外部回線からの着信やFirewall通過を証明しません。
- **実機結果比較**: 参照PNGとWindows/Questの出力PNGをブラウザー内で比較し、差分とJSONを保存します。画像はサーバーへ送信されません。

UIの表示切替はイベントが実際に映像へ出ることを保証しません。WHEP受信にはMediaMTX側のWebRTC設定が必要です。独立した津波/EEWテスターと地図プレビューは本番ingest→Renderer→Senderの出力ではありません。Windows/Quest実機画像の比較、実JMAイベント、WAN着信、長時間・大規模負荷は別途実施し、未実施の結果を合格扱いしないでください。

## 自動テスト

- JavaScript単体テスト: `npm test`
- Python単体テスト: `$env:PYTHONUTF8='1'; python -B -m unittest discover -s tests -p 'test_*.py'`
- Atlasセル: 左下最初の8×8セル、行折返し、colour32、CRC、可変Atlas寸法1920×1088/1936×1168、データ帯とRectの干渉を確認
- Rect: COPY/ALPHA_PAIR、0件/15件、MAIN_VIDEO実寸、座標範囲、wire共通テストベクトルを確認
- 映像: CRF23/libx264/yuv420pの単一フレームencode/decode CRCテスト
- 状態: JMA XML、P2P code 556、EEW取消Event、津波解除、入力鮮度、レイアウト切替、Rendererの情報源未更新表示を確認
- 起動制御: MediaMTX設定、A2パケット容量、listener競合、RTSP DESCRIBE readiness、子プロセス復旧の単体テスト

## ローカル結合試験（2026-11-10）

`python tools/atlas_e2e.py --mediamtx <mediamtx.exe> --duration 12` をAtlas実寸1936×1168と1920×1088で実行。MediaMTX v1.21.3をloopbackだけにbindし、JMAサンプル4件とP2P code 556を投入して `/bosai` をRTSP/TCPで受信しました。

- ffprobe: H.264、yuv420p。1936×1168はlevel 5.0、1920×1088はlevel 4.0
- 各解像度で1fps復号した12フレーム中12フレームのA2 CRCが一致し、無効フレーム0
- 各解像度で復号パケットの0 Rect、15 Rect、reverseL（4 Rect）を確認
- EEW取消Eventと津波レイヤーが状態に残ることを確認
- 結果JSON/映像: `tests/results/atlas-a2-e2e/` と `tests/results/atlas-a2-e2e-1920x1088/`

## 未確認の受け入れ項目

- JMA AtomとP2P WebSocketの接続は結合試験中に成立しましたが、実イベント受信・内容照合は未確認。
- RTSP再接続、長時間配信、遅延/帯域は未計測。
- Windows/Quest VRChat AVProでのRect合成、実際のMAIN_VIDEO寸法、ALPHA_PAIR見え方、色情報セルCRCは未確認。
- WAN、DDNS、Firewall、ルーター復旧、長時間配信、視聴者別資源負荷は未確認。localhostの80視聴者同時接続は60秒試験で確認済み。
- Windows Task Schedulerへの実登録と再起動後の自動起動は未実施。登録/停止コマンドは `docs/03-streaming.md` に記載。

## Udon合成との目視比較

`python tools/atlas_composite_check.py` でRTSP `/bosai` または保存済みAtlasフレームを読み込み、A2を検証して1920×1080の参照合成PNGを作成できます。**連続表示を開始** するとRTSP接続を維持して毎秒2フレームで合成を更新し、無効フレームや切断時は最後の有効結果を表示し続けます。切断時は5秒間隔で再接続します。Unity比較用一式を `C:\FURUKAWA\ALCOM\chan-room-1\Assets\HCL\bosai\Tests\AtlasCompositeCheck` に保存した後、Unityで **HCL/bosai → Render Atlas Composite Check Bundle** を実行します。Unityの出力 `Artifacts/BosaiCompositeCheck-Udon.png` をアプリの **Udon合成PNGと比較** に読み込むと、差分画像と平均絶対差を表示します。

Unity側はbundle内のA2 packet bytesをUdon wire decoderで再decodeし、各Rectが一致した場合だけ、そのデコード結果をGPU合成シェーダーへ渡します。Atlas色セルのGPU readback、AVPro/Quest実機再生、色空間差、実動画入力寸法はこの静止比較だけでは検証できません。

AtlasテストUIの「Windows / Quest 実機結果の画像比較」では、bundleの `reference.png` と実機出力PNGを読み込み、Quest/Windows、AVPro/Udon、機種・ビルド情報を添えて比較結果JSONを保存できます。両画像は1920×1080 PNGに限定し、ブラウザー内で平均絶対差と差分画像を計算します。画像はサーバーへ送信しません。この機能は結果の記録・比較経路を提供するもので、実機再生を自動実行したり実機試験の合否を保証したりはしません。

## 旧記録の扱い

以前の20秒・1936×1168のRTSP記録は旧Atlas v8送出を使用していました。現在のA2結合試験とは分けて扱います。
