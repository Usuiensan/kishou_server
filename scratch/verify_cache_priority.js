const cache = { formatted: [] };

function addToCache(formatted) {
  const now = Date.now();
  const top = cache.formatted[0];
  
  const isEEWActive = top && top.type === 'eew' && (now - new Date(top.timestamp).getTime() < 60000);

  if (isEEWActive) {
    if (formatted.type === 'eew' || formatted.type.startsWith('earthquake')) {
      cache.formatted = [formatted, ...cache.formatted.filter(item => item.id !== formatted.id)].slice(0, 10);
      console.log(`🚀 ${formatted.type === 'eew' ? '緊急地震速報の更新' : '震度情報の到着'}（TOP更新）`);
    } else {
      cache.formatted = [top, formatted, ...cache.formatted.slice(1)].slice(0, 10);
      console.log(`📝 緊急地震速報の継続表示中のため、新着データを 2 番目に挿入しました (${formatted.type})`);
    }
  } else {
    const filtered = cache.formatted.filter(item => item.id !== formatted.id);
    cache.formatted = [formatted, ...filtered].slice(0, 10);
    console.log(`📝 キャッシュを更新しました (Type: ${formatted.type})`);
  }
}

// テスト開始
console.log('--- シナリオ1: EEW -> 震度情報の順で到着 ---');
const eew = { type: 'eew', id: 'event1', timestamp: new Date().toISOString(), text: 'EEW Alert' };
addToCache(eew);
console.log('Top:', cache.formatted[0].type); // Expected: eew

const earthquake = { type: 'earthquake_3', id: 'event1', timestamp: new Date().toISOString(), text: 'Intensity 3' };
addToCache(earthquake);
console.log('Top:', cache.formatted[0].type); // Expected: earthquake_3 (EEW replaced or pushed down, if ID is same it replaces)
if (cache.formatted[0].type === 'earthquake_3') {
  console.log('✅ 震度情報がトップになりました');
} else {
  console.error('❌ 震度情報がトップになりませんでした');
}

console.log('\n--- シナリオ2: EEW -> 津波情報の順で到着 ---');
cache.formatted = [];
addToCache(eew);
const tsunami = { type: 'tsunami_warning', id: 'event2', timestamp: new Date().toISOString(), text: 'Tsunami Warning' };
addToCache(tsunami);
console.log('Top:', cache.formatted[0].type); // Expected: eew
console.log('2nd:', cache.formatted[1].type); // Expected: tsunami_warning
if (cache.formatted[0].type === 'eew' && cache.formatted[1].type === 'tsunami_warning') {
  console.log('✅ 津波情報は2番目に保持されました（EEW優先）');
} else {
  console.error('❌ 順序が正しくありません');
}

console.log('\n--- シナリオ3: 異なるイベントの震度情報 ---');
cache.formatted = [];
addToCache(eew);
const otherEq = { type: 'earthquake_4', id: 'event3', timestamp: new Date().toISOString(), text: 'Other Intensity 4' };
addToCache(otherEq);
console.log('Top:', cache.formatted[0].type); // Expected: earthquake_4
console.log('2nd:', cache.formatted[1].type); // Expected: eew
if (cache.formatted[0].type === 'earthquake_4' && cache.formatted[1].type === 'eew') {
  console.log('✅ 異なる震度情報もトップに表示されました');
} else {
  console.error('❌ 順序が正しくありません');
}
