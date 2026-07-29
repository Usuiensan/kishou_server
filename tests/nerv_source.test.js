const assert = require('node:assert/strict');
const test = require('node:test');
const {
  classifyNervStatus,
  decodeHtml,
  isDuplicateEarthquakeSource,
  isExcludedNervStatus,
  normalizeStatus,
  removeHashtags,
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
  assert.equal(isDuplicateEarthquakeSource({ content: '緊急地震速報です', tags: [] }), true);
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

test('NERVの死去ニュースだけを除外し、死亡を含む災害・事件報道は通す', () => {
  assert.equal(isExcludedNervStatus({ content: '<p>著名人が死去しました</p>' }), true);
  assert.equal(isExcludedNervStatus({ content: '<p>事故で1人が死亡しました</p>' }), false);
});
