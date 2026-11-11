const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { ingestXml, ingestP2P, ingestTestEvents, start } = require('../tools/atlas_ingest');
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

test('P2P警報入力も区域別Atlas II EEWイベントとして保持する', () => {
  const result = ingestP2P(createAtlasSnapshot(), {
    code: 556, earthquake: { time: '2026/04/01 10:06:25' },
    issue: { eventId: 'p2p-event', serial: '1', time: '2026/04/01 10:06:39' },
    areas: [{ pref: '茨城', name: '茨城県北部', scaleFrom: 50, scaleTo: 50, arrivalTime: null }],
  }, 1000);
  assert.equal(result.state.layers.eew[0].payload.atlasII.areas[0].areaId, 300);
  assert.equal(result.state.layers.eew[0].payload.atlasII.areas[0].areaFlags & 4, 4);
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
    const response = await fetch(`${base}/jma`, { method: 'POST', headers: { 'content-type': 'application/xml' }, body: sample('37_01_01_240613_VXSE43.xml') });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).kinds, ['eew']);
    assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).layers.eew.length, 1);
    assert.equal((await fetch(`${base}/source-health`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'jma', ok: false, at: new Date().toISOString(), error: 'timeout' }) })).status, 200);
    assert.equal((await fetch(`${base}/health`).then((result) => result.json())).sourceHealth.jma.error, 'timeout');
    const p2p = await fetch(`${base}/p2p`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 556, earthquake: {}, issue: { eventId: 'p2p-http', serial: '1', time: '2026/04/01 10:06:39' },
        areas: [{ pref: '茨城', name: '茨城県北部', scaleFrom: 40, scaleTo: 40 }] }) });
    assert.equal(p2p.status, 200);
    assert.deepEqual((await p2p.json()).kinds, ['eew']);
    assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).layers.eew.length, 2);
    assert.equal((await fetch(`${base}/health`).then((result) => result.json())).ok, true);
  } finally {
    service.close();
    fs.rmSync(folder, { recursive: true, force: true });
  }
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
    assert.deepEqual((await input.json()).kinds, ['eew', 'eew']);
    assert.equal(service.getState().layers.eew.length, 2);
    const reset = await fetch(`${base}/test/reset`, { method: 'POST' });
    assert.equal(reset.status, 200);
    assert.equal(service.getState().layers.eew.length, 0);
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
    await fetch(`${base}/test/events`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ events: [{ xml: sample('37_01_01_240613_VXSE43.xml') }] }) });
    assert.equal(service.getState().atlasIIConfig.activeLayout, 'reverseL');
    await fetch(`${base}/test/reset`, { method: 'POST' });
    assert.equal(service.getState().atlasIIConfig.activeLayout, 'reverseL');
    assert.equal((await fetch(`${base}/test/layout`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ activeLayout: 'missing' }) })).status, 422);
  } finally {
    service.close();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
