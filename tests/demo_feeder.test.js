const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { buildEewPlaylist, buildTelopPlaylist } = require('../tools/demo_feeder');

const corpusDir = '/home/hatch/jma-xml-corpus/real';

test('EEW playlist alternates real forecast and warning series with <=25s intervals', () => {
  const playlist = buildEewPlaylist({ corpusDir, fallbackDir: path.join(__dirname, 'samples') });
  assert.deepEqual(playlist.map((scenario) => scenario.name), ['予報', '警報']);
  for (const scenario of playlist) {
    assert.ok(scenario.steps.length >= 3);
    assert.equal(scenario.steps.at(-1).data.isCancel, true);
    assert.ok(scenario.steps.slice(0, -1).every((step) => step.data.isCancel === false));
    assert.ok(scenario.intervalMs <= 25_000);
  }
});

test('telop playlist contains intensity, tsunami, and long-period scenarios', () => {
  const playlist = buildTelopPlaylist();
  assert.deepEqual(playlist.map((scenario) => scenario.name), ['震度', '津波', '長周期']);
  assert.ok(playlist.every((scenario) => scenario.holdMs >= 120_000 && scenario.cancel));
  assert.ok(playlist.every((scenario) => scenario.xml && scenario.cancel));
});
