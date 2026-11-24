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
  assert.equal(snapshot.notices[0].payload.notice, '津波警報・注意報は解除されました');
  assert.equal(snapshot.layers.eew.length, 1);
  assert.equal(snapshot.layers.intensity.length, 1);
  assert.equal(snapshot.layers.vertical.length, 1);
});

test('津波解除の帯通知は15秒で消え、新しい発表で同イベントの通知を消す', () => {
  const issued = applyAtlasBulletin(createAtlasSnapshot(), event('tsunami'), 1000);
  const canceled = applyAtlasBulletin(issued, { ...event('tsunami', 'eq-1', 'cancel'), payload: { notice: '津波警報・注意報は解除されました' } }, 2000);
  assert.equal(canceled.notices.length, 1);
  assert.equal(pruneAtlasSnapshot(canceled, 16_999).notices.length, 1);
  assert.equal(pruneAtlasSnapshot(canceled, 17_000).notices.length, 0);
  const reissued = applyAtlasBulletin(canceled, event('tsunami', 'eq-1', 'upsert', '2026-11-09T10:02:00+09:00', 3), 3000);
  assert.equal(reissued.notices.length, 0);
});

test('古い報は上書きせず、期限切れは種別ごとに除外する', () => {
  let snapshot = createAtlasSnapshot();
  snapshot = applyAtlasBulletin(snapshot, event('eew', 'eq-1', 'upsert', '2026-11-09T10:00:20+09:00', 2), 1000);
  snapshot = applyAtlasBulletin(snapshot, event('eew', 'eq-1', 'upsert', '2026-11-09T10:00:10+09:00', 1), 1100);
  assert.equal(snapshot.layers.eew[0].event.serial, 2);
  snapshot = applyAtlasBulletin(snapshot, event('tsunami'), 1000);
  const expired = applyAtlasBulletin(snapshot, event('vertical', 'v-1'), 1000);
  const visible = applyAtlasBulletin(expired, event('intensity', 'i-1'), 70000);
  assert.equal(visible.layers.eew.length, 0);
  assert.equal(visible.layers.tsunami.length, 1);
});

test('EEWは受信から30秒を超えるとpruneされる', () => {
  const snapshot = applyAtlasBulletin(createAtlasSnapshot(), event('eew'), 1000);
  assert.equal(pruneAtlasSnapshot(snapshot, 31_000).layers.eew.length, 0);
  assert.equal(pruneAtlasSnapshot(snapshot, 30_999).layers.eew.length, 1);
});

const { buildEewAudioPlaylist, playlistDurationMs } = require('../lib/eewAudio');
const EEW_DURATIONS = require('../lib/eewAudioDurations');

const warningEew = (serial = 1, publishedAt = '2026-11-09T10:00:00+09:00') => ({
  version: 1, kind: 'eew', action: 'upsert',
  event: { id: 'eq-warn', publishedAt, serial, infoType: '発表', infoKind: 'eew' },
  payload: { render: { hypocenterName: '石川県能登地方', areas: ['石川県能登'], isWarning: true } },
});

const expectedRetention = (isUpdate) => playlistDurationMs(
  buildEewAudioPlaylist({ hypocenterName: '石川県能登地方', areas: ['石川県能登'], isCancel: false },
    { isUpdate, repeatCount: 2, basePath: '' }),
  EEW_DURATIONS,
) + 10_000;

test('警報級EEWはアナウンス終了+10秒まで保持され、その時刻でpruneされる', () => {
  const snapshot = applyAtlasBulletin(createAtlasSnapshot(), warningEew(), 1000);
  const retention = expectedRetention(false);
  assert.ok(retention > 30_000, `長いアナウンスは従来30秒より長く保持される (${retention}ms)`);
  assert.equal(snapshot.layers.eew[0].retentionMs, retention);
  assert.equal(pruneAtlasSnapshot(snapshot, 1000 + retention - 1).layers.eew.length, 1);
  assert.equal(pruneAtlasSnapshot(snapshot, 1000 + retention).layers.eew.length, 0);
});

test('警報級EEWの続報は続報アナウンス（alert_update始まり）の総尺+10秒で保持される', () => {
  let snapshot = applyAtlasBulletin(createAtlasSnapshot(), warningEew(1), 1000);
  snapshot = applyAtlasBulletin(snapshot, warningEew(2, '2026-11-09T10:00:20+09:00'), 2000);
  const retention = expectedRetention(true);
  assert.equal(snapshot.layers.eew[0].retentionMs, retention);
  assert.equal(pruneAtlasSnapshot(snapshot, 2000 + retention - 1).layers.eew.length, 1);
  assert.equal(pruneAtlasSnapshot(snapshot, 2000 + retention).layers.eew.length, 0);
});

test('予報級EEW（音声なし）は従来どおり30秒でpruneされる', () => {
  const forecast = warningEew();
  forecast.payload.render.isWarning = false;
  const snapshot = applyAtlasBulletin(createAtlasSnapshot(), forecast, 1000);
  assert.equal(snapshot.layers.eew[0].retentionMs, 30_000);
  assert.equal(pruneAtlasSnapshot(snapshot, 30_999).layers.eew.length, 1);
  assert.equal(pruneAtlasSnapshot(snapshot, 31_000).layers.eew.length, 0);
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
  assert.equal(snapshot.layers.eew.length, 0);
  assert.equal(snapshot.layers.tsunami.length, 1);
  snapshot = pruneAtlasSnapshot(snapshot, 10_801_001);
  assert.equal(snapshot.layers.tsunami.length, 1);
});

test('A2レイアウトと入力鮮度は状態更新・期限処理でも保持する', () => {
  let snapshot = { ...createAtlasSnapshot(), atlasIIConfig: { activeLayout: 'reverseL' },
    sourceHealth: { jma: { ok: true }, p2p: null } };
  snapshot = applyAtlasBulletin(snapshot, event('tsunami'), 1000);
  snapshot = pruneAtlasSnapshot(snapshot, 10_801_001);
  assert.equal(snapshot.atlasIIConfig.activeLayout, 'reverseL');
  assert.equal(snapshot.sourceHealth.jma.ok, true);
});
