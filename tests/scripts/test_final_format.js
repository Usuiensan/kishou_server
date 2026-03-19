const fs = require('fs');
const path = require('path');
const { parseEarthquake } = require('./lib/parsers/earthquake');
const { parseTsunami } = require('./lib/parsers/tsunami');
const { formatEarthquake, formatTsunami } = require('./lib/formatter');

const samples = [
  {
    type: 'earthquake',
    file: 'jmaxml_20260312_Samples/38-39_Tsunami/32-39_11_01_120615_VXSE51.xml',
    desc: '震度速報 (VXSE51)',
  },
  {
    type: 'earthquake',
    file: 'jmaxml_20260312_Samples/33_12_01_240613_VXSE52.xml',
    desc: '震源に関する情報 (VXSE52)',
  },
  {
    type: 'earthquake',
    file: 'jmaxml_20260312_Samples/38-39_Tsunami/32-39_11_05_240613_VXSE53.xml',
    desc: '震源に関する情報 (VXSE53)',
  },
  {
    type: 'tsunami',
    file: 'jmaxml_20260312_Samples/38-39_Tsunami/32-39_11_02_250206_VTSE41.xml',
    desc: '大津波警報・津波警報・津波注意報 (VTSE41)',
  },
];

function runFinalTest() {
  console.log('✨ 最終出力形式（VRChat用JSON）の生成例を表示します...\n');

  samples.forEach((sample) => {
    const filePath = path.join(__dirname, sample.file);
    if (!fs.existsSync(filePath)) return;

    const xml = fs.readFileSync(filePath, 'utf-8');
    let formatted;

    if (sample.type === 'earthquake') {
      const parsed = parseEarthquake(xml);
      formatted = formatEarthquake(parsed);
    } else {
      const parsed = parseTsunami(xml);
      formatted = formatTsunami(parsed);
    }

    formatted.timestamp = new Date().toISOString();

    console.log(`--- ${sample.desc} ---`);
    console.log(JSON.stringify(formatted, null, 2));
    console.log('\n');
  });
}

runFinalTest();
