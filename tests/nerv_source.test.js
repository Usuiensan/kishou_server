const assert = require('node:assert/strict');
const test = require('node:test');
const {
  classifyNervStatus,
  decodeHtml,
  isDuplicateEarthquakeSource,
  isExcludedNervStatus,
  isTornadoAlert,
  isNervRelevantStatus,
  normalizeStatus,
  removeHashtags,
  normalizeNervContent,
} = require('../lib/nervSource');

test('NERV HTML本文をプレーンテキストへ変換する', () => {
  assert.equal(decodeHtml('<p>停電情報</p><br>東京 &amp; 千葉'), '停電情報\n東京 & 千葉');
});

test('NERVのカテゴリを分類する', () => {
  assert.equal(classifyNervStatus({ content: '停電情報', tags: [] }), 'blackout');
  assert.equal(classifyNervStatus({ content: '避難所を開設', tags: [] }), 'evacuation');
  assert.equal(classifyNervStatus({ content: '電車が運休', tags: [] }), 'transit');
  assert.equal(classifyNervStatus({ content: 'NHKニュース速報', tags: [] }), 'news');
});

test('地震・津波・緊急投稿はNERVバックアップ対象から除外する', () => {
  assert.equal(isDuplicateEarthquakeSource({ content: '緊急地震速報', tags: [] }), true);
  assert.equal(isDuplicateEarthquakeSource({ content: '大津波警報', tags: [] }), true);
  assert.equal(isDuplicateEarthquakeSource({ content: '通常ニュース', tags: [] }), false);
});

test('NERV項目に出典情報を付加する', () => {
  const item = normalizeStatus({ id: '1', content: '<p>ニュース</p>', url: 'https://unnerv.jp/@UN_NERV/1', created_at: '2026-01-01T00:00:00Z', tags: [] });
  assert.equal(item.source, 'nerv');
  assert.equal(item.sourceUrl, 'https://unnerv.jp/@UN_NERV/1');
  assert.equal(item.nervCategory, 'news');
});

test('NERV本文からハッシュタグを除去する', () => {
  const item = normalizeStatus({ id: '2', content: '<p>避難情報を発表しました。 #避難 #防災</p>', url: 'https://unnerv.jp/@UN_NERV/2', created_at: '2026-01-01T00:00:00Z', tags: [{ name: '避難' }] });
  assert.equal(item.lines[0].text, '避難情報を発表しました。');
});

test('NERVの危険度で候補を絞り込む', () => {
  assert.equal(isNervRelevantStatus({ content: 'レベル2大雨注意報です' }), false);
  assert.equal(isNervRelevantStatus({ content: '大雨警報級の見込みです' }), false);
  assert.equal(isNervRelevantStatus({ content: 'レベル4土砂災害危険情報です' }), true);
  assert.equal(isNervRelevantStatus({ content: '避難所を開設しました' }), true);
  assert.equal(isNervRelevantStatus({ content: '避難判断水位に上る見込みです' }), false);
  assert.equal(isNervRelevantStatus({ content: 'レベル4危険警報に到達する見込みです' }), false);
  assert.equal(isNervRelevantStatus({ content: '【岩手県 レベル4土砂災害危険警報】\nレベル2からレベル4に到達する見込みです' }), true);
  assert.equal(isNervRelevantStatus({ content: '【岩手県 気象警報・注意報】\nレベル4土砂災害危険警報に到達する見込みです' }), false);
  assert.equal(isNervRelevantStatus({ content: '事故で死亡者が出ています' }), true);
});

test('NERVの定型気象・火山情報を通常候補から除外する', () => {
  assert.equal(isNervRelevantStatus({ content: '【台風第13号実況・予報】\n台風情報' }), false);
  assert.equal(isNervRelevantStatus({ content: '【全般気象解説情報】\n気象情報' }), false);
  assert.equal(isNervRelevantStatus({ content: '【噴火警報・予報 口永良部島】\n噴火警戒レベル1' }), false);
  assert.equal(isNervRelevantStatus({ content: '【NHKニュース速報】\n火山噴火を速報' }), true);
});

test('竜巻注意情報を一般向け表示へ整形する', () => {
  assert.equal(normalizeNervContent('【北海道 気象防災速報（竜巻注意）】\n#北海道'), '竜巻注意情報　北海道\n竜巻など突風のおそれ　安全確保を');
  assert.equal(
    normalizeNervContent('【八重山地方気象防災速報（竜巻注意）】\n竜巻などの激しい突風が発生しやすい気象状況になっています。頑丈な建物内に移動してください。この情報は30日15:10まで有効です。'),
    '竜巻注意情報　八重山地方\n竜巻など突風のおそれ　安全確保を\nこの情報は30日15:10まで有効です',
  );
});

test('竜巻注意情報を全送出経路の手前で除外する', () => {
  const status = { content: '【北海道 気象防災速報（竜巻注意）】\n竜巻など突風のおそれ', tags: [] };
  assert.equal(isTornadoAlert(status), true);
  assert.equal(isNervRelevantStatus(status), false);
});

test('NERVの死去ニュースだけを除外し、死亡を含む災害・事件報道は通す', () => {
  assert.equal(isExcludedNervStatus({ content: '<p>著名人が死去しました</p>' }), true);
  assert.equal(isExcludedNervStatus({ content: '<p>事故で1人が死亡しました</p>' }), false);
});
