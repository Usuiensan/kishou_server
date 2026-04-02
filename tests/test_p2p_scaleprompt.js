const { mapP2PQuakeToEarthquake } = require('../lib/parsers/p2pquake');
const { formatEarthquake } = require('../lib/formatter');

// 震度速報 (ScalePrompt) の擬似データ
const mockScalePrompt = {
  code: 551,
  time: "2024/04/17 23:15:00",
  issue: {
    source: "気象庁",
    time: "2024/04/17 23:15:00",
    type: "ScalePrompt",
    correct: "None"
  },
  earthquake: {
    time: "2024/04/17 23:14:00",
    maxScale: 30, // 震度3
    domesticTsunami: "None"
  },
  points: [
    { pref: "愛媛県", addr: "愛媛県南予", scale: 30 }
  ]
};

console.log("--- 🧪 震度速報 (ScalePrompt) 擬似データテスト ---");
const parsed = mapP2PQuakeToEarthquake(mockScalePrompt);
console.log("Parsed infoKind:", parsed.infoKind);

const formatted = formatEarthquake(parsed);

console.log("\n--- 📺 表示テキストの確認 ---");
formatted.lines.forEach((line, index) => {
    console.log(`Line ${index + 1}: ${line.text.replace(/\n/g, ' [改行] ')}`);
});
