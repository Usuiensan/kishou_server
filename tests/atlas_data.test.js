const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseTsunami } = require('../lib/parsers/tsunami');
const { parseEarthquake } = require('../lib/parsers/earthquake');
const { createAtlasData, createAtlasSnapshot, applyAtlasBulletin } = require('../lib/atlasData');

const sample = (name) => fs.readFileSync(path.join(__dirname, 'samples', name), 'utf8');

test('津波電文の通常・更新・取消をアトラス表示モデルへ変換する', () => {
  const first = createAtlasData('tsunami', parseTsunami(sample('32-39_11_02_250206_VTSE41.xml')));
  const update = createAtlasData('tsunami', parseTsunami(sample('32-39_11_06_250206_VTSE41.xml')));
  const cancel = createAtlasData('tsunami', parseTsunami(sample('38-39_03_01_210805_VTSE41.xml')));

  assert.equal(first.action, 'upsert');
  assert.ok(first.payload.render.major.length > 0);
  assert.equal(update.action, 'upsert');
  assert.notDeepEqual(update.payload.render.major, first.payload.render.major);
  assert.equal(cancel.action, 'cancel');
  assert.match(cancel.payload.lines[0], /解除/);
  assert.deepEqual(cancel.payload.render, { major: [], warning: [], advisory: [] });
});

test('EEW警報の通常・続報・取消を同じ縦型コンポーネント入力へ変換する', () => {
  const first = createAtlasData('eew', parseEarthquake(sample('37_01_01_240613_VXSE43.xml')));
  const update = createAtlasData('eew', parseEarthquake(sample('37_01_02_240613_VXSE43.xml')));
  const cancel = createAtlasData('eew', parseEarthquake(sample('37_01_03_240613_VXSE43.xml')));

  assert.equal(first.action, 'upsert');
  assert.equal(first.payload.render.latitude, 33.2);
  assert.equal(first.payload.render.longitude, 132.4);
  assert.ok(first.payload.render.areas.length > 0);
  assert.equal(update.action, 'upsert');
  assert.notDeepEqual(update.payload.render.areas, first.payload.render.areas);
  assert.equal(cancel.action, 'cancel');
});

test('EEW取消は同一イベントのEEWだけを除き、同イベントIDの津波を保持する', () => {
  const tsunami = createAtlasData('tsunami', { ...parseTsunami(sample('32-39_11_02_250206_VTSE41.xml')), eventId: '20240417231454' });
  const eew = createAtlasData('eew', parseEarthquake(sample('37_01_01_240613_VXSE43.xml')));
  const cancel = createAtlasData('eew', parseEarthquake(sample('37_01_03_240613_VXSE43.xml')));
  let state = applyAtlasBulletin(createAtlasSnapshot(), tsunami, 1000);
  state = applyAtlasBulletin(state, eew, 1001);
  state = applyAtlasBulletin(state, cancel, 1002);
  assert.equal(state.layers.eew.length, 0);
  assert.equal(state.layers.tsunami.length, 1);
});

test('震度電文と縦書き見出しを同一イベントの独立レイヤーにする', () => {
  const parsed = parseEarthquake(sample('32-39_11_05_240613_VXSE53.xml'));
  const intensity = createAtlasData('intensity', parsed);
  const vertical = createAtlasData('vertical', { ...parsed, verticalHeadline: '震度７を観測' });
  let state = applyAtlasBulletin(createAtlasSnapshot(), intensity, 1000);
  state = applyAtlasBulletin(state, vertical, 1001);
  assert.ok(state.layers.intensity[0].payload.render.maxInt);
  assert.equal(state.layers.vertical[0].payload.text, '震度７を観測');
});

test('震度情報から県名・震度・ルビを付けた縦見出しを作る', () => {
  const parsed = parseEarthquake(sample('32-39_11_05_240613_VXSE53.xml'));
  const vertical = createAtlasData('vertical', parsed);
  assert.deepEqual(vertical.payload, { text: '宮城で震度7', place: '宮城', reading: 'みやぎ', intensity: '7' });

  const tokyo = createAtlasData('vertical', { ...parsed, intensity: { ...parsed.intensity, prefs: [{ name: '東京都', maxInt: '7' }] } });
  assert.equal(tokyo.payload.reading, 'とうきょう');
});
