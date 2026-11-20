#!/usr/bin/env node
'use strict';

/**
 * 緊急地震速報 (警報) 能登半島地震シナリオの受信〜テロップ〜音声再生を一貫確認するローカルデモサーバー。
 *
 * 起動: node tools/eew_noto_demo.js [--port 8787]
 * ブラウザで http://127.0.0.1:8787/ を開くと、SSE (/atlas-state-events) 経由で
 * 緊急地震速報を受信し、テロップ描画と Web Audio API による MP3 パーツ連続再生・続報カットを確認できる。
 */

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { parseArgs } = require('node:util');
const { createAtlasSnapshot, pruneAtlasSnapshot } = require('../lib/atlasData');
const { ingestEewJson } = require('./atlas_ingest');

const ROOT = path.resolve(__dirname, '..');
const TELOP_DIR = path.join(ROOT, 'telop');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.css': 'text/css; charset=utf-8',
};

// 令和6年能登半島地震 (2024-01-01 16:10, M7.6) 警報3回・実データシナリオ
const NOTO_SCENARIO = [
  {
    step: 1,
    serial: 1,
    label: '第1報 (警報1回目)',
    hypocenterName: '石川県能登地方',
    latitude: 37.5,
    longitude: 137.2,
    depthKm: 10,
    magnitude: 5.7,
    maxIntensity: '5強',
    areas: ['石川県能登'],
  },
  {
    step: 2,
    serial: 20,
    label: '第20報 (警報2回目・続報)',
    hypocenterName: '石川県能登地方',
    latitude: 37.5,
    longitude: 137.2,
    depthKm: 10,
    magnitude: 6.6,
    maxIntensity: '6強',
    areas: [
      '石川県能登', '富山県西部', '新潟県上越', '富山県東部', '石川県加賀', '新潟県佐渡',
      '長野県北部', '新潟県中越', '岐阜県飛騨', '群馬県南部',
    ],
  },
  {
    step: 3,
    serial: 30,
    label: '第30報 (警報3回目・続報)',
    hypocenterName: '能登半島沖',
    latitude: 37.6,
    longitude: 137.2,
    depthKm: 10,
    magnitude: 7.4,
    maxIntensity: '7',
    isFinal: true,
    areas: [
      '石川県能登', '石川県加賀', '富山県西部', '富山県東部', '福井県嶺北', '福井県嶺南',
      '新潟県上越', '新潟県佐渡', '新潟県中越', '新潟県下越',
      '長野県北部', '長野県南部', '長野県中部', '山梨県中・西部',
      '福島県会津', '福島県中通り', '宮城県南部', '宮城県中部', '山形県村山', '山形県置賜', '山形県庄内',
      '栃木県南部', '栃木県北部', '茨城県南部', '茨城県北部', '埼玉県北部', '埼玉県南部', '埼玉県秩父',
      '群馬県北部', '群馬県南部', '千葉県北西部',
      '岐阜県飛騨', '岐阜県美濃中西部', '岐阜県美濃東部', '静岡県東部', '愛知県西部', '三重県北部',
      '滋賀県北部', '奈良県', '兵庫県北部',
    ],
  },
];

function buildNotoAxisPayload(scenarioStep, now = Date.now()) {
  const iso = new Date(now).toISOString();
  return {
    source: 'axis',
    data: {
      EventID: '20240101161009',
      Serial: scenarioStep.serial,
      Title: '緊急地震速報（警報）',
      ReportDateTime: iso,
      OriginDateTime: '2024-01-01T16:10:09+09:00',
      Intensity: scenarioStep.maxIntensity,
      Magnitude: scenarioStep.magnitude,
      Flag: {
        is_training: false,
        is_final: Boolean(scenarioStep.isFinal),
        is_cancel: false,
      },
      Hypocenter: {
        Name: scenarioStep.hypocenterName,
        Coordinate: [scenarioStep.longitude, scenarioStep.latitude],
        Depth: `${scenarioStep.depthKm}km`,
      },
      Forecast: scenarioStep.areas.map((name) => ({
        Name: name,
        Intensity: { From: '5-', To: scenarioStep.maxIntensity },
      })),
    },
  };
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function serveFile(res, filePath) {
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    'content-type': MIME_TYPES[ext] || 'application/octet-stream',
    'cache-control': 'no-store',
  });
  fs.createReadStream(filePath).pipe(res);
}

function startDemoServer({ host = '127.0.0.1', port = 8787, layoutPath = path.join(ROOT, 'examples', 'atlas-layouts.json') } = {}) {
  const atlasIIConfig = JSON.parse(fs.readFileSync(layoutPath, 'utf8'));
  let state = {
    ...createAtlasSnapshot(Date.now()),
    atlasIIConfig,
    testMode: true,
    sourceHealth: { jma: { ok: true, at: new Date().toISOString() }, p2p: { ok: true, at: new Date().toISOString() } },
  };
  let seq = 0;
  const sseClients = new Set();
  const autoTimers = [];

  function clearAutoTimers() {
    while (autoTimers.length) clearTimeout(autoTimers.pop());
  }

  function commit(nextState) {
    seq += 1;
    state = { ...nextState, seq };
    const payload = `data: ${JSON.stringify(state)}\n\n`;
    for (const client of sseClients) {
      if (!client.writableEnded) client.write(payload);
    }
  }

  function dispatchEew(source, data) {
    const now = Date.now();
    const res = ingestEewJson(state, source, data, now, { allowTraining: true, enforceEewFreshness: false });
    if (res.filtered) return { accepted: false, filtered: true };
    commit({
      ...res.state,
      sourceHealth: {
        ...res.state.sourceHealth,
        jma: { ok: true, at: new Date(now).toISOString() },
        p2p: { ok: true, at: new Date(now).toISOString() },
      },
    });
    return { accepted: true, seq, serial: res.state.eew?.event?.serial ?? null };
  }

  const server = http.createServer(async (req, res) => {
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);

    if (req.method === 'GET' && urlPath === '/atlas-state.json') {
      return sendJson(res, 200, state);
    }

    if (req.method === 'GET' && urlPath === '/atlas-state-events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
      });
      res.write(`data: ${JSON.stringify(state)}\n\n`);
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    if (req.method === 'POST' && urlPath === '/eew') {
      try {
        const body = await readJsonBody(req);
        return sendJson(res, 200, dispatchEew(body.source || 'axis', body.data || body));
      } catch (err) {
        return sendJson(res, 422, { accepted: false, error: err.message });
      }
    }

    if (req.method === 'POST' && urlPath === '/api/demo/noto/step') {
      try {
        const body = await readJsonBody(req);
        const stepObj = NOTO_SCENARIO.find((s) => s.step === Number(body.step));
        if (!stepObj) return sendJson(res, 400, { error: 'step must be 1, 2, or 3' });
        const { source, data } = buildNotoAxisPayload(stepObj);
        const result = dispatchEew(source, data);
        console.log(`[DEMO] Dispatched ${stepObj.label} (seq=${result.seq})`);
        return sendJson(res, 200, { ...result, label: stepObj.label });
      } catch (err) {
        return sendJson(res, 500, { error: err.message });
      }
    }

    if (req.method === 'POST' && urlPath === '/api/demo/noto/auto') {
      const body = await readJsonBody(req).catch(() => ({}));
      const step2DelayMs = Number(body.step2DelayMs) || 16000;
      const step3DelayMs = Number(body.step3DelayMs) || 38000;

      clearAutoTimers();
      state = {
        ...createAtlasSnapshot(Date.now()),
        atlasIIConfig,
        testMode: true,
        sourceHealth: { jma: { ok: true, at: new Date().toISOString() }, p2p: { ok: true, at: new Date().toISOString() } },
      };

      const fire = (stepNum) => {
        const stepObj = NOTO_SCENARIO.find((s) => s.step === stepNum);
        const { source, data } = buildNotoAxisPayload(stepObj);
        const result = dispatchEew(source, data);
        console.log(`[DEMO AUTO] Dispatched ${stepObj.label} (seq=${result.seq})`);
      };

      fire(1);
      autoTimers.push(setTimeout(() => fire(2), step2DelayMs));
      autoTimers.push(setTimeout(() => fire(3), step3DelayMs));

      return sendJson(res, 200, { started: true, scheduleMs: [0, step2DelayMs, step3DelayMs] });
    }

    if (req.method === 'POST' && urlPath === '/api/demo/reset') {
      clearAutoTimers();
      commit({
        ...createAtlasSnapshot(Date.now()),
        atlasIIConfig,
        testMode: true,
        sourceHealth: { jma: { ok: true, at: new Date().toISOString() }, p2p: { ok: true, at: new Date().toISOString() } },
      });
      console.log('[DEMO] Reset state');
      return sendJson(res, 200, { reset: true, seq });
    }

    // 静的ファイル配信
    if (req.method === 'GET') {
      if (urlPath === '/' || urlPath === '/eew-audio-demo.html') {
        return serveFile(res, path.join(TELOP_DIR, 'eew-audio-demo.html'));
      }
      if (urlPath === '/lib/eewAudio.js') {
        return serveFile(res, path.join(ROOT, 'lib', 'eewAudio.js'));
      }
      const safeRel = path.normalize(urlPath).replace(/^(\.\.(\/|\\|$))+/, '');
      const target = path.join(TELOP_DIR, safeRel);
      if (target.startsWith(TELOP_DIR)) {
        return serveFile(res, target);
      }
    }

    res.writeHead(404);
    res.end('Not found');
  });

  const expiryTimer = setInterval(() => {
    const next = pruneAtlasSnapshot(state, Date.now());
    if (next !== state) commit(next);
  }, 1000);
  expiryTimer.unref();

  server.listen(port, host, () => {
    console.log(`EEW Noto Demo Server listening at http://${host}:${server.address().port}/`);
  });

  return {
    server,
    close: () => {
      clearAutoTimers();
      clearInterval(expiryTimer);
      server.close();
    },
  };
}

if (require.main === module) {
  const { values } = parseArgs({
    options: {
      host: { type: 'string', default: '127.0.0.1' },
      port: { type: 'string', default: '8787' },
    },
  });
  const svc = startDemoServer({ host: values.host, port: Number(values.port) });
  process.once('SIGINT', () => svc.close());
  process.once('SIGTERM', () => svc.close());
}

module.exports = { startDemoServer, buildNotoAxisPayload, NOTO_SCENARIO };
