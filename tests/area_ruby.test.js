const assert = require('node:assert/strict');
const test = require('node:test');
const { applyAreaRuby } = require('../lib/areaRuby');
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

test('読みが本文より長い地域名も本文位置を維持する補正を付ける', () => {
  const text = applyAreaRuby('熊本南区');
  assert.match(text, new RegExp(ruby('くまもとみなみ', '熊本南')));
  assert.match(text, new RegExp(ruby('く', '区')));
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
