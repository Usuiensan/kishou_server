const express = require('express');
const fetch = require('node-fetch');
const { XMLParser } = require('fast-xml-parser');
const { parseEarthquake } = require('./lib/parsers/earthquake');
const { parseTsunami } = require('./lib/parsers/tsunami');
const { parseWeather } = require('./lib/parsers/weather');
const { formatEarthquake, formatTsunami, formatWeather } = require('./lib/formatter');

const app = express();
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' });

// JMA Atom Feeds
const FEEDS = {
    EQVOL: 'https://www.data.jma.go.jp/developer/xml/feed/eqvol_l.xml',
    EXTRA: 'https://www.data.jma.go.jp/developer/xml/feed/extra_l.xml',
    OTHER: 'https://www.data.jma.go.jp/developer/xml/feed/other_l.xml',
};

// 取得対象の電文コード定義
const TARGET_CODES = {
    EARTHQUAKE: ["VXSE51", "VXSE52", "VXSE53", "VXSE62"],
    TSUNAMI: ["VTSE41", "VTSE51", "VTSE52"],
    WEATHER: ["VPWW53", "VPUW50", "VPTW60", "VPFW40", "VPOA50"]
};

// キャッシュ
const cache = {
    formatted: [],
    lastUpdate: 0,
    ttl: 60 * 1000,
};

// 処理済みURLを記録して重複取得を防止
const processedUrls = new Set();

async function fetchAndParseFeed() {
    console.log('🔄 フィード取得開始 (VRChat用形式生成)...');
    try {
        const formattedList = [];

        for (const feedKey of Object.keys(FEEDS)) {
            console.log(`📡 フィード取得中: ${feedKey}`);
            const response = await fetch(FEEDS[feedKey]);
            const xmlText = await response.text();
            const feedObj = parser.parse(xmlText);
            
            const entries = Array.isArray(feedObj.feed.entry) ? feedObj.feed.entry : [feedObj.feed.entry];

            // 各情報種別（地震、津波、気象）について、最新の1件だけを取得対象とする
            let latestFound = {
                earthquake: false,
                tsunami: false,
                weather: false
            };

            for (const entry of entries) {
                const link = (entry.link?.href || entry.link) || '';
                if (!link) continue;

                const isEarthquake = !latestFound.earthquake && TARGET_CODES.EARTHQUAKE.some(code => link.includes(code));
                const isTsunami = !latestFound.tsunami && TARGET_CODES.TSUNAMI.some(code => link.includes(code));
                const isWeather = !latestFound.weather && TARGET_CODES.WEATHER.some(code => link.includes(code));

                // 既に処理済みのURLはスキップ
                if (processedUrls.has(link)) {
                    // 処理済みでも「最新」としてはカウントする（フィードの先頭にある場合）
                    if (isEarthquake) latestFound.earthquake = true;
                    if (isTsunami) latestFound.tsunami = true;
                    if (isWeather) latestFound.weather = true;
                    continue;
                }

                if (isEarthquake) {
                    console.log(`📥 新しい地震情報を取得: ${link}`);
                    const res = await fetch(link);
                    const parsed = parseEarthquake(await res.text());
                    formattedList.push({
                        ...formatEarthquake(parsed),
                        timestamp: new Date().toISOString()
                    });
                    processedUrls.add(link);
                    latestFound.earthquake = true;
                } else if (isTsunami) {
                    console.log(`📥 新しい津波情報を取得: ${link}`);
                    const res = await fetch(link);
                    const parsed = parseTsunami(await res.text());
                    formattedList.push({
                        ...formatTsunami(parsed),
                        timestamp: new Date().toISOString()
                    });
                    processedUrls.add(link);
                    latestFound.tsunami = true;
                } else if (isWeather) {
                    console.log(`📥 新しい気象情報を取得: ${link}`);
                    const res = await fetch(link);
                    const parsed = parseWeather(await res.text());
                    formattedList.push({
                        ...formatWeather(parsed),
                        timestamp: new Date().toISOString()
                    });
                    processedUrls.add(link);
                    latestFound.weather = true;
                }

                // すべてのカテゴリの最新が見つかったら終了（現在のフィード内）
                if (latestFound.earthquake && latestFound.tsunami && latestFound.weather) break;
            }
        }

        // キャッシュ管理: 古い情報を維持（新しいのが見つからなかった場合）
        // 実際にはformattedListに新しいのがあればそれを使うが、
        // cache.formattedが空にならないように配慮
        if (formattedList.length > 0) {
            cache.formatted = formattedList;
        }
        
        cache.lastUpdate = Date.now();
        return cache.formatted;
    } catch (err) {
        console.error('❌ フィード解析エラー:', err);
        return cache.formatted;
    }
}

app.get('/jma/latest', async (req, res) => {
    const now = Date.now();
    let data;
    if (now - cache.lastUpdate > cache.ttl || !cache.formatted || cache.formatted.length === 0) {
        data = await fetchAndParseFeed();
    } else {
        data = cache.formatted;
    }
    
    // 最新の情報を1件返す
    const latest = (data && data.length > 0) ? data[0] : {
        type: "stable",
        timestamp: new Date().toISOString(),
        id: "none",
        lines: ["現在、発表されている地震・津波情報はありません。"]
    };
    
    res.json(latest);
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`🚀 JMA API Server running on http://localhost:${PORT}`);
});
