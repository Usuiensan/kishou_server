const test = require('node:test');
const assert = require('node:assert/strict');
const { lookupEpicenterRegion, EPICENTER_REGION_COUNT } = require('../lib/epicenterRegion');
const { createAtlasData } = require('../lib/atlasData');

// 期待値は tests/samples の気象庁XML（震央地名コード付き）から取った実例
test('震央地名ポリゴンで国内の震央を判定する', () => {
  assert.equal(EPICENTER_REGION_COUNT, 331);
  assert.deepEqual(lookupEpicenterRegion(34.8, 138.5), { code: 485, name: '駿河湾', reading: 'するがわん' });
  assert.deepEqual(lookupEpicenterRegion(39.0, 140.9), { code: 213, name: '岩手県内陸南部', reading: 'いわてけんないりくなんぶ' });
  assert.equal(lookupEpicenterRegion(30.9, 131.1)?.code, 820);
  assert.equal(lookupEpicenterRegion(30.9, 131.1)?.name, '大隅半島東方沖');
});

test('海外の震央も判定する（負の経度は0〜360度表記へ正規化）', () => {
  assert.deepEqual(lookupEpicenterRegion(-17.2, 178.6), { code: 950, name: '南太平洋', reading: 'みなみたいへいよう' });
  assert.equal(lookupEpicenterRegion(-36.1, -72.6)?.code, 946);
  assert.equal(lookupEpicenterRegion(-36.1, -72.6)?.name, '南米西部');
  assert.equal(lookupEpicenterRegion(-36.1, 287.4)?.code, 946);
});

test('不正な座標ではnullを返す', () => {
  assert.equal(lookupEpicenterRegion(null, 138.5), null);
  assert.equal(lookupEpicenterRegion(34.8, undefined), null);
  assert.equal(lookupEpicenterRegion(NaN, 138.5), null);
  assert.equal(lookupEpicenterRegion(91, 138.5), null);
  assert.equal(lookupEpicenterRegion(34.8, 361), null);
  assert.equal(lookupEpicenterRegion(34.8, -181), null);
});

test('EEWで震央地名が無い場合は座標から補完し、ある場合は上書きしない', () => {
  const base = { eventId: 'epicenter-fallback', infoType: '発表', eewAreaDetails: [] };
  const filled = createAtlasData('eew', { ...base, earthquake: { hypocenter: { name: '', coordinate: '+34.8+138.5-10000/' } } });
  assert.equal(filled.payload.render.hypocenterName, '駿河湾');
  const kept = createAtlasData('eew', { ...base, earthquake: { hypocenter: { name: '静岡県西部', coordinate: '+34.8+138.5-10000/' } } });
  assert.equal(kept.payload.render.hypocenterName, '静岡県西部');
  const noCoord = createAtlasData('eew', { ...base, earthquake: { hypocenter: { name: '', coordinate: '' } } });
  assert.equal(noCoord.payload.render.hypocenterName, '');
});
