const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright-core');
const eewAreas = require('../protocol/atlas-ii-eew-areas-v1.json').zones;
const tsunamiAreas = require('../protocol/atlas-ii-tsunami-areas-v1.json').zones;

test('Chrome displays the live Atlas preview and the distinct stream/metrics panels', { timeout: 30000 }, async () => {
  const pageHtml = fs.readFileSync(path.join(__dirname, '../tools/atlas_test_ui.html'));
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/pWQAAAAASUVORK5CYII=', 'base64');
  const submittedEvents = [];
  const server = http.createServer((request, response) => {
    if (request.method === 'POST' && request.url === '/test/events') {
      const chunks = []; request.on('data', chunk => chunks.push(chunk)); request.on('end', () => {
        submittedEvents.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"accepted":true,"kinds":["eew"]}');
      }); return;
    }
    if (request.url === '/test/eew-areas') {
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({areas:eewAreas})); return;
    }
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
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({areas:tsunamiAreas})); return;
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
    await page.waitForFunction(() => document.querySelectorAll('[data-eew-area-row]').length === 188);
    await page.waitForFunction(() => document.querySelectorAll('[data-tsunami-zone]').length === 66);
    await page.waitForFunction(() => document.getElementById('atlasPreview').naturalWidth > 0
      && document.getElementById('stageMetrics').textContent.includes('Chromium capture: 29.5 FPS'));
    assert.equal(await page.locator('#streamVideo').count(), 1);
    assert.equal(await page.locator('#atlasPreview').count(), 1);
    const area = page.locator('tr[data-eew-area-row][data-name="茨城県南部"]');
    await area.locator('[data-warning]').check();
    await area.locator('[data-prediction]').check();
    await area.locator('[data-scale-from]').selectOption('40');
    await area.locator('[data-scale-to]').selectOption('45');
    await area.locator('[data-arrival]').selectOption('10');
    await area.locator('[data-arrival-offset]').fill('8');
    await page.locator('#eewEventId').fill('browser-custom-eew');
    await page.getByRole('button', { name: '設定したEEWを投入' }).click();
    await page.waitForFunction(() => document.getElementById('result').textContent.includes('accepted'));
    const customBulletin = submittedEvents[0].events[0].bulletin;
    assert.equal(customBulletin.eventId, 'browser-custom-eew');
    assert.deepEqual(customBulletin.eewAreaDetails.map(item => item.name), ['茨城県南部']);
    assert.equal(customBulletin.eewForecastAreas[0].scaleTo, '45');
    await page.locator('#compareP2P').fill(JSON.stringify({ code:556, earthquake:{hypocenter:{name:'P2P震源'}}, issue:{eventId:'p2p-compare',serial:'1',time:'2026/11/12 09:00:00'}, areas:[{pref:'茨城',name:'茨城県南部',scaleFrom:40,scaleTo:45}] }));
    await page.locator('#compareJMA').fill(fs.readFileSync(path.join(__dirname, 'samples/37_01_01_240613_VXSE43.xml'), 'utf8'));
    await page.getByRole('button', { name: '両方を順に投入' }).click();
    await page.waitForFunction(() => document.getElementById('result').textContent.includes('accepted'));
    assert.equal(submittedEvents[1].events[0].p2p.code, 556);
    assert.match(submittedEvents[1].events[1].xml, /<Report/);
    await page.getByRole('button', { name: '全区域選択' }).click();
    assert.match(await page.locator('#tsunamiSelectionStatus').innerText(), /66\/66区域/);
    await page.getByRole('button', { name: '選択反転' }).click();
    assert.match(await page.locator('#tsunamiSelectionStatus').innerText(), /選択 0\/66区域/);
    const zone100 = page.locator('tr[data-tsunami-zone][data-code="100"]');
    const zone101 = page.locator('tr[data-tsunami-zone][data-code="101"]');
    const zone360 = page.locator('tr[data-tsunami-zone][data-code="360"]');
    await zone100.locator('[data-zone-select]').check(); await zone101.locator('[data-zone-select]').check();
    await page.locator('#tsunamiBulkSeverity').selectOption('2');
    await page.getByRole('button', { name: '選択区域へ一括適用' }).click();
    assert.equal(await zone100.locator('[data-zone-severity]').inputValue(), '2');
    assert.equal(await zone101.locator('[data-zone-severity]').inputValue(), '2');
    await zone100.locator('[data-zone-severity]').selectOption('1');
    await zone100.locator('[data-zone-height]').fill('1m');
    await zone100.locator('[data-zone-arrival]').selectOption('unknown');
    await zone101.locator('[data-zone-height]').fill('3m');
    await zone101.locator('[data-zone-arrival]').selectOption('soon');
    await zone360.locator('[data-zone-severity]').selectOption('3');
    await zone360.locator('[data-zone-height]').fill('5m');
    await zone360.locator('[data-zone-arrival]').selectOption('arrived');
    assert.match(await page.locator('#tsunamiSelectionStatus').innerText(), /なし 63・注意報 1・警報 1・大津波警報 1/);
    await page.locator('#tsunamiEventId').fill('browser-tsunami');
    await page.getByRole('button', { name: '津波区域設定を投入' }).click();
    await page.waitForFunction(() => document.getElementById('result').textContent.includes('accepted'));
    assert.equal(submittedEvents[2].events[0].bulletin.eventId, 'browser-tsunami');
    assert.equal(submittedEvents[2].events[0].bulletin.tsunami.forecasts.length, 3);
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
