const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('横型EEWは地域名を14単位で折り返し、34pxのまま表示する', () => {
  const html = fs.readFileSync(path.join(__dirname, '../telop/atlas-1080-v8.html'), 'utf8');
  const source = html.match(/function wrapTokens[\s\S]*?(?=\/\* ========= ミニマップ ========= \*\/)/)[0];
  const context = vm.createContext({});
  const result = vm.runInContext(`${source}\nJSON.stringify({ lines: fitLines(Array.from({ length: 15 }, (_, i) => String(i).padStart(2, '0'))), size: AREAS_FONT_SIZE })`, context);
  const { lines, size } = JSON.parse(result);

  assert.equal(size, 34);
  assert.equal(lines.length, 3);
  assert.deepEqual(lines.map(line => [...line].length), [14, 14, 14]);
  assert.equal(lines.join('　').replaceAll('　', ''), Array.from({ length: 15 }, (_, i) => String(i).padStart(2, '0')).join(''));
});
