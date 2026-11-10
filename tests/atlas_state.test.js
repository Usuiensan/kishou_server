const test = require('node:test');
const assert = require('node:assert/strict');
const { applyAtlasBulletin, createAtlasSnapshot, pruneAtlasSnapshot } = require('../lib/atlasData');

const event = (kind, id = 'eq-1', action = 'upsert', publishedAt = '2026-11-09T10:00:00+09:00', serial = 1) => ({
  version: 1, kind, action, event: { id, publishedAt, serial, infoType: action === 'cancel' ? '取消' : '発表', infoKind: kind }, payload: { marker: `${kind}:${id}:${serial}` },
});

test('4種の情報レイヤーの全同時表示組み合わせを維持する', () => {
  const kinds = ['eew', 'tsunami', 'intensity', 'vertical'];
  for (let mask = 1; mask < 16; mask++) {
    let snapshot = createAtlasSnapshot();
    const included = kinds.filter((_, i) => mask & (1 << i));
    for (const kind of included) snapshot = applyAtlasBulletin(snapshot, event(kind));
    assert.deepEqual(Object.keys(snapshot.layers).filter((kind) => snapshot.layers[kind].length), included);
    assert.equal(snapshot.layers.eew.length, included.includes('eew') ? 1 : 0);
    assert.equal(snapshot.layers.tsunami.length, included.includes('tsunami') ? 1 : 0);
  }
});

test('一部レイヤーの続報と取消は他レイヤーと別イベントを保持する', () => {
  let snapshot = createAtlasSnapshot();
  for (const kind of ['eew', 'tsunami', 'intensity', 'vertical']) snapshot = applyAtlasBulletin(snapshot, event(kind));
  snapshot = applyAtlasBulletin(snapshot, event('eew', 'eq-1', 'upsert', '2026-11-09T10:00:20+09:00', 2));
  snapshot = applyAtlasBulletin(snapshot, event('tsunami', 'eq-2'));
  snapshot = applyAtlasBulletin(snapshot, event('eew', 'eq-1', 'cancel', '2026-11-09T10:00:30+09:00', 2));
  assert.equal(snapshot.layers.eew[0].action, 'cancel');
  assert.equal(snapshot.layers.tsunami.length, 2);
  assert.equal(snapshot.layers.intensity.length, 1);
  assert.equal(snapshot.layers.vertical.length, 1);
});

test('津波解除は対象イベントだけを消しEEWと震度を残す', () => {
  let snapshot = createAtlasSnapshot();
  for (const kind of ['eew', 'tsunami', 'intensity', 'vertical']) snapshot = applyAtlasBulletin(snapshot, event(kind));
  snapshot = applyAtlasBulletin(snapshot, event('tsunami', 'eq-1', 'cancel', '2026-11-09T10:01:00+09:00', 2));
  assert.equal(snapshot.layers.tsunami[0].action, 'cancel');
  assert.equal(snapshot.layers.eew.length, 1);
  assert.equal(snapshot.layers.intensity.length, 1);
  assert.equal(snapshot.layers.vertical.length, 1);
});

test('古い報は上書きせず、期限切れは種別ごとに除外する', () => {
  let snapshot = createAtlasSnapshot();
  snapshot = applyAtlasBulletin(snapshot, event('eew', 'eq-1', 'upsert', '2026-11-09T10:00:20+09:00', 2), 1000);
  snapshot = applyAtlasBulletin(snapshot, event('eew', 'eq-1', 'upsert', '2026-11-09T10:00:10+09:00', 1), 1100);
  assert.equal(snapshot.layers.eew[0].event.serial, 2);
  snapshot = applyAtlasBulletin(snapshot, event('tsunami'), 1000);
  const expired = applyAtlasBulletin(snapshot, event('vertical', 'v-1'), 1000);
  const visible = applyAtlasBulletin(expired, event('intensity', 'i-1'), 70000);
  assert.equal(visible.layers.eew[0].action, 'upsert');
  assert.equal(visible.layers.tsunami.length, 1);
});

test('別地震は新しい順に保持し、古い取消は新しい報を消さない', () => {
  let snapshot = applyAtlasBulletin(createAtlasSnapshot(), event('eew', 'old', 'upsert', '2026-11-09T09:00:00+09:00', 1), 1000);
  snapshot = applyAtlasBulletin(snapshot, event('eew', 'new', 'upsert', '2026-11-09T10:00:00+09:00', 1), 1100);
  snapshot = applyAtlasBulletin(snapshot, event('eew', 'new', 'cancel', '2026-11-09T09:59:00+09:00', 1), 1200);
  assert.deepEqual(snapshot.layers.eew.map((entry) => entry.event.id), ['new', 'old']);
});

test('新しい電文が来なくても各レイヤーの期限切れを独立して除く', () => {
  let snapshot = createAtlasSnapshot();
  snapshot = applyAtlasBulletin(snapshot, event('eew'), 1000);
  snapshot = applyAtlasBulletin(snapshot, event('tsunami'), 1000);
  snapshot = pruneAtlasSnapshot(snapshot, 61_001);
  assert.equal(snapshot.layers.eew.length, 1);
  assert.equal(snapshot.layers.tsunami.length, 1);
  snapshot = pruneAtlasSnapshot(snapshot, 10_801_001);
  assert.equal(snapshot.layers.tsunami.length, 1);
});
