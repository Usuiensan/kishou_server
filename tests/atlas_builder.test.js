const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('atlas builder connects state polling and paired existing components at v8 coordinates', () => {
  const root = path.resolve(__dirname, '..');
  execFileSync('python', ['telop/build_atlas.py'], { cwd: root });
  const html = fs.readFileSync(path.join(root, 'telop/atlas-1080.html'), 'utf8');
  for (const id of ['atlas-clock', 'atlas-intensity', 'atlas-headline', 'eew-box', 'tsunami-mini', 'atlas-alpha-mirror']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /#eew-box\s*\{\s*left:417px;\s*top:747px/);
  assert.match(html, /#tsunami-mini\s*\{\s*position:absolute;\s*left:1236px;\s*top:651px/);
  assert.match(html, /fetch\(`atlas-state\.json/);
  const initial = html.match(/window\.ATLAS_INITIAL_STATE = (\{[^;]+\});<\/script>/);
  assert.ok(initial);
  const layers = JSON.parse(initial[1]).layers;
  for (const kind of ['eew', 'tsunami', 'intensity', 'vertical']) assert.ok(layers[kind].length, `${kind} demo layer is empty`);
  assert.match(html, /renderTsunamiMini\(view\.tsunami\)/);
  assert.match(html, /function renderEEW\(d\)/);
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map((match) => match[1]);
  assert.ok(scripts.length >= 5);
  for (const script of scripts) assert.doesNotThrow(() => new Function(script));

  const elements = new Map();
  const element = (id = '') => ({
    id, style: {}, innerHTML: '', textContent: '', children: [],
    classList: { values: new Set(), add(value) { this.values.add(value); }, remove(value) { this.values.delete(value); } },
    setAttribute() {}, append(...items) { this.children.push(...items); }, appendChild(item) { this.children.push(item); },
    replaceChildren(...items) { this.children = items; }, cloneNode() { return element(id); },
    getContext() { return { measureText: () => ({ width: 1 }) }; }, clientWidth: 600,
  });
  const document = {
    getElementById(id) { if (!elements.has(id)) elements.set(id, element(id)); return elements.get(id); },
    createElement(tag) { return element(tag); },
  };
  const sandbox = { document, innerWidth: 1920, innerHeight: 1080, addEventListener() {},
    setInterval() { return 1; }, clearInterval() {}, setTimeout() { return 1; }, fetch: async () => ({ ok: false }) };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  for (const script of scripts) vm.runInContext(script, sandbox);
  assert.match(elements.get('map-cell').innerHTML, /<svg/);
  assert.match(elements.get('tsunami-mini').innerHTML, /<svg/);
  assert.ok(elements.get('eew-box').classList.values.has('on'));
  assert.ok(elements.get('atlas-intensity').children.length);
  assert.ok(elements.get('atlas-headline').textContent);
});
