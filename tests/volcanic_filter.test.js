const assert = require('node:assert/strict');
const test = require('node:test');
const { isVolcanicEntry } = require('../lib/volcanicFilter');

test('火山関連の電文コードを除外する', () => {
  assert.equal(isVolcanicEntry({ id: 'https://example.test/VFV052' }), true);
  assert.equal(isVolcanicEntry({ link: { href: 'https://example.test/VZSE40' } }), true);
});

test('地震・津波の電文コードは除外しない', () => {
  assert.equal(isVolcanicEntry({ id: 'https://example.test/VXSE52' }), false);
  assert.equal(isVolcanicEntry({ link: { href: 'https://example.test/VTSE51' } }), false);
});
