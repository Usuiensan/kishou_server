#!/usr/bin/env node
const fs = require('node:fs');
const { parseEarthquake } = require('../lib/parsers/earthquake');
const { parseTsunami } = require('../lib/parsers/tsunami');
const { createAtlasData } = require('../lib/atlasData');

const [kind, inputPath, previousPath] = process.argv.slice(2);
if (!['eew', 'tsunami'].includes(kind) || !inputPath) {
  console.error('Usage: node tools/atlas_data.js <eew|tsunami> <bulletin.xml> [previous-atlas.json]');
  process.exit(2);
}

const xml = fs.readFileSync(inputPath, 'utf8');
const parsed = kind === 'eew' ? parseEarthquake(xml) : parseTsunami(xml);
if (parsed.status !== '通常') throw new Error(`Training/test bulletin rejected: ${parsed.status}`);
const previous = previousPath ? JSON.parse(fs.readFileSync(previousPath, 'utf8')) : null;
process.stdout.write(`${JSON.stringify(createAtlasData(kind, parsed, previous), null, 2)}\n`);
