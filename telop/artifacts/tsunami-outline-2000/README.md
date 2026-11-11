# 津波ミニマップ・境界線レイヤー

- キャンバス: 2000×2000 px、RGBA、OpenRaster（GIMPで開けます）
- [OpenRaster（GIMP対応）](tsunami-japan-outline-2000.ora) / [透過PNGプレビュー](tsunami-japan-outline-2000.png)
- レイヤー: 陸地成分、津波予報区境界66区域、都道府県どうしの境界、北海道の振興局どうしの境界。注意報・警報・特別警報の色線と凡例は含みません。
- 地形は `land_components.json` と `tzones.js` の座標を同じ線形等距離投影で描画し、角の丸め・地形変形はしていません。島名の網羅的な対応表が既存データにないため、陸地成分レイヤーは都道府県名と成分番号で識別します。
- 行政界: 国土数値情報 N03-2024（北海道の振興局界を含む）、CC BY 4.0。

再生成: `python telop/export_tsunami_layers.py`（補助境界データは `auxiliary-boundaries.json` を使用）

レイヤー数（フォルダーを除く）: 417
