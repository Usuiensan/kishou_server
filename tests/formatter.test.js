const assert = require('node:assert/strict');
const test = require('node:test');
const { filterFormattedEarthquakeByIntensity } = require('../lib/formatter');

const earthquake = {
  type: 'earthquake_4',
  lines: [
    { text: '<align="center">地震情報', duration: 3.5 },
    { text: '震源は test', duration: 7.5 },
    { text: '<u>震度4</u> <indent=5em><nobr>地域4</nobr></indent>', duration: 7.5 },
    { text: '<u>震度3</u> <indent=5em><nobr>地域3</nobr></indent>', duration: 7.5 },
    { text: '<u>震度1</u> <indent=5em><nobr>地域1</nobr></indent>', duration: 7.5 },
  ],
};

test('表示震度4以上では震度1〜3の地域行を除外する', () => {
  const result = filterFormattedEarthquakeByIntensity(earthquake, 4);
  assert.deepEqual(result.lines.map((line) => line.text), [
    '<align="center">地震情報',
    '震源は test',
    '<u>震度4</u> <indent=5em><nobr>地域4</nobr></indent>',
  ]);
});

test('表示震度1以上と未設定は全震度行を保持する', () => {
  assert.equal(filterFormattedEarthquakeByIntensity(earthquake, 1).lines.length, earthquake.lines.length);
  assert.equal(filterFormattedEarthquakeByIntensity(earthquake, null).lines.length, earthquake.lines.length);
});

test('EEWやNERVの本文は表示震度フィルタを適用しない', () => {
  const formatted = { type: 'eew', lines: [{ text: '<u>震度1</u> EEW', duration: 1 }] };
  assert.deepEqual(filterFormattedEarthquakeByIntensity(formatted, 4), formatted);
});
