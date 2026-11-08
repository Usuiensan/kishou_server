const test = require('node:test');
const assert = require('node:assert/strict');

const { EewTracker } = require('../lib/eewTracker');
const { formatEarthquake } = require('../lib/formatter');

function eew({ eventId = '20261016123810', infoType = '発表', serial = 1, areas = ['東京'], isWarning = true } = {}) {
  return {
    isEEW: true,
    isWarning,
    eventId,
    infoType,
    reportId: serial,
    serial,
    reportTime: '2026-10-16 12:38:10',
    headline: 'カムチャツカ半島付近で地震 強い揺れに警戒',
    eewAreas: areas,
  };
}

test('最初の警報は通常投稿、同じ報の再送は重複として止まる', () => {
  const tracker = new EewTracker();
  assert.equal(tracker.accept(eew({ serial: 1 })).action, 'full');
  assert.equal(tracker.accept(eew({ serial: 1 })).action, 'skip');
});

test('続報は追加地域だけが差分になり、追加がなければキャッシュ更新のみ', () => {
  const tracker = new EewTracker();
  assert.equal(tracker.accept(eew({ serial: 1, areas: ['東京'] })).action, 'full');

  const delta = tracker.accept(eew({ serial: 2, areas: ['東京', '神奈川'] }));
  assert.equal(delta.action, 'delta');
  assert.deepEqual(delta.additionalAreas, ['神奈川']);

  assert.equal(tracker.accept(eew({ serial: 3, areas: ['東京', '神奈川'] })).action, 'silent');
});

test('予報は投稿枠を消費せず、後の警報が通常投稿になる', () => {
  const tracker = new EewTracker();
  const forecast = eew({ serial: 1, isWarning: false });
  assert.equal(tracker.accept(forecast, { postable: false }).action, 'skip');

  assert.equal(tracker.accept(eew({ serial: 2 })).action, 'full');
});

test('取消は必ず投稿され、同じ取消の再送だけが止まる', () => {
  const tracker = new EewTracker();
  assert.equal(tracker.accept(eew({ serial: 1 })).action, 'full');
  // 取消は直前報と同じ情報番号でも infoType が違うため別キーになる
  assert.equal(tracker.accept(eew({ serial: 1, infoType: '取消' })).action, 'cancel');
  assert.equal(tracker.accept(eew({ serial: 1, infoType: '取消' })).action, 'skip');
});

test('別経路から同じ報が届いても二重投稿にならない', () => {
  const tracker = new EewTracker();
  // P2P 経由の第1報
  assert.equal(tracker.accept(eew({ serial: 1 })).action, 'full');
  // JMA 電文経由で同じ第1報 (eventId・serial が一致) → 重複
  assert.equal(tracker.accept(eew({ serial: 1 })).action, 'skip');
  // JMA 経由でしか届かなかった取消 → 投稿される
  assert.equal(tracker.accept(eew({ serial: 1, infoType: '取消' })).action, 'cancel');
});

test('差分続報の整形は続報表記になり、追加地域だけが載る', () => {
  const formatted = formatEarthquake({
    ...eew({ areas: ['神奈川'] }),
    eewAdditionalAreas: ['神奈川'],
    isEewDelta: true,
  });
  assert.ok(formatted);
  assert.equal(formatted.isEewDelta, true);
  const text = (formatted.lines || []).map((line) => line.text).join('\n');
  assert.match(text, /続報/);
  assert.match(text, /神奈川/);
  assert.doesNotMatch(text, /東京/);
});
