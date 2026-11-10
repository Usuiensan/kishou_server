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
  assert.ok(first.payload.render.areas.includes('愛媛県南予'));
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
  const regions = [...new Set(Object.values(intensity.payload.render.cityGroups).flat())];
  assert.ok(regions.includes('栗原市'));
  assert.deepEqual(regions.filter((name) => !intensity.payload.render.cityReadings[name]), []);
  assert.equal(intensity.payload.render.cityReadings['栗原市'], 'くりはらし');
  const eewZone = createAtlasData('intensity', {
    ...parsed,
    intensity: { ...parsed.intensity, cityGroups: { '4': ['愛媛県南予'] } },
  });
  assert.equal(eewZone.payload.render.cityReadings['愛媛県南予'], 'えひめけん なんよ');
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

test('震度速報の説明を津波の心配の有無と震源情報の2ページにする', () => {
  const bulletin = {
    eventId: 'frame-sample', infoType: '発表', infoKind: '震度速報', originTimeFormatted: '午前1時4分',
    intensity: { maxInt: '5+', groups: { '5+': ['静岡県西部'] }, cityGroups: { '5+': ['浜松市'] } },
    earthquake: { hypocenter: { name: '静岡県西部', description: '深さ４０ｋｍ' }, magnitude: '5.7' },
  };
  const pending = createAtlasData('intensity', bulletin);
  assert.deepEqual(pending.payload.summaryFrames, [
    { lines: ['午前1時4分ごろ東海地方で震度5強', '沿岸部では念のため津波に注意'] },
    { lines: ['震源は静岡県西部', '深さ40キロ　マグニチュード5.7'] },
  ]);

  const noTsunami = createAtlasData('intensity', { ...bulletin, tsunamiWorry: false, comment: '津波の心配はありません。' });
  assert.equal(noTsunami.payload.summaryFrames[0].lines[1], '津波の心配はありません');
  const announced = createAtlasData('intensity', { ...bulletin, tsunamiWorry: true });
  assert.equal(announced.payload.summaryFrames[0].lines[1], '沿岸部では念のため津波に注意');
  const laterReport = createAtlasData('intensity', { ...bulletin, infoKind: '地震情報', tsunamiWorry: true });
  assert.equal(laterReport.payload.summaryFrames[0].lines[1], '津波情報が発表されています');
});
