#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_PATTERNS = path.join(ROOT, 'examples', 'demo-patterns');
const DEFAULT_CORPUS = '/home/hatch/jma-xml-corpus/real';
const EEW_INTERVAL_MS = 20_000;
const TELOP_HOLD_MS = 120_000;

function filesWithPrefix(directory, prefix, fallbackDir) {
  const source = fs.existsSync(directory) ? directory : fallbackDir;
  let files = fs.readdirSync(source).filter((name) => name.startsWith(prefix) && name.endsWith('.xml'))
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true })).map((name) => path.join(source, name));
  if (!files.length && source !== fallbackDir && fs.existsSync(fallbackDir)) {
    files = fs.readdirSync(fallbackDir).filter((name) => name.startsWith(prefix) && name.endsWith('.xml'))
      .sort((a, b) => a.localeCompare(b, 'en', { numeric: true })).map((name) => path.join(fallbackDir, name));
  }
  return files;
}

function tag(xml, name, from = 0) {
  const match = xml.slice(from).match(new RegExp(`<[^>]*:?${name}[^>]*>([^<]*)<\\/[^>]*:?${name}>`));
  return match ? match[1].trim() : '';
}

function wolfxFromXml(xml) {
  const coordinate = xml.match(/<[^>]*:?Coordinate[^>]*>([+-][\d.]+)([+-][\d.]+)-([\d.]+)\//);
  const title = tag(xml, 'Title');
  const hypocenter = xml.match(/<Hypocenter\b[^>]*>([\s\S]*?)<\/Hypocenter>/)?.[1] || '';
  const areas = [...xml.matchAll(/<Area\b[^>]*>([\s\S]*?)<\/Area>/g)].map((match) => match[1])
    .filter((body) => body.includes('<Category>'))
    .map((body) => ({ Chiiki: tag(body, 'Name'), Shindo1: tag(body, 'To'), Shindo2: tag(body, 'From'), Type: '警報', Arrive: body.includes('既に主要動') ? '既に到達' : '', Time: tag(body, 'ArrivalTime').replace(/[-:TZ+]/g, '').slice(8, 14) }))
    .filter((area) => area.Chiiki);
  return { type: 'jma_eew', EventID: tag(xml, 'EventID'), Serial: Number(tag(xml, 'Serial')),
    AnnouncedTime: tag(xml, 'ReportDateTime'), OriginTime: tag(xml, 'OriginTime'), Title: title,
    isWarn: title.includes('警報'), isCancel: tag(xml, 'InfoType') === '取消', isFinal: false, isTraining: false,
    Hypocenter: tag(hypocenter, 'Name'), Latitude: coordinate ? Number(coordinate[1]) : null,
    Longitude: coordinate ? Number(coordinate[2]) : null, Depth: coordinate ? Number(coordinate[3]) / 1000 : null,
    Magnitude: tag(xml, 'Magnitude'), MaxIntensity: tag(xml, 'To'), WarnArea: areas,
    OriginalText: '' };
}

function buildEewPlaylist({ corpusDir = DEFAULT_CORPUS, fallbackDir = path.join(ROOT, 'tests', 'samples') } = {}) {
  const series = [
    ['予報', '36_01_', [1, 2, 32]],
    ['警報', '37_01_', [1, 2]],
  ];
  return series.map(([name, prefix, serials]) => {
    const files = filesWithPrefix(corpusDir, prefix, fallbackDir);
    const selected = serials.map((serial) => files.find((file) => file.includes(`_${String(serial).padStart(2, '0')}_`))).filter(Boolean);
    const cancel = files.find((file) => /取消/.test(fs.readFileSync(file, 'utf8')));
    if (!selected.length || !cancel) throw new Error(`EEW fixture series is incomplete: ${name}`);
    return { name, intervalMs: EEW_INTERVAL_MS,
      steps: [...selected, cancel].map((file) => ({ file, data: wolfxFromXml(fs.readFileSync(file, 'utf8')) })) };
  });
}

function buildTelopPlaylist(patternsDir = DEFAULT_PATTERNS) {
  return [
    ['震度', 'pat_vxse51.xml', 'pat_vxse51-cancel.xml'],
    ['津波', 'pat_tsu1.xml', 'pat_tsu1-cancel.xml'],
    ['長周期', 'pat_lp.xml', 'pat_lp-cancel.xml'],
  ].map(([name, file, cancel]) => ({ name, holdMs: TELOP_HOLD_MS,
    xml: fs.readFileSync(path.join(patternsDir, file), 'utf8'),
    cancel: fs.readFileSync(path.join(patternsDir, cancel), 'utf8') }));
}

function post(url, body, contentType) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method: 'POST', headers: { 'content-type': contentType, 'content-length': Buffer.byteLength(body) } }, (response) => {
      response.resume();
      response.on('end', () => response.statusCode >= 200 && response.statusCode < 300 ? resolve() : reject(new Error(`HTTP ${response.statusCode}`)));
    });
    request.on('error', reject);
    request.end(body);
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function runEewTrack(url, playlist, logger = console) {
  let index = 0;
  while (true) {
    const scenario = playlist[index++ % playlist.length];
    for (const [step, item] of scenario.steps.entries()) {
      while (true) {
        try { await post(`${url}/eew`, JSON.stringify({ source: 'wolfx', data: item.data }), 'application/json'); break; }
        catch (error) { logger.error(`EEW ingest retry: ${error.message}`); await sleep(5000); }
      }
      if (step < scenario.steps.length - 1) await sleep(scenario.intervalMs);
    }
    await sleep(5000);
  }
}

async function runTelopTrack(url, playlist, logger = console) {
  let index = 0;
  while (true) {
    const scenario = playlist[index++ % playlist.length];
    while (true) {
      try { await post(`${url}/jma`, scenario.xml, 'application/xml; charset=utf-8'); break; }
      catch (error) { logger.error(`telop ingest retry: ${error.message}`); await sleep(5000); }
    }
    await sleep(scenario.holdMs);
    while (true) {
      try { await post(`${url}/jma`, scenario.cancel, 'application/xml; charset=utf-8'); break; }
      catch (error) { logger.error(`telop cancel retry: ${error.message}`); await sleep(5000); }
    }
    await sleep(5000);
  }
}

if (require.main === module) {
  const ingestUrl = process.env.DEMO_INGEST_URL || 'http://127.0.0.1:8767';
  const eew = buildEewPlaylist();
  const telop = buildTelopPlaylist();
  void runEewTrack(ingestUrl, eew);
  void runTelopTrack(ingestUrl, telop);
}

module.exports = { buildEewPlaylist, buildTelopPlaylist, wolfxFromXml };
