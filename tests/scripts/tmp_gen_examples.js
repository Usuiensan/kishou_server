const fs = require('fs');
const { parseEarthquake } = require('./lib/parsers/earthquake');
const { parseTsunami } = require('./lib/parsers/tsunami');
const { parseWeather } = require('./lib/parsers/weather');
const { formatEarthquake, formatTsunami, formatWeather } = require('./lib/formatter');

const SAMPLES = [
    { type: 'earthquake', code: 'VXSE53', file: 'xml_example/jmaxml_20260312_Samples/38-39_Tsunami/32-39_11_05_240613_VXSE53.xml' },
    { type: 'tsunami', code: 'VTSE41', file: 'xml_example/jmaxml_20260312_Samples/38-39_Tsunami/32-39_11_02_250206_VTSE41.xml' },
    { type: 'weather', code: 'VPWW53', file: 'xml_example/15_14_01_170216_VPWW53.xml' }
];

SAMPLES.forEach(sample => {
    try {
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
        
        console.log(`---START_${sample.code}---`);
        console.log(JSON.stringify(formatted, null, 2));
        console.log(`---END_${sample.code}---`);
    } catch (e) {
        console.error(`Error processing ${sample.code}: ${e.message}`);
    }
});
