const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const areas = JSON.parse(fs.readFileSync('protocol/atlas-ii-tsunami-areas-v1.json', 'utf8'))
  .zones.map(({ code }) => String(code)).sort();
const regions = JSON.parse(fs.readFileSync('telop/tsunami-regions.json', 'utf8'));
const source = fs.readFileSync('telop/tsunami-art.js', 'utf8');
const context = { window: {} };
vm.runInNewContext(source, context);
const art = context.window.TSUNAMI_ART;

test('all forecast areas have fixed advisory, warning, and major warning bands', () => {
  assert.deepEqual(Object.keys(regions).sort(), areas);
  for (const code of areas) {
    for (const kind of ['advisory', 'warning', 'major']) {
      const paths = regions[code][kind];
      assert.ok(paths.length, `${code} ${kind} has no fixed area`);
      assert.ok(paths.every((d) => typeof d === 'string' && d.startsWith('M') && d.endsWith('Z')),
        `${code} ${kind} contains a non-polygon path`);
      assert.ok(paths.every((d) => [...d.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)]
        .every(([, x, y]) => Number.isFinite(Number(x)) && Number.isFinite(Number(y)))),
      `${code} ${kind} contains invalid coordinates`);
    }
  }
});

test('production drawing fills stored region bands instead of stroking coastlines', () => {
  assert.deepEqual(Object.keys(art.regions).sort(), areas);
  assert.deepEqual(JSON.parse(JSON.stringify(art.regions)), regions);
  const html = fs.readFileSync('telop/tsunami.html', 'utf8');
  assert.match(html, /Object\.entries\(ART\.regions\)/);
  assert.match(html, /fill=\"\$\{TM_COLORS\[k\]\}\" fill-rule=\"evenodd\"/);
  assert.doesNotMatch(html, /stroke-width=\"\$\{width\}\"/);
});
