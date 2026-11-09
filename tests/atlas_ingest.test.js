const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { ingestXml, start } = require('../tools/atlas_ingest');
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
  assert.equal(state.layers.eew.length, 0);
  assert.equal(state.layers.tsunami.length, 1);
});

test('震度電文は震度・縦見出しへ同時に反映する', () => {
  const result = ingestXml(createAtlasSnapshot(), sample('32-39_11_05_240613_VXSE53.xml'), 1000);
  assert.deepEqual(result.kinds, ['intensity', 'vertical']);
  assert.equal(result.state.layers.intensity.length, 1);
  assert.equal(result.state.layers.vertical.length, 1);
});

test('localhostのXML受け口は状態スナップショットを更新しhealthを返す', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-ingest-'));
  const statePath = path.join(folder, 'state.json');
  const logger = { log() {}, error() {} };
  const service = start({ statePath, port: 0, logger });
  await once(service.server, 'listening');
  try {
    const base = `http://127.0.0.1:${service.server.address().port}`;
    const response = await fetch(`${base}/jma`, { method: 'POST', headers: { 'content-type': 'application/xml' }, body: sample('37_01_01_240613_VXSE43.xml') });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).kinds, ['eew']);
    assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).layers.eew.length, 1);
    assert.equal((await fetch(`${base}/health`).then((result) => result.json())).ok, true);
  } finally {
    service.close();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
