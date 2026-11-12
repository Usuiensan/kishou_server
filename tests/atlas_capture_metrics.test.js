const test = require('node:test');
const assert = require('node:assert/strict');
const { summarizeCaptures } = require('../tools/atlas_capture_metrics');

test('Chromium capture metrics use observed timestamps and screenshot durations', () => {
  const result = summarizeCaptures([
    { at: 100, unixMs: 1000, durationMs: 2 },
    { at: 120, unixMs: 1020, durationMs: 4 },
    { at: 140, unixMs: 1040, durationMs: 6 },
  ], 2, 1050);
  assert.equal(result.fps, 50);
  assert.equal(result.changedFrames, 2);
  assert.deepEqual(result.intervalMs, { average: 20, max: 20, p95: 20 });
  assert.deepEqual(result.durationMs, { average: 4, max: 6, p95: 6 });
});
