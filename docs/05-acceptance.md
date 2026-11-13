# A2受け入れ状況

## 自動テスト

- JavaScript単体テスト: `npm test`
- Python単体テスト: `$env:PYTHONUTF8='1'; python -B -m unittest discover -s tests -p 'test_*.py'`
- Atlasセル: 左下最初の8×8セル、行折返し、colour32、CRC、可変Atlas寸法1920×1088/1936×1168、データ帯とRectの干渉を確認
- Rect: COPY/ALPHA_PAIR、0件/15件、MAIN_VIDEO論理出力canvas、座標範囲、wire共通テストベクトルを確認
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
- WAN、DDNS、Firewall、ルーター復旧、80視聴者同時接続は未確認。
- Windows Task Schedulerへの実登録と再起動後の自動起動は未実施。登録/停止コマンドは `docs/03-streaming.md` に記載。

## Udon合成との目視比較

`python tools/atlas_composite_check.py` でRTSP `/bosai` または保存済みAtlasフレームを読み込み、A2を検証して1920×1080の参照合成PNGを作成できます。**連続表示を開始** するとRTSP接続を維持して毎秒2フレームで合成を更新し、無効フレームや切断時は最後の有効結果を表示し続けます。切断時は5秒間隔で再接続します。Unity比較用一式を `C:\FURUKAWA\ALCOM\chan-room-1\Assets\HCL\bosai\Tests\AtlasCompositeCheck` に保存した後、Unityで **HCL/bosai → Render Atlas Composite Check Bundle** を実行します。Unityの出力 `Artifacts/BosaiCompositeCheck-Udon.png` をアプリの **Udon合成PNGと比較** に読み込むと、差分画像と平均絶対差を表示します。

Unity側はbundle内のA2 packet bytesをUdon wire decoderで再decodeし、各Rectが一致した場合だけ、そのデコード結果をGPU合成シェーダーへ渡します。Atlas色セルのGPU readback、AVPro/Quest実機再生、色空間差、実動画入力寸法はこの静止比較だけでは検証できません。

## 旧記録の扱い

以前の20秒・1936×1168のRTSP記録は旧Atlas v8送出を使用していました。現在のA2結合試験とは分けて扱います。
