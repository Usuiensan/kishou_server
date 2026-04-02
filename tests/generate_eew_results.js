const fs = require('fs');
const path = require('path');
const { parseEarthquake } = require('../lib/parsers/earthquake');
const { formatEarthquake } = require('../lib/formatter');

const samplesDir = path.join(__dirname, 'samples/xml_example/jmaxml_20260312_Samples/36-37_EEW');
const resultsDir = path.join(__dirname, 'results');

if (!fs.existsSync(resultsDir)) {
    fs.mkdirSync(resultsDir, { recursive: true });
}

const testSamples = [
    { name: 'VXSE43_Warning', file: '37_01_02_240613_VXSE43.xml' },
    { name: 'VXSE44_Forecast', file: '36_01_10_240613_VXSE44.xml' }
];

testSamples.forEach(sample => {
    const xmlPath = path.join(samplesDir, sample.file);
    if (!fs.existsSync(xmlPath)) {
        console.error(`Sample not found: ${xmlPath}`);
        return;
    }

    try {
        const xml = fs.readFileSync(xmlPath, 'utf-8');
        const parsed = parseEarthquake(xml);
        const formatted = formatEarthquake(parsed);
        
        if (!formatted) {
            console.log(`Skipped (not a warning): ${sample.file}`);
            return;
        }

        const resultPath = path.join(resultsDir, `test_result_${sample.file.split('_').pop().replace('.xml', '')}.json`);
        
        fs.writeFileSync(resultPath, JSON.stringify(formatted, null, 2));
        console.log(`Generated: ${resultPath}`);
    } catch (e) {
        console.error(`Error processing ${sample.file}:`, e);
    }
});
