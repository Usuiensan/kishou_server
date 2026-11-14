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
