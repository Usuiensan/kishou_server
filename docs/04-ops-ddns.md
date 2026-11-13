# 04 自宅公開・Cloudflare DDNS・障害復旧

## ネットワーク構成

`examples/mediamtx.production.example.yml` はA2 `/bosai` の本番候補設定です。`0.0.0.0:8554` のRTSP/TCP listener、loopback限定publish、匿名read、API/metrics/pprof無効を設定します。readを匿名公開するため配信内容は誰でも視聴できます。`examples/mediamtx.yml` は旧ローカル試験資料で、現行サービス起動に使いません。VRChatで認証付きURLが受理されることは未確認です。

```
VRChat/AVPro --TCP 8554--> Cloudflare DNS-only A record --> home WAN IP --> ルーター port forward --> MediaMTX
                                       ^                              |
                                       |-- cloudflare-ddns.py <--------|
Web/管理画面は既存のCloudflare Tunnelのまま（本動画経路とは分離）
```

- `stream.example.com` のAレコードを **DNS only (proxied=false)** にする。Cloudflare Tunnelのホスト名やオレンジ雲のレコードと混ぜない。
- TTLは非Enterpriseなら60秒が最短。DNSキャッシュを無理に「必ず60秒で更新される」と扱わない。
- `AAAA`レコードはIPv6公開の動作を確認できるまで作らない。誤ったAAAAは一部端末の接続失敗につながる。
- IPv4で外部着信できる契約か調べる（CGNAT/DS-Lite/MAP-Eと利用可能ポート）。ルーターWAN IPと外向きIP比較。
- ルーター側でLAN固定IPのPCへ **8554/TCP**を転送する。ホストFWも同ポートだけ公開。管理API/メトリクスを外部へ開けない。
- 視聴者に自宅IPが公開される点を了承した設計。IPに含まれる地理・ISP推測も生じる。
- サーバーの端末接続に対して帯域・接続数の上限、メトリクスとエラー監視を設ける。

## DDNS

`examples/cloudflare-ddns.py` は最小構成のサンプル。Zone/Record/Token/Hostを環境変数で渡す。対象レコードのType= A、Name一致を検査し、グローバルIPv4だけ更新する。レコード変更時以外はPATCHしない。

`examples/systemd/` に service/timer のテンプレートを同梱。API Tokenを限定権限で発行し、`/etc/cloudflare-ddns.env`を権限600で保存する。hostnameは既存ドメインのサブドメインへ置き換える。

## IP切替のとき

1. ルーターが再起動し、WANに新IPが割り振られる。
2. DDNS監視が外部IPv4を検出してDNSのAレコードを更新する。
3. 既存のTCPコネクションは切れる。VRChatの再生は自動復旧が保証されない。
4. 新しいDNSを引き直した後にAVProを再ロードする必要がある。受信側の再試行・動画停止検出・手動再接続はクライアント担当と合意する。
5. DDNS更新時刻/外部検証での接続回復時刻/視聴者の実再生回復時刻をそれぞれ計測する。

## 安全な検証方法

- テストUIの **WAN / DDNS / Firewall診断** は、`stream.usuiensan.dev` のAレコード、`api.ipify.org` で観測した外向きIPv4、診断PCから配信ホストのTCP 8554への外向き接続を確認する。ルーター管理画面で読んだWAN IPv4を入力すると外向きIPv4と比較できる。外向きIPv4は照会先サービスへ送信され、UIの試験APIはloopback限定。
- この診断は受信Firewallやポート転送を判定しない。受信確認は自宅外の回線から行う。
- まずLAN内部でRTSPを再生し、その後**自宅外のネットワーク**（モバイル回線等）からTCP 8554と映像を確認する。
- リアルタイム運用前に、停電/プロセス停止/ルーター再起動/DDNS API失敗の障害訓練を行う。
- ポート開放だけ成功しても、VRChatのUntrusted URL/ワールド許可設定による接続失敗は別問題。
- 大量の負荷試験を実インターネット利用者や本番の公開IPに無断で実施しない。許可のあるクライアント環境で段階的に増やす。
