const test = require('node:test');
const assert = require('node:assert/strict');
const { createAtlasData } = require('../lib/atlasData');
const { tsunamiHeightData, tsunamiArrivalData, tsunamiForecastValues } = require('../telop/atlas-live');

// 津波予想行の確定ルール:
// - 高さデータまたは予想時刻データのどちらか (または両方) が入っていれば予想行を出す。
// - 片方しかなければ、ない方のスロットを全角スペースで埋める
//   (「高さ不明」「到達時刻不明」のような文言では埋めない)。
// - 両方とも入っていない区域は地名だけになるので、複数地名を1フレームに
//   集約する (描画側は hasHeight / hasArrival の両方 false で判定する)。
// - データ有無はフォールバック文言ではなく実データで判定する。
// - 注意報では警報級の高さ文言 (巨大・高い) は高さデータとして扱わない。

const frameOf = (forecast) => createAtlasData('tsunami', {
  eventId: 'forecast-rule-sample', infoType: '発表',
  tsunami: { groups: { majorTsunami: [], warning: [], advisory: [] }, forecasts: [forecast] },
}).payload.tsunamiFrames[0];

const advisory = (overrides) => ({
  area: { code: '100', name: '区域A' },
  category: { kind: '津波注意報', code: '62' },
  maxHeight: '', formattedArrivalTime: '',
  ...overrides,
});

test('注意報で高さも到達データもない区域はデータなしになる (集約対象)', () => {
  const frame = frameOf(advisory({ firstHeight: { condition: '', arrivalTime: '' } }));
  assert.equal(frame.hasHeight, false);
  assert.equal(frame.hasArrival, false);
  assert.equal(tsunamiHeightData(frame), false);
  assert.equal(tsunamiArrivalData(frame), false);
});

test('注意報は到達時刻だけでもデータありになり、高さ側をスペースで埋める', () => {
  const frame = frameOf(advisory({ formattedArrivalTime: '午後3時30分' }));
  assert.equal(frame.hasHeight, false);
  assert.equal(frame.hasArrival, true);
  assert.deepEqual(tsunamiForecastValues(frame), ['　', '午後3時30分']);
});

test('注意報は高さの実述だけでもデータありになり、到達側をスペースで埋める', () => {
  const frame = frameOf(advisory({ maxHeight: '1m' }));
  assert.equal(frame.hasHeight, true);
  assert.equal(frame.hasArrival, false);
  assert.deepEqual(tsunamiForecastValues(frame), ['1m', '　']);
});

test('注意報の高さに警報級の文言が来ても高さデータとして扱わない', () => {
  const frame = frameOf(advisory({ maxHeight: '巨大', formattedArrivalTime: '午後3時30分' }));
  assert.equal(frame.hasHeight, false);
  assert.deepEqual(tsunamiForecastValues(frame), ['　', '午後3時30分']);
});

test('警報は高さだけでも予想行を出し、到達側をスペースで埋める', () => {
  const frame = frameOf({
    area: { code: '200', name: '区域B' },
    category: { kind: '津波警報', code: '51' },
    maxHeight: '高い', formattedArrivalTime: '',
  });
  assert.equal(frame.hasHeight, true);
  assert.equal(frame.hasArrival, false);
  assert.deepEqual(tsunamiForecastValues(frame), ['高い', '　']);
});

test('高さ文言はカテゴリ対応にそろえる (警報の巨大→高い、大津波警報の高い→巨大)', () => {
  const warning = frameOf({
    area: { code: '200', name: '区域B' },
    category: { kind: '津波警報', code: '51' },
    maxHeight: '巨大', formattedArrivalTime: '午後3時30分',
  });
  assert.deepEqual(tsunamiForecastValues(warning), ['高い', '午後3時30分']);
  const major = frameOf({
    area: { code: '300', name: '区域C' },
    category: { kind: '大津波警報', code: '52' },
    maxHeight: '高い', formattedArrivalTime: '午後3時30分',
  });
  assert.deepEqual(tsunamiForecastValues(major), ['巨大', '午後3時30分']);
});

test('大津波警報は到達conditionだけでもデータありになり、高さ側をスペースで埋める', () => {
  const frame = frameOf({
    area: { code: '300', name: '区域C' },
    category: { kind: '大津波警報', code: '52' },
    maxHeight: '', formattedArrivalTime: '',
    firstHeight: { condition: '津波到達中と予測', arrivalTime: '' },
  });
  assert.equal(frame.hasHeight, false);
  assert.equal(frame.hasArrival, true);
  assert.deepEqual(tsunamiForecastValues(frame), ['　', '到達か']);
});

const payloadOf = (forecasts) => createAtlasData('tsunami', {
  eventId: 'overview-sample', infoType: '発表',
  tsunami: { groups: { majorTsunami: [], warning: [], advisory: [] }, forecasts },
}).payload;

test('地名一覧は種別順 (大津波→警報→注意報) に全区域をまとめ、詳細とは別に返る', () => {
  const payload = payloadOf([
    { area: { code: '100', name: '注意報区域' }, category: { kind: '津波注意報', code: '62' }, maxHeight: '', formattedArrivalTime: '' },
    { area: { code: '200', name: '警報区域' }, category: { kind: '津波警報', code: '51' }, maxHeight: '高い', formattedArrivalTime: '午後3時30分' },
    { area: { code: '210', name: '大津波区域' }, category: { kind: '大津波警報：追加', code: '52' }, maxHeight: '巨大', formattedArrivalTime: '午後3時00分' },
  ]);
  assert.deepEqual(payload.tsunamiOverviewFrames.map((frame) => [frame.level, frame.area]), [
    ['major', '大津波区域'], ['warning', '警報区域'], ['advisory', '注意報区域'],
  ]);
  assert.equal(payload.tsunamiOverviewFrames[0].label, '大津波警報');
  assert.equal(payload.tsunamiOverviewFrames[0].additional, true);
  assert.equal(payload.tsunamiOverviewFrames[1].additional, false);
  // 詳細側は従来どおり全区域分が返る (データ有無の振り分けは描画側)
  assert.equal(payload.tsunamiFrames.length, 3);
});

test('地名一覧は種別ごとに6件ずつフレームへ区切り、データのない区域も含める', () => {
  // 区域名は2字にし、文字数上限 (19字) が効かない条件で6件上限だけを検証する
  const forecasts = ['100', '101', '102', '110', '111', '120', '200'].map((code, index) => ({
    area: { code, name: `区${index + 1}` },
    category: { kind: '津波注意報', code: '62' }, maxHeight: '', formattedArrivalTime: '',
  }));
  const overview = payloadOf(forecasts).tsunamiOverviewFrames;
  assert.equal(overview.length, 2);
  assert.deepEqual(overview[0].areas, ['区1', '区2', '区3', '区4', '区5', '区6']);
  assert.deepEqual(overview[1].areas, ['区7']);
  assert.equal(overview[0].area, '区1　区2　区3　区4　区5　区6');
});

test('地名一覧は区域名と区切りの合計が19字を超えないよう区切る', () => {
  // 実フレームで切れた組み合わせ: 6件に満たなくても文字数で区切る
  // 19字は札拡大 (58px) 後の幾何: 1382.4px − (札322px+gap 22px) = 1038.4px → 19.9字
  const forecasts = [
    { area: { code: '760', name: '宮崎県' }, category: { kind: '津波注意報', code: '62' }, maxHeight: '', formattedArrivalTime: '' },
    { area: { code: '771', name: '種子島・屋久島地方' }, category: { kind: '津波注意報', code: '62' }, maxHeight: '', formattedArrivalTime: '' },
    { area: { code: '772', name: '奄美群島・トカラ列島' }, category: { kind: '津波注意報', code: '62' }, maxHeight: '', formattedArrivalTime: '' },
    { area: { code: '770', name: '鹿児島県東部' }, category: { kind: '津波注意報', code: '62' }, maxHeight: '', formattedArrivalTime: '' },
  ];
  const overview = payloadOf(forecasts).tsunamiOverviewFrames;
  // 宮崎県(3字)+区切り+種子島・屋久島地方(9字)=13字。次を足すと24字で上限超過
  assert.deepEqual(overview.map((frame) => frame.areas), [
    ['宮崎県', '種子島・屋久島地方'],
    ['奄美群島・トカラ列島', '鹿児島県東部'],
  ]);
  for (const frame of overview) assert.ok([...frame.area].length <= 19);
});

test('単一の区域名が19字を超える場合はその区域だけで1フレームにする', () => {
  const longName = 'あいうえおかきくけこさしすせそたちつてとな';
  assert.equal([...longName].length, 21);
  const overview = payloadOf([
    { area: { code: '100', name: longName }, category: { kind: '津波注意報', code: '62' }, maxHeight: '', formattedArrivalTime: '' },
    { area: { code: '101', name: '宮崎県' }, category: { kind: '津波注意報', code: '62' }, maxHeight: '', formattedArrivalTime: '' },
  ]).tsunamiOverviewFrames;
  assert.deepEqual(overview.map((frame) => frame.areas), [[longName], ['宮崎県']]);
  assert.equal(overview[0].area, longName);
});

test('津波フレームは区域名の読みを保持する', () => {
  const payload = payloadOf([
    { area: { code: '772', name: '奄美諸島・トカラ列島' }, category: { kind: '津波注意報', code: '62' }, maxHeight: '', formattedArrivalTime: '' },
    { area: { code: '200', name: '宮城県' }, category: { kind: '津波警報', code: '51' }, maxHeight: '高い', formattedArrivalTime: '' },
  ]);
  const detail = payload.tsunamiFrames.find((frame) => frame.area === '奄美諸島・トカラ列島');
  assert.equal(detail.readings['奄美諸島・トカラ列島'], 'あまみしょとうとかられっとう');
  const overview = payload.tsunamiOverviewFrames.find((frame) => frame.areas.includes('宮城県'));
  assert.equal(overview.readings['宮城県'], 'みやぎけん');
});

test('取消では地名一覧も詳細も空になる', () => {
  const payload = createAtlasData('tsunami', {
    eventId: 'overview-cancel', infoType: '取消',
    tsunami: { groups: { majorTsunami: [], warning: [], advisory: [] }, forecasts: [
      { area: { code: '200', name: '区域' }, category: { kind: '津波警報', code: '51' }, maxHeight: '高い', formattedArrivalTime: '' },
    ] },
  }).payload;
  assert.deepEqual(payload.tsunamiOverviewFrames, []);
  assert.deepEqual(payload.tsunamiFrames, []);
});

test('フラグのないフレームは文字列からデータ有無を復元する', () => {
  assert.deepEqual(
    tsunamiForecastValues({ level: 'warning', height: '3m', arrival: 'すぐ来る' }),
    ['3m', 'すぐ来る']);
  assert.deepEqual(
    tsunamiForecastValues({ level: 'major', height: '不明', arrival: '到達時刻不明' }),
    ['　', '　']);
  assert.equal(tsunamiHeightData({ level: 'advisory', height: '1m' }), true);
  assert.equal(tsunamiArrivalData({ level: 'advisory', height: '不明', arrival: '' }), false);
});
