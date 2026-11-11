const test = require('node:test');
const assert = require('node:assert/strict');
const { staleSources, syncTsunamiBlinkClock, eewVisibility } = require('../telop/atlas-live');

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
  let tick;
  const sandbox = {
    document: { getElementById: (id) => id === 'atlas-intensity' ? band : null, createElement: element },
    setInterval(callback) { tick = callback; return 1; }, clearInterval() { tick = null; },
    setTimeout() {}, fetch: async () => ({ ok: false }),
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(require.resolve('../telop/atlas-live'), 'utf8'), sandbox);
  const state = { version: 1, layers: { eew: [], tsunami: [], vertical: [], intensity: [{ event: { id: 'new', publishedAt: '2026-11-12T00:00:00Z' }, payload: { render: { maxInt: '4', cityGroups: {} }, summaryFrames: [{ lines: ['最新'] }] } }] } };
  const apply = () => sandbox.applyAtlasSnapshot(JSON.parse(JSON.stringify(state)));
  apply();
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
  assert.equal(band.children.length, 0);
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
