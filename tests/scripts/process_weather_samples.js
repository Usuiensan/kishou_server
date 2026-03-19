const fs = require('fs');
const path = require('path');
const { parseWeather } = require('../../lib/parsers/weather');
const { formatWeather } = require('../../lib/formatter');

const SAMPLES = [
    '../samples/xml_example/15_08_01_130412_VPWW53.xml',
    '../samples/xml_example/15_09_01_160628_VPWW53.xml',
    '../samples/xml_example/15_11_01_150916_VPWW54.xml',
    '../samples/xml_example/15_12_01_161130_VPWW54.xml',
    '../samples/xml_example/15_14_01_170216_VPWW53.xml',
    '../samples/xml_example/15_14_01_170216_VPWW54.xml'
];

const results = {};

SAMPLES.forEach(file => {
    try {
        const samplePath = path.join(__dirname, file);
        const xml = fs.readFileSync(samplePath, 'utf-8');
        const parsed = parseWeather(xml);
        const formatted = formatWeather(parsed);
        results[file] = {
            raw_parsed: parsed,
            formatted: formatted
        };
    } catch (e) {
        results[file] = { error: e.message };
    }
});

const outputPath = path.join(__dirname, '../results/weather_test_results.json');
fs.writeFileSync(outputPath, JSON.stringify(results, null, 2), 'utf-8');
console.log(`✅ Generated ${outputPath}`);
