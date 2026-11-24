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

test('適応秒数は表示中のブロックから計算し、0.5秒単位に丸める', () => {
  const { pageSeconds } = require('../telop/atlas-live');
  const block = (lines, body, ruby = 0, locations = 0, pairs = 0) => ({ lines, body, ruby, locations, pairs });
  assert.equal(pageSeconds([]), 0);
  assert.equal(pageSeconds([block(1, 14)]), 5);
  assert.equal(pageSeconds([block(2, 31)]), 7.5);
  assert.equal(pageSeconds([block(2, 36, 24, 8)]), 11);
  // 合計105字、最大31字。丸める前は 4.75 + 31/6 + (74/6)/4 = 13秒。
  assert.equal(pageSeconds([block(2, 25), block(2, 31), block(2, 25), block(2, 24)]), 12);
  assert.equal(pageSeconds([block(2, 31, 0, 0, 1)]), 8);
  assert.equal(pageSeconds([block(1, 18), block(2, 11)]), 6.5);
});

const quake = (id, pages, options = {}) => ({
  event: { id, ...options.event },
  payload: {
    render: { maxInt: '4', ...options.render },
    summaryFrames: pages.map((text) => ({ lines: [text] })),
    longPeriodFrames: options.longPeriodFrames || [],
  },
});

test('地震は先着3件を表示し、続報の震度や並び順が変わっても4件目は空きを待つ', () => {
  const { band, headline, sandbox, tick } = loadAtlasLiveBand();
  const state = createAtlasSnapshot();
  const quakeA = quake('a', ['A']);
  const quakeB = quake('b', ['B1', 'B2']);
  const quakeC = quake('c', ['C1', 'C2']);
  const quakeD = quake('d', ['D'], { render: { maxInt: '7' } });
  state.layers.intensity = [quakeA, quakeB, quakeC];
  state.layers.vertical = [quakeA, quakeB, quakeC, quakeD].map(({ event }) =>
    ({ event, payload: { text: event.id } }));
  const apply = () => sandbox.applyAtlasSnapshot(structuredClone(state));
  const shown = () => band.children.map((line) => line.textContent);
  apply();
  assert.deepEqual(shown(), ['A', 'B1', 'C1']);
  assert.equal(headline.textContent, 'a');
  assert.equal(headline.style.display, 'block');

  const revisedB = quake('b', ['B1', 'B続報'], { event: { serial: 2 }, render: { maxInt: '6+' } });
  state.layers.intensity = [quakeD, revisedB, quakeC, quakeA];
  apply();
  assert.deepEqual(shown(), ['A', 'B1', 'C1']);
  tick();
  assert.deepEqual(shown(), ['A', 'B1', 'C2']);
  assert.equal(headline.textContent, 'a');
  tick();
  assert.deepEqual(shown(), ['B続報', 'C1', 'D']);
  assert.equal(headline.textContent, 'b');
  tick();
  assert.deepEqual(shown(), ['B1', 'C2', 'D']);
  tick();
  assert.deepEqual(shown(), ['B続報']);
  tick();
  assert.deepEqual(shown(), []);
  assert.equal(headline.textContent, '');
  apply();
  assert.deepEqual(shown(), []);
});

test('表示を終えた地震の続報も、使用中の3ブロックに割り込まない', () => {
  const { band, sandbox, tick } = loadAtlasLiveBand();
  const state = createAtlasSnapshot();
  const apply = () => sandbox.applyAtlasSnapshot(structuredClone(state));
  const shown = () => band.children.map((line) => line.textContent);
  state.layers.intensity = [quake('a', ['A']), quake('b', ['B1', 'B2']), quake('c', ['C1', 'C2']), quake('d', ['D1', 'D2'])];
  apply();
  tick();
  tick();
  assert.deepEqual(shown(), ['B1', 'C1', 'D1']);
  state.layers.intensity[0] = quake('a', ['A続報'], { event: { serial: 2 } });
  apply();
  tick();
  assert.deepEqual(shown(), ['B2', 'C2', 'D2']);
  tick();
  assert.deepEqual(shown(), ['A続報', 'D1']);
});

test('同一地震の新電文はページ境界で全ページを2周し、再受信では再開しない', () => {
  const { band, sandbox, tick, delay } = loadAtlasLiveBand();
  const state = createAtlasSnapshot();
  state.layers.intensity = [quake('a', ['概要', '震源'])];
  const apply = () => sandbox.applyAtlasSnapshot(structuredClone(state));
  const firstLine = () => band.children[0]?.textContent;
  apply();
  tick();
  assert.equal(firstLine(), '震源');
  state.layers.intensity[0].event.serial = 2;
  apply();
  assert.equal(firstLine(), '震源');
  for (const expected of ['概要', '震源', '概要', '震源', undefined]) {
    tick();
    assert.equal(firstLine(), expected);
  }
  apply();
  assert.equal(firstLine(), undefined);
  assert.equal(delay(), undefined);
  state.layers.intensity[0].event.serial = 3;
  apply();
  assert.equal(firstLine(), '概要');
});

test('地震ブロックは概要・震度行・長周期ページの順に表示する', () => {
  const { band, sandbox, tick } = loadAtlasLiveBand();
  const state = createAtlasSnapshot();
  state.layers.intensity = [quake('a', ['概要'], {
    render: { groups: { '4': ['宮城県北部'], '3': ['宮城県南部'], '2': ['宮城県中部'] } },
    longPeriodFrames: [{ type: 'heading', lines: ['長周期の概要'] }],
  })];
  sandbox.applyAtlasSnapshot(state);
  assert.equal(band.children[0].textContent, '概要');
  tick();
  assert.equal(band.children.length, 2);
  assert.equal(band.children[0].children[1].textContent, '宮城県北部');
  tick();
  assert.equal(band.children.length, 1);
  assert.equal(band.children[0].children[1].textContent, '宮城県中部');
  tick();
  assert.equal(band.children[0].textContent, '長周期の概要');
});

test('津波は地震と同時に表示し、津波が消えたページ境界で地震を詰める', () => {
  const { band, sandbox, tick } = loadAtlasLiveBand();
  const state = createAtlasSnapshot();
  state.layers.intensity = [quake('a', ['地震1', '地震2', '地震3'])];
  const apply = () => sandbox.applyAtlasSnapshot(structuredClone(state));
  const shown = () => band.children.map((line) => line.textContent);
  apply();
  state.layers.tsunami = [{ event: { id: 't' }, payload: { tsunamiFrames: [{ level: 'notice', label: '津波' }] } }];
  apply();
  assert.deepEqual(shown(), ['地震1']);
  tick();
  assert.deepEqual(shown(), ['津波', '地震2']);
  state.layers.tsunami = [];
  apply();
  assert.deepEqual(shown(), ['津波', '地震2']);
  tick();
  assert.deepEqual(shown(), ['地震3']);
});

test('津波と地震3件が同時に各2行のページを表示できる', () => {
  const { band, sandbox, delay } = loadAtlasLiveBand();
  const state = createAtlasSnapshot();
  state.layers.intensity = ['a', 'b', 'c'].map((id) => {
    const entry = quake(id, []);
    entry.payload.summaryFrames = [{ lines: [id + 'の'.repeat(14), '地'.repeat(16)] }];
    return entry;
  });
  state.layers.tsunami = [{ event: { id: 't' }, payload: { tsunamiObservationFrames: [{
    observation: true, station: '観測点', timeLabel: '午前1時', heightLabel: '2m',
  }] } }];
  sandbox.applyAtlasSnapshot(state);
  assert.equal(band.children.length, 8);
  assert.deepEqual(band.children.map((line) => 'data-atlas-second-line' in line.attributes),
    [false, true, false, true, false, true, false, true]);
  assert.equal(band.children[0].textContent, '津波観測観測点');
  assert.equal(delay(), 12000);
});

test('ページ上の実測対象は表示する本文・ルビ・地点と値の組を使う', () => {
  const { sandbox, delay } = loadAtlasLiveBand();
  const state = createAtlasSnapshot();
  state.layers.tsunami = [{ event: { id: 't' }, payload: { tsunamiObservationFrames: [{
    observation: true, station: '甲乙丙丁戊己庚辛', readings: { '甲乙丙丁戊己庚辛': 'あいうえおかきくけこさしすせそたちつてと' },
    timeLabel: '午前1時', heightLabel: '2.5m　・到達',
  }] } }];
  sandbox.applyAtlasSnapshot(state);
  // 2行。津波観測4字 + 観測点8字 + 時刻4字 + 高さ・到達6字。
  // 読み20字、1地点1組。不可視の2行目の札と区切りは数えない。
  assert.equal(delay(), 7500);
});

test('EEWは警報ボックスの初出だけページを2秒延長し、14秒で止める', () => {
  const { band, sandbox, tick, delay, elapse } = loadAtlasLiveBand();
  const state = createAtlasSnapshot();
  state.layers.intensity = [quake('a', ['あ'.repeat(100), '短文'])];
  const warning = (id, isWarning = true, serial = 1) =>
    ({ event: { id, serial }, payload: { render: { isWarning, maxInt: '4' } } });
  const apply = () => sandbox.applyAtlasSnapshot(structuredClone(state));
  apply();
  assert.equal(delay(), 12000);
  elapse(1000);
  state.layers.eew = [warning('eew-a', false)];
  apply();
  assert.equal(delay(), 11000);
  state.layers.eew = [warning('eew-a')];
  apply();
  assert.equal(delay(), 13000);
  state.layers.eew = [warning('eew-b')];
  apply();
  assert.equal(delay(), 13000);
  tick();
  assert.equal(band.children[0].textContent, '短文');
  assert.equal(delay(), 5000);
  state.layers.eew = [warning('eew-a', true, 2)];
  apply();
  assert.equal(delay(), 5000);
  state.layers.eew = [warning('eew-c')];
  apply();
  assert.equal(delay(), 7000);
  state.layers.eew = [warning('eew-c', true, 2)];
  apply();
  assert.equal(delay(), 7000);
});

test('震度情報の震源行をグループルビで描く', () => {
  const vm = require('node:vm');
  const fs = require('node:fs');
  const element = () => ({ children: [], style: {}, textContent: '', setAttribute() {}, replaceChildren() { this.children = []; }, appendChild(child) { this.children.push(child); }, append(...children) { this.children.push(...children); } });
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

test('津波の続報は全フレームを更新し、ページ位置を維持して範囲外は末尾に丸める', () => {
  const { band, sandbox, tick } = loadAtlasLiveBand();
  const state = createAtlasSnapshot();
  const detail = (area, arrival) => ({
    level: 'advisory', label: '津波注意報', area, arrival, hasArrival: Boolean(arrival),
  });
  const payload = {
    tsunamiOverviewFrames: [{ ...detail('区域A　区域B'), overview: true, areas: ['区域A', '区域B'] }],
    tsunamiFrames: [detail('区域A'), detail('区域B', '午後3時30分')],
  };
  state.layers.tsunami = [{ event: { id: 'tsunami', serial: 1 }, payload }];
  const apply = () => sandbox.applyAtlasSnapshot(structuredClone(state));
  const area = () => band.children[0].children[1].textContent;
  apply();
  assert.equal(area(), '区域A　区域B');
  tick();
  assert.equal(area(), '区域A');
  assert.equal(band.children.length, 1);
  tick();
  assert.equal(area(), '区域B');

  state.layers.tsunami[0].event.serial = 2;
  payload.tsunamiFrames = [detail('区域A', '午後4時'), detail('区域B', '午後5時')];
  apply();
  assert.match(band.children[1].textContent, /午後3時30分/);
  tick();
  assert.equal(area(), '区域B');
  assert.match(band.children[1].textContent, /午後5時/);
  payload.tsunamiFrames.pop();
  apply();
  tick();
  assert.equal(area(), '区域A');
  tick();
  assert.equal(area(), '区域A　区域B');
});

test('同じ津波のフレームは2周を超えて表示し、情報がなくなった境界で終了する', () => {
  const { band, sandbox, tick, delay } = loadAtlasLiveBand();
  const state = createAtlasSnapshot();
  state.layers.tsunami = [{ event: { id: 'tsunami' }, payload: { tsunamiFrames: [
    { level: 'notice', label: '津波解除' },
    { level: 'notice', label: '津波情報' },
  ] } }];
  sandbox.applyAtlasSnapshot(structuredClone(state));
  assert.equal(band.children[0].textContent, '津波解除');
  for (const expected of ['津波情報', '津波解除', '津波情報', '津波解除', '津波情報']) {
    tick();
    assert.equal(band.children[0].textContent, expected);
  }
  state.layers.tsunami = [];
  sandbox.applyAtlasSnapshot(state);
  assert.equal(band.children[0].textContent, '津波情報');
  tick();
  assert.equal(band.children.length, 0);
  assert.equal(delay(), undefined);
});

test('長周期の階級行は地名列28字までで割り、1行ずつページ送りする', () => {
  // 28字は札を別行にした地名行 (行幅いっぱい) の実レイアウト検証による上限
  const pages = longPeriodPages([
    { type: 'class', level: '4', names: ['雫石町西根上駒木野', '奥州市水沢大鐘町', '登米市中田町', '大崎市古川大崎', '涌谷町新町裏', '青森市花園', '五所川原市栄町', '五戸町古舘'] },
  ]);
  assert.deepEqual(pages.map((page) => page.rows.map((row) => row.names)), [
    [['雫石町西根上駒木野', '奥州市水沢大鐘町', '登米市中田町']],
    [['大崎市古川大崎', '涌谷町新町裏', '青森市花園', '五所川原市栄町']],
    [['五戸町古舘']],
  ]);
  assert.deepEqual(pages.map((page) => page.rows.map((row) => row.first)), [[true], [false], [false]]);
  for (const page of pages) {
    assert.equal(page.type, 'class');
    assert.equal(page.level, '4');
    for (const row of page.rows) {
      const characters = row.names.reduce((sum, name) => sum + [...name].length, 0) + row.names.length - 1;
      assert.ok(characters <= 28, `${row.names.join('　')} が28字を超える`);
    }
  }
});

test('長周期の見出し・説明行はそのまま1ページになり、28字を超える地名も途中で切らない', () => {
  const longName = 'あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめも';
  assert.equal([...longName].length, 35);
  const pages = longPeriodPages([
    { type: 'heading', lines: ['見出し1', '見出し2'] },
    { type: 'note', lines: ['説明1', '説明2'] },
    { type: 'class', level: '2', names: [longName, '青森市花園'] },
  ]);
  assert.deepEqual(pages[0], { type: 'heading', lines: ['見出し1', '見出し2'] });
  assert.deepEqual(pages[1], { type: 'note', lines: ['説明1', '説明2'] });
  assert.deepEqual(pages[2].rows.map((row) => row.names), [[longName]]);
  assert.deepEqual(pages[3].rows.map((row) => row.names), [['青森市花園']]);
});

const loadAtlasLiveBand = () => {
  const vm = require('node:vm');
  const fs = require('node:fs');
  const element = (tag = 'div') => ({
    tagName: tag.toUpperCase(), children: [], style: {}, className: '', attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; },
    get textContent() { return this.content + this.children.map((child) => typeof child === 'string' ? child : child.textContent).join(''); },
    set textContent(value) { this.content = value; this.children = []; },
    content: '',
    replaceChildren() { this.textContent = ''; },
    appendChild(child) { this.children.push(child); },
    append(...children) { this.children.push(...children); },
  });
  const band = element();
  const headline = element();
  let now = 0;
  let timer;
  let nextId = 0;
  const sandbox = {
    document: { getElementById: (id) => ({ 'atlas-intensity': band, 'atlas-headline': headline }[id] || null), createElement: element },
    Date: class extends Date { static now() { return now; } },
    renderEEW() {}, renderEEWUpdate() {},
    setTimeout(callback, delay) {
      const id = ++nextId;
      if (delay >= 5000 && callback.name !== 'advanceTsunamiSuper') timer = { callback, at: now + delay, id };
      return id;
    },
    clearTimeout(id) { if (timer?.id === id) timer = undefined; },
    fetch: async () => ({ ok: false }),
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(require.resolve('../telop/atlas-live'), 'utf8'), sandbox);
  return {
    band, headline, sandbox,
    delay: () => timer && timer.at - now,
    elapse: (ms) => { now += ms; },
    tick() {
      assert.ok(timer, 'ページ送りの締切');
      const { at, callback } = timer;
      timer = undefined;
      now = at;
      callback();
    },
  };
};
const rubyBase = (ruby) => ruby.textContent.slice(0, -ruby.children[0].textContent.length);
const rubyOf = (span) => span.children.find((part) => typeof part !== 'string');

test('訓練の上部テロップ見出しに印を付け、通常フレームには付けない', () => {
  const { band, sandbox, tick } = loadAtlasLiveBand();
  const state = (training) => ({ version: 1, display: {}, layers: { eew: [], tsunami: [], vertical: [], intensity: [{
    event: { id: training ? 'training-intensity' : 'normal-intensity', training, publishedAt: '2026-11-12T00:00:00Z' },
    payload: { render: { maxInt: '4', cityGroups: {} }, summaryFrames: [{ lines: ['震度速報'] }] },
  }] } });
  sandbox.applyAtlasSnapshot(state(true));
  assert.match(band.children[0].textContent, /【訓練】震度速報/);
  sandbox.applyAtlasSnapshot(state(false));
  tick();
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
  assert.equal(rubyBase(ruby), '宮城県北部');
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
  // 1行目=札の行 (長周期札+階級札)、2行目=地名の行。
  assert.equal(band.children.length, 2);
  assert.ok(band.children[0].children[1].className.includes('atlas-longperiod-class-badge'));
  const names = band.children[1].children[0];
  const ruby = rubyOf(names);
  assert.ok(ruby, '観測点名にルビ要素が付く');
  assert.equal(rubyBase(ruby), '登米市中田町');
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
  const badgeText = (badge) => badge.children.map((part) => typeof part === 'string' ? part : part.textContent).join('');
  const intensityBadge = band.children[0].children[0];
  assert.equal(intensityBadge.children.length, 1);
  assert.equal(intensityBadge.children[0].className, 'atlas-badge-text');
  assert.equal(badgeText(intensityBadge), '震度5強');
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
  tick();
  const lpBadge = band.children[0].children[0];
  assert.equal(badgeText(lpBadge), '長周期地震動');
  const classBadge = band.children[0].children[1];
  assert.equal(badgeText(classBadge), '階級3');
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
  tick();
  const tsunamiBadge = band.children[0].children[0];
  assert.equal(badgeText(tsunamiBadge), '津波警報');
  // 津波警報の札は気象庁指針の警報色 #ff2800 に白文字
  assert.equal(tsunamiBadge.style.backgroundColor, '#ff2800');
  assert.equal(tsunamiBadge.style.color, '#fff');
  tick();
  const forecastBadge = band.children[1].children[0];
  assert.equal(badgeText(forecastBadge), '予想');
});

test('津波札の色は種別ごとの業界ルール（気象庁指針 表1-2）で描く', () => {
  const badgeOf = (level, label) => {
    const { band, sandbox } = loadAtlasLiveBand();
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
    const { band, sandbox } = loadAtlasLiveBand();
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
  const expected = {
    '1': ['#faf500', '#111', true],
    '2': ['#ff9900', '#111', true],
    '3': ['#ff4b00', '#fff', false],
    '4': ['#ff2800', '#fff', false],
  };
  for (const [level, [background, color, noOutline]] of Object.entries(expected)) {
    const { band, sandbox } = loadAtlasLiveBand();
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
  assert.equal(rubyBase(overviewRuby), '宮城県');
  assert.equal(overviewRuby.children[0].textContent, 'みやぎけん');
  tick();
  const detailRuby = rubyOf(band.children[0].children[1]);
  assert.ok(detailRuby, '詳細の区域名にルビ要素が付く');
  assert.equal(rubyBase(detailRuby), '宮城県');
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
  assert.deepEqual(areas.children.map(rubyBase), ['登', '米', '市']);
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
  assert.deepEqual(area.children.map(rubyBase), ['宮', '城', '県']);
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
  assert.equal(badge.children.map((part) => typeof part === 'string' ? part : part.textContent).join(''), '津波観測');
  assert.ok(badge.className.includes('atlas-tsunami-observation-badge'));
  const nameRuby = rubyOf(line1.children[1]);
  assert.ok(nameRuby, '観測点名にルビ要素が付く');
  assert.equal(rubyBase(nameRuby), '根室市花咲');
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
  assert.equal(rubyBase(name), '区');
  assert.equal(name.children[0].textContent, 'く');
});

test('長周期の階級行は訓練時も同じ28字で割る', () => {
  // 札は別行のため、【訓練】が付いても地名行の幅は変わらない。
  const pages = longPeriodPages([
    { type: 'class', level: '3', training: true, names: ['神奈川県横浜市西区', '鹿児島県鹿児島市', '那覇市'] },
  ]);
  assert.deepEqual(pages[0].rows[0].names, ['神奈川県横浜市西区', '鹿児島県鹿児島市', '那覇市']);
  for (const page of pages) {
    assert.equal(page.training, true);
    for (const row of page.rows) {
      const characters = row.names.reduce((sum, name) => sum + [...name].length, 0) + row.names.length - 1;
      assert.ok(characters <= 28, `${row.names.join('　')} が28字を超える`);
    }
  }
});
