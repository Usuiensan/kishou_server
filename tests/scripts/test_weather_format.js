const fs = require('fs');
const path = require('path');
const { parseWeather } = require('./lib/parsers/weather');
const { formatWeather } = require('./lib/formatter');

const samples = [
    'xml_example/15_08_01_130412_VPWW53.xml', // 特別警報
    'xml_example/18_01_01_100806_VPOA50.xml', // 記録的短時間大雨
];

function testWeather() {
    console.log('✨ 気象情報のフォーマットテストを開始します...\n');

    samples.forEach(file => {
        if (!fs.existsSync(file)) {
            console.log(`⚠️ ファイルが見つかりません: ${file}`);
            return;
        }

        const xml = fs.readFileSync(file, 'utf-8');
        const parsed = parseWeather(xml);
        const formatted = formatWeather(parsed);

        console.log(`--- ${path.basename(file)} ---`);
        console.log(JSON.stringify(formatted, null, 2));
        console.log('\n');
    });
}

testWeather();
