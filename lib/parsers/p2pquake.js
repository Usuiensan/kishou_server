const { EEW_HOKKAIDO_MAPPING, TARGET_EEW_AREAS } = require('./earthquake');

function mapP2PQuakeToEEW(data) {
    if (data.code !== 556) return null;

    const eq = data.earthquake || {};
    const issue = data.issue || {};

    const result = {
        status: '通常',
        reportTime: (issue.time || data.time || '').replace(/\//g, '-'),
        reportId: issue.serial || data.id || data.time || issue.time || '',
        serial: issue.serial || null,
        isEEW: true,
        isWarning: true, // P2PQuake の 556 は警報のみ
        eventId: issue.eventId || data.id || 'unknown',
        infoType: data.cancelled ? '取消' : '発表',
        headline: '',
        eewAreas: [],
        eewAreaDetails: []
    };

    if (!data.cancelled) {
        const areaName = eq.hypocenter?.reduceName || eq.hypocenter?.name || '';
        result.headline = areaName ? `${areaName}で地震 強い揺れに警戒` : '強い揺れに警戒';

        // 地域名のマッピングとフィルタリング
        const areaNames = new Set();
        if (data.areas && Array.isArray(data.areas)) {
            data.areas.forEach(a => {
                let name = a.pref || ''; // P2PQuake は pref が府県名 (例: "栃木")
                if (!name) return;
                
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

        // 区域ごとの予想震度・到達予想も捨てずに残す (区域名レベル、元の値のまま)。
        // eewAreas (府県レベル) とは別に保持し、並び順の検証や表示の材料にする。
        if (data.areas && Array.isArray(data.areas)) {
            const seenDetail = new Set();
            data.areas.forEach(a => {
                if (!a.name || seenDetail.has(a.name)) return;
                seenDetail.add(a.name);
                result.eewAreaDetails.push({
                    name: a.name,
                    pref: a.pref || '',
                    scaleFrom: (typeof a.scaleFrom === 'number') ? a.scaleFrom : null,
                    scaleTo: (typeof a.scaleTo === 'number') ? a.scaleTo : null,
                    arrivalTime: a.arrivalTime || null,
                    kindCode: (typeof a.kindCode === 'number') ? a.kindCode : null
                });
            });
        }
    } else {
        result.headline = '緊急地震速報は取り消されました。';
    }

    return result;
}

module.exports = {
    mapP2PQuakeToEEW
};
