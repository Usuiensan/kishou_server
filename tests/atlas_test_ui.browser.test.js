const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright-core');

test('Chrome displays the live Atlas preview and the distinct stream/metrics panels', { timeout: 30000 }, async () => {
  const pageHtml = fs.readFileSync(path.join(__dirname, '../tools/atlas_test_ui.html'));
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/pWQAAAAASUVORK5CYII=', 'base64');
  const server = http.createServer((request, response) => {
    if (request.url.startsWith('/test/atlas.png')) {
      response.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' }); response.end(png); return;
    }
    if (request.url === '/test/metrics') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ chromiumCapture: { stage: 'Chromium capture', source: 'synthetic browser fixture', fps: 29.5,
        sampleCount: 10, lastAtUnixMs: Date.now(), intervalMs: { p95: 34 }, durationMs: { average: 4, max: 8, p95: 7 } } })); return;
    }
    if (request.url === '/test/status') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ingest: { display: {}, atlasIIConfig: { activeLayout: 'full', layouts: { full: [] } }, activeLayers: {} } })); return;
    }
    if (request.url === '/test/tsunami-areas') {
      response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"areas":[]}'); return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end(pageHtml);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const launch = { headless: true, args: ['--disable-gpu'] };
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) launch.executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  else if (process.platform === 'win32') launch.channel = 'chrome';
  let browser;
  try {
    browser = await chromium.launch(launch);
    const context = await browser.newContext({ acceptDownloads: true });
    await context.addInitScript(() => {
      window.RTCPeerConnection = class {
        iceGatheringState = 'complete'; connectionState = 'connected';
        addTransceiver() {} async createOffer() { return { type: 'offer', sdp: 'offer' }; }
        async setLocalDescription(value) { this.localDescription = value; }
        async setRemoteDescription() {}
      };
      HTMLVideoElement.prototype.requestVideoFrameCallback = function (callback) { window.__atlasFrameCallback = callback; return 1; };
    });
    await context.route('http://127.0.0.1:8889/**', (route) => route.fulfill({ status: 200, contentType: 'application/sdp', body: 'answer' }));
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction(() => document.getElementById('atlasPreview').naturalWidth > 0
      && document.getElementById('stageMetrics').textContent.includes('Chromium capture: 29.5 FPS'));
    assert.equal(await page.locator('#streamVideo').count(), 1);
    assert.equal(await page.locator('#atlasPreview').count(), 1);
    const logDownload = page.waitForEvent('download');
    await page.getByRole('button', { name: '検証ログ保存' }).click();
    const logPath = await (await logDownload).path();
    const validationLog = JSON.parse(fs.readFileSync(logPath, 'utf8'));
    assert.ok(validationLog.savedAt);
    assert.ok('receiveMetrics' in validationLog);
    const atlasDownload = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Atlas PNG保存' }).click();
    assert.equal((await atlasDownload).suggestedFilename(), 'atlas-renderer.png');
    await page.evaluate(() => {
      window.__atlasFrameCallback(100, { presentedFrames: 1 });
      window.__atlasFrameCallback(133, { presentedFrames: 2 });
    });
    await page.waitForFunction(() => document.getElementById('receiveMetrics').textContent.includes('30.3 FPS'));
    assert.match(await page.locator('#stageMetrics').innerText(), /PNG→RGB変換: 未取得/);
  } finally {
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
