const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const { createNervStreamMonitor, parseNervStreamMessage } = require('../lib/nervStream');

const status = (id = '100') => ({
  id,
  content: '<p>避難情報を発表しました</p>',
  created_at: '2026-07-30T00:00:00Z',
  account: { id: '1' },
});

test('Mastodon updateイベントのpayloadを解析する', () => {
  const result = parseNervStreamMessage(JSON.stringify({
    event: 'update',
    payload: JSON.stringify(status()),
  }));
  assert.equal(result.kind, 'status');
  assert.equal(result.status.id, '100');
});

test('UN_NERV以外のローカル投稿を除外する', () => {
  const result = parseNervStreamMessage({
    event: 'update',
    payload: JSON.stringify({ ...status(), account: { id: '2' } }),
  });
  assert.equal(result.kind, 'ignored');
  assert.equal(result.reason, 'non-nerv-account');
});

test('update以外のイベントと不正payloadを処理対象にしない', () => {
  assert.equal(parseNervStreamMessage({ event: 'delete', payload: '{}' }).reason, 'not-update');
  assert.equal(parseNervStreamMessage({ event: 'update', payload: '{' }).reason, 'invalid-payload-json');
});

test('切断後に指数バックオフで再接続し、統計を保持する', async () => {
  class FakeWebSocket extends EventEmitter {
    static instances = [];
    constructor() {
      super();
      FakeWebSocket.instances.push(this);
    }
    close() {}
  }

  const accepted = [];
  let reconnects = 0;
  const monitor = createNervStreamMonitor({
    url: 'wss://example.test/stream',
    WebSocketImpl: FakeWebSocket,
    initialReconnectDelayMs: 1,
    maxReconnectDelayMs: 2,
    statsIntervalMs: 100000,
    logger: { info() {}, warn() {}, error() {} },
    onStatus: (item) => { accepted.push(item.id); return true; },
    onReconnect: () => { reconnects += 1; },
  });

  monitor.connect();
  const first = FakeWebSocket.instances[0];
  first.emit('open');
  first.emit('message', JSON.stringify({ event: 'update', payload: JSON.stringify(status('1')) }));
  first.emit('message', JSON.stringify({ event: 'update', payload: JSON.stringify({ ...status('2'), account: { id: '2' } }) }));
  first.emit('close', 1006, 'test');
  await new Promise((resolve) => setTimeout(resolve, 10));
  FakeWebSocket.instances[1].emit('open');

  assert.deepEqual(accepted, ['1']);
  assert.equal(reconnects, 1);
  assert.equal(FakeWebSocket.instances.length, 2);
  assert.deepEqual(monitor.getStats(), {
    receivedPosts: 2,
    excludedPosts: 1,
    reconnectCount: 1,
    connected: true,
  });
  monitor.stop();
});
