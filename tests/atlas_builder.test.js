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
  assert.match(html, /\.atlas-alpha-eew\s*\{[^}]*background:#fff/);
  assert.match(html, /atlas-intensity-row\.top \.atlas-intensity-areas ruby \{ ruby-position:over/);
  assert.match(html, /atlas-intensity-row\.bottom \.atlas-intensity-areas ruby \{ ruby-position:under/);
  assert.match(html, /-webkit-text-stroke:\s*8px #000/);
  assert.match(html, /paint-order:\s*stroke fill/);
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
  const maskLand = { style: { setProperty(name, value) { this[name] = value; } } };
  const maskCoast = { style: { setProperty(name, value) { this[name] = value; } } };
  const maskZone = { style: { setProperty(name, value) { this[name] = value; } } };
  const maskText = { style: { setProperty(name, value) { this[name] = value; } } };
  const element = (id = '') => ({
    id, style: {}, innerHTML: '', textContent: '', children: [],
    classList: { values: new Set(), add(value) { this.values.add(value); }, remove(value) { this.values.delete(value); }, contains(value) { return this.values.has(value); } },
    setAttribute() {}, append(...items) { this.children.push(...items); }, appendChild(item) { this.children.push(item); },
    replaceChildren(...items) { this.children = items; }, cloneNode() { return element(id); },
    getContext() { return { measureText: () => ({ width: 1 }) }; }, clientWidth: 600,
    querySelectorAll(selector) { return selector === '.tm-land' ? [maskLand]
      : selector === '.tm-coast, .tm-zone' ? [maskCoast, maskZone]
        : selector === '.tm-label, .tm-legend-label, text, rect' ? [maskText] : []; },
  });
  const document = {
    getElementById(id) { if (!elements.has(id)) elements.set(id, element(id)); return elements.get(id); },
    createElement(tag) { return element(tag); },
  };
  let intensityTick;
  const sandbox = { document, innerWidth: 1920, innerHeight: 1080, addEventListener() {},
    setInterval(callback) { intensityTick = callback; return 1; }, clearInterval() {}, setTimeout() { return 1; }, fetch: async () => ({ ok: false }) };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  for (const script of scripts) vm.runInContext(script, sandbox);
  assert.match(elements.get('map-cell').innerHTML, /<svg/);
  assert.match(elements.get('tsunami-mini').innerHTML, /<svg/);
  assert.ok(elements.get('eew-box').classList.values.has('on'));
  assert.ok(elements.get('eew-v').classList.values.has('on'));
  assert.ok(elements.get('atlas-intensity').children.length);
  const visibleIntensityRows = elements.get('atlas-intensity').children.map((row) => row.children[1]);
  assert.equal(elements.get('atlas-intensity').children[0].children[0].textContent, '震度7');
  assert.equal(elements.get('atlas-intensity').children[1].children[0].textContent, '震度6強');
  const areaStrings = visibleIntensityRows.map((areas) => areas.children.map((part) => typeof part === 'string' ? part : part.textContent).join(''));
  assert.ok(areaStrings.some((line) => line.includes('　')));
  assert.ok(areaStrings.every((line) => [...line].length <= 21));
  assert.ok(visibleIntensityRows.some((areas) => areas.children.some((part) => part?.id === 'ruby')));
  assert.equal(elements.get('atlas-headline').children[0].children[0].textContent, 'みやぎ');
  assert.equal(elements.get('atlas-alpha-mirror').children[0].className, 'atlas-alpha-eew');
  assert.ok(elements.get('atlas-alpha-mirror').children[1].classList.values.has('atlas-alpha-tsunami'));
  assert.equal(elements.get('atlas-alpha-mirror').children[1].style.backgroundColor, '#999');
  assert.equal(maskLand.style.fill, '#fff');
  assert.equal(maskZone.style.stroke, '#fff');
  assert.equal(maskText.style.fill, '#fff');
  const wrapped = JSON.parse(initial[1]);
  for (const kind of ['eew', 'tsunami', 'vertical']) wrapped.layers[kind] = [];
  wrapped.layers.intensity[0].payload.render = {
    cityGroups: { '4': Array(16).fill('つくばみらい市') },
    cityRubyParts: { 'つくばみらい市': [['つくばみらい', 'つくばみらい'], ['市', 'し']] },
  };
  sandbox.applyAtlasSnapshot(wrapped);
  const wrappedRows = elements.get('atlas-intensity').children;
  assert.equal(wrappedRows[0].children[0].textContent, '震度4');
  assert.equal(wrappedRows[0].children[0].className, 'atlas-intensity-badge');
  assert.equal(wrappedRows[1].children[0].textContent, '');
  assert.equal(wrappedRows[1].children[0].className, 'atlas-intensity-continuation');
  assert.equal(wrappedRows[0].className, 'atlas-intensity-row top');
  assert.equal(wrappedRows[1].className, 'atlas-intensity-row bottom');
  assert.equal(wrappedRows[0].children[1].children[0], 'つくばみらい');
  assert.equal(wrappedRows[0].children[1].children[1].textContent, '市');
  assert.equal(wrappedRows[0].children[1].children[1].children[0].textContent, 'し');
  assert.ok(!wrappedRows[0].children[1].children.some((part) => part?.textContent === 'つくばみらい市'));
  assert.ok(wrappedRows[0].children[1].children.includes('　'));
  intensityTick();
  assert.equal(elements.get('atlas-intensity').children[0].children[0].textContent, '震度4');
  wrapped.layers.intensity[0].payload.render.cityGroups = { '4': ['仙台宮城野区'] };
  wrapped.layers.intensity[0].payload.render.cityRubyParts = {
    '仙台宮城野区': [['仙台宮城野', 'せんだいみやぎの'], ['区', 'く']],
  };
  sandbox.applyAtlasSnapshot(wrapped);
  const wardParts = elements.get('atlas-intensity').children[0].children[1].children;
  assert.equal(wardParts[0].textContent, '仙台宮城野');
  assert.equal(wardParts[0].children[0].textContent, 'せんだいみやぎの');
  assert.equal(wardParts[1].textContent, '区');
  assert.equal(wardParts[1].children[0].textContent, 'く');
  wrapped.layers.intensity[0].payload.render.cityGroups = { '4': ['あきる野市'] };
  wrapped.layers.intensity[0].payload.render.cityRubyParts = {
    'あきる野市': [['あきる野', 'あきるの'], ['市', 'し']],
  };
  sandbox.applyAtlasSnapshot(wrapped);
  const mixedParts = elements.get('atlas-intensity').children[0].children[1].children;
  assert.equal(mixedParts[0], 'あきる');
  assert.equal(mixedParts[1].textContent, '野');
  assert.equal(mixedParts[1].children[0].textContent, 'の');
  assert.equal(mixedParts[2].textContent, '市');
  assert.equal(mixedParts[2].children[0].textContent, 'し');
});
