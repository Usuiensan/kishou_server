const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('横型EEWは地域名を14単位で折り返し、34pxのまま表示する', () => {
  const html = fs.readFileSync(path.join(__dirname, '../telop/eew.html'), 'utf8');
  const source = html.match(/function wrapTokens[\s\S]*?(?=\/\* ========= ミニマップ ========= \*\/)/)[0];
  const context = vm.createContext({ shortName: pref => pref.replace(/[都府県]$/, ''), hokkaidoZones: () => [] });
  const result = vm.runInContext(`${source}\nJSON.stringify({
    compact: layoutAreas(['茨城県', '栃木県'], []).lines,
    wide: layoutAreas(['北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県', '茨城県', '栃木県', '群馬県', '埼玉県', '千葉県', '東京都', '神奈川県', '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県', '岐阜県', '静岡県', '愛知県', '三重県', '滋賀県', '京都府', '大阪府', '兵庫県', '奈良県', '和歌山県', '鳥取県', '島根県', '岡山県', '広島県', '山口県', '徳島県', '香川県', '愛媛県', '高知県', '福岡県', '佐賀県', '長崎県', '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県'], []).lines,
    size: AREAS_FONT_SIZE
  })`, context);
  const { compact, wide, size } = JSON.parse(result);

  assert.equal(size, 34);
  assert.deepEqual(compact, ['茨城　栃木']);
  assert.deepEqual(wide, ['北海道　東北　関東　新潟', '北陸　甲信　東海　近畿　中国', '四国　九州　沖縄']);
  assert.deepEqual(wide.map(line => [...line].length), [12, 14, 8]);
});

test('v8横型も14単位を超える行をそのまま折り返す', () => {
  const html = fs.readFileSync(path.join(__dirname, '../telop/atlas-1080-v8.html'), 'utf8');
  const source = html.match(/function wrapTokens[\s\S]*?(?=\/\* ========= ミニマップ ========= \*\/)/)[0];
  const context = vm.createContext({});
  const result = vm.runInContext(`${source}\nJSON.stringify({ lines: fitLines(Array.from({ length: 15 }, (_, i) => String(i).padStart(2, '0'))), size: AREAS_FONT_SIZE })`, context);
  const { lines, size } = JSON.parse(result);

  assert.equal(size, 34);
  assert.deepEqual(lines.map(line => [...line].length), [14, 14, 14]);
});
