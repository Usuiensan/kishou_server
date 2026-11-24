# 常時再生デモ配信

デモは本番と同じ `atlas_service.py` を別プロセスで起動し、状態・ログを `/opt/kishou-server/runtime-demo`、入力を loopback の `127.0.0.1:8767`、RTSP publish を `rtsp://127.0.0.1:8554/bosai-demo` に分離する。`--no-live-sources` により `atlas_sources.js` は起動せず、`--test-mode` と `OVERLAY_TEST_MARK=1` により画面へ非実況表示を出す。

`tools/demo_feeder.js` は外部依存なしで、EEW とテロップを別タイマーで投入する。EEW は `jma-xml-corpus/real` の 2024-04-17 豊後水道の VXSE44（予報）と VXSE43（警報）を Wolfx 形式へ変換し、第1報・続報・最終値・取消を20秒間隔で交互に送る。テロップはリポジトリ内の `examples/demo-patterns/` にある VXSE51、VTSE 津波、VXSE 長周期のデモ用XMLを各120秒保持して取消する。デモ配信と `npm test` は同じXMLを使う。

## systemd 配置

実配置でリポジトリを `/opt/kishou-server` に置き、MediaMTX は `examples/mediamtx.production.example.yml` を読み込む。既存の MediaMTX サービスを再起動して `/bosai-demo` の追加設定を反映した後、次を実行する。

```sh
install -m 0644 deploy/atlas-demo.service /etc/systemd/system/
install -m 0644 deploy/demo-feeder.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now atlas-demo.service
systemctl enable --now demo-feeder.service
systemctl status atlas-demo.service demo-feeder.service
curl http://127.0.0.1:8767/health
```

視聴確認は `rtsp://<公開ホスト>:8554/bosai-demo` を使う。公開readのため、MediaMTX の認証・Firewall 方針は本番と同じく実配置で確認する。
