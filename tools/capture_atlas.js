#!/usr/bin/env node
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright-core');
const { performance } = require('node:perf_hooks');
const { summarizeCaptures } = require('./atlas_capture_metrics');

const ROOT = path.resolve(__dirname, '..');
const HTML = path.join(ROOT, 'telop', 'atlas-1080.html');

function argsFrom(argv) {
  const args = { interval: 1000 / 30, watch: false };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--watch') args.watch = true;
    else if (key === '--state') args.state = path.resolve(argv[++index]);
    else if (key === '--output') args.output = path.resolve(argv[++index]);
    else if (key === '--metrics-file') args.metricsFile = path.resolve(argv[++index]);
    else if (key === '--interval-ms') args.interval = Number(argv[++index]);
    else if (key === '--browser') args.browser = path.resolve(argv[++index]);
    else throw new Error(`Unknown argument: ${key}`);
  }
  if (!args.state || !args.output) throw new Error('Usage: node tools/capture_atlas.js --state <snapshot.json> --output <capture.png> [--watch] [--interval-ms 33] [--browser <chrome.exe>] [--metrics-file <metrics.json>]');
  if (!(args.interval > 0)) throw new Error('--interval-ms must be positive');
  return args;
}

function atomicWrite(filePath, content) {
  const temp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temp, content);
  fs.renameSync(temp, filePath);
}

async function main() {
  const args = argsFrom(process.argv.slice(2));
  if (!fs.existsSync(HTML)) throw new Error(`Build the atlas first: ${HTML}`);
  if (!fs.existsSync(args.state)) throw new Error(`State snapshot not found: ${args.state}`);
  fs.mkdirSync(path.dirname(args.output), { recursive: true });
  if (args.metricsFile) fs.mkdirSync(path.dirname(args.metricsFile), { recursive: true });

  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    if (pathname === '/favicon.ico') {
      response.writeHead(204);
      response.end();
      return;
    }
    if (pathname === '/atlas-state.json') {
      try {
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        response.end(fs.readFileSync(args.state));
      } catch (error) {
        response.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        response.end(`State unavailable: ${error.message}`);
      }
      return;
    }
    if (pathname === '/' || pathname === '/atlas-1080.html') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      response.end(fs.readFileSync(HTML));
      return;
    }
    response.writeHead(404);
    response.end();
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  let browser;
  const pageErrors = [];
  const consoleErrors = [];
  const failedRequests = [];
  let captures = 0;
  let changedFrames = 0;
  let previous = null;
  let stopping = false;
  const captureSamples = [];
  let metricsWrittenAt = 0;
  const writeCaptureMetrics = (force = false) => {
    if (!args.metricsFile || (!force && performance.now() - metricsWrittenAt < 1000)) return;
    atomicWrite(args.metricsFile, JSON.stringify(summarizeCaptures(captureSamples, changedFrames, Date.now())));
    metricsWrittenAt = performance.now();
  };
  const stop = () => { stopping = true; };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  try {
    const launch = { headless: true, args: ['--disable-gpu', '--disable-background-timer-throttling'] };
    if (args.browser || process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) {
      launch.executablePath = args.browser || process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
    } else if (process.platform === 'win32') {
      launch.channel = 'chrome';
    }
    browser = await chromium.launch(launch);
    const context = await browser.newContext({ viewport: { width: 1936, height: 1228 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    page.on('requestfailed', (request) => {
      if (!request.url().endsWith('/favicon.ico')) failedRequests.push(`${request.url()}: ${request.failure()?.errorText || 'failed'}`);
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/atlas-1080.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.ATLAS_RENDER_READY && window.ATLAS_SNAPSHOT_RECEIVED, null, { timeout: 15000 });
    await page.evaluate(() => document.fonts.ready);
    const info = await page.evaluate(() => ({
      width: document.querySelector('#stage')?.offsetWidth,
      height: document.querySelector('#stage')?.offsetHeight,
      fontStatus: document.fonts.status,
      brokenImages: [...document.images].filter((image) => !image.complete || image.naturalWidth === 0).map((image) => image.src),
      renderedLayers: Object.fromEntries(Object.entries(window.ATLAS_LAST_SNAPSHOT?.layers || {}).map(([kind, entries]) => [kind, entries.length])),
      visible: {
        eew: document.getElementById('eew-box')?.classList.contains('on'),
        verticalEew: document.getElementById('eew-v')?.classList.contains('on'),
        tsunamiSvg: !!document.querySelector('#tsunami-mini svg'),
        intensityRows: document.querySelectorAll('#atlas-intensity .atlas-intensity-row').length,
      },
      componentStyle: Object.fromEntries(['eew-box', 'eew-v', 'tsunami-mini'].map((id) => {
        const element = document.getElementById(id);
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return [id, { display: style.display, visibility: style.visibility, opacity: style.opacity,
          rect: [rect.x, rect.y, rect.width, rect.height], text: element.innerText.slice(0, 100) }];
      })),
    }));
    if (info.width !== 1936 || info.height !== 1168 || info.fontStatus !== 'loaded' || info.brokenImages.length) {
      throw new Error(`Atlas not ready: ${JSON.stringify(info)}`);
    }

    const started = Date.now();
    let nextFrame = started;
    do {
      if (args.watch) {
        // Apply Unix-time phase to every active tsunami map animation before
        // taking the screenshot, including the left map and alpha-mask copy.
        // The old <svg>.getAnimations() call missed animations on child paths.
        await page.evaluate(() => window.AtlasLive.syncTsunamiBlinkClock(Date.now()));
      }
      const captureStarted = performance.now();
      const png = await page.locator('#stage').screenshot({ animations: 'allow' });
      const capturedAt = performance.now();
      captures += 1;
      captureSamples.push({ at: capturedAt, unixMs: Date.now(), durationMs: capturedAt - captureStarted });
      while (captureSamples.length > 300 || capturedAt - captureSamples[0].at > 10000) captureSamples.shift();
      if (!previous || !png.equals(previous)) {
        if (args.watch) {
          const length = Buffer.allocUnsafe(4);
          length.writeUInt32BE(png.length);
          if (!process.stdout.write(Buffer.concat([length, png]))) {
            await new Promise((resolve) => process.stdout.once('drain', resolve));
          }
        } else {
          atomicWrite(args.output, png);
        }
        previous = png;
        changedFrames += 1;
      }
      writeCaptureMetrics();
      if (!args.watch) break;
      nextFrame += args.interval;
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, nextFrame - Date.now())));
    } while (!stopping);

    if (pageErrors.length || consoleErrors.length || failedRequests.length) {
      throw new Error(`Browser errors: ${JSON.stringify({ pageErrors, consoleErrors, failedRequests })}`);
    }
    if (!args.watch) {
      const box = await page.locator('#stage').boundingBox();
      const result = { output: args.output, size: [box.width, box.height], mode: 'RGBA PNG capture', captures, changedFrames, browser: await browser.version(), assets: { documentFonts: info.fontStatus, brokenImages: info.brokenImages, failedRequests }, renderedLayers: info.renderedLayers, visible: info.visible, componentStyle: info.componentStyle };
      process.stdout.write(`${JSON.stringify(result)}\n`);
    }
  } finally {
    writeCaptureMetrics(true);
    if (browser) await browser.close();
    await new Promise((resolve) => server.close(resolve));
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
