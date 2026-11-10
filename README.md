# VRChat 防災アトラス送出サーバー — Codex 引き継ぎキット

**用途:** 自宅PCで気象情報・テロップを取り込み、アトラス v8 (1936×1168) と24バイトの公開表示制御データを生成し、H.264で符号化してRTSP over TCPでVRChatへ届ける。**このZIPはバックエンド開発指示・共通プロトコル・検証ツールであり、完成した本番サーバーではない。**

## 実装対象と境界

- **対象**: 送出側（入力アダプタ、テロップ合成、v8アトラス描画、データ帯、FFmpegエンコード、MediaMTX、Cloudflare DDNS、監視・障害復旧、検証）。
- **対象外**: Unity Shader、UdonSharp、AVProの実機受信実装。ただし共通通信仕様・テストベクトルの相互運用検証を必須とする。
- **接続先**: `telop-mock` 内の承認済みHTML描画部品。JMAサンプルXMLをloopback HTTPで受ける独立プロセス。既存の本番botと`ssl/`を変更しない。
- **既存の受信側PoC**: `vrchat-atlas-v8-kickoff` の `docs/metadata-v1.md` と `tools/metadata_demo.py` を**そのまま複製**した。通信方式を別案で作り直さない。

## 開始

1. `AGENTS.md` と `prompts/CODEX_START.md` をCodexへ渡す。
2. `python3 -m unittest discover -s tests -v` を実行する（標準ライブラリ＋既存試験のPillow依存）。
3. `python3 tools/smoke.py` で静止画、プロトコル、H.264往復試験を確認する（Pillow/ffmpeg/libx264が必要）。
4. `docs/01-architecture.md` → `docs/02-integration.md` → `docs/03-streaming.md` → `docs/04-ops-ddns.md` → `docs/05-acceptance.md` の順で確認する。
5. `protocol/atlas-v8.md` と `protocol/metadata-v1.md` は送受信の正本。変更する場合は別バージョンを発行する。

## ローカル統合試験

Chromium、Node.js、Python/Pillow、FFmpeg/libx264、MediaMTX が必要。まず `python telop/build_atlas.py` を実行して `telop/atlas-1080.html` を生成し、次に実XMLからRTSP録画までを通す:

```powershell
python tools/atlas_e2e.py --mediamtx C:\path\to\mediamtx.exe --chrome "C:\Program Files\Google\Chrome\Application\chrome.exe"
```

録画、発表・続報・取消の代表画像、`ffprobe`/メタデータ検証結果は `tests/results/atlas-e2e/` に保存される。JMA XMLは `node tools/atlas_ingest.js --state runtime/atlas-state.json` の loopback 専用 `/jma` へPOSTできる。HTML描画は `python tools/render_atlas.py --state runtime/atlas-state.json --output runtime/atlas.png --watch`、RTSP送出は `python tools/atlas_sender.py --atlas runtime/atlas.png --stream --sequence-state runtime/sequence.json`。

この受け口はローカルXML入力であり、気象庁配信からの自動取得ではない。WAN公開、DDNS、VRChat実機再生は個別に準備・検証する。

常駐起動は `python tools/atlas_service.py --mediamtx C:\path\to\mediamtx.exe --chrome "C:\Program Files\Google\Chrome\Application\chrome.exe"`。停止は Ctrl+C。子プロセス終了時に指数バックオフで再起動し、ログは `runtime/logs/` で各5MB・3世代にローテーションする。MediaMTX設定は初期状態で loopback のみに bind し、RTSPリーダーもloopbackに制限する。

自動結合試験APIは明示的に有効化する。常駐起動コマンドへ `--test-api` を付けると `127.0.0.1:8766` にloopback専用の制御口が開く。MediaMTXの配信・RTSP URLには触れず、常駐senderが `runtime/atlas-controls.json` を監視してフレームの状態を更新する。例: `python tools/atlas_service.py --mediamtx C:\path\to\mediamtx.exe --chrome "C:\Program Files\Google\Chrome\Application\chrome.exe" --test-api`。

手動の実電文投入は従来どおり `POST /jma` を使う。試験APIで複数/任意JSONイベントを投入する場合は `/test/events`、状態更新は `/test/mode`、初期化は `/test/reset`、状態確認は `GET /test/status` を使う。シナリオは `/test/scenarios/run` へ `{"steps":[{"atSeconds":5,"action":"mode","values":{"flags":7,"opacity":220}},{"atSeconds":20,"action":"mode","values":{"flags":0,"opacity":0}}]}` の形式で渡す。`action` は `events`、`mode`、`reset`、配信子プロセスの停止/再開を行う`fault`を指定できる。実行中の状態は`/test/status`、中止は`POST /test/scenarios/cancel`で確認する。

手動での実電文投入と状態変更は、シナリオと同じ制御処理をCLIから呼び出す:

```powershell
python tools/atlas_test.py event tests/samples/37_01_01_240613_VXSE43.xml tests/samples/37_01_02_240613_VXSE43.xml
python tools/atlas_test.py mode --flags 7 --opacity 220
python tools/atlas_test.py status
```

自動シナリオJSONは時刻指定で複数XML、表示状態、解除、障害再現を並べる。`xmlFile`はシナリオファイルからの相対パス、またはリポジトリ相対パスで指定する:

```json
{"steps":[
  {"atSeconds":5,"action":"events","events":[{"xmlFile":"tests/samples/37_01_01_240613_VXSE43.xml"}]},
  {"atSeconds":10,"action":"events","events":[{"xmlFile":"tests/samples/37_01_02_240613_VXSE43.xml"}]},
  {"atSeconds":15,"action":"mode","values":{"flags":7,"opacity":220}},
  {"atSeconds":20,"action":"reset"},
  {"atSeconds":25,"action":"fault","child":"sender","state":"stop"},
  {"atSeconds":30,"action":"fault","child":"sender","state":"resume"}
]}
```

これを`scenario.json`として保存し、`python tools/atlas_test.py scenario scenario.json`で実行する。試験APIはデフォルトで無効で、loopback以外へbindできない。`/test/events`はXMLまたはJSONの複数イベントを受け付け、シナリオは時刻指定・繰り返し実行に対応する。いずれの状態変更もRTSP URLを再読込しない。

## ここで確定している値

- アトラス: 1936×1168、最終映像合成画面: 1920×1080
- ビット帯: `(0,1128,1936,30)`、8×8セル、R/G各2bit、B=255
- 24バイトのパケットを3行に繰り返し、CRC32/IEEEで検査
- RTSPサーバー: MediaMTX、視聴側URL例 `rtspt://stream.example.com:8554/atlas`（Windows/AVProで要検証）
- DNS: Cloudflare `A`、DNS only、TTL=60秒、更新APIによるDDNS
- H.264: `yuv420p`, B-frameなし、送出時VBR。Level 4.2のフレーム面積制約を超えるためv8はLevel 5.0から試験

## 残っている確認

`telop/build_atlas.py` と `telop/atlas-1080-v8.html` を確認済み。配信HTMLは既存コンポーネントを接続して生成する `telop/atlas-1080.html`。JMA上流の常時取得、WAN/DDNS、CPU・メモリの長時間負荷測定、VRChat実機再生は未実施。サンプルXMLのE2E結果はローカル処理の証拠であり、実運用接続の確認ではない。

RTSPサーバーを自宅で直接公開する構成のため、自宅のグローバルIPはDNS問い合わせ・接続先から把握できる。契約回線のCGNAT・DS-Lite・MAP-Eとポート転送可否を確認する。

## 外部の公式参照

- MediaMTX config: https://mediamtx.org/docs/references/configuration-file
- MediaMTX FFmpeg publish: https://mediamtx.org/docs/publish/ffmpeg
- MediaMTX auth: https://mediamtx.org/docs/features/authentication
- Cloudflare TTL: https://developers.cloudflare.com/dns/manage-dns-records/reference/ttl/
- Cloudflare DNS PATCH: https://developers.cloudflare.com/api/resources/dns/subresources/records/methods/edit/
- VRChat video player: https://creators.vrchat.com/worlds/udon/video-players/
- URL restrictions: https://creators.vrchat.com/worlds/udon/video-players/www-whitelist/
- 元記事: https://site.kamishiro.online/archives/215
- source project: https://github.com/Usuiensan/kishou_server/tree/telop-mock
