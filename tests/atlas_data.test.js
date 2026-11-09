const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseTsunami } = require('../lib/parsers/tsunami');
const { parseEarthquake } = require('../lib/parsers/earthquake');
const { createAtlasData } = require('../lib/atlasData');

const sample = (name) => fs.readFileSync(path.join(__dirname, 'samples', name), 'utf8');

test('津波電文の通常・更新・取消をアトラス表示モデルへ変換する', () => {
  const first = createAtlasData('tsunami', parseTsunami(sample('32-39_11_02_250206_VTSE41.xml')));
  const update = createAtlasData('tsunami', parseTsunami(sample('32-39_11_06_250206_VTSE41.xml')), first);
  const cancel = createAtlasData('tsunami', parseTsunami(sample('38-39_03_01_210805_VTSE41.xml')), update);

  assert.equal(first.action, 'normal');
  assert.ok(first.tsunami.major.length > 0);
  assert.equal(update.action, 'update');
  assert.notDeepEqual(update.tsunami.major, first.tsunami.major);
  assert.equal(cancel.action, 'cancel');
  assert.match(cancel.top.lines[0], /解除/);
  assert.deepEqual(cancel.tsunami, { visible: false, major: [], warning: [], advisory: [] });
});

test('EEW警報の通常・続報・取消を同じ縦型コンポーネント入力へ変換する', () => {
  const first = createAtlasData('eew', parseEarthquake(sample('37_01_01_240613_VXSE43.xml')));
  const update = createAtlasData('eew', parseEarthquake(sample('37_01_02_240613_VXSE43.xml')), first);
  const cancel = createAtlasData('eew', parseEarthquake(sample('37_01_03_240613_VXSE43.xml')), update);

  assert.equal(first.action, 'normal');
  assert.equal(first.eew.visible, true);
  assert.equal(first.eew.latitude, 33.2);
  assert.equal(first.eew.longitude, 132.4);
  assert.ok(first.eew.areas.length > 0);
  assert.equal(update.action, 'update');
  assert.notDeepEqual(update.eew.areas, first.eew.areas);
  assert.equal(cancel.action, 'cancel');
  assert.equal(cancel.eew.visible, false);
});
