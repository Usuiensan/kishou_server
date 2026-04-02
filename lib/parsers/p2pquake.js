const { EEW_HOKKAIDO_MAPPING, TARGET_EEW_AREAS } = require('./earthquake');

function mapP2PQuakeToEarthquake(data) {
    if (data.code !== 551) return null;

    const eq = data.earthquake;
    const issue = data.issue;

    const hp = eq.hypocenter || {};
    const depthStr = hp.depth >= 0 ? `深さ ${hp.depth}km` : '深さ 不明';
    const magnitudeStr = hp.magnitude >= 0 ? `Ｍ${hp.magnitude.toFixed(1)}` : 'Ｍ不明';

    // 内部形式にマッピング (formatter.js が期待する構造)
    const result = {
        status: '通常',
        infoKind: mapP2PType(issue.type),
        originTimeFormatted: formatP2PTime(eq.time),
        originTime: eq.time.replace(/\//g, '-'),
        reportTime: issue.time.replace(/\//g, '-'),
        earthquake: {
            hypocenter: {
                name: hp.name || '不明',
                description: `${depthStr} ${magnitudeStr}`, // formatter.js が深さ・マグニチュード抽出に利用
            },
            magnitude: hp.magnitude >= 0 ? hp.magnitude.toFixed(1) : 'NaN',
            magnitudeDescription: magnitudeStr
        },
        intensity: {
            maxInt: mapP2PScale(eq.maxScale),
            groups: {}
        },
        comment: data.comments?.freeFormComment || '',
        tsunamiWorry: eq.domesticTsunami !== 'None' && eq.domesticTsunami !== 'Unknown',
        isEEW: false
    };

    // 震度ごとの地域まとめ (Hokkaido マッピングと重複除去を適用)
    if (data.points) {
        data.points.forEach(p => {
            const scaleStr = mapP2PScale(p.scale);
            if (scaleStr) {
                if (!result.intensity.groups[scaleStr]) result.intensity.groups[scaleStr] = [];
                
                // 地域名のクリーンアップとマッピング
                let name = p.addr.replace(/[都府県]$/, '');
                if (EEW_HOKKAIDO_MAPPING[name]) {
                    name = EEW_HOKKAIDO_MAPPING[name];
                }
                
                if (!result.intensity.groups[scaleStr].includes(name)) {
                    result.intensity.groups[scaleStr].push(name);
                }
            }
        });
    }

    return result;
}

function mapP2PType(p2pType) {
    const mapping = {
        'ScalePrompt': '震度速報',
        'Destination': '震源に関する情報',
        'ScaleAndDestination': '震度・震源に関する情報',
        'DetailScale': '各地の震度に関する情報',
        'Foreign': '遠地地震に関する情報',
        'Other': 'その他の情報'
    };
    return mapping[p2pType] || p2pType;
}

function formatP2PTime(p2pTime) {
    try {
        const date = new Date(p2pTime.replace(/\//g, '-'));
        const hour = date.getHours();
        const minute = date.getMinutes();
        const ampm = hour < 12 ? '午前' : '午後';
        const displayHour = hour === 0 ? 0 : (hour > 12 ? hour - 12 : hour);
        return `${ampm}${displayHour}時${minute}分`;
    } catch (e) {
        return '';
    }
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
