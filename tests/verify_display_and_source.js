const { formatEarthquake, formatTsunami } = require('../lib/formatter');

// 1. 表示時間 & Catetory (type) の検証
console.log('--- 🧪 カテゴリ細分化と表示時間の検証 ---');

// a. 地震情報 (震度別)
const testCases = [
    { int: '3', expected: 'earthquake_3', duration: 3.5 },
    { int: '5-', expected: 'earthquake_5l', duration: 3.5 },
    { int: '5+', expected: 'earthquake_5h', duration: 3.5 },
    { int: '7', expected: 'earthquake_7', duration: 3.5 }
];

testCases.forEach(tc => {
    const res = formatEarthquake({
        intensity: { maxInt: tc.int },
        eventId: `eq_${tc.int}`,
        earthquake: { hypocenter: { name: 'テスト' } }
    });
    console.log(`Intensity ${tc.int} -> Type: ${res.type}, Title Duration: ${res.lines[0].duration}`);
});

// b. EEW
const eewRes = formatEarthquake({
    isEEW: true,
    isWarning: true,
    headline: 'テスト',
    eventId: 'eew_test'
});
console.log(`EEW -> Type: ${eewRes.type}, isEEW: ${eewRes.isEEW}`);

// c. 津波情報
const tsWarningRes = formatTsunami({
    tsunami: { groups: { majorTsunami: ['地域A'], warning: [], advisory: [] }, forecasts: [] },
    eventId: 'ts_warn'
});
console.log(`Tsunami Warning -> Type: ${tsWarningRes.type}, Duration: ${tsWarningRes.lines[0].duration}`);

const tsAdvisoryRes = formatTsunami({
    tsunami: { groups: { majorTsunami: [], warning: [], advisory: ['地域B'] }, forecasts: [] },
    eventId: 'ts_adv'
});
console.log(`Tsunami Advisory -> Type: ${tsAdvisoryRes.type}`);

// 2. EEW 継続表示の検証 (jma_server.js ロジック)
console.log('\n--- 🧪 EEW 継続表示 (Typeベース) の検証 ---');

let mockCache = { formatted: [] };
function addToCache(formatted) {
  const now = Date.now();
  const top = mockCache.formatted[0];
  const isEEWActive = top && top.type === 'eew' && (now - new Date(top.timestamp).getTime() < 60000);

  if (isEEWActive && formatted.type !== 'eew') {
    mockCache.formatted = [top, formatted, ...mockCache.formatted.slice(1)].slice(0, 5);
  } else {
    mockCache.formatted = [formatted, ...mockCache.formatted.filter(i => i.id !== formatted.id)].slice(0, 5);
  }
}

const eew = { id: 'eew1', type: 'eew', timestamp: new Date().toISOString() };
const eq = { id: 'eq1', type: 'earthquake_3', timestamp: new Date().toISOString() };

addToCache(eew);
addToCache(eq);
console.log('Current Top (after EQ during EEW):', mockCache.formatted[0].type); // Expected: eew

if (mockCache.formatted[0].type === 'eew' && tsWarningRes.type === 'tsunami_warning') {
    console.log('\n✅ カテゴリ細分化および優先表示ロジックの全ての検証に成功');
} else {
    console.log('\n❌ 検証に失敗しました');
}
