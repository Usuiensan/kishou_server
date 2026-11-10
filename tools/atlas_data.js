#!/usr/bin/env node
const fs = require('node:fs');
const { parseEarthquake } = require('../lib/parsers/earthquake');
const { parseTsunami } = require('../lib/parsers/tsunami');
const { createAtlasData, createAtlasSnapshot, applyAtlasBulletin } = require('../lib/atlasData');

const [kind, inputPath, snapshotPath] = process.argv.slice(2);
if (!['eew', 'tsunami', 'intensity', 'vertical'].includes(kind) || !inputPath) {
  console.error('Usage: node tools/atlas_data.js <eew|tsunami|intensity|vertical> <bulletin.xml> [snapshot.json]');
  process.exit(2);
}

const xml = fs.readFileSync(inputPath, 'utf8');
const parsed = kind === 'eew' ? parseEarthquake(xml) : parseTsunami(xml);
if (parsed.status !== '通常') throw new Error(`Training/test bulletin rejected: ${parsed.status}`);
const bulletin = createAtlasData(kind, parsed);
if (!snapshotPath) {
  process.stdout.write(`${JSON.stringify(bulletin, null, 2)}\n`);
} else {
  const snapshot = fs.existsSync(snapshotPath) ? JSON.parse(fs.readFileSync(snapshotPath, 'utf8')) : createAtlasSnapshot();
  const updated = applyAtlasBulletin(snapshot, bulletin);
  fs.writeFileSync(snapshotPath, `${JSON.stringify(updated, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(updated, null, 2)}\n`);
}
