const test = require('node:test');
const assert = require('node:assert/strict');

const { FEED_FETCH_SECONDS, nextFeedFetchDelay } = require('../lib/feedSchedule');

function at(sec, ms = 0) {
  return new Date(2026, 10, 15, 12, 34, sec, ms);
}

test('取得秒は毎分20秒と50秒', () => {
  assert.deepEqual(FEED_FETCH_SECONDS, [20, 50]);
});

test('20秒より前ならその分の20秒まで', () => {
  assert.equal(nextFeedFetchDelay(at(10)), 10 * 1000);
  assert.equal(nextFeedFetchDelay(at(0)), 20 * 1000);
});

test('20秒ちょうどなら50秒まで (同時刻は次扱い)', () => {
  assert.equal(nextFeedFetchDelay(at(20)), 30 * 1000);
});

test('20秒を過ぎたら50秒まで', () => {
  assert.equal(nextFeedFetchDelay(at(35)), 15 * 1000);
  assert.equal(nextFeedFetchDelay(at(20, 500)), 29 * 1000 + 500);
});

test('50秒を過ぎたら次の分の20秒まで', () => {
  assert.equal(nextFeedFetchDelay(at(55)), 25 * 1000);
  assert.equal(nextFeedFetchDelay(at(50)), 30 * 1000);
});
