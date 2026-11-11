# 津波ミニマップ・境界線レイヤー

- キャンバス: 2000×2000 px、RGBA、OpenRaster（GIMPで開けます）
- [OpenRaster（GIMP対応）](tsunami-japan-outline-2000.ora) / [透過PNGプレビュー](tsunami-japan-outline-2000.png)
- レイヤー: 陸地成分、津波予報区境界66区域、都道府県どうしの境界、北海道の振興局どうしの境界。注意報・警報・特別警報の色線と凡例は含みません。
- 地形は `land_components.json` と `tzones.js` の座標を同じ線形等距離投影で描画し、角の丸め・地形変形はしていません。陸地レイヤー名は国土地理院「地名集日本 2021」の島名・座標を照合して付けています。島名を照合できない成分は、都道府県名と地図上の座標で識別します。
- 行政界: 国土数値情報 N03-2024（北海道の振興局界を含む）、CC BY 4.0。島名: 国土地理院・海上保安庁「地名集日本 2021」。

再生成: `python telop/export_tsunami_layers.py`（`auxiliary-boundaries.json` と `island-layer-names.json` を使用）

レイヤー数（フォルダーを除く）: 417
