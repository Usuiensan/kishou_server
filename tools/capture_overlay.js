#!/usr/bin/env node
// Overlay renderer for protocol/overlay-fixed.md.
//
// Renders the same telop page as capture_atlas.js (telop/atlas-1080.html fed
// by the shared atlas state snapshot) but keeps only the two elements the
// overlay profile uses:
//   1. the horizontal EEW box (#eew-box), restored to its original
//      1280x720 design position scaled by 1.5 (left 351, top 561,
//      803x268 design size with zoom 1.5), and
//   2. the top two-line telop (#atlas-intensity, the two intensity rows
//      that live in the top band), moved to the top edge at full width.
// Everything else (frame bands, vertical EEW, tsunami minimaps, the alpha
// mirror, the data-bit strip, the test-mode notice) is hidden. Frames are
// 1920x1080 RGBA screenshots with a transparent background, written to
// stdout as length-prefixed PNG (4-byte big-endian length + PNG bytes),
// the same framing as capture_atlas.js --watch. tools/overlay_sender.py
// downscales them to 1280x720 and publishes the fixed pair.
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright-core');

const ROOT = path.resolve(__dirname, '..');
const HTML = path.join(ROOT, 'telop', 'atlas-1080.html');

const OVERLAY_CSS = `
  html, body, #stage { background: transparent !important; }
  #lb-top { background: transparent !important; }
  #atlas-clock, #atlas-source-status { display: none !important; }
  #atlas-intensity { left: 0 !important; top: 0 !important; width: 1920px !important; }
  #lb-left, #atlas-headline, #tsunami-mini, #tsunami-mini-left,
  #tsunami-super, #eew-v, #atlas-alpha-mirror, #rg-bits,
  #atlas-test-notice { display: none !important; }
  #eew-box { left: 234px !important; top: 374px !important; zoom: 1.5; }
`;

function argsFrom(argv) {
  const args = { interval: 500, html: HTML };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--state') args.state = path.resolve(argv[++index]);
    else if (key === '--html') args.html = path.resolve(argv[++index]);
    else if (key === '--interval-ms') args.interval = Number(argv[++index]);
    else if (key === '--browser') args.browser = path.resolve(argv[++index]);
    else throw new Error(`Unknown argument: ${key}`);
  }
  if (!args.state) throw new Error('Usage: node tools/capture_overlay.js --state <snapshot.json> [--interval-ms 500] [--browser <chrome.exe>]');
  if (!(args.interval > 0)) throw new Error('--interval-ms must be positive');
  return args;
}

async function main() {
  const args = argsFrom(process.argv.slice(2));
  if (!fs.existsSync(args.html)) throw new Error(`Atlas HTML not found: ${args.html}`);
  if (!fs.existsSync(args.state)) throw new Error(`State snapshot not found: ${args.state}`);

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
      response.end(fs.readFileSync(args.html));
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
  let stopping = false;
  const stop = () => { stopping = true; };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  process.stdout.once('error', stop);

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
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/atlas-1080.html`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.ATLAS_RENDER_READY && window.ATLAS_SNAPSHOT_RECEIVED, null, { timeout: 15000 });
    await page.addStyleTag({ content: OVERLAY_CSS });
    await page.evaluate(() => document.fonts.ready);
    const info = await page.evaluate(() => ({
      width: document.querySelector('#stage')?.offsetWidth,
      height: document.querySelector('#stage')?.offsetHeight,
      fontStatus: document.fonts.status,
      brokenImages: [...document.images].filter((image) => !image.complete || image.naturalWidth === 0).map((image) => image.src),
      hidden: ['lb-left', 'eew-v', 'atlas-alpha-mirror', 'rg-bits'].map(
        (id) => getComputedStyle(document.getElementById(id)).display === 'none'),
    }));
    if (info.width !== 1936 || info.height !== 1168 || info.fontStatus !== 'loaded'
        || info.brokenImages.length || info.hidden.some((hidden) => !hidden)) {
      throw new Error(`Overlay page not ready: ${JSON.stringify(info)}`);
    }

    let previous = null;
    let nextFrame = Date.now();
    while (!stopping) {
      let png;
      try {
        png = await page.screenshot({
          omitBackground: true, animations: 'allow',
          clip: { x: 0, y: 0, width: 1920, height: 1080 },
        });
      } catch (error) {
        if (stopping) break;
        throw error;
      }
      if (pageErrors.length) throw new Error(`Browser page errors: ${JSON.stringify(pageErrors)}`);
      if (!previous || !png.equals(previous)) {
        const length = Buffer.allocUnsafe(4);
        length.writeUInt32BE(png.length);
        if (!process.stdout.write(Buffer.concat([length, png]))) {
          await new Promise((resolve) => process.stdout.once('drain', resolve));
        }
        previous = png;
      }
      nextFrame += args.interval;
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, nextFrame - Date.now())));
    }
  } finally {
    if (browser) await browser.close();
    server.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
