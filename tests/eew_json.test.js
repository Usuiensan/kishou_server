const test = require('node:test');
const assert = require('node:assert/strict');
const { mapAxisEew, mapWolfxEew, mapProjectBsEew, mapEewJson, normalizeEewMessage, parseEbiAreas } = require('../lib/parsers/eewJson');
const { createAtlasData, createAtlasSnapshot } = require('../lib/atlasData');
const { ingestEewJson } = require('../tools/atlas_ingest');

const axisWarning = {
  Title: '緊急地震速報（警報）',
  EventID: 20261112120000,
  Serial: 3,
  ReportDateTime: '2026-11-12T12:00:10+09:00',
  OriginDateTime: '2026-11-12T12:00:00+09:00',
  Magnitude: '6.1',
  Intensity: '5弱',
  Hypocenter: { Name: '駿河湾', Depth: '10km', Coordinate: [138.5, 34.8] },
  Flag: { is_final: false, is_cancel: false, is_training: false },
  Forecast: [
    { Code: 441, Name: '静岡県東部', Intensity: { From: '5弱', To: '5弱' } },
    { Code: 442, Name: '静岡県中部', Intensity: { From: '4', To: '5弱' } },
  ],
};

const wolfxWarning = {
  type: 'jma_eew',
  EventID: 20261112120000,
  Serial: 2,
  AnnouncedTime: '2026/11/12 12:00:05',
  OriginTime: '2026/11/12 12:00:00',
  Title: '緊急地震速報(警報)',
  isWarn: true,
  isCancel: false,
  isFinal: false,
  isTraining: false,
  Hypocenter: '駿河湾',
  Latitude: 34.8,
  Longitude: 138.5,
  Depth: 10,
  Magnitude: 6.1,
  MaxIntensity: '5弱',
  OriginalText: 'EEW EBI 441 S4545 120030 10 442 S4045 120040 00 ECI 9999=',
};

const projectBsWarning = {
  type: 'jma_eew',
  eventID: 20261112120000,
  serial: 1,
  issue: { time: '2026/11/12 12:00:03' },
  originTime: '2026/11/12 12:00:00',
  hypocenter: { name: '駿河湾', magnitude: 6.0, location: { lat: 34.8, lng: 138.5, depth: 10 }, isEstimate: false },
  maxIntensity: '5弱',
  isWarn: true,
  isCancel: false,
  isFinal: false,
  originalTelegram: '37 00 00 EBI 441 S4545 120030 10 9999=',
};

test('Axisの警報JSONを内部bulletinへ変換し、A2区域になる', () => {
  const bulletin = mapAxisEew(axisWarning);
  assert.equal(bulletin.eventId, '20261112120000');
  assert.equal(bulletin.isWarning, true);
  assert.equal(bulletin.headline, '駿河湾で地震 強い揺れに警戒');
  assert.equal(bulletin.earthquake.hypocenter.coordinate, '+34.8+138.5-10000/');
  assert.deepEqual(bulletin.eewForecastAreas.map(({ scaleFrom, scaleTo }) => [scaleFrom, scaleTo]), [['45', '45'], ['40', '45']]);
  assert.deepEqual(bulletin.eewAreas, ['静岡']);
  assert.equal(bulletin.eewAreaDetails.length, 2);
  const atlas = createAtlasData('eew', bulletin);
  assert.deepEqual(atlas.payload.atlasII.areas.map(({ areaId }) => areaId), [441, 442]);
  assert.ok(atlas.payload.atlasII.areas.every(({ areaFlags }) => areaFlags & 4));
  assert.equal(atlas.payload.render.hypocenterName, '駿河湾');
});

test('各JSONマッパーは最終報フラグを伝播し、明示的なtrue以外を最終報にしない', () => {
  assert.equal(mapAxisEew({ ...axisWarning, Flag: { ...axisWarning.Flag, is_final: true } }).isFinal, true);
  assert.equal(mapAxisEew(axisWarning).isFinal, false);
  assert.equal(mapWolfxEew({ ...wolfxWarning, isFinal: true }).isFinal, true);
  assert.equal(mapWolfxEew(wolfxWarning).isFinal, false);
  assert.equal(mapProjectBsEew({ ...projectBsWarning, isFinal: true }).isFinal, true);
  assert.equal(mapProjectBsEew(projectBsWarning).isFinal, false);
});

test('Axisの訓練報は取り込まず、取消報は取消になる', () => {
  assert.equal(mapAxisEew({ ...axisWarning, Flag: { is_training: true } }), null);
  const cancel = mapAxisEew({ ...axisWarning, Flag: { is_cancel: true } });
  assert.equal(cancel.infoType, '取消');
});

test('Wolfxのjma_eewを変換し、EBIから区域・到達時刻・警報フラグを取る', () => {
  const bulletin = mapWolfxEew(wolfxWarning);
  assert.equal(bulletin.eventId, '20261112120000');
  assert.equal(bulletin.reportDateTime, '2026-11-12 12:00:05');
  assert.equal(bulletin.eewForecastAreas.length, 2);
  const [first, second] = bulletin.eewForecastAreas;
  assert.deepEqual([first.name, first.scaleFrom, first.scaleTo, first.kindCode], ['静岡県東部', '45', '45', 10]);
  assert.equal(first.arrivalTime, '2026-11-12T12:00:30+09:00');
  assert.deepEqual(bulletin.eewAreaDetails.map(({ name }) => name), ['静岡県東部']);
  assert.equal(second.kindCode, 19);
  const atlas = createAtlasData('eew', bulletin);
  assert.deepEqual(atlas.payload.atlasII.areas.map(({ areaId }) => areaId), [441, 442]);
});

test('WolfxのWarnAreaがあればEBIより優先して区域にする', () => {
  const bulletin = mapWolfxEew({
    ...wolfxWarning,
    OriginalText: '',
    WarnArea: [
      { Chiiki: '静岡県東部', Shindo1: '5弱', Shindo2: '5弱', Time: '120030', Type: '警報', Arrive: '未到達' },
      { Chiiki: '静岡県中部', Shindo1: '5弱', Shindo2: '4', Time: '//////', Type: '警報', Arrive: '既に到達と予測' },
    ],
  });
  assert.equal(bulletin.eewForecastAreas.length, 2);
  const [first, second] = bulletin.eewForecastAreas;
  assert.deepEqual([first.scaleFrom, first.scaleTo, first.kindCode, first.arrivalTime],
    ['45', '45', 10, '2026-11-12T12:00:30+09:00']);
  assert.deepEqual([second.scaleFrom, second.scaleTo, second.kindCode, second.arrivalTime],
    ['40', '45', 11, null]);
  assert.deepEqual(bulletin.eewAreaDetails.map(({ name }) => name), ['静岡県東部', '静岡県中部']);
});

test('WolfxのeewWarningAreasは警報タイプの府県だけになる', () => {
  const bulletin = mapWolfxEew({
    ...wolfxWarning,
    OriginalText: '',
    WarnArea: [
      { Chiiki: '静岡県東部', Shindo1: '5弱', Shindo2: '5弱', Time: '120030', Type: '警報', Arrive: '未到達' },
      { Chiiki: '神奈川県東部', Shindo1: '4', Shindo2: '4', Time: '120100', Type: '予報', Arrive: '未到達' },
    ],
  });
  assert.deepEqual(bulletin.eewAreas, ['静岡', '神奈川']);
  assert.deepEqual(bulletin.eewWarningAreas, ['静岡']);
});

test('Wolfxの訓練報と他種別は取り込まない', () => {
  assert.equal(mapWolfxEew({ ...wolfxWarning, isTraining: true }), null);
  assert.equal(mapWolfxEew({ ...wolfxWarning, type: 'cenc_eew' }), null);
  assert.equal(mapWolfxEew({ type: 'heartbeat' }), null);
});

test('ProjectBSのjma_eewを変換する', () => {
  const bulletin = mapProjectBsEew(projectBsWarning);
  assert.equal(bulletin.eventId, '20261112120000');
  assert.equal(bulletin.isWarning, true);
  assert.equal(bulletin.eewForecastAreas.length, 1);
  assert.equal(bulletin.eewForecastAreas[0].name, '静岡県東部');
  const training = { ...projectBsWarning, originalTelegram: '37 00 30 EBI 441 S4545 120030 10 9999=' };
  assert.equal(mapProjectBsEew(training), null);
});

test('EBIの震度コード99は下限と同じとして扱う', () => {
  const areas = parseEbiAreas('EBI 441 S9945 120030 10 9999=', '2026/11/12 12:00:00');
  assert.equal(areas.length, 1);
  assert.equal(areas[0].scaleTo, '45');
  assert.equal(areas[0].scaleFrom, '45');
});

test('ingestEewJsonは3源を受け付け、フィルタ対象は状態を変えない', () => {
  const snapshot = createAtlasSnapshot();
  const accepted = ingestEewJson(snapshot, 'axis', axisWarning);
  assert.deepEqual(accepted.kinds, ['eew']);
  assert.equal(accepted.state.layers.eew.length, 1);
  assert.equal(accepted.state.layers.eew[0].event.id, '20261112120000');
  const filtered = ingestEewJson(snapshot, 'wolfx', { ...wolfxWarning, isTraining: true });
  assert.equal(filtered.filtered, true);
  assert.equal(filtered.state, snapshot);
  assert.equal(mapEewJson('unknown', {}), null);
});

test('normalizeEewMessageは源ごとに振り分ける', () => {
  assert.deepEqual(normalizeEewMessage('axis', { channel: 'eew', message: axisWarning }),
    { endpoint: 'eew', source: 'axis', data: axisWarning });
  assert.deepEqual(normalizeEewMessage('axis', { channel: 'jmx-seismology', message: '<Report/>' }),
    { endpoint: 'jma', xml: '<Report/>' });
  assert.equal(normalizeEewMessage('axis', { channel: 'jmx-meteorology', message: 'x' }), null);
  assert.deepEqual(normalizeEewMessage('wolfx', { type: 'heartbeat' }), { heartbeat: true });
  assert.deepEqual(normalizeEewMessage('wolfx', wolfxWarning), { endpoint: 'eew', source: 'wolfx', data: wolfxWarning });
  assert.equal(normalizeEewMessage('projectbs', { type: 'cenc_eew' }), null);
  assert.deepEqual(normalizeEewMessage('projectbs', projectBsWarning), { endpoint: 'eew', source: 'projectbs', data: projectBsWarning });
});

test('仮定震源要素 (PLUM 法のみ) は震源名・座標を持たない bulletin になる', () => {
  // Wolfx: Hypocenter が「仮定震源要素」そのもの
  const wolfx = mapWolfxEew({ ...wolfxWarning, Hypocenter: '仮定震源要素', Latitude: 34.8, Longitude: 138.5, Depth: 10, Magnitude: 1.0 });
  assert.equal(wolfx.earthquake.hypocenter.assumed, true);
  assert.equal(wolfx.earthquake.hypocenter.name, '');
  assert.equal(wolfx.earthquake.hypocenter.coordinate, '');
  assert.equal(wolfx.headline, '強い揺れに警戒');

  // Axis: Condition が「仮定震源要素」
  const axis = mapAxisEew({ ...axisWarning, Condition: '仮定震源要素' });
  assert.equal(axis.earthquake.hypocenter.assumed, true);
  assert.equal(axis.earthquake.hypocenter.name, '');
  assert.equal(axis.earthquake.hypocenter.coordinate, '');

  // ProjectBS: hypocenter.name が「仮定震源要素」
  const pbs = mapProjectBsEew({ ...projectBsWarning, hypocenter: { ...projectBsWarning.hypocenter, name: '仮定震源要素' } });
  assert.equal(pbs.earthquake.hypocenter.assumed, true);
  assert.equal(pbs.earthquake.hypocenter.coordinate, '');

  // render では ×印の材料 (緯度経度) と震源名・M・深さが全て落ちる
  const data = createAtlasData('eew', wolfx);
  assert.equal(data.payload.render.latitude, null);
  assert.equal(data.payload.render.longitude, null);
  assert.equal(data.payload.render.hypocenterName, '');
  assert.equal(data.payload.render.magnitude, null);
  assert.equal(data.payload.render.depthKm, null);

  // 通常の震源では assumed が付かず、座標も保持される (回帰防止)
  const normal = mapWolfxEew(wolfxWarning);
  assert.equal(normal.earthquake.hypocenter.assumed, undefined);
  const normalData = createAtlasData('eew', normal);
  assert.equal(normalData.payload.render.latitude, 34.8);
  assert.equal(normalData.payload.render.hypocenterName, '駿河湾');
});
