# アトラス v8 — 受信側の座標契約

基準: ユーザー提供「アトラス v8 シェーダー・パラメータ仕様」。対象は `atlas-1080-v8.html`、ビルダー `build_atlas.py`。原ファイル自体は本パッケージに未収録。

## 座標系

- 全体: **1936 x 1168 px**。画像座標は左上原点、Unity UVは左下原点。
- `Vector4 = (uMin, vMin, uSize, vSize)`。`vMin`は矩形下端。
- `uMin=x/1936`; `uSize=w/1936`; `vMin=1-(y+h)/1168`; `vSize=h/1168`。
- 1 texel = `(1/1936, 1/1168)`。出力基準は1920x1080。

## Source rectangles

| Shader name | x | y | w | h | uMin | vMin | uSize | vSize |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| `_TopSrcRect` | 0 | 0 | 1920 | 158 | 0.000000000 | 0.864726027 | 0.991735537 | 0.135273973 |
| `_LeftSrcRect` | 0 | 174 | 281 | 922 | 0.000000000 | 0.061643836 | 0.145144628 | 0.789383562 |
| `_EewSrcRect` | 11 | 174 | 258 | 922 | 0.005681818 | 0.061643836 | 0.133264463 | 0.789383562 |
| `_LowerAlphaSrcRect` | 297 | 174 | 1639 | 461 | 0.153409091 | 0.456335616 | 0.846590909 | 0.394691781 |
| `_LowerRgbSrcRect` | 297 | 651 | 1639 | 461 | 0.153409091 | 0.047945205 | 0.846590909 | 0.394691781 |
| `_DataSrcRect` | 0 | 1128 | 1936 | 30 | 0.000000000 | 0.008561644 | 1.000000000 | 0.025684932 |

上帯右側 x=1920..1936 は未使用。左帯は背景まで含む `_LeftSrcRect` と縦型EEW実体の `_EewSrcRect` を区別する。下段RGBと透明度は同じ local UV でサンプルする。

## Destination rectangles (screen=1920x1080)

| Name | (x, y, w, h) | (uMin, vMin, uSize, vSize) |
|---|---|---|
| 本編映像（L発動時） | (281,158,1639,922) | (0.146354167, 0.000000000, 0.853645833, 0.853703704) |
| 上帯 | (0,0,1920,158) | (0.000000000, 0.853703704, 1.000000000, 0.146296296) |
| 左帯 | (0,158,281,922) | (0.000000000, 0.000000000, 0.146354167, 0.853703704) |
| EEW | (11,158,258,922) | (0.005729167, 0.000000000, 0.134375000, 0.853703704) |
| 下段基準 | (281,619,1639,461) | (0.146354167, 0.000000000, 0.853645833, 0.426851852) |

下段は `_LowerDestRect` で移動できる。Source rectanglesはアトラスの版に紐づく定数として保持する。

## Shader contract

```hlsl
Properties {
    _AtlasTex ("Atlas Texture", 2D) = "black" {}
    _AtlasSize ("Atlas Size (w,h,1/w,1/h)", Vector) = (1936,1168,0.000516529,0.000856164)
    _TopSrcRect ("Top",Vector) = (0.000000000,0.864726027,0.991735537,0.135273973)
    _LeftSrcRect ("Left",Vector) = (0.000000000,0.061643836,0.145144628,0.789383562)
    _EewSrcRect ("EEW",Vector) = (0.005681818,0.061643836,0.133264463,0.789383562)
    _LowerAlphaSrcRect ("Lower Alpha",Vector) = (0.153409091,0.456335616,0.846590909,0.394691781)
    _LowerRgbSrcRect ("Lower RGB",Vector) = (0.153409091,0.047945205,0.846590909,0.394691781)
    _DataSrcRect ("Data",Vector) = (0.000000000,0.008561644,1.000000000,0.025684932)
    _LowerDestRect ("Lower Destination", Vector) = (0.146354167,0.000000000,0.853645833,0.426851852)
    _LActive ("L Active",Range(0,1)) = 0
    _TopVisible ("Top Visible",Range(0,1)) = 1
    _LeftVisible ("Left Visible",Range(0,1)) = 1
    _LowerVisible ("Lower Visible",Range(0,1)) = 1
    _LowerOpacity ("Lower Opacity",Range(0,1)) = 1
}
```

Mapping: `float2 MapRectUV(float2 uv, float4 rect) { return rect.xy + uv*rect.zw; }`.

下段: `rgb = tex2D(_AtlasTex,MapRectUV(localUv,_LowerRgbSrcRect)).rgb; alphaRgb = tex2D(_AtlasTex,MapRectUV(localUv,_LowerAlphaSrcRect)).rgb; alpha = saturate(dot(alphaRgb,float3(0.2126,0.7152,0.0722))); return float4(rgb,alpha*_LowerOpacity*_LowerVisible);`

Udonが変更するのは `_LActive`, `_TopVisible`, `_LeftVisible`, `_LowerVisible`, `_LowerOpacity`, `_LowerDestRect`。SourceRectは通常変更しない。

Visual texture: `Wrap=Clamp`, `Filter=Bilinear`; MipMapはプレーヤー出力設定に従う。データ抽出では別のPoint/中心サンプリング経路を使う。`_AtlasTex_ST`は使わない。

## Explicit unknowns

- 本編映像の **atlas内Source Rectは未定義**。別テクスチャ/別経路を後続工程で確認する。
- データ帯は予約領域。元のv8仕様はプロトコルを定めていない。`metadata-v1.md`は新しい提案でありv8仕様そのものではない。
