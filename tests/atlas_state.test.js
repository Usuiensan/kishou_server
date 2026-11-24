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
const gatedEew = ({ id = 'g-1', isWarning = false, maxInt = '2', serial = 1, publishedAt = '2026-11-09T10:00:00+09:00', action = 'upsert' } = {}) => ({
  version: 1, kind: 'eew', action,
  event: { id, publishedAt, serial, infoType: action === 'cancel' ? '取消' : '発表', infoKind: 'eew' },
  payload: { render: { hypocenterName: '福島県沖', areas: [], isWarning, maxInt } },
});
const gatedIntensity = ({ id = 'g-1', maxInt = '2', longPeriodFrames = [], publishedAt = '2026-11-09T10:03:00+09:00' } = {}) => ({
  version: 1, kind: 'intensity', action: 'upsert',
  event: { id, publishedAt, serial: 1, infoType: '発表', infoKind: '震源・震度に関する情報' },
  payload: { render: { maxInt }, longPeriodFrames, summaryFrames: [] },
});
const gatedVertical = ({ id = 'g-1', level = '2', publishedAt = '2026-11-09T10:03:00+09:00' } = {}) => ({
  version: 1, kind: 'vertical', action: 'upsert',
  event: { id, publishedAt, serial: 1, infoType: '発表', infoKind: '震源・震度に関する情報' },
  payload: { text: `福島で震度${level}`, intensity: level },
});

test('表示ゲート: 予報級EEWは予想最大震度3以下では状態に入らず、4以上・不明・警報級は入る', () => {
  for (const maxInt of ['1', '2', '3']) {
    const snapshot = applyAtlasBulletin(createAtlasSnapshot(), gatedEew({ maxInt }), 1000);
    assert.equal(snapshot.layers.eew.length, 0, maxInt);
    assert.deepEqual(snapshot.eewOutputEvents, {}, maxInt);
  }
  for (const maxInt of ['4', '5-', '7', null]) {
    const snapshot = applyAtlasBulletin(createAtlasSnapshot(), gatedEew({ maxInt }), 1000);
    assert.equal(snapshot.layers.eew.length, 1, String(maxInt));
    assert.equal(typeof snapshot.eewOutputEvents['g-1'], 'number', String(maxInt));
  }
  const warning = applyAtlasBulletin(createAtlasSnapshot(), gatedEew({ isWarning: true, maxInt: '3' }), 1000);
  assert.equal(warning.layers.eew.length, 1);
});

test('表示ゲート: 予報が途中で4以上に上がれば表示が始まり、その後の低下でも表示中の続報は受ける', () => {
  let snapshot = applyAtlasBulletin(createAtlasSnapshot(), gatedEew({ maxInt: '2', serial: 1 }), 1000);
  assert.equal(snapshot.layers.eew.length, 0);
  snapshot = applyAtlasBulletin(snapshot, gatedEew({ maxInt: '4', serial: 2, publishedAt: '2026-11-09T10:00:20+09:00' }), 2000);
  assert.equal(snapshot.layers.eew.length, 1);
  snapshot = applyAtlasBulletin(snapshot, gatedEew({ maxInt: '2', serial: 3, publishedAt: '2026-11-09T10:00:40+09:00' }), 3000);
  assert.equal(snapshot.layers.eew.length, 1);
  assert.equal(snapshot.layers.eew[0].event.serial, 3);
});

test('表示ゲート: 表示していないEEWの取消は状態に入らず、表示したEEWの取消は入る', () => {
  let snapshot = applyAtlasBulletin(createAtlasSnapshot(), gatedEew({ maxInt: '2', serial: 1 }), 1000);
  snapshot = applyAtlasBulletin(snapshot, gatedEew({ action: 'cancel', serial: 2, publishedAt: '2026-11-09T10:00:20+09:00' }), 2000);
  assert.equal(snapshot.layers.eew.length, 0);
  let shown = applyAtlasBulletin(createAtlasSnapshot(), gatedEew({ maxInt: '4', serial: 1 }), 1000);
  shown = applyAtlasBulletin(shown, gatedEew({ action: 'cancel', serial: 2, publishedAt: '2026-11-09T10:00:20+09:00' }), 2000);
  assert.equal(shown.layers.eew.length, 1);
  assert.equal(shown.layers.eew[0].action, 'cancel');
});

test('表示ゲート: 実震度1・2の地震情報は単独では入らず、震度3以上と長周期は入る', () => {
  for (const maxInt of ['1', '2']) {
    assert.equal(applyAtlasBulletin(createAtlasSnapshot(), gatedIntensity({ maxInt }), 1000).layers.intensity.length, 0, maxInt);
    assert.equal(applyAtlasBulletin(createAtlasSnapshot(), gatedVertical({ level: maxInt }), 1000).layers.vertical.length, 0, maxInt);
  }
  assert.equal(applyAtlasBulletin(createAtlasSnapshot(), gatedIntensity({ maxInt: '3' }), 1000).layers.intensity.length, 1);
  assert.equal(applyAtlasBulletin(createAtlasSnapshot(), gatedIntensity({ maxInt: '2', longPeriodFrames: [{ type: 'heading', lines: [] }] }), 1000).layers.intensity.length, 1);
});

test('表示ゲート: EEWが出た地震の実震度1・2は入り、別イベントの実震度1・2は入らない', () => {
  let snapshot = applyAtlasBulletin(createAtlasSnapshot(), gatedEew({ id: 'g-9', maxInt: '4' }), 1000);
  snapshot = applyAtlasBulletin(snapshot, gatedIntensity({ id: 'g-9', maxInt: '1' }), 2000);
  assert.equal(snapshot.layers.intensity.length, 1);
  snapshot = applyAtlasBulletin(snapshot, gatedVertical({ id: 'g-9', level: '1' }), 2100);
  assert.equal(snapshot.layers.vertical.length, 1);
  snapshot = applyAtlasBulletin(snapshot, gatedIntensity({ id: 'other', maxInt: '1' }), 2200);
  assert.equal(snapshot.layers.intensity.length, 1);
});

test('表示ゲート: EEW記録は24時間で失効し、それ以降の実震度1・2は入らない', () => {
  let snapshot = applyAtlasBulletin(createAtlasSnapshot(), gatedEew({ id: 'g-24', maxInt: '4' }), 1000);
  const later = 1000 + 24 * 60 * 60_000 + 1;
  snapshot = applyAtlasBulletin(snapshot, gatedIntensity({ id: 'g-24', maxInt: '1' }), later);
  assert.equal(snapshot.layers.intensity.length, 0);
});

test('表示ゲート: testMode と訓練電文には適用しない', () => {
  const testSnapshot = { ...createAtlasSnapshot(), testMode: true };
  assert.equal(applyAtlasBulletin(testSnapshot, gatedEew({ maxInt: '2' }), 1000).layers.eew.length, 1);
  const training = gatedEew({ maxInt: '2' });
  training.event.training = true;
  assert.equal(applyAtlasBulletin(createAtlasSnapshot(), training, 1000).layers.eew.length, 1);
  assert.equal(applyAtlasBulletin(testSnapshot, gatedIntensity({ maxInt: '1' }), 1000).layers.intensity.length, 1);
});
