const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
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

test('defaultは廃止し、EEWと震度4以上は明示購読する', () => {
  assert.equal(shouldDeliver(earthquake('eew'), config('default')), false);
  assert.equal(shouldDeliver(earthquake('eew'), config('eew')), true);
  assert.equal(shouldDeliver(earthquake('earthquake_4'), config('intensity_4')), true);
  assert.equal(shouldDeliver(earthquake('earthquake_5l'), config('intensity_4')), true);
  assert.equal(shouldDeliver(earthquake('earthquake_3'), config('intensity_4')), false);
});

test('NERV一括カテゴリは廃止し、細分化カテゴリだけを通知する', () => {
  const selected = config('eew', 'nerv_level5', 'nerv_news');
  assert.equal(shouldDeliver(earthquake('eew'), selected), true);
  assert.equal(shouldDeliver({ type: 'nerv', source: 'nerv', nervCategories: ['nerv_level5'] }, selected), true);
  assert.equal(shouldDeliver({ type: 'nerv', source: 'nerv', nervCategories: ['nerv_level4'] }, selected), false);
  assert.equal(shouldDeliver(earthquake('earthquake_1'), selected), false);
});

test('eewとnervはdefaultなしでも独立して通知する', () => {
  assert.equal(shouldDeliver(earthquake('eew'), config('eew')), true);
  assert.equal(shouldDeliver({ type: 'nerv', source: 'nerv', nervCategory: 'news' }, config('nerv_news')), true);
  assert.equal(shouldDeliver({ type: 'nerv', source: 'nerv', nervCategory: 'news' }, config('nerv')), false);
  assert.equal(shouldDeliver(earthquake('earthquake_1'), config('eew', 'nerv_news')), false);
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

test('旧defaultとnerv購読を解除し、明示購読だけを移行する', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kishou-discord-subscriptions-'));
  const filePath = path.join(directory, 'subscriptions.json');
  fs.writeFileSync(filePath, JSON.stringify({
    guild: {
      legacyDefault: { categories: ['default'] },
      legacyNerv: { categories: ['nerv'] },
      explicit: { categories: ['eew', 'intensity_4'] },
    },
  }));
  const script = "process.stdout.write(JSON.stringify(require('./lib/discordBot').loadSubscriptions()))";
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DISCORD_SUBSCRIPTIONS_FILE: filePath },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { guild: { explicit: { categories: ['eew', 'intensity_4'] } } });
  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')), { guild: { explicit: { categories: ['eew', 'intensity_4'] } } });
});
