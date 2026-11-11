# 津波ミニマップ・レイヤー画像

- キャンバス: 2000×2000 px、RGBA、OpenRaster（GIMPで開けます）
- 状態: `telop/tsunami.html` の組み込み `example` デモ。実時間の発表状態ではありません。
- [現行レイアウト版](tsunami-japan-2000.ora) / [透過プレビューPNG](tsunami-japan-2000.png)
- 地形・区域・色帯: 現行 `tsunami-art.js` の固定パスを使用。地図形状の変更はしていません。
- 陸地は既存SVGの地形パス単位で分離し、予報区境界は全66区域を個別レイヤー化（初期非表示）しています。島名データがない地形片は、島名を推定せず都道府県と番号で命名しています。
- 色帯レイヤーはデモに発表設定された区域だけを種別フォルダーに収録しています。色: 注意報 `#FAF500`、警報 `#FF2800`、特別警報（大津波警報）`#C800FF`。
- 透過PNGはORAと同じ初期表示状態です。ORA内の海面背景レイヤーは任意で、初期非表示です。

## 自然地形版

[tsunami-japan-natural-2000.ora](tsunami-japan-natural-2000.ora) は `geojson.js` 由来の陸地成分と `tzones.js` の元海岸線から作成。線形の等距離投影（代表緯度の経度補正）で一様に配置し、座標のワープ、コーナー丸め、島の再配置はしていません。表示上の簡略化として、既存 `land_components.json` の陸地成分を使っています。色帯は元海岸線に沿う線幅で描き、陸地の上へは重ねていません。レイヤー数: {sum(1 for _ in walk(natural))}。
プレビュー: [tsunami-japan-natural-2000.png](tsunami-japan-natural-2000.png)

再生成: `python telop/export_tsunami_layers.py`

レイヤー数（フォルダーを除く）: 220

注意: 現行レイアウト版は既存640×510の地図を縦横比を保って配置しています。自然地形版にも地図投影由来の歪みは残ります。
