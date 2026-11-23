const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { pollJma, start, wolfxEqlistSignatures } = require('../tools/atlas_sources');

class FakeWebSocket extends EventEmitter {
  static instances = [];
  constructor(url) { super(); this.url = url; FakeWebSocket.instances.push(this); }
  close() { this.emit('close'); }
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('JMA Atom EEW entries are fetched once and posted to the loopback ingest endpoint', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push([url, options]);
    if (url.endsWith('eqvol.xml')) return { ok: true, text: async () => `<feed><entry><updated>${new Date().toISOString()}</updated><link href="https://example.test/VXSE43.xml"/></entry><entry><link href="https://example.test/VPWW53.xml"/></entry></feed>` };
    if (url.endsWith('VXSE43.xml')) return { ok: true, text: async () => '<Report />' };
    return { ok: true };
  };
  const processed = new Set();
  const result = await pollJma({ fetchImpl, ingestUrl: 'http://127.0.0.1:8765', processed });
  assert.equal(result.accepted, 1);
  assert.equal(calls.length, 3);
  assert.equal(calls[2][0], 'http://127.0.0.1:8765/jma');
  assert.equal(calls[2][1].body, '<Report />');
  assert.equal(processed.has('https://example.test/VXSE43.xml'), true);
});

test('JMAの各エントリをquarantine/retryableに分類し、後続と次回再試行を維持する', async () => {
  const calls = [];
  const processed = new Set();
  const responses = {
    'https://example.test/VXSE43-one.xml': { ok: true, text: async () => '<one/>' },
    'https://example.test/VXSE43-two.xml': { ok: true, text: async () => '<two/>' },
    'https://example.test/VXSE43-missing.xml': { ok: false, status: 404 },
    'https://example.test/VXSE43-down.xml': { ok: false, status: 500 },
  };
  const fetchImpl = async (url, options) => {
    calls.push([url, options]);
    if (url.endsWith('eqvol.xml')) return { ok: true, text: async () => '<feed>'
      + ['one', 'two', 'missing', 'down'].map((name) => `<entry><link href="https://example.test/VXSE43-${name}.xml"/></entry>`).join('') + '</feed>' };
    if (responses[url]) return responses[url];
    if (url.endsWith('/jma')) {
      const body = options.body;
      return body === '<one/>' ? { ok: false, status: 422, text: async () => '{"reason":"bad"}' }
        : { ok: true, text: async () => '{"accepted":false,"filtered":true,"reason":"no_displayable_content"}' };
    }
    throw new Error(`unexpected URL ${url}`);
  };
  const result = await pollJma({ fetchImpl, ingestUrl: 'http://atlas', processed, now: 0, logger: { error() {} } });
  assert.deepEqual({ accepted: result.accepted, filtered: result.filtered, quarantined: result.quarantined, retryable: result.retryable },
    { accepted: 0, filtered: 1, quarantined: 2, retryable: 1 });
  assert.deepEqual([...processed].sort(), ['https://example.test/VXSE43-missing.xml', 'https://example.test/VXSE43-one.xml', 'https://example.test/VXSE43-two.xml'].sort());
  assert.equal(calls.filter(([url]) => url === 'https://example.test/VXSE43-down.xml').length, 1);
});

test('詳細取得の404はquarantine、500はretryableになる', async () => {
  const fetchImpl = async (url) => url.endsWith('eqvol.xml')
    ? { ok: true, text: async () => '<feed><entry><link href="https://example.test/VXSE43-404.xml"/></entry><entry><link href="https://example.test/VXSE43-500.xml"/></entry></feed>' }
    : { ok: false, status: url.endsWith('404.xml') ? 404 : 500 };
  const processed = new Set();
  const result = await pollJma({ fetchImpl, ingestUrl: 'http://atlas', processed, logger: { error() {} } });
  assert.equal(result.quarantined, 1);
  assert.equal(result.retryable, 1);
  assert.equal(processed.has('https://example.test/VXSE43-404.xml'), true);
  assert.equal(processed.has('https://example.test/VXSE43-500.xml'), false);
});

test('ingest 500はretryableのまま次回pollで再試行する', async () => {
  const url = 'https://example.test/VXSE43-retry.xml';
  let attempts = 0;
  const fetchImpl = async (requestUrl) => {
    if (requestUrl.endsWith('eqvol.xml')) return { ok: true, text: async () => `<feed><entry><link href="${url}"/></entry></feed>` };
    if (requestUrl === url) return { ok: true, text: async () => '<retry/>' };
    attempts++;
    return attempts === 1 ? { ok: false, status: 500 } : { ok: true, json: async () => ({ accepted: true }) };
  };
  const processed = new Set();
  const first = await pollJma({ fetchImpl, ingestUrl: 'http://atlas', processed, logger: { error() {} } });
  assert.equal(first.retryable, 1);
  assert.equal(processed.has(url), false);
  const second = await pollJma({ fetchImpl, ingestUrl: 'http://atlas', processed, logger: { error() {} } });
  assert.equal(second.accepted, 1);
  assert.equal(processed.has(url), true);
});

test('eqlistの変化で詳細を取得し、同一reportは再送せず失敗時は再試行する', async () => {
  FakeWebSocket.instances = [];
  const calls = [];
  let detailAttempts = 0;
  const event = { eventId: 'wolfx-event', reports: [{ id: 'report-1', product: 'VXSE51', status: 'issued', time: new Date(Date.now() - 1000).toISOString() }] };
  const fetchImpl = async (url, options = {}) => {
    calls.push([url, options]);
    if (String(url).includes('jma_earthquake_detail')) {
      detailAttempts++;
      if (detailAttempts === 1) throw new Error('temporary');
      return { ok: true, json: async () => ({ events: [event] }) };
    }
    if (String(url).endsWith('/wolfx-eq')) return { ok: true };
    return { ok: true, text: async () => '<feed></feed>' };
  };
  const service = start({ ingestUrl: 'http://atlas', fetchImpl, WebSocketImpl: FakeWebSocket,
    logger: { log() {}, error() {} }, env: {} });
  try {
    const socket = FakeWebSocket.instances.find((item) => item.url.includes('jma_eqlist'));
    assert.ok(socket);
    socket.emit('message', JSON.stringify({ No1: { EventID: 'wolfx-event', Title: 'a', time: '1', hypocenter: 'x', magnitude: '2', shindo: '3', depth: '4' } }));
    await tick();
    assert.equal(detailAttempts, 1);
    socket.emit('message', JSON.stringify({ No1: { EventID: 'wolfx-event', Title: 'b', time: '1', hypocenter: 'x', magnitude: '2', shindo: '3', depth: '4' } }));
    await tick();
    assert.equal(detailAttempts, 2);
    assert.equal(calls.filter(([url]) => String(url).endsWith('/wolfx-eq')).length, 1);
    socket.emit('message', JSON.stringify({ No1: { EventID: 'wolfx-event', Title: 'b', time: '1', hypocenter: 'x', magnitude: '2', shindo: '3', depth: '4' } }));
    await tick();
    assert.equal(detailAttempts, 2);
    assert.deepEqual([...wolfxEqlistSignatures({ hello: {}, No1: { EventID: 'x', Title: 't', time: 'd', hypocenter: 'h', magnitude: 1, shindo: 2, depth: 3 } })], [['x', 't|d|h|1|2|3']]);
  } finally { service.stop(); }
});

