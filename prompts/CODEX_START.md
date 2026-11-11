# Codex開始指示 — 防災A2送出

`AGENTS.md`、`protocol/atlas-ii.md`、`README.md`を読み、最新のIssue #17を仕様正本にしてください。現行 `/bosai` はA2 colour32 v2専用です。Atlas v8とmetadata-v1は履歴参照のみとし、コード・設定・起動手順へ復活させないでください。

作業前に`git status`を確認し、ユーザーの既存変更を保護してください。既存パーサー、入力source、state、Rect設定、HTML/Chromium renderer、A2 packet、FFmpeg、MediaMTXを一つの送出経路として確認します。既存のJMA HTTPS API、PM2、Discord Bot、`ssl/`を二重起動・変更しないでください。

挙動変更では観測可能な要求を表すテストを追加し、関連する単体テストを実行します。セル起点、Rect範囲、MAIN_VIDEO寸法、入力鮮度、EEW/津波解除、RTSP readinessを確認してください。Unity/VRChat実機やWANは実機実行の証拠なしに確認済みと報告しません。

Windowsの運用経路は `tools/atlas_service.py` と `docs/03-streaming.md` のみを案内します。旧v8 senderや `/atlas` を起動例にしないでください。
