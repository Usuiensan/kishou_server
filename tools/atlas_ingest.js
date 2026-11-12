#!/usr/bin/env node
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { parseEarthquake } = require('../lib/parsers/earthquake');
const { parseTsunami } = require('../lib/parsers/tsunami');
const { mapP2PQuakeToEEW } = require('../lib/parsers/p2pquake');
const { createAtlasData, createAtlasSnapshot, applyAtlasBulletin, pruneAtlasSnapshot } = require('../lib/atlasData');

const MAX_XML_BYTES = 10 * 1024 * 1024;
const INTENSITY_SCALES = new Set(['1', '2', '3', '4', '5-', '5+', '6-', '6+', '7']);

function validateIntensityBulletin(bulletin) {
  if (!bulletin || typeof bulletin !== 'object' || typeof bulletin.eventId !== 'string' ||
      !bulletin.eventId.trim() || Buffer.byteLength(bulletin.eventId, 'utf8') > 255 ||
      !['発表', '更新', '続報', '最終報', '取消'].includes(bulletin.infoType) ||
      !['震度速報', '震源・震度情報'].includes(bulletin.infoKind)) throw new TypeError('invalid test intensity bulletin');
  const intensity = bulletin.intensity;
  const validScale = (value) => value == null || value === '' || INTENSITY_SCALES.has(String(value));
  if (!intensity || typeof intensity !== 'object' || !Array.isArray(intensity.prefs) || intensity.prefs.length > 47) throw new TypeError('invalid test intensity data');
  if (!validScale(intensity.maxInt)) throw new TypeError('invalid 震度階級');
  let names = 0;
  for (const field of ['groups', 'cityGroups']) {
    const groups = intensity[field];
    if (!groups || typeof groups !== 'object' || Array.isArray(groups)) throw new TypeError(`invalid ${field}`);
    for (const [scale, values] of Object.entries(groups)) {
      if (!INTENSITY_SCALES.has(scale) || !Array.isArray(values)) throw new TypeError(`invalid ${field} scale`);
      names += values.length;
      if (values.some((name) => typeof name !== 'string' || !name.trim() || Buffer.byteLength(name, 'utf8') > 192)) {
        throw new TypeError(`invalid ${field} name`);
      }
    }
  }
  if (names > 600 || intensity.prefs.some((pref) => !pref || typeof pref.name !== 'string' ||
      !pref.name.trim() || Buffer.byteLength(pref.name, 'utf8') > 192 || !validScale(pref.maxInt))) {
    throw new TypeError('invalid test intensity regions');
  }
}

function ingestXml(snapshot, xml, now = Date.now()) {
  if (typeof xml !== 'string' || !xml.includes('<Report')) throw new TypeError('expected a JMA Report XML document');
  const earthquake = parseEarthquake(xml);
  const tsunami = !earthquake.isEEW && earthquake.infoKind?.includes('津波') ? parseTsunami(xml) : null;
  if (earthquake.status !== '通常' || (tsunami && tsunami.status !== '通常')) throw new Error(`unsupported bulletin status: ${earthquake.status || tsunami?.status || 'unknown'}`);

  const bulletins = [];
  if (earthquake.isEEW) bulletins.push(createAtlasData('eew', earthquake));
  if (tsunami) bulletins.push(createAtlasData('tsunami', tsunami));
  const seismicCancel = earthquake.infoType === '取消' && /震度|地震情報/.test(earthquake.infoKind || '');
  if (!earthquake.isEEW && (earthquake.intensity || seismicCancel)) {
    bulletins.push(createAtlasData('intensity', earthquake), createAtlasData('vertical', earthquake));
  }
  if (!bulletins.length) throw new Error(`unsupported JMA info kind: ${earthquake.infoKind || tsunami.infoKind || 'unknown'}`);

  const next = bulletins.reduce((state, item) => applyAtlasBulletin(state, item, now), snapshot);
  return { state: next, kinds: bulletins.map(({ kind }) => kind) };
}

function ingestP2P(snapshot, input, now = Date.now()) {
  const bulletin = mapP2PQuakeToEEW(input);
  if (!bulletin) throw new TypeError('Atlas II P2P input accepts code 556 EEW bulletins only');
  return { state: applyAtlasBulletin(snapshot, createAtlasData('eew', bulletin), now), kinds: ['eew'] };
}

function ingestTestEvents(snapshot, input, now = Date.now()) {
  const events = Array.isArray(input?.events) ? input.events : [input];
  if (!events.length || events.length > 100) throw new TypeError('events must contain 1 to 100 items');
  let state = snapshot;
  const kinds = [];
  for (const item of events) {
    if (typeof item?.xml === 'string') {
      const result = ingestXml(state, item.xml, now);
      state = result.state;
      kinds.push(...result.kinds);
    } else if (item?.p2p && typeof item.p2p === 'object') {
      const result = ingestP2P(state, item.p2p, now);
      state = result.state;
      kinds.push(...result.kinds);
    } else {
      if (!item?.atlasEvent && item?.kind && item?.bulletin && ['intensity', 'vertical'].includes(item.kind)) {
        validateIntensityBulletin(item.bulletin);
      }
      const bulletin = item?.atlasEvent || (item?.kind && item?.bulletin
        ? createAtlasData(item.kind, item.bulletin) : null);
      if (!bulletin) throw new TypeError('each event must contain xml, atlasEvent, or kind and bulletin');
      state = applyAtlasBulletin(state, bulletin, now);
      kinds.push(bulletin.kind);
    }
  }
  return { state, kinds };
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_XML_BYTES) {
        reject(Object.assign(new Error('JMA XML exceeds 10 MiB'), { statusCode: 413 }));
        request.destroy();
      } else chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function writeSnapshot(filePath, snapshot) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(snapshot)}\n`, 'utf8');
  fs.renameSync(temporary, filePath);
}

function start({ statePath = path.resolve('runtime/atlas-state.json'), host = '127.0.0.1', port = 8765, logger = console, testApi = false, atlasIIConfig = null } = {}) {
  if (!['127.0.0.1', '::1', 'localhost'].includes(host)) throw new Error('JMA XML input must bind to loopback');
  let state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : createAtlasSnapshot();
  state = { ...state, display: { ...createAtlasSnapshot().display, ...state.display } };
  state = { ...state, sourceHealth: { jma: null, p2p: null, ...state.sourceHealth } };
  if (atlasIIConfig) state = { ...state, atlasIIConfig };
  state = { ...state, testMode: testApi === true };
  let clockOffsetMs = 0;
  const currentTime = () => Date.now() + clockOffsetMs;
  let lastInputAt = null;
  let lastError = null;
  writeSnapshot(statePath, state);
  const server = http.createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ ok: true, lastInputAt, lastError, testMode: state.testMode === true, display: state.display,
        virtualNow: testApi ? currentTime() : null, clockOffsetMs: testApi ? clockOffsetMs : null,
        atlasIIConfig: state.atlasIIConfig,
        sourceHealth: state.sourceHealth,
        activeLayers: Object.fromEntries(Object.entries(state.layers).map(([kind, rows]) => [kind, rows.length])) }));
      return;
    }
    if (testApi && request.method === 'POST' && request.url === '/test/clock') {
      try {
        const input = JSON.parse(await readBody(request));
        if (!Number.isFinite(input?.advanceMs) || input.advanceMs < 0 || input.advanceMs > 365 * 24 * 60 * 60_000) throw new TypeError('advanceMs must be between 0 and 365 days');
        clockOffsetMs += input.advanceMs;
        const now = currentTime();
        state = { ...pruneAtlasSnapshot(state, now), updatedAt: now };
        writeSnapshot(statePath, state);
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ virtualNow: now, clockOffsetMs, activeLayers: Object.fromEntries(Object.entries(state.layers).map(([kind, rows]) => [kind, rows.length])) }));
      } catch (error) {
        response.writeHead(error.statusCode || 422, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: error.message }));
      }
      return;
    }
    if (request.method === 'POST' && request.url === '/source-health') {
      try {
        const health = JSON.parse(await readBody(request));
        if (!['jma', 'p2p'].includes(health?.source) || typeof health.ok !== 'boolean' ||
            typeof health.at !== 'string' || !Number.isFinite(Date.parse(health.at))) throw new TypeError('invalid source health');
        const previous = state.sourceHealth[health.source] || {};
        state = { ...state, sourceHealth: { ...state.sourceHealth,
          [health.source]: { ...previous, ok: health.ok, at: health.at,
            lastReceivedAt: previous.lastReceivedAt || null,
            error: health.ok ? null : String(health.error || 'source unavailable') } } };
        writeSnapshot(statePath, state);
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ accepted: true }));
      } catch (error) {
        response.writeHead(error.statusCode || 422, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ accepted: false, error: error.message }));
      }
      return;
    }
    if (testApi && request.method === 'POST' && request.url === '/test/events') {
      try {
        const body = await readBody(request);
        const input = request.headers['content-type']?.includes('application/xml')
          ? { xml: body } : JSON.parse(body);
        const result = ingestTestEvents(state, input, currentTime());
        state = result.state;
        writeSnapshot(statePath, state);
        lastInputAt = new Date(currentTime()).toISOString();
        lastError = null;
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ accepted: true, kinds: result.kinds, updatedAt: state.updatedAt }));
      } catch (error) {
        lastError = error.message;
        response.writeHead(error.statusCode || 422, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ accepted: false, error: error.message }));
      }
      return;
    }
    if (request.method === 'POST' && request.url === '/p2p') {
      try {
        const result = ingestP2P(state, JSON.parse(await readBody(request)), currentTime());
        state = result.state;
        lastInputAt = new Date(currentTime()).toISOString();
        state = { ...state, sourceHealth: { ...state.sourceHealth,
          p2p: { ...state.sourceHealth.p2p, ok: true, at: lastInputAt, lastReceivedAt: lastInputAt, error: null } } };
        writeSnapshot(statePath, state);
        lastError = null;
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ accepted: true, kinds: result.kinds, updatedAt: state.updatedAt }));
      } catch (error) {
        lastError = error.message;
        response.writeHead(error.statusCode || 422, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ accepted: false, error: error.message }));
      }
      return;
    }
    if (testApi && request.method === 'POST' && request.url === '/test/reset') {
      clockOffsetMs = 0;
      state = { ...createAtlasSnapshot(currentTime()), atlasIIConfig: state.atlasIIConfig,
        testMode: state.testMode === true,
        sourceHealth: { jma: null, p2p: null } };
      writeSnapshot(statePath, state);
      lastInputAt = new Date(currentTime()).toISOString();
      lastError = null;
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ reset: true, updatedAt: state.updatedAt }));
      return;
    }
    if (testApi && request.method === 'POST' && request.url === '/test/layout') {
      try {
        const input = JSON.parse(await readBody(request));
        const { activeLayout, atlasIIConfig } = input;
        const replaceConfig = atlasIIConfig !== undefined;
        const config = atlasIIConfig === undefined ? state.atlasIIConfig : atlasIIConfig;
        if (!config || typeof config !== 'object' || Array.isArray(config) || typeof activeLayout !== 'string' ||
          (replaceConfig && config.activeLayout !== activeLayout) || !config.layouts || !Object.hasOwn(config.layouts, activeLayout)) throw new TypeError('unknown Atlas II layout');
        state = { ...state, updatedAt: currentTime(), atlasIIConfig: { ...config, activeLayout } };
        writeSnapshot(statePath, state);
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ activeLayout }));
      } catch (error) {
        response.writeHead(error.statusCode || 422, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: error.message }));
      }
      return;
    }
    if (testApi && request.method === 'POST' && request.url === '/test/display') {
      try {
        const input = JSON.parse((await readBody(request)).toString());
        const keys = ['tsunamiMap', 'tsunamiLeftMap', 'tsunamiLines', 'eewHorizontal', 'eewVertical', 'earthquakeTelop'];
        if (!keys.includes(input?.key) || typeof input.visible !== 'boolean') throw new TypeError('key and boolean visible are required');
        state = { ...state, updatedAt: currentTime(), display: { ...state.display, [input.key]: input.visible } };
        writeSnapshot(statePath, state);
        lastInputAt = new Date(currentTime()).toISOString();
        lastError = null;
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ updatedAt: state.updatedAt, display: state.display }));
      } catch (error) {
        lastError = error.message;
        response.writeHead(error.statusCode || 422, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: error.message }));
      }
      return;
    }
    if (request.method !== 'POST' || request.url !== '/jma') {
      response.writeHead(404);
      response.end();
      return;
    }
    try {
      const xml = await readBody(request);
      const result = ingestXml(state, xml, currentTime());
      state = result.state;
      lastInputAt = new Date(currentTime()).toISOString();
      state = { ...state, sourceHealth: { ...state.sourceHealth,
        jma: { ...state.sourceHealth.jma, ok: true, at: lastInputAt, lastReceivedAt: lastInputAt, error: null } } };
      writeSnapshot(statePath, state);
      lastError = null;
      logger.log(`accepted JMA bulletin: ${result.kinds.join(',')}`);
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ accepted: true, kinds: result.kinds, updatedAt: state.updatedAt }));
    } catch (error) {
      lastError = error.message;
      logger.error(`rejected JMA bulletin: ${error.message}`);
      response.writeHead(error.statusCode || 422, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ accepted: false, error: error.message }));
    }
  });
  const expiryTimer = setInterval(() => {
    const next = pruneAtlasSnapshot(state, currentTime());
    if (next !== state) {
      state = next;
      writeSnapshot(statePath, state);
    }
  }, 1000);
  expiryTimer.unref();
  server.listen(port, host, () => logger.log(`JMA XML input listening at http://${host}:${server.address().port}/jma`));
  return { server, close: () => { clearInterval(expiryTimer); server.close(); }, getState: () => state };
}

if (require.main === module) {
  const { values } = parseArgs({ options: {
    state: { type: 'string', default: 'runtime/atlas-state.json' },
    host: { type: 'string', default: '127.0.0.1' },
    port: { type: 'string', default: '8765' },
    'test-api': { type: 'boolean', default: false },
    layout: { type: 'string', default: 'examples/atlas-layouts.json' },
  } });
  const service = start({ statePath: path.resolve(values.state), host: values.host, port: Number(values.port),
    testApi: values['test-api'], atlasIIConfig: JSON.parse(fs.readFileSync(path.resolve(values.layout), 'utf8')) });
  const stop = () => service.close();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

module.exports = { ingestXml, ingestP2P, ingestTestEvents, validateIntensityBulletin, start, writeSnapshot };
