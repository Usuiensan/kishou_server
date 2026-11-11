const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const artContext = { window: {} };
vm.runInNewContext(fs.readFileSync('telop/tsunami-art.js', 'utf8'), artContext);
const art = artContext.window.TSUNAMI_ART;
const officialCodes = JSON.parse(fs.readFileSync('protocol/atlas-ii-tsunami-areas-v1.json', 'utf8'))
  .zones.map(({ code }) => String(code));

test('every JMA tsunami forecast zone has drawable coastline paths', () => {
  assert.deepEqual(Object.keys(art.zoneNames).sort(), officialCodes.sort());
  assert.deepEqual(Object.keys(art.zones).sort(), officialCodes.sort());
  for (const code of officialCodes) {
    assert.ok(art.zones[code].paths.length > 0, `${code} ${art.zoneNames[code]} has no paths`);
    for (const path of art.zones[code].paths) {
      const coordinates = [...path.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)];
      assert.ok(coordinates.length >= 2, `${code} contains a degenerate path`);
      assert.ok(path.startsWith('M'), `${code} path does not start with M`);
      assert.ok(coordinates.every(([, x, y]) => Number.isFinite(Number(x)) && Number.isFinite(Number(y))), `${code} has invalid coordinates`);
    }
  }
});
