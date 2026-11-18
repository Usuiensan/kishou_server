const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseTsunami } = require('../lib/parsers/tsunami');
const { parseEarthquake } = require('../lib/parsers/earthquake');
const { createAtlasData, createAtlasSnapshot, applyAtlasBulletin } = require('../lib/atlasData');

const sample = (name) => fs.readFileSync(path.join(__dirname, 'samples', name), 'utf8');

test('VTSE52の予報なし更新は既存予報の描画を保持し、観測だけ更新する', () => {
  const forecast = createAtlasData('tsunami', parseTsunami(sample('32-39_12_02_250206_VTSE41.xml')));
  const observation = createAtlasData('tsunami', parseTsunami(sample('32-39_12_05_250206_VTSE52.xml')));
  let state = applyAtlasBulletin(createAtlasSnapshot(), forecast, 1000);
  state = applyAtlasBulletin(state, observation, 2000);
  const row = state.layers.tsunami[0];
  assert.equal(row.payload.tsunamiForecasts.length, forecast.payload.tsunamiForecasts.length);
  assert.deepEqual(row.payload.render, forecast.payload.render);
  assert.deepEqual(row.payload.tsunamiOverviewFrames, forecast.payload.tsunamiOverviewFrames);
  assert.deepEqual(row.payload.tsunamiFrames, forecast.payload.tsunamiFrames);
  assert.deepEqual(row.payload.atlasII, forecast.payload.atlasII);
  assert.notDeepEqual(row.payload.tsunamiObservationFrames, forecast.payload.tsunamiObservationFrames);
  assert.deepEqual(row.payload.tsunamiChangeFrames, []);
});

test('津波取消は保持していた予報を消しnoticeを出す', () => {
  const bulletin = createAtlasData('tsunami', parseTsunami(sample('32-39_12_02_250206_VTSE41.xml')));
  const cancel = createAtlasData('tsunami', { eventId: bulletin.event.id, infoType: '取消', infoKind: bulletin.event.infoKind,
    reportDateTime: '2016-09-01T07:16:00+09:00' });
  let state = applyAtlasBulletin(createAtlasSnapshot(), bulletin, 1000);
  state = applyAtlasBulletin(state, cancel, 2000);
  assert.deepEqual(state.layers.tsunami[0].payload.tsunamiForecasts, []);
  assert.equal(state.notices[0].payload.notice, '津波警報・注意報は解除されました');
});

test('津波電文の通常・更新・取消をアトラス表示モデルへ変換する', () => {
  const first = createAtlasData('tsunami', parseTsunami(sample('32-39_11_02_250206_VTSE41.xml')));
  const update = createAtlasData('tsunami', parseTsunami(sample('32-39_11_06_250206_VTSE41.xml')));
  const cancel = createAtlasData('tsunami', parseTsunami(sample('38-39_03_01_210805_VTSE41.xml')));

  assert.equal(first.action, 'upsert');
  assert.ok(first.payload.render.major.length > 0);
  assert.equal(first.payload.atlasII.length, 66);
  assert.ok(first.payload.atlasII.some(level => level === 3));
  assert.equal(update.action, 'upsert');
  assert.notDeepEqual(update.payload.render.major, first.payload.render.major);
  assert.ok(first.payload.tsunamiFrames.length > 0);
  assert.deepEqual(first.payload.tsunamiFrames[0], {
    hasHeight: true, hasArrival: true,
    level: 'major', label: '大津波警報', additional: false,
    area: '岩手県', height: '巨大', arrival: '到達か',
    readings: { '岩手県': 'いわてけん' },
    monoReadings: { '岩手県': [['岩', 'いわ'], ['手', 'て'], ['県', 'けん']] },
  });
  assert.equal(cancel.action, 'cancel');
  assert.match(cancel.payload.lines[0], /解除/);
  assert.equal(cancel.payload.notice, '津波警報・注意報は解除されました');
  assert.deepEqual(cancel.payload.render, { major: [], warning: [], advisory: [] });
});

test('津波は取消の後に新しいReportDateTimeで再投入できる', () => {
  const base = parseTsunami(sample('32-39_11_02_250206_VTSE41.xml'));
  const first = createAtlasData('tsunami', { ...base, reportDateTime: '2026-11-13T11:00:00.000Z' });
  const cancel = createAtlasData('tsunami', {
    eventId: base.eventId, infoType: '取消', infoKind: base.infoKind,
    reportDateTime: '2026-11-13T11:01:00.000Z', serial: null,
  });
  const second = createAtlasData('tsunami', { ...base, reportDateTime: '2026-11-13T11:02:00.000Z' });
  let state = applyAtlasBulletin(createAtlasSnapshot(), first, 1000);
  assert.equal(state.layers.tsunami[0].action, 'upsert');
  state = applyAtlasBulletin(state, cancel, 2000);
  assert.equal(state.layers.tsunami[0].action, 'cancel');
  state = applyAtlasBulletin(state, second, 3000);
  assert.equal(state.layers.tsunami.length, 1);
  assert.equal(state.layers.tsunami[0].action, 'upsert');
});

test('津波の警報レベル低下だけを前号との差分として保持する', () => {
  const first = createAtlasData('tsunami', {
    eventId: 'downgrade', infoType: '発表', reportDateTime: '2026-11-13T11:00:00Z', serial: 1,
    tsunami: { groups: { majorTsunami: [], warning: [], advisory: [] }, forecasts: [
      { area: { code: '101', name: '北海道太平洋沿岸中部' }, category: { kind: '津波警報', code: '51' }, maxHeight: '', formattedArrivalTime: '' },
      { area: { code: '201', name: '青森県太平洋沿岸' }, category: { kind: '津波警報', code: '51' }, maxHeight: '', formattedArrivalTime: '' },
      { area: { code: '300', name: '茨城県' }, category: { kind: '津波注意報', code: '62' }, maxHeight: '', formattedArrivalTime: '' },
    ] },
  });
  assert.deepEqual(first.payload.tsunamiChangeFrames, []);

  const second = createAtlasData('tsunami', {
    eventId: 'downgrade', infoType: '発表', reportDateTime: '2026-11-13T11:01:00Z', serial: 2,
    tsunami: { groups: { majorTsunami: [], warning: [], advisory: [] }, forecasts: [
      { area: { code: '101', name: '北海道太平洋沿岸中部' }, category: { kind: '津波注意報', code: '62' }, maxHeight: '', formattedArrivalTime: '' },
      { area: { code: '201', name: '青森県太平洋沿岸' }, category: { kind: '津波警報', code: '51' }, maxHeight: '', formattedArrivalTime: '' },
      { area: { code: '300', name: '茨城県' }, category: { kind: '津波警報', code: '51' }, maxHeight: '', formattedArrivalTime: '' },
      { area: { code: '310', name: '千葉県九十九里・外房' }, category: { kind: '津波注意報', code: '62' }, maxHeight: '', formattedArrivalTime: '' },
    ] },
  });
  let state = applyAtlasBulletin(createAtlasSnapshot(), first, 1000);
  state = applyAtlasBulletin(state, second, 2000);
  assert.deepEqual(state.layers.tsunami[0].payload.tsunamiChangeFrames.map((frame) => [
    frame.oldLevel, frame.newLevel, frame.area,
  ]), [['warning', 'advisory', '北海道太平洋沿岸中部']]);
  assert.equal(state.layers.tsunami[0].payload.tsunamiChangeFrames[0].headline, '津波警報が津波注意報に変更');

  const unchanged = applyAtlasBulletin(state, createAtlasData('tsunami', {
    eventId: 'downgrade', infoType: '発表', reportDateTime: '2026-11-13T11:02:00Z', serial: 3,
    tsunami: { groups: { majorTsunami: [], warning: [], advisory: [] }, forecasts: [
      { area: { code: '101', name: '北海道太平洋沿岸中部' }, category: { kind: '津波注意報', code: '62' }, maxHeight: '', formattedArrivalTime: '' },
      { area: { code: '201', name: '青森県太平洋沿岸' }, category: { kind: '津波警報', code: '51' }, maxHeight: '', formattedArrivalTime: '' },
    ] },
  }), 3000);
  assert.deepEqual(unchanged.layers.tsunami[0].payload.tsunamiChangeFrames, []);
});

test('注意報・警報・大津波警報の予想到達を上部テロップ用に保持する', () => {
  const tsunami = createAtlasData('tsunami', {
    eventId: 'warning-sample', infoType: '発表', tsunami: { groups: { majorTsunami: [], warning: ['石川県能登'], advisory: [] }, forecasts: [
      { area: { code: '360', name: '石川県能登' }, category: { kind: '津波警報：追加', code: '51' }, maxHeight: '3m', formattedArrivalTime: '', firstHeight: { condition: 'すでに津波到達と予測' } },
      { area: { code: '101', name: '北海道太平洋沿岸中部' }, category: { kind: '津波警報', code: '51' }, maxHeight: '1m', formattedArrivalTime: '午後7時30分' },
    ] },
  });
  assert.deepEqual(tsunami.payload.tsunamiFrames, [
    { hasHeight: true, hasArrival: true, level: 'warning', label: '津波警報', additional: true, area: '石川県能登', height: '3m', arrival: 'すでに到達と予測', readings: { '石川県能登': 'いしかわけん のと' }, monoReadings: { '石川県能登': [['石', 'いし'], ['川', 'かわ'], ['県', 'けん'], ['能', 'の'], ['登', 'と']] } },
    { hasHeight: true, hasArrival: true, level: 'warning', label: '津波警報', additional: false, area: '北海道太平洋沿岸中部', height: '1m', arrival: '午後7時30分', readings: { '北海道太平洋沿岸中部': 'ほっかいどう たいへいようえんがんちゅうぶ' }, monoReadings: { '北海道太平洋沿岸中部': [['北', 'ほっ'], ['海', 'かい'], ['道', 'どう'], ['太', 'たい'], ['平', 'へい'], ['洋', 'よう'], ['沿', 'えん'], ['岸', 'がん'], ['中', 'ちゅう'], ['部', 'ぶ']] } },
  ]);
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
  assert.equal(first.payload.atlasII.areas.find(area => area.areaId === 622).areaFlags & 4, 4);
  assert.equal(first.payload.atlasII.areas.find(area => area.areaId === 622).scalePair & 15, 6);
  assert.equal(first.payload.atlasII.areas.length, 9);
  assert.equal(update.action, 'upsert');
  assert.notDeepEqual(update.payload.render.areas, first.payload.render.areas);
  assert.equal(cancel.action, 'cancel');
  assert.equal(cancel.payload.atlasII.eventFlags & 1, 1);
  assert.deepEqual(cancel.payload.atlasII.areas, []);
});

test('EEW取消は同一イベントのEEWだけを除き、同イベントIDの津波を保持する', () => {
  const tsunami = createAtlasData('tsunami', { ...parseTsunami(sample('32-39_11_02_250206_VTSE41.xml')), eventId: '20240417231454' });
  const eew = createAtlasData('eew', parseEarthquake(sample('37_01_01_240613_VXSE43.xml')));
  const cancel = createAtlasData('eew', parseEarthquake(sample('37_01_03_240613_VXSE43.xml')));
  let state = applyAtlasBulletin(createAtlasSnapshot(), tsunami, 1000);
  state = applyAtlasBulletin(state, eew, 1001);
  const followup = createAtlasData('eew', parseEarthquake(sample('37_01_02_240613_VXSE43.xml')));
  state = applyAtlasBulletin(state, followup, 1002);
  assert.equal(state.layers.eew[0].payload.atlasII.eventFlags & 8, 8);
  assert.ok(state.layers.eew[0].payload.atlasII.areas.some(area => area.areaFlags & 8));
  const repeated = applyAtlasBulletin(state, followup, 1002.5);
  assert.deepEqual(repeated.layers.eew[0].payload.atlasII.areas, state.layers.eew[0].payload.atlasII.areas);
  state = applyAtlasBulletin(state, cancel, 1003);
  assert.equal(state.layers.eew[0].action, 'cancel');
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

test('震度情報の読みマップは細分区域名と長周期観測点名も含む', () => {
  const parsed = parseEarthquake(sample('78_01_01_240613_VXSE62.xml'));
  const intensity = createAtlasData('intensity', parsed);
  const readings = intensity.payload.render.cityReadings;
  // 細分区域名 (groups) の全名に読みがある
  const groupNames = [...new Set(Object.values(intensity.payload.render.groups || {}).flat())];
  assert.ok(groupNames.length > 0);
  assert.deepEqual(groupNames.filter((name) => !readings[name]), []);
  // 長周期の観測点名にも読みがある (自治体名+地区名の複合名)
  assert.equal(readings['登米市中田町'], 'とめしなかだちょう');
  assert.equal(readings['青森市花園'], 'あおもりしはなぞの');
  assert.equal(readings['奥州市水沢大鐘町'], 'おうしゅうしみずさわおおがねちょう');
  // モノルビのセグメントマップも同じ名前集合で用意される
  const mono = intensity.payload.render.cityMonoReadings;
  assert.deepEqual(groupNames.filter((name) => !mono[name]), []);
  assert.deepEqual(mono['登米市中田町'], [['登', 'と'], ['米', 'め'], ['市', 'し'], ['中', 'なか'], ['田', 'だ'], ['町', 'ちょう']]);
  assert.deepEqual(mono['奥州市水沢大鐘町'], [['奥', 'おう'], ['州', 'しゅう'], ['市', 'し'], ['水', 'みず'], ['沢', 'さわ'], ['大', 'おお'], ['鐘', 'がね'], ['町', 'ちょう']]);
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
    { lines: ['震源は静岡県西部', '深さ40キロ　マグニチュード5.7'], hypocenterName: '静岡県西部', hypocenterReading: 'しずおかけんせいぶ' },
  ]);

  const noTsunami = createAtlasData('intensity', { ...bulletin, tsunamiWorry: false, comment: '津波の心配はありません。' });
  assert.equal(noTsunami.payload.summaryFrames[0].lines[1], '津波の心配はありません');
  const announced = createAtlasData('intensity', { ...bulletin, tsunamiWorry: true });
  assert.equal(announced.payload.summaryFrames[0].lines[1], '沿岸部では念のため津波に注意');
  const laterReport = createAtlasData('intensity', { ...bulletin, infoKind: '地震情報', tsunamiWorry: true });
  assert.equal(laterReport.payload.summaryFrames[0].lines[1], '津波情報が発表されています');
});

test('震源フレームはマスターにある地名だけ読みを持つ', () => {
  const base = {
    eventId: 'frame-ruby', infoType: '発表', infoKind: '震度速報', originTimeFormatted: '午前1時4分',
    intensity: { maxInt: '5+' }, earthquake: { hypocenter: { name: '駿河湾' } },
  };
  const known = createAtlasData('intensity', base);
  assert.equal(known.payload.summaryFrames[1].hypocenterReading, 'するがわん');
  const unknown = createAtlasData('intensity', { ...base, earthquake: { hypocenter: { name: '未知の震源' } } });
  assert.equal(unknown.payload.summaryFrames[1].hypocenterReading, '');
});

test('津波一覧の行割りは訓練と追加で予算を狭める', () => {
  // 予算は実レイアウト計測 (2026-11-19) による: 通常28字は収まるが、
  // 「追加」表示か【訓練】バッジが付くと28字では右端が切れる。
  // 追加・訓練は各-4字、両方では-8字 (20字) まで狭めると収まる。
  const zones = require('../protocol/atlas-ii-tsunami-areas-v1.json').zones;
  const codeOf = Object.fromEntries(zones.map((z) => [z.name, String(z.code)]));
  const areas = ['北海道太平洋沿岸東部', '北海道太平洋沿岸中部', '北海道太平洋沿岸西部',
    '青森県太平洋沿岸', '新潟県上中下越', '東京湾内湾', '長崎県西方', '陸奥湾', '佐渡', '宮城県'];
  const mk = (extra, kind = '津波警報') => createAtlasData('tsunami', {
    eventId: 'BUDGET', infoType: '発表', reportDateTime: '2026-01-01T00:00:00+09:00', ...extra,
    tsunami: { groups: { majorTsunami: [], warning: [], advisory: [] },
      forecasts: areas.map((name) => ({ area: { name, code: codeOf[name] }, category: { code: '51', kind } })) },
  });
  const lengths = (data) => data.payload.tsunamiOverviewFrames.map((f) => [...f.area].length);
  const plain = lengths(mk({}));
  assert.ok(Math.max(...plain) <= 28 && Math.max(...plain) > 24, `通常: ${plain}`);
  const additional = lengths(mk({}, '津波警報追加'));
  assert.ok(Math.max(...additional) <= 24, `追加: ${additional}`);
  const training = lengths(mk({ training: true }));
  assert.ok(Math.max(...training) <= 24, `訓練: ${training}`);
  const both = lengths(mk({ training: true }, '津波警報追加'));
  assert.ok(Math.max(...both) <= 20, `訓練+追加: ${both}`);
});
