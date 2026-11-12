# 津波警報状態での地図3コピー表示・capture計測

実施日: 2026-11-12  
ブラウザー: Chrome 156.0.8078.80  
入力: 試験UIの津波警報生成関数で作成した宮城県・警報・3m・「すぐ来る」のtestMode snapshot。JMA/P2Pや本番ingestは使用していない。

## 結果

| 測定項目 | 実測 |
| --- | ---: |
| capture指定間隔 | 33.333 ms（約30 FPS） |
| Chromium capture FPS | 12.56 FPS |
| capture間隔 | 平均79.60 ms、最大101.44 ms、p95 85.54 ms |
| screenshot処理時間 | 平均69.54 ms、最大86.09 ms、p95 77.41 ms |
| rolling window | 126 samples（約10秒） |
| 点滅animation数 | 42（右下14、左帯14、アルファミラー14） |
| 点滅周期 | 3000 ms（ON 2253 ms、OFF 747 ms） |
| capture時の表示 | 42/42 animationが期待phaseと一致 |
| 位相ドリフト / 3コピー間位相差 | avg/max/p95 すべて0 ms |
| PNG→RGB変換時間 | 変更のあった15フレーム、平均45.74 ms、最大/p95 76.06 ms |

PNG→RGB側のFPS・間隔は変更フレームの出力頻度を表すため、連続変換能力のFPSとして扱わない。30FPS指定に対してcaptureは12.56FPSで、目標に届かなかった。

## 修正内容と確認

実測前はCSSで`#tsunami-mini-left`を`display:none`にした後、表示時にinline styleを空文字へ戻していた。空文字ではCSSの`display:none`が残り、左帯地図が隠れていた。表示時に`display:block`を指定するよう修正した。

修正後のChrome captureで左帯地図を目視し、3グループ各14 animation、計42 animationを測定した。計測は各capture直前にUnix時計へ位相を同期しているため、0msはこの同期後の位相一致を示す。長時間・実RTSP/WHEP配信の累積ドリフトや受信側の動作は未確認。

関連検証:

- `python -B telop/build_atlas.py`
- `node --test tests/atlas_builder.test.js tests/atlas_live.test.js` — 10/10 passed
- `python -B tools/render_atlas.py ... --watch --interval-ms 33.333 ...` — testMode津波snapshotで実行。測定取得後、Ctrl+Cで停止。

画像: [tsunami-alert-three-map-copies.png](tsunami-alert-three-map-copies.png)
