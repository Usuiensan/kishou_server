const fs = require('fs');
const path = require('path');
const { parseEarthquake } = require('../lib/parsers/earthquake');

// 深夜のサンプル（OriginTimeを無理やり深夜0時に書き換えてテスト）
const samplePath = path.join(__dirname, 'samples/xml_example/jmaxml_20260312_Samples/33_12_01_240613_VXSE52.xml');

try {
    let xml = fs.readFileSync(samplePath, 'utf-8');
    // OriginTime を深夜0時に置換
    xml = xml.replace(/<OriginTime>.*?<\/OriginTime>/, '<OriginTime>2024-04-18T00:00:00+09:00</OriginTime>');
    
    const parsed = parseEarthquake(xml);
    console.log('Midnight Time:', parsed.originTimeFormatted);

    // 正午のサンプル
    xml = xml.replace(/<OriginTime>.*?<\/OriginTime>/, '<OriginTime>2024-04-18T12:00:00+09:00</OriginTime>');
    const parsedNoon = parseEarthquake(xml);
    console.log('Noon Time:', parsedNoon.originTimeFormatted);

} catch (e) {
    console.error('Test Error:', e);
}
