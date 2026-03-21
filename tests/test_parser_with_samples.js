const fs = require('fs');
const path = require('path');
const { parseEarthquake } = require('../lib/parsers/earthquake');
const { formatEarthquake } = require('../lib/formatter');

// テスト用サンプル（長周期地震動を含む想定のもの）
const samplePath = path.join(__dirname, 'samples/xml_example/jmaxml_20260312_Samples/38-39_Tsunami/32-39_05_01_100831_VXSE53.xml');

try {
    const xml = fs.readFileSync(samplePath, 'utf-8');
    const parsed = parseEarthquake(xml);
    const formatted = formatEarthquake(parsed);

    console.log('--- Parsed Data ---');
    console.log(JSON.stringify(parsed, (key, value) => key === 'intensity' ? undefined : value, 2)); // 震度は長いので除外

    console.log('\n--- Formatted Lines ---');
    formatted.lines.forEach(line => console.log(line));

} catch (e) {
    console.error('Test Error:', e);
}
