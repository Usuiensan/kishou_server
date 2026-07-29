const assert = require('node:assert/strict');
const test = require('node:test');
const {
  toLegacyApiType,
  toLegacyApiNotification,
  toLegacyApiResponse,
} = require('../lib/apiResponse');

test('APIの低震度typeは維持し、それ以外の既知通知をemergencyへ変換する', () => {
  for (const type of ['earthquake_1', 'earthquake_2', 'earthquake_3', 'earthquake_4']) {
    assert.equal(toLegacyApiType(type), type);
  }
  for (const type of ['earthquake_5l', 'earthquake_5h', 'earthquake_6l', 'earthquake_6h', 'earthquake_7', 'eew', 'earthquake', 'tsunami_warning', 'tsunami_advisory', 'nerv', 'weather']) {
    assert.equal(toLegacyApiType(type), 'emergency');
  }
});

test('stableと未知typeは変更しない', () => {
  assert.equal(toLegacyApiType('stable'), 'stable');
  assert.equal(toLegacyApiType('future_type'), 'future_type');
});

test('API互換変換は元オブジェクトとlinesオブジェクトを変更しない', () => {
  const source = { type: 'earthquake_5l', lines: [{ text: '本文', duration: 3.5 }], id: '1' };
  const converted = toLegacyApiNotification(source);
  assert.equal(converted.type, 'emergency');
  assert.deepEqual(converted.lines, source.lines);
  assert.equal(source.type, 'earthquake_5l');
  assert.equal(typeof converted.lines[0], 'object');
});

test('APIレスポンス配列を一括変換する', () => {
  const response = toLegacyApiResponse([
    { type: 'eew' },
    { type: 'earthquake_4' },
    { type: 'stable' },
  ]);
  assert.deepEqual(response.map((item) => item.type), ['emergency', 'earthquake_4', 'stable']);
});
