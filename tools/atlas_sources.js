#!/usr/bin/env node
"use strict";

const fs = require('node:fs');
const { XMLParser } = require('fast-xml-parser');
const WebSocket = require('ws');
const fetch = require('node-fetch');
const { normalizeEewMessage } = require('../lib/parsers/eewJson');

const FEED_URL = 'https://www.data.jma.go.jp/developer/xml/feed/eqvol.xml';
const P2P_URL = 'wss://api.p2pquake.net/v2/ws';
const WOLFX_URL = 'wss://ws-api.wolfx.jp/all_eew';
const PROJECTBS_URL = 'wss://telegram-cf.projectbs.cn/jmaeewws/';
const AXIS_SERVER_LIST_URL = 'https://axis.prioris.jp/api/server/list/';
const AXIS_REFRESH_URL = 'https://axis.prioris.jp/api/token/refresh/';
const POLL_MS = 30_000;
const RETAIN_MS = 3 * 60 * 60_000;
const TARGET = /(?:VXSE4[2-5]|VXSE5[1-3]|VXSE62|VTSE4[1]|VTSE5[12])/;

function feedEntries(xml) {
  const feed = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' }).parse(xml).feed;
  const rows = feed?.entry == null ? [] : Array.isArray(feed.entry) ? feed.entry : [feed.entry];
  return rows.map((entry) => ({
    url: entry.link?.href || entry.link || '',
    updated: entry.updated || '',
  })).filter(({ url, updated }) => TARGET.test(url) && (!updated || Date.now() - Date.parse(updated) < RETAIN_MS));
}

async function pollJma({ fetchImpl = fetch, ingestUrl, processed = new Set(), now = Date.now() }) {
  const response = await fetchImpl(FEED_URL, { timeout: 10_000 });
  if (!response.ok) throw new Error(`JMA feed HTTP ${response.status}`);
  const rows = feedEntries(await response.text()).reverse();
  let accepted = 0;
  for (const { url } of rows) {
    if (processed.has(url)) continue;
    const detail = await fetchImpl(url, { timeout: 10_000 });
    if (!detail.ok) throw new Error(`JMA detail HTTP ${detail.status}: ${url}`);
    const body = await detail.text();
    const ingest = await fetchImpl(`${ingestUrl}/jma`, { timeout: 10_000,
      method: 'POST', headers: { 'content-type': 'application/xml; charset=utf-8' }, body,
    });
    if (!ingest.ok) throw new Error(`Atlas ingest HTTP ${ingest.status}: ${url}`);
    processed.add(url);
    accepted++;
  }
  while (processed.size > 2000) processed.delete(processed.values().next().value);
  return { accepted, checkedAt: new Date(now).toISOString() };
}

// JWT の payload を検証なしで読む（Axis トークンの有効期限判定だけに使う）
function jwtExpiryMs(token) {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
    return Number.isFinite(payload.exp) ? payload.exp * 1000 : null;
  } catch { return null; }
}

// Axis のリフレッシュ可否: 今月の残り日数が7日未満のときだけ API を呼んでよい（公式ドキュメントの制限）
function axisRefreshDue(token, now = new Date()) {
  const expiry = jwtExpiryMs(token);
  if (!expiry || expiry <= now.getTime()) return false;
  const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  return lastDay - now.getDate() < 7 && expiry < new Date(now.getFullYear(), now.getMonth() + 2, 1).getTime();
}

function start({ ingestUrl = 'http://127.0.0.1:8765', logger = console,
  fetchImpl = fetch, WebSocketImpl = WebSocket, pollMs = POLL_MS,
  axisToken = process.env.AXIS_TOKEN || '', axisTokenFile = process.env.AXIS_TOKEN_FILE || '',
  env = process.env } = {}) {
  const processed = new Set();
  let stopped = false;
  let ws;
  let reconnectTimer;
  let pollTimer;
  let polling = false;
  const postHealth = (source, ok, error = null) => fetchImpl(`${ingestUrl}/source-health`, { timeout: 5000,
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ source, ok, error, at: new Date().toISOString() }),
  }).then((response) => { if (!response.ok) throw new Error(`HTTP ${response.status}`); })
    .catch((cause) => logger.error(`source health update failed: ${cause.message}`));
  const postJson = (pathName, payload) => fetchImpl(`${ingestUrl}${pathName}`, { timeout: 5000,
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
    .then((response) => { if (!response.ok) throw new Error(`HTTP ${response.status}`); return response; });
  const poll = async () => {
    if (polling || stopped) return;
    polling = true;
    try {
      const result = await pollJma({ fetchImpl, ingestUrl, processed });
      await postHealth('jma', true);
      logger.log(`JMA feed checked; accepted=${result.accepted}`);
    } catch (error) {
      await postHealth('jma', false, error.message);
      logger.error(`JMA feed failed: ${error.message}`);
    } finally { polling = false; }
  };
  const connect = () => {
    if (stopped) return;
    ws = new WebSocketImpl(P2P_URL);
    ws.on('open', () => { void postHealth('p2p', true); logger.log('P2P WebSocket connected'); });
    ws.on('ping', () => { void postHealth('p2p', true); });
    ws.on('message', (data) => {
      try {
        const input = JSON.parse(data.toString());
        if (input.code !== 556) return;
        void fetchImpl(`${ingestUrl}/p2p`, { timeout: 5000, method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input) }).then((response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return postHealth('p2p', true);
        }).catch((error) => logger.error(`P2P ingest failed: ${error.message}`));
      } catch (error) { logger.error(`P2P message failed: ${error.message}`); }
    });
    ws.on('close', () => {
      void postHealth('p2p', false, 'WebSocket disconnected');
      if (!stopped) reconnectTimer = setTimeout(connect, 5000);
    });
    ws.on('error', (error) => logger.error(`P2P WebSocket error: ${error.message}`));
  };

  // ---- 追加の EEW 情報源 (Wolfx / ProjectBS / Axis) ----
  // 切断時は 5 秒から最大 300 秒まで間隔を広げて再接続する（停止中の情報源で回し続けない）。
  const extraSockets = [];
  const connectBackoff = (source, connectFn) => {
    let delay = 5000;
    let timer = null;
    const attempt = () => { if (!stopped) connectFn(api); };
    const api = {
      success() { delay = 5000; },
      retry() {
        if (stopped) return;
        clearTimeout(timer);
        timer = setTimeout(attempt, delay);
        delay = Math.min(delay * 2, 300_000);
      },
    };
    attempt();
    return { stop() { clearTimeout(timer); } };
  };
  const relayMessage = (source, raw) => {
    let message;
    try { message = JSON.parse(raw.toString()); } catch { return; }
    const relay = normalizeEewMessage(source, message);
    if (!relay) return;
    if (relay.heartbeat) {
      void postHealth(source, true);
      return 'heartbeat';
    }
    if (relay.endpoint === 'jma') {
      void fetchImpl(`${ingestUrl}/jma`, { timeout: 5000, method: 'POST',
        headers: { 'content-type': 'application/xml; charset=utf-8' }, body: relay.xml })
        .then((response) => { if (!response.ok) throw new Error(`HTTP ${response.status}`); return postHealth(source, true); })
        .catch((error) => logger.error(`${source} ingest failed: ${error.message}`));
      return;
    }
    void postJson('/eew', { source, data: relay.data })
      .then(() => postHealth(source, true))
      .catch((error) => logger.error(`${source} ingest failed: ${error.message}`));
  };
  const openSocket = (source, url, { headers, onOpen } = {}) => {
    let handle = null;
    const session = connectBackoff(source, (api) => {
      let socket;
      try { socket = new WebSocketImpl(url, headers ? { headers } : undefined); } catch (error) {
        logger.error(`${source} WebSocket error: ${error.message}`);
        void postHealth(source, false, error.message);
        api.retry();
        return;
      }
      socket.on('open', () => {
        api.success();
        void postHealth(source, true);
        logger.log(`${source} WebSocket connected`);
        if (onOpen) { try { onOpen(socket); } catch (error) { logger.error(`${source} open handler failed: ${error.message}`); } }
      });
      socket.on('message', (data) => {
        const text = data.toString();
        if (text === 'hello' || text === 'hb') { void postHealth(source, true); return; }
        if (relayMessage(source, text) === 'heartbeat' && source !== 'axis') {
          try { socket.send(source === 'wolfx' ? 'ping' : 'queryjson'); } catch { /* 再接続側で回復する */ }
        }
      });
      socket.on('close', () => { void postHealth(source, false, 'WebSocket disconnected'); api.retry(); });
      socket.on('error', (error) => logger.error(`${source} WebSocket error: ${error.message}`));
      handle = socket;
    });
    const entry = { stop() { session.stop(); try { handle?.close(); } catch { /* 終了済み */ } } };
    extraSockets.push(entry);
    return entry;
  };

  // Wolfx: 登録・認証不要。接続直後に最新 EEW を問い合わせ、心拍には ping で応答する。
  openSocket('wolfx', env.WOLFX_EEW_URL || WOLFX_URL, { onOpen: (socket) => socket.send('query_jmaeew') });
  // ProjectBS: 登録・認証不要。心拍のたびに最新 JSON を問い合わせる（Zero Quake と同じ運用）。
  openSocket('projectbs', env.PROJECTBS_EEW_URL || PROJECTBS_URL, { onOpen: (socket) => socket.send('queryjson') });

  // Axis: アクセストークンがある場合だけ接続する。トークンは環境変数 AXIS_TOKEN、
  // または AXIS_TOKEN_FILE が指すファイル（リフレッシュ後の保存先を兼ねる）から読む。
  let currentAxisToken = '';
  try {
    if (axisTokenFile && fs.existsSync(axisTokenFile)) currentAxisToken = fs.readFileSync(axisTokenFile, 'utf8').trim();
  } catch (error) { logger.error(`Axis token file read failed: ${error.message}`); }
  if (!currentAxisToken) currentAxisToken = String(axisToken || '').trim();
  let axisSession = null;
  let axisRefreshTimer = null;
  const connectAxis = () => {
    if (stopped || !currentAxisToken) return;
    let handle = null;
    axisSession = connectBackoff('axis', (api) => {
      (async () => {
        try {
          const list = await fetchImpl(AXIS_SERVER_LIST_URL, { timeout: 10_000,
            headers: { authorization: `Bearer ${currentAxisToken}` } });
          if (!list.ok) throw new Error(`Axis server list HTTP ${list.status}`);
          const servers = (await list.json()).servers;
          if (!Array.isArray(servers) || !servers.length) throw new Error('Axis server list is empty');
          if (stopped) return;
          const server = String(servers[0]).replace(/\/$/, '');
          const socket = new WebSocketImpl(`${server}/socket`, { headers: { authorization: `Bearer ${currentAxisToken}` } });
          handle = socket;
          let heartbeatTimer = null;
          socket.on('open', () => {
            api.success();
            void postHealth('axis', true);
            logger.log('axis WebSocket connected');
            heartbeatTimer = setInterval(() => {
              try { socket.send('hb'); } catch { /* 切断側で回復する */ }
              void postHealth('axis', true);
            }, 50_000);
          });
          socket.on('message', (data) => {
            const text = data.toString();
            if (text === 'hello' || text === 'hb') return;
            relayMessage('axis', text);
          });
          socket.on('close', () => {
            clearInterval(heartbeatTimer);
            void postHealth('axis', false, 'WebSocket disconnected');
            api.retry();
          });
          socket.on('error', (error) => logger.error(`axis WebSocket error: ${error.message}`));
        } catch (error) {
          logger.error(`axis connect failed: ${error.message}`);
          void postHealth('axis', false, error.message);
          api.retry();
        }
      })();
    });
    axisSession.stopSocket = () => { try { handle?.close(); } catch { /* 終了済み */ } };
  };
  if (currentAxisToken) {
    connectAxis();
    // トークンリフレッシュは公式制限に従い、残り7日未満の時期に1日1回だけ試す
    axisRefreshTimer = setInterval(() => {
      if (stopped || !axisRefreshDue(currentAxisToken)) return;
      void (async () => {
        try {
          const response = await fetchImpl(AXIS_REFRESH_URL, { timeout: 10_000,
            headers: { authorization: `Bearer ${currentAxisToken}` } });
          const body = await response.json().catch(() => ({}));
          if (response.status === 402) { logger.error('axis token refresh failed: contract has expired'); return; }
          if (!response.ok || !body.token || body.token === currentAxisToken) return;
          currentAxisToken = body.token;
          if (axisTokenFile) {
            try { fs.writeFileSync(axisTokenFile, `${currentAxisToken}\n`, { mode: 0o600 }); }
            catch (error) { logger.error(`Axis token file write failed: ${error.message}`); }
          }
          logger.log('axis token refreshed');
          // 接続中なら閉じれば再接続経路が新しいトークンで接続し直す。切断中なら次回試行が使う。
          axisSession?.stopSocket?.();
        } catch (error) { logger.error(`axis token refresh failed: ${error.message}`); }
      })();
    }, 24 * 60 * 60_000);
  } else {
    logger.log('axis source disabled: AXIS_TOKEN is not set');
  }

  void poll();
  pollTimer = setInterval(() => void poll(), pollMs);
  connect();
  return { stop() {
    stopped = true;
    clearInterval(pollTimer);
    clearTimeout(reconnectTimer);
    clearInterval(axisRefreshTimer);
    axisSession?.stop();
    axisSession?.stopSocket?.();
    for (const entry of extraSockets) entry.stop();
    ws?.close();
  } };
}

if (require.main === module) {
  const service = start();
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { service.stop(); process.exit(0); });
}

module.exports = { feedEntries, pollJma, start, jwtExpiryMs, axisRefreshDue };
