const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

test('スナップショット適用完了通知はDOM更新後のseqを渡す', async () => {
  const intensity = { children: [], replaceChildren() { this.children = []; }, appendChild(child) { this.children.push(child); } };
  const callbacks = [];
  const element = () => ({ children: [], style: {}, classList: { contains() { return false; }, add() {}, remove() {} }, replaceChildren() { this.children = []; }, appendChild(child) { this.children.push(child); }, append(...children) { this.children.push(...children); } });
  const sandbox = {
    document: { getElementById: (id) => id === 'atlas-intensity' ? intensity : element(), createElement: element },
    setInterval() { return 1; }, clearInterval() {}, setTimeout() {}, fetch: async () => ({ ok: false }),
    Intl, Date, JSON,
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(require.resolve('../telop/atlas-live'), 'utf8'), sandbox);
  sandbox.ATLAS_ON_RENDER = (seq) => callbacks.push({ seq, text: intensity.children.map((child) => child.textContent).join('') });
  const snapshot = { version: 1, seq: 23, display: {}, layers: { eew: [], tsunami: [], vertical: [], intensity: [{ event: { id: 'rendered', publishedAt: '2026-11-12T00:00:00Z' }, payload: { render: { maxInt: '4', cityGroups: { '4': ['A'] } }, summaryFrames: [{ lines: ['震源はA'] }] } }] } };
  const renderedSeq = sandbox.applyAtlasSnapshot(snapshot);
  assert.equal(renderedSeq, 23);
  assert.equal(sandbox.ATLAS_RENDERED_SEQ, 23);
  assert.equal(intensity.children.length, 1);
});

test('描き出し済み seq は rAF 2回後に確定する', () => {
  const intensity = { children: [], replaceChildren() { this.children = []; }, appendChild(child) { this.children.push(child); } };
  const element = () => ({ children: [], style: {}, classList: { contains() { return false; }, add() {}, remove() {} }, replaceChildren() { this.children = []; }, appendChild(child) { this.children.push(child); }, append(...children) { this.children.push(...children); } });
  const rafCallbacks = [];
  const sandbox = {
    document: { getElementById: (id) => id === 'atlas-intensity' ? intensity : element(), createElement: element },
    setInterval() { return 1; }, clearInterval() {}, setTimeout() {},
    requestAnimationFrame(callback) { rafCallbacks.push(callback); return rafCallbacks.length; },
    fetch: async () => ({ ok: false }),
    Intl, Date, JSON,
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(require.resolve('../telop/atlas-live'), 'utf8'), sandbox);
  const snapshot = { version: 1, seq: 41, display: {}, layers: { eew: [], tsunami: [], vertical: [], intensity: [] } };
  sandbox.applyAtlasSnapshot(snapshot);
  assert.equal(sandbox.ATLAS_RENDERED_SEQ, 41);
  assert.equal(sandbox.ATLAS_PAINTED_SEQ, null);
  assert.equal(rafCallbacks.length, 1);
  rafCallbacks.shift()();
  assert.equal(sandbox.ATLAS_PAINTED_SEQ, null);
  assert.equal(rafCallbacks.length, 1);
  rafCallbacks.shift()();
  assert.equal(sandbox.ATLAS_PAINTED_SEQ, 41);
});
