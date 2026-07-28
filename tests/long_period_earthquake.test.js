const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseEarthquake } = require('../lib/parsers/earthquake');
const { formatEarthquake } = require('../lib/formatter');

test('VXSE62 long-period observation keeps class-by-area groups', () => {
  const xml = fs.readFileSync(path.join(__dirname, 'samples/78_01_01_240613_VXSE62.xml'), 'utf8');
  const parsed = parseEarthquake(xml);

  assert.equal(parsed.lgIntensity.maxLgInt, 3);
  assert.deepEqual(parsed.lgIntensity.groups['3'], ['宮城県北部']);
  assert.ok(parsed.lgIntensity.groups['1'].includes('青森県津軽北部'));

  const formatted = formatEarthquake(parsed);
  assert.ok(formatted);
  const text = JSON.stringify(formatted);
  assert.match(text, /長周期地震動/);
  assert.match(text, /宮城県北部/);
});
