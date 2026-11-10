const test = require('node:test');
const assert = require('node:assert/strict');
const { staleSources } = require('../telop/atlas-live');

test('JMA/P2Pの接続失敗・2分超過を別々に未更新として判定する', () => {
  const now = Date.parse('2026-11-10T00:02:01Z');
  const health = {
    jma: { ok: true, at: '2026-11-10T00:00:00Z' },
    p2p: { ok: false, at: '2026-11-10T00:02:00Z' },
  };
  assert.deepEqual(staleSources(health, now), ['jma', 'p2p']);
  health.jma.at = '2026-11-10T00:01:00Z';
  health.p2p.ok = true;
  assert.deepEqual(staleSources(health, now), []);
});

test('初期状態は両入力源を未更新として示す', () => {
  assert.deepEqual(staleSources({ jma: null, p2p: null }, 0), ['jma', 'p2p']);
});
