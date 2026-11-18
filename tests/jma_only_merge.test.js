const test = require('node:test');
const assert = require('node:assert/strict');

const { EarthquakeRegistry } = require('../lib/earthquakeRegistry');
const { formatEarthquake } = require('../lib/formatter');

function jmaParsed({ originTime = '2026-11-08T01:04:00+09:00', name = '静岡県西部', maxInt = '4', cityGroups = null, groups = null, lg = null, comment = '', infoKind = '各地の震度に関する情報', eventId = '20261108010400' } = {}) {
  const parsed = {
    status: '通常',
    infoKind,
    infoType: '発表',
    eventId,
    originTimeFormatted: '午前1時4分',
    comment,
    earthquake: {
      originTime,
      hypocenter: { name, description: '深さ 30ｋｍ', coordinate: '' },
      magnitude: '5.0',
    },
    intensity: { maxInt, groups: groups || {}, cityGroups: cityGroups || {} },
  };
  if (lg) parsed.lgIntensity = lg;
  return parsed;
}

function formattedTexts(formatted) {
  return (formatted?.lines || []).map((line) => line.text).join('\n');
}

// 発表経路は JMA フィードのみ (P2P 551 は採用しない)。レジストリは
// JMA 電文同士の続報 (震度速報→震源・震度情報) の突き合わせを担う。

test('同一内容の詳細が再掲されても投稿しない', () => {
  const registry = new EarthquakeRegistry();
  const first = jmaParsed({ maxInt: '4', cityGroups: { '4': ['浜松市'], '3': ['静岡市'] } });
  assert.equal(registry.merge(first).action, 'full');

  const again = jmaParsed({ maxInt: '4', cityGroups: { '4': ['浜松市'], '3': ['静岡市'] } });
  assert.equal(registry.merge(again).action, 'skip');
});

test('詳細の続報は新しい地点と長周期だけが差分になる', () => {
  const registry = new EarthquakeRegistry();
  const first = jmaParsed({ maxInt: '4', cityGroups: { '4': ['浜松市'], '3': ['静岡市'] } });
  assert.equal(registry.merge(first).action, 'full');

  const follow = jmaParsed({
    maxInt: '4',
    cityGroups: { '4': ['浜松市'], '3': ['静岡市'], '2': ['掛川市'] },
    lg: { maxLgInt: '2', groups: { '2': ['静岡県西部'] } },
  });
  const { action, delta } = registry.merge(follow);
  assert.equal(action, 'delta');

  const text = formattedTexts(formatEarthquake(delta));
  assert.match(text, /地震情報（続報）/);
  assert.match(text, /掛川市/);
  assert.match(text, /長周期地震動/);
  assert.doesNotMatch(text, /浜松市/);
  assert.doesNotMatch(text, /静岡市/);
});

test('震度速報のあと同内容の速報が再掲されても投稿しない', () => {
  const registry = new EarthquakeRegistry();
  const prompt = jmaParsed({ maxInt: '4', groups: { '4': ['静岡県西部'] }, infoKind: '震度速報' });
  assert.equal(registry.merge(prompt).action, 'full');

  const again = jmaParsed({ maxInt: '4', groups: { '4': ['静岡県西部'] }, infoKind: '震度速報' });
  assert.equal(registry.merge(again).action, 'skip');
});

test('最大震度が上がった続報は新しい最大震度で差分投稿になる', () => {
  const registry = new EarthquakeRegistry();
  const first = jmaParsed({ maxInt: '4', cityGroups: { '4': ['浜松市'] }, infoKind: '震度速報' });
  assert.equal(registry.merge(first).action, 'full');

  const follow = jmaParsed({
    maxInt: '5-',
    cityGroups: { '5-': ['浜松市', '磐田市'], '4': ['静岡市'] },
  });
  const { action, delta } = registry.merge(follow);
  assert.equal(action, 'delta');
  const formatted = formatEarthquake(delta);
  assert.equal(formatted.type, 'earthquake_5l');
  const text = formattedTexts(formatted);
  assert.match(text, /震度５弱/);
  assert.match(text, /磐田市/);
});

test('発生時刻が違う地震は別イベントとして通常投稿になる', () => {
  const registry = new EarthquakeRegistry();
  assert.equal(registry.merge(jmaParsed({})).action, 'full');
  const other = jmaParsed({ originTime: '2026-11-08T02:30:00+09:00', name: '茨城県沖', eventId: '20261108023000' });
  assert.equal(registry.merge(other).action, 'full');
});

test('震源名なしの震度速報と震源名ありの続報が同じイベントに統合される', () => {
  const registry = new EarthquakeRegistry();
  const prompt = jmaParsed({ name: '', maxInt: '4', cityGroups: { '4': ['浜松市'] }, infoKind: '震度速報' });
  // 震源名が無いパース結果を模す
  prompt.earthquake.hypocenter.name = '';
  assert.equal(registry.merge(prompt).action, 'full');

  const detail = jmaParsed({ maxInt: '4', cityGroups: { '4': ['浜松市'], '3': ['静岡市'] } });
  const { action, delta } = registry.merge(detail);
  assert.equal(action, 'delta');
  assert.match(formattedTexts(formatEarthquake(delta)), /静岡市/);
});
