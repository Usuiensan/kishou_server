const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseEarthquake } = require('../lib/parsers/earthquake');
const zones = require('../protocol/atlas-ii-eew-areas-v1.json').zones;

test('EEW mapping has 188 unique numeric JMA areas and matches real local VXSE43 XML', () => {
  const byCode = new Map(zones.map((zone) => [zone.areaId, zone.name]));
  const byName = new Map(zones.map((zone) => [zone.name, zone.areaId]));
  assert.equal(zones.length, 188);
  assert.equal(byCode.size, 188);
  assert.equal(byName.size, 188);
  const sampleDir = path.join(__dirname, 'samples');
  const files = fs.readdirSync(sampleDir).filter((name) => name.endsWith('VXSE43.xml'));
  let matched = 0;
  for (const file of files) {
    const parsed = parseEarthquake(fs.readFileSync(path.join(sampleDir, file), 'utf8'));
    for (const area of parsed.eewForecastAreas) {
      assert.equal(byCode.get(area.code), area.name, `${file}: ${area.code}/${area.name}`);
      assert.equal(byName.get(area.name), area.code, `${file}: ${area.name}/${area.code}`);
      matched++;
    }
  }
  assert.ok(matched >= 20);
});
