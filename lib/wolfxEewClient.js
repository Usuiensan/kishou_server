"use strict";

// Discord 情報 bot (jma_server.js) 用の Wolfx EEW クライアント。
// bot は P2P 556 と JMA XML しか購読しておらず、予報級 EEW が届かなかった
// ため、GCE 側の bot 自身が Wolfx へ接続して予報級を取り込む (2026-11-14
// ユーザー決定)。接続・再接続・心拍の方式は tools/atlas_sources.js の
// Wolfx 接続と同じ: 接続直後に query_jmaeew で最新報を問い合わせ、
// heartbeat には ping で応答し、切断時は 5 秒から最大 300 秒まで
// バックオフして再接続する。受信した EEW は lib/parsers/eewJson.js で
// 既存経路 (P2P 556 / JMA XML) と同じ bulletin 形式へ変換してから
// onBulletin へ渡すため、重複管理 (EewTracker) は経路を問わず効く。

const WebSocket = require('ws');
const { normalizeEewMessage, mapEewJson } = require('./parsers/eewJson');

const WOLFX_EEW_URL = 'wss://ws-api.wolfx.jp/all_eew';

function startWolfxEewClient({ url = WOLFX_EEW_URL, onBulletin, logger = console, WebSocketImpl = WebSocket } = {}) {
  let stopped = false;
  let socket = null;
  let timer = null;
  let delay = 5000;

  const scheduleRetry = () => {
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(connect, delay);
    delay = Math.min(delay * 2, 300_000);
  };

  function connect() {
    if (stopped) return;
    try {
      socket = new WebSocketImpl(url);
    } catch (error) {
      logger.error(`Wolfx WebSocket error: ${error.message}`);
      scheduleRetry();
      return;
    }
    socket.on('open', () => {
      delay = 5000;
      logger.log('Wolfx WebSocket connected');
      try { socket.send('query_jmaeew'); } catch { /* 切断側で回復する */ }
    });
    socket.on('message', (data) => {
      let message;
      try { message = JSON.parse(data.toString()); } catch { return; }
      const relay = normalizeEewMessage('wolfx', message);
      if (!relay) return;
      if (relay.heartbeat) {
        try { socket.send('ping'); } catch { /* 切断側で回復する */ }
        return;
      }
      if (relay.endpoint !== 'eew') return;
      const bulletin = mapEewJson('wolfx', relay.data);
      if (!bulletin || !onBulletin) return;
      try { onBulletin(bulletin); } catch (error) { logger.error(`Wolfx EEW handling failed: ${error.message}`); }
    });
    socket.on('close', () => scheduleRetry());
    socket.on('error', (error) => logger.error(`Wolfx WebSocket error: ${error.message}`));
  }

  connect();
  return {
    stop() {
      stopped = true;
      clearTimeout(timer);
      try { socket?.close(); } catch { /* 終了済み */ }
    },
  };
}

module.exports = { startWolfxEewClient, WOLFX_EEW_URL };
