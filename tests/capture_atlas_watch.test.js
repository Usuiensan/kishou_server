const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createAtlasSnapshot } = require('../lib/atlasData');

const root = path.resolve(__dirname, '..');

test('capture_atlas --watch streams frames without reference errors', { timeout: 90000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-atlas-watch-'));
  const state = path.join(dir, 'state.json');
  fs.writeFileSync(state, JSON.stringify(createAtlasSnapshot(Date.now())));
  const args = [path.join(root, 'tools', 'capture_atlas.js'),
    '--state', state, '--output', path.join(dir, 'atlas.png'), '--watch'];
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) {
    args.push('--browser', process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE);
  }
  const child = spawn(process.execPath, args, { cwd: root });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const frames = await new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    const timer = setTimeout(() => reject(new Error(
      `no frame within timeout; stderr: ${stderr.slice(-500)}`)), 60000);
    child.stdout.on('data', (chunk) => {
      chunks.push(chunk);
      length += chunk.length;
      const all = Buffer.concat(chunks);
      if (all.length >= 4) {
        const size = all.readUInt32BE(0);
        if (all.length >= 4 + size) {
          clearTimeout(timer);
          resolve(size);
        }
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`capture exited early code=${code}; stderr: ${stderr.slice(-500)}`));
    });
  });
  child.kill('SIGTERM');
  await new Promise((resolve) => child.once('exit', resolve));
  assert.ok(frames > 0, 'expected a PNG frame');
  assert.ok(!/ReferenceError/.test(stderr), `stderr contains ReferenceError: ${stderr.slice(-500)}`);
  fs.rmSync(dir, { recursive: true, force: true });
});
