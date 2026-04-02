const { XMLParser } = require('fast-xml-parser');

const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
});

const EEW_HOKKAIDO_MAPPING = {
    '石狩': '北海道道央',
    '空知': '北海道道央',
    '後志': '北海道道央',
    '胆振': '北海道道央',
    '日高': '北海道道央',
    '渡島': '北海道道南',
    '檜山': '北海道道南',
    '上川': '北海道道北',
    '留萌': '北海道道北',
    '宗谷': '北海道道北',
    '網走・北見・紋別': '北海道道東',
    '十勝': '北海道道東',
    '釧路': '北海道道東',
    '根室': '北海道道東'
};

const TARGET_EEW_AREAS = [
    "北海道道央", "北海道道南", "北海道道北", "北海道道東",
    "青森", "岩手", "宮城", "秋田", "山形", "福島",
    "茨城", "栃木", "群馬", "埼玉", "千葉", "東京", "神奈川",
    "新潟", "富山", "石川", "福井", "山梨", "長野",
    "岐阜", "静岡", "愛知", "三重",
    "滋賀", "京都", "大阪", "兵庫", "奈良", "和歌山",
    "鳥取", "島根", "岡山", "広島", "山口",
    "徳島", "香川", "愛媛", "高知",
    "福岡", "佐賀", "長崎", "熊本", "大分", "宮崎", "鹿児島", "沖縄"
];

function formatTime(isoString) {
    if (!isoString) return '';
    try {
        const date = new Date(isoString);
        if (isNaN(date.getTime())) return '';

        // Asia/Tokyo で時刻情報を取得
        const jstFormatted = date.toLocaleString('ja-JP', {
            timeZone: 'Asia/Tokyo',
            hour: 'numeric',
            minute: 'numeric',
            hour12: false
        });

        // 抽出した文字列（例: "23:15" または "23時15分"）から数字を抜き出す
        const match = jstFormatted.match(/(\d+).+?(\d+)/);
        if (!match) return '';

        const hours = parseInt(match[1]);
        const minutes = parseInt(match[2]);

        const ampm = hours < 12 ? '午前' : '午後';
        // 深夜0時は「午前0時」とする (hours % 12。ただし正午は「午後0時」)
        const displayHours = hours % 12;
        return `${ampm}${displayHours}時${minutes}分`;
    } catch (e) {
        return '';
    }
}

function parseEarthquake(xml) {
    const jsonObj = parser.parse(xml);
    const report = jsonObj.Report;
    const head = report.Head;
    const body = report.Body;
    const control = report.Control;

    const result = {
        title: control.Title,
        headTitle: head.Title,
        status: control.Status,
        reportDateTime: head.ReportDateTime,
        targetDateTime: head.TargetDateTime,
        originTimeFormatted: formatTime(body.Earthquake?.OriginTime || head.TargetDateTime),
        eventId: head.EventID,
        infoType: head.InfoType,
        infoKind: head.InfoKind,
        headline: head.Headline?.Text || '',
        comment: body.Comments?.ForecastComment?.Text || body.Comments?.FreeFormComment || '',
        warningComment: body.Comments?.WarningComment?.Text || '',
        tsunamiWorry: false,
        // EEW 判定
        isEEW: head.InfoKind === '緊急地震速報' || head.InfoKind?.includes('緊急地震速報'),
        isWarning: head.Title?.includes('警報') || head.Headline?.Text?.includes('警報'),
        eventId: head.EventID,
        infoType: head.InfoType,
        eewAreas: [],
    };

    // EEW で Headline を構築する (「震源地で地震 強い揺れに警戒」の固定形式)
    if (result.isEEW && result.infoType !== '取消') {
        const areaName = body.Earthquake?.Hypocenter?.Area?.Name || '';
        result.headline = areaName ? `${areaName}で地震 強い揺れに警戒` : '強い揺れに警戒';
    }

    // EEW の地域情報を抽出 (府県予報区レベルを使用し、指定の名称にマッピング)
    if (result.isEEW && head.Headline?.Information) {
        const info = Array.isArray(head.Headline.Information) ? head.Headline.Information : [head.Headline.Information];
        
        // 府県予報区レベルの情報を探す
        const prefInfo = info.find(i => i.type?.includes('府県予報区'));
        
        if (prefInfo && prefInfo.Item) {
            const items = Array.isArray(prefInfo.Item) ? prefInfo.Item : [prefInfo.Item];
            const areaNames = new Set();

            items.forEach(item => {
                const areas = Array.isArray(item.Areas.Area) ? item.Areas.Area : [item.Areas.Area];
                areas.forEach(area => {
                    let name = area.Name;
                    
                    // 北海道のマッピング
                    if (EEW_HOKKAIDO_MAPPING[name]) {
                        name = EEW_HOKKAIDO_MAPPING[name];
                    }

                    // 指定の地域名リストに含まれているかチェック
                    if (TARGET_EEW_AREAS.includes(name)) {
                        areaNames.add(name);
                    }
                });
            });
            result.eewAreas = Array.from(areaNames);
        }
    }

    // 津波の心配フラグ判定
    const headlineText = head.Headline?.Text || '';
    if (headlineText.includes('津波の心配はありません') || result.comment.includes('津波の心配はありません')) {
        result.tsunamiWorry = false;
    } else if (headlineText.includes('津波') || result.comment.includes('津波')) {
        result.tsunamiWorry = true;
    }

    // 震源情報 (VXSE52, VXSE53)
    if (body.Earthquake) {
        const eq = body.Earthquake;
        result.earthquake = {
            originTime: eq.OriginTime,
            arrivalTime: eq.ArrivalTime,
            hypocenter: {
                name: eq.Hypocenter.Area.Name,
                code: eq.Hypocenter.Area.Code?.['#text'] || eq.Hypocenter.Area.Code,
                coordinate: eq.Hypocenter.Area['jmx_eb:Coordinate']?.['#text'] || eq.Hypocenter.Area['jmx_eb:Coordinate'] || '',
                description: eq.Hypocenter.Area['jmx_eb:Coordinate']?.description || '',
            },
            magnitude: eq['jmx_eb:Magnitude']?.['#text'] || eq['jmx_eb:Magnitude'] || 'NaN',
            magnitudeDescription: eq['jmx_eb:Magnitude']?.description || '',
        };
    }

    // 長周期地震動情報 (VXSE53)
    if (body.LgIntensity) {
        const lgIntensity = body.LgIntensity;
        result.lgIntensity = {
            maxLgInt: lgIntensity.Observation?.MaxLgInt || null,
            groups: {}, // 階級ごとの地域まとめ
        };

        if (lgIntensity.Observation?.Pref) {
            const lgPrefs = Array.isArray(lgIntensity.Observation.Pref) 
                ? lgIntensity.Observation.Pref 
                : [lgIntensity.Observation.Pref];

            lgPrefs.forEach(pref => {
                const areas = Array.isArray(pref.Area) ? pref.Area : [pref.Area];
                areas.forEach(area => {
                    const lgInt = area.MaxLgInt;
                    if (lgInt) {
                        if (!result.lgIntensity.groups[lgInt]) result.lgIntensity.groups[lgInt] = [];
                        result.lgIntensity.groups[lgInt].push(area.Name);
                    }
                });
            });
        }
    }

    // 震度情報 (VXSE51, VXSE53, VXSE62)
    if (body.Intensity) {
        const intensity = body.Intensity;
        result.intensity = {
            maxInt: intensity.Observation?.MaxInt || null,
            maxLgInt: intensity.Observation?.MaxLgInt || null,
            prefs: [],
            maxLgInt: intensity.Observation?.MaxLgInt || null,
            prefs: [],
            groups: {},     // 震度ごとの地域まとめ
            cityGroups: {}, // 震度ごとの市町村まとめ
        };

        const prefs = intensity.Observation?.Pref 
            ? (Array.isArray(intensity.Observation.Pref) ? intensity.Observation.Pref : [intensity.Observation.Pref])
            : [];

        const groups = {};
        const cityGroups = {};

        result.intensity.prefs = prefs.map(pref => {
            const areas = Array.isArray(pref.Area) ? pref.Area : [pref.Area];
            areas.forEach(area => {
                const int = area.MaxInt;
                if (int) {
                    if (!groups[int]) groups[int] = [];
                    groups[int].push(area.Name);
                }
            });
            return {
                name: pref.Name,
                code: pref.Code,
                maxInt: pref.MaxInt,
                areas: areas.map(area => {
                    const cities = area.City ? (Array.isArray(area.City) ? area.City : [area.City]) : [];
                    return {
                        name: area.Name,
                        code: area.Code,
                        maxInt: area.MaxInt,
                        cities: cities.map(city => {
                            const int = city.MaxInt;
                            if (int) {
                                if (!cityGroups[int]) cityGroups[int] = [];
                                cityGroups[int].push(city.Name);
                            }
                            const stations = city.IntensityStation ? (Array.isArray(city.IntensityStation) ? city.IntensityStation : [city.IntensityStation]) : [];
                            return {
                                name: city.Name,
                                code: city.Code,
                                maxInt: city.MaxInt,
                                stations: stations.map(st => ({
                                    name: st.Name,
                                    code: st.Code,
                                    int: st.Int,
                                })),
                            };
                        }),
                    };
                }),
            };
        });
        result.intensity.groups = groups;
        result.intensity.cityGroups = cityGroups;

        // body.Intensity.Observation.MaxLgInt も存在する場合があるため、lgIntensityがなければ補完
        if (!result.lgIntensity && intensity.Observation?.MaxLgInt) {
            result.lgIntensity = { maxLgInt: intensity.Observation.MaxLgInt };
        }
    }

    return result;
}

module.exports = { parseEarthquake };
