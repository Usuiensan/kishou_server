const assert = require('node:assert/strict');
const test = require('node:test');
const { formatEarthquake, formatTsunami } = require('../lib/formatter');

function earthquakeWithIntensity(maxInt, groups) {
  return {
    eventId: `test-${maxInt}`,
    originTimeFormatted: '午後7時45分',
    intensity: { maxInt, groups, cityGroups: groups },
    earthquake: { hypocenter: { name: 'テスト震源' }, magnitude: '4.2' },
  };
}

test('最大震度1〜3は通知しない', () => {
  for (const intensity of ['1', '2', '3']) {
    assert.equal(formatEarthquake(earthquakeWithIntensity(intensity, { [intensity]: ['東京'] })), null);
  }
});

test('最大震度4以上では震度1〜3の地域を除外する', () => {
  const result = formatEarthquake(earthquakeWithIntensity('4', {
    '4': ['東京'],
    '3': ['埼玉'],
    '2': ['千葉'],
  }));
  const text = result.lines.map((line) => line.text).join('\n');
  assert.match(text, /東京/);
  assert.doesNotMatch(text, /埼玉|千葉/);
});

test('震度情報なしのM4.9は通知しない', () => {
  assert.equal(formatEarthquake({
    eventId: 'm49',
    earthquake: { hypocenter: { name: 'テスト震源' }, magnitude: '4.9' },
  }), null);
});

test('震度情報なしのM5.0は通知する', () => {
  assert.notEqual(formatEarthquake({
    eventId: 'm50',
    earthquake: { hypocenter: { name: 'テスト震源' }, magnitude: '5.0' },
  }), null);
});

test('震度4があればM5未満でも通知する', () => {
  assert.notEqual(formatEarthquake(earthquakeWithIntensity('4', { '4': ['東京'] })), null);
});
