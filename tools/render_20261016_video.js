#!/usr/bin/env node
'use strict';

/**
 * 2026年10月16日 12時38〜40分頃 緊急地震速報 (誤報: カムチャツカ半島付近 M9.9 / 最大震度7 -> 取消)
 * の実際のシチュエーションを再現した MP4 動画 (out/eew_20261016_demo.mp4) を生成する。
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright-core');
const { createAtlasSnapshot } = require('../lib/atlasData');
const { ingestEewJson } = require('./atlas_ingest');

const ROOT = path.resolve(__dirname, '..');
const HTML_PATH = path.join(ROOT, 'telop', 'atlas-1080.html');
const OUT_DIR = path.join(ROOT, 'out');
const OUT_VIDEO = path.join(OUT_DIR, 'eew_20261016_demo.mp4');

const HOKKAIDO_20261016_AREAS = [
  '根室地方北部', '根室地方中部', '根室地方南部', '網走地方', '北見地方', '釧路地方北部',
  '紋別地方', '釧路地方中南部', '宗谷地方北部', '宗谷地方南部', '上川地方北部', '空知地方南部',
  '胆振地方中東部', '石狩地方中部', '十勝地方北部', '上川地方中部', '留萌地方中北部',
  '十勝地方中部', '北海道利尻礼文', '十勝地方南部', '上川地方南部',
];

function findChrome() {
  const candidates = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ];
  const hit = candidates.find((p) => fs.existsSync(p));
  if (!hit) throw new Error('Chrome/Edge executable not found');
  return hit;
}

function buildSnapshots() {
  const layoutConfig = JSON.parse(fs.readFileSync(path.join(ROOT, 'examples', 'atlas-layouts.json'), 'utf8'));
  const baseNow = Date.parse('2026-10-16T12:38:10+09:00');
  const health = {
    jma: { ok: true, at: new Date(baseNow).toISOString() },
    p2p: { ok: true, at: new Date(baseNow).toISOString() },
  };

  // 1. 通常待機状態
  const idleSnap = {
    ...createAtlasSnapshot(baseNow),
    seq: 1,
    atlasIIConfig: layoutConfig,
    sourceHealth: health,
  };

  // 2. 2026-10-16 12:38 緊急地震速報(警報) カムチャツカ半島付近 M9.9 最大震度7
  const warnRes = ingestEewJson(idleSnap, 'axis', {
    EventID: '20261016123810',
    Serial: 1,
    Title: '緊急地震速報（警報）',
    ReportDateTime: '2026-10-16T12:38:10+09:00',
    OriginDateTime: '2026-10-16T12:38:00+09:00',
    Intensity: '7',
    Magnitude: 9.9,
    Flag: { is_training: false, is_final: false, is_cancel: false },
    Hypocenter: { Name: 'カムチャツカ半島付近', Coordinate: [], Depth: '' },
    Forecast: HOKKAIDO_20261016_AREAS.map((Name) => ({
      Name,
      Intensity: { From: '5-', To: '7' },
    })),
  }, baseNow);

  const alarmSnap = {
    ...warnRes.state,
    seq: 2,
    sourceHealth: health,
  };

  // 3. 2026-10-16 12:40 取消報
  const cancelNow = Date.parse('2026-10-16T12:40:00+09:00');
  const cancelRes = ingestEewJson(alarmSnap, 'axis', {
    EventID: '20261016123810',
    Serial: 2,
    Title: '緊急地震速報（警報）',
    ReportDateTime: '2026-10-16T12:40:00+09:00',
    OriginDateTime: '2026-10-16T12:38:00+09:00',
    Flag: { is_training: false, is_final: true, is_cancel: true },
    Hypocenter: { Name: 'カムチャツカ半島付近', Coordinate: [], Depth: '' },
    Forecast: [],
  }, cancelNow);

  const cancelSnap = {
    ...cancelRes.state,
    seq: 3,
    sourceHealth: {
      jma: { ok: true, at: new Date(cancelNow).toISOString() },
      p2p: { ok: true, at: new Date(cancelNow).toISOString() },
    },
  };

  return { idleSnap, alarmSnap, cancelSnap };
}

async function captureFrames(tmpDir, snaps) {
  const browser = await chromium.launch({
    executablePath: findChrome(),
    headless: true,
    args: ['--no-sandbox', '--disable-gpu'],
  });
  try {
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    const page = await context.newPage();

    // 待機背景がわかりやすいように dark gray ステージのまま開く
    await page.goto(`file:///${HTML_PATH.replace(/\\/g, '/')}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof window.applyAtlasSnapshot === 'function');

    const states = [
      { name: 'idle', snap: snaps.idleSnap, badge: '通常待機（無音モノラル音声）' },
      { name: 'alarm', snap: snaps.alarmSnap, badge: '2026-10-16 12:38 警報発報（カムチャツカ半島付近 M9.9 / 最大震度7）' },
      { name: 'cancel', snap: snaps.cancelSnap, badge: '2026-10-16 12:40 取消報（「先ほどの緊急地震速報は取り消されました。」）' },
    ];

    for (const st of states) {
      await page.evaluate(({ snap, badge }) => {
        window.applyAtlasSnapshot(snap);
        let el = document.getElementById('demo-caption');
        if (!el) {
          el = document.createElement('div');
          el.id = 'demo-caption';
          el.style.cssText = [
            'position:fixed', 'left:36px', 'bottom:28px', 'z-index:9999',
            'background:rgba(15,23,42,0.86)', 'color:#f8fafc',
            'font:700 28px/1.4 "Noto Sans JP","Yu Gothic UI",sans-serif',
            'padding:12px 20px', 'border-radius:10px', 'border:2px solid #475569',
          ].join(';');
          document.body.appendChild(el);
        }
        el.textContent = badge;
      }, st);
      await page.waitForTimeout(200);
      await page.screenshot({ path: path.join(tmpDir, `${st.name}.png`) });
    }
  } finally {
    await browser.close();
  }
}

function generateTimelinePcm(pcmPath) {
  const pyScript = `
import sys
from pathlib import Path
sys.path.insert(0, ${JSON.stringify(path.join(ROOT, 'tools'))})
from eew_audio_stream import AudioClipCache, build_eew_audio_playlist, SAMPLE_RATE, CHANNELS, SAMPLE_WIDTH, DEFAULT_AUDIO_DIR

cache = AudioClipCache(ffmpeg="ffmpeg", sample_rate=SAMPLE_RATE)
bps = SAMPLE_RATE * CHANNELS * SAMPLE_WIDTH  # bytes per second (96000)

# 0.0 - 2.0s: 通常待機 (無音)
idle_pcm = b"\\x00" * (2 * bps)

# 2.0 - 14.0s (12.0s): 警報発報 (12秒で途中カット)
areas = ${JSON.stringify(HOKKAIDO_20261016_AREAS)}
playlist = build_eew_audio_playlist("カムチャツカ半島付近", areas, is_update=False)
alarm_chunks = []
for path, pause_ms in playlist:
    alarm_chunks.append(cache.get_pcm(path))
    alarm_chunks.append(b"\\x00" * (int(SAMPLE_RATE * pause_ms / 1000) * CHANNELS * SAMPLE_WIDTH))
alarm_full = b"".join(alarm_chunks)
alarm_cut = alarm_full[:12 * bps]
if len(alarm_cut) < 12 * bps:
    alarm_cut += b"\\x00" * (12 * bps - len(alarm_cut))

# 14.0 - 20.0s (6.0s): 取消報
cancel_pcm = cache.get_pcm(DEFAULT_AUDIO_DIR / "phrases" / "alert_cancel.mp3")
cancel_slot = cancel_pcm[:6 * bps]
if len(cancel_slot) < 6 * bps:
    cancel_slot += b"\\x00" * (6 * bps - len(cancel_slot))

Path(${JSON.stringify(pcmPath)}).write_bytes(idle_pcm + alarm_cut + cancel_slot)
`;
  execFileSync('python', ['-c', pyScript], { stdio: 'inherit' });
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const tmpDir = path.join(OUT_DIR, '.tmp_20261016');
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    const snaps = buildSnapshots();
    await captureFrames(tmpDir, snaps);

    const pcmPath = path.join(tmpDir, 'timeline.pcm');
    generateTimelinePcm(pcmPath);

    const concatTxt = path.join(tmpDir, 'frames.txt');
    fs.writeFileSync(
      concatTxt,
      [
        `file '${path.join(tmpDir, 'idle.png').replace(/\\/g, '/')}'`,
        'duration 2.0',
        `file '${path.join(tmpDir, 'alarm.png').replace(/\\/g, '/')}'`,
        'duration 12.0',
        `file '${path.join(tmpDir, 'cancel.png').replace(/\\/g, '/')}'`,
        'duration 6.0',
        `file '${path.join(tmpDir, 'cancel.png').replace(/\\/g, '/')}'`,
      ].join('\n'),
      'utf8'
    );

    execFileSync('ffmpeg', [
      '-y', '-loglevel', 'warning',
      '-f', 'concat', '-safe', '0', '-i', concatTxt,
      '-f', 's16le', '-ar', '48000', '-ac', '1', '-i', pcmPath,
      '-vf', 'scale=1280:720,fps=30,format=yuv420p',
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
      '-c:a', 'aac', '-ac', '1', '-ar', '48000', '-b:a', '96k',
      '-shortest',
      OUT_VIDEO,
    ], { stdio: 'inherit' });

    console.log(`Generated video: ${OUT_VIDEO}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
