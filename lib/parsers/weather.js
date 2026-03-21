const { XMLParser } = require('fast-xml-parser');

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' });

function parseWeather(xml) {
    try {
        const obj = parser.parse(xml);
        const report = obj.Report;
        if (!report) return { title: '不明な電文', groups: [] };

        const head = report.Head;
        
        const result = {
            title: head.Title || report.Control.Title || '',
            status: report.Control.Status || '通常',
            reportDateTime: head.ReportDateTime || '',
            headline: (head.Headline?.Text || '').replace(/\s+/g, ' ').trim(),
            infoKind: head.InfoKind || '',
            groups: [] // [{ kind: '大雨特別警報', areas: ['奈良市', '大和高田市', ...] }]
        };

        // Headline/Information から種別ごとのエリアを抽出
        if (head.Headline && head.Headline.Information) {
            const infos = Array.isArray(head.Headline.Information) 
                ? head.Headline.Information 
                : [head.Headline.Information];
            
            // 文字数節約のため、地方レベル（まとめた地域）を優先する
            // 優先順位: 市町村等をまとめた地域等 > 二次細分区域等 > 市町村等 > 発表細分 > 一次細分区域等 > 府県予報区等
            const priorityOrder = [
                '（市町村等をまとめた地域等）',
                '（二次細分区域等）',
                '（市町村等）',
                '（発表細分）',
                '（一次細分区域等）',
                '（府県予報区等）'
            ];

            let bestInfo = null;
            for (const typeKey of priorityOrder) {
                bestInfo = infos.find(i => i.type && i.type.includes(typeKey));
                if (bestInfo) break;
            }

            const targetInfos = bestInfo ? [bestInfo] : infos;

            for (const info of targetInfos) {
                if (!info.Item) continue;
                
                const items = Array.isArray(info.Item) ? info.Item : [info.Item];
                for (const item of items) {
                    const kinds = Array.isArray(item.Kind) ? item.Kind : [item.Kind];
                    const areas = Array.isArray(item.Areas?.Area) ? item.Areas.Area : (item.Areas?.Area ? [item.Areas.Area] : []);
                    const areaNames = areas.map(a => a.Name);

                    for (const kind of kinds) {
                        const kindName = kind?.Name || '';
                        if (!kindName) continue;
                        
                        const isTarget = kindName.includes('特別警報') || 
                                        kindName.includes('警報') || 
                                        kindName.includes('注意報') || 
                                        kindName.includes('土砂災害警戒情報') ||
                                        kindName.includes('線状降水帯') ||
                                        kindName.includes('記録的短時間大雨');
                        
                        if (isTarget) {
                            let group = result.groups.find(g => g.kind === kindName);
                            if (group) {
                                group.areas = Array.from(new Set([...group.areas, ...areaNames]));
                            } else {
                                result.groups.push({ kind: kindName, areas: areaNames });
                            }
                        }
                    }
                }
            }
        }

        return result;
    } catch (e) {
        console.error('Weather Parse Error:', e);
        return { title: '解析エラー', headline: '電文の解析に失敗しました。', groups: [] };
    }
}

module.exports = { parseWeather };
