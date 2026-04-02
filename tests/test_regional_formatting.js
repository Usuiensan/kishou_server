const { getFormattedMaxIntensityRegion } = require('../lib/utils/regions');
const { formatEarthquake } = require('../lib/formatter');

console.log("--- 🧪 地方名表示テスト ---");

// テスト1: 関東地方
const areas1 = ["神奈川", "東京"];
console.log(`Areas: ${areas1} -> Region: ${getFormattedMaxIntensityRegion(areas1)}`);

// テスト2: 関東・東北地方
const areas2 = ["宮城", "福島", "茨城"];
console.log(`Areas: ${areas2} -> Region: ${getFormattedMaxIntensityRegion(areas2)}`);

// テスト3: 奄美地方
const areas3 = ["奄美地方"];
console.log(`Areas: ${areas3} -> Region: ${getFormattedMaxIntensityRegion(areas3)}`);

// テスト4: フルデータでのフォーマット検証
const mockQuake = {
    originTimeFormatted: "午後7時45分",
    intensity: {
        maxInt: "4",
        groups: {
            "4": ["石川", "富山"]
        }
    }
};

const formatted = formatEarthquake(mockQuake);
console.log("\n--- 📤 フォーマット結果 (北陸地方) ---");
console.log(formatted.lines[1].text);

// テスト5: 複数混在
const mockQuakeMixed = {
    originTimeFormatted: "午前10時20分",
    intensity: {
        maxInt: "3",
        groups: {
            "3": ["愛知", "岐阜", "静岡", "長野"]
        }
    }
};

const formattedMixed = formatEarthquake(mockQuakeMixed);
console.log("\n--- 📤 フォーマット結果 (東海・甲信越地方) ---");
console.log(formattedMixed.lines[1].text);
