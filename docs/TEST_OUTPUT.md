# 電文出力テスト

## ディレクトリ構成

- `jma_server.js`：本番サーバーのエントリーポイント
- `lib/`：本番で読み込むパーサー、フォーマッタ、Discord/NERV処理
- `tests/*.test.js`：`node --test` で実行する自動テスト
- `tests/scripts/`：サンプル電文の生成・表示確認など、手動実行するテスト用JS
- `tests/results/`：テストで生成されるJSON・Markdown

本番起動では `npm start` を使用し、`tests/` 以下のJSは読み込みません。

全電文サンプルを解析し、Unity/API向けJSONとDiscord向けMarkdownを生成します。

```powershell
npm test
```

`npm test` は、単体テスト実行後に `tests/scripts/test_all_codes.js` を実行します。

生成物：

- `tests/results/test_result_<コード>.json`：Unity/API向けの整形済みJSON
- `tests/results/test_result_<コード>.md`：Discord送信用Markdown（改行済みの可読テキスト）

例：

```powershell
Get-Content tests/results/test_result_VTSE52.md
```

個別に出力サンプルだけを再生成する場合：

```powershell
node tests/scripts/test_all_codes.js
```

NERVのニュース・交通情報のDiscord表示テスト：

```powershell
node tests/scripts/test_nerv_output.js
```

`tests/results/test_result_NERV.md` に、NHKニュース速報と交通機関情報のサンプル本文を出力します。`死去`を含む投稿は除外し、`死亡`を含む災害・事件報道は除外しません。

## NERV過去投稿の人手レビュー

公開APIから取得した投稿は送出せず、原文と確認用Markdownを必ずファイルへ保存します。

```powershell
node tests/scripts/review_nerv_archive.js 40
```

第4引数で過去へ遡るページ数を指定できます（既定10ページ、最大100ページ）。

```powershell
node tests/scripts/review_nerv_archive.js 40 "" 100
```

さらに古いページを取得する場合は、最後に取得した投稿IDを `max_id` として指定します。

```powershell
node tests/scripts/review_nerv_archive.js 40 117000000000000000
```

生成される2ファイルを人が確認し、採用対象を選別します。

- `tests/results/nerv_archive_<日時>.json`：API原文を含むレビュー用JSON
- `tests/results/nerv_archive_<日時>.md`：本文・URL・タグ・現在の除外候補を読みやすく並べたMarkdown

このスクリプトは送信処理やキャッシュ登録を行いません。

NHKニュース速報だけをレビューする場合：

```powershell
node tests/scripts/review_nhk_news.js 40
```

第4引数で遡るページ数を指定できます（1ページ最大40件、既定10ページ）：

```powershell
node tests/scripts/review_nhk_news.js 40 "" 50
```

これは最大2,000件を過去方向へ検索します。前回の最古IDから続ける場合は、第3引数に `oldestId` を指定します。

このスクリプトは本文・タグに `NHK`、`ニュース速報`、`NHKニュース` が含まれる投稿だけを対象にし、既存の地震・津波・緊急情報の除外判定と `死去` 除外を適用します。送出は行わず、次の2ファイルへ保存します。

避難・危険度情報は現時点の発令・発生を優先し、「避難判断水位に上る見込み」「レベル4に到達する見込み」など将来予測だけの投稿は対象外です。
投稿冒頭の `【…】` 見出しを現時点の状態として優先判定します。見出しが単なる「気象警報・注意報」で、本文に将来のレベル4到達見込みだけが書かれている場合は除外します。

- `tests/results/nerv_nhk_review_<日時>.json`
- `tests/results/nerv_nhk_review_<日時>.md`
