const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

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
