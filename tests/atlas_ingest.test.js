const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { ingestXml, ingestEewJson, ingestP2P, ingestTestEvents, start } = require('../tools/atlas_ingest');
const { createAtlasSnapshot } = require('../lib/atlasData');

const sample = (name) => fs.readFileSync(path.join(__dirname, 'samples', name), 'utf8');

test('JMAのEEW続報・取消を受け、津波レイヤーを保持する', () => {
  let state = createAtlasSnapshot();
  const first = ingestXml(state, sample('37_01_01_240613_VXSE43.xml'), 1000);
  state = first.state;
  assert.deepEqual(first.kinds, ['eew']);
  state = ingestXml(state, sample('32-39_11_02_250206_VTSE41.xml'), 1001).state;
  assert.equal(state.layers.tsunami.length, 1);
  state = ingestXml(state, sample('37_01_02_240613_VXSE43.xml'), 1002).state;
  assert.equal(state.layers.eew[0].event.serial, 2);
  state = ingestXml(state, sample('37_01_03_240613_VXSE43.xml'), 1003).state;
  assert.equal(state.layers.eew[0].action, 'cancel');
  assert.equal(state.layers.tsunami.length, 1);
});

test('震度電文は震度・縦見出しへ同時に反映する', () => {
  const result = ingestXml(createAtlasSnapshot(), sample('32-39_11_05_240613_VXSE53.xml'), 1000);
  assert.deepEqual(result.kinds, ['intensity', 'vertical']);
  assert.equal(result.state.layers.intensity.length, 1);
  assert.equal(result.state.layers.vertical.length, 1);
});

test('訓練電文は通常起動では拒否し、許可時だけ訓練印付きで受け付ける', () => {
  const trainingXml = sample('37_01_01_240613_VXSE43.xml').replace('<Status>通常</Status>', '<Status>訓練</Status>');
  assert.throws(() => ingestXml(createAtlasSnapshot(), trainingXml, 1000), /unsupported bulletin status: 訓練/);
  const result = ingestXml(createAtlasSnapshot(), trainingXml, 1000, { allowTraining: true });
  assert.equal(result.state.layers.eew[0].event.training, true);
  assert.equal(result.state.layers.eew[0].payload.render.training, true);
});

test('任意震度の試験イベントは正規の震度と縦見出しレイヤーへ投入され、不正階級を拒否する', () => {
  const bulletin = { eventId:'custom-intensity', infoType:'発表', infoKind:'震源・震度情報', originTimeFormatted:'10時30分', tsunamiWorry:false,
    earthquake:{hypocenter:{name:'石川県能登'},magnitude:'5.2'}, intensity:{maxInt:'5+',prefs:[{name:'石川県',maxInt:'5+'}],groups:{'5+':['石川県能登']},cityGroups:{'5+':['輪島市']}} };
  const result = ingestTestEvents(createAtlasSnapshot(), { events:[{kind:'intensity',bulletin},{kind:'vertical',bulletin}] }, 1000);
  assert.deepEqual(result.kinds,['intensity','vertical']);
  assert.deepEqual(result.state.layers.intensity[0].payload.render.cityGroups['5+'],['輪島市']);
  assert.equal(result.state.layers.vertical[0].payload.place,'石川');
  assert.throws(()=>ingestTestEvents(createAtlasSnapshot(),{events:[{kind:'intensity',bulletin:{...bulletin,intensity:{...bulletin.intensity,maxInt:'9'}}}]},1000),/震度階級/);
  assert.throws(()=>ingestTestEvents(createAtlasSnapshot(),{events:[{kind:'intensity',bulletin:{...bulletin,intensity:{...bulletin.intensity,cityGroups:{'5+':Array(601).fill('市')}}}}]},1000),/test intensity regions/);
});

test('P2P警報入力も区域別Atlas II EEWイベントとして保持する', () => {
  const result = ingestP2P(createAtlasSnapshot(), {
    code: 556, earthquake: { time: '2026/04/01 10:06:25' },
    issue: { eventId: 'p2p-event', serial: '1', time: '2026/04/01 10:06:39' },
    areas: [{ pref: '茨城', name: '茨城県北部', scaleFrom: 50, scaleTo: 50, arrivalTime: null }],
  }, 1000);
  assert.equal(result.state.layers.eew[0].payload.atlasII.areas[0].areaId, 300);
  assert.equal(result.state.layers.eew[0].payload.atlasII.areas[0].areaFlags & 4, 4);
});

test('試験イベント列でP2P code 556とJMA XMLを同じAtlas状態へ比較投入する', () => {
  const p2p = { code:556, earthquake:{hypocenter:{name:'茨城県南部'}}, issue:{eventId:'compare-p2p',serial:'1',time:'2026/04/01 10:06:39'},
    areas:[{pref:'茨城',name:'茨城県北部',scaleFrom:50,scaleTo:50}] };
  const result = ingestTestEvents(createAtlasSnapshot(), {events:[{p2p},{xml:sample('37_01_01_240613_VXSE43.xml')}]}, 1000);
  assert.deepEqual(result.kinds, ['eew','eew']);
  assert.deepEqual(result.acceptedEvents.map(event => event.source), ['p2p','xml']);
  assert.ok(result.acceptedEvents.every(event => event.areaRecords.length > 0));
  assert.ok(result.acceptedEvents.every(event => event.areaRecords.every(area => ['areaId','scalePair','areaFlags','arrivalOffsetSeconds'].every(key => key in area))));
  assert.equal(result.state.layers.eew.length, 2);
  assert.throws(() => ingestTestEvents(createAtlasSnapshot(), {events:[{p2p:{...p2p,code:555}}]}, 1000), /code 556/);
  assert.throws(() => ingestTestEvents(createAtlasSnapshot(), {events:[{p2p:{...p2p,areas:[{pref:'未知',name:'未知区域',scaleFrom:30,scaleTo:30}]}}]}, 1000), /unmapped JMA EEW area/);
});

test('単一区域津波の3段階試験は同じイベントを置換し、描画データも更新する', () => {
  let state = createAtlasSnapshot();
  for (const [code, key, severity] of [['62', 'advisory', 1], ['51', 'warning', 2], ['53', 'majorTsunami', 3]]) {
    const name = '北海道太平洋沿岸東部';
    const bulletin = { eventId: 'test-tsunami-single', infoType: '発表', infoKind: '津波警報・注意報', reportDateTime: '2026-11-11T00:00:00Z', serial: 1,
      tsunami: { groups: { majorTsunami: [], warning: [], advisory: [], [key]: [name] }, forecasts: [{ category: { code, kind: name }, area: { code: 100, name }, maxHeight: '1m', firstHeight: { condition: '到達予想' } }] } };
    state = ingestTestEvents(state, { events: [{ kind: 'tsunami', bulletin }] }).state;
    assert.equal(state.layers.tsunami.length, 1);
    const renderKey = key === 'majorTsunami' ? 'major' : key;
    assert.deepEqual(state.layers.tsunami[0].payload.render[renderKey], [name]);
    assert.equal(state.layers.tsunami[0].payload.atlasII[0], severity);
  }
});

test('localhostのXML受け口は状態スナップショットを更新しhealthを返す', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-ingest-'));
  const statePath = path.join(folder, 'state.json');
  const logger = { log() {}, error() {} };
  const service = start({ statePath, port: 0, logger });
  await once(service.server, 'listening');
  try {
    const base = `http://127.0.0.1:${service.server.address().port}`;
    assert.equal((await fetch(`${base}/test/events`, { method: 'POST', headers: { 'content-type': 'application/xml' }, body: sample('37_01_01_240613_VXSE43.xml') })).status, 404);
    assert.equal((await fetch(`${base}/test/events/remove`, { method:'POST', headers:{'content-type':'application/json'}, body:'{"kind":"eew","eventId":"x"}' })).status, 404);
    const response = await fetch(`${base}/jma`, { method: 'POST', headers: { 'content-type': 'application/xml' }, body: sample('37_01_01_240613_VXSE43.xml') });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).kinds, ['eew']);
    assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).layers.eew.length, 1);
    const jmaReceivedAt = service.getState().sourceHealth.jma.lastReceivedAt;
    assert.ok(Number.isFinite(Date.parse(jmaReceivedAt)));
    assert.equal((await fetch(`${base}/source-health`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'jma', ok: false, at: new Date().toISOString(), error: 'timeout' }) })).status, 200);
    const healthAfterFailure = (await fetch(`${base}/health`).then((result) => result.json())).sourceHealth.jma;
    assert.equal(healthAfterFailure.error, 'timeout');
    assert.equal(healthAfterFailure.lastReceivedAt, jmaReceivedAt);
    const p2p = await fetch(`${base}/p2p`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 556, earthquake: {}, issue: { eventId: 'p2p-http', serial: '1', time: '2026/04/01 10:06:39' },
        areas: [{ pref: '茨城', name: '茨城県北部', scaleFrom: 40, scaleTo: 40 }] }) });
    assert.equal(p2p.status, 200);
    assert.deepEqual((await p2p.json()).kinds, ['eew']);
    assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).layers.eew.length, 2);
    assert.ok(Number.isFinite(Date.parse(service.getState().sourceHealth.p2p.lastReceivedAt)));
    assert.equal((await fetch(`${base}/health`).then((result) => result.json())).ok, true);
  } finally {
    service.close();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('JMA受け口はloopback以外へbindできない', () => {
  assert.throws(() => start({ host: '0.0.0.0' }), /bind to loopback/);
});

test('試験APIはXML連続投入・任意Atlasイベント・状態リセットを扱う', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-test-api-'));
  const statePath = path.join(folder, 'state.json');
  const service = start({ statePath, port: 0, testApi: true, logger: { log() {}, error() {} } });
  await once(service.server, 'listening');
  try {
    const base = `http://127.0.0.1:${service.server.address().port}`;
    const input = await fetch(`${base}/test/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ events: [{ xml: sample('37_01_01_240613_VXSE43.xml') }, { kind: 'eew', bulletin: { eventId: 'synthetic', infoType: '発表', earthquake: { hypocenter: { name: '試験震源', coordinate: '+35.0+140.0' } }, eewAreaDetails: [] } }] }) });
    assert.equal(input.status, 200);
    const accepted = await input.json();
    assert.deepEqual(accepted.kinds, ['eew', 'eew']);
    assert.equal(accepted.acceptedEvents[0].source, 'xml');
    assert.ok(accepted.acceptedEvents[0].areaRecords.length > 0);
    assert.equal(service.getState().layers.eew.length, 2);
    const active = await (await fetch(`${base}/health`)).json();
    assert.equal(active.testEvents.length, 2);
    assert.ok(active.testEvents.every((item) => item.eventId && Object.hasOwn(item, 'serial') && Object.hasOwn(item, 'publishedAt')));
    const removal = await fetch(`${base}/test/events/remove`, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({kind:'eew',eventId:'synthetic'}) });
    assert.deepEqual(await removal.json(), {removed:true,kind:'eew',eventId:'synthetic'});
    assert.equal(service.getState().layers.eew.length, 1);
    const reset = await fetch(`${base}/test/reset`, { method: 'POST' });
    assert.equal(reset.status, 200);
    assert.equal(service.getState().layers.eew.length, 0);
  } finally {
    service.close();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('テスト仮想時計を進めると震度情報TTLを実時間待ちなしで適用する', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-virtual-clock-'));
  const statePath = path.join(folder, 'state.json');
  const service = start({ statePath, port: 0, testApi: true, logger: { log() {}, error() {} } });
  await once(service.server, 'listening');
  try {
    const base = `http://127.0.0.1:${service.server.address().port}`;
    const input = await fetch(`${base}/test/events`, { method: 'POST', headers: { 'content-type': 'application/xml' }, body: sample('32-39_11_05_240613_VXSE53.xml') });
    assert.equal(input.status, 200);
    assert.equal(service.getState().layers.intensity.length, 1);
    const advance = await fetch(`${base}/test/clock`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ advanceMs: 3 * 60 * 60_000 + 1 }) });
    assert.equal(advance.status, 200);
    assert.equal(service.getState().layers.intensity.length, 0);
    assert.equal(service.getState().layers.vertical.length, 0);
    assert.equal((await advance.json()).clockOffsetMs, 3 * 60 * 60_000 + 1);
    assert.equal((await fetch(`${base}/test/clock`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"advanceMs":-1}' })).status, 422);
  } finally {
    service.close();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('Rect layoutを試験APIから切り替え、JMA状態更新後も保持する', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-layout-api-'));
  const config = { activeLayout: 'full', layouts: { full: [], reverseL: [{ source: 1 }] } };
  const service = start({ statePath: path.join(folder, 'state.json'), port: 0, testApi: true,
    atlasIIConfig: config, logger: { log() {}, error() {} } });
  await once(service.server, 'listening');
  try {
    const base = `http://127.0.0.1:${service.server.address().port}`;
    assert.equal((await fetch(`${base}/test/layout`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ activeLayout: 'reverseL' }) })).status, 200);
    const editedConfig = { ...config, activeLayout: 'full', atlasSize: [1920, 1152],
      mainVideoSize: [1280, 720], outputSize: [1280, 720], layouts: { ...config.layouts, full: [{ source: 0, mode: 1, visible: false, opacity: 128,
        srcX: 0, srcY: 200, srcW: 100, srcH: 100, dstX: 10, dstY: 10, dstW: 100, dstH: 100,
        alphaX: 0, alphaY: 200, alphaW: 100, alphaH: 100 }] } };
    assert.equal((await fetch(`${base}/test/layout`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ activeLayout: 'full', atlasIIConfig: editedConfig }) })).status, 200);
    assert.deepEqual(service.getState().atlasIIConfig, editedConfig);
    await fetch(`${base}/test/events`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ events: [{ xml: sample('37_01_01_240613_VXSE43.xml') }] }) });
    assert.equal(service.getState().atlasIIConfig.activeLayout, 'full');
    await fetch(`${base}/test/reset`, { method: 'POST' });
    assert.equal(service.getState().atlasIIConfig.activeLayout, 'full');
    assert.equal((await fetch(`${base}/test/layout`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ activeLayout: 'missing' }) })).status, 422);
  } finally {
    service.close();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('試験API起動時はtestModeを状態へ記録しリセット後も保持する', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-test-mode-'));
  const statePath = path.join(folder, 'state.json');
  const service = start({ statePath, port: 0, testApi: true, logger: { log() {}, error() {} } });
  await once(service.server, 'listening');
  try {
    assert.equal(service.getState().testMode, true);
    assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).testMode, true);
    const base = `http://127.0.0.1:${service.server.address().port}`;
    assert.equal((await (await fetch(`${base}/health`)).json()).testMode, true);
    await fetch(`${base}/test/reset`, { method: 'POST' });
    assert.equal(service.getState().testMode, true);
  } finally {
    service.close();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('通常起動時はtestModeを記録しない', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-normal-mode-'));
  const statePath = path.join(folder, 'state.json');
  const service = start({ statePath, port: 0, logger: { log() {}, error() {} } });
  await once(service.server, 'listening');
  try {
    assert.equal(service.getState().testMode, false);
  } finally {
    service.close();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('EEW JSONの続報ごとに状態連番と変更ログを進める', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-change-log-'));
  const statePath = path.join(folder, 'state.json');
  const service = start({ statePath, port: 0, logger: { log() {}, error() {} } });
  await once(service.server, 'listening');
  try {
    const base = `http://127.0.0.1:${service.server.address().port}`;
    const post = (serial) => fetch(`${base}/eew`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: 'axis', data: {
      EventID: 'change-event', Serial: serial, ReportDateTime: '2026/11/16 00:00:00', OriginDateTime: '2026/11/16 00:00:00',
      Title: '緊急地震速報', Hypocenter: { Name: '試験震源', Coordinate: [140, 35], Depth: '10km' }, Magnitude: '5.0', Intensity: 40,
      Forecast: [{ Name: '茨城県北部', Intensity: { From: 40, To: 40 } }], Flag: {},
    } }) });
    await post(1); await post(2);
    const records = fs.readFileSync(path.join(folder, 'state-changes.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(records.map((record) => record.seq), [1, 2]);
    assert.deepEqual(records.map((record) => record.added[0].serial), [1, 2]);
  } finally { service.close(); fs.rmSync(folder, { recursive: true, force: true }); }
});

test('source-healthだけの更新は状態連番を進めない', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-health-only-'));
  const statePath = path.join(folder, 'state.json');
  const service = start({ statePath, port: 0, logger: { log() {}, error() {} } });
  await once(service.server, 'listening');
  try {
    const base = `http://127.0.0.1:${service.server.address().port}`;
    const response = await fetch(`${base}/source-health`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: 'jma', ok: false, at: new Date().toISOString(), error: 'timeout' }) });
    assert.equal(response.status, 200);
    assert.equal((await (await fetch(`${base}/health`)).json()).seq, 0);
    assert.equal(fs.existsSync(path.join(folder, 'state-changes.jsonl')), false);
  } finally { service.close(); fs.rmSync(folder, { recursive: true, force: true }); }
});

test('EEWのexpiryは削除を変更ログへ残す', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-expiry-log-'));
  const statePath = path.join(folder, 'state.json');
  const service = start({ statePath, port: 0, testApi: true, logger: { log() {}, error() {} } });
  await once(service.server, 'listening');
  try {
    const base = `http://127.0.0.1:${service.server.address().port}`;
    await fetch(`${base}/test/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ events: [{ kind: 'eew', bulletin: { eventId: 'expiry-event', serial: 1, infoType: '発表', infoKind: '緊急地震速報', earthquake: { hypocenter: { name: '試験震源' }, magnitude: '5.0' }, eewAreaDetails: [] } }] }) });
    await fetch(`${base}/test/clock`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ advanceMs: 30_001 }) });
    const records = fs.readFileSync(path.join(folder, 'state-changes.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(records.some((record) => record.removed.some((row) => row.eventId === 'expiry-event')));
  } finally { service.close(); fs.rmSync(folder, { recursive: true, force: true }); }
});

test('古いEEW JSONは鮮度ガードで取り込まず、新しいものと無効化時は取り込む', () => {
  const formatJst = (ms) => new Date(ms + 9 * 3600_000).toISOString().replace('T', ' ').slice(0, 19);
  const now = Date.now();
  const payload = (reportDateTime) => ({ EventID: 'fresh-event', Serial: 1, ReportDateTime: reportDateTime,
    OriginDateTime: reportDateTime, Title: '緊急地震速報', Hypocenter: { Name: '試験震源', Coordinate: [140, 35], Depth: '10km' },
    Magnitude: '5.0', Intensity: 40, Forecast: [{ Name: '茨城県北部', Intensity: { From: 40, To: 40 } }], Flag: {} });
  const stale = ingestEewJson(createAtlasSnapshot(), 'axis', payload(formatJst(now - 10 * 60_000)), now, { enforceEewFreshness: true });
  assert.equal(stale.filtered, true);
  assert.equal(stale.stale, true);
  assert.equal(stale.state.layers.eew.length, 0);
  const fresh = ingestEewJson(createAtlasSnapshot(), 'axis', payload(formatJst(now)), now, { enforceEewFreshness: true });
  assert.equal(fresh.filtered, false);
  assert.equal(fresh.state.layers.eew.length, 1);
  const unguarded = ingestEewJson(createAtlasSnapshot(), 'axis', payload(formatJst(now - 10 * 60_000)), now);
  assert.equal(unguarded.state.layers.eew.length, 1);
});

test('古いJMA EEW XMLは鮮度ガードで取り込まない', () => {
  const xml = sample('37_01_01_240613_VXSE43.xml');
  const stale = ingestXml(createAtlasSnapshot(), xml, Date.now(), { enforceEewFreshness: true });
  assert.equal(stale.filtered, true);
  assert.equal(stale.stale, true);
  const fresh = ingestXml(createAtlasSnapshot(), xml, Date.parse('2024-04-17T23:14:59+09:00') + 1000, { enforceEewFreshness: true });
  assert.deepEqual(fresh.kinds, ['eew']);
});

test('古いP2P EEWは鮮度ガードで取り込まない', () => {
  const input = { code: 556, earthquake: { time: '2026/04/01 10:06:25' },
    issue: { eventId: 'p2p-freshness', serial: '1', time: '2026/04/01 10:06:39' },
    areas: [{ pref: '茨城', name: '茨城県北部', scaleFrom: 50, scaleTo: 50, arrivalTime: null }] };
  const stale = ingestP2P(createAtlasSnapshot(), input, Date.now(), { enforceEewFreshness: true });
  assert.equal(stale.filtered, true);
  assert.equal(stale.stale, true);
  assert.equal(stale.state.layers.eew.length, 0);
  const fresh = ingestP2P(createAtlasSnapshot(), input, Date.parse('2026-04-01T10:06:39+09:00') + 1000, { enforceEewFreshness: true });
  assert.equal(fresh.state.layers.eew.length, 1);
});

test('鮮度ガード有効時はHTTPでも古いEEWを落とし連番を進めない', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-eew-freshness-'));
  const statePath = path.join(folder, 'state.json');
  const service = start({ statePath, port: 0, eewFreshnessGuard: true, logger: { log() {}, error() {} } });
  await once(service.server, 'listening');
  try {
    const base = `http://127.0.0.1:${service.server.address().port}`;
    const formatJst = (ms) => new Date(ms + 9 * 3600_000).toISOString().replace('T', ' ').slice(0, 19);
    const data = (reportDateTime) => ({ EventID: 'http-freshness', Serial: 1, ReportDateTime: reportDateTime,
      OriginDateTime: reportDateTime, Title: '緊急地震速報', Hypocenter: { Name: '試験震源', Coordinate: [140, 35], Depth: '10km' },
      Magnitude: '5.0', Intensity: 40, Forecast: [{ Name: '茨城県北部', Intensity: { From: 40, To: 40 } }], Flag: {} });
    const staleResponse = await fetch(`${base}/eew`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'axis', data: data(formatJst(Date.now() - 600_000)) }) });
    assert.deepEqual(await staleResponse.json(), { accepted: false, filtered: true, stale: true, kinds: [], updatedAt: 0 });
    assert.equal((await (await fetch(`${base}/health`)).json()).seq, 0);
    assert.equal(fs.existsSync(path.join(folder, 'state-changes.jsonl')), false);
    const freshResponse = await fetch(`${base}/eew`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'axis', data: data(formatJst(Date.now())) }) });
    assert.equal((await freshResponse.json()).accepted, true);
    assert.equal((await (await fetch(`${base}/health`)).json()).seq, 1);
  } finally { service.close(); fs.rmSync(folder, { recursive: true, force: true }); }
});
