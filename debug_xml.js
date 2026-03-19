const { XMLParser } = require('fast-xml-parser');
const fs = require('fs');

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' });

const xml = fs.readFileSync('xml_example/15_08_01_130412_VPWW53.xml', 'utf-8');
const obj = parser.parse(xml);
const infos = Array.isArray(obj.Report.Head.Headline.Information) 
    ? obj.Report.Head.Headline.Information 
    : [obj.Report.Head.Headline.Information];

infos.forEach((info, i) => {
    console.log(`Info[${i}] type:`, info.type);
});
