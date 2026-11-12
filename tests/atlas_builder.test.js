const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { parseEarthquake } = require('../lib/parsers/earthquake');
const { parseTsunami } = require('../lib/parsers/tsunami');
const { createAtlasData, createAtlasSnapshot, applyAtlasBulletin } = require('../lib/atlasData');

test('atlas builder connects state polling and paired existing components', () => {
  const root = path.resolve(__dirname, '..');
  execFileSync('python', ['telop/build_atlas.py'], { cwd: root });
  const html = fs.readFileSync(path.join(root, 'telop/atlas-1080.html'), 'utf8');
  for (const id of ['atlas-clock', 'atlas-intensity', 'atlas-headline', 'eew-box', 'tsunami-mini', 'tsunami-super', 'atlas-alpha-mirror']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /#eew-box\s*\{\s*left:574\.5px;\s*top:747px/);
  assert.match(html, /#tsunami-mini\s*\{\s*position:absolute;\s*left:1357px;\s*top:651px/);
  assert.match(html, /#tsunami-mini\s*\{[^}]*width:460px;\s*height:auto/);
  assert.match(html, /#tsunami-mini\.advisory-only\s*\{[^}]*width:380px/);
  assert.match(html, /#tsunami-mini svg\s*\{[^}]*width:100%;\s*height:auto/);
  assert.match(html, /#tsunami-super[^}]*right:600px[^}]*z-index:6/);
  assert.match(html, /\.atlas-alpha-eew\s*\{[^}]*background:#fff/);
  assert.match(html, /atlas-intensity-row\.top \.atlas-intensity-areas ruby \{ ruby-position:over/);
  assert.match(html, /atlas-intensity-row\.bottom \.atlas-intensity-areas ruby \{ ruby-position:under/);
  assert.match(html, /#atlas-clock[^}]*font-size:56px/);
  assert.match(html, /#atlas-intensity\s*\{[^}]*height:155px/);
  assert.match(html, /#atlas-intensity\s*\{[^}]*justify-content:flex-start/);
  assert.match(html, /\.atlas-intensity-row[^}]*grid-template-columns:230px 1fr/);
  assert.match(html, /\.atlas-intensity-row[^}]*font-size:52px/);
  assert.match(html, /\.atlas-intensity-row[^}]*line-height:1/);
  assert.match(html, /\.atlas-summary-line[^}]*height:76px[^}]*font-size:52px[^}]*-webkit-text-stroke:0\.2em #000/);
  assert.match(html, /\.atlas-tsunami-badge[^}]*height:68px[^}]*border:4px solid #101010/);
  assert.match(html, /\.atlas-tsunami-forecast-badge[^}]*background:#fff[^}]*color:#111/);
  assert.match(html, /\.atlas-intensity-badge[^}]*height:74px[^}]*font-size:60px[^}]*white-space:nowrap/);
  assert.match(html, /atlas-intensity-row\.top \.atlas-intensity-badge \{ border-bottom-width:0/);
  assert.match(html, /atlas-intensity-row\.bottom \.atlas-intensity-badge \{ align-self:center/);
  assert.match(html, /\.atlas-intensity-areas[^}]*-webkit-text-stroke:0\.24em #000/);
  assert.match(html, /#rg-bits[^}]*background:#000/);
  assert.match(html, /id="atlas-test-notice">【実際の情報ではありません】</);
  assert.match(html, /#atlas-test-notice\s*\{[^}]*top:1116px[^}]*background:#fcee21/);
  assert.doesNotMatch(html, /length:129|class=\\?"cell/);
  assert.match(html, /ATLAS_RENDER_READY = true/);
  assert.match(html, /ATLAS_SNAPSHOT_RECEIVED = true/);
  assert.match(html, /\.atlas-intensity-areas rt \{ font-size:22px[^}]*-webkit-text-stroke:0\.24em #000/);
  assert.match(html, /-webkit-text-stroke:\s*0\.24em #000/);
  assert.match(html, /paint-order:\s*stroke fill/);
  assert.match(html, /#v-headline-box\s*\{[^}]*writing-mode:\s*vertical-rl/);
  assert.match(html, /\.atlas-headline-number\s*\{[^}]*text-combine-upright:\s*all/);
  assert.match(html, /fetch\(`atlas-state\.json/);
  const initial = html.match(/window\.ATLAS_INITIAL_STATE = (\{[^;]+\});<\/script>/);
  assert.ok(initial);
  const initialState = JSON.parse(initial[1]);
  assert.deepEqual(Object.fromEntries(Object.entries(initialState.layers).map(([kind, entries]) => [kind, entries.length])),
    { eew: 0, tsunami: 0, intensity: 0, vertical: 0 });
  assert.match(html, /renderTsunamiMini\(\{ \.\.\.view\.tsunami/);
  assert.match(html, /tsunamiElement\.className = advisoryOnly \? 'advisory-only' : ''/);
  assert.match(html, /renderTsunamiMini\(\{\s*\.\.\.view\.tsunami,\s*linesVisible:/);
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
    replaceChildren(...items) { this.children = items; if (id === 'tsunami-mini' && !items.length) this.innerHTML = ''; }, cloneNode() { return element(id); },
    getContext() { return { measureText: () => ({ width: 1 }) }; }, clientWidth: 600,
    querySelector(selector) { return this.children.find(child => child.className === selector.slice(1)) || null; },
    querySelectorAll(selector) { return selector === '.tm-land' ? [maskLand]
      : selector === '.tm-coast' ? [maskCoast]
        : selector === '.tm-zone' ? [maskZone]
        : selector === '.tm-label, .tm-legend-label, text, rect' ? [maskText] : []; },
  });
  const document = {
    getElementById(id) { if (!elements.has(id)) elements.set(id, element(id)); return elements.get(id); },
    createElement(tag) { return element(tag); },
  };
  let intensityTick;
  let nextTimeoutId = 1;
  const timeouts = [];
  const sandbox = { document, innerWidth: 1920, innerHeight: 1080, addEventListener() {},
    setInterval(callback) { intensityTick = callback; return 1; }, clearInterval() {},
    setTimeout(callback, delay) { const timer = { id: nextTimeoutId++, callback, delay, cleared: false }; timeouts.push(timer); return timer.id; },
    clearTimeout(id) { const timer = timeouts.find(item => item.id === id); if (timer) timer.cleared = true; },
    fetch: async () => ({ ok: false }) };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  for (const script of renderScripts) vm.runInContext(script, sandbox);
  assert.match(elements.get('map-cell').innerHTML, /<svg/);
  assert.match(elements.get('tsunami-mini').innerHTML, /<svg/);
  const zonePath = elements.get('tsunami-mini').innerHTML.indexOf('<path class="tm-zone"');
  const coastPath = elements.get('tsunami-mini').innerHTML.indexOf('stroke="#151515"');
  const landFill = elements.get('tsunami-mini').innerHTML.indexOf('class="tm-land"');
  assert.ok(zonePath >= 0 && zonePath < coastPath && coastPath < landFill, 'coastal bands sit behind coastline and land fill');
  assert.match(elements.get('tsunami-mini').innerHTML, /class="tm-zone" fill="#faf500" fill-rule="evenodd"/);
  assert.match(elements.get('tsunami-mini').innerHTML.slice(zonePath, coastPath), /<path class="tm-zone"[^>]* d="[^"]*Z/);
  assert.ok(elements.get('eew-box').classList.values.has('on'));
  assert.equal(elements.get('eew-v').classList.values.has('on'), false);
  sandbox.applyAtlasControls({ flags: 1 });
  assert.ok(elements.get('eew-box').classList.values.has('on'));
  assert.ok(elements.get('eew-v').classList.values.has('on'));
  assert.equal(elements.get('v-headline').textContent, '豊後水道で地震');
  assert.doesNotMatch(elements.get('v-areas').innerHTML, /四国/);
  assert.match(elements.get('v-areas').innerHTML, /愛媛/);
  assert.match(elements.get('areas').innerHTML, /愛媛　高知　大分/);
  assert.ok(elements.get('atlas-intensity').children.length);
  assert.equal(elements.get('atlas-intensity').children[0].className, 'atlas-tsunami-line atlas-tsunami-major');
  assert.equal(elements.get('atlas-intensity').children[0].children[0].textContent, '大津波警報');
  assert.equal(elements.get('atlas-intensity').children[1].children[0].textContent, '予想');
  assert.equal(elements.get('tsunami-super').style.display, 'block');
  assert.ok(elements.get('tsunami-super').children.length > 1);
  const onePageWarning = JSON.parse(JSON.stringify(renderFixture));
  onePageWarning.layers.tsunami[0].event.serial = 50;
  onePageWarning.layers.tsunami[0].payload.tsunamiFrames = [
    { level: 'warning', label: '津波警報', area: '石川県能登', height: '3m', arrival: 'すぐ来る', updateKey: 'new-jma-update' },
  ];
  sandbox.applyAtlasSnapshot(onePageWarning);
  assert.equal(elements.get('tsunami-super').children.length, 2);
  const runTimeout = (delay) => {
    const timer = [...timeouts].reverse().find(item => item.delay === delay && !item.cleared);
    assert.ok(timer, `expected an active ${delay}ms timer`);
    timer.cleared = true;
    timer.callback();
  };
  runTimeout(7500);
  assert.equal(elements.get('tsunami-super').style.display, 'block');
  runTimeout(7500);
  assert.equal(elements.get('tsunami-super').style.display, 'none');
  const canceledWarning = JSON.parse(JSON.stringify(onePageWarning));
  canceledWarning.layers.tsunami = [];
  canceledWarning.notices = [{ kind: 'tsunami', event: { id: 'cancelled' }, payload: { notice: '津波警報・注意報は解除されました' }, receivedAt: Date.now() }];
  sandbox.applyAtlasSnapshot(canceledWarning);
  assert.equal(elements.get('tsunami-super').style.display, 'none');
  assert.equal(elements.get('atlas-intensity').children[0].textContent, '津波警報・注意報は解除されました');
  const transition = timeouts.find(item => item.delay === 1000 && !item.cleared && !item.callback.name);
  assert.ok(transition, 'L mode keeps both EEW layouts for one second');
  transition.cleared = true;
  transition.callback();
  assert.equal(elements.get('eew-box').classList.values.has('on'), false);
  assert.ok(elements.get('eew-v').classList.values.has('on'));
  const noTsunamiWorry = JSON.parse(JSON.stringify(renderFixture));
  noTsunamiWorry.layers.tsunami = [];
  noTsunamiWorry.layers.intensity[0].payload.summaryFrames = [
    { lines: ['午前1時4分ごろ東海地方で震度5強', '津波の心配はありません'] },
  ];
  sandbox.applyAtlasSnapshot(noTsunamiWorry);
  assert.equal(elements.get('atlas-headline').textContent, '津波の心配なし');
  assert.equal(elements.get('atlas-headline').style.display, 'block');
  assert.equal(elements.get('atlas-headline').style.color, '#fff');
  const tsunamiConcern = JSON.parse(JSON.stringify(noTsunamiWorry));
  tsunamiConcern.layers.intensity[0].payload.summaryFrames[0].lines[1] = '沿岸部では念のため津波に注意';
  sandbox.applyAtlasSnapshot(tsunamiConcern);
  assert.equal(elements.get('atlas-headline').style.display, 'none');
  sandbox.applyAtlasControls({ flags: 0 });
  assert.ok(elements.get('eew-box').classList.values.has('on'));
  const intensityRowsFixture = JSON.parse(JSON.stringify(renderFixture));
  intensityRowsFixture.layers.tsunami[0].payload.tsunamiFrames = [];
  intensityRowsFixture.layers.intensity[0].event.id = 'rows-layout';
  intensityRowsFixture.layers.vertical[0].event.id = 'rows-layout';
  intensityRowsFixture.layers.intensity[0].payload.summaryFrames = [];
  sandbox.applyAtlasSnapshot(intensityRowsFixture);
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
  assert.equal(maskZone.style.fill, '#fff');
  assert.equal(maskText.style.fill, '#fff');
  const noTsunamiAreas = JSON.parse(JSON.stringify(renderFixture));
  noTsunamiAreas.layers.tsunami[0].payload.render = { major: [], warning: [], advisory: [] };
  noTsunamiAreas.layers.tsunami[0].payload.tsunamiFrames = [];
  sandbox.applyAtlasSnapshot(noTsunamiAreas);
  assert.equal(elements.get('tsunami-mini').style.display, 'none');
  assert.equal(elements.get('tsunami-mini').innerHTML, '');
  assert.equal(elements.get('atlas-alpha-mirror').children.length, 1);
  assert.ok(elements.get('eew-box').classList.values.has('on'));
  assert.ok(elements.get('atlas-intensity').children.length);
  assert.equal(elements.get('atlas-intensity').children[0].className, 'atlas-summary-line');
  const advisoryOnly = JSON.parse(JSON.stringify(noTsunamiAreas));
  advisoryOnly.layers.tsunami[0].payload.render.advisory = ['佐渡'];
  advisoryOnly.layers.tsunami[0].payload.tsunamiFrames = [
    { level: 'advisory', label: '津波注意報', additional: false, area: '佐渡', height: '1m', arrival: '午後7時30分ごろ' },
  ];
  sandbox.applyAtlasSnapshot(advisoryOnly);
  assert.equal(elements.get('tsunami-mini').style.display, 'none');
  assert.equal(elements.get('tsunami-mini').className, 'advisory-only');
  const mixed = JSON.parse(JSON.stringify(advisoryOnly));
  mixed.layers.tsunami[0].payload.render.warning = ['宮城県'];
  sandbox.applyAtlasSnapshot(mixed);
  assert.equal(elements.get('tsunami-mini').className, '');
  assert.match(elements.get('tsunami-mini').innerHTML, /class="tm-zone" fill="#ff2800" fill-rule="evenodd"/);
  assert.match(elements.get('tsunami-mini').innerHTML, /class="tm-zone" fill="#faf500" fill-rule="evenodd"/);
  sandbox.applyAtlasSnapshot(advisoryOnly);
  assert.equal(elements.get('atlas-alpha-mirror').children.length, 1);
  assert.equal(elements.get('atlas-intensity').children[0].className, 'atlas-tsunami-line atlas-tsunami-advisory');
  const hiddenEarthquake = JSON.parse(JSON.stringify(advisoryOnly));
  hiddenEarthquake.display.earthquakeTelop = false;
  sandbox.applyAtlasSnapshot(hiddenEarthquake);
  assert.equal(elements.get('atlas-intensity').children[0].className, 'atlas-tsunami-line atlas-tsunami-advisory');
  const expiredTsunami = JSON.parse(JSON.stringify(advisoryOnly));
  expiredTsunami.layers.tsunami = [];
  sandbox.applyAtlasSnapshot(expiredTsunami);
  assert.equal(elements.get('tsunami-mini').style.display, 'none');
  assert.equal(elements.get('tsunami-mini').innerHTML, '');
  assert.equal(elements.get('atlas-alpha-mirror').children.length, 1);
  assert.ok(elements.get('eew-box').classList.values.has('on'));
  assert.equal(elements.get('atlas-intensity').children.length, 0);
  let wrapped = JSON.parse(JSON.stringify(renderFixture));
  for (const kind of ['eew', 'tsunami', 'vertical']) wrapped.layers[kind] = [];
  wrapped.layers.intensity[0].event.id = 'wrapped-layout';
  wrapped.layers.intensity[0].payload.render = {
    maxInt: '4', cityGroups: { '4': Array(16).fill('つくばみらい市') },
    cityReadings: { 'つくばみらい市': 'つくばみらいし' },
  };
  wrapped.layers.intensity[0].payload.summaryFrames = [
    { lines: ['午前1時4分ごろ東海地方で震度5強', '沿岸部では念のため津波に注意'] },
    { lines: ['震源は静岡県西部', '深さ40キロ　マグニチュード5.7'] },
  ];
  sandbox.applyAtlasSnapshot(wrapped);
  const wrappedRows = elements.get('atlas-intensity').children;
  assert.deepEqual(wrappedRows.map(row => [row.className, row.textContent]), [
    ['atlas-summary-line', '午前1時4分ごろ東海地方で震度5強'],
    ['atlas-summary-line', '沿岸部では念のため津波に注意'],
  ]);
  intensityTick();
  assert.deepEqual(elements.get('atlas-intensity').children.map(row => row.textContent), ['震源は静岡県西部', '深さ40キロ　マグニチュード5.7']);
  intensityTick();
  assert.equal(elements.get('atlas-intensity').children[0].children[0].textContent, '震度4');
  wrapped.layers.intensity[0].event.id = 'wrapped-rows-layout';
  wrapped.layers.intensity[0].payload.summaryFrames = [];
  sandbox.applyAtlasSnapshot(wrapped);
  const intensityRows = elements.get('atlas-intensity').children;
  assert.equal(intensityRows[0].children[0].textContent, '震度4');
  assert.equal(intensityRows[0].children[0].className, 'atlas-intensity-badge');
  assert.equal(intensityRows[1].children[0].textContent, '');
  assert.equal(intensityRows[1].children[0].className, 'atlas-intensity-continuation');
  assert.equal(intensityRows[0].className, 'atlas-intensity-row top');
  assert.equal(intensityRows[1].className, 'atlas-intensity-row bottom');
  assert.equal(intensityRows[0].children[1].children[0], 'つくばみらい');
  assert.equal(intensityRows[0].children[1].children[1].textContent, '市');
  assert.equal(intensityRows[0].children[1].children[1].children[0].textContent, 'し');
  assert.ok(!intensityRows[0].children[1].children.some((part) => part?.textContent === 'つくばみらい市'));
  assert.ok(intensityRows[0].children[1].children.includes('　'));
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

  wrapped.layers.intensity[0].payload.render = {
    maxInt: '5+', cityGroups: { '5+': ['知多市'], '5-': ['売木村', '恵那市', '浜松浜名区', '瀬戸市'] }, cityReadings: {},
  };
  sandbox.applyAtlasSnapshot(wrapped);
  const severityRows = elements.get('atlas-intensity').children;
  assert.deepEqual(severityRows.map(row => row.children[0].textContent), ['震度5強', '震度5弱']);
  assert.deepEqual(severityRows.map(row => row.children[1].children.filter(part => typeof part === 'string' && part !== '　')),
    [['知多市'], ['売木村', '恵那市', '浜松浜名区', '瀬戸市']]);
});
