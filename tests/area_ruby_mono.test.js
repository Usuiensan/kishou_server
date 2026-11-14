const test = require('node:test');
const assert = require('node:assert/strict');
const areaRuby = require('../data/area_ruby.json');
const areaRubyMono = require('../data/area_ruby_mono.json');
const { getAreaRubyMono } = require('../lib/areaRuby');

test('モノルビマスターは area_ruby.json の全エントリを収録し、連結が一致する', () => {
  const names = Object.keys(areaRuby);
  assert.ok(names.length > 0);
  assert.deepEqual(Object.keys(areaRubyMono).sort(), [...names].sort());
  for (const name of names) {
    const segments = areaRubyMono[name];
    assert.ok(Array.isArray(segments) && segments.length > 0, `${name}: セグメントがある`);
    for (const segment of segments) {
      assert.equal(segment.length, 2, `${name}: セグメントは [対象, 読み] の組`);
      assert.equal(typeof segment[0], 'string', `${name}: 対象は文字列`);
      assert.equal(typeof segment[1], 'string', `${name}: 読みは文字列`);
    }
    // 対象文字列の連結 = 名前、読みの連結 = area_ruby.json のグループ読みの連結
    assert.equal(segments.map(([base]) => base).join(''), name, `${name}: 対象の連結`);
    const expectedReading = areaRuby[name].map((group) => group[1]).join('');
    assert.equal(segments.map(([, reading]) => reading).join(''), expectedReading, `${name}: 読みの連結`);
  }
});

test('getAreaRubyMono は登録名のセグメントをそのまま返す', () => {
  assert.deepEqual(getAreaRubyMono('藤沢町'), [['藤', 'ふじ'], ['沢', 'さわ'], ['町', 'ちょう']]);
  assert.deepEqual(getAreaRubyMono('那須塩原市'), [['那', 'な'], ['須', 'す'], ['塩', 'しお'], ['原', 'ばら'], ['市', 'し']]);
});

test('getAreaRubyMono は未登録の複合名を登録名の連結で分割し、引けない名前は null', () => {
  // '石川県金沢市' 自体は未登録で、石川県 + 金沢市 の連結として引ける
  assert.equal(areaRuby['石川県金沢市'], undefined);
  assert.deepEqual(getAreaRubyMono('石川県金沢市'), [['石', 'いし'], ['川', 'かわ'], ['県', 'けん'], ['金', 'かな'], ['沢', 'ざわ'], ['市', 'し']]);
  assert.equal(getAreaRubyMono('未登録の地名'), null);
  assert.equal(getAreaRubyMono(''), null);
});

test('基本はモノルビ (1字セグメント) で、困難な熟語だけ複数文字セグメントになる', () => {
  for (const name of ['那須塩原市', '藤沢町', '釧路市', '登米市中田町', '北海道太平洋沿岸中部']) {
    assert.ok(getAreaRubyMono(name).every(([base]) => [...base].length === 1), `${name}: 全セグメントが1字`);
  }
  // 相模は1字ずつに割り当てられないため熟語グループとして残る
  const sagamihara = getAreaRubyMono('相模原市');
  assert.deepEqual(sagamihara[0], ['相模', 'さがみ']);
  assert.deepEqual(sagamihara.slice(1), [['原', 'はら'], ['市', 'し']]);
});
