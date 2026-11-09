const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

test('atlas builder connects state polling and paired existing components at v8 coordinates', () => {
  const root = path.resolve(__dirname, '..');
  execFileSync('python', ['telop/build_atlas.py'], { cwd: root });
  const html = fs.readFileSync(path.join(root, 'telop/atlas-1080.html'), 'utf8');
  for (const id of ['atlas-clock', 'atlas-intensity', 'atlas-headline', 'eew-box', 'tsunami-mini', 'atlas-alpha-mirror']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /#eew-box\s*\{\s*left:417px;\s*top:747px/);
  assert.match(html, /#tsunami-mini\s*\{\s*position:absolute;\s*left:1236px;\s*top:651px/);
  assert.match(html, /fetch\(`atlas-state\.json/);
  const initial = html.match(/window\.ATLAS_INITIAL_STATE = (\{[^;]+\});<\/script>/);
  assert.ok(initial);
  const layers = JSON.parse(initial[1]).layers;
  for (const kind of ['eew', 'tsunami', 'intensity', 'vertical']) assert.ok(layers[kind].length, `${kind} demo layer is empty`);
  assert.match(html, /renderTsunamiMini\(view\.tsunami\)/);
  assert.match(html, /function renderEEW\(d\)/);
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map((match) => match[1]);
  assert.ok(scripts.length >= 5);
  for (const script of scripts) assert.doesNotThrow(() => new Function(script));
});
