const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parseEarthquake } = require('../lib/parsers/earthquake');
const { parseTsunami } = require('../lib/parsers/tsunami');
const { createAtlasData, createAtlasSnapshot, applyAtlasBulletin } = require('../lib/atlasData');

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
  assert.match(html, /#atlas-clock[^}]*font-size:56px/);
  assert.match(html, /\.atlas-intensity-row[^}]*grid-template-columns:190px 1fr/);
  assert.match(html, /\.atlas-intensity-badge[^}]*font-size:32px[^}]*white-space:nowrap/);
  assert.match(html, /#rg-bits[^}]*background:#000/);
  assert.doesNotMatch(html, /length:129|class=\\?"cell/);
  assert.match(html, /ATLAS_RENDER_READY = true/);
  assert.match(html, /ATLAS_SNAPSHOT_RECEIVED = true/);
  assert.match(html, /\.atlas-intensity-areas rt \{ font-size:18px/);
  assert.match(html, /-webkit-text-stroke:\s*8px #000/);
  assert.match(html, /paint-order:\s*stroke fill/);
  assert.match(html, /#v-headline-box\s*\{[^}]*display:none/);
  assert.match(html, /\.atlas-headline-number\s*\{[^}]*text-combine-upright:\s*all/);
  assert.match(html, /fetch\(`atlas-state\.json/);
  const initial = html.match(/window\.ATLAS_INITIAL_STATE = (\{[^;]+\});<\/script>/);
  assert.ok(initial);
  const initialState = JSON.parse(initial[1]);
  assert.deepEqual(Object.fromEntries(Object.entries(initialState.layers).map(([kind, entries]) => [kind, entries.length])),
    { eew: 0, tsunami: 0, intensity: 0, vertical: 0 });
  assert.match(html, /renderTsunamiMini\(view\.tsunami\)/);
  assert.match(html, /function renderEEW\(d\)/);
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map((match) => match[1]);
  assert.ok(scripts.length >= 5);
  for (const script of scripts) assert.doesNotThrow(() => new Function(script));
  const samples = path.join(root, 'tests/samples');
  let renderFixture = createAtlasSnapshot();
  for (const [kind, filename] of [
    ['eew', '37_01_01_240613_VXSE43.xml'],
    ['tsunami', '32-39_11_02_250206_VTSE41.xml'],
    ['intensity', '32-39_11_05_240613_VXSE53.xml'],
    ['vertical', '32-39_11_05_240613_VXSE53.xml'],
  ]) {
    const xml = fs.readFileSync(path.join(samples, filename), 'utf8');
    const parsed = kind === 'eew' ? parseEarthquake(xml) : parseTsunami(xml);
    renderFixture = applyAtlasBulletin(renderFixture, createAtlasData(kind, parsed), Date.now());
  }
  const renderScripts = scripts.map((script) => script.replace(
    /window\.ATLAS_INITIAL_STATE = .*?;/,
    `window.ATLAS_INITIAL_STATE = ${JSON.stringify(renderFixture)};`,
  ));

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
  for (const script of renderScripts) vm.runInContext(script, sandbox);
  assert.match(elements.get('map-cell').innerHTML, /<svg/);
  assert.match(elements.get('tsunami-mini').innerHTML, /<svg/);
  assert.ok(elements.get('eew-box').classList.values.has('on'));
  assert.ok(elements.get('eew-v').classList.values.has('on'));
  assert.equal(elements.get('v-headline').textContent, '');
  assert.doesNotMatch(elements.get('v-areas').innerHTML, /四国/);
  assert.match(elements.get('v-areas').innerHTML, /愛媛県南予/);
  assert.match(elements.get('areas').innerHTML, /愛媛県南予/);
  assert.ok(elements.get('atlas-intensity').children.length);
  const visibleIntensityRows = elements.get('atlas-intensity').children.map((row) => row.children[1]);
  assert.equal(elements.get('atlas-intensity').children[0].children[0].textContent, '震度7');
  assert.equal(elements.get('atlas-intensity').children[1].children[0].textContent, '震度6強');
  const areaStrings = visibleIntensityRows.map((areas) => areas.children.map((part) => typeof part === 'string' ? part : part.textContent).join(''));
  assert.ok(areaStrings.some((line) => line.includes('　')));
  assert.ok(areaStrings.every((line) => [...line].length <= 21));
  assert.ok(visibleIntensityRows.some((areas) => areas.children.some((part) => part?.id === 'ruby')));
  assert.equal(elements.get('atlas-headline').children[0].children[0].textContent, 'みやぎ');
  assert.ok(elements.get('atlas-headline').children.some((part) => part?.className === 'atlas-headline-number' && part.textContent === '7'));
  assert.equal(elements.get('atlas-alpha-mirror').children[0].className, 'atlas-alpha-eew');
  assert.ok(elements.get('atlas-alpha-mirror').children[1].classList.values.has('atlas-alpha-tsunami'));
  assert.equal(elements.get('atlas-alpha-mirror').children[1].style.backgroundColor, '#999');
  assert.equal(maskLand.style.fill, '#fff');
  assert.equal(maskZone.style.stroke, '#fff');
  assert.equal(maskText.style.fill, '#fff');
  let wrapped = JSON.parse(JSON.stringify(renderFixture));
  for (const kind of ['eew', 'tsunami', 'vertical']) wrapped.layers[kind] = [];
  wrapped.layers.intensity[0].payload.render = {
    cityGroups: { '4': Array(16).fill('つくばみらい市') },
    cityReadings: { 'つくばみらい市': 'つくばみらいし' },
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
  wrapped.layers.intensity[0].payload.render.cityReadings = { '仙台宮城野区': 'せんだいみやぎのく' };
  sandbox.applyAtlasSnapshot(wrapped);
  const wardParts = elements.get('atlas-intensity').children[0].children[1].children;
  assert.equal(wardParts.length, 1);
  assert.equal(wardParts[0].textContent, '仙台宮城野区');
  assert.equal(wardParts[0].children[0].textContent, 'せんだいみやぎのく');
  wrapped.layers.intensity[0].payload.render.cityGroups = { '4': ['あきる野市'] };
  wrapped.layers.intensity[0].payload.render.cityReadings = { 'あきる野市': 'あきるのし' };
  sandbox.applyAtlasSnapshot(wrapped);
  const mixedParts = elements.get('atlas-intensity').children[0].children[1].children;
  assert.equal(mixedParts[0], 'あきる');
  assert.equal(mixedParts[1].textContent, '野市');
  assert.equal(mixedParts[1].children[0].textContent, 'のし');
  wrapped.layers.intensity[0].payload.render.cityGroups = { '4': ['愛媛県南予'] };
  wrapped.layers.intensity[0].payload.render.cityReadings = { '愛媛県南予': 'えひめけん なんよ' };
  sandbox.applyAtlasSnapshot(wrapped);
  const prefectureZoneRuby = elements.get('atlas-intensity').children[0].children[1].children[0];
  assert.equal(prefectureZoneRuby.textContent, '愛媛県南予');
  assert.equal(prefectureZoneRuby.children[0].textContent, 'えひめけん なんよ');
});
