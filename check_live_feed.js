const fetch = require('node-fetch');
const { XMLParser } = require('fast-xml-parser');
const { parseEarthquake } = require('./lib/parsers/earthquake');
const { parseTsunami } = require('./lib/parsers/tsunami');
const { formatEarthquake, formatTsunami } = require('./lib/formatter');

const FEEDS = {
    EQVOL: 'https://www.data.jma.go.jp/developer/xml/feed/eqvol_l.xml',
};

const TARGET_CODES = {
    EARTHQUAKE: ["VXSE51", "VXSE52", "VXSE53", "VXSE62"],
    TSUNAMI: ["VTSE41", "VTSE51", "VTSE52"]
};

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' });

async function verifyLiveFeed() {
    console.log('🌍 気象庁フィードから最新情報を取得中...');
    try {
        const response = await fetch(FEEDS.EQVOL);
        const xmlText = await response.text();
        const feedObj = parser.parse(xmlText);
        
        const entries = Array.isArray(feedObj.feed.entry) ? feedObj.feed.entry : [feedObj.feed.entry];
        
        console.log(`✅ フィードの取得に成功しました。エントリ数: ${entries.length}`);

        let found = false;
        for (const entry of entries) {
            const link = entry.link.href || entry.link;
            const title = entry.title;
            
            const isEarthquake = TARGET_CODES.EARTHQUAKE.some(code => link.includes(code));
            const isTsunami = TARGET_CODES.TSUNAMI.some(code => link.includes(code));

            if (isEarthquake || isTsunami) {
                found = true;
                console.log(`\n🔍 ターゲット電文を発見: ${title}`);
                console.log(`🔗 リンク: ${link}`);
                
                const res = await fetch(link);
                const xmlContent = await res.text();

                if (isEarthquake) {
                    const parsed = parseEarthquake(xmlContent);
                    const formatted = formatEarthquake(parsed);
                    console.log('--- 解析結果 (地震) ---');
                    console.log(formatted.lines.join('\n'));
                } else if (isTsunami) {
                    const parsed = parseTsunami(xmlContent);
                    const formatted = formatTsunami(parsed);
                    console.log('--- 解析結果 (津波) ---');
                    console.log(formatted.lines.join('\n'));
                }
                break; // 最初の1件のみ確認
            }
        }

        if (!found) {
            console.log('\n😴 現在、フィード内に解析対象（地震・津波）の電文はありませんでした。');
            console.log('フィード内の最新タイトル一覧:');
            entries.slice(0, 5).forEach(e => console.log(`- ${e.title}`));
        }

    } catch (err) {
        console.error('❌ エラーが発生しました:', err);
    }
}

verifyLiveFeed();
