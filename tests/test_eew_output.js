const fs = require('fs');
const path = require('path');
const { parseEarthquake } = require('../lib/parsers/earthquake');
const { formatEarthquake } = require('../lib/formatter');

// EEW サンプル (VXSE43 警報)
const eewSamplePath = path.join(__dirname, 'samples/xml_example/jmaxml_20260312_Samples/36-37_EEW/37_01_02_240613_VXSE43.xml');

try {
    console.log('--- Testing EEW (Warning) ---');
    const xml = fs.readFileSync(eewSamplePath, 'utf-8');
    const parsed = parseEarthquake(xml);
    const formatted = formatEarthquake(parsed);

    console.log(JSON.stringify(formatted, null, 2));

    // 通常の地震サンプルの duration も確認
    console.log('\n--- Testing Normal Earthquake (with duration) ---');
    const normalSamplePath = path.join(__dirname, 'samples/xml_example/jmaxml_20260312_Samples/33_12_01_240613_VXSE52.xml');
    const xmlNormal = fs.readFileSync(normalSamplePath, 'utf-8');
    const parsedNormal = parseEarthquake(xmlNormal);
    const formattedNormal = formatEarthquake(parsedNormal);
    console.log(JSON.stringify(formattedNormal, null, 2));

} catch (e) {
    console.error('Test Error:', e);
}
