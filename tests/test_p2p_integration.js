const { mapP2PQuakeToEEW } = require('../lib/parsers/p2pquake');
const { formatEarthquake } = require('../lib/formatter');

// モックデータ: EEW (556)
const mockEEW = {
  id: "60573c8a-ea8d-465c-a7c6-deda552e0ddb",
  code: 556,
  time: "2024/04/17 23:14:58",
  issue: {
    time: "2024/04/17 23:14:58",
    eventId: "20240417231454",
    serial: "1"
  },
  earthquake: {
    hypocenter: {
      name: "豊後水道",
      depth: 50,
      magnitude: 6.6
    }
  },
  areas: [
    { pref: "愛媛県", name: "愛媛県南予" },
    { pref: "高知県", name: "高知県西部" }
  ]
};

console.log("--- EEW Mapping Test ---");
const parsedEEW = mapP2PQuakeToEEW(mockEEW);
console.log("Parsed eventId:", parsedEEW.eventId);
console.log("Headline:", parsedEEW.headline);
console.log("Areas:", parsedEEW.eewAreas);

const formattedEEW = formatEarthquake(parsedEEW);
console.log("Formatted text snippet:", formattedEEW.lines[0].text.substring(0, 100));

// 地震情報 (551) は P2P から採用しない (JMA フィード経路に一本化)。
// このスクリプトは EEW (556) マッパの確認専用。
