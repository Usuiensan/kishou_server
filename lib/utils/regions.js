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
    getFormattedMaxIntensityRegion,
    getEewRegionFromArea,
    groupEewAreasForDisplay
};

// ===== 緊急地震速報の対象地域表示（@SC_Sendai_City の逆解析5法則に準拠） =====
// 法則1: 基本はエリア（都道府県など）別表示
// 法則2: 2行（1行最大14字）に収まらなければ地方別表示に変更
// 法則3: 地方内で1エリアのみの発表ならエリア表示のまま
// 法則4: 新潟や島嶼部はそれぞれ独立した地方扱い
// 法則5: それでも収まらない場合は文字を小さくして表示（呼び出し側で <size> を付ける）
const EEW_LINE_WIDTH = 14;
const EEW_MAX_LINES = 2;

/**
 * EEW表示用の地方名を返す。法則4により新潟は甲信越から独立させる。
 * 奄美は getRegionFromArea が既に独立扱いする。
 */
function getEewRegionFromArea(areaName) {
    if (!areaName) return null;
    if (areaName.startsWith('新潟')) return '新潟';
    return getRegionFromArea(areaName);
}

function eewTextWidth(text) {
    return [...String(text)].length;
}

// 区切り（半角スペース2つ＝全角1字分）を挟んで貪欲に折り返したときの行数
function eewWrappedLineCount(tokens) {
    let lines = 1;
    let current = 0;
    tokens.forEach((token) => {
        const w = eewTextWidth(token);
        const needed = current === 0 ? w : current + 1 + w;
        if (current > 0 && needed > EEW_LINE_WIDTH) {
            lines += 1;
            current = w;
        } else {
            current = needed;
        }
    });
    return lines;
}

/**
 * EEWの対象エリア一覧を表示用トークン列へ変換する。
 * @param {string[]} areas パーサが作る都道府県短縮名の配列（発表順）
 * @returns {{tokens: string[], grouped: boolean, shrunk: boolean}}
 *   tokens: 表示する文字列の列（地方化した場合は「◯◯地方」）
 *   grouped: 地方別表示に切り替えたか
 *   shrunk: 法則5（縮小表示）が必要か
 */
function groupEewAreasForDisplay(areas) {
    const unique = [...new Set((areas || []).filter(Boolean))];
    if (unique.length === 0) return { tokens: [], grouped: false, shrunk: false };
    if (eewWrappedLineCount(unique) <= EEW_MAX_LINES) {
        return { tokens: unique, grouped: false, shrunk: false };
    }

    const counts = new Map();
    unique.forEach((area) => {
        const region = getEewRegionFromArea(area);
        if (region) counts.set(region, (counts.get(region) || 0) + 1);
    });

    const tokens = [];
    const emittedRegions = new Set();
    // 法則4の独立地方は、所属エリアが1つでも地方トークンで出す（法則3の例外を適用しない）
    const INDEPENDENT_REGIONS = new Set(['新潟', '沖縄', '奄美']);
    unique.forEach((area) => {
        const region = getEewRegionFromArea(area);
        if (region && (counts.get(region) >= 2 || INDEPENDENT_REGIONS.has(region))) {
            if (!emittedRegions.has(region)) {
                emittedRegions.add(region);
                tokens.push(`${region}地方`);
            }
        } else {
            tokens.push(area);
        }
    });

    const shrunk = eewWrappedLineCount(tokens) > EEW_MAX_LINES;
    return { tokens, grouped: true, shrunk };
}
