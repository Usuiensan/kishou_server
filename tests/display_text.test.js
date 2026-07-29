const assert = require('node:assert/strict');
const test = require('node:test');
const { toFullwidthDigits } = require('../lib/displayText');

test('表示本文の算用数字を全角化し、リッチテキストタグ内部は変更しない', () => {
  assert.equal(
    toFullwidthDigits('<color=#FF2800>震度5</color> 深さ10キロ indent=12em'),
    '<color=#FF2800>震度５</color> 深さ１０キロ indent=１２em',
  );
});
