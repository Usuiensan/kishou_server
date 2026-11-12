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
  const tsunamiMapHtml = fs.readFileSync(path.join(__dirname, '../telop/tsunami-zonecheck.html'));
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/pWQAAAAASUVORK5CYII=', 'base64');
  const submittedEvents = [];
  const submittedScenarios = [];
  const submittedClock = [];
  const submittedLayouts = [];
  const submittedFaults = [];
  const submittedNetworkDiagnostics = [];
  let failNextFault = true;
  const activeTestEvents = [
    {kind:'eew',eventId:'event-eew-1',serial:2,publishedAt:'2026-11-12T00:00:00Z',areas:['茨城県南部']},
    {kind:'tsunami',eventId:'event-tsunami-2',serial:1,publishedAt:'2026-11-12T00:01:00Z',areas:['北海道太平洋沿岸東部']},
  ];
  const logRequests = [];
  const server = http.createServer((request, response) => {
    if(request.method==='POST'&&request.url==='/test/network-diagnostic'){const chunks=[];request.on('data',chunk=>chunks.push(chunk));request.on('end',()=>{submittedNetworkDiagnostics.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify({targetHost:'stream.usuiensan.dev',publicEgressIPv4:'203.0.113.2',ddnsMatchesPublicIPv4:true,outboundTcp8554:true,inboundFirewallChecked:false}));});return;}
    if (request.method === 'POST' && request.url === '/test/events') {
      const chunks = []; request.on('data', chunk => chunks.push(chunk)); request.on('end', () => {
        submittedEvents.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"accepted":true,"kinds":["eew"]}');
      }); return;
    }
    if (request.method === 'POST' && request.url === '/test/scenarios/run') {
      const chunks = []; request.on('data', chunk => chunks.push(chunk)); request.on('end', () => {
        submittedScenarios.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"started":true}');
      }); return;
    }
    if (request.method === 'POST' && request.url === '/test/clock') {
      const chunks = []; request.on('data', chunk => chunks.push(chunk)); request.on('end', () => {
        submittedClock.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"clockOffsetMs":120000}');
      }); return;
    }
    if (request.method === 'POST' && request.url === '/test/layout') {
      const chunks = []; request.on('data', chunk => chunks.push(chunk)); request.on('end', () => {
        submittedLayouts.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"activeLayout":"full"}');
      }); return;
    }
    if (request.method === 'POST' && request.url === '/test/fault') {
      const chunks = []; request.on('data', chunk => chunks.push(chunk)); request.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        submittedFaults.push(body);
        if (failNextFault) { failNextFault = false; response.writeHead(503, { 'content-type': 'application/json' }); response.end('{"error":"synthetic fault failure"}'); return; }
        response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ child: body.child, state: body.action }));
      }); return;
    }
    if (request.method === 'POST' && request.url === '/test/events/remove') {
      const chunks = []; request.on('data', chunk => chunks.push(chunk)); request.on('end', () => {
        const target = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const index = activeTestEvents.findIndex(event => event.kind === target.kind && event.eventId === target.eventId);
        if (index < 0) { response.writeHead(404, { 'content-type':'application/json' }); response.end('{"error":"test event not found"}'); return; }
        activeTestEvents.splice(index, 1);
        response.writeHead(200, { 'content-type':'application/json' }); response.end(JSON.stringify({removed:true,kind:target.kind,eventId:target.eventId}));
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
    if (request.url.startsWith('/test/logs?')) {
      const params = new URL(request.url, 'http://localhost').searchParams;
      logRequests.push({ component: params.get('component'), query: params.get('query') });
      if (params.get('download') === '1') {
        response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'content-disposition': 'attachment; filename="atlas-ingest-logs.txt"' });
        response.end('ERROR rejected fixture\n'); return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ component: params.get('component'), query: params.get('query'), lineCount: 1, content: 'ERROR rejected fixture\n' })); return;
    }
    if (request.url === '/test/status') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ingest: { display: {}, sourceHealth: { jma:{ok:true,at:new Date().toISOString(),lastReceivedAt:'2026-11-12T00:00:00Z'},p2p:{ok:false,at:'2026-11-11T23:00:00Z',lastReceivedAt:null,error:'WebSocket disconnected'} }, testEvents:activeTestEvents, atlasIIConfig: { activeLayout: 'full', atlasSize: [1936, 1168], mainVideoSize: [1920, 1080], outputSize: [1920, 1080], layouts: { full: [{ source: 1, mode: 0, visible: true, opacity: 255, srcX: 0, srcY: 0, srcW: 1920, srcH: 1080, dstX: 0, dstY: 0, dstW: 1920, dstH: 1080 }] } }, activeLayers: {} }, environment:{platform:'Windows test',python:'3.12',gitSha:'abc1234',protocolVersion:2}, children: Object.fromEntries(['mediamtx','ingest','jma-p2p-sources','renderer','a2-sender'].map(name => [name,{running:name==='renderer',enabled:true,pid:name==='renderer'?42:null,restarts:1,lastExitCode:name==='renderer'?null:7}])) })); return;
    }
    if (request.url === '/test/tsunami-areas') {
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({areas:tsunamiAreas})); return;
    }
    if (request.url === '/test/tsunami-map-preview') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end(tsunamiMapHtml); return;
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
    await page.waitForFunction(() => document.getElementById('status').textContent.includes('lastExitCode'));
    await page.locator('#routerWanIPv4').fill('192.168.1.2');
    await page.getByRole('button',{name:'ネットワーク診断を実行'}).click();
    await page.waitForFunction(()=>document.getElementById('result').textContent.includes('inboundFirewallChecked'));
    assert.deepEqual(submittedNetworkDiagnostics,[{routerWanIPv4:'192.168.1.2'}]);
    const deviceImages = await page.evaluate(() => ['#000000', '#010101'].map(color => {
      const canvas=document.createElement('canvas');canvas.width=1920;canvas.height=1080;const context=canvas.getContext('2d');context.fillStyle=color;context.fillRect(0,0,canvas.width,canvas.height);return canvas.toDataURL('image/png').split(',')[1];
    }));
    await page.locator('#devicePlatform').selectOption('Quest');
    await page.locator('#devicePlayer').selectOption('AVPro + Udon');
    await page.locator('#deviceDetails').fill('Quest 3 / test build');
    await page.locator('#deviceReferenceFile').setInputFiles({name:'reference.png',mimeType:'image/png',buffer:Buffer.from(deviceImages[0],'base64')});
    await page.locator('#deviceResultFile').setInputFiles({name:'quest-result.png',mimeType:'image/png',buffer:Buffer.from(deviceImages[1],'base64')});
    await page.getByRole('button',{name:'画像を比較'}).click();
    await page.waitForFunction(() => document.getElementById('deviceComparisonStatus').textContent.includes('平均絶対差 1/255'));
    assert.match(await page.locator('#deviceComparisonStatus').innerText(),/Quest \/ AVPro \+ Udon/);
    const deviceReportDownload=page.waitForEvent('download');
    await page.getByRole('button',{name:'比較結果JSONを保存'}).click();
    const deviceReport=JSON.parse(fs.readFileSync(await (await deviceReportDownload).path(),'utf8'));
    assert.equal(deviceReport.platform,'Quest');assert.equal(deviceReport.player,'AVPro + Udon');assert.equal(deviceReport.meanAbsoluteError,1);assert.equal(deviceReport.changedPixels,1920*1080);
    const statusText = await page.locator('#status').innerText();
    assert.match(await page.locator('#environment').innerText(), /Windows test \/ Python 3\.12 \/ Git abc1234 \/ A2 v2/);
    assert.ok(await page.locator('#sectionSearch').count());
    const compareSection = page.locator('body > section').filter({ has: page.getByRole('heading', { name: /P2P code 556/ }) });
    const statusSection = page.locator('body > section').filter({ has: page.getByRole('heading', { name: '状態', exact: false }) });
    await page.locator('#sectionSearch').fill('P2P code 556');
    assert.equal(await compareSection.isVisible(), true);
    assert.equal(await statusSection.isVisible(), false);
    await page.locator('#sectionSearch').fill('');
    await page.locator('#sectionCategory').selectOption('情報投入');
    assert.equal(await compareSection.isVisible(), true);
    assert.equal(await statusSection.isVisible(), false);
    await page.locator('#sectionCategory').selectOption('all');
    const sampleSection = page.locator('body > section').filter({ has: page.getByRole('heading', { name: /サンプル投入/ }) });
    await sampleSection.getByRole('button', { name: '折り畳む' }).click();
    assert.equal(await sampleSection.locator('button').nth(1).isVisible(), false);
    await sampleSection.getByRole('button', { name: '展開' }).click();
    assert.match(await page.locator('#activeEvents').innerText(), /event-eew-1.*第2報.*茨城県南部/s);
    assert.match(await page.locator('#displayConflict').innerText(), /津波とEEWが同時.*縦型EEW.*津波左帯/);
    assert.equal(await page.locator('#activeEvents [data-event-id]').count(), 2);
    await page.locator('#activeEvents [data-event-id="event-eew-1"] button').click();
    await page.waitForFunction(() => document.getElementById('result').textContent.includes('"removed": true'));
    await page.waitForFunction(() => document.querySelectorAll('#activeEvents [data-event-id]').length === 1);
    assert.match(await page.locator('#activeEvents').innerText(), /event-tsunami-2/);
    assert.equal(await page.getByRole('button', { name: '試験状態を一括リセット' }).count(), 1);
    assert.match(await page.getByText(/対象: テストイベント・表示状態・仮想時計/).innerText(), /Atlas IIレイアウト設定と試験モードは維持/);
    assert.ok(await page.locator('#operationHistory').count());
    assert.equal(await page.getByRole('button', { name: '緊急地震速報', exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'EEW第1報', exact: true }).count(), 1);
    for (const child of ['mediamtx','ingest','jma-p2p-sources','renderer','a2-sender']) assert.ok(statusText.includes(`"${child}"`));
    assert.match(statusText, /"a2-sender"[\s\S]*"running": false[\s\S]*"lastExitCode": 7/);
    assert.match(await page.locator('#sourceHealth').innerText(), /JMA: 接続正常.*最終受信/);
    assert.match(await page.locator('#sourceHealth').innerText(), /P2P: 接続異常.*最終受信 なし.*WebSocket disconnected/);
    assert.deepEqual(await page.locator('nav[aria-label="独立テスター"] a').evaluateAll(links => links.map(link => link.getAttribute('href'))), [
      '/test/tools/tsunami-tester.html', '/test/tools/tsunami-zonecheck.html',
      '/test/tools/eew-telop-tester.html', '/test/tools/tester/index.html',
    ]);
    await page.waitForFunction(() => document.getElementById('rectLayoutJson').value.includes('srcW'));
    await page.locator('#logComponent').selectOption('ingest');
    await page.locator('#logQuery').fill('ERROR');
    await page.getByRole('button', { name: 'ログ検索' }).click();
    await page.waitForFunction(() => document.getElementById('logResult').textContent.includes('rejected fixture'));
    assert.deepEqual(logRequests.at(-1), { component: 'ingest', query: 'ERROR' }, JSON.stringify(logRequests));
    const downloadPromise = page.waitForEvent('download', { timeout: 5000 }).catch(error => error);
    await page.getByRole('button', { name: 'ログ保存', exact: true }).click();
    const logFile = await downloadPromise;
    if (logFile instanceof Error) throw logFile;
    assert.deepEqual(logRequests[1], { component: 'ingest', query: 'ERROR' });
    assert.match(logFile.suggestedFilename(), /ingest.*logs\.txt/);
    await page.locator('#faultChild').selectOption('jma-p2p-sources');
    await page.locator('#faultAction').selectOption('stop');
    await page.getByRole('button', { name: '実行', exact: true }).click();
    await page.waitForFunction(() => document.getElementById('result').textContent.includes('synthetic fault failure'));
    assert.equal(await page.locator('#result').getAttribute('aria-live'), 'polite');
    for (const action of ['stop','resume']) {
      await page.locator('#faultAction').selectOption(action);
      await page.getByRole('button', { name: '実行', exact: true }).click();
      await page.waitForFunction(state => document.getElementById('result').textContent.includes(`"state": "${state}"`), action);
    }
    assert.match(await page.locator('#operationHistory').innerText(), /\/test\/fault/);
    assert.deepEqual(submittedFaults, [{child:'jma-p2p-sources',action:'stop'},{child:'jma-p2p-sources',action:'stop'},{child:'jma-p2p-sources',action:'resume'}]);
    await page.getByRole('button', { name: 'Rect追加' }).click();
    const rects = [
      { source: 1, mode: 0, visible: true, opacity: 255, srcX: 0, srcY: 0, srcW: 1280, srcH: 720, dstX: 0, dstY: 0, dstW: 1280, dstH: 720 },
      { source: 0, mode: 1, visible: false, opacity: 128, srcX: 0, srcY: 200, srcW: 100, srcH: 100, dstX: 10, dstY: 10, dstW: 100, dstH: 100, alphaX: 0, alphaY: 200, alphaW: 100, alphaH: 100 },
    ];
    await page.locator('#rectLayoutJson').fill(JSON.stringify(rects, null, 2));
    await page.locator('#rectIndex').selectOption('1');
    await page.getByRole('button', { name: '順序を上へ' }).click();
    assert.equal(JSON.parse(await page.locator('#rectLayoutJson').inputValue())[0].mode, 1);
    await page.getByRole('button', { name: 'Rect追加' }).click();
    assert.equal(JSON.parse(await page.locator('#rectLayoutJson').inputValue()).length, 3);
    await page.getByRole('button', { name: '選択Rect削除' }).click();
    assert.equal(JSON.parse(await page.locator('#rectLayoutJson').inputValue()).length, 2);
    for (const [id, value] of Object.entries({ atlasWidth: 1920, atlasHeight: 1152, mainVideoWidth: 1280, mainVideoHeight: 720, outputWidth: 1280, outputHeight: 720 })) {
      await page.locator(`#${id}`).fill(String(value));
    }
    await page.getByRole('button', { name: 'Rect・寸法を適用' }).click();
    await page.waitForFunction(() => document.getElementById('result').textContent.includes('activeLayout'));
    assert.deepEqual(submittedLayouts[0].atlasIIConfig.atlasSize, [1920, 1152]);
    assert.deepEqual(submittedLayouts[0].atlasIIConfig.mainVideoSize, [1280, 720]);
    assert.deepEqual(submittedLayouts[0].atlasIIConfig.outputSize, [1280, 720]);
    assert.deepEqual(submittedLayouts[0].atlasIIConfig.layouts.full.map(rect => [rect.source, rect.mode, rect.visible, rect.opacity]), [[0, 1, false, 128], [1, 0, true, 255]]);
    assert.deepEqual(submittedLayouts[0].atlasIIConfig.layouts.full[0], rects[1]);
    assert.deepEqual(submittedLayouts[0].atlasIIConfig.layouts.full[1], rects[0]);
    await page.getByRole('button', { name: 'JSONから画面へ読込' }).click();
    const scenarioRows = page.locator('[data-scenario-step]');
    assert.equal(await scenarioRows.count(), 2);
    await scenarioRows.nth(0).getByLabel('ステップ1 時刻').fill('3');
    await scenarioRows.nth(0).getByLabel('ステップ1 操作').selectOption('display');
    await scenarioRows.nth(0).getByLabel('ステップ1 内容').fill('{"key":"tsunamiLines","visible":false}');
    await scenarioRows.nth(0).getByLabel('ステップ1 内容').press('Tab');
    await page.getByRole('button', { name: 'ステップ追加' }).click();
    assert.equal(await scenarioRows.count(), 3);
    await scenarioRows.nth(2).getByRole('button', { name: '削除' }).click();
    await page.getByRole('button', { name: 'シナリオ実行・再実行' }).click();
    await page.waitForFunction(() => document.getElementById('result').textContent.includes('started'));
    await page.waitForFunction(() => document.getElementById('operationHistory').textContent.includes('/test/scenarios/run'));
    assert.deepEqual(submittedScenarios[0].steps[0], { atSeconds: 3, action: 'display', key: 'tsunamiLines', visible: false });
    assert.equal(submittedScenarios[0].steps.length, 2);
    await page.locator('#scenarioName').fill('browser scenario');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    assert.deepEqual(await page.locator('#savedScenario option').allTextContents(), ['browser scenario']);
    await page.waitForFunction(() => document.getElementById('operationHistory').textContent.includes('シナリオ保存: browser scenario'));
    await page.locator('#scenarioPreset').selectOption('reset');
    await page.getByRole('button', { name: 'プリセット読込' }).click();
    assert.equal(await scenarioRows.count(), 1);
    await page.getByRole('button', { name: '保存分を読込' }).click();
    assert.equal(await scenarioRows.count(), 2);
    const scenarioDownload = page.waitForEvent('download');
    await page.getByRole('button', { name: 'JSONファイル保存' }).click();
    const scenarioFile = JSON.parse(fs.readFileSync(await (await scenarioDownload).path(), 'utf8'));
    assert.deepEqual(scenarioFile.steps[0], submittedScenarios[0].steps[0]);
    await page.getByRole('button', { name: '保存分を削除' }).click();
    assert.equal(await page.locator('#savedScenario option').count(), 0);
    await page.locator('#clockAdvanceMs').fill('120000');
    await page.getByRole('button', { name: '仮想時計を進める', exact: true }).click();
    await page.waitForFunction(() => document.getElementById('result').textContent.includes('clockOffsetMs'));
    assert.deepEqual(submittedClock[0], { advanceMs: 120000 });
    await page.waitForFunction(() => document.querySelectorAll('[data-eew-area-row]').length === 188);
    await page.waitForFunction(() => document.querySelectorAll('[data-tsunami-zone]').length === 66);
    await page.waitForFunction(() => document.querySelector('#tsunamiMapPreview')?.contentDocument?.querySelectorAll('#zc-list .zrow').length === 66);
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
    await page.getByRole('button', { name: '隣接区域', exact: true }).click();
    assert.deepEqual(await page.locator('tr[data-tsunami-zone] [data-zone-severity]').evaluateAll(nodes => nodes.filter(node => node.value === '2').map(node => node.closest('tr').dataset.code)), ['100','101','102']);
    await page.getByRole('button', { name: '狭水域', exact: true }).click();
    assert.deepEqual(await page.locator('tr[data-tsunami-zone] [data-zone-severity]').evaluateAll(nodes => nodes.filter(node => node.value === '1').map(node => node.closest('tr').dataset.code)), ['312','330','391']);
    await page.getByRole('button', { name: '離島', exact: true }).click();
    assert.deepEqual(await page.locator('tr[data-tsunami-zone] [data-zone-severity]').evaluateAll(nodes => nodes.filter(node => node.value === '1').map(node => node.closest('tr').dataset.code)), ['320','321','772','802']);
    await page.getByRole('button', { name: '湾奥・混合種別', exact: true }).click();
    assert.equal(await page.locator('tr[data-tsunami-zone][data-code="202"] [data-zone-severity]').inputValue(), '1');
    assert.equal(await page.locator('tr[data-tsunami-zone][data-code="312"] [data-zone-severity]').inputValue(), '2');
    assert.equal(await page.locator('tr[data-tsunami-zone][data-code="391"] [data-zone-severity]').inputValue(), '3');
    await page.getByRole('button', { name: '全区域選択' }).click(); await page.locator('#tsunamiBulkSeverity').selectOption('0'); await page.getByRole('button', { name: '選択区域へ一括適用' }).click(); await page.getByRole('button', { name: '選択反転' }).click();
    await zone100.locator('[data-zone-severity]').selectOption('0');
    assert.equal(await page.frameLocator('#tsunamiMapPreview').locator('#zc-list .zrow').nth(0).locator('button').innerText(), 'なし');
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
    const map = page.frameLocator('#tsunamiMapPreview');
    await page.waitForFunction(() => document.querySelector('#tsunamiMapPreview').contentDocument.querySelectorAll('.tm-legend-label').length === 6);
    assert.equal(await map.locator('#tm-stage svg').nth(0).getAttribute('class'), 'tm-blink');
    assert.equal(await map.locator('#tm-stage svg').nth(0).locator('.tm-land').count() > 0, true);
    assert.equal(await map.locator('#tm-stage svg').nth(0).locator('.tm-zone').count() > 0, true);
    assert.equal(await map.locator('#tm-stage svg').nth(0).locator('polyline.tm-decor2').count(), 2);
    assert.equal(await map.locator('#tm-stage svg').nth(0).evaluate((left, right) => left.innerHTML === right.innerHTML,
      await map.locator('#tm-stage svg').nth(1).elementHandle()), true);
    const overlappingZoneColors = await map.locator('#tm-stage svg').nth(0).evaluate(() => {
      renderTsunamiMini({ major: ['宮城県'], warning: ['宮城県'], legend: false, blink: false }, 'tsunami-mini');
      return [...document.querySelectorAll('#tsunami-mini .tm-zone')].map(path => path.getAttribute('fill'));
    });
    assert.ok(overlappingZoneColors.length > 0);
    assert.deepEqual([...new Set(overlappingZoneColors)], ['#c800ff']);
    await page.evaluate(() => previewTsunamiMap());
    await page.locator('#tsunamiPreviewBlink').uncheck();
    const scaleCounts = await page.frameLocator('#tsunamiMapPreview').locator('#tm-stage svg').nth(0).evaluate(async svg => {
      const mapDocument=svg.ownerDocument, copy=svg.cloneNode(true), style=mapDocument.createElementNS('http://www.w3.org/2000/svg','style');
      copy.setAttribute('class',''); style.textContent=mapDocument.querySelector('style').textContent; copy.insertBefore(style,copy.firstChild);
      const url=URL.createObjectURL(new Blob([copy.outerHTML],{type:'image/svg+xml'})), image=new Image(); image.src=url; await image.decode();
      const countAt=(width,height)=>{const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0,width,height);const pixels=ctx.getImageData(0,0,width,height).data;const counts={land:0,coast:0,advisory:0,warning:0,major:0};for(let i=0;i<pixels.length;i+=4){if(!pixels[i+3])continue;const key=pixels[i]===152&&pixels[i+1]===152&&pixels[i+2]===152?'land':pixels[i]===21&&pixels[i+1]===21&&pixels[i+2]===21?'coast':pixels[i]===250&&pixels[i+1]===245&&pixels[i+2]===0?'advisory':pixels[i]===255&&pixels[i+1]===40&&pixels[i+2]===0?'warning':pixels[i]===200&&pixels[i+1]===0&&pixels[i+2]===255?'major':null;if(key)counts[key]++;}return counts;};
      URL.revokeObjectURL(url);return {full:countAt(640,510),small:countAt(258,205)};
    });
    for(const key of ['land','coast','advisory','warning','major']){assert.ok(scaleCounts.small[key]>0,'small preview retains '+key);assert.ok(scaleCounts.small[key]<scaleCounts.full[key],key+' scales with the map');}
    await page.locator('#tsunamiPreviewBlink').uncheck();
    await page.waitForFunction(() => document.querySelector('#tsunamiMapPreview').contentDocument.querySelector('#tm-stage svg')?.getAttribute('class') === '');
    await page.locator('#tsunamiPreviewLines').uncheck();
    await page.waitForFunction(() => document.querySelector('#tsunamiMapPreview').contentDocument.querySelector('#tm-stage svg .tm-zone') === null);
    assert.equal(await map.locator('#tm-stage svg').nth(0).locator('.tm-land').count() > 0, true);
    await page.locator('#tsunamiPreviewBlink').check(); await page.locator('#tsunamiPreviewLines').check();
    await page.getByRole('button', { name: '66区域を順次表示' }).click();
    assert.equal(await page.frameLocator('#tsunamiMapPreview').locator('#zc-list .zrow').nth(0).locator('button').innerText(), '注意報');
    await page.waitForTimeout(1050);
    assert.equal(await page.frameLocator('#tsunamiMapPreview').locator('#zc-list .zrow').nth(0).locator('button').innerText(), 'なし');
    await page.getByRole('button', { name: '順次表示を停止' }).click();
    const contactSheetDownload = page.waitForEvent('download');
    await page.getByRole('button', { name: '66区域コンタクトシートPNG保存' }).click();
    const contactSheetPath = await (await contactSheetDownload).path();
    const contactSheetPng = fs.readFileSync(contactSheetPath);
    assert.equal(contactSheetPng.toString('hex', 0, 8), '89504e470d0a1a0a');
    assert.equal(contactSheetPng.readUInt32BE(16), 1320);
    assert.equal(contactSheetPng.readUInt32BE(20), 2035);
    await page.locator('#tsunamiEventId').fill('browser-tsunami');
    await page.getByRole('button', { name: '津波区域設定を投入' }).click();
    await page.waitForFunction(() => document.getElementById('result').textContent.includes('accepted'));
    assert.equal(submittedEvents[2].events[0].bulletin.eventId, 'browser-tsunami');
    assert.equal(submittedEvents[2].events[0].bulletin.tsunami.forecasts.length, 3);
    await page.locator('#intensityEventId').fill('browser-intensity');
    await page.locator('#intensitySerial').fill('2');
    await page.locator('#intensityMax').selectOption('6+');
    await page.locator('#intensityTsunamiWorry').selectOption('published');
    await page.locator('#intensityAreas').fill(JSON.stringify({ prefectures:[{name:'石川県',maxInt:'6+'}], regions:{'6+':['石川県能登']}, cities:{'6+':['輪島市']} }));
    await page.getByRole('button', { name: '震度・地震情報を投入' }).click();
    await page.waitForFunction(() => document.getElementById('result').textContent.includes('accepted'));
    assert.deepEqual(submittedEvents[3].events.map(item=>item.kind), ['intensity','vertical']);
    assert.equal(submittedEvents[3].events[0].bulletin.eventId, 'browser-intensity');
    assert.equal(submittedEvents[3].events[0].bulletin.intensity.maxInt, '6+');
    assert.equal(submittedEvents[3].events[0].bulletin.tsunamiWorry, true);
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
