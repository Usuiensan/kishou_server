const fs = require('fs');
const path = require('path');
const { parseEarthquake } = require('./lib/parsers/earthquake');
const { parseTsunami } = require('./lib/parsers/tsunami');

const samples = [
    {
        type: 'earthquake',
        file: 'jmaxml_20260312_Samples/38-39_Tsunami/32-39_11_01_120615_VXSE51.xml',
        desc: '震度速報 (VXSE51)'
    },
    {
        type: 'earthquake',
        file: 'jmaxml_20260312_Samples/33_12_01_240613_VXSE52.xml',
        desc: '震源に関する情報 (VXSE52)'
    },
    {
        type: 'earthquake',
        file: 'jmaxml_20260312_Samples/38-39_Tsunami/32-39_11_05_240613_VXSE53.xml',
        desc: '震源・震度に関する情報 (VXSE53)'
    },
    {
        type: 'tsunami',
        file: 'jmaxml_20260312_Samples/38-39_Tsunami/32-39_11_02_250206_VTSE41.xml',
        desc: '大津波警報・津波警報・津波注意報 (VTSE41)'
    },
    {
        type: 'tsunami',
        file: 'jmaxml_20260312_Samples/38-39_Tsunami/32-39_11_03_250206_VTSE51.xml',
        desc: '津波到達予想時刻・予想される津波の高さ (VTSE51)'
    }
];

async function runTests() {
    console.log('🧪 パーサーの検証を開始します...');
    
    for (const sample of samples) {
        console.log(`\n--- ${sample.desc} ---`);
        const filePath = path.join(__dirname, sample.file);
        if (!fs.existsSync(filePath)) {
            console.error(`❌ ファイルが見つかりません: ${filePath}`);
            continue;
        }

        const xml = fs.readFileSync(filePath, 'utf-8');
        try {
            let result;
            if (sample.type === 'earthquake') {
                result = parseEarthquake(xml);
            } else {
                result = parseTsunami(xml);
            }
            // console.log(JSON.stringify(result, null, 2));
            console.log(`✅ パース成功: ${result.title} (${result.eventId})`);
            if (result.earthquake) {
                console.log(`📍 震央: ${result.earthquake.hypocenter?.name || '不明'}`);
            }
            if (result.intensity) {
                console.log(`📢 最大震度: ${result.intensity.maxInt}`);
            }
            if (result.tsunami) {
                console.log(`🌊 津波警報エリア数: ${result.tsunami.forecasts.length}`);
            }
        } catch (err) {
            console.error(`❌ パースエラー: ${err.message}`);
        }
    }
}

runTests();
