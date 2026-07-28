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
