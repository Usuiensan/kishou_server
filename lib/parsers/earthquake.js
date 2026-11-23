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

function areasFromHeadlineInformation(information, type) {
    const entry = information.find((item) => item.type?.includes(type));
    if (!entry?.Item) return [];
    const items = Array.isArray(entry.Item) ? entry.Item : [entry.Item];
    const areas = new Map();
    for (const item of items) {
        const raw = item.Areas?.Area;
        for (const area of raw ? (Array.isArray(raw) ? raw : [raw]) : []) {
            if (area.Name) areas.set(area.Name, { name: area.Name, code: area.Code || null });
        }
    }
    return [...areas.values()];
}

function eewForecastAreas(forecast) {
    const prefs = forecast?.Pref ? (Array.isArray(forecast.Pref) ? forecast.Pref : [forecast.Pref]) : [];
    return prefs.flatMap(pref => (pref.Area ? (Array.isArray(pref.Area) ? pref.Area : [pref.Area]) : []).map(area => ({
        name: area.Name || '', pref: pref.Name || '', code: Number(area.Code) || null,
        scaleFrom: area.ForecastInt?.From || '', scaleTo: area.ForecastInt?.To || '',
        kindCode: Number(area.Category?.Kind?.Code) || null,
        arrivalTime: area.ArrivalTime || null,
    })));
}

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

// 観測点名から市区町村名を取り出す。気象庁の観測点名は「市区町村名＋町名等」
// の形だが、政令指定都市は「横浜鶴見区…」のように市名 (「市」を省く) ＋区名
// で始まるもの、東京23区は「東京千代田区…」と都名を冠するもの、県名を冠する
// もの (「茨城鹿嶋市…」「山形小国町…」) がある。市区町村名を取り出せない
// 名前 (空港など市区町村名を含まないもの) は null を返し、呼び出し側で
// 観測点名のまま使う (誤った市区町村には丸めない)。
const DESIGNATED_CITY_NAMES = [
    '札幌市', '仙台市', 'さいたま市', '千葉市', '横浜市', '川崎市', '相模原市',
    '新潟市', '静岡市', '浜松市', '名古屋市', '京都市', '大阪市', '堺市',
    '神戸市', '岡山市', '広島市', '北九州市', '福岡市', '熊本市',
];
const TOKYO_SPECIAL_WARDS = [
    '千代田区', '中央区', '港区', '新宿区', '文京区', '台東区', '墨田区',
    '江東区', '品川区', '目黒区', '大田区', '世田谷区', '渋谷区', '中野区',
    '杉並区', '豊島区', '北区', '荒川区', '板橋区', '練馬区', '足立区',
    '葛飾区', '江戸川区',
];
const PREFECTURE_SHORT_NAMES = [
    '北海道', '青森', '岩手', '宮城', '秋田', '山形', '福島', '茨城', '栃木',
    '群馬', '埼玉', '千葉', '東京', '神奈川', '新潟', '富山', '石川', '福井',
    '山梨', '長野', '岐阜', '静岡', '愛知', '三重', '滋賀', '京都', '大阪',
    '兵庫', '奈良', '和歌山', '鳥取', '島根', '岡山', '広島', '山口', '徳島',
    '香川', '愛媛', '高知', '福岡', '佐賀', '長崎', '熊本', '大分', '宮崎',
    '鹿児島', '沖縄',
];

function municipalitySuffixIndex(chars, suffix) {
    // 接頭辞 (市区町村名の本体) が2字以上になる最初の位置。「大町町」の
    // 1字目の「町」のような、市区町村名そのものに含まれる字では切らない。
    for (let i = 2; i < chars.length; i += 1) {
        if (chars[i] === suffix) return i;
    }
    return -1;
}

function municipalityOfStation(stationName) {
    const chars = [...String(stationName || '')];
    if (!chars.length) return null;
    const name = chars.join('');
    // 政令指定都市 (「横浜市…」と「横浜鶴見区…」のどちらもその市)。
    for (const city of DESIGNATED_CITY_NAMES) {
        if (name.startsWith(city)) return city;
        const shortName = city.slice(0, -1);
        if (!name.startsWith(shortName)) continue;
        const rest = name.slice(shortName.length);
        const wardEnd = rest.indexOf('区');
        if (wardEnd >= 1 && wardEnd <= 3 && !/[市町村]/.test(rest.slice(0, wardEnd))) return city;
    }
    // 東京23区 (特別区そのものが市区町村。「東京…」の都名冠りも同じ区)。
    for (const ward of TOKYO_SPECIAL_WARDS) {
        if (name.startsWith(ward) || name.startsWith(`東京${ward}`)) return ward;
    }
    // 県名冠りは県名を外して判定し直す。外して解釈できない名前 (「山形市」
    // のように県名で始まる市区町村そのもの) は元の名前で判定する。
    for (const pref of PREFECTURE_SHORT_NAMES) {
        if (name.startsWith(pref) && name.length > pref.length) {
            const stripped = municipalityOfStation(name.slice(pref.length));
            if (stripped) return stripped;
        }
    }
    // 一般形: 市→町→村の順に、接頭辞2字以上で最初に現れる字で切る
    // (「武蔵村山市」の「村」のような市区町村名内部の字で切らないため、
    // 町・村より市を優先する)。「四日市市」「廿日市市」のように本体が
    // 「市」で終わる市は、次の字も「市」ならそこまでを市名とする。
    for (const suffix of ['市', '町', '村']) {
        const index = municipalitySuffixIndex(chars, suffix);
        if (index > 0) {
            const end = suffix === '市' && chars[index + 1] === '市' ? index + 1 : index;
            return chars.slice(0, end + 1).join('');
        }
    }
    return null;
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
        serial: head.Serial || null,
        infoKind: head.InfoKind,
        headline: head.Headline?.Text || '',
        comment: body.Comments?.ForecastComment?.Text || body.Comments?.FreeFormComment || '',
        warningComment: body.Comments?.WarningComment?.Text || '',
        // true=津波への言及あり / false=心配なしの明記あり / null=未確定
        tsunamiWorry: null,
        // EEW 判定
        isEEW: head.InfoKind === '緊急地震速報' || head.InfoKind?.includes('緊急地震速報'),
        isWarning: head.Title?.includes('警報') || head.Headline?.Text?.includes('警報'),
        eventId: head.EventID,
        infoType: head.InfoType,
        eewAreas: [],
        eewAreaDetails: [],
        eewForecastAreas: [],
    };

    // 仮定震源要素 (PLUM 法のみで震源未推定) の判別。気象庁の判別方法どおり
    // <Earthquake><Condition>仮定震源要素</Condition> を見る。このとき緯度経度・
    // 深さ・M は観測点座標と固定値で意味を持たないため、震源名も含め表示しない。
    const eqCondition = body.Earthquake?.Condition;
    const eqConditionText = typeof eqCondition === 'string' ? eqCondition : (eqCondition?.['#text'] || '');
    const hypocenterAssumed = eqConditionText.includes('仮定震源要素');

    // EEW で Headline を構築する (「震源地で地震 強い揺れに警戒」の固定形式)
    if (result.isEEW && result.infoType !== '取消') {
        const areaName = hypocenterAssumed ? '' : (body.Earthquake?.Hypocenter?.Area?.Name || '');
        result.headline = areaName ? `${areaName}で地震 強い揺れに警戒` : '強い揺れに警戒';
    }

    // EEW の地域情報を抽出 (府県予報区レベルを使用し、指定の名称にマッピング)
    if (result.isEEW && head.Headline?.Information) {
        const info = Array.isArray(head.Headline.Information) ? head.Headline.Information : [head.Headline.Information];
        
        result.eewAreaDetails = areasFromHeadlineInformation(info, '細分区域');

        // 府県予報区レベルは震度地図の対象県を引く既存一覧として保持する。
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

    if (result.isEEW) result.eewForecastAreas = eewForecastAreas(body.Intensity?.Forecast);

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
                ...(hypocenterAssumed ? { assumed: true } : {}),
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
            // VXSE62 などでは、長周期地震動の地域階級が
            // Intensity.Observation.Pref[].Area[].MaxLgInt に格納される。
            // 最大階級だけでなく、既存の震度表示と同じく階級ごとの地域一覧を保持する。
            const groups = {};
            const prefs = Array.isArray(intensity.Observation.Pref)
                ? intensity.Observation.Pref
                : (intensity.Observation.Pref ? [intensity.Observation.Pref] : []);
            for (const pref of prefs) {
                const areas = Array.isArray(pref.Area) ? pref.Area : (pref.Area ? [pref.Area] : []);
                for (const area of areas) {
                    const lgInt = area.MaxLgInt;
                    const name = area.Name;
                    if (!lgInt || !name) continue;
                    if (!groups[lgInt]) groups[lgInt] = [];
                    if (!groups[lgInt].includes(name)) groups[lgInt].push(name);
                }
            }
            result.lgIntensity = { maxLgInt: intensity.Observation.MaxLgInt, groups };
        }

        // 長周期地震動の観測点別階級 (VXSE62等)。観測点は Intensity.Observation の
        // Pref > Area > IntensityStation に LgInt 付きで並ぶ (観測点名は市区町村名を含む)。
        // 細分区域単位の groups とは別に stationGroups へ保持し、groups の意味は変えない。
        // あわせて市区町村単位に丸めた cityGroups (市区町村ごとの最大階級) も作る。
        if (result.lgIntensity) {
            const stationGroups = {};
            const cityMaxLgInt = new Map();
            for (const pref of prefs) {
                const areas = Array.isArray(pref.Area) ? pref.Area : (pref.Area ? [pref.Area] : []);
                for (const area of areas) {
                    const stations = area.IntensityStation
                        ? (Array.isArray(area.IntensityStation) ? area.IntensityStation : [area.IntensityStation])
                        : [];
                    for (const station of stations) {
                        const lgInt = station.LgInt == null ? '' : String(station.LgInt);
                        if (!['1', '2', '3', '4'].includes(lgInt) || !station.Name) continue;
                        if (!stationGroups[lgInt]) stationGroups[lgInt] = [];
                        if (!stationGroups[lgInt].includes(station.Name)) stationGroups[lgInt].push(station.Name);
                        const city = municipalityOfStation(station.Name) || station.Name;
                        const previous = cityMaxLgInt.get(city);
                        if (previous === undefined || Number(lgInt) > Number(previous)) {
                            cityMaxLgInt.set(city, lgInt);
                        }
                    }
                }
            }
            if (Object.keys(stationGroups).length) result.lgIntensity.stationGroups = stationGroups;
            if (cityMaxLgInt.size) {
                const cityGroups = {};
                for (const [city, lgInt] of cityMaxLgInt) {
                    if (!cityGroups[lgInt]) cityGroups[lgInt] = [];
                    cityGroups[lgInt].push(city);
                }
                result.lgIntensity.cityGroups = cityGroups;
            }
        }
    }

    return result;
}

module.exports = {
    parseEarthquake,
    eewForecastAreas,
    formatTime,
    municipalityOfStation,
    EEW_HOKKAIDO_MAPPING,
    TARGET_EEW_AREAS
};
