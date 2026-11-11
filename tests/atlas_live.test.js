const test = require('node:test');
const assert = require('node:assert/strict');
const { staleSources, syncTsunamiBlinkClock } = require('../telop/atlas-live');

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

test('津波マップ全系統がPCのUnix時計に同期し描画遅延を累積しない', () => {
  const fake = (name = 'tmblink') => ({
    animationName: name,
    effect: { getTiming: () => ({ duration: 3000 }) },
    pauseCalls: 0,
    currentTime: -1,
    pause() { this.pauseCalls++; },
  });
  const main = fake(), left = fake(), alphaMirror = fake(), unrelated = fake('eewblink');
  let animations = [main, left, alphaMirror, unrelated];
  const previousDocument = global.document;
  global.document = { getAnimations: () => animations };
  try {
    // Midway into the OFF portion (75%-100%): every copy must match.
    assert.equal(syncTsunamiBlinkClock(1_800_000_002_260), 3);
    for (const animation of [main, left, alphaMirror]) {
      assert.equal(animation.currentTime, 2260);
      assert.equal(animation.pauseCalls, 1);
    }
    assert.equal(unrelated.currentTime, -1);
    assert.equal(unrelated.pauseCalls, 0);

    // Dropping hundreds of captures still jumps to wall-clock phase.
    assert.equal(syncTsunamiBlinkClock(1_800_000_128_010), 3);
    for (const animation of [main, left, alphaMirror]) assert.equal(animation.currentTime, 2010);

    // Re-rendered SVG paths create fresh animation objects; do not restart
    // their 3s clock at zero, and do not depend on a previous frame.
    const replacedMap = fake(), replacedMask = fake();
    animations = [replacedMap, replacedMask, unrelated];
    assert.equal(syncTsunamiBlinkClock(1_800_000_129_900), 2);
    assert.equal(replacedMap.currentTime, 900);
    assert.equal(replacedMask.currentTime, 900);
    assert.equal(unrelated.pauseCalls, 0);
  } finally {
    if (previousDocument === undefined) delete global.document;
    else global.document = previousDocument;
  }
});
