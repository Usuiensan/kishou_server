const express = require('express');
const fetch = require('node-fetch');
const { XMLParser } = require('fast-xml-parser');
const { parseEarthquake } = require('./lib/parsers/earthquake');
const { parseTsunami } = require('./lib/parsers/tsunami');
const { formatEarthquake, formatTsunami } = require('./lib/formatter');

const app = express();
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' });

// JMA Atom Feeds
const FEEDS = {
    EQVOL: 'https://www.data.jma.go.jp/developer/xml/feed/eqvol_l.xml',
};

// 取得対象の電文コード定義
const TARGET_CODES = {
    EARTHQUAKE: ["VXSE51", "VXSE52", "VXSE53", "VXSE62"],
    TSUNAMI: ["VTSE41", "VTSE51", "VTSE52"]
};

// キャッシュ
const cache = {
    formatted: [],
    lastUpdate: 0,
    ttl: 60 * 1000,
};

async function fetchAndParseFeed() {
    console.log('🔄 フィード取得開始 (VRChat用形式生成)...');
    try {
        const response = await fetch(FEEDS.EQVOL);
        const xmlText = await response.text();
        const feedObj = parser.parse(xmlText);
        
        const entries = Array.isArray(feedObj.feed.entry) ? feedObj.feed.entry : [feedObj.feed.entry];
        
        const formattedList = [];

        for (const entry of entries) {
            const link = entry.link.href || entry.link;
            const isEarthquake = TARGET_CODES.EARTHQUAKE.some(code => link.includes(code));
            const isTsunami = TARGET_CODES.TSUNAMI.some(code => link.includes(code));

            if (isEarthquake) {
                const res = await fetch(link);
                const parsed = parseEarthquake(await res.text());
                formattedList.push({
                    ...formatEarthquake(parsed),
                    timestamp: new Date().toISOString()
                });
            } else if (isTsunami) {
                const res = await fetch(link);
                const parsed = parseTsunami(await res.text());
                formattedList.push({
                    ...formatTsunami(parsed),
                    timestamp: new Date().toISOString()
                });
            }
        }

        cache.formatted = formattedList;
        cache.lastUpdate = Date.now();
        return formattedList;
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
