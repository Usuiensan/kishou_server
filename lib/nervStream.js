const WebSocket = require('ws');

function parseJson(value) {
  if (Buffer.isBuffer(value)) return JSON.parse(value.toString('utf8'));
  if (typeof value === 'string') return JSON.parse(value);
  return value;
}

/**
 * Mastodon streaming APIのイベントをNERV投稿へ変換する。
 * public:localには他アカウントの投稿も流れるため、ここでアカウントIDを固定確認する。
 */
function parseNervStreamMessage(data, { accountId = '1' } = {}) {
  let event;
  try {
    event = parseJson(data);
  } catch {
    return { kind: 'ignored', reason: 'invalid-event-json' };
  }

  if (!event || event.event !== 'update') {
    return { kind: 'ignored', reason: 'not-update' };
  }

  let status;
  try {
    status = parseJson(event.payload);
  } catch {
    return { kind: 'ignored', reason: 'invalid-payload-json' };
  }

  if (!status || status.account?.id !== accountId) {
    return { kind: 'ignored', reason: 'non-nerv-account', status };
  }
  if (!status.id || !status.content) {
    return { kind: 'ignored', reason: 'invalid-status', status };
  }
  return { kind: 'status', status };
}

function createNervStreamMonitor({
  url,
  WebSocketImpl = WebSocket,
  onStatus,
  onReconnect,
  onDisconnect,
  logger = console,
  accountId = '1',
  initialReconnectDelayMs = 5000,
  maxReconnectDelayMs = 60000,
  statsIntervalMs = 60000,
} = {}) {
  if (!url) throw new Error('NERV streaming URL is required');
  if (typeof onStatus !== 'function') throw new Error('NERV stream onStatus callback is required');

  let socket = null;
  let reconnectTimer = null;
  let statsTimer = null;
  let stopped = false;
  let reconnectDelayMs = initialReconnectDelayMs;
  let reconnectCount = 0;
  let connected = false;
  const stats = {
    receivedPosts: 0,
    excludedPosts: 0,
    reconnectCount: 0,
  };

  const logStats = (prefix = 'NERV WebSocket統計') => {
    logger.info?.(`📊 ${prefix}: 受信投稿=${stats.receivedPosts}, 対象外投稿=${stats.excludedPosts}, 再接続=${stats.reconnectCount}`);
  };

  const scheduleReconnect = () => {
    if (stopped || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, reconnectDelayMs);
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, maxReconnectDelayMs);
  };

  const connect = () => {
    if (stopped) return;
    logger.info?.(`📡 NERV WebSocket接続試行: ${url}`);
    const currentSocket = new WebSocketImpl(url);
    socket = currentSocket;

    currentSocket.on('open', () => {
      if (socket !== currentSocket) return;
      const wasReconnect = reconnectCount > 0;
      connected = true;
      reconnectDelayMs = initialReconnectDelayMs;
      logger.info?.(`✅ NERV WebSocket接続成功${wasReconnect ? '（再接続）' : ''}`);
      if (wasReconnect) void Promise.resolve(onReconnect?.()).catch((error) => {
        logger.error?.(`❌ NERV WebSocket復旧処理エラー: ${error.message}`);
      });
      logStats('NERV WebSocket接続状態');
    });

    currentSocket.on('message', (data) => {
      if (socket !== currentSocket) return;
      let parsed;
      try {
        parsed = parseNervStreamMessage(data, { accountId });
      } catch (error) {
        logger.warn?.(`⚠️ NERV WebSocketイベント処理エラー: ${error.message}`);
        return;
      }
      if (parsed.kind === 'ignored' && ['not-update', 'invalid-event-json', 'invalid-payload-json'].includes(parsed.reason)) return;
      stats.receivedPosts += 1;
      if (parsed.kind === 'ignored') {
        stats.excludedPosts += 1;
        return;
      }
      if (parsed.kind !== 'status') return;
      void Promise.resolve(onStatus(parsed.status)).then((accepted) => {
        if (accepted === false) stats.excludedPosts += 1;
      }).catch((error) => {
        logger.error?.(`❌ NERV WebSocket投稿処理エラー: ${error.message}`);
      });
    });

    currentSocket.on('close', (code, reason) => {
      if (socket !== currentSocket) return;
      socket = null;
      const hadConnection = connected;
      connected = false;
      if (hadConnection) {
        reconnectCount += 1;
        stats.reconnectCount = reconnectCount;
      }
      logger.warn?.(`⚠️ NERV WebSocket切断 (code=${code}, reason=${reason || '不明'})`);
      logStats('NERV WebSocket切断時');
      if (hadConnection) void Promise.resolve(onDisconnect?.()).catch(() => {});
      scheduleReconnect();
    });

    currentSocket.on('error', (error) => {
      logger.error?.(`❌ NERV WebSocketエラー: ${error.message}`);
    });
  };

  statsTimer = setInterval(() => logStats(), statsIntervalMs);
  statsTimer.unref?.();

  return {
    connect,
    stop() {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (statsTimer) clearInterval(statsTimer);
      reconnectTimer = null;
      statsTimer = null;
      socket?.close();
      socket = null;
    },
    getStats() {
      return { ...stats, connected };
    },
  };
}

module.exports = { createNervStreamMonitor, parseNervStreamMessage };
