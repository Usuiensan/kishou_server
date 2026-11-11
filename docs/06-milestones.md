# 06 Codex開発タスク分割

> 旧24B/Atlas v8/M0-M5計画の履歴資料。現在の仕様や完了証拠には使わない。現行A2の検証状況は `docs/05-acceptance.md`、起動手順は `docs/03-streaming.md` を参照。

## 2026-11-09 実装状況

- M0〜M3: 完了。実HTML、JMAサンプルXML、24Bメタデータ、FFmpeg、MediaMTXのloopback RTSP/TCPまで通し試験済み。
- M4: 未実施。設定はloopback限定の安全な初期値。DNS、WAN bind、ルーター、トークン、外部クライアント未設定。
- M5: 一部未実施。ローカル受信録画で映像・メタデータを確認。VRChat/AVPro、相互運用、長時間・多数接続の試験は未実施。
- JMA XML常時取得: 未実装。現状は別プロセスのloopback `/jma` へXMLをPOSTする接続口。

## M0: 足場
既存レポジトリ現物を確認、`telop/HANDOFF-CODEX.md` を読み、利用可能ファイルと未提供ファイルを明記。入力API/テロップのインターフェースを一覧化。`test`が走る環境を構築。

## M1: 配信ビットの実装
送出側に `protocol/metadata-v1.md` と完全一致する生成器。3行描画、CRC検証、状態変更時のみsequence、1秒timestamp。アトラスPNGと圧縮往復試験。

## M2: 本物のアトラス生成
`build_atlas.py`/`atlas-1080-v8.html`（実物入手後）と連携。既存EEW・津波テロップ素材を取り込む。座標・RGBA/輝度・画像目視を試験。ビルダがない場合はその旨を記録しM1を先に完成。

## M3: RTSPライブ送出
FFmpeg長寿命プロセス、MediaMTX、VBR/x264、ローカル再生、連続再起動。設定変更なしで静止時の帯域が自動低下することを実測。

## M4: インターネット公開/DDNS
Cloudflare DNS-onlyのAレコードを作成（ユーザーのドメイン名が必要）、最小権限トークンでDDNS。外部からRTSP/TCPを視聴。WAN IP変更から復帰まで測定。

## M5: 運用と相互運用
VRChat受信チームとテストベクトル一致、AVProで再生・表示制御、負荷試験、文字視認性、タイムスタンプ鮮度検証、障害訓練。見つかった不整合をv1互換性を保って修正。

同時開発可能範囲: M1とM2、M3/ネットワークのローカル準備。共通protocolの変更だけは送受両担当で合意する。
