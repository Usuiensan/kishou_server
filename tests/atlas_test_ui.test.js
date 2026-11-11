const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { ingestTestEvents } = require('../tools/atlas_ingest');
const { createAtlasSnapshot } = require('../lib/atlasData');

test('状態更新中も適用前のレイアウト選択を保持する', () => {
  const page = fs.readFileSync('tools/atlas_test_ui.html', 'utf8');
  const script = page.match(/<script>([\s\S]*?)<\/script>/)[1];
  const elements = {};
  const element = (id) => elements[id] ||= {
    value: '', innerHTML: '', textContent: '', classList: { toggle() {} }, append() {},
  };
  const context = { document: { getElementById: element, createTextNode() {}, createElement: () => ({}) },
    fetch: () => new Promise(() => {}), setInterval() {} };
  vm.runInNewContext(script, context);
  const status = { ingest: { atlasIIConfig: { activeLayout: 'full', layouts: { full: [], reverseL: [] } } } };
  context.updateControls(status);
  element('layout').value = 'reverseL';
  context.updateControls(status);
  assert.equal(element('layout').value, 'reverseL');
});

test('津波レベルボタンは実際のbulletinを送信し、ingestTestEventsで置換できる', async () => {
  const page = fs.readFileSync('tools/atlas_test_ui.html', 'utf8');
  const script = page.match(/<script>([\s\S]*?)<\/script>/)[1];
  const elements = {};
  const element = (id) => elements[id] ||= {
    value: '', innerHTML: '', textContent: '', selectedOptions: [{ value: '100', textContent: '北海道太平洋沿岸東部' }],
    classList: { toggle() {} }, append() {},
  };
  const requests = [];
  const context = { document: { getElementById: element, createTextNode() {}, createElement: () => ({}) },
    fetch: async (url, options = {}) => {
      if (options.method === 'POST') requests.push({ url, body: JSON.parse(options.body) });
      return { ok: true, json: async () => ({ ingest: { display: {}, atlasIIConfig: { layouts: {} }, activeLayers: {} } }) };
    }, setInterval() {}, Date };
  vm.runInNewContext(script, context);
  context.presetTsunamiLevel('62');
  context.presetTsunamiLevel('53');
  context.cancelTsunamiPreset();
  const events = requests.filter((request) => request.url === '/test/events');
  assert.equal(events.length, 3);
  let state = createAtlasSnapshot();
  for (const request of events.slice(0, 2)) state = ingestTestEvents(state, request.body).state;
  assert.equal(state.layers.tsunami.length, 1);
  assert.deepEqual(state.layers.tsunami[0].payload.render.major, ['北海道太平洋沿岸東部']);
  assert.equal(state.layers.tsunami[0].payload.atlasII[0], 3);
  state = ingestTestEvents(state, events[2].body).state;
  assert.equal(state.layers.tsunami.length, 1);
  assert.equal(state.layers.tsunami[0].action, 'cancel');
});
