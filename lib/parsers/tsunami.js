const { XMLParser } = require('fast-xml-parser');

const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
});

const COLORS = {
    MAJOR_TSUNAMI: '#ff00ff',
    TSUNAMI_WARNING: '#FF2800',
    TSUNAMI_ADVISORY: '#FAF500'
};

function formatTime(isoString) {
    if (!isoString) return '';
    const date = new Date(isoString);
    if (isNaN(date.getTime())) return isoString;
    const hours = date.getHours();
    const minutes = date.getMinutes();
    const ampm = hours < 12 ? '午前' : '午後';
    const displayHours = hours % 12 || 12;
    return `${ampm}${displayHours}時${minutes}分`;
}

function parseTsunami(xml) {
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
        originTimeFormatted: body.Earthquake ? formatTime(body.Earthquake.OriginTime) : null,
        eventId: head.EventID,
        infoType: head.InfoType,
        infoKind: head.InfoKind,
        headline: head.Headline?.Text || '',
        comment: body.Comments?.FreeFormComment || '',
    };

    if (body.Tsunami) {
        const tsunami = body.Tsunami;
        result.tsunami = {
            forecasts: [],
            groups: {
                majorTsunami: [],
                warning: [],
                advisory: []
            }
        };

        if (tsunami.Forecast) {
            const items = Array.isArray(tsunami.Forecast.Item) 
                ? tsunami.Forecast.Item 
                : [tsunami.Forecast.Item];

            result.tsunami.forecasts = items.map(item => {
                const kindCode = String(item.Category.Kind.Code);
                const areaName = item.Area.Name;
                
                // カテゴリ分け (JMAXMLコード体系に基づく)
                if (['52', '53'].includes(kindCode)) result.tsunami.groups.majorTsunami.push(areaName);
                else if (['51'].includes(kindCode)) result.tsunami.groups.warning.push(areaName);
                else if (['62'].includes(kindCode)) result.tsunami.groups.advisory.push(areaName);
                // 71, 72, 73 (若干の海面変動) は無視

                const res = {
                    area: {
                        name: item.Area.Name,
                        code: item.Area.Code,
                    },
                    category: {
                        kind: item.Category.Kind.Name,
                        code: item.Category.Kind.Code,
                    },
                    maxHeight: item.MaxHeight?.['jmx_eb:TsunamiHeight']?.description || '',
                    formattedArrivalTime: formatTime(item.FirstHeight?.ArrivalTime),
                };

                if (item.FirstHeight) {
                    res.firstHeight = {
                        arrivalTime: item.FirstHeight.ArrivalTime || '',
                        condition: item.FirstHeight.Condition || '',
                    };
                }

                if (item.Station) {
                    const stations = Array.isArray(item.Station) ? item.Station : [item.Station];
                    res.stations = stations.map(st => ({
                        name: st.Name,
                        code: st.Code,
                        highTideDateTime: st.HighTideDateTime || '',
                        arrivalTime: st.FirstHeight?.ArrivalTime || '',
                        condition: st.FirstHeight?.Condition || '',
                    }));
                }

                return res;
            });
        }
    }

    // 津波観測値 (Observation)
    if (body.Tsunami?.Observation) {
        const observation = body.Tsunami.Observation;
        result.tsunami.observations = [];
        
        const items = Array.isArray(observation.Item) ? observation.Item : [observation.Item];
        result.tsunami.observations = items.map(item => ({
            area: {
                name: item.Area.Name,
                code: item.Area.Code,
            },
            maxHeight: item.MaxHeight?.['jmx_eb:TsunamiHeight']?.description || '',
            firstHeight: item.FirstHeight ? {
                arrivalTime: item.FirstHeight.ArrivalTime || '',
                condition: item.FirstHeight.Condition || '',
            } : null
        }));
    }

    if (body.Earthquake) {
        const eq = body.Earthquake;
        result.earthquake = {
            originTime: eq.OriginTime,
            hypocenter: eq.Hypocenter ? {
                name: eq.Hypocenter.Area.Name,
                code: eq.Hypocenter.Area.Code?.['#text'] || eq.Hypocenter.Area.Code,
                coordinate: eq.Hypocenter.Area['jmx_eb:Coordinate']?.['#text'] || eq.Hypocenter.Area['jmx_eb:Coordinate'] || '',
            } : null,
            magnitude: eq['jmx_eb:Magnitude']?.['#text'] || eq['jmx_eb:Magnitude'] || 'NaN',
            magnitudeDescription: eq['jmx_eb:Magnitude']?.description || '', // マグニチュードの説明文
        };
    }

    // 震度情報 (VTSEに含まれる場合)
    if (body.Intensity) {
        const intensity = body.Intensity;
        result.intensity = {
            maxInt: intensity.Observation?.MaxInt || null,
            maxLgInt: intensity.Observation?.MaxLgInt || null,
            prefs: [],
            groups: {},
            cityGroups: {},
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
    }

    return result;
}

module.exports = { parseTsunami };
