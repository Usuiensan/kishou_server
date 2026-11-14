const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { EEW_ANNOUNCE_MAX_INTENSITIES, isEewAnnounceableMaxInt, eewDisplayMode, isEewPostable } = require('../lib/eewAnnounce');
const { createAtlasData } = require('../lib/atlasData');
const { composeAtlasView, eewDisplayMode: liveEewDisplayMode } = require('../telop/atlas-live');
const { parseEarthquake } = require('../lib/parsers/earthquake');
const { mapWolfxEew } = require('../lib/parsers/eewJson');
const { EewTracker } = require('../lib/eewTracker');
const { startWolfxEewClient } = require('../lib/wolfxEewClient');

const sample = (name) => fs.readFileSync(path.join(__dirname, 'samples', name), 'utf8');

const wolfxMessage = (overrides = {}) => ({
  type: 'jma_eew',
  EventID: '20260101010000',
  Serial: 1,
  AnnouncedTime: '2026/01/01 01:00:00',
  OriginTime: '2026/01/01 00:59:30',
  Title: '緊急地震速報（予報）',
  isWarn: false,
  isCancel: false,
  isTraining: false,
  Hypocenter: '石川県能登地方',
  Latitude: 37.5,
  Longitude: 137.3,
  Depth: 10,
  Magnitude: 5.5,
  MaxIntensity: '4',
  WarnArea: [],
  ...overrides,
});

test('発表基準の震度集合は 不明・4・5弱・5強・6弱・6強・7 で、3以下は対象外', () => {
  assert.deepEqual([...EEW_ANNOUNCE_MAX_INTENSITIES].sort(), ['4', '5+', '5-', '6+', '6-', '7']);
  for (const maxInt of ['1', '2', '3']) assert.equal(isEewAnnounceableMaxInt(maxInt), false, maxInt);
  for (const maxInt of ['4', '5-', '5+', '6-', '6+', '7']) assert.equal(isEewAnnounceableMaxInt(maxInt), true, maxInt);
  // 不明 (null / 未設定) は対象に含む
  assert.equal(isEewAnnounceableMaxInt(null), true);
  assert.equal(isEewAnnounceableMaxInt(undefined), true);
});

test('eewDisplayMode: 警報級はボックス、予報級は震度集合で テロップのみ/出さない を分ける', () => {
  assert.equal(eewDisplayMode({ isWarning: true, maxInt: '3' }), 'box');
  assert.equal(eewDisplayMode({ isWarning: true, maxInt: null }), 'box');
  assert.equal(eewDisplayMode({ isWarning: false, maxInt: '4' }), 'telop');
  assert.equal(eewDisplayMode({ isWarning: false, maxInt: null }), 'telop');
  assert.equal(eewDisplayMode({ isWarning: false, maxInt: '7' }), 'telop');
  assert.equal(eewDisplayMode({ isWarning: false, maxInt: '3' }), 'none');
  assert.equal(eewDisplayMode({ isWarning: false, maxInt: '1' }), 'none');
  // isWarning が記録されていない旧形式は従来どおりボックス
  assert.equal(eewDisplayMode({}), 'box');
  assert.equal(eewDisplayMode(undefined), 'box');
  // ブラウザ側 (telop/atlas-live.js) の判定も同じ結果になる
  for (const render of [
    { isWarning: true, maxInt: '3' }, { isWarning: false, maxInt: '4' },
    { isWarning: false, maxInt: null }, { isWarning: false, maxInt: '3' }, {},
  ]) {
    assert.equal(liveEewDisplayMode(render), eewDisplayMode(render), JSON.stringify(render));
  }
});

test('isEewPostable: 警報級と取消は常時、予報級は震度集合のときだけ投稿対象', () => {
  assert.equal(isEewPostable({ isWarning: true, infoType: '発表', intensity: { maxInt: '3' } }), true);
  assert.equal(isEewPostable({ isWarning: false, infoType: '取消', intensity: { maxInt: '1' } }), true);
  assert.equal(isEewPostable({ isWarning: false, infoType: '発表', intensity: { maxInt: '4' } }), true);
  assert.equal(isEewPostable({ isWarning: false, infoType: '発表', intensity: { maxInt: null } }), true);
  assert.equal(isEewPostable({ isWarning: false, infoType: '発表', intensity: { maxInt: '3' } }), false);
  assert.equal(isEewPostable({ isWarning: false, infoType: '発表', intensity: { maxInt: '2' } }), false);
  assert.equal(isEewPostable(null), false);
});

test('createAtlasData(eew) は render に isWarning と maxInt を保持する', () => {
  const forecast = createAtlasData('eew', mapWolfxEew(wolfxMessage()));
  assert.equal(forecast.payload.render.isWarning, false);
  assert.equal(forecast.payload.render.maxInt, '4');

  const unknown = createAtlasData('eew', mapWolfxEew(wolfxMessage({ MaxIntensity: '' })));
  assert.equal(unknown.payload.render.maxInt, null);

  // 公式サンプル 37_01_01 (VXSE43 形式だが内容は警報級) では isWarning が立ち、
  // maxInt は区域別 scaleTo の最大 (愛媛県南予の '5-') から導出される
  const warning = createAtlasData('eew', parseEarthquake(sample('37_01_01_240613_VXSE43.xml')));
  assert.equal(warning.payload.render.isWarning, true);
  assert.equal(warning.payload.render.maxInt, '5-');
});

test('createAtlasData(eew): XML 由来で intensity.maxInt が無い場合は区域別 scaleTo の最大から導出する', () => {
  // JMA XML の EEW (VXSE43/44) を模す: intensity.maxInt は null で、予想は
  // eewForecastAreas の scaleTo にだけある (実データでは数値と文字列が混在する)。
  const base = mapWolfxEew(wolfxMessage({ MaxIntensity: '' }));
  assert.equal(base.intensity.maxInt, null);
  const area = (scaleTo) => ({
    name: '愛媛県南予', pref: '愛媛', code: 622, scaleFrom: scaleTo, scaleTo, kindCode: 1, arrivalTime: null,
  });

  const scale4 = createAtlasData('eew', { ...base, eewForecastAreas: [area(4)] });
  assert.equal(scale4.payload.render.maxInt, '4');
  assert.equal(eewDisplayMode(scale4.payload.render), 'telop');

  const scale3 = createAtlasData('eew', { ...base, eewForecastAreas: [area(3)] });
  assert.equal(scale3.payload.render.maxInt, '3');
  assert.equal(eewDisplayMode(scale3.payload.render), 'none');

  // '5弱' は内部表記 '5-' へ寄せ、他の区域より大きければ最大になる
  const scale5Low = createAtlasData('eew', { ...base, eewForecastAreas: [area(4), area('5弱')] });
  assert.equal(scale5Low.payload.render.maxInt, '5-');

  // intensity.maxInt がある場合は区域から導出せずそちらを優先する
  const direct = mapWolfxEew(wolfxMessage({ MaxIntensity: '5強' }));
  assert.equal(direct.intensity.maxInt, '5+');
  const prioritized = createAtlasData('eew', { ...direct, eewForecastAreas: [area(7)] });
  assert.equal(prioritized.payload.render.maxInt, '5+');

  // 区域が無ければ従来どおり null (不明) のまま
  const noAreas = createAtlasData('eew', { ...base, eewForecastAreas: [] });
  assert.equal(noAreas.payload.render.maxInt, null);
});

test('createAtlasData(eew): 実サンプル VXSE44 (予報) は scaleTo から maxInt=4 を導出する', () => {
  const data = createAtlasData('eew', parseEarthquake(sample('36_01_03_240613_VXSE44.xml')));
  assert.equal(data.payload.render.isWarning, false);
  assert.equal(data.payload.render.maxInt, '4');
  assert.equal(eewDisplayMode(data.payload.render), 'telop');
});

const eewEntry = (render, { id = 'E1', serial = 1, publishedAt = '2026-01-01T01:00:00+09:00', action = 'upsert' } = {}) => ({
  action,
  event: { id, serial, publishedAt },
  payload: { render },
});
const snapshotWithEew = (entries) => ({
  version: 1,
  display: {},
  sourceHealth: {},
  layers: { eew: entries, tsunami: [], intensity: [], vertical: [] },
});

test('composeAtlasView: 予報級 (震度集合内) はボックスに出さず上部テロップ行だけを返す', () => {
  const view = composeAtlasView(snapshotWithEew([
    eewEntry({ hypocenterName: '石川県能登地方', latitude: 37.5, longitude: 137.3, areas: [], isWarning: false, maxInt: '4' }),
  ]));
  assert.equal(view.eew, null);
  // Node テスト環境には eew.html の headlinePlace が無いため震源地名はそのまま使う。
  // 実ページでは headlinePlace で短縮したボックス見出しと同一文になる。
  assert.equal(view.eewTelop?.text, '石川県能登地方で地震 強い揺れに警戒');
});

test('composeAtlasView: 警報級は従来どおりボックス用に返し、テロップ行は出さない', () => {
  const entry = eewEntry({ hypocenterName: '豊後水道', latitude: 33.2, longitude: 132.4, areas: [], isWarning: true, maxInt: null });
  const view = composeAtlasView(snapshotWithEew([entry]));
  assert.equal(view.eew, entry);
  assert.equal(view.eewTelop, null);
});

test('composeAtlasView: 予報級でも震度3以下はどちらにも出さない', () => {
  const view = composeAtlasView(snapshotWithEew([
    eewEntry({ hypocenterName: '石川県能登地方', latitude: 37.5, longitude: 137.3, areas: [], isWarning: false, maxInt: '3' }),
  ]));
  assert.equal(view.eew, null);
  assert.equal(view.eewTelop, null);
});

test('composeAtlasView: 警報級 (旧) と予報級 (新) が同時にある場合は両方を返す', () => {
  const warning = eewEntry(
    { hypocenterName: '豊後水道', latitude: 33.2, longitude: 132.4, areas: [], isWarning: true, maxInt: null },
    { id: 'E1', publishedAt: '2026-01-01T01:00:00+09:00' });
  const forecast = eewEntry(
    { hypocenterName: '石川県能登地方', latitude: 37.5, longitude: 137.3, areas: [], isWarning: false, maxInt: '5-' },
    { id: 'E2', publishedAt: '2026-01-01T02:00:00+09:00' });
  const view = composeAtlasView(snapshotWithEew([warning, forecast]));
  assert.equal(view.eew, warning);
  assert.equal(view.eewTelop?.text, '石川県能登地方で地震 強い揺れに警戒');
});

test('EewTracker: Wolfx と JMA の同一報は経路が違っても二重投稿しない', () => {
  const tracker = new EewTracker();
  const base = {
    isEEW: true, eventId: '20260101010000', infoType: '発表', serial: 2,
    reportTime: '2026-01-01T01:00:00+09:00', eewAreas: ['石川'],
  };
  const viaWolfx = { ...base, isWarning: false, intensity: { maxInt: '4' } };
  const viaJma = { ...base, isWarning: false, intensity: { maxInt: '4' } };
  assert.equal(tracker.accept(viaWolfx, { postable: isEewPostable(viaWolfx) }).action, 'full');
  assert.equal(tracker.accept(viaJma, { postable: isEewPostable(viaJma) }).action, 'skip');
});

test('EewTracker: 対象外の予報 (震度3) は投稿済みにせず、続く対象報は初回投稿になる', () => {
  const tracker = new EewTracker();
  const base = { isEEW: true, eventId: '20260101020000', infoType: '発表', eewAreas: ['石川'] };
  const weak = { ...base, serial: 1, isWarning: false, intensity: { maxInt: '3' } };
  assert.equal(tracker.accept(weak, { postable: isEewPostable(weak) }).action, 'skip');
  const strong = { ...base, serial: 2, isWarning: false, intensity: { maxInt: '5-' } };
  assert.equal(tracker.accept(strong, { postable: isEewPostable(strong) }).action, 'full');
  const cancel = { ...base, serial: 3, infoType: '取消', isWarning: false, intensity: { maxInt: '5-' } };
  assert.equal(tracker.accept(cancel, { postable: isEewPostable(cancel) }).action, 'cancel');
});

class FakeSocket {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.handlers = new Map();
    this.sent = [];
    FakeSocket.instances.push(this);
  }
  on(event, fn) {
    const list = this.handlers.get(event) || [];
    list.push(fn);
    this.handlers.set(event, list);
  }
  emit(event, ...args) {
    for (const fn of this.handlers.get(event) || []) fn(...args);
  }
  send(message) { this.sent.push(message); }
  close() { this.emit('close'); }
}

test('Wolfx クライアント: 接続時に問い合わせ、心拍へ応答し、EEW を bulletin 化して渡す', () => {
  FakeSocket.instances = [];
  const bulletins = [];
  const client = startWolfxEewClient({
    onBulletin: (bulletin) => bulletins.push(bulletin),
    logger: { log() {}, error() {} },
    WebSocketImpl: FakeSocket,
  });
  assert.equal(FakeSocket.instances.length, 1);
  const socket = FakeSocket.instances[0];
  assert.equal(socket.url, 'wss://ws-api.wolfx.jp/all_eew');

  socket.emit('open');
  assert.deepEqual(socket.sent, ['query_jmaeew']);

  socket.emit('message', JSON.stringify({ type: 'heartbeat' }));
  assert.deepEqual(socket.sent, ['query_jmaeew', 'ping']);

  socket.emit('message', JSON.stringify(wolfxMessage({ MaxIntensity: '5弱' })));
  assert.equal(bulletins.length, 1);
  assert.equal(bulletins[0].eventId, '20260101010000');
  assert.equal(bulletins[0].isWarning, false);
  assert.equal(bulletins[0].intensity.maxInt, '5-');
  assert.equal(bulletins[0].isEEW, true);

  // 訓練報は取り込まない
  socket.emit('message', JSON.stringify(wolfxMessage({ isTraining: true, EventID: '20260101020000' })));
  assert.equal(bulletins.length, 1);

  client.stop();
  socket.emit('close');
  assert.equal(FakeSocket.instances.length, 1, 'stop 後は再接続しない');
});
