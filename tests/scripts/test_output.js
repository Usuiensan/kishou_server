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
        type: 'tsunami',
        file: 'jmaxml_20260312_Samples/38-39_Tsunami/32-39_11_02_250206_VTSE41.xml',
        desc: '大津波警報・津波警報・津波注意報 (VTSE41)'
    }
];

function runDetailedTest() {
    console.log('🔍 詳細な出力テストを開始します...');
    
    samples.forEach(sample => {
        console.log(`\n================================================================`);
        console.log(`📋 ${sample.desc}`);
        console.log(`================================================================`);
        
        const filePath = path.join(__dirname, sample.file);
        if (!fs.existsSync(filePath)) {
            console.error(`❌ ファイルが見つかりません: ${filePath}`);
            return;
        }

        const xml = fs.readFileSync(filePath, 'utf-8');
        try {
            const result = sample.type === 'earthquake' ? parseEarthquake(xml) : parseTsunami(xml);
            
            // 全エリアの情報を一覧表示
            if (result.intensity) {
                console.log('📢 【震度観測地域一覧】');
                result.intensity.prefs.forEach(pref => {
                    console.log(`📍 ${pref.name} (最大震度: ${pref.maxInt})`);
                    pref.areas.forEach(area => {
                        console.log(`  - ${area.name} (最大震度: ${area.maxInt})`);
                    });
                });
            }

            if (result.tsunami) {
                console.log('🌊 【津波予報地域一覧】');
                result.tsunami.forecasts.forEach(f => {
                    console.log(`🚩 ${f.area.name}: ${f.category.kind} (予想高さ: ${f.maxHeight})`);
                    if (f.firstHeight?.arrivalTime || f.firstHeight?.condition) {
                        console.log(`   到達予想: ${f.firstHeight.arrivalTime || ''} ${f.firstHeight.condition || ''}`);
                    }
                });
            }

            // フルデータをファイルに保存して確認できるようにする
            const outputFileName = `test_output_${sample.type}.json`;
            fs.writeFileSync(outputFileName, JSON.stringify(result, null, 2));
            console.log(`\n✅ 全データは '${outputFileName}' に保存されました。`);
            
        } catch (err) {
            console.error(`❌ エラー: ${err.message}`);
        }
    });
}

runDetailedTest();
