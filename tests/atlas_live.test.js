const test = require('node:test');
const assert = require('node:assert/strict');
const { staleSources, syncTsunamiBlinkClock, eewVisibility, composeAtlasView, longPeriodPages } = require('../telop/atlas-live');
const { createAtlasSnapshot } = require('../lib/atlasData');

test('testModeはスナップショットからビューへ伝播する', () => {
  assert.equal(composeAtlasView(createAtlasSnapshot()).testMode, false);
  assert.equal(composeAtlasView({ ...createAtlasSnapshot(), testMode: true }).testMode, true);
});

test('訓練印はEEW予報見出しと上部テロップへ伝わり、通常情報には出ない', () => {
  const snapshot = createAtlasSnapshot();
  snapshot.layers.eew = [{ event: { id: 'training-eew', training: true }, payload: { render: {
    isWarning: false, serial: 1, training: true, hypocenterName: '訓練震源', maxInt: '4',
  } } }];
  const trainingView = composeAtlasView(snapshot);
  assert.match(trainingView.eewWindow.lines[0], /【訓練】/);

  const normalSnapshot = createAtlasSnapshot();
  normalSnapshot.layers.eew = [{ event: { id: 'normal-eew' }, payload: { render: {
    isWarning: false, serial: 1, hypocenterName: '通常震源', maxInt: '4',
  } } }];
  assert.doesNotMatch(composeAtlasView(normalSnapshot).eewWindow.lines[0], /【訓練】/);
});

test('任意源は直近10分以内に報告があった場合だけ未更新判定の対象になる', () => {
  const now = Date.parse('2026-11-10T00:10:00Z');
  const health = {
    jma: { ok: true, at: '2026-11-10T00:09:30Z' },
    p2p: { ok: true, at: '2026-11-10T00:09:30Z' },
    wolfx: { ok: false, at: '2026-11-10T00:09:00Z' },
    projectbs: { ok: false, at: '2026-11-09T23:00:00Z' },
  };
  assert.deepEqual(staleSources(health, now), ['wolfx']);
});

test('L画面の緊急地震速報は発動直後だけ横縦を併用し、その後は縦だけにする', () => {
  const display = { eewHorizontal: true, eewVertical: true };
  assert.deepEqual(eewVisibility(display, true, true), { horizontal: true, vertical: true });
  assert.deepEqual(eewVisibility(display, true, false), { horizontal: false, vertical: true });
  assert.deepEqual(eewVisibility(display, false, false), { horizontal: true, vertical: false });
  assert.deepEqual(eewVisibility({ ...display, eewVertical: false }, true, false), { horizontal: false, vertical: false });
});

test('JMA/P2Pの接続失敗・2分超過を別々に未更新として判定する', () => {
  const now = Date.parse('2026-11-10T00:02:01Z');
  const health = {
    jma: { ok: true, at: '2026-11-10T00:00:00Z' },
    p2p: { ok: false, at: '2026-11-10T00:02:00Z' },
  };
  assert.deepEqual(staleSources(health, now), ['jma', 'p2p']);
  health.jma.at = '2026-11-10T00:01:00Z';
  health.p2p.ok = true;
  assert.deepEqual(staleSources(health, now), []);
});

test('初期状態は両入力源を未更新として示す', () => {
  assert.deepEqual(staleSources({ jma: null, p2p: null }, 0), ['jma', 'p2p']);
});

test('津波複数イベントを新しい順に並べ、解除通知を先頭へ置き、区域群を保持する', () => {
  const snapshot = createAtlasSnapshot();
  snapshot.layers.tsunami = [
    { event: { id: 'new', publishedAt: '2026-11-12T01:00:00Z', serial: 2 }, payload: {
      render: { major: ['宮城県'], warning: [], advisory: [] },
      tsunamiFrames: [{ level: 'major', label: '大津波警報', area: '宮城県' }],
    } },
    { event: { id: 'old', publishedAt: '2026-11-12T00:00:00Z', serial: 1 }, payload: {
      render: { major: [], warning: ['宮城県', '青森県'], advisory: [] },
      tsunamiFrames: [{ level: 'warning', label: '津波警報', area: '青森県' }],
    } },
  ];
  snapshot.notices = [{ kind: 'tsunami', event: { id: 'cancel' }, payload: { notice: '津波警報・注意報は解除されました' } }];
  const view = composeAtlasView(snapshot);
  assert.deepEqual(view.tsunamiFrames.map((frame) => frame.level), ['notice', 'major', 'warning']);
  assert.equal(view.tsunamiFrames[0].label, '津波警報・注意報は解除されました');
  assert.deepEqual(view.tsunami, { major: ['宮城県'], warning: ['宮城県', '青森県'], advisory: [] });
});

test('津波はイベントごとに地名一覧を詳細より先へ並べる', () => {
  const snapshot = createAtlasSnapshot();
  snapshot.layers.tsunami = [
    { event: { id: 'ev', publishedAt: '2026-11-12T01:00:00Z', serial: 1 }, payload: {
      render: { major: [], warning: ['区域A'], advisory: [] },
      tsunamiOverviewFrames: [{ overview: true, level: 'warning', label: '津波警報', area: '区域A' }],
      tsunamiFrames: [{ level: 'warning', label: '津波警報', area: '区域A', height: '高い', arrival: '午後3時' }],
    } },
  ];
  const view = composeAtlasView(snapshot);
  assert.deepEqual(view.tsunamiFrames.map((frame) => frame.overview === true), [true, false]);
});

test('津波の差分は更新された区域だけを残し、一覧は種別の区域集合が変わったときだけ含める', () => {
  const { tsunamiDelta } = require('../telop/atlas-live');
  const detail = (area, arrival) => ({ level: 'warning', label: '津波警報', area, height: '高い', arrival, hasHeight: true, hasArrival: true, updateKey: `ev:1:2026-11-12T00:00:00Z:warning:${area}:高い:${arrival}` });
  const overview = (area) => ({ overview: true, level: 'warning', label: '津波警報', area, updateKey: `ev:1:2026-11-12T00:00:00Z:warning:${area}::` });
  const previous = [overview('区域A　区域B'), detail('区域A', '午後3時'), detail('区域B', '午後4時')];
  // 初回提示は全件
  assert.deepEqual(tsunamiDelta(previous, null), previous);
  // 変化がなければ差分は空
  assert.deepEqual(tsunamiDelta(previous, previous), []);
  // 区域Bの到達だけが変化 → その詳細だけ (区域集合は不変なので一覧は含めない)
  const arrived = [overview('区域A　区域B'), detail('区域A', '午後3時'), detail('区域B', '到達か')];
  assert.deepEqual(tsunamiDelta(arrived, previous).map((frame) => frame.area), ['区域B']);
  // 区域Cが追加 → 一覧 (集合の変化) + 新規区域の詳細、一覧が先
  const added = [overview('区域A　区域B　区域C'), detail('区域A', '午後3時'), detail('区域B', '午後4時'), detail('区域C', '午後5時')];
  assert.deepEqual(tsunamiDelta(added, previous).map((frame) => [frame.overview === true, frame.area]), [
    [true, '区域A　区域B　区域C'], [false, '区域C'],
  ]);
  // 区域Bが削除 → 一覧だけ (消えた区域の詳細は出せない)
  const removed = [overview('区域A'), detail('区域A', '午後3時')];
  assert.deepEqual(tsunamiDelta(removed, previous).map((frame) => frame.overview === true), [true]);
  // 解除通知は常に出す
  const notice = { level: 'notice', label: '津波警報・注意報は解除されました' };
  assert.deepEqual(tsunamiDelta([notice], previous), [notice]);
  // 新規イベントのフレームは全て差分になる
  const other = [{ ...detail('区域A', '午後3時'), updateKey: 'ev2:1:2026-11-12T01:00:00Z:warning:区域A:高い:午後3時' }];
  assert.equal(tsunamiDelta(other, previous).length, 1);
});

test('津波マップ全系統がPCのUnix時計に同期し描画遅延を累積しない', () => {
  const fake = (name = 'tmblink') => ({
    animationName: name,
    effect: { getTiming: () => ({ duration: 3000 }) },
    pauseCalls: 0,
    currentTime: -1,
    pause() { this.pauseCalls++; },
  });
  const main = fake(), left = fake(), alphaMirror = fake(), unrelated = fake('eewblink');
  let animations = [main, left, alphaMirror, unrelated];
  const previousDocument = global.document;
  global.document = { getAnimations: () => animations };
  try {
    // Midway into the OFF portion (75%-100%): every copy must match.
    assert.equal(syncTsunamiBlinkClock(1_800_000_002_260), 3);
    for (const animation of [main, left, alphaMirror]) {
      assert.equal(animation.currentTime, 2260);
      assert.equal(animation.pauseCalls, 1);
    }
    assert.equal(unrelated.currentTime, -1);
    assert.equal(unrelated.pauseCalls, 0);

    // Dropping hundreds of captures still jumps to wall-clock phase.
    assert.equal(syncTsunamiBlinkClock(1_800_000_128_010), 3);
    for (const animation of [main, left, alphaMirror]) assert.equal(animation.currentTime, 2010);

    // Re-rendered SVG paths create fresh animation objects; do not restart
    // their 3s clock at zero, and do not depend on a previous frame.
    const replacedMap = fake(), replacedMask = fake();
    animations = [replacedMap, replacedMask, unrelated];
    assert.equal(syncTsunamiBlinkClock(1_800_000_129_900), 2);
    assert.equal(replacedMap.currentTime, 900);
    assert.equal(replacedMask.currentTime, 900);
    assert.equal(unrelated.pauseCalls, 0);
  } finally {
    if (previousDocument === undefined) delete global.document;
    else global.document = previousDocument;
  }
});

test('同一地震の続報は変更されたサマリーフレームを丸ごと残し、地域差分だけにする', () => {
  const { earthquakeDelta } = require('../telop/atlas-live');
  const previous = { intensity: { cityGroups: { '4': ['A', 'B'] } }, summaryFrames: [{ lines: ['時刻', '津波注意'] }] };
  const current = { intensity: { cityGroups: { '4': ['A', 'C'], '3': ['B'] } }, summaryFrames: [{ lines: ['時刻', '津波なし'] }] };
  const delta = earthquakeDelta(current, previous);
  assert.deepEqual(delta.intensity.cityGroups, { '4': ['C'], '3': ['B'] });
  assert.deepEqual(delta.summaryFrames, [{ lines: ['時刻', '津波なし'] }]);
  assert.deepEqual(earthquakeDelta(current, current).summaryFrames, []);
  assert.deepEqual(earthquakeDelta(current, current).intensity.cityGroups, { '4': [], '3': [] });
});

test('サマリーが不変でも新しい震源フレームは丸ごと残す', () => {
  const { earthquakeDelta } = require('../telop/atlas-live');
  const previous = {
    intensity: { cityGroups: {} },
    summaryFrames: [{ lines: ['時刻', '津波なし'] }],
  };
  const current = {
    intensity: { cityGroups: {} },
    summaryFrames: [{ lines: ['時刻', '津波なし'] }, { lines: ['震源'] }],
  };
  const delta = earthquakeDelta(current, previous);
  assert.deepEqual(delta.summaryFrames, [{ lines: ['震源'] }]);
});

test('震度テロップは2周で終了し、再受信・津波解除・古い地震で再開しない', () => {
  const vm = require('node:vm');
  const fs = require('node:fs');
  const element = () => ({ children: [], style: {}, textContent: '', replaceChildren() { this.children = []; }, appendChild(child) { this.children.push(child); }, append(...children) { this.children.push(...children); } });
  const band = element();
  let tick, intervalDelay;
  const sandbox = {
    document: { getElementById: (id) => id === 'atlas-intensity' ? band : null, createElement: element },
    setInterval(callback, delay) { tick = callback; intervalDelay = delay; return 1; }, clearInterval() { tick = null; },
    setTimeout() {}, fetch: async () => ({ ok: false }),
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(require.resolve('../telop/atlas-live'), 'utf8'), sandbox);
  const state = { version: 1, layers: { eew: [], tsunami: [], vertical: [], intensity: [{ event: { id: 'new', publishedAt: '2026-11-12T00:00:00Z' }, payload: { render: { maxInt: '4', cityGroups: {} }, summaryFrames: [{ lines: ['最新'] }] } }] } };
  const apply = () => sandbox.applyAtlasSnapshot(JSON.parse(JSON.stringify(state)));
  apply();
  assert.equal(intervalDelay, 7500);
  assert.equal(band.children[0].textContent, '最新');
  state.layers.intensity[0].event.serial = 2;
  apply();
  assert.equal(band.children[0].textContent, '最新');
  tick();
  assert.equal(band.children[0].textContent, '最新');
  tick();
  assert.equal(band.children.length, 0);
  assert.equal(tick, null);
  apply();
  assert.equal(band.children.length, 0);
  state.display = { earthquakeTelop: false }; apply();
  state.display.earthquakeTelop = true; apply();
  assert.equal(band.children.length, 0);
  state.layers.intensity[0].payload.summaryFrames[0].lines.push('続報'); apply();
  assert.deepEqual(Array.from(band.children, child => child.textContent), ['続報']);
  state.layers.tsunami = [{ event: { id: 'tsunami' }, payload: { tsunamiFrames: [{ level: 'notice', label: '津波解除' }] } }]; apply();
  state.layers.tsunami = []; apply();
  assert.equal(band.children[0].textContent, '最新');
  state.layers.intensity[0].event = { id: 'old', publishedAt: '2026-11-11T00:00:00Z' }; apply();
  assert.equal(band.children.length, 0);
  state.layers.intensity[0].event = { id: 'next', publishedAt: '2026-11-12T01:00:00Z' };
  state.layers.intensity[0].payload.summaryFrames = [{ lines: ['1ページ'] }, { lines: ['2ページ'] }]; apply();
  for (const expected of ['2ページ', '1ページ', '2ページ']) {
    tick();
    assert.equal(band.children[0].textContent, expected);
  }
  tick();
  assert.equal(band.children.length, 0);
  assert.equal(tick, null);
});

test('津波テロップ終了後に中断した地震情報へ戻る', () => {
  const vm = require('node:vm');
  const fs = require('node:fs');
  const element = () => ({ children: [], style: {}, textContent: '', replaceChildren() { this.children = []; }, appendChild(child) { this.children.push(child); }, append(...children) { this.children.push(...children); } });
  const band = element();
  let tick;
  const sandbox = {
    document: { getElementById: (id) => id === 'atlas-intensity' ? band : null, createElement: element },
    setInterval(callback) { tick = callback; return 1; }, clearInterval() { tick = null; },
    setTimeout() {}, fetch: async () => ({ ok: false }),
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(require.resolve('../telop/atlas-live'), 'utf8'), sandbox);
  const state = { version: 1, display: {}, layers: { eew: [], tsunami: [], vertical: [], intensity: [{
    event: { id: 'quake', publishedAt: '2026-11-12T00:00:00Z' },
    payload: { render: { maxInt: '4', cityGroups: {} }, summaryFrames: [{ lines: ['概要'] }, { lines: ['震源'] }] },
  }] } };
  const apply = () => sandbox.applyAtlasSnapshot(JSON.parse(JSON.stringify(state)));
  apply();
  assert.equal(band.children[0].textContent, '概要');
  state.layers.tsunami = [{ event: { id: 'tsunami' }, payload: { tsunamiFrames: [{ level: 'notice', label: '津波解除' }] } }];
  apply();
  assert.equal(band.children[0].textContent, '津波解除');
  state.layers.tsunami = [];
  apply();
  assert.equal(band.children[0].textContent, '概要');
  tick();
  assert.equal(band.children[0].textContent, '震源');
});

test('震度情報の震源行をグループルビで描く', () => {
  const vm = require('node:vm');
  const fs = require('node:fs');
  const element = () => ({ children: [], style: {}, textContent: '', replaceChildren() { this.children = []; }, appendChild(child) { this.children.push(child); }, append(...children) { this.children.push(...children); } });
  const band = element();
  const sandbox = {
    document: { getElementById: (id) => id === 'atlas-intensity' ? band : null, createElement: element },
    setInterval() { return 1; }, clearInterval() {}, setTimeout() {}, fetch: async () => ({ ok: false }),
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(require.resolve('../telop/atlas-live'), 'utf8'), sandbox);
  sandbox.applyAtlasSnapshot({ version: 1, display: {}, layers: {
    eew: [], tsunami: [], vertical: [], intensity: [{ event: { id: 'ruby-summary', publishedAt: '2026-11-12T00:00:00Z' }, payload: {
      render: { maxInt: '4', cityGroups: {} }, summaryFrames: [{ lines: ['震源は駿河湾', '津波の心配はありません'], hypocenterName: '駿河湾', hypocenterReading: 'するがわん' }],
    } }],
  } });
  assert.equal(band.children[0].children[1], '震源は');
  assert.equal(band.children[0].children[2].textContent, '駿河湾');
  assert.equal(band.children[0].children[2].children[0].textContent, 'するがわん');
});

test('津波は一覧→詳細の順で出し、更新時は変わった区域の詳細だけを流す', () => {
  const vm = require('node:vm');
  const fs = require('node:fs');
  const element = () => ({ children: [], style: {}, textContent: '', replaceChildren() { this.children = []; }, appendChild(child) { this.children.push(child); }, append(...children) { this.children.push(...children); } });
  const band = element();
  let tick;
  const sandbox = {
    document: { getElementById: (id) => id === 'atlas-intensity' ? band : null, createElement: element },
    setInterval(callback) { tick = callback; return 1; }, clearInterval() { tick = null; },
    setTimeout() {}, fetch: async () => ({ ok: false }),
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(require.resolve('../telop/atlas-live'), 'utf8'), sandbox);
  const detail = (area, arrival, hasArrival) => ({
    level: 'advisory', label: '津波注意報', additional: false, area,
    height: '不明', arrival, hasHeight: false, hasArrival,
  });
  const state = { version: 1, display: {}, layers: { eew: [], vertical: [], intensity: [], tsunami: [{
    event: { id: 'tsunami', publishedAt: '2026-11-12T00:00:00Z', serial: 1 },
    payload: {
      render: { major: [], warning: [], advisory: ['区域A', '区域B'] },
      tsunamiOverviewFrames: [{ overview: true, level: 'advisory', label: '津波注意報', additional: false, area: '区域A　区域B', areas: ['区域A', '区域B'] }],
      tsunamiFrames: [detail('区域A', '到達時刻不明', false), detail('区域B', '午後3時30分', true)],
    },
  }] } };
  const apply = () => sandbox.applyAtlasSnapshot(JSON.parse(JSON.stringify(state)));
  // 区域名はルビ付きで子要素として描かれるため、表示テキストは子から組み立てる
  const spanText = (span) => span.children.map((part) => typeof part === 'string' ? part : part.textContent).join('');
  // 初回は一覧が先 (データのない区域Aも一覧にだけ現れる)
  apply();
  assert.equal(band.children.length, 1);
  assert.equal(spanText(band.children[0].children[1]), '区域A　区域B');
  // 次ページはデータのある区域Bの詳細
  tick();
  assert.equal(band.children.length, 2);
  assert.equal(spanText(band.children[0].children[1]), '区域B');
  assert.ok(band.children[1].children[1].textContent.includes('午後3時30分'));
  // 更新で区域Aに到達データが入る → 変わった区域Aの詳細だけを流す
  // (区域集合は不変なので一覧は出し直さない)
  state.layers.tsunami[0].event.serial = 2;
  state.layers.tsunami[0].payload.tsunamiFrames[0] = detail('区域A', '午後4時', true);
  apply();
  assert.equal(band.children.length, 2);
  assert.equal(spanText(band.children[0].children[1]), '区域A');
  assert.ok(band.children[1].children[1].textContent.includes('午後4時'));
});

test('同じ津波フレーム群は2周で終了し、新しいupdateKeyで再表示する', () => {
  const vm = require('node:vm');
  const fs = require('node:fs');
  const element = () => ({ children: [], style: {}, textContent: '', replaceChildren() { this.children = []; }, appendChild(child) { this.children.push(child); }, append(...children) { this.children.push(...children); } });
  const band = element();
  let tick;
  const sandbox = {
    document: { getElementById: (id) => id === 'atlas-intensity' ? band : null, createElement: element },
    setInterval(callback) { tick = callback; return 1; }, clearInterval() { tick = null; },
    setTimeout() {}, fetch: async () => ({ ok: false }),
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(require.resolve('../telop/atlas-live'), 'utf8'), sandbox);
  const state = { version: 1, display: {}, layers: { eew: [], vertical: [], intensity: [], tsunami: [{
    event: { id: 'tsunami', serial: 1, publishedAt: '2026-11-12T00:00:00Z' },
    payload: { tsunamiFrames: [
      { level: 'notice', label: '津波解除', updateKey: 'tsunami:1:a' },
      { level: 'notice', label: '津波情報', updateKey: 'tsunami:1:b' },
    ] },
  }] } };
  const apply = () => sandbox.applyAtlasSnapshot(JSON.parse(JSON.stringify(state)));
  apply();
  assert.equal(band.children[0].textContent, '津波解除');
  tick();
  assert.equal(band.children[0].textContent, '津波情報');
  tick();
  assert.equal(band.children[0].textContent, '津波解除');
  tick();
  assert.equal(band.children[0].textContent, '津波情報');
  tick();
  assert.equal(band.children.length, 0);
  assert.equal(tick, null);

  state.layers.tsunami[0].event.serial = 2;
  state.layers.tsunami[0].payload.tsunamiFrames[0].updateKey = 'tsunami:2:c';
  apply();
  assert.equal(band.children[0].textContent, '津波解除');
});

test('長周期の階級行は地名列22字までで割り、2行ずつページ送りする', () => {
  // 22字は本文40px・ルビ20px (モノルビ) 化後の実レイアウト検証による
  // 上限: 観測点名プールの最悪の組み合わせが23字で行幅を超えた
  const pages = longPeriodPages([
    { type: 'class', level: '4', names: ['雫石町西根上駒木野', '奥州市水沢大鐘町', '登米市中田町', '大崎市古川大崎', '涌谷町新町裏', '青森市花園', '五所川原市栄町', '五戸町古舘'] },
  ]);
  assert.deepEqual(pages.map((page) => page.rows.map((row) => row.names)), [
    [['雫石町西根上駒木野', '奥州市水沢大鐘町'], ['登米市中田町', '大崎市古川大崎', '涌谷町新町裏']],
    [['青森市花園', '五所川原市栄町', '五戸町古舘']],
  ]);
  assert.deepEqual(pages.map((page) => page.rows.map((row) => row.first)), [[true, false], [false]]);
  for (const page of pages) {
    assert.equal(page.type, 'class');
    assert.equal(page.level, '4');
    for (const row of page.rows) {
      const characters = row.names.reduce((sum, name) => sum + [...name].length, 0) + row.names.length - 1;
      assert.ok(characters <= 22, `${row.names.join('　')} が22字を超える`);
    }
  }
});

test('長周期の見出し・説明行はそのまま1ページになり、22字を超える地名も途中で切らない', () => {
  const longName = 'あいうえおかきくけこさしすせそたちつてとなにぬね';
  assert.equal([...longName].length, 24);
  const pages = longPeriodPages([
    { type: 'heading', lines: ['見出し1', '見出し2'] },
    { type: 'note', lines: ['説明1', '説明2'] },
    { type: 'class', level: '2', names: [longName, '青森市花園'] },
  ]);
  assert.deepEqual(pages[0], { type: 'heading', lines: ['見出し1', '見出し2'] });
  assert.deepEqual(pages[1], { type: 'note', lines: ['説明1', '説明2'] });
  assert.deepEqual(pages[2].rows.map((row) => row.names), [[longName], ['青森市花園']]);
});

const loadAtlasLiveBand = () => {
  const vm = require('node:vm');
  const fs = require('node:fs');
  const element = () => ({ children: [], style: {}, textContent: '', classList: { add() {}, contains: () => false }, replaceChildren() { this.children = []; }, appendChild(child) { this.children.push(child); }, append(...children) { this.children.push(...children); } });
  const band = element();
  let tick;
  const sandbox = {
    document: { getElementById: (id) => id === 'atlas-intensity' ? band : null, createElement: element },
    setInterval(callback) { tick = callback; return 1; }, clearInterval() { tick = null; },
    setTimeout() {}, fetch: async () => ({ ok: false }),
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(require.resolve('../telop/atlas-live'), 'utf8'), sandbox);
  return { band, sandbox, tick: () => tick() };
};
const rubyOf = (span) => span.children.find((part) => typeof part !== 'string');

test('訓練の上部テロップ見出しに印を付け、通常フレームには付けない', () => {
  const { band, sandbox } = loadAtlasLiveBand();
  const state = (training) => ({ version: 1, display: {}, layers: { eew: [], tsunami: [], vertical: [], intensity: [{
    event: { id: training ? 'training-intensity' : 'normal-intensity', training, publishedAt: '2026-11-12T00:00:00Z' },
    payload: { render: { maxInt: '4', cityGroups: {} }, summaryFrames: [{ lines: ['震度速報'] }] },
  }] } });
  sandbox.applyAtlasSnapshot(state(true));
  assert.match(band.children[0].textContent, /【訓練】震度速報/);
  sandbox.applyAtlasSnapshot(state(false));
  assert.doesNotMatch(band.children[0].textContent, /【訓練】/);
});

test('震度行は細分区域名にもルビを付けて描く', () => {
  const { band, sandbox } = loadAtlasLiveBand();
  const state = { version: 1, display: {}, layers: { eew: [], tsunami: [], vertical: [], intensity: [{
    event: { id: 'groups', publishedAt: '2026-11-12T00:00:00Z' },
    payload: {
      render: { maxInt: '4', groups: { '4': ['宮城県北部'] }, cityReadings: { '宮城県北部': 'みやぎけんほくぶ' } },
      summaryFrames: [],
    },
  }] } };
  sandbox.applyAtlasSnapshot(JSON.parse(JSON.stringify(state)));
  const areas = band.children[0].children[1];
  const ruby = rubyOf(areas);
  assert.ok(ruby, '細分区域名にルビ要素が付く');
  assert.equal(ruby.textContent, '宮城県北部');
  assert.equal(ruby.children[0].textContent, 'みやぎけんほくぶ');
});

test('長周期の階級行は観測点名にルビを付けて描く', () => {
  const { band, sandbox } = loadAtlasLiveBand();
  const state = { version: 1, display: {}, layers: { eew: [], tsunami: [], vertical: [], intensity: [{
    event: { id: 'lg', publishedAt: '2026-11-12T00:00:00Z' },
    payload: {
      render: { maxInt: '4', cityGroups: {}, cityReadings: { '登米市中田町': 'とめしなかだちょう', '青森市花園': 'あおもりしはなぞの' } },
      summaryFrames: [],
      longPeriodFrames: [{ type: 'class', level: '3', names: ['登米市中田町', '青森市花園'] }],
    },
  }] } };
  sandbox.applyAtlasSnapshot(JSON.parse(JSON.stringify(state)));
  assert.equal(band.children.length, 1);
  const names = band.children[0].children[2];
  const ruby = rubyOf(names);
  assert.ok(ruby, '観測点名にルビ要素が付く');
  assert.equal(ruby.textContent, '登米市中田町');
  assert.equal(ruby.children[0].textContent, 'とめしなかだちょう');
});

test('札はルビなしのプレーンテキストで描く（震度・長周期・階級・津波・予想）', () => {
  const { band, sandbox, tick } = loadAtlasLiveBand();
  // 震度札: 「震度5強」をそのまま出す (弱・強にもルビを付けない)
  const intensityState = { version: 1, display: {}, layers: { eew: [], tsunami: [], vertical: [], intensity: [{
    event: { id: 'badge-intensity', publishedAt: '2026-11-12T00:00:00Z' },
    payload: {
      render: { maxInt: '5+', groups: { '5+': ['宮城県北部'] }, cityReadings: {} },
      summaryFrames: [],
    },
  }] } };
  sandbox.applyAtlasSnapshot(JSON.parse(JSON.stringify(intensityState)));
  const intensityBadge = band.children[0].children[0];
  assert.deepEqual(intensityBadge.children, ['震度5強']);
  // 長周期札: 「長周期地震動」「階級3」ともプレーン
  const lpState = { version: 1, display: {}, layers: { eew: [], tsunami: [], vertical: [], intensity: [{
    event: { id: 'badge-lp', publishedAt: '2026-11-12T00:00:00Z' },
    payload: {
      render: { maxInt: '4', cityGroups: {}, cityReadings: {} },
      summaryFrames: [],
      longPeriodFrames: [{ type: 'class', level: '3', names: ['登米市中田町'] }],
    },
  }] } };
  sandbox.applyAtlasSnapshot(JSON.parse(JSON.stringify(lpState)));
  const lpBadge = band.children[0].children[0];
  assert.deepEqual(lpBadge.children, ['長周期地震動']);
  const classBadge = band.children[0].children[1];
  assert.deepEqual(classBadge.children, ['階級3']);
  // 津波札: 一覧は種別ラベル、詳細の白札は「予想」ともプレーン
  const tsunamiState = { version: 1, display: {}, layers: { eew: [], vertical: [], intensity: [], tsunami: [{
    event: { id: 'badge-tsunami', publishedAt: '2026-11-12T00:00:00Z', serial: 1 },
    payload: {
      render: { major: [], warning: ['宮城県'], advisory: [] },
      tsunamiOverviewFrames: [{ overview: true, level: 'warning', label: '津波警報', additional: false, area: '宮城県', areas: ['宮城県'], readings: {} }],
      tsunamiFrames: [{ level: 'warning', label: '津波警報', additional: false, area: '宮城県', height: '3m', arrival: 'すぐ来る', hasHeight: true, hasArrival: true, readings: {} }],
    },
  }] } };
  sandbox.applyAtlasSnapshot(JSON.parse(JSON.stringify(tsunamiState)));
  const tsunamiBadge = band.children[0].children[0];
  assert.deepEqual(tsunamiBadge.children, ['津波警報']);
  // 津波警報の札は気象庁指針の警報色 #ff2800 に白文字
  assert.equal(tsunamiBadge.style.backgroundColor, '#ff2800');
  assert.equal(tsunamiBadge.style.color, '#fff');
  tick();
  const forecastBadge = band.children[1].children[0];
  assert.deepEqual(forecastBadge.children, ['予想']);
});

test('津波札の色は種別ごとの業界ルール（気象庁指針 表1-2）で描く', () => {
  const { band, sandbox } = loadAtlasLiveBand();
  const badgeOf = (level, label) => {
    const state = { version: 1, display: {}, layers: { eew: [], vertical: [], intensity: [], tsunami: [{
      event: { id: `badge-color-${level}`, publishedAt: '2026-11-12T00:00:00Z', serial: 1 },
      payload: {
        render: { major: [], warning: [], advisory: [] },
        tsunamiOverviewFrames: [{ overview: true, level, label, additional: false, area: '宮城県', areas: ['宮城県'], readings: {} }],
        tsunamiFrames: [],
      },
    }] } };
    sandbox.applyAtlasSnapshot(JSON.parse(JSON.stringify(state)));
    return band.children[0].children[0];
  };
  // 大津波警報: #c800ff に白文字
  const major = badgeOf('major', '大津波警報');
  assert.equal(major.style.backgroundColor, '#c800ff');
  assert.equal(major.style.color, '#fff');
  // 津波注意報: #faf500 に黒文字 (縁取りを外したため明るい札は黒文字)
  const advisory = badgeOf('advisory', '津波注意報');
  assert.equal(advisory.style.backgroundColor, '#faf500');
  assert.equal(advisory.style.color, '#111');
});

test('震度札の色は震度ごとに気象庁指針（表2-2）の色で描く', () => {
  const { band, sandbox } = loadAtlasLiveBand();
  const expected = {
    '1': ['#f2f2ff', '#111'],
    '2': ['#00aaff', '#fff'],
    '3': ['#0041ff', '#fff'],
    '4': ['#fae696', '#111'],
    '5-': ['#ffe600', '#111'],
    '5+': ['#ff9900', '#fff'],
    '6-': ['#ff2800', '#fff'],
    '6+': ['#a50021', '#fff'],
    '7': ['#b40068', '#fff'],
  };
  for (const [level, [background, color]] of Object.entries(expected)) {
    const state = { version: 1, display: {}, layers: { eew: [], tsunami: [], vertical: [], intensity: [{
      event: { id: `badge-level-${level}`, publishedAt: '2026-11-12T00:00:00Z' },
      payload: {
        render: { maxInt: level, groups: { [level]: ['宮城県北部'] }, cityReadings: {} },
        summaryFrames: [],
      },
    }] } };
    sandbox.applyAtlasSnapshot(JSON.parse(JSON.stringify(state)));
    const badge = band.children[0].children[0];
    assert.equal(badge.style.backgroundColor, background, `震度${level}の背景色`);
    assert.equal(badge.style.color, color, `震度${level}の文字色`);
  }
});

test('長周期の階級札は階級ごとに色を変える（検討会資料の素案カラー）', () => {
  const { band, sandbox } = loadAtlasLiveBand();
  const expected = {
    '1': ['#faf500', '#111', true],
    '2': ['#ff9900', '#111', true],
    '3': ['#ff4b00', '#fff', false],
    '4': ['#ff2800', '#fff', false],
  };
  for (const [level, [background, color, noOutline]] of Object.entries(expected)) {
    const state = { version: 1, display: {}, layers: { eew: [], tsunami: [], vertical: [], intensity: [{
      event: { id: `badge-lp-class-${level}`, publishedAt: '2026-11-12T00:00:00Z' },
      payload: {
        render: { maxInt: '4', cityGroups: {}, cityReadings: {} },
        summaryFrames: [],
        longPeriodFrames: [{ type: 'class', level, names: ['登米市中田町'] }],
      },
    }] } };
    sandbox.applyAtlasSnapshot(JSON.parse(JSON.stringify(state)));
    const classBadge = band.children[0].children[1];
    assert.equal(classBadge.style.backgroundColor, background, `階級${level}の背景色`);
    assert.equal(classBadge.style.color, color, `階級${level}の文字色`);
    assert.equal(classBadge.className.includes('atlas-badge-no-outline'), noOutline, `階級${level}の縁取り有無`);
  }
});

test('津波の一覧・詳細の区域名にルビを付ける', () => {
  const { band, sandbox, tick } = loadAtlasLiveBand();
  const readings = { '宮城県': 'みやぎけん' };
  const state = { version: 1, display: {}, layers: { eew: [], vertical: [], intensity: [], tsunami: [{
    event: { id: 'tsunami', publishedAt: '2026-11-12T00:00:00Z', serial: 1 },
    payload: {
      render: { major: [], warning: [], advisory: ['宮城県'] },
      tsunamiOverviewFrames: [{ overview: true, level: 'advisory', label: '津波注意報', additional: false, area: '宮城県', areas: ['宮城県'], readings }],
      tsunamiFrames: [{ level: 'advisory', label: '津波注意報', additional: false, area: '宮城県', height: '', arrival: '午後3時', hasHeight: false, hasArrival: true, readings }],
    },
  }] } };
  sandbox.applyAtlasSnapshot(JSON.parse(JSON.stringify(state)));
  const overviewRuby = rubyOf(band.children[0].children[1]);
  assert.ok(overviewRuby, '一覧の区域名にルビ要素が付く');
  assert.equal(overviewRuby.textContent, '宮城県');
  assert.equal(overviewRuby.children[0].textContent, 'みやぎけん');
  tick();
  const detailRuby = rubyOf(band.children[0].children[1]);
  assert.ok(detailRuby, '詳細の区域名にルビ要素が付く');
  assert.equal(detailRuby.textContent, '宮城県');
  assert.equal(detailRuby.children[0].textContent, 'みやぎけん');
});

test('震度行はモノルビのセグメントごとにルビを付けて描く', () => {
  const { band, sandbox } = loadAtlasLiveBand();
  const state = { version: 1, display: {}, layers: { eew: [], tsunami: [], vertical: [], intensity: [{
    event: { id: 'mono', publishedAt: '2026-11-12T00:00:00Z' },
    payload: {
      render: {
        maxInt: '4', cityGroups: { '4': ['登米市'] },
        cityReadings: { '登米市': 'とめし' },
        cityMonoReadings: { '登米市': [['登', 'と'], ['米', 'め'], ['市', 'し']] },
      },
      summaryFrames: [],
    },
  }] } };
  sandbox.applyAtlasSnapshot(JSON.parse(JSON.stringify(state)));
  const areas = band.children[0].children[1];
  // グループルビ (名前全体に1つのルビ) ではなく、1字ずつ3つのルビになる
  assert.equal(areas.children.length, 3);
  assert.deepEqual(areas.children.map((ruby) => ruby.textContent), ['登', '米', '市']);
  assert.deepEqual(areas.children.map((ruby) => ruby.children[0].textContent), ['と', 'め', 'し']);
});

test('津波の一覧はモノルビのセグメントごとにルビを付けて描く', () => {
  const { band, sandbox } = loadAtlasLiveBand();
  const readings = { '宮城県': 'みやぎけん' };
  const monoReadings = { '宮城県': [['宮', 'みや'], ['城', 'ぎ'], ['県', 'けん']] };
  const state = { version: 1, display: {}, layers: { eew: [], vertical: [], intensity: [], tsunami: [{
    event: { id: 'tsunami-mono', publishedAt: '2026-11-12T00:00:00Z', serial: 1 },
    payload: {
      render: { major: [], warning: [], advisory: ['宮城県'] },
      tsunamiOverviewFrames: [{ overview: true, level: 'advisory', label: '津波注意報', additional: false, area: '宮城県', areas: ['宮城県'], readings, monoReadings }],
      tsunamiFrames: [],
    },
  }] } };
  sandbox.applyAtlasSnapshot(JSON.parse(JSON.stringify(state)));
  const area = band.children[0].children[1];
  assert.equal(area.children.length, 3);
  assert.deepEqual(area.children.map((ruby) => ruby.textContent), ['宮', '城', '県']);
  assert.deepEqual(area.children.map((ruby) => ruby.children[0].textContent), ['みや', 'ぎ', 'けん']);
});

test('津波観測は紫札+観測点名と、時刻+高さの2行で描く', () => {
  const { band, sandbox } = loadAtlasLiveBand();
  const state = { version: 1, display: {}, layers: { eew: [], vertical: [], intensity: [], tsunami: [{
    event: { id: 'tsunami-obs', publishedAt: '2026-11-12T00:00:00Z', serial: 1 },
    payload: {
      render: { major: [], warning: [], advisory: [] },
      tsunamiOverviewFrames: [],
      tsunamiObservationFrames: [{ observation: true, station: '根室市花咲', timeLabel: '午前10時30分', heightLabel: '30cm', readings: { '根室市花咲': 'ねむろしはなさき' } }],
      tsunamiFrames: [],
    },
  }] } };
  sandbox.applyAtlasSnapshot(JSON.parse(JSON.stringify(state)));
  assert.equal(band.children.length, 2);
  const [line1, line2] = band.children;
  const badge = line1.children[0];
  assert.equal(badge.children.join(''), '津波観測');
  assert.ok(badge.className.includes('atlas-tsunami-observation-badge'));
  const nameRuby = rubyOf(line1.children[1]);
  assert.ok(nameRuby, '観測点名にルビ要素が付く');
  assert.equal(nameRuby.textContent, '根室市花咲');
  assert.equal(line2.children[1].textContent, '午前10時30分　30cm');
});

test('津波の変更フレームは見出しとルビ付き区域名の2行で描く', () => {
  const { band, sandbox } = loadAtlasLiveBand();
  const state = { version: 1, display: {}, layers: { eew: [], vertical: [], intensity: [], tsunami: [{
    event: { id: 'tsunami-change', publishedAt: '2026-11-12T00:00:00Z', serial: 2 },
    payload: {
      render: { major: [], warning: [], advisory: ['区域A'] },
      tsunamiOverviewFrames: [],
      tsunamiChangeFrames: [{
        change: true, oldLevel: 'warning', newLevel: 'advisory',
        headline: '津波警報が津波注意報に変更', area: '区域A', areas: ['区域A'],
        readings: { 区域A: 'くいきえー' }, monoReadings: { 区域A: [['区', 'く'], ['域', 'いき'], ['A', 'えー']] },
      }],
      tsunamiObservationFrames: [], tsunamiFrames: [],
    },
  }] } };
  sandbox.applyAtlasSnapshot(JSON.parse(JSON.stringify(state)));
  assert.equal(band.children.length, 2);
  assert.equal(band.children[0].textContent, '津波警報が津波注意報に変更');
  const name = rubyOf(band.children[1]);
  assert.ok(name, '変更区域名にルビ要素が付く');
  assert.equal(name.textContent, '区');
  assert.equal(name.children[0].textContent, 'く');
});

test('長周期の階級行は訓練時に20字までで割る', () => {
  // 訓練時はバッジが【訓練】分だけ広がり、22字では右端が切れる
  // (実レイアウト計測 2026-11-19)。訓練時は20字に狭める。
  const pages = longPeriodPages([
    { type: 'class', level: '3', training: true, names: ['神奈川県横浜市西区', '鹿児島県鹿児島市', '那覇市'] },
  ]);
  assert.deepEqual(pages[0].rows[0].names, ['神奈川県横浜市西区', '鹿児島県鹿児島市']);
  for (const page of pages) {
    assert.equal(page.training, true);
    for (const row of page.rows) {
      const characters = row.names.reduce((sum, name) => sum + [...name].length, 0) + row.names.length - 1;
      assert.ok(characters <= 20, `${row.names.join('　')} が20字を超える`);
    }
  }
});
