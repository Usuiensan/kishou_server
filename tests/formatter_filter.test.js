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

test('最大震度4以上では震度1以上の地域をすべて表示する', () => {
  const result = formatEarthquake(earthquakeWithIntensity('4', {
    '4': ['東京'],
    '3': ['埼玉'],
    '2': ['千葉'],
  }));
  const text = result.lines.map((line) => line.text).join('\n');
  assert.match(text, /東京/);
  assert.match(text, /埼玉/);
  assert.match(text, /千葉/);
});

test('震度情報なしのM4.9は通知しない', () => {
  assert.equal(formatEarthquake({
    eventId: 'm49',
    earthquake: { hypocenter: { name: 'テスト震源' }, magnitude: '4.9' },
  }), null);
});

test('不要な津波・長周期地震動の説明文を表示しない', () => {
  const result = formatEarthquake({
    eventId: 'cleanup',
    originTimeFormatted: '午後7時45分',
    title: '地震情報',
    comment: '津波警報等（大津波警報・津波警報あるいは津波注意報）を発表中です。\n各長周期地震動階級に対する簡易な現象表現\n 階級１やや大きな揺れ\n波形、スペクトル等、本地震の長周期地震動に関する詳細な情報は気象庁の長周期地震動に関する観測情報のウェブサイト　(　https://example.test　) もあわせてご活用ください。',
    earthquake: { hypocenter: { name: 'テスト震源' }, magnitude: '6.0' },
    intensity: { maxInt: '4', groups: { '4': ['東京'] } },
  });
  const text = result.lines.map((line) => line.text).join('\n');
  assert.doesNotMatch(text, /大津波警報・津波警報あるいは津波注意報/);
  assert.doesNotMatch(text, /各長周期地震動階級|波形、スペクトル/);
  assert.match(text, /津波警報等が発表されています/);
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
