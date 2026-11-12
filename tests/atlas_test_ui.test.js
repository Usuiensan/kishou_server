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

test('受信フレーム計測はFPS・間隔分布・提示落ちを表示する', async () => {
  const page = fs.readFileSync('tools/atlas_test_ui.html', 'utf8');
  const script = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)][1][1];
  const vector = JSON.parse(fs.readFileSync('protocol/atlas-ii-vectors.json', 'utf8')).vectors[0];
  const palette = Array.from({ length: 32 }, (_, s) => [85 * (s & 3), 85 * ((s >> 2) & 3), 255 * (s >> 4)]);
  const rgba = new Uint8ClampedArray(360 * 8 * 4);
  for (let i = 0; i < 45; i++) for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    const offset = (y * 360 + i * 8 + x) * 4, color = palette[vector.symbols[i]];
    rgba.set([...color, 255], offset);
  }
  const elements = {};
  const element = (id) => elements[id] ||= { textContent: '', className: '', requestVideoFrameCallback(callback) { this.callback = callback; }, play: async () => {}, pause() {}, load() {}, removeAttribute() {} };
  class PeerConnection {
    iceGatheringState = 'complete';
    addTransceiver() {}
    async createOffer() { return { type: 'offer' }; }
    async setLocalDescription(offer) { this.localDescription = offer; }
    async setRemoteDescription() {}
  }
  const context = {
    document: { getElementById: element, createElement: () => ({ width: 0, height: 0, getContext: () => ({ drawImage() {}, getImageData: () => ({ data: rgba }) }) }) },
    $: element,
    RTCPeerConnection: PeerConnection,
    fetch: async () => ({ ok: true, text: async () => 'answer' }),
    location: { hostname: 'localhost' },
    setInterval() {},
    performance: { now: () => 200 },
  };
  vm.runInNewContext(script, context);
  await new Promise((resolve) => setImmediate(resolve));
  const video = element('streamVideo');
  video.videoWidth = 1280; video.videoHeight = 720;
  video.callback(100, { presentedFrames: 1 });
  video.callback(133, { presentedFrames: 2 });
  video.callback(166, { presentedFrames: 4 });
  assert.match(element('receiveMetrics').textContent, /30\.3 FPS/);
  assert.match(element('receiveMetrics').textContent, /平均 33\.0 ms・最大 33\.0 ms・p95 33\.0 ms/);
  assert.match(element('receiveMetrics').textContent, /Chromium drop 1/);
  assert.match(element('receiveMetrics').textContent, /A2重複 2/);
  assert.match(element('receiveMetrics').textContent, /header異常 0/);
});

test('受信映像のA2検証成功率は接続ごとの累積サンプルで表示する', () => {
  const page = fs.readFileSync('tools/atlas_test_ui.html', 'utf8');
  const script = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)][1][1];
  const vector = JSON.parse(fs.readFileSync('protocol/atlas-ii-vectors.json', 'utf8')).vectors[0];
  const palette = Array.from({ length: 32 }, (_, s) => [85 * (s & 3), 85 * ((s >> 2) & 3), 255 * (s >> 4)]);
  const rgba = new Uint8ClampedArray(1280 * 720 * 4);
  vector.symbols.forEach((symbol, i) => {
    const x0 = i % 160 * 8, y0 = 720 - (Math.floor(i / 160) + 1) * 8;
    for (let y = 2; y <= 5; y++) for (let x = 2; x <= 5; x++) rgba.set([...palette[symbol], 255], ((y0 + y) * 1280 + x0 + x) * 4);
  });
  const elements = {};
  const element = (id) => elements[id] ||= { textContent: '', className: '', value: '', videoWidth: 1280, videoHeight: 720, readyState: 2, play: async () => {}, pause() {}, load() {}, removeAttribute() {} };
  const context = { document: { getElementById: element, createElement: () => ({ getContext: () => ({ drawImage() {}, getImageData: () => ({ data: rgba }) }) }) },
    $: element, fetch: async () => ({ ok: true, text: async () => 'answer' }), RTCPeerConnection: class {},
    location: { hostname: 'localhost' }, setInterval() {}, performance: { now: () => 0 }, Date };
  vm.runInNewContext(script, context);
  context.verifyStreamFrame();
  context.verifyStreamFrame();
  assert.match(element('verifySummary').textContent, /A2検証成功率 2\/2 \(100\.0%\)/, element('verifyResult').textContent);
});

test('処理段階の計測は実測値と未取得を区別して表示する', async () => {
  const page = fs.readFileSync('tools/atlas_test_ui.html', 'utf8');
  const script = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)][1][1];
  const elements = {};
  const element = (id) => elements[id] ||= { textContent: '', className: '', requestVideoFrameCallback(callback) { this.callback = callback; }, play: async () => {}, pause() {}, load() {}, removeAttribute() {} };
  class PeerConnection { addTransceiver() {} async createOffer() { return {}; } async setLocalDescription() { this.localDescription = {}; } async setRemoteDescription() {} }
  let perfNow = 0;
  const context = {
    document: { getElementById: element }, $: element,
    RTCPeerConnection: PeerConnection,
    fetch: async (url) => url === '/test/metrics'
      ? { ok: true, json: async () => ({ chromiumCapture: { fps: 29.5, sampleCount: 10, durationMs: { average: 4, max: 8, p95: 7 }, intervalMs: { p95: 34 }, lastAtUnixMs: Date.now(), blink: { animationCount: 3, periodMs: 3000, onMs: 2253, offMs: 747, phaseMs: 500, expectedVisible: true, visibleCount: 3, phaseDriftMs: { average: 1, max: 2, p95: 2 }, phaseSpreadMs: { average: 0, max: 0, p95: 0 }, groups: { 'tsunami-mini': 1, 'tsunami-mini-left': 1, 'atlas-alpha-mirror': 1 } } }, processes: { renderer: { available: true, pid: 42, cpuPercent: 25, memoryBytes: 10485760 } } }) }
      : { ok: true, text: async () => 'answer' },
    location: { hostname: 'localhost' }, setInterval() {}, performance: { now: () => perfNow }, Date,
  };
  vm.runInNewContext(script, context);
  await context.refreshStageMetrics();
  assert.match(element('stageMetrics').textContent, /Chromium capture: 29\.5 FPS/);
  assert.match(element('stageMetrics').textContent, /津波点滅: 周期 3000 ms・ON 2253 ms・OFF 747 ms/);
  assert.match(element('stageMetrics').textContent, /PNG→RGB変換: 未取得/);
  assert.match(element('stageMetrics').textContent, /FFmpeg encoder: 未取得/);
  assert.match(element('stageMetrics').textContent, /renderer\(PID 42\): CPU 25% \/ メモリ 10\.0 MiB/);
  perfNow = 2100; context.showReceiveStall();
  assert.match(element('receiveMetrics').textContent, /未受信: 接続開始から 2\.1 秒/);
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
