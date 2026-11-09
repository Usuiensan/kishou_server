# アトラス v8 シェーダー・パラメータ仕様

対象: `atlas-1080-v8.html`（ビルダー: `build_atlas.py`）
用途: VRChat 内で、ビデオプレーヤーが受けたアトラス・テクスチャを Shader が切り分け、Udon が表示状態を切り替えるための基準値。

## 1. 座標系

- アトラス全体: **1936 × 1168 px**
- 元画像の画素座標: 左上原点、x 右方向、y 下方向。
- Unity UV: 左下原点、u 右方向、v 上方向。
- UV Rect はすべて `Vector4 = (uMin, vMin, uSize, vSize)` とする。`vMin` は領域の下端。
- 変換式:

```text
uMin  = x / 1936
uSize = width / 1936
vMin  = 1 - (y + height) / 1168
vSize = height / 1168
uMax  = uMin + uSize
vMax  = vMin + vSize
```

- 1 texel の UV サイズ: `(0.000516529, 0.000856164)`
- 半 texel: `(0.000258264, 0.000428082)`
- 下表の値は小数第6位まで。HLSL 定数は小数第9位まで記載する。丸め誤差は 0.002 texel 未満。

## 2. アトラス元領域 UV 表

| 名称 | Shader 名 | px (x, y, w, h) | uMin | uMax | vMin | vMax | Vector4 (uMin, vMin, uSize, vSize) |
|---|---|---:|---:|---:|---:|---:|---|
| 上帯 | `_TopSrcRect` | (0, 0, 1920, 158) | 0.000000 | 0.991736 | 0.864726 | 1.000000 | (0.000000, 0.864726, 0.991736, 0.135274) |
| 左帯スロット全体 | `_LeftSrcRect` | (0, 174, 281, 922) | 0.000000 | 0.145145 | 0.061644 | 0.851027 | (0.000000, 0.061644, 0.145145, 0.789384) |
| 縦型 EEW 実体 | `_EewSrcRect` | (11, 174, 258, 922) | 0.005682 | 0.138946 | 0.061644 | 0.851027 | (0.005682, 0.061644, 0.133264, 0.789384) |
| 下段・透明度（輝度） | `_LowerAlphaSrcRect` | (297, 174, 1639, 461) | 0.153409 | 1.000000 | 0.456336 | 0.851027 | (0.153409, 0.456336, 0.846591, 0.394692) |
| 下段・RGB | `_LowerRgbSrcRect` | (297, 651, 1639, 461) | 0.153409 | 1.000000 | 0.047945 | 0.442637 | (0.153409, 0.047945, 0.846591, 0.394692) |
| データビット | `_DataSrcRect` | (0, 1128, 1936, 30) | 0.000000 | 1.000000 | 0.008562 | 0.034247 | (0.000000, 0.008562, 1.000000, 0.025685) |

補足:

- 上帯の右側 `x=1920..1936, y=0..158` は未使用の 16 px 帯であり、上帯 Rect には含めない。
- 左帯スロット全体には背景と EEW が含まれる。通常表示は `_EewSrcRect` を使い、左帯背景まで含めて差し替える場合だけ `_LeftSrcRect` を使う。
- 下段の透明度と RGB は、同じローカル UV でサンプルするペアである。片方だけ Rect を変更しないこと。

## 3. 最終画面（1920 × 1080）への配置 Rect

単一のフルスクリーン合成 Shader で描く場合の基準値。画素座標は左上原点、Screen Rect は Unity UV と同じく `(uMin, vMin, uSize, vSize)`。

| 対象 | 配置 px (x, y, w, h) | Screen Rect |
|---|---:|---|
| 本編映像（L 発動時） | (281, 158, 1639, 922) | (0.146354, 0.000000, 0.853646, 0.853704) |
| 上帯 | (0, 0, 1920, 158) | (0.000000, 0.853704, 1.000000, 0.146296) |
| 左帯スロット | (0, 158, 281, 922) | (0.000000, 0.000000, 0.146354, 0.853704) |
| 縦型 EEW | (11, 158, 258, 922) | (0.005729, 0.000000, 0.134375, 0.853704) |
| 下段の基準位置（L 発動時の映像下半分） | (281, 619, 1639, 461) | (0.146354, 0.000000, 0.853646, 0.426852) |

下段は映像から切り離された独立要素なので、最終位置は固定値ではなく Udon 側の `_LowerDestRect` で与える。上記は基準位置であり、サイズ **1639 × 461** を変えない限り、移動しても 1:1 は保たれる。拡大・縮小する場合はその表示だけスケーリングが発生する。

個別 Quad に分ける場合は Screen Rect を使わず、各 Quad のローカル UV `(0..1)` を対応する Source Rect へ写像する。

## 4. ShaderLab Properties

```hlsl
Properties
{
    _AtlasTex ("Atlas Texture", 2D) = "black" {}

    _AtlasSize ("Atlas Size (w,h,1/w,1/h)", Vector)
        = (1936, 1168, 0.000516529, 0.000856164)

    _TopSrcRect ("Top Source Rect", Vector)
        = (0.000000000, 0.864726027, 0.991735537, 0.135273973)
    _LeftSrcRect ("Left Source Rect", Vector)
        = (0.000000000, 0.061643836, 0.145144628, 0.789383562)
    _EewSrcRect ("EEW Source Rect", Vector)
        = (0.005681818, 0.061643836, 0.133264463, 0.789383562)
    _LowerAlphaSrcRect ("Lower Alpha Source Rect", Vector)
        = (0.153409091, 0.456335616, 0.846590909, 0.394691781)
    _LowerRgbSrcRect ("Lower RGB Source Rect", Vector)
        = (0.153409091, 0.047945205, 0.846590909, 0.394691781)
    _DataSrcRect ("Data Source Rect", Vector)
        = (0.000000000, 0.008561644, 1.000000000, 0.025684932)

    _LowerDestRect ("Lower Destination Rect", Vector)
        = (0.146354167, 0.000000000, 0.853645833, 0.426851852)

    _LActive ("L Active", Range(0, 1)) = 0
    _TopVisible ("Top Visible", Range(0, 1)) = 1
    _LeftVisible ("Left Visible", Range(0, 1)) = 1
    _LowerVisible ("Lower Visible", Range(0, 1)) = 1
    _LowerOpacity ("Lower Opacity", Range(0, 1)) = 1
}
```

`_DataSrcRect` はアトラス上の予約領域を示す定数として保持する。この仕様は、その読み取り方式や符号化方式を定めない。

## 5. サンプリング関数

```hlsl
sampler2D _AtlasTex;
float4 _TopSrcRect;
float4 _LeftSrcRect;
float4 _EewSrcRect;
float4 _LowerAlphaSrcRect;
float4 _LowerRgbSrcRect;
float4 _DataSrcRect;

float2 MapRectUV(float2 localUv, float4 rect)
{
    return rect.xy + localUv * rect.zw;
}

float4 SampleAtlasRect(float2 localUv, float4 rect)
{
    return tex2D(_AtlasTex, MapRectUV(localUv, rect));
}

float4 SampleLower(float2 localUv)
{
    float3 rgb = tex2D(
        _AtlasTex,
        MapRectUV(localUv, _LowerRgbSrcRect)).rgb;

    float3 alphaRgb = tex2D(
        _AtlasTex,
        MapRectUV(localUv, _LowerAlphaSrcRect)).rgb;

    // 透明度は輝度で表す。色偏りの影響を抑えるため Rec.709 輝度を使う。
    float alpha = saturate(dot(
        alphaRgb, float3(0.2126, 0.7152, 0.0722)));

    return float4(rgb, alpha * _LowerOpacity * _LowerVisible);
}
```

単独要素用 Shader では `_SrcRect` 1 個を持たせ、上表から対象の値を入れる。フルスクリーン合成 Shader では、上記の全 Rect を保持し、Screen Rect の内側かどうかでサンプル元を切り替える。

## 6. Udon が変更してよい値

| パラメータ | 型 | 用途 |
|---|---|---|
| `_LActive` | float 0/1 | L 発動状態。映像配置と帯表示の切替 |
| `_TopVisible` | float 0/1 | 上帯の表示 |
| `_LeftVisible` | float 0/1 | 左帯・EEW の表示 |
| `_LowerVisible` | float 0/1 | 下段の表示 |
| `_LowerOpacity` | float 0..1 | 下段全体の不透明度 |
| `_LowerDestRect` | Vector4 | 下段の配置。サイズを変えなければ移動のみで 1:1 を維持 |

Udon は Source Rect を原則変更しない。アトラスのレイアウトが変わった場合は、Shader 側定数を新しい版の表で差し替える。

## 7. テクスチャ設定

- Wrap Mode: **Clamp**
- Filter Mode: **Bilinear**
- Mip Maps: プレーヤー出力 RenderTexture の設定に従う。Shader 側で追加の拡大縮小変換を入れない。
- `_AtlasTex_ST` は使わない。各 Rect が直接 UV を決める。
- 領域間には 16 px の隙間があるため、通常の Bilinear でも隣の表示要素は混ざらない。境界を厳密に扱う場合のみ、サンプル位置を半 texel 内側へ制限する。

## 8. 全体方針: サーバー駆動 / クライアント固定

クライアント（Shader + Udon）は、アトラス v8 プロトコル専用の汎用レンダラとして固定する。情報の意味解釈、文面、地図、表示順序、タイミング、配色はすべてサーバー側で決め、サーバーはアトラスの各領域内に自由に描画する。

### クライアント更新が不要な変更

- 各領域の中に描く文字、地図、図形、色、点滅などの内容変更
- 領域内で完結するレイアウト変更
- 表示する情報の種類、順序、継続時間、切替タイミングの変更
- 下段の配置変更。ただしサイズを変えず、`_LowerDestRect` の範囲で移動する場合

### クライアント更新が必要な変更（プロトコル変更）

- アトラス全体の寸法変更
- Source Rect の位置・寸法変更
- RGB と輝度アルファのような、領域同士の対応関係や合成方法の変更
- 新しい合成プリミティブの追加
- Shader パラメータの意味・型の変更
- VRChat / ビデオプレーヤー側 API の変更への追随

Udon は個別の災害情報や表示内容を解釈しない。プレーヤーの読み込み・再生・再読み込み、汎用的な表示フラグと不透明度、L 状態程度だけを扱い、意味のある判断はサーバーへ寄せる。これにより、通常の運用変更はサーバー側だけで完結させる。

## 9. 運用前提: 30fps / キャンバスは縮小しない

- フレームレートは **30fps** 前提とし、アトラスは v8 の **1936 × 1168** を維持する。Level 4.2 に合わせるための 1920 × 1152 への縮小は行わない。
- H.264 Level 4.2 の MaxFS は 8,704 マクロブロックで、fps によらず適用される。v8 は 121 × 73 = **8,833** で **129 超過**するため、厳密な Level 4.2 適合は要件としない。
- 処理速度側は 8,833 × 30 = **264,990 MB/s** で、Level 4.2 の MaxMBPS 522,240 の範囲内。
- 符号化レベルは **5.0 以上または自動** とする（Level 5.0 の MaxFS は 22,080 で、v8 は十分に収まる）。
- ただし Level 5.0 を再生できるかは VRChat 本体ではなく端末側 OS デコーダの実装に依存する。参照フレーム数やビットレートなど実際の符号化パラメータは Level 4.2 相当に抑え、「5.0 なのはフレームサイズだけ」の状態にする。Quest 2 実機で再生確認するまでは、この点は未検証として扱う。
