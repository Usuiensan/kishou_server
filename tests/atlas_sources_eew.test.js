const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { start, jwtExpiryMs, axisRefreshDue } = require('../tools/atlas_sources');

class FakeWebSocket extends EventEmitter {
  static instances = [];
  constructor(url, options) {
    super();
    this.url = url;
    this.options = options;
    this.sent = [];
    FakeWebSocket.instances.push(this);
  }
  send(data) { this.sent.push(data); }
  close() { this.emit('close'); }
}

const silentLogger = { log() {}, error() {} };
const tick = () => new Promise((resolve) => setImmediate(resolve));

function fakeFetch(calls) {
  return async (url, options = {}) => {
    calls.push([url, options]);
    if (String(url).endsWith('eqvol.xml')) {
      return { ok: true, text: async () => '<feed></feed>' };
    }
    if (String(url).includes('axis.prioris.jp/api/server/list')) {
      return { ok: true, json: async () => ({ servers: ['wss://ws.axis.test'] }) };
    }
    return { ok: true, json: async () => ({}) };
  };
}

const wolfxMessage = {
  type: 'jma_eew', EventID: 1, Serial: 1, isWarn: true, isCancel: false, isTraining: false,
  AnnouncedTime: '2026/11/12 12:00:05', OriginTime: '2026/11/12 12:00:00',
  Hypocenter: '駿河湾', Latitude: 34.8, Longitude: 138.5, Depth: 10, Magnitude: 6.1, MaxIntensity: '5弱',
  OriginalText: 'EBI 441 S4545 120030 10 9999=',
};

test('Wolfxへ接続してqueryを送り、jma_eewをingestへ中継し、心拍へpingで応答する', async () => {
  FakeWebSocket.instances = [];
  const calls = [];
  const service = start({ ingestUrl: 'http://127.0.0.1:8765', logger: silentLogger,
    fetchImpl: fakeFetch(calls), WebSocketImpl: FakeWebSocket, axisToken: '', axisTokenFile: '', env: {} });
  await tick();
  const wolfx = FakeWebSocket.instances.find((socket) => socket.url.includes('wolfx'));
  assert.ok(wolfx, 'wolfx socket exists');
  wolfx.emit('open');
  assert.deepEqual(wolfx.sent, ['query_jmaeew']);
  wolfx.emit('message', Buffer.from(JSON.stringify(wolfxMessage)));
  await tick();
  const relay = calls.find(([url]) => String(url).endsWith('/eew'));
  assert.ok(relay, 'relayed to /eew');
  assert.equal(JSON.parse(relay[1].body).source, 'wolfx');
  wolfx.emit('message', Buffer.from(JSON.stringify({ type: 'heartbeat' })));
  assert.deepEqual(wolfx.sent, ['query_jmaeew', 'ping']);
  service.stop();
});

test('Axisはトークンが無いと接続せず、あるとサーバ一覧を取得してBearerで接続する', async () => {
  FakeWebSocket.instances = [];
  const calls = [];
  const token = ['x', Buffer.from(JSON.stringify({ exp: 1999999999 })).toString('base64url'), 'y'].join('.');
  const service = start({ ingestUrl: 'http://127.0.0.1:8765', logger: silentLogger,
    fetchImpl: fakeFetch(calls), WebSocketImpl: FakeWebSocket, axisToken: token, axisTokenFile: '', env: {} });
  await tick();
  await tick();
  const axis = FakeWebSocket.instances.find((socket) => socket.url.includes('ws.axis.test'));
  assert.ok(axis, 'axis socket exists');
  assert.equal(axis.url, 'wss://ws.axis.test/socket');
  assert.equal(axis.options.headers.authorization, `Bearer ${token}`);
  const listCall = calls.find(([url]) => String(url).includes('api/server/list'));
  assert.equal(listCall[1].headers.authorization, `Bearer ${token}`);
  service.stop();
});

test('Axisトークンのリフレッシュは月末まで7日未満かつ期限が翌月内のときだけ', () => {
  const makeToken = (expSeconds) => ['x', Buffer.from(JSON.stringify({ exp: expSeconds })).toString('base64url'), 'y'].join('.');
  const lateNovember = new Date(2026, 10, 25); // 2026-11-25, 残り5日
  const nextMonthEnd = Math.floor(new Date(2026, 11, 31, 23, 59).getTime() / 1000);
  assert.equal(axisRefreshDue(makeToken(nextMonthEnd), lateNovember), true);
  const earlyNovember = new Date(2026, 10, 10);
  assert.equal(axisRefreshDue(makeToken(nextMonthEnd), earlyNovember), false);
  assert.equal(jwtExpiryMs('not-a-jwt'), null);
  assert.equal(axisRefreshDue('not-a-jwt', lateNovember), false);
});
