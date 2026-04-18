const fs = require('fs');
const { mapP2PQuakeToEEW } = require('../lib/parsers/p2pquake');
const { formatEarthquake } = require('../lib/formatter');

// EEW サンプルデータの読み込み
const sampleData = JSON.parse(fs.readFileSync('./eew_sample.json', 'utf8'))[0];

console.log('--- EEW 発表時のテスト ---');
const parsedEEW = mapP2PQuakeToEEW(sampleData);
const formattedEEW = formatEarthquake(parsedEEW);

console.log('Formatted EEW:', JSON.stringify(formattedEEW, null, 2));

const eewDuration = formattedEEW.lines[0].duration;
if (eewDuration === 60.0) {
    console.log('✅ EEW 発表時の duration は 60.0 です。');
} else {
    console.error(`❌ EEW 発表時の duration が ${eewDuration} です（期待値: 60.0）。`);
}

console.log('\n--- EEW 取消時のテスト ---');
const cancelData = { ...sampleData, cancelled: true };
const parsedCancel = mapP2PQuakeToEEW(cancelData);
const formattedCancel = formatEarthquake(parsedCancel);

console.log('Formatted Cancel:', JSON.stringify(formattedCancel, null, 2));

const cancelDuration = formattedCancel.lines[0].duration;
if (cancelDuration === 60.0) {
    console.log('✅ EEW 取消時の duration は 60.0 です。');
} else {
    console.error(`❌ EEW 取消時の duration が ${cancelDuration} です（期待値: 60.0）。`);
}
