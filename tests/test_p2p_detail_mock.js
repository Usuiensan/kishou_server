const { mapP2PQuakeToEarthquake } = require('../lib/parsers/p2pquake');
const { formatEarthquake } = require('../lib/formatter');

// 震源情報が含まれる詳細な地震情報 (551) の擬似データ
const mockFullQuake = {
  code: 551,
  id: "mock-id-123",
  time: "2024/04/17 23:20:00",
  issue: {
    source: "気象庁",
    time: "2024/04/17 23:19:00",
    type: "ScaleAndDestination", // 震源・震度に関する情報
    correct: "None"
  },
  earthquake: {
    time: "2024/04/17 23:14:00",
    hypocenter: {
      name: "豊後水道",
      latitude: 33.2,
      longitude: 132.4,
      depth: 50,
      magnitude: 6.6
    },
    maxScale: 60,
    domesticTsunami: "None"
  },
  points: [
    { pref: "愛媛県", addr: "愛媛県南予", scale: 60 },
    { pref: "高知県", addr: "高知県西部", scale: 55 }
  ]
};

console.log("--- 🧪 震源情報ありの擬似データテスト ---");
const parsed = mapP2PQuakeToEarthquake(mockFullQuake);
const formatted = formatEarthquake(parsed);

console.log("--- 📤 出力結果 (JSON) ---");
console.log(JSON.stringify(formatted, null, 2));

console.log("\n--- 📺 表示テキストの確認 ---");
formatted.lines.forEach((line, index) => {
    console.log(`Line ${index + 1}: ${line.text.replace(/\n/g, ' [改行] ')}`);
});
