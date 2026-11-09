# 05 受け入れ条件・計測表

## Gate A: 通信契約

- atlas 1936×1168、v8各領域の境界ピクセルを自動検証
- 24Bパケットの little-endian field, magic/version/CRC32を送受で一致
- 3複製のうち1つが壊れても残りを復号でき、3つとも破損なら破棄
- 8×8セルの整数座標と中央サンプリングでRGB→nibbleを復元
- 1秒timestampが進み、sequenceは変化時だけ進む（32bit wrap時の取り扱いを別試験）

## Gate B: 映像品質

- H.264 yuv420pで固定フレーム群をencode/decode、全フレームpacket CRCが合格
- CRF=18/23/28、可能なら`maxrate=500k/1000k/3000k`でビット誤り・表示領域の画質を比較
- 静止・文字だけ変更・警報地図変更・全画面の急更新を混ぜて測る
- 30fpsと15fpsで、CPU/GPU負荷とbitrate/映像遅延を比較
- 検証条件: ffmpegバージョン、codec、パラメータ、入力動画SHA256、フレーム数、ビット誤り数を記録

## Gate C: ライブ配信

- FFmpeg→MediaMTX(localhost)→VLC/FFmpegのRTSP/TCP再生
- Windows VRChat AVProが`rtspt://`で再生できるか別途実機検証
- 映像上にパケット更新が即反映され、再接続後も復旧
- 実測の遅延p50/p95、RTSP再接続所要時間、途切れた時間を記録

## Gate D: 運用

- Public/Group Publicのドメイン許可 + Untrusted URLsの確認
- DNS-only/DDNS：IP変更→Aレコード更新→外部接続回復の時間を測定
- ルーター公開はTCP 8554のみ、publish権限はlocalhost、管理APIは非公開
- 20/40/80接続の帯域を測り、平時と最大更新時のピークを算出
- ニュース/警報の取消・訂正、APIエラー、データ欠落、停電復旧の状態遷移を試験

## 測定記録テンプレート

| 収録日時 | 解像度/FPS | CRF/Maxrate | 平時Mbps | 更新時ピークMbps | CRC成功率 | p95遅延 | 接続数 | 備考 |
|---|---|---|---:|---:|---:|---:|---:|---|
| 未測定 | 1936×1168/30 | 23/3000k | — | — | — | — | — | VRChat実機未実施 |

## 実測（2026-11-09、ローカルE2E）

`tools/atlas_e2e.py` にて Chromiumで描画した実アトラスへ、EEW→津波→震度・縦見出し→EEW続報→EEW取消→津波続報のサンプルXMLを連続投入し、RTSP/TCPを1接続のまま20秒録画した。

| 項目 | 結果 |
|---|---:|
| 受信録画 | 20秒、586フレーム（実測29.3fps） |
| H.264 | High、1936×1168、yuv420p、Level 5.0、B-frame 0 |
| メタデータ | 1,758行を個別CRC検証、1,758行成功、復旧対象行0 |
| シーケンス | 表示更新に伴い1〜19 |
| 平均 / 1秒ピーク | 692 kbps / 1,386 kbps |
| 復号映像と最終HTML画像の差 | 灰度平均絶対誤差 4.96/255（データ帯除外） |
| 最終状態 | EEW 0、津波 1、震度 1、縦見出し 1。EEW取消で他レイヤーは残存 |

録画 `tests/results/atlas-e2e/atlas-rtsp.mkv`、代表画像 `01-eew.png`〜`06-tsunami-update.png`、全計測・行別CRC記録 `atlas-e2e.json` は同ディレクトリに生成される。ここは `.gitignore` 対象の再生成物。

未計測: CPU/メモリ、長時間連続運転、15fps比較、描画から受信までの遅延分布、WAN、VRChat実機。XMLの自動取得も別途必要で、今回の入力は既存サンプルXMLをloopback受け口へPOSTしたもの。

常駐運用のスモークでは、`atlas_service.py` 配下のsenderプロセスを強制終了し、2秒後に新sender PIDが起動してRTSP publishへ戻ることを確認した。Ctrl+Cの停止後、RTSP 8554/TCPとXML受け口8765/TCPのlistenが終了した。

「H.264でCRC成功」「自宅LAN再生成功」「外部WAN成功」「VRChat AVPro成功」はそれぞれ別の検証段階であり、混ぜない。
