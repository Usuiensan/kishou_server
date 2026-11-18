#!/usr/bin/env node
// Overlay renderer for protocol/overlay-fixed.md.
//
// Renders the same telop page as capture_atlas.js (telop/atlas-1080.html fed
// by the shared atlas state snapshot) but keeps only the two elements the
// overlay profile uses:
//   1. the horizontal EEW box (#eew-box), restored to its original
//      1280x720 design position scaled by 1.5 (left 351, top 561,
//      803x268 design size with zoom 1.5), and the forecast-grade EEW
//      window (#eew-forecast-window), which shares the box's top-left
//      corner and the same zoom — except that both of its display
//      forms sit at the top of the screen instead: the warning-grade
//      strip (class "strip") and the forecast-only window (class
//      "top") move to the telop's top margin (rendered 54px = CSS
//      top 36px at zoom 1.5), dropping below the summary band when
//      that is also on screen (class "below-summary": rendered
//      54 + 120*1.25 = 204px = CSS 136px),
//      and
//   2. the top two-line telop (#atlas-intensity, the two intensity rows
//      that live in the top band), inset by 5% screen margins (top 54px,
//      left/right 96px of the 1920x1080 canvas) and scaled by 1.25. The
//      layout width is (1920 - 2*96) / 1.25 = 1382.4px so the scaled box
//      spans exactly the margin-inset width and no text is pushed off
//      the canvas edge.
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
  #atlas-intensity { left: 96px !important; top: 54px !important; width: 1382.4px !important;
    transform: scale(1.25); transform-origin: top left; }
  #lb-left, #atlas-headline, #tsunami-mini, #tsunami-mini-left,
  #tsunami-super, #eew-v, #atlas-alpha-mirror, #rg-bits,
  #atlas-test-notice { display: none !important; }
  #eew-box { left: 234px !important; top: 374px !important; zoom: 1.5; }
  #eew-forecast-window { left: 96px !important; width: 1382.4px !important;
    transform: scale(1.25); transform-origin: top left; }
  #eew-forecast-window.top { top: 54px !important; }
  #eew-forecast-window.top.below-summary { top: 248px !important; }
`;

function argsFrom(argv) {
  const args = { interval: 100, html: HTML };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--state') args.state = path.resolve(argv[++index]);
    else if (key === '--html') args.html = path.resolve(argv[++index]);
    else if (key === '--interval-ms') args.interval = Number(argv[++index]);
    else if (key === '--browser') args.browser = path.resolve(argv[++index]);
    else throw new Error(`Unknown argument: ${key}`);
  }
  if (!args.state) throw new Error('Usage: node tools/capture_overlay.js --state <snapshot.json> [--interval-ms 100] [--browser <chrome.exe>]');
  if (!(args.interval > 0)) throw new Error('--interval-ms must be positive');
  return args;
}

async function main() {
  const args = argsFrom(process.argv.slice(2));
  if (!fs.existsSync(args.html)) throw new Error(`Atlas HTML not found: ${args.html}`);
  if (!fs.existsSync(args.state)) throw new Error(`State snapshot not found: ${args.state}`);

  let lastServedSeq = null;
  let lastSavedSeq = null;
  let savedFrames = new Set();
  let savedPageCount = 0;
  let lastPushedState = null;
  const sseClients = new Set();
  const seqFramesDir = path.join(path.dirname(args.state), 'seq-frames');
  const saveSeqFrame = (seq, png) => {
    if (!Number.isInteger(seq)) return;
    const frameKey = png.toString('base64');
    let targetName;
    if (seq !== lastSavedSeq) {
      targetName = `${seq}.png`;
    } else {
      if (savedFrames.has(frameKey) || savedPageCount >= 12) return;
      targetName = `${seq}-p${savedPageCount + 2}.png`;
    }
    try {
      fs.mkdirSync(seqFramesDir, { recursive: true });
      const target = path.join(seqFramesDir, targetName);
      const temporary = `${target}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, png);
      fs.renameSync(temporary, target);
      const files = fs.readdirSync(seqFramesDir).filter((name) => /^(\d+)(?:-p\d+)?\.png$/.test(name));
      const sequences = [...new Set(files.map((name) => Number(name.match(/^(\d+)/)[1])))].sort((a, b) => b - a);
      const kept = new Set(sequences.slice(0, 96));
      for (const name of files) {
        if (!kept.has(Number(name.match(/^(\d+)/)[1]))) fs.rmSync(path.join(seqFramesDir, name));
      }
      if (seq !== lastSavedSeq) {
        lastSavedSeq = seq;
        savedFrames = new Set([frameKey]);
        savedPageCount = 0;
      } else {
        savedFrames.add(frameKey);
        savedPageCount += 1;
      }
    } catch (error) {
      process.stderr.write(`seq frame save failed: ${error.message}\n`);
    }
  };
  const pushState = (response, body) => {
    try {
      const snapshot = JSON.parse(body);
      if (Number.isInteger(snapshot.seq)) lastServedSeq = snapshot.seq;
    } catch (_) { /* ignore malformed state */ }
    response.write(`data: ${body}\n\n`);
  };
  const broadcastState = () => {
    let body;
    try { body = fs.readFileSync(args.state, 'utf8'); } catch (_) { return; }
    if (body === lastPushedState) return;
    lastPushedState = body;
    for (const client of sseClients) {
      if (!client.destroyed) pushState(client, body);
    }
  };
  const stateWatcher = fs.watch(path.dirname(args.state), (eventType, filename) => {
    if (filename && filename.toString() === path.basename(args.state)) broadcastState();
  });
  stateWatcher.on('error', () => { /* keep serving polling and existing SSE clients */ });
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    if (pathname === '/favicon.ico') {
      response.writeHead(204);
      response.end();
      return;
    }
    if (pathname === '/atlas-state.json') {
      try {
        const body = fs.readFileSync(args.state);
        try { const snapshot = JSON.parse(body); if (Number.isInteger(snapshot.seq)) lastServedSeq = snapshot.seq; } catch (_) { /* ignore malformed state */ }
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        response.end(body);
      } catch (error) {
        response.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        response.end(`State unavailable: ${error.message}`);
      }
      return;
    }
    if (pathname === '/atlas-state-events') {
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      sseClients.add(response);
      response.on('close', () => sseClients.delete(response));
      try {
        const body = fs.readFileSync(args.state, 'utf8');
        lastPushedState = body;
        pushState(response, body);
      } catch (_) {
        response.end();
        sseClients.delete(response);
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
    let previousSeq = null;
    let captureTail = Promise.resolve();
    const captureFrame = (requestedSeq) => {
      captureTail = captureTail.then(async () => {
      // 撮影中はページの snapshot 適用を止める。撮影と適用が重なると
      // 撮影した絵と seq の紐付けがずれる (撮影中に適用が走ると、
      // 撮影後の読み直しが新 seq を返し、古い絵に新 seq が付く)。
      await page.evaluate(() => { window.ATLAS_CAPTURE_BUSY = true; });
      try {
      // 要求された seq の描画フレームが実際に出るまで待つ。DOM更新
      // 直後の撮影ではコンポジタが前の描画を出すことがあるため、
      // ページ側の ATLAS_PAINTED_SEQ が一致するのを最大1秒待つ。
      if (Number.isInteger(requestedSeq)) {
        const deadline = Date.now() + 1000;
        for (;;) {
          let painted = null;
          try {
            painted = await page.evaluate(() => window.ATLAS_PAINTED_SEQ);
          } catch (_) { break; }
          if (painted === requestedSeq) break;
          if (Number.isInteger(painted) && painted > requestedSeq) break;
          if (Date.now() >= deadline) break;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
      let png;
      try {
        png = await page.screenshot({
          omitBackground: true, animations: 'allow',
          clip: { x: 0, y: 0, width: 1920, height: 1080 },
        });
      } catch (error) {
        if (stopping) return;
        throw error;
      }
      if (pageErrors.length) throw new Error(`Browser page errors: ${JSON.stringify(pageErrors)}`);
      // 撮影後に描画済み seq を読み直す。キュー待ちの間に状態が進んだ
      // 場合、呼び出し時の seq では前 seq のページとして誤紐付けになる。
      let frameSeq = Number.isInteger(requestedSeq) ? requestedSeq : lastServedSeq;
      try {
        const rendered = await page.evaluate(() => window.ATLAS_RENDERED_SEQ);
        if (Number.isInteger(rendered)) frameSeq = rendered;
      } catch (_) { /* Keep the requested sequence if the page is unavailable. */ }
      if (!previous || !png.equals(previous)) {
        saveSeqFrame(frameSeq, png);
        const length = Buffer.allocUnsafe(4);
        length.writeUInt32BE(png.length);
        if (!process.stdout.write(Buffer.concat([length, png]))) {
          await new Promise((resolve) => process.stdout.once('drain', resolve));
        }
        previous = png;
        previousSeq = frameSeq;
      } else if (Number.isInteger(lastServedSeq) && lastServedSeq !== previousSeq) {
        // 状態が変わっても画面が変わらない場合（津波表示中に震度情報が
        // 追加される等）でも、その seq に対応するフレームを残す。
        saveSeqFrame(frameSeq, png);
        previousSeq = frameSeq;
      }
      } finally {
        await page.evaluate(() => { window.ATLAS_CAPTURE_BUSY = false; }).catch(() => {});
      }
      });
      return captureTail;
    };
    await page.exposeFunction('atlasFrameRendered', (seq) => captureFrame(seq));
    await page.evaluate(() => {
      window.ATLAS_ON_RENDER = (seq) => window.atlasFrameRendered(seq);
      if (Number.isInteger(window.ATLAS_RENDERED_SEQ)) return window.atlasFrameRendered(window.ATLAS_RENDERED_SEQ);
      return null;
    });
    let nextFrame = Date.now();
    while (!stopping) {
      await captureFrame(await page.evaluate(() => window.ATLAS_RENDERED_SEQ));
      nextFrame += args.interval;
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, nextFrame - Date.now())));
    }
  } finally {
    stateWatcher.close();
    if (browser) await browser.close();
    server.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
