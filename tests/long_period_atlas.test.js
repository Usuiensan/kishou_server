const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseEarthquake } = require('../lib/parsers/earthquake');
const { createAtlasData } = require('../lib/atlasData');

test('VXSE62の長周期観測点が階級別に保持される', () => {
  const xml = fs.readFileSync(path.join(__dirname, 'samples/78_01_01_240613_VXSE62.xml'), 'utf8');
  const parsed = parseEarthquake(xml);

  // 既存の細分区域単位groupsは従来どおり
  assert.deepEqual(parsed.lgIntensity.groups['3'], ['宮城県北部']);
  // 観測点（市区町村名）単位はstationGroupsへ追加で保持する
  assert.deepEqual(parsed.lgIntensity.stationGroups['3'], ['登米市中田町']);
  assert.ok(parsed.lgIntensity.stationGroups['1'].includes('青森市花園'));
  assert.ok(parsed.lgIntensity.stationGroups['1'].includes('奥州市水沢大鐘町'));
  // 市区町村単位に丸めた cityGroups (市区町村ごとの最大階級) も保持する
  assert.deepEqual(parsed.lgIntensity.cityGroups['3'], ['登米市']);
  assert.ok(parsed.lgIntensity.cityGroups['1'].includes('青森市'));
  assert.ok(parsed.lgIntensity.cityGroups['1'].includes('奥州市'));
});

test('長周期フレームは見出し・説明行・階級4から1の順で生成される', () => {
  const xml = fs.readFileSync(path.join(__dirname, 'samples/78_01_01_240613_VXSE62.xml'), 'utf8');
  const data = createAtlasData('intensity', parseEarthquake(xml));
  const frames = data.payload.longPeriodFrames;

  assert.deepEqual(frames[0], {
    type: 'heading',
    lines: ['午前2時23分ごろの地震により', '長周期地震動を観測しました'],
  });
  // 初期版にあった説明行が見出しの直後に入る
  assert.deepEqual(frames[1], {
    type: 'note',
    lines: ['高層のビルやタワーで大きな揺れが', '長く続いた可能性があります'],
  });
  assert.deepEqual(frames.filter((frame) => frame.type === 'class').map((frame) => frame.level), ['3', '1']);
  const class3 = frames.find((frame) => frame.level === '3');
  assert.deepEqual(class3.names, ['登米市']);
  const class1 = frames.find((frame) => frame.level === '1');
  assert.ok(class1.names.includes('青森市'));
});

test('長周期を含まない震度情報では長周期フレームが空になる', () => {
  const xml = fs.readFileSync(path.join(__dirname, 'samples/32-35_06_03_240613_VXSE53.xml'), 'utf8');
  const data = createAtlasData('intensity', parseEarthquake(xml));

  assert.deepEqual(data.payload.longPeriodFrames, []);
});

test('長周期の観測点を正しい市区町村名に集約し、空港は観測点名で表示する', () => {
  const template = fs.readFileSync(path.join(__dirname, 'samples/78_01_01_240613_VXSE62.xml'), 'utf8');
  for (const [station, name, reading] of [
    ['山形市緑町', '山形市', 'やまがたし'],
    ['大阪堺市中区深井清水町', '堺市', 'さかいし'],
    ['札幌中央区北２条', '札幌市', 'さっぽろし'],
    ['東京千代田区大手町', '千代田区', 'ちよだく'],
    ['新千歳空港', '新千歳空港', 'しんちとせくうこう'],
  ]) {
    const xml = template.replace('<Name>登米市中田町</Name>', `<Name>${station}</Name>`);
    const result = createAtlasData('intensity', parseEarthquake(xml)).payload;
    assert.deepEqual(result.longPeriodFrames.find(frame => frame.level === '3').names, [name]);
    assert.equal(result.render.cityReadings[name], reading);
    assert.ok(result.render.cityMonoReadings[name].length);
    assert.ok(result.render.cityMonoReadings[station].length);
  }
});
