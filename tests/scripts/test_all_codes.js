const fs = require('fs');
const path = require('path');
const { parseEarthquake } = require('../../lib/parsers/earthquake');
const { parseTsunami } = require('../../lib/parsers/tsunami');
const { parseWeather } = require('../../lib/parsers/weather');
const { formatEarthquake, formatTsunami, formatWeather } = require('../../lib/formatter');
const { formatLinesForDebug } = require('../../lib/discordWebhook');

const TEST_SAMPLES = [
    { type: 'earthquake', code: 'VXSE51', file: '../samples/32-39_11_01_120615_VXSE51.xml' },
    { type: 'earthquake', code: 'VXSE52', file: '../samples/33_12_01_240613_VXSE52.xml' },
    { type: 'earthquake', code: 'VXSE53', file: '../samples/32-39_11_05_240613_VXSE53.xml' },
    { type: 'earthquake', code: 'VXSE62', file: '../samples/78_01_01_240613_VXSE62.xml' },
    { type: 'tsunami', code: 'VTSE41', file: '../samples/32-39_11_02_250206_VTSE41.xml' },
    { type: 'tsunami', code: 'VTSE51', file: '../samples/32-39_11_03_250206_VTSE51.xml' },
    { type: 'tsunami', code: 'VTSE52', file: '../samples/32-39_12_05_250206_VTSE52.xml' },
    { type: 'weather', code: 'VPWW53', file: '../samples/15_14_01_170216_VPWW53.xml' },
    { type: 'weather', code: 'VPOA50', file: '../samples/18_01_01_100806_VPOA50.xml' }
];

const resultsDir = path.join(__dirname, '../results');
fs.mkdirSync(resultsDir, { recursive: true });

async function runTests() {
    console.log('🧪 Starting Output Tests for all available codes...');
    const results = [];

    for (const sample of TEST_SAMPLES) {
        try {
            console.log(`Testing ${sample.code} (${sample.type})...`);
            const samplePath = path.join(__dirname, sample.file);
            const xml = fs.readFileSync(samplePath, 'utf-8');
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

            const outputName = path.join(resultsDir, `test_result_${sample.code}.json`);
            const discordMarkdown = formatted ? formatLinesForDebug(formatted) : '';
            fs.writeFileSync(outputName, JSON.stringify(formatted, null, 2), 'utf-8');
            const markdownName = path.join(resultsDir, `test_result_${sample.code}.md`);
            fs.writeFileSync(markdownName, discordMarkdown, 'utf-8');
            if (discordMarkdown) {
                console.log('📨 Discord本文を ' + markdownName + ' に保存しました');
            }
            console.log(`✅ Saved ${outputName}`);
            results.push({ code: sample.code, success: true });
        } catch (err) {
            console.error(`❌ Failed to test ${sample.code}:`, err.message);
            results.push({ code: sample.code, success: false, error: err.message });
        }
    }

    console.log('\n📊 Test Summary:');
    results.forEach(r => console.log(`${r.code}: ${r.success ? 'PASS' : 'FAIL'} ${r.error || ''}`));
    const failed = results.filter((result) => !result.success);
    if (failed.length > 0) {
        console.error(`\n❌ Output tests failed: ${failed.length}/${results.length}`);
        process.exitCode = 1;
    } else {
        console.log(`\n✅ Output tests passed: ${results.length}/${results.length}`);
    }
}

runTests();
