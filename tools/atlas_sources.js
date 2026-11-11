#!/usr/bin/env node
"use strict";

const { XMLParser } = require('fast-xml-parser');
const WebSocket = require('ws');
const fetch = require('node-fetch');

const FEED_URL = 'https://www.data.jma.go.jp/developer/xml/feed/eqvol.xml';
const P2P_URL = 'wss://api.p2pquake.net/v2/ws';
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

function start({ ingestUrl = 'http://127.0.0.1:8765', logger = console,
  fetchImpl = fetch, WebSocketImpl = WebSocket, pollMs = POLL_MS } = {}) {
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
  void poll();
  pollTimer = setInterval(() => void poll(), pollMs);
  connect();
  return { stop() {
    stopped = true;
    clearInterval(pollTimer);
    clearTimeout(reconnectTimer);
    ws?.close();
  } };
}

if (require.main === module) {
  const service = start();
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { service.stop(); process.exit(0); });
}

module.exports = { feedEntries, pollJma, start };
