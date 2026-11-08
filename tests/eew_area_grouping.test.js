const assert = require('node:assert/strict');
const test = require('node:test');
const { groupEewAreasForDisplay } = require('../lib/utils/regions');
const { formatEarthquake } = require('../lib/formatter');

test('法則1: 2行14字に収まる場合はエリア表示のまま', () => {
  const result = groupEewAreasForDisplay(['東京', '千葉', '神奈川', '埼玉']);
  assert.deepEqual(result.tokens, ['東京', '千葉', '神奈川', '埼玉']);
  assert.equal(result.grouped, false);
  assert.equal(result.shrunk, false);
});

test('法則2: 収まらない場合は地方別表示へ切り替える', () => {
  const areas = ['青森', '岩手', '宮城', '秋田', '山形', '福島', '茨城', '栃木', '群馬', '埼玉', '千葉', '東京', '神奈川'];
  const result = groupEewAreasForDisplay(areas);
  assert.equal(result.grouped, true);
  assert.deepEqual(result.tokens, ['東北地方', '関東地方']);
  assert.equal(result.shrunk, false);
});

test('法則3: 地方内で1エリアだけならエリア表示のまま残す', () => {
  const areas = ['青森', '岩手', '宮城', '秋田', '山形', '福島', '茨城', '栃木', '群馬', '埼玉', '千葉', '東京', '神奈川', '高知'];
  const result = groupEewAreasForDisplay(areas);
  assert.equal(result.grouped, true);
  assert.ok(result.tokens.includes('高知'));
  assert.ok(!result.tokens.includes('四国地方'));
});

test('法則4: 新潟は甲信越から独立した地方として扱う', () => {
  const areas = ['新潟', '山梨', '長野', '茨城', '栃木', '群馬', '埼玉', '千葉', '東京', '神奈川', '沖縄'];
  const result = groupEewAreasForDisplay(areas);
  assert.equal(result.grouped, true);
  assert.ok(result.tokens.includes('新潟地方'));
  assert.ok(result.tokens.includes('甲信越地方'));
  // 島嶼部の沖縄も独立地方として地方トークンになる
  assert.ok(result.tokens.includes('沖縄地方'));
});

test('法則5: 地方化しても収まらない場合は縮小フラグが立つ', () => {
  const areas = ['北海道', '青森', '岩手', '宮城', '秋田', '山形', '福島', '茨城', '栃木', '群馬', '埼玉', '千葉', '東京', '神奈川', '新潟', '富山', '石川', '福井', '山梨', '長野', '岐阜', '静岡', '愛知', '三重', '滋賀', '京都', '大阪', '兵庫', '奈良', '和歌山', '鳥取', '島根', '岡山', '広島', '山口', '徳島', '香川', '愛媛', '高知', '福岡', '佐賀', '長崎', '熊本', '大分', '宮崎', '鹿児島', '沖縄'];
  const result = groupEewAreasForDisplay(areas);
  assert.equal(result.grouped, true);
  assert.equal(result.shrunk, true);
});

test('空・重複・地方不明のエリアを安全に扱う', () => {
  assert.deepEqual(groupEewAreasForDisplay([]), { tokens: [], grouped: false, shrunk: false });
  assert.deepEqual(groupEewAreasForDisplay(['東京', '東京']).tokens, ['東京']);
  const result = groupEewAreasForDisplay(['東京']);
  assert.deepEqual(result.tokens, ['東京']);
});

function eewEq(areas) {
  return {
    isEEW: true,
    isWarning: true,
    eventId: 'test-eew-grouping',
    headline: '震央付近で地震',
    eewAreas: areas,
    eewAdditionalAreas: [],
  };
}

test('formatter: テロップ本文は地方化され、eewAreasは未加工のまま返る', () => {
  const areas = ['青森', '岩手', '宮城', '秋田', '山形', '福島', '茨城', '栃木', '群馬', '埼玉', '千葉', '東京', '神奈川'];
  const formatted = formatEarthquake(eewEq(areas));
  assert.ok(formatted.lines[0].text.includes('<nobr>東北地方</nobr>'));
  assert.ok(formatted.lines[0].text.includes('<nobr>関東地方</nobr>'));
  assert.deepEqual(formatted.eewAreas, areas);
});

test('formatter: 収まる場合は従来どおりエリア名を並べる', () => {
  const formatted = formatEarthquake(eewEq(['東京', '千葉', '神奈川', '埼玉']));
  assert.ok(formatted.lines[0].text.includes('<nobr>東京</nobr>'));
  assert.ok(!formatted.lines[0].text.includes('関東地方'));
  assert.ok(!formatted.lines[0].text.includes('<size='));
});
