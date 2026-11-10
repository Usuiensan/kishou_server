# グローバル AGENTS.md

## 適用範囲と優先順位

本書はこのプロジェクトの標準ルール。個別依頼、最新のIssue/仕様に具体要件がある場合はそちらを優先する。過去資料より最新のユーザー決定を優先する。

## 基本方針

正しさ、単純さ、保守性を優先する。現在の要件を満たす最小変更を行い、将来の可能性だけで仕組みを増やさない。作業は合理的な前提で自律的に完了し、結果を左右する不明点を確認する。

## A2送出の正本と境界

- 本番 `/bosai` は Atlas II / A2 colour32 v2だけを送出する。正本は `protocol/atlas-ii.md`、区域表、共通ベクトル、参照デコーダー。
- 8×8セルは左下端余白0pxから配置する。最小幅640px、Atlas幅/高さ16pxの倍数、完全状態packet、28B header、最大15 Rect、CRC32を維持する。
- 旧Atlas v8とmetadata-v1は歴史資料として扱い、本番コード、起動、RTSP URL、現在の運用手順に使わない。旧方式との互換やフォールバックを追加しない。
- `examples/atlas-layouts.json` がMAIN_VIDEO実寸、論理出力サイズ、Atlas実寸、Rect planの運用設定正本。Rectのsource・mode・座標は配信前に検証する。
- JMA Atom/P2P code556 → `tools/atlas_sources.js` → loopback `atlas_ingest.js` → 状態 → HTML/Chromium → Rect/A2 → FFmpeg → MediaMTX `/bosai` の流れを保つ。
- JMA収集で `jma_server.js`、PM2 `jma-api`、Discord Bot、`ssl/`を起動・変更しない。独立A2収集器を使い、既存API/Botへ副作用を出さない。
- 津波/EEWの有効警報を入力断や単純TTLで無言に消さない。情報源鮮度、packet timestamp、RTSP状態を分けて扱い、情報源の更新停止を画面上で示す。
- 実装確認と運用確認を混ぜない。単体、H.264、RTSP、WAN、VRChat/Quest実機の証拠を別々に報告する。
- 機密情報、秘密鍵、token、固定公開IPをリポジトリやログへ保存しない。RTSP publishはloopback、readは指定された公開範囲、管理APIは非公開にする。

## 開発サイクル

挙動変更では関係する仕様/資料を確認し、現在の要件と矛盾する箇所を先に直す。要求を表すテストを追加して失敗を確認し、最小実装、関連テスト、lint/build、差分確認の順で進める。資料のみの変更では該当工程だけ行う。

## Git

作業前後に `git status` を確認し、既存のユーザー変更を保護する。無関係な変更はstage/commit/pushしない。force push、hard reset、clean、履歴書換えは明示許可が必要。独立した実装タスクは検証後に日本語の簡潔なcommit messageでコミットする。

## 報告

分かったこと、変更、検証結果、未検証事項、起動手順を日本語で簡潔に報告する。事実・推論・未確認を区別する。起動済みや実機確認済みと、手順/単体テストだけの状態を混同しない。
