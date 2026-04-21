const { formatTime } = require('../lib/parsers/tsunami');

// 1. 時刻変換のテスト (UTC -> JST)
console.log('--- 1. 時刻変換テスト (UTC -> JST) ---');
const utcTime = '2026-04-21T07:00:00Z'; // UTC 7:00 -> JST 16:00
const formattedTime = formatTime(utcTime);
console.log(`Input: ${utcTime}`);
console.log(`Output: ${formattedTime}`);
if (formattedTime === '午後4時0分') {
    console.log('✅ JST 変換成功 (午後4時0分)');
} else {
    console.error(`❌ JST 変換失敗: ${formattedTime}`);
}

// 2. 優先順位とキャッシュのテスト
console.log('\n--- 2. 優先順位テスト (EEW > 津波 > 地震) ---');

const cache = { formatted: [] };

function addToCache(formatted) {
  const filtered = cache.formatted.filter(item => item.id !== formatted.id);
  const updatedList = [formatted, ...filtered];
  updatedList.sort((a, b) => {
    const getPriority = (item) => {
      if (item.type === 'eew') return 0;
      if (item.type.startsWith('tsunami')) return 1;
      if (item.type.startsWith('earthquake')) return 2;
      return 3;
    };
    const pA = getPriority(a);
    const pB = getPriority(b);
    if (pA !== pB) return pA - pB;
    return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
  });
  cache.formatted = updatedList.slice(0, 10);
}

const eew = { type: 'eew', id: 'e1', timestamp: new Date('2026-04-21T16:00:00+09:00').toISOString() };
const tsunami = { type: 'tsunami_warning', id: 't1', timestamp: new Date('2026-04-21T16:01:00+09:00').toISOString() };
const eq = { type: 'earthquake_5h', id: 'q1', timestamp: new Date('2026-04-21T16:02:00+09:00').toISOString() };

// 順不同で追加しても優先順位通りになるか
addToCache(eq);
addToCache(tsunami);
addToCache(eew);

console.log('Order:', cache.formatted.map(i => i.type).join(' > '));
if (cache.formatted[0].type === 'eew' && cache.formatted[1].type === 'tsunami_warning' && cache.formatted[2].type === 'earthquake_5h') {
    console.log('✅ 優先順位通りにソートされました (EEW > 津波 > 地震)');
} else {
    console.error('❌ 優先順位が正しくありません');
}

// 3. 有効期限のテスト
console.log('\n--- 3. 有効期限テスト (EEW 60s) ---');

function getLatestData(now) {
    const RETAIN_MS = 3 * 60 * 60 * 1000;
    return cache.formatted.filter((item) => {
      const itemTime = new Date(item.timestamp).getTime();
      if (item.type === 'eew') {
        return now - itemTime < 60000;
      }
      return now - itemTime < RETAIN_MS;
    });
}

const nowNormal = new Date('2026-04-21T16:00:30+09:00').getTime(); // 30秒後
const resultsNormal = getLatestData(nowNormal);
console.log('30秒後の件数:', resultsNormal.length);
if (resultsNormal.some(i => i.type === 'eew')) {
    console.log('✅ 30秒後はEEWが残っています');
} else {
    console.error('❌ 30秒後なのにEEWが消えました');
}

const nowLate = new Date('2026-04-21T16:01:30+09:00').getTime(); // 90秒後
const resultsLate = getLatestData(nowLate);
console.log('90秒後の件数:', resultsLate.length);
if (!resultsLate.some(i => i.type === 'eew')) {
    console.log('✅ 90秒後はEEWが消去されました');
} else {
    console.error('❌ 90秒後なのにEEWが残っています');
}
