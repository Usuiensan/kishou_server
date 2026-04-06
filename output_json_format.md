# JMA API 出力JSON形式の仕様 (最新版)

本ドキュメントでは、JMA API (`/jma/latest`) が出力するJSON形式について解説します。
最新の改修（カテゴリ細分化、表示時間固定化、EEW 優先表示）を反映しています。

## 概要
APIは常に**オブジェクトの配列**を返却します（最新の情報が配列の先頭インデックス 0 に配置されます）。

### 保持・キャッシュポリシー
- **キャッシュ保持**: 各情報は、サーバー処理から **3時間** (`RETAIN_MS`) キャッシュに保持されます。
- **データ取得間隔**: 気象庁 (JMA) フィードを **30秒** 間隔でチェックします。
- **緊急地震速報 (EEW)**: P2P 地震情報 WebSocket よりリアルタイムで受信します。

### 緊急地震速報 (EEW) の優先表示
最新の情報が `type: "eew"` の場合、発表から **60秒間** は新しい地震情報が届いても EEW が配列の先頭（表示の最優先）に留まり続けます。

---

## 共通フィールド
| フィールド | 型 | 説明 |
| :--- | :--- | :--- |
| `type` | `String` | 情報のカテゴリ。重要度や表示スタイルに使用。 |
| `id` | `String/Number` | 情報の一意なID (EventIDなど)。 |
| `isEEW` | `Boolean` | 緊急地震速報の場合のみ `true`。 |
| `lines` | `Array<Object>` | 表示用テキスト行の配列。 |
| `timestamp` | `String` | サーバーで情報が処理された日時 (ISO 8601形式)。 |

---

## 種類別カテゴリ (`type`)

詳細な制御を可能にするため、以下のカテゴリに細分化されています。

### 1. 緊急地震速報
- `eew`: 緊急地震速報 (発表・更新・取消)

### 2. 津波情報
- `tsunami_warning`: 大津波警報・津波警報
- `tsunami_advisory`: 津波注意報

### 3. 地震情報 (最大震度別)
- `earthquake_1` 〜 `earthquake_4`: 最大震度 1 〜 4
- `earthquake_5l` / `earthquake_5h`: 最大震度 5弱 / 5強
- `earthquake_6l` / `earthquake_6h`: 最大震度 6弱 / 6強
- `earthquake_7`: 最大震度 7
- `earthquake`: 震度情報なし (震源要素のみの遠地地震など)

### 4. 気象情報
- `weather`: 特別警報、警報、注意報、線状降水帯情報など

---

## `lines` フィールドと表示秒数 (`duration`)

テロップの視認性を高めるため、文字数計算ではなく**固定秒数**を採用しています。

| 区分 | 1行目 (index 0) | 2行目以降 (index > 0) |
| :--- | :--- | :--- |
| **地震・EEW・気象** | **3.5秒** | **10.0秒** |
| **津波情報** | **10.0秒** | **10.0秒** |

### データ構造
```json
{
  "text": "表示するテキスト内容",
  "duration": 3.5
}
```

---

## 出力例 (JSON)

### 通常の地震情報 (震度3)
```json
{
  "type": "earthquake_3",
  "id": "20260406152000",
  "lines": [
    { "text": "<align=\"center\">地震情報", "duration": 3.5 },
    { "text": "午後3時20分ごろ 関東地方で\n地震がありました", "duration": 10.0 },
    { "text": "震源は茨城県南部\n深さ50キロ  マグニチュード4.5", "duration": 10.0 }
  ],
  "timestamp": "2026-04-06T06:21:00.000Z"
}
```

### 津波警報
```json
{
  "type": "tsunami_warning",
  "id": "20260406193000",
  "lines": [
    { "text": "<color=#FF2800>【津波警報】</color> <indent=7em><nobr>岩手県</nobr>    <nobr>宮城県</nobr></indent>", "duration": 10.0 },
    { "text": "津波警報が出ている各沿岸の\n津波到達予想は次のとおりです", "duration": 10.0 }
  ],
  "timestamp": "2026-04-06T10:30:00.000Z"
}
```

### 緊急地震速報 (EEW)
```json
{
  "type": "eew",
  "id": "20260406193500",
  "isEEW": true,
  "lines": [
    {
      "text": "<align=\"center\" vspace=0.5em><color=#FF2800>【緊急地震速報】</color>　\n<align=\"left\" vspace=0.5em>茨城県で地震 強い揺れに警戒\n<nobr>茨城</nobr>  <nobr>栃木</nobr>  <nobr>千葉</nobr>  <nobr>埼玉</nobr>  <nobr>群馬</nobr>",
      "duration": 3.5
    }
  ],
  "timestamp": "2026-04-06T10:35:00.000Z"
}
```
