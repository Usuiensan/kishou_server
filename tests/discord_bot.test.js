const assert = require('node:assert/strict');
const test = require('node:test');
const { shouldDeliver } = require('../lib/discordBot');

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
