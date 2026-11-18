const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { EarthquakeRegistry, eventKeyOf } = require('../lib/earthquakeRegistry');
const { parseEarthquake } = require('../lib/parsers/earthquake');

function sample(name) {
  return parseEarthquake(fs.readFileSync(path.join(__dirname, 'samples', name), 'utf8'));
}

test('異なる eventId の VXSE51 は地点を混ぜずにそれぞれ full になる', () => {
  const registry = new EarthquakeRegistry();
  const first = sample('32-35_01_01_100806_VXSE51.xml');
  const second = sample('32-35_04_01_100831_VXSE51.xml');

  assert.equal(registry.merge(first).action, 'full');
  assert.equal(registry.merge(second).action, 'full');
  assert.equal(registry.events.size, 2);
  assert.equal(registry.events.get(registry.keyFor(first)).points.has('静岡県中部'), true);
  assert.equal(registry.events.get(registry.keyFor(second)).points.has('静岡県中部'), false);
});

test('同一 eventId の VXSE51 から VXSE53 は新規地点を含む delta になる', () => {
  const registry = new EarthquakeRegistry();
  const first = sample('32-35_04_02_100831_VXSE51.xml');
  const follow = sample('32-35_04_04_240613_VXSE53.xml');

  assert.equal(first.eventId, follow.eventId);
  assert.equal(registry.merge(first).action, 'full');
  const result = registry.merge(follow);
  assert.equal(result.action, 'delta');
  assert.equal(result.delta.intensity.groups['1'].includes('鹿児島十島村'), true);
});

test('同一 VXSE51 の再投入は skip になる', () => {
  const registry = new EarthquakeRegistry();
  const first = sample('32-35_04_02_100831_VXSE51.xml');

  assert.equal(registry.merge(first).action, 'full');
  assert.equal(registry.merge(sample('32-35_04_02_100831_VXSE51.xml')).action, 'skip');
});

test('keyFor は eventId を優先し、なければ時刻と震源名を使う', () => {
  assert.equal(eventKeyOf({ eventId: 'event-1', originTime: '2026-11-08T01:04:00+09:00' }), 'event-1');
  assert.equal(eventKeyOf({ originTime: '2026-11-08T01:04:00+09:00', earthquake: { hypocenter: { name: '静岡県西部' } } }), '2026-11-08 01:04|静岡県西部');
});

test('targetDateTime の震度速報と earthquake.originTime の続報を同じエントリに結び付ける', () => {
  const registry = new EarthquakeRegistry();
  const prompt = {
    targetDateTime: '2026-11-08T01:04:00+09:00',
    intensity: { maxInt: '4', groups: { '4': ['静岡県西部'] } },
  };
  const detail = {
    targetDateTime: '2026-11-08T01:05:00+09:00',
    earthquake: { originTime: '2026-11-08T01:04:00+09:00', hypocenter: { name: '静岡県西部' } },
    intensity: { maxInt: '4', groups: { '4': ['静岡県西部'], '3': ['静岡市'] } },
  };

  assert.equal(registry.merge(prompt).action, 'full');
  const result = registry.merge(detail);
  assert.equal(result.action, 'delta');
  assert.deepEqual(result.delta.intensity.groups, { '3': ['静岡市'] });
});
