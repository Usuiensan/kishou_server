const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { EEW_ANNOUNCE_MAX_INTENSITIES, isEewAnnounceableMaxInt, eewDisplayMode, isEewPostable } = require('../lib/eewAnnounce');
const { createAtlasData } = require('../lib/atlasData');
const { composeAtlasView, eewDisplayMode: liveEewDisplayMode, eewForecastWindowLines, eewForecastDataLine } = require('../telop/atlas-live');
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

test('eewDisplayMode: 警報級はボックス、予報級は震度集合で ウィンドウ/出さない を分ける', () => {
  assert.equal(eewDisplayMode({ isWarning: true, maxInt: '3' }), 'box');
  assert.equal(eewDisplayMode({ isWarning: true, maxInt: null }), 'box');
  assert.equal(eewDisplayMode({ isWarning: false, maxInt: '4' }), 'window');
  assert.equal(eewDisplayMode({ isWarning: false, maxInt: null }), 'window');
  assert.equal(eewDisplayMode({ isWarning: false, maxInt: '7' }), 'window');
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
  assert.equal(eewDisplayMode(scale4.payload.render), 'window');

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
  assert.equal(eewDisplayMode(data.payload.render), 'window');
});

test('createAtlasData(eew) は render に報数・マグニチュード・深さも保持する', () => {
  // Wolfx: Serial / Magnitude / Depth (座標文字列の末尾メートル) がそのまま届く
  const wolfx = createAtlasData('eew', mapWolfxEew(wolfxMessage({ Serial: 3, Magnitude: 4.2, Depth: 20 })));
  assert.equal(wolfx.payload.render.serial, 3);
  assert.equal(wolfx.payload.render.magnitude, 4.2);
  assert.equal(wolfx.payload.render.depthKm, 20);

  // JMA XML 実サンプル (第3報、M5.1、深さ30km)
  const xml = createAtlasData('eew', parseEarthquake(sample('36_01_03_240613_VXSE44.xml')));
  assert.equal(xml.payload.render.serial, 3);
  assert.equal(xml.payload.render.magnitude, 5.1);
  assert.equal(xml.payload.render.depthKm, 30);

  // 取れない要素は null (描画側でその要素だけ省く)
  const missing = createAtlasData('eew', mapWolfxEew(wolfxMessage({ Serial: '', Magnitude: '', Depth: null })));
  assert.equal(missing.payload.render.serial, null);
  assert.equal(missing.payload.render.magnitude, null);
  assert.equal(missing.payload.render.depthKm, null);
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

test('composeAtlasView: 予報級 (震度集合内) はボックスに出さずウィンドウの2行だけを返す', () => {
  const view = composeAtlasView(snapshotWithEew([
    eewEntry({ hypocenterName: '熊本県天草・芦北地方', latitude: 32.6, longitude: 130.2, areas: [], isWarning: false, maxInt: '4', serial: 1, magnitude: 4.2, depthKm: 20 }),
  ]));
  assert.equal(view.eew, null);
  // 書式はユーザー指定の例そのまま (震源地名は短縮せず「で地震」を続ける)
  assert.deepEqual(view.eewWindow?.lines, [
    '緊急地震速報(予報)[第1報]',
    '熊本県天草・芦北地方で地震 最大震度4 M4.2 深さ20km',
  ]);
});

test('composeAtlasView: 警報級は従来どおりボックス用に返し、ウィンドウは出さない', () => {
  const entry = eewEntry({ hypocenterName: '豊後水道', latitude: 33.2, longitude: 132.4, areas: [], isWarning: true, maxInt: null });
  const view = composeAtlasView(snapshotWithEew([entry]));
  assert.equal(view.eew, entry);
  assert.equal(view.eewWindow, null);
});

test('composeAtlasView: 予報級でも震度3以下はどちらにも出さない', () => {
  const view = composeAtlasView(snapshotWithEew([
    eewEntry({ hypocenterName: '石川県能登地方', latitude: 37.5, longitude: 137.3, areas: [], isWarning: false, maxInt: '3' }),
  ]));
  assert.equal(view.eew, null);
  assert.equal(view.eewWindow, null);
});

test('composeAtlasView: 警報級 (旧) と予報級 (新) が同時にある場合は両方を返す', () => {
  const warning = eewEntry(
    { hypocenterName: '豊後水道', latitude: 33.2, longitude: 132.4, areas: [], isWarning: true, maxInt: null },
    { id: 'E1', publishedAt: '2026-01-01T01:00:00+09:00' });
  const forecast = eewEntry(
    { hypocenterName: '石川県能登地方', latitude: 37.5, longitude: 137.3, areas: [], isWarning: false, maxInt: '5-', serial: 2, magnitude: 5.5, depthKm: 10 },
    { id: 'E2', publishedAt: '2026-01-01T02:00:00+09:00' });
  const view = composeAtlasView(snapshotWithEew([warning, forecast]));
  assert.equal(view.eew, warning);
  assert.deepEqual(view.eewWindow?.lines, [
    '緊急地震速報(予報)[第2報]',
    '石川県能登地方で地震 最大震度5弱 M5.5 深さ10km',
  ]);
});

test('eewForecastWindowLines: 要素の有無と震度表記をユーザー指定の書式に組み立てる', () => {
  const base = { hypocenterName: '熊本県天草・芦北地方', maxInt: '4', serial: 1, magnitude: 4.2, depthKm: 20 };
  assert.deepEqual(eewForecastWindowLines(base), [
    '緊急地震速報(予報)[第1報]',
    '熊本県天草・芦北地方で地震 最大震度4 M4.2 深さ20km',
  ]);
  // 報数が取れなければ [第N報] を付けない
  assert.equal(eewForecastWindowLines({ ...base, serial: null })[0], '緊急地震速報(予報)');
  // 予想最大震度の日本語表記と不明
  assert.equal(eewForecastWindowLines({ ...base, maxInt: '5-' })[1], '熊本県天草・芦北地方で地震 最大震度5弱 M4.2 深さ20km');
  assert.equal(eewForecastWindowLines({ ...base, maxInt: '5+' })[1], '熊本県天草・芦北地方で地震 最大震度5強 M4.2 深さ20km');
  assert.equal(eewForecastWindowLines({ ...base, maxInt: '6-' })[1], '熊本県天草・芦北地方で地震 最大震度6弱 M4.2 深さ20km');
  assert.equal(eewForecastWindowLines({ ...base, maxInt: '6+' })[1], '熊本県天草・芦北地方で地震 最大震度6強 M4.2 深さ20km');
  assert.equal(eewForecastWindowLines({ ...base, maxInt: '7' })[1], '熊本県天草・芦北地方で地震 最大震度7 M4.2 深さ20km');
  assert.equal(eewForecastWindowLines({ ...base, maxInt: null })[1], '熊本県天草・芦北地方で地震 最大震度不明 M4.2 深さ20km');
  // マグニチュードは小数1位、取れなければ要素だけ省く
  assert.equal(eewForecastWindowLines({ ...base, magnitude: 4 })[1], '熊本県天草・芦北地方で地震 最大震度4 M4.0 深さ20km');
  assert.equal(eewForecastWindowLines({ ...base, magnitude: null })[1], '熊本県天草・芦北地方で地震 最大震度4 深さ20km');
  // 深さ: 0 は「ごく浅い」、取れなければ要素だけ省く
  assert.equal(eewForecastWindowLines({ ...base, depthKm: 0 })[1], '熊本県天草・芦北地方で地震 最大震度4 M4.2 深さごく浅い');
  assert.equal(eewForecastWindowLines({ ...base, depthKm: null })[1], '熊本県天草・芦北地方で地震 最大震度4 M4.2');
  // 震源地名が無ければ地名要素ごと省き、先頭に空白を残さない
  assert.equal(eewForecastWindowLines({ ...base, hypocenterName: '' })[1], '最大震度4 M4.2 深さ20km');
  assert.equal(eewForecastWindowLines(null), null);
});

test('eewForecastDataLine: データ行は震源地名に「で地震」を付けて1行だけを組み立てる', () => {
  const base = { hypocenterName: '熊本県天草・芦北地方', maxInt: '4', serial: 1, magnitude: 4.2, depthKm: 20 };
  assert.equal(eewForecastDataLine(base), '熊本県天草・芦北地方で地震 最大震度4 M4.2 深さ20km');
  // ウィンドウの2行目と同一 (警報級のストリップはこの1行だけを使う)
  assert.equal(eewForecastWindowLines(base)[1], eewForecastDataLine(base));
  // 警報級 (最大震度が導出できない旧来の render) でも同じ組み立てになる
  assert.equal(eewForecastDataLine({ hypocenterName: '豊後水道', maxInt: null }), '豊後水道で地震 最大震度不明');
  // 震源地名が取れなければ地名要素ごと省く
  assert.equal(eewForecastDataLine({ ...base, hypocenterName: '' }), '最大震度4 M4.2 深さ20km');
  assert.equal(eewForecastDataLine(null), null);
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

// install の描画検証用ハーネス (帯 = #atlas-intensity、win = #eew-forecast-window)
const createInstallHarness = () => {
  const vm = require('node:vm');
  const element = () => ({
    children: [], style: {}, textContent: '', className: '',
    replaceChildren() { this.children = []; },
    appendChild(child) { this.children.push(child); },
    append(...children) { this.children.push(...children); },
  });
  const band = element();
  const win = element();
  const sandbox = {
    document: {
      getElementById: (id) => (id === 'atlas-intensity' ? band : id === 'eew-forecast-window' ? win : null),
      createElement: element,
    },
    setInterval() { return 1; }, clearInterval() {},
    setTimeout() {}, fetch: async () => ({ ok: false }),
    // 実ページでは telop/eew.html が提供するボックス描画 (ここでは検証対象外)
    renderEEW() {}, renderEEWVertical() {},
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(require.resolve('../telop/atlas-live'), 'utf8'), sandbox);
  const apply = (state) => sandbox.applyAtlasSnapshot(JSON.parse(JSON.stringify(state)));
  return { band, win, apply };
};
const forecastEntryFixture = () => eewEntry(
  { hypocenterName: '熊本県天草・芦北地方', latitude: 32.6, longitude: 130.2, areas: [], isWarning: false, maxInt: '4', serial: 1, magnitude: 4.2, depthKm: 20 },
  { id: 'F1' });
const warningEntryFixture = () => eewEntry(
  { hypocenterName: '豊後水道', latitude: 33.2, longitude: 132.4, areas: [], isWarning: true, maxInt: null },
  { id: 'W1', publishedAt: '2026-01-01T00:30:00+09:00' });

test('install: 予報級はウィンドウに2行、警報級ボックス表示中はデータ行1行のストリップが上部に出る', () => {
  const { win, apply } = createInstallHarness();
  const forecastEntry = forecastEntryFixture();
  const warningEntry = warningEntryFixture();

  // 予報級のみ: ウィンドウ (ボックス位置) に2行が出る
  apply(snapshotWithEew([forecastEntry]));
  assert.equal(win.style.display, 'block');
  assert.equal(win.className, '');
  assert.deepEqual(win.children.map((child) => [child.className, child.textContent]), [
    ['eew-forecast-line1', '緊急地震速報(予報)[第1報]'],
    ['eew-forecast-line2', '熊本県天草・芦北地方で地震 最大震度4 M4.2 深さ20km'],
  ]);

  // EEW が消えればウィンドウも消える
  apply(snapshotWithEew([]));
  assert.equal(win.style.display, 'none');
  assert.equal(win.children.length, 0);
  assert.equal(win.className, '');

  // 警報級ボックスと同時: ボックスは従来どおり出たまま、同じ要素が
  // 警報級自身のデータ行1行だけのストリップ (上部配置クラス) になる
  apply(snapshotWithEew([warningEntry, forecastEntry]));
  assert.equal(win.style.display, 'block');
  assert.equal(win.className, 'strip');
  assert.deepEqual(win.children.map((child) => [child.className, child.textContent]), [
    ['eew-forecast-line2', '豊後水道で地震 最大震度不明'],
  ]);

  // 警報級だけでもストリップは同じ内容で出続ける
  apply(snapshotWithEew([warningEntry]));
  assert.equal(win.style.display, 'block');
  assert.equal(win.className, 'strip');
  assert.deepEqual(win.children.map((child) => child.textContent), ['豊後水道で地震 最大震度不明']);

  // 横型 EEW が表示設定で無効ならウィンドウもストリップも出ない
  const disabled = snapshotWithEew([forecastEntry]);
  disabled.display = { eewHorizontal: false };
  apply(disabled);
  assert.equal(win.style.display, 'none');
  assert.equal(win.className, '');
});

test('install: ストリップは上部テロップのサマリーが同時表示されている間だけ帯の下へずれる', () => {
  const { band, win, apply } = createInstallHarness();
  const warningEntry = warningEntryFixture();
  const tsunamiEntry = {
    action: 'upsert',
    event: { id: 'T1', serial: 1, publishedAt: '2026-01-01T01:30:00+09:00' },
    payload: {
      render: { major: [], warning: ['区域A'], advisory: [] },
      tsunamiOverviewFrames: [{ overview: true, level: 'warning', label: '津波警報', area: '区域A' }],
      tsunamiFrames: [],
    },
  };
  const snapshotWith = (eewEntries, tsunamiEntries = []) => ({
    version: 1,
    display: {},
    sourceHealth: {},
    layers: { eew: eewEntries, tsunami: tsunamiEntries, intensity: [], vertical: [] },
  });

  // 警報級＋津波サマリーの初回: ストリップは上部に出て、帯にはサマリーが入る
  apply(snapshotWith([warningEntry], [tsunamiEntry]));
  assert.equal(win.className, 'strip');
  assert.ok(band.children.length > 0, '帯にサマリーが表示されている');

  // 次のスナップショット適用で、サマリー表示中として帯の下へずれる
  apply(snapshotWith([warningEntry], [tsunamiEntry]));
  assert.equal(win.style.display, 'block');
  assert.equal(win.className, 'strip below-summary');
  assert.deepEqual(win.children.map((child) => child.textContent), ['豊後水道で地震 最大震度不明']);

  // サマリーが消えたら (2回適用して帯の消去を反映) ストリップは上部へ戻る
  apply(snapshotWith([warningEntry]));
  apply(snapshotWith([warningEntry]));
  assert.equal(band.children.length, 0);
  assert.equal(win.className, 'strip');
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
