const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const {
  shouldDeliver,
  loadDeliveryKeys,
  saveDeliveryKeys,
  createDiscordDeliveryKey,
  createDiscordDeliveryChunkKey,
} = require('../lib/discordBot');

const earthquake = (type) => ({ type });
const config = (...categories) => ({ categories });

test('defaultはEEWまたは最大震度4以上だけを通知する', () => {
  assert.equal(shouldDeliver(earthquake('eew'), config('default')), true);
  assert.equal(shouldDeliver(earthquake('earthquake_4'), config('default')), true);
  assert.equal(shouldDeliver(earthquake('earthquake_5l'), config('default')), true);
  assert.equal(shouldDeliver(earthquake('earthquake_1'), config('default')), false);
  assert.equal(shouldDeliver(earthquake('earthquake_3'), config('default')), false);
});

test('defaultとeewとnervの併用では低震度を通知せず、明示カテゴリを通知する', () => {
  const selected = config('default', 'eew', 'nerv');
  assert.equal(shouldDeliver(earthquake('eew'), selected), true);
  assert.equal(shouldDeliver({ type: 'nerv', source: 'nerv' }, selected), true);
  assert.equal(shouldDeliver(earthquake('earthquake_1'), selected), false);
});

test('eewとnervはdefaultなしでも独立して通知する', () => {
  assert.equal(shouldDeliver(earthquake('eew'), config('eew')), true);
  assert.equal(shouldDeliver({ type: 'nerv', source: 'nerv' }, config('nerv')), true);
  assert.equal(shouldDeliver(earthquake('earthquake_1'), config('eew', 'nerv')), false);
});

test('明示した震度カテゴリの閾値で通知する', () => {
  assert.equal(shouldDeliver(earthquake('earthquake_1'), config('intensity_1')), true);
  assert.equal(shouldDeliver(earthquake('earthquake_3'), config('intensity_1')), true);
  assert.equal(shouldDeliver(earthquake('earthquake_3'), config('intensity_4')), false);
  assert.equal(shouldDeliver(earthquake('earthquake_4'), config('intensity_4')), true);
});

test('Discord Bot送信キーは送出時刻だけが変わっても同一情報として扱う', () => {
  const first = createDiscordDeliveryKey({
    source: 'jma', type: 'earthquake_4', id: 'volatile-id', timestamp: '2026-01-01T00:00:00Z',
    sentTimestamp: '2026-01-01T00:00:01Z', lines: [{ text: '本文', duration: 7.5 }],
  });
  const afterRestart = createDiscordDeliveryKey({
    source: 'jma', type: 'earthquake_4', id: 'another-volatile-id', timestamp: '2026-01-02T00:00:00Z',
    sentTimestamp: '2026-01-02T00:00:01Z', lines: [{ text: '本文', duration: 7.5 }],
  });
  const changed = createDiscordDeliveryKey({
    source: 'jma', type: 'earthquake_4', id: 'another-volatile-id', timestamp: '2026-01-02T00:00:00Z',
    sentTimestamp: '2026-01-02T00:00:01Z', lines: [{ text: '更新本文', duration: 7.5 }],
  });
  assert.equal(first, afterRestart);
  assert.notEqual(first, changed);
});

test('Discord Bot送信済みチャンク台帳を再起動後も読み込める', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kishou-discord-bot-'));
  const filePath = path.join(directory, 'delivery.json');
  const keys = new Set([createDiscordDeliveryChunkKey('channel-1', 'message-1', 0)]);
  saveDeliveryKeys(keys, filePath);
  assert.deepEqual([...loadDeliveryKeys(filePath)], [...keys]);
});
