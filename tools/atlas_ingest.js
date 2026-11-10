#!/usr/bin/env node
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { parseEarthquake } = require('../lib/parsers/earthquake');
const { parseTsunami } = require('../lib/parsers/tsunami');
const { createAtlasData, createAtlasSnapshot, applyAtlasBulletin, pruneAtlasSnapshot } = require('../lib/atlasData');

const MAX_XML_BYTES = 10 * 1024 * 1024;

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
    } else {
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

function start({ statePath = path.resolve('runtime/atlas-state.json'), host = '127.0.0.1', port = 8765, logger = console, testApi = false } = {}) {
  if (!['127.0.0.1', '::1', 'localhost'].includes(host)) throw new Error('JMA XML input must bind to loopback');
  let state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : createAtlasSnapshot();
  state = { ...state, display: { ...createAtlasSnapshot().display, ...state.display } };
  let lastInputAt = null;
  let lastError = null;
  writeSnapshot(statePath, state);
  const server = http.createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ ok: true, lastInputAt, lastError, display: state.display,
        activeLayers: Object.fromEntries(Object.entries(state.layers).map(([kind, rows]) => [kind, rows.length])) }));
      return;
    }
    if (testApi && request.method === 'POST' && request.url === '/test/events') {
      try {
        const body = await readBody(request);
        const input = request.headers['content-type']?.includes('application/xml')
          ? { xml: body } : JSON.parse(body);
        const result = ingestTestEvents(state, input);
        state = result.state;
        writeSnapshot(statePath, state);
        lastInputAt = new Date().toISOString();
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
      state = createAtlasSnapshot(Date.now());
      writeSnapshot(statePath, state);
      lastInputAt = new Date().toISOString();
      lastError = null;
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ reset: true, updatedAt: state.updatedAt }));
      return;
    }
    if (testApi && request.method === 'POST' && request.url === '/test/display') {
      try {
        const input = JSON.parse((await readBody(request)).toString());
        const keys = ['tsunamiMap', 'tsunamiLeftMap', 'tsunamiLines', 'eewHorizontal', 'eewVertical', 'earthquakeTelop'];
        if (!keys.includes(input?.key) || typeof input.visible !== 'boolean') throw new TypeError('key and boolean visible are required');
        state = { ...state, updatedAt: Date.now(), display: { ...state.display, [input.key]: input.visible } };
        writeSnapshot(statePath, state);
        lastInputAt = new Date().toISOString();
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
      const result = ingestXml(state, xml);
      state = result.state;
      writeSnapshot(statePath, state);
      lastInputAt = new Date().toISOString();
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
    const next = pruneAtlasSnapshot(state);
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
  } });
  const service = start({ statePath: path.resolve(values.state), host: values.host, port: Number(values.port), testApi: values['test-api'] });
  const stop = () => service.close();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

module.exports = { ingestXml, ingestTestEvents, start, writeSnapshot };
