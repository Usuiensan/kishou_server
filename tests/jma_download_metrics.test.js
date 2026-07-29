const assert = require('node:assert/strict');
const test = require('node:test');
const { createJmaDownloadMetrics, getJstDateKey } = require('../lib/jmaDownloadMetrics');

test('JMA取得量をfeed/detail別に日次累計する', () => {
  const logs = [];
  const metrics = createJmaDownloadMetrics({ logger: (line) => logs.push(line) });
  const now = new Date('2026-07-30T00:00:00+09:00');

  metrics.record('feed', 54024, now);
  metrics.record('detail', 2349, now);
  metrics.record('detail', 2705, now);

  assert.deepEqual(metrics.snapshot(now), {
    date: '2026-07-30',
    feed: { requests: 1, bytes: 54024 },
    detail: { requests: 2, bytes: 5054 },
  });
  assert.equal(metrics.formatSnapshot(now), '📊 JMA取得量（日次累計 JST 2026-07-30） feed 1件/54,024B detail 2件/5,054B total 3件/59,078B');
  assert.equal(metrics.logIfDue(now), true);
  assert.equal(logs.length, 1);
  assert.equal(metrics.logIfDue(new Date(now.getTime() + 9 * 60 * 1000)), false);
  assert.equal(metrics.logIfDue(new Date(now.getTime() + 10 * 60 * 1000)), true);
  assert.equal(logs.length, 2);
});

test('日本時間の日付変更で日次累計を切り替える', () => {
  const metrics = createJmaDownloadMetrics({ logger() {} });
  const beforeMidnight = new Date('2026-07-30T23:59:59+09:00');
  const afterMidnight = new Date('2026-07-31T00:00:00+09:00');

  assert.equal(getJstDateKey(beforeMidnight), '2026-07-30');
  metrics.record('feed', 100, beforeMidnight);
  metrics.record('detail', 200, afterMidnight);

  assert.deepEqual(metrics.snapshot(afterMidnight), {
    date: '2026-07-31',
    feed: { requests: 0, bytes: 0 },
    detail: { requests: 1, bytes: 200 },
  });
});
