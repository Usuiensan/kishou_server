const { XMLParser } = require('fast-xml-parser');

const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
});

function formatTime(isoString) {
    if (!isoString) return '';
    const date = new Date(isoString);
    
    // 実行環境のタイムゾーンに関わらずJST(日本標準時)で抽出する
    const options = { timeZone: 'Asia/Tokyo', hour: 'numeric', minute: 'numeric', hour12: false };
    const formatter = new Intl.DateTimeFormat('ja-JP', options);
    const parts = formatter.formatToParts(date);
    
    const hours = parseInt(parts.find(p => p.type === 'hour').value);
    const minutes = parseInt(parts.find(p => p.type === 'minute').value);
    
    const ampm = hours < 12 ? '午前' : '午後';
    const displayHours = hours % 12 || 12;
    return `${ampm}${displayHours}時${minutes}分`;
}

function parseEarthquake(xml) {
    const jsonObj = parser.parse(xml);
    const report = jsonObj.Report;
    const head = report.Head;
    const body = report.Body;
    const control = report.Control;

    const result = {
        title: control.Title,
        status: control.Status,
        reportDateTime: head.ReportDateTime,
        targetDateTime: head.TargetDateTime,
        originTimeFormatted: formatTime(body.Earthquake?.OriginTime || head.TargetDateTime),
        eventId: head.EventID,
        infoType: head.InfoType,
        infoKind: head.InfoKind,
        headline: head.Headline?.Text || '',
        comment: body.Comments?.ForecastComment?.Text || body.Comments?.FreeFormComment || '',
        tsunamiWorry: false,
    };

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

        const prefs = Array.isArray(intensity.Observation.Pref) 
            ? intensity.Observation.Pref 
            : [intensity.Observation.Pref];

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
