# Codexへ最初に送る指示（そのまま貼り付け用）

あなたは「VRChat防災アトラス **送出サーバー側**」の実装担当です。VRChat/Unityの受信実装は担当外です。添付ZIPの `AGENTS.md` を読み、`protocol/atlas-v8.md`, `protocol/metadata-v1.md` を通信仕様の正本として扱ってください。

今回の作業範囲：`Usuiensan/kishou_server` の `telop-mock` にある既存HTML/JS素材や `/api/v2/latest` などの出力を流用し、自宅PCでH.264/RTSPTライブ送出できるサービスを別プロセスとして構築する。`telop/HANDOFF-CODEX.md` と `telop/docs/` を必ず確認し、既存の描画ロジックを作り直さない。稼働中のmainやPM2 `jma-api`、`ssl/`へ変更を加えない。

**初回タスク（完了まで実装して試験する）**

1. リポジトリ/実ファイルを調査する。`atlas-1080-v8.html`と`build_atlas.py`の有無を確認し、無ければ報告する。
2. `reference/metadata_demo.py` と `protocol/metadata-v1.md` に合わせ、v8アトラス画像に24バイトの状態パケットを3重埋め込みする送信モジュールを実装する。勝手な新プロトコルは作らない。
3. 左上原点で座標整合性を試験し、合成フレームをPNGへ出力する。`yuv420p`でH.264圧縮・復号後にCRC/フィールドを一致させる。試験条件を固定して報告する。
4. MediaMTXへのFFmpeg RTSP/TCP送出を作る（ローカルループで再生可能）。画質ベースのVBR、Bフレーム無効、1秒GOP、Level 5.0で始める。平時/表示変更時の実ビットレートをffprobeで測定する。
5. 実装とテスト、検証ログ、残課題をまとめる。VRChat実機試験、WANからの接続、DDNS更新は別工程として明示する。

既存の仕様/ファイルに不足があれば該当箇所と妥当な仮実装を分離して進める。大規模な事前調査だけで作業を終えず、最小送出パイプラインとテストを完成させる。
