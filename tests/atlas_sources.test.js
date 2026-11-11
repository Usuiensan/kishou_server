const test = require('node:test');
const assert = require('node:assert/strict');
const { pollJma } = require('../tools/atlas_sources');

test('JMA Atom EEW entries are fetched once and posted to the loopback ingest endpoint', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push([url, options]);
    if (url.endsWith('eqvol.xml')) return { ok: true, text: async () => `<feed><entry><updated>${new Date().toISOString()}</updated><link href="https://example.test/VXSE43.xml"/></entry><entry><link href="https://example.test/VPWW53.xml"/></entry></feed>` };
    if (url.endsWith('VXSE43.xml')) return { ok: true, text: async () => '<Report />' };
    return { ok: true };
  };
  const processed = new Set();
  const result = await pollJma({ fetchImpl, ingestUrl: 'http://127.0.0.1:8765', processed });
  assert.equal(result.accepted, 1);
  assert.equal(calls.length, 3);
  assert.equal(calls[2][0], 'http://127.0.0.1:8765/jma');
  assert.equal(calls[2][1].body, '<Report />');
  assert.equal(processed.has('https://example.test/VXSE43.xml'), true);
});
