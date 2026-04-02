const REGION_MAP = {
    '青森': '東北', '岩手': '東北', '宮城': '東北', '秋田': '東北', '山形': '東北', '福島': '東北',
    '茨城': '関東', '栃木': '関東', '群馬': '関東', '埼玉': '関東', '千葉': '関東', '東京': '関東', '神奈川': '関東',
    '富山': '北陸', '石川': '北陸', '福井': '北陸',
    '新潟': '甲信越', '山梨': '甲信越', '長野': '甲信越',
    '岐阜': '東海', '静岡': '東海', '愛知': '東海', '三重': '東海',
    '滋賀': '近畿', '京都': '近畿', '大阪': '近畿', '兵庫': '近畿', '奈良': '近畿', '和歌山': '近畿',
    '鳥取': '中国', '島根': '中国', '岡山': '中国', '広島': '中国', '山口': '中国',
    '徳島': '四国', '香川': '四国', '愛媛': '四国', '高知': '四国',
    '福岡': '九州', '佐賀': '九州', '長崎': '九州', '熊本': '九州', '大分': '九州', '宮崎': '九州', '鹿児島': '九州',
    '沖縄': '沖縄', '北海道': '北海道', '道央': '北海道', '道南': '北海道', '道北': '北海道', '道東': '北海道'
};

/**
 * 地域名（都道府県名や支庁名など）から広域地方名を返す
 * @param {string} areaName 
 * @returns {string|null}
 */
function getRegionFromArea(areaName) {
    if (!areaName) return null;
    
    // 奄美の特殊判定
    if (areaName.includes('奄美')) {
        return '奄美';
    }

    // マッピングから検索 (前方一致)
    for (const [key, region] of Object.entries(REGION_MAP)) {
        if (areaName.startsWith(key)) {
            return region;
        }
    }

    return null;
}

/**
 * 最大震度の観測エリアリストから地方名リストを取得し、連結して返す
 * @param {string[]} areas 
 * @returns {string} (例: "関東・東北地方" )
 */
function getFormattedMaxIntensityRegion(areas) {
    if (!areas || areas.length === 0) return '';

    const regions = new Set();
    areas.forEach(area => {
        const region = getRegionFromArea(area);
        if (region) {
            regions.add(region);
        }
    });

    const regionList = Array.from(regions);
    if (regionList.length === 0) return '';

    // 特定の順序で並び替える（任意ですが、北から南など）
    const order = ['北海道', '東北', '関東', '北陸', '甲信越', '東海', '近畿', '中国', '四国', '九州', '奄美', '沖縄'];
    regionList.sort((a, b) => order.indexOf(a) - order.indexOf(b));

    return regionList.join('・') + '地方';
}

module.exports = {
    getRegionFromArea,
    getFormattedMaxIntensityRegion
};
