const fs = require('fs');
const path = require('path');
const { parseEarthquake } = require('./lib/parsers/earthquake');
const { parseTsunami } = require('./lib/parsers/tsunami');
const { parseWeather } = require('./lib/parsers/weather');
const { formatEarthquake, formatTsunami, formatWeather } = require('./lib/formatter');

const TEST_SAMPLES = [
    { type: 'earthquake', code: 'VXSE51', file: 'xml_example/jmaxml_20260312_Samples/38-39_Tsunami/32-39_11_01_120615_VXSE51.xml' },
    { type: 'earthquake', code: 'VXSE52', file: 'xml_example/jmaxml_20260312_Samples/33_12_01_240613_VXSE52.xml' },
    { type: 'earthquake', code: 'VXSE53', file: 'xml_example/jmaxml_20260312_Samples/38-39_Tsunami/32-39_11_05_240613_VXSE53.xml' },
    { type: 'earthquake', code: 'VXSE62', file: 'xml_example/jmaxml_20260312_Samples/77-80_EEW_LPM_Aftermath/78_01_01_240613_VXSE62.xml' },
    { type: 'tsunami', code: 'VTSE41', file: 'xml_example/jmaxml_20260312_Samples/38-39_Tsunami/32-39_11_02_250206_VTSE41.xml' },
    { type: 'tsunami', code: 'VTSE51', file: 'xml_example/jmaxml_20260312_Samples/38-39_Tsunami/32-39_11_03_250206_VTSE51.xml' },
    { type: 'tsunami', code: 'VTSE52', file: 'xml_example/jmaxml_20260312_Samples/38-39_Tsunami/32-39_12_05_250206_VTSE52.xml' },
    { type: 'weather', code: 'VPWW53', file: 'xml_example/15_14_01_170216_VPWW53.xml' },
    { type: 'weather', code: 'VPOA50', file: 'xml_example/18_01_01_100806_VPOA50.xml' }
];

async function runTests() {
    console.log('🧪 Starting Output Tests for all available codes...');
    const results = [];

    for (const sample of TEST_SAMPLES) {
        try {
            console.log(`Testing ${sample.code} (${sample.type})...`);
            const xml = fs.readFileSync(sample.file, 'utf-8');
            let parsed, formatted;

            if (sample.type === 'earthquake') {
                parsed = parseEarthquake(xml);
                formatted = formatEarthquake(parsed);
            } else if (sample.type === 'tsunami') {
                parsed = parseTsunami(xml);
                formatted = formatTsunami(parsed);
            } else if (sample.type === 'weather') {
                parsed = parseWeather(xml);
                formatted = formatWeather(parsed);
            }

            const outputName = `test_result_${sample.code}.json`;
            fs.writeFileSync(outputName, JSON.stringify(formatted, null, 2), 'utf-8');
            console.log(`✅ Saved ${outputName}`);
            results.push({ code: sample.code, success: true });
        } catch (err) {
            console.error(`❌ Failed to test ${sample.code}:`, err.message);
            results.push({ code: sample.code, success: false, error: err.message });
        }
    }

    console.log('\n📊 Test Summary:');
    results.forEach(r => console.log(`${r.code}: ${r.success ? 'PASS' : 'FAIL'} ${r.error || ''}`));
}

runTests();
