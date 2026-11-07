const assert = require('node:assert/strict');
const test = require('node:test');
const { applyAreaRuby, getAreaReading } = require('../lib/areaRuby');
const { toUnityDisplayText } = require('../lib/displayText');
const { normalizeStatus } = require('../lib/nervSource');

const ruby = (reading, base) => {
  const rubyWidth = reading.length * 0.5;
  const centerOffset = (base.length - rubyWidth) / 2;
  const rewind = centerOffset + rubyWidth;
  const em = (value) => `${Math.round(value * 1000) / 1000}em`;
  return `<space=${em(centerOffset)}><size=50%><voffset=0.7em>${reading}</voffset></size><space=${em(-rewind)}>${base}`;
};

test('京都市を漢字グループ単位でルビ化する', () => {
  assert.equal(applyAreaRuby('京都市'), `${ruby('きょうと', '京都')}${ruby('し', '市')}`);
});

test('JMA地域名・都道府県・市町村をルビ化する', () => {
  const text = applyAreaRuby('関東 東京都 八代市');
  assert.match(text, new RegExp(ruby('かんとう', '関東')));
  assert.match(text, new RegExp(ruby('とうきょう', '東京')));
  assert.match(text, new RegExp(`${ruby('やつしろ', '八代')}${ruby('し', '市')}`));
});

test('都道府県付き宇城市を分割して正しくルビ化する', () => {
  assert.equal(getAreaReading('熊本県宇城市'), 'くまもとけん うきし');
  assert.match(applyAreaRuby('熊本県宇城市'), /うき/);
});

test('読みが本文より長い地域名も本文位置を維持する補正を付ける', () => {
  const text = applyAreaRuby('熊本南区');
  assert.match(text, new RegExp(ruby('くまもとみなみ', '熊本南')));
  assert.match(text, new RegExp(ruby('く', '区')));
});

test('都道府県名を冠した地域名の読みを半角スペースで区切る', () => {
  const cases = [
    ['熊本西区', 'くまもと にしく'],
    ['熊本中央区', 'くまもと ちゅうおうく'],
    ['福岡博多区', 'ふくおか はかたく'],
    ['大阪堺市西区', 'おおさか さかいしにしく'],
    ['京都右京区', 'きょうと うきょうく'],
    ['熊本県天草・芦北', 'くまもとけん あまくさ・あしきた'],
  ];
  for (const [area, expected] of cases) {
    assert.equal(getAreaReading(area), expected, area);
  }
});

test('市名を冠した独立地域名の読みを半角スペースで区切る', () => {
  assert.equal(getAreaReading('薩摩川内市甑島'), 'さつませんだいし こしきしま');
  assert.equal(getAreaReading('佐世保市宇久島'), 'させぼし うくじま');
  assert.equal(getAreaReading('薩摩川内市'), 'さつませんだいし');
});

test('既存のルビ単位を維持した地名にも読みの区切りを反映する', () => {
  assert.equal(getAreaReading('熊本南区'), 'くまもと みなみく');
  assert.equal(getAreaReading('大阪堺市西区'), 'おおさか さかいしにしく');
});

test('都道府県名と同じ語幹の単独市町村には区切りを入れない', () => {
  assert.equal(getAreaReading('京都市'), 'きょうとし');
  assert.equal(getAreaReading('岩手町'), 'いわてまち');
  assert.equal(getAreaReading('福島町'), 'ふくしまちょう');
  assert.equal(getAreaReading('愛知江南市'), 'あいち こうなんし');
  assert.equal(getAreaReading('福島伊達市'), 'ふくしま だてし');
});

test('長い地域名を優先し、タグ属性と未登録名を変更しない', () => {
  const text = applyAreaRuby('<color=#FF2800>京都市</color><indent=12em>未登録地域</indent>');
  assert.match(text, new RegExp(`<color=#FF2800>${ruby('きょうと', '京都')}${ruby('し', '市')}</color>`));
  assert.match(text, /<indent=12em>未登録地域<\/indent>/);
  assert.doesNotMatch(text, /<color=#ＦＦ２８００|indent=１２em/);
});

test('Unity本文の最終変換ではルビを付けない', () => {
  const text = toUnityDisplayText('<color=#FF2800>京都市</color><indent=12em>未登録地域</indent>');
  assert.equal(text, '<color=#FF2800>京都市</color><indent=12em>未登録地域</indent>');
  assert.doesNotMatch(text, /<(?:size|voffset|space)(?:=|>)/i);
});

test('NERV本文はルビなしで表示する', () => {
  const item = normalizeStatus({
    id: 'ruby-test',
    content: '<p>京都市で発表</p> 未登録地域',
    url: 'https://unnerv.jp/@UN_NERV/ruby-test',
    created_at: '2026-01-01T00:00:00Z',
    tags: [],
  });
  assert.equal(item.lines[0].text, '京都市で発表 未登録地域');
  assert.doesNotMatch(item.lines[0].text, /<(?:size|voffset|space)(?:=|>)/i);
  assert.match(item.lines[0].text, /未登録地域/);
});

test('名古屋市の区の読みを半角スペースで区切る', () => {
  const cases = [
    ['名古屋千種区', 'なごや ちくさく'],
    ['名古屋東区', 'なごや ひがしく'],
    ['名古屋北区', 'なごや きたく'],
    ['名古屋西区', 'なごや にしく'],
    ['名古屋中村区', 'なごや なかむらく'],
    ['名古屋中区', 'なごや なかく'],
    ['名古屋昭和区', 'なごや しょうわく'],
    ['名古屋瑞穂区', 'なごや みずほく'],
    ['名古屋熱田区', 'なごや あつたく'],
    ['名古屋中川区', 'なごや なかがわく'],
    ['名古屋港区', 'なごや みなとく'],
    ['名古屋南区', 'なごや みなみく'],
    ['名古屋守山区', 'なごや もりやまく'],
    ['名古屋緑区', 'なごや みどりく'],
    ['名古屋名東区', 'なごや めいとうく'],
    ['名古屋天白区', 'なごや てんぱくく'],
  ];
  for (const [area, expected] of cases) {
    assert.equal(getAreaReading(area), expected, area);
  }
  // 北名古屋市は名古屋市の区ではないので対象外
  assert.equal(getAreaReading('北名古屋市'), 'きたなごやし');
});
