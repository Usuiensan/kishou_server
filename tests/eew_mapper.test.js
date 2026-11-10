const assert = require('node:assert/strict');
const test = require('node:test');
const { mapP2PQuakeToEEW } = require('../lib/parsers/p2pquake');
const { createAtlasData } = require('../lib/atlasData');

test('EEWの続報識別子にissue.serialを保持する', () => {
  const parsed = mapP2PQuakeToEEW({
    code: 556,
    id: 'message-id',
    earthquake: { time: '2026/07/29 12:00:00', maxScale: 50, hypocenter: { name: 'テスト' } },
    issue: { eventId: 'event-id', serial: '3', time: '2026/07/29 12:00:05' },
    areas: [],
  });
  assert.equal(parsed.eventId, 'event-id');
  assert.equal(parsed.serial, '3');
  assert.equal(parsed.reportId, '3');
});

test('EEWの区域ごとの予想震度・到達予想を eewAreaDetails に保持する', () => {
  const parsed = mapP2PQuakeToEEW({
    code: 556,
    earthquake: { time: '2026/04/01 10:06:25', maxScale: 50, hypocenter: { name: '茨城県南部', reduceName: '茨城県' } },
    issue: { eventId: '20260401100625', serial: '1', time: '2026/04/01 10:06:39' },
    areas: [
      { arrivalTime: '2026/04/01 10:06:39', name: '栃木県南部', pref: '栃木', scaleFrom: 45, scaleTo: 45 },
      { arrivalTime: null, name: '千葉県北西部', pref: '千葉', scaleFrom: 40, scaleTo: 40 },
      { arrivalTime: '2026/04/01 10:06:37', name: '群馬県南部', pref: '群馬', scaleFrom: 40, scaleTo: 46 },
    ],
  });
  assert.deepEqual(parsed.eewAreaDetails, [
      { name: '栃木県南部', pref: '栃木', scaleFrom: 45, scaleTo: 45, arrivalTime: '2026/04/01 10:06:39', kindCode: null },
      { name: '千葉県北西部', pref: '千葉', scaleFrom: 40, scaleTo: 40, arrivalTime: null, kindCode: null },
      { name: '群馬県南部', pref: '群馬', scaleFrom: 40, scaleTo: 46, arrivalTime: '2026/04/01 10:06:37', kindCode: null },
  ]);
});

test('EEW取消では eewAreaDetails は空のまま', () => {
  const parsed = mapP2PQuakeToEEW({
    code: 556,
    cancelled: true,
    earthquake: { time: '2026/04/01 10:06:25', hypocenter: { name: '茨城県南部' } },
    issue: { eventId: '20260401100625', serial: '2', time: '2026/04/01 10:07:00' },
    areas: [
      { arrivalTime: null, name: '栃木県南部', pref: '栃木', scaleFrom: 45, scaleTo: 45 },
    ],
  });
  assert.deepEqual(parsed.eewAreaDetails, []);
});

test('P2P code 556 の区域名・予測・到達時刻をJMA areaIdへ変換する', () => {
  const parsed = mapP2PQuakeToEEW({
    code: 556, earthquake: { time: '2026/04/01 10:06:25' },
    issue: { eventId: '20260401100625', serial: '1', time: '2026/04/01 10:06:39' },
    areas: [{ name: '茨城県北部', pref: '茨城', scaleFrom: 50, scaleTo: 55,
      arrivalTime: '2026/04/01 10:06:37' }],
  });
  const event = createAtlasData('eew', parsed).payload.atlasII;
  assert.equal(event.areas[0].areaId, 300);
  assert.equal(event.areas[0].scalePair, 0x87);
  assert.equal(event.areas[0].areaFlags, 6);
  assert.equal(event.areas[0].arrivalOffsetSeconds, -2);
  assert.equal(event.eventFlags & 2, 2);
});

test('P2Pのprefと区域名が対応表に食い違う入力は拒否する', () => {
  const parsed = mapP2PQuakeToEEW({
    code: 556, earthquake: {}, issue: { eventId: 'bad-map', time: '2026/04/01 10:06:39' },
    areas: [{ name: '茨城県北部', pref: '栃木', scaleFrom: 40, scaleTo: 40 }],
  });
  assert.throws(() => createAtlasData('eew', parsed), /unmapped JMA EEW area/);
});

test('予測値のない警報対象区域も震度不明のAreaRecordとして残す', () => {
  const event = createAtlasData('eew', {
    eventId: 'warning-only', infoType: '発表', isWarning: true,
    reportTime: '2026/04/01 10:06:39', serial: '1', eewForecastAreas: [],
    eewAreaDetails: [{ name: '茨城県北部', pref: '茨城' }],
  }).payload.atlasII;
  assert.equal(event.areas.length, 1);
  assert.equal(event.areas[0].areaId, 300);
  assert.equal(event.areas[0].scalePair, 0);
  assert.equal(event.areas[0].areaFlags & 4, 4);
  assert.equal(event.eventFlags & 4, 0);
});
