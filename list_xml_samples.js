const fs = require('fs');
const path = require('path');
const { XMLParser } = require('fast-xml-parser');

const parser = new XMLParser({ ignoreAttributes: false });
const dir = 'd:/kishou_server/tests/samples/xml_example';

const files = fs.readdirSync(dir).filter(f => f.endsWith('.xml'));
const results = [];

for (const file of files) {
    try {
        const content = fs.readFileSync(path.join(dir, file), 'utf-8');
        const obj = parser.parse(content);
        const report = obj.Report;
        if (!report) continue;

        results.push({
            file: file,
            title: report.Control.Title,
            infoKind: report.Head.InfoKind,
            headline: report.Head.Headline?.Text || 'N/A'
        });
    } catch (e) {
        // Skip large files or errors for now
    }
}

fs.writeFileSync('d:/kishou_server/xml_analysis_results.json', JSON.stringify(results, null, 2));
console.log('Analysis completed. Results saved to xml_analysis_results.json');
