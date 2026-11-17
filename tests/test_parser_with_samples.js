const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { parseEarthquake } = require('../lib/parsers/earthquake');
const { formatEarthquake } = require('../lib/formatter');

// テスト用サンプル（長周期地震動を含む想定のもの）
const samplePath = path.join(__dirname, 'samples/32-35_01_03_240613_VXSE53.xml');

try {
    const xml = fs.readFileSync(samplePath, 'utf-8');
    const parsed = parseEarthquake(xml);
    const formatted = formatEarthquake(parsed);

    const intensityXml = fs.readFileSync(path.join(__dirname, 'samples/32-35_01_01_100806_VXSE51.xml'), 'utf-8');
    assert.strictEqual(parseEarthquake(intensityXml).tsunamiWorry, null);

    const hypocenterXml = fs.readFileSync(path.join(__dirname, 'samples/32-35_01_02_240613_VXSE52.xml'), 'utf-8');
    assert.strictEqual(parseEarthquake(hypocenterXml).tsunamiWorry, false);

    console.log('--- Parsed Data ---');
    console.log(JSON.stringify(parsed, (key, value) => key === 'intensity' ? undefined : value, 2)); // 震度は長いので除外

    console.log('\n--- Formatted Lines ---');
    formatted.lines.forEach(line => console.log(line));

} catch (e) {
    console.error('Test Error:', e);
    process.exitCode = 1;
}
