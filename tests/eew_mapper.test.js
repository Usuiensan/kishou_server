const assert = require('node:assert/strict');
const test = require('node:test');
const { mapP2PQuakeToEEW } = require('../lib/parsers/p2pquake');

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
    { name: '栃木県南部', pref: '栃木', scaleFrom: 45, scaleTo: 45, arrivalTime: '2026/04/01 10:06:39' },
    { name: '千葉県北西部', pref: '千葉', scaleFrom: 40, scaleTo: 40, arrivalTime: null },
    { name: '群馬県南部', pref: '群馬', scaleFrom: 40, scaleTo: 46, arrivalTime: '2026/04/01 10:06:37' },
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
