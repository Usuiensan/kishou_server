const { mapP2PQuakeToEEW } = require('../lib/parsers/p2pquake');
const { formatEarthquake } = require('../lib/formatter');

// 2026/04/01 茨城県南部 M5.1 の実データ (P2P API v2 556)
const mockData = {
    "areas": [
        { "arrivalTime": "2026/04/01 10:06:39", "kindCode": "19", "name": "栃木県南部", "pref": "栃木", "scaleFrom": 45, "scaleTo": 45 },
        { "arrivalTime": "2026/04/01 10:06:39", "kindCode": "19", "name": "茨城県北部", "pref": "茨城", "scaleFrom": 45, "scaleTo": 45 },
        { "arrivalTime": "2026/04/01 10:06:39", "kindCode": "19", "name": "茨城県南部", "pref": "茨城", "scaleFrom": 45, "scaleTo": 45 },
        { "arrivalTime": null, "kindCode": "11", "name": "千葉県北西部", "pref": "千葉", "scaleFrom": 40, "scaleTo": 40 },
        { "arrivalTime": null, "kindCode": "11", "name": "埼玉県南部", "pref": "埼玉", "scaleFrom": 40, "scaleTo": 40 },
        { "arrivalTime": null, "kindCode": "11", "name": "埼玉県北部", "pref": "埼玉", "scaleFrom": 40, "scaleTo": 40 },
        { "arrivalTime": "2026/04/01 10:06:37", "kindCode": "19", "name": "群馬県南部", "pref": "群馬", "scaleFrom": 40, "scaleTo": 40 }
    ],
    "cancelled": false,
    "code": 556,
    "earthquake": {
        "arrivalTime": "2026/04/01 10:06:25",
        "condition": "",
        "hypocenter": {
            "depth": 50,
            "latitude": 36.1,
            "longitude": 140,
            "magnitude": 5.1,
            "name": "茨城県南部",
            "reduceName": "茨城県"
        },
        "originTime": "2026/04/01 10:06:18"
    },
    "issue": {
        "eventId": "20260401100625",
        "serial": "1",
        "time": "2026/04/01 10:06:39"
    },
    "time": "2026/04/01 10:06:40.11"
};

console.log('🧪 P2P地震情報 緊急地震速報 (556) モックテスト開始');
console.log('--------------------------------------------------');

try {
    console.log('\n--- 📥 Mock Data Input ---');
    console.log(JSON.stringify(mockData, null, 2));

    const parsed = mapP2PQuakeToEEW(mockData);
    
    if (parsed) {
        console.log('\n--- 🔍 Parsed Result ---');
        console.log(JSON.stringify(parsed, null, 2));

        const formatted = formatEarthquake(parsed);
        
        if (formatted) {
            console.log('\n--- 📤 Formatted Output (JSON) ---');
            console.log(JSON.stringify(formatted, null, 2));

            console.log('\n--- 📺 Display Text (Simulated) ---');
            formatted.lines.forEach((line, index) => {
                console.log(`[Line ${index + 1}]`);
                console.log(line.text);
            });
            console.log('\n✅ テスト成功');
        } else {
            console.log('\n⚠️ Formatted Output is null (Filtered?)');
        }
    } else {
        console.log('\n❌ Parsed Result is null');
    }
} catch (err) {
    console.error('\n💥 エラー発生:', err);
}
