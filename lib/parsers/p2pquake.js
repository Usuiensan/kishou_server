const { EEW_HOKKAIDO_MAPPING, TARGET_EEW_AREAS } = require('./earthquake');

function mapP2PQuakeToEarthquake(data) {
    if (data.code !== 551) return null;

    const eq = data.earthquake;
    const issue = data.issue;

    // 内部形式にマッピング
    const result = {
        status: '通常',
        reportTime: issue.time.replace(/\//g, '-'),
        targetTime: eq.time.replace(/\//g, '-'),
        originTime: eq.time.replace(/\//g, '-'),
        hypocenter: eq.hypocenter.name || '不明',
        depth: eq.hypocenter.depth >= 0 ? `${eq.hypocenter.depth}km` : '不明',
        magnitude: eq.hypocenter.magnitude >= 0 ? eq.hypocenter.magnitude.toFixed(1) : '不明',
        maxInt: mapP2PScale(eq.maxScale),
        headline: '',
        comment: data.comments?.freeFormComment || '',
        tsunamiWorry: eq.domesticTsunami !== 'None' && eq.domesticTsunami !== 'Unknown',
        isEEW: false,
        intensity: {
            groups: {}
        }
    };

    // 震度ごとの地域まとめ
    if (data.points) {
        data.points.forEach(p => {
            const scaleStr = mapP2PScale(p.scale);
            if (scaleStr) {
                if (!result.intensity.groups[scaleStr]) result.intensity.groups[scaleStr] = [];
                result.intensity.groups[scaleStr].push(p.addr);
            }
        });
    }

    // 見出しの合成
    const timeStr = result.originTime.split(' ')[1].substring(0, 5); // HH:mm
    result.headline = `${timeStr}ごろ 地震がありました。`;
    if (!result.tsunamiWorry) {
        result.headline += ' この地震による津波の心配はありません。';
    }

    return result;
}

function mapP2PQuakeToEEW(data) {
    if (data.code !== 556) return null;

    const eq = data.earthquake || {};
    const issue = data.issue;

    const result = {
        status: '通常',
        reportTime: issue.time.replace(/\//g, '-'),
        isEEW: true,
        isWarning: true, // P2PQuake の 556 は警報のみ
        eventId: issue.eventId,
        infoType: data.cancelled ? '取消' : '発表',
        headline: '',
        eewAreas: []
    };

    if (!data.cancelled) {
        const areaName = eq.hypocenter?.name || '';
        result.headline = areaName ? `${areaName}で地震 強い揺れに警戒` : '強い揺れに警戒';

        // 地域名のマッピングとフィルタリング
        const areaNames = new Set();
        if (data.areas) {
            data.areas.forEach(a => {
                let name = a.pref; // P2PQuake は pref が府県名 (例: "愛媛県")
                
                // 「県」「府」「都」を削除してマッピングを試行
                const cleanName = name.replace(/[都府県]$/, '');
                
                if (EEW_HOKKAIDO_MAPPING[cleanName]) {
                    areaNames.add(EEW_HOKKAIDO_MAPPING[cleanName]);
                } else if (TARGET_EEW_AREAS.includes(cleanName)) {
                    areaNames.add(cleanName);
                }
            });
        }
        result.eewAreas = Array.from(areaNames);
    } else {
        result.headline = '緊急地震速報は取り消されました。';
    }

    return result;
}

function mapP2PScale(p2pScale) {
    const mapping = {
        10: '1', 
        20: '2', 
        30: '3', 
        40: '4', 
        45: '5-', 
        46: '5-', 
        50: '5+', 
        55: '6-', 
        60: '6+', 
        70: '7'
    };
    return mapping[p2pScale] || null;
}

module.exports = {
    mapP2PQuakeToEarthquake,
    mapP2PQuakeToEEW
};
