const test = require('node:test');
const assert = require('node:assert/strict');
const { composeAtlasView } = require('../telop/atlas-live');

const kinds = ['eew', 'tsunami', 'intensity', 'vertical'];
function snapshot(active) {
  const layers = Object.fromEntries(kinds.map((kind) => [kind, active.includes(kind) ? [
    { kind, event: { id: `${kind}-1`, publishedAt: '2026-11-09T10:00:00Z', serial: 1 }, payload: {
      render: kind === 'eew' ? { hypocenterName: '能登' } : kind === 'tsunami' ? { major: ['石川県'], warning: ['富山県'] } : kind === 'intensity' ? { maxInt: '6+', cityGroups: { '6+': ['輪島市', '珠洲市'] } } : {},
      lines: kind === 'intensity' ? ['震度6強・石川県', '石川県珠洲市'] : [],
      text: kind === 'vertical' ? '石川県で震度6強' : '',
    } },
  ] : []]));
  return { version: 1, layers };
}

test('all 16 combinations compose without one information kind clearing another', () => {
  for (let mask = 0; mask < 16; mask += 1) {
    const active = kinds.filter((_, bit) => mask & (1 << bit));
    const view = composeAtlasView(snapshot(active));
    assert.equal(Boolean(view.eew), active.includes('eew'));
    assert.deepEqual(view.tsunami.major, active.includes('tsunami') ? ['石川県'] : []);
    assert.equal(view.intensityLines.length, active.includes('intensity') ? 2 : 0);
    assert.equal(Boolean(view.intensity), active.includes('intensity'));
    assert.equal(Boolean(view.headline), active.includes('vertical'));
  }
});

test('updates and removal in one layer preserve all other rendered layers', () => {
  const state = snapshot(kinds);
  state.layers.tsunami = [];
  state.layers.intensity[0].payload.lines = ['震度5強・新潟県'];
  const view = composeAtlasView(state);
  assert.equal(view.eew.event.id, 'eew-1');
  assert.deepEqual(view.tsunami.major, []);
  assert.deepEqual(view.intensityLines.map((line) => line.text), ['震度5強・新潟県']);
  assert.deepEqual(view.intensity.cityGroups['6+'], ['輪島市', '珠洲市']);
  assert.equal(view.headline.text, '石川県で震度6強');
});

test('tsunami regions from independent active events are combined by category', () => {
  const state = snapshot(['tsunami']);
  state.layers.tsunami.push({ kind: 'tsunami', event: { id: 'tsunami-2', publishedAt: '2026-11-09T10:01:00Z' }, payload: { render: { major: [], warning: ['新潟県'], advisory: ['佐渡'] } } });
  assert.deepEqual(composeAtlasView(state).tsunami, { major: ['石川県'], warning: ['富山県', '新潟県'], advisory: ['佐渡'] });
});
