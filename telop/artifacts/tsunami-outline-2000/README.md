# 津波ミニマップ・境界線レイヤー

- キャンバス: 2000×2000 px、RGBA、OpenRaster（GIMPで開けます）
- [OpenRaster（GIMP対応）](tsunami-japan-outline-2000.ora) / [透過PNGプレビュー](tsunami-japan-outline-2000.png)
- レイヤー: 陸地 189成分、津波予報区境界66区域、都道府県境75レイヤー、北海道の振興局境27レイヤー。投影面積1px²未満の陸地成分60個を除外しています。注意報・警報・特別警報の色線と凡例は含みません。
- `land_components.json` の249成分すべてに地名を割り当て、レイヤー名にしています。島名・位置は国土地理院・海上保安庁「地名集日本 2021」、地理院地図標準地図、Wikidataの地名・座標を照合しました。人工島、半島、複数の島がつながった成分は、地図上で確認できる地名を付けています。地形は角を丸めず、座標も変形していません。
- 行政界: 国土数値情報 N03-2024（北海道の振興局界を含む）、CC BY 4.0。

再生成: `python telop/export_tsunami_layers.py`（`auxiliary-boundaries.json` と `island-layer-names.json` を使用。249成分分の名称がそろっていることを確認して出力します）

レイヤー数（フォルダーを除く）: 357
