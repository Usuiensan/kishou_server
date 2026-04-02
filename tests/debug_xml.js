const fs = require('fs');
const path = require('path');
const { XMLParser } = require('fast-xml-parser');
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' });

const eewSamplePath = path.join(__dirname, 'samples/xml_example/jmaxml_20260312_Samples/36-37_EEW/37_01_02_240613_VXSE43.xml');

try {
    const xml = fs.readFileSync(eewSamplePath, 'utf-8');
    const jsonObj = parser.parse(xml);
    console.log(JSON.stringify(jsonObj.Report.Head.Headline, null, 2));
} catch (e) {
    console.error(e);
}
