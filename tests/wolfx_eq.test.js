const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { mapWolfxEqEvent } = require('../lib/parsers/wolfxEq');
const { ingestXml, ingestWolfxEq } = require('../tools/atlas_ingest');
const { createAtlasSnapshot } = require('../lib/atlasData');

const detail = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'wolfx_detail_20261120214603.json'), 'utf8'));
const event = detail.events[0];
const xml = fs.readFileSync(path.join(__dirname, 'fixtures', 'jma_vxse51_20261120214603.xml'), 'utf8');

test('Wolfx VXSE51をJMA互換の震度速報へ変換する', () => {
  const bulletin = mapWolfxEqEvent(event);
  assert.equal(bulletin.reportDateTime, '2026-11-20T21:47:00+09:00');
  assert.equal(bulletin.targetDateTime, '2026-11-20T21:46:00+09:00');
  assert.equal(bulletin.originTimeFormatted, '午後9時46分');
  assert.equal(bulletin.intensity.maxInt, 4);
  assert.deepEqual(bulletin.intensity.prefs[0], { name: '熊本県', code: 43, maxInt: 4,
    areas: [{ name: '熊本県天草・芦北', code: 743, maxInt: 4, cities: [] }] });
  assert.deepEqual(bulletin.intensity.groups, { 4: ['熊本県天草・芦北'] });
});

test('Wolfxはissued VXSE51だけを変換し、必須値不足を拒否する', () => {
  assert.equal(mapWolfxEqEvent({ ...event, reports: event.reports.map((r) => ({ ...r, status: 'cancelled' })) }), null);
  assert.equal(mapWolfxEqEvent({ ...event, reports: event.reports.filter((r) => r.product !== 'VXSE51') }), null);
  assert.equal(mapWolfxEqEvent({ ...event, eventId: undefined }), null);
  assert.equal(mapWolfxEqEvent({ ...event, reports: [{ ...event.reports[0], observation: { ...event.reports[0].observation, prefs: undefined } }] }), null);
});

test('JMAとWolfxの震度速報は意味内容が一致し、後着の同一報は無変更になる', () => {
  const semantic = (snapshot) => JSON.stringify({
    layers: Object.fromEntries(Object.entries(snapshot.layers).map(([kind, rows]) => [kind, rows.map((row) => ({ ...row, receivedAt: undefined }))])),
  });
  const jma = ingestXml(createAtlasSnapshot(), xml, Date.parse('2026-11-20T21:50:00+09:00')).state;
  const wolfx = ingestWolfxEq(createAtlasSnapshot(), event, Date.parse('2026-11-20T21:50:00+09:00')).state;
  assert.equal(semantic(jma), semantic(wolfx));
  assert.equal(ingestWolfxEq(jma, event, Date.parse('2026-11-20T21:50:00+09:00')).changed, false);
  assert.equal(ingestXml(wolfx, xml, Date.parse('2026-11-20T21:50:00+09:00')).state.layers.intensity.length, wolfx.layers.intensity.length);
});

