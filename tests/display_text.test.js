const assert = require('node:assert/strict');
const test = require('node:test');
const { toFullwidthDigits, toUnityDisplayText } = require('../lib/displayText');

test('表示本文の算用数字を全角化し、リッチテキストタグ内部は変更しない', () => {
  assert.equal(
    toFullwidthDigits('<color=#FF2800>震度5</color> 深さ10キロ indent=12em'),
    '<color=#FF2800>震度５</color> 深さ１０キロ indent=１２em',
  );
});

test('Unity本文はルビなしの漢字表示へ戻す', () => {
  const text = toUnityDisplayText('<color=#FF2800>京都市 震度5</color><indent=12em>未登録地域</indent>');
  assert.equal(text, '<color=#FF2800>京都市 震度５</color><indent=12em>未登録地域</indent>');
  assert.doesNotMatch(text, /<(?:size|voffset|space)(?:=|>)/i);
});
