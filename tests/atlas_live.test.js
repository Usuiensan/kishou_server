const test = require('node:test');
const assert = require('node:assert/strict');
const { staleSources, syncTsunamiBlinkClock, eewVisibility, composeAtlasView, longPeriodPages } = require('../telop/atlas-live');
const { createAtlasSnapshot } = require('../lib/atlasData');

test('testModeはスナップショットからビューへ伝播する', () => {
  assert.equal(composeAtlasView(createAtlasSnapshot()).testMode, false);
  assert.equal(composeAtlasView({ ...createAtlasSnapshot(), testMode: true }).testMode, true);
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

test('同一地震の続報は変更行・追加地域・震度変更だけにする', () => {
  const { earthquakeDelta } = require('../telop/atlas-live');
  const previous = { intensity: { cityGroups: { '4': ['A', 'B'] } }, summaryFrames: [{ lines: ['時刻', '津波注意'] }] };
  const current = { intensity: { cityGroups: { '4': ['A', 'C'], '3': ['B'] } }, summaryFrames: [{ lines: ['時刻', '津波なし'] }] };
  const delta = earthquakeDelta(current, previous);
  assert.deepEqual(delta.intensity.cityGroups, { '4': ['C'], '3': ['B'] });
  assert.deepEqual(delta.summaryFrames, [{ lines: ['津波なし'] }]);
  assert.deepEqual(earthquakeDelta(current, current).summaryFrames, []);
  assert.deepEqual(earthquakeDelta(current, current).intensity.cityGroups, { '4': [], '3': [] });
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

test('長周期の階級行は地名列13字までで割り、2行ずつページ送りする', () => {
  // 実フレームで右端で切れた観測点の組 (25字割りでは地名の途中で欠けた)
  // 13字は本文36px・ルビ30px化後の実レイアウト検証による上限:
  // 14字では「大崎市古川大崎＋涌谷町新町裏」が列幅 (752.4px) を超えた
  const pages = longPeriodPages([
    { type: 'class', level: '4', names: ['雫石町西根上駒木野', '奥州市水沢大鐘町', '登米市中田町', '大崎市古川大崎', '涌谷町新町裏', '青森市花園', '五所川原市栄町', '五戸町古舘'] },
  ]);
  assert.deepEqual(pages.map((page) => page.rows.map((row) => row.names)), [
    [['雫石町西根上駒木野'], ['奥州市水沢大鐘町']],
    [['登米市中田町'], ['大崎市古川大崎']],
    [['涌谷町新町裏', '青森市花園'], ['五所川原市栄町', '五戸町古舘']],
  ]);
  assert.deepEqual(pages.map((page) => page.rows.map((row) => row.first)), [[true, false], [false, false], [false, false]]);
  for (const page of pages) {
    assert.equal(page.type, 'class');
    assert.equal(page.level, '4');
    for (const row of page.rows) {
      const characters = row.names.reduce((sum, name) => sum + [...name].length, 0) + row.names.length - 1;
      assert.ok(characters <= 13, `${row.names.join('　')} が13字を超える`);
    }
  }
});

test('長周期の見出し・説明行はそのまま1ページになり、13字を超える地名も途中で切らない', () => {
  const longName = 'あいうえおかきくけこさしすせそた';
  assert.equal([...longName].length, 16);
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

test('津波の一覧・詳細の区域名にルビを付けて描く', () => {
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
        maxInt: '4', groups: { '4': ['宮城県北部'] },
        cityReadings: { '宮城県北部': 'みやぎけんほくぶ' },
        cityMonoReadings: { '宮城県北部': [['宮', 'みや'], ['城', 'ぎ'], ['県', 'けん'], ['北', 'ほく'], ['部', 'ぶ']] },
      },
      summaryFrames: [],
    },
  }] } };
  sandbox.applyAtlasSnapshot(JSON.parse(JSON.stringify(state)));
  const areas = band.children[0].children[1];
  // グループルビ (名前全体に1つのルビ) ではなく、1字ずつ5つのルビになる
  assert.equal(areas.children.length, 5);
  assert.deepEqual(areas.children.map((ruby) => ruby.textContent), ['宮', '城', '県', '北', '部']);
  assert.deepEqual(areas.children.map((ruby) => ruby.children[0].textContent), ['みや', 'ぎ', 'けん', 'ほく', 'ぶ']);
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
