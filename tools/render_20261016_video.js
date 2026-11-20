#!/usr/bin/env node
'use strict';

/**
 * 気象庁 緊急地震速報（警報）発表状況ページ (2026/10/16 12:38〜48 カムチャツカ半島付近 M9.9/最大震度7 -> 取消)
 * に基づく、オーバーレイ固定ペア形式 (1280x1440: 上RGB/下Alpha輝度) + モノラル音声 MP4 動画を生成する。
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
const OUT_VIDEO = path.join(OUT_DIR, 'eew_20261016_overlay.mp4');

// tools/capture_overlay.js と同一のオーバーレイ専用 CSS
const OVERLAY_CSS = `
  html, body, #stage { background: transparent !important; }
  #lb-top { background: transparent !important; }
  #atlas-clock, #atlas-source-status { display: none !important; }
  #atlas-intensity { left: 48px !important; top: 54px !important; width: 1459.2px !important;
    transform: scale(1.25); transform-origin: top left; }
  #lb-left, #atlas-headline, #tsunami-mini, #tsunami-mini-left,
  #tsunami-super, #eew-v, #atlas-alpha-mirror, #rg-bits,
  #atlas-test-notice { display: none !important; }
  #eew-box { left: 234px !important; top: 374px !important; zoom: 1.5; }
  #eew-forecast-window { left: 48px !important; width: 1459.2px !important;
    transform: scale(1.25); transform-origin: top left; }
  #eew-forecast-window.top { top: 54px !important; }
  #eew-forecast-window.top.below-summary { top: 248px !important; }
`;

// 気象庁 reachtime.html (20261016123810) ※1 警報第1報 (予報第17報 12:40:02.6) 全100区域
const AREAS_STEP1 = [
  '根室地方北部', '根室地方中部', '根室地方南部', '網走地方', '北見地方', '釧路地方北部',
  '紋別地方', '釧路地方中南部', '宗谷地方北部', '宗谷地方南部', '上川地方北部', '空知地方南部',
  '胆振地方中東部', '石狩地方中部', '十勝地方北部', '上川地方中部', '留萌地方中北部',
  '十勝地方中部', '北海道利尻礼文', '十勝地方南部', '上川地方南部', '留萌地方南部',
  '空知地方北部', '空知地方中部', '日高地方西部', '石狩地方北部', '日高地方東部',
  '日高地方中部', '石狩地方南部', '後志地方北部', '渡島地方東部', '胆振地方西部',
  '後志地方西部', '後志地方東部', '青森県下北', '青森県三八上北', '渡島地方北部',
  '青森県津軽北部', '岩手県内陸北部', '檜山地方', '渡島地方西部', '岩手県沿岸北部',
  '秋田県沿岸北部', '宮城県中部', '宮城県北部', '北海道奥尻島', '青森県津軽南部',
  '岩手県沿岸南部', '秋田県内陸北部', '岩手県内陸南部', '秋田県沿岸南部', '秋田県内陸南部',
  '宮城県南部', '福島県中通り', '山形県庄内', '山形県村山', '福島県浜通り',
  '山形県最上', '山形県置賜', '新潟県下越', '福島県会津', '栃木県北部',
  '新潟県佐渡', '栃木県南部', '茨城県北部', '新潟県中越', '茨城県南部',
  '群馬県北部', '千葉県北東部', '新潟県上越', '群馬県南部', '埼玉県北部',
  '埼玉県南部', '千葉県北西部', '石川県能登', '東京都２３区', '長野県北部',
  '神奈川県東部', '千葉県南部', '長野県中部', '山梨県中・西部', '埼玉県秩父',
  '東京都多摩東部', '富山県東部', '神奈川県西部', '富山県西部', '山梨県東部・富士五湖',
  '石川県加賀', '岐阜県飛騨', '静岡県東部', '静岡県伊豆', '長野県南部',
  '伊豆大島', '新島', '静岡県中部', '岐阜県美濃中西部', '三宅島',
  '神津島', '愛知県西部', '静岡県西部',
];

// 気象庁 reachtime.html ※2 警報第2報 (予報第19報 12:40:41.6) 全105区域 (福井県等追加)
const AREAS_STEP2 = [
  '根室地方北部', '根室地方南部', '網走地方', '根室地方中部', '釧路地方北部', '紋別地方',
  '北見地方', '宗谷地方北部', '宗谷地方南部', '釧路地方中南部', '上川地方北部', '留萌地方中北部',
  '十勝地方北部', '空知地方南部', '日高地方西部', '石狩地方北部', '胆振地方中東部', '石狩地方中部',
  '上川地方中部', '十勝地方中部', '北海道利尻礼文', '上川地方南部', '留萌地方南部', '空知地方北部',
  '十勝地方南部', '空知地方中部', '日高地方東部', '日高地方中部', '石狩地方南部', '後志地方北部',
  '胆振地方西部', '後志地方西部', '後志地方東部', '渡島地方東部', '渡島地方北部', '青森県下北',
  '檜山地方', '渡島地方西部', '青森県津軽北部', '青森県三八上北', '岩手県沿岸北部', '岩手県内陸北部',
  '青森県津軽南部', '秋田県沿岸北部', '宮城県中部', '宮城県北部', '北海道奥尻島', '岩手県沿岸南部',
  '秋田県内陸北部', '岩手県内陸南部', '秋田県沿岸南部', '秋田県内陸南部', '山形県庄内', '宮城県南部',
  '山形県村山', '福島県中通り', '福島県浜通り', '山形県最上', '山形県置賜', '新潟県下越',
  '福島県会津', '栃木県北部', '新潟県佐渡', '栃木県南部', '茨城県北部', '新潟県中越',
  '茨城県南部', '新潟県上越', '群馬県南部', '埼玉県北部', '埼玉県南部', '千葉県北西部',
  '石川県能登', '群馬県北部', '千葉県北東部', '東京都２３区', '長野県北部', '神奈川県東部',
  '千葉県南部', '長野県中部', '山梨県中・西部', '埼玉県秩父', '東京都多摩東部', '東京都多摩西部',
  '富山県東部', '神奈川県西部', '富山県西部', '山梨県東部・富士五湖', '石川県加賀', '岐阜県飛騨',
  '静岡県東部', '静岡県伊豆', '長野県南部', '岐阜県美濃東部', '静岡県中部', '福井県嶺北',
  '岐阜県美濃中西部', '伊豆大島', '新島', '三宅島', '神津島', '愛知県西部',
  '静岡県西部', '愛知県東部', '福井県嶺南',
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
  const t1 = Date.parse('2026-10-16T12:40:02.6+09:00');
  const t2 = Date.parse('2026-10-16T12:40:41.6+09:00');
  const t3 = Date.parse('2026-10-16T12:48:50.0+09:00');
  const health = (t) => ({
    jma: { ok: true, at: new Date(t).toISOString() },
    p2p: { ok: true, at: new Date(t).toISOString() },
  });

  // 1. 通常待機状態
  const idleSnap = {
    ...createAtlasSnapshot(t1),
    seq: 1,
    atlasIIConfig: layoutConfig,
    sourceHealth: health(t1),
  };

  // 2. 警報第1報 (予報第17報 12:40:02.6)
  const warn1 = ingestEewJson(idleSnap, 'axis', {
    EventID: '20261016123810',
    Serial: 17,
    Title: '緊急地震速報（警報）',
    ReportDateTime: '2026-10-16T12:40:02+09:00',
    OriginDateTime: '2026-10-16T12:38:00+09:00',
    Intensity: '7',
    Magnitude: 9.9,
    Flag: { is_training: false, is_final: false, is_cancel: false },
    Hypocenter: { Name: 'カムチャツカ半島付近', Coordinate: [153.4, 48.2], Depth: '140km' },
    Forecast: AREAS_STEP1.map((Name) => ({ Name, Intensity: { From: '5-', To: '7' } })),
  }, t1);
  const alarm1Snap = { ...warn1.state, seq: 2, sourceHealth: health(t1) };

  // 3. 警報第2報・続報 (予報第19報 12:40:41.6)
  const warn2 = ingestEewJson(alarm1Snap, 'axis', {
    EventID: '20261016123810',
    Serial: 19,
    Title: '緊急地震速報（警報）',
    ReportDateTime: '2026-10-16T12:40:41+09:00',
    OriginDateTime: '2026-10-16T12:38:00+09:00',
    Intensity: '7',
    Magnitude: 9.9,
    Flag: { is_training: false, is_final: false, is_cancel: false },
    Hypocenter: { Name: 'カムチャツカ半島付近', Coordinate: [153.4, 48.2], Depth: '140km' },
    Forecast: AREAS_STEP2.map((Name) => ({ Name, Intensity: { From: '5-', To: '7' } })),
  }, t2);
  const alarm2Snap = { ...warn2.state, seq: 3, sourceHealth: health(t2) };

  // 4. キャンセル報 (12:48:50.0)
  const cancelRes = ingestEewJson(alarm2Snap, 'axis', {
    EventID: '20261016123810',
    Serial: 20,
    Title: '緊急地震速報（警報）',
    ReportDateTime: '2026-10-16T12:48:50+09:00',
    OriginDateTime: '2026-10-16T12:38:00+09:00',
    Flag: { is_training: false, is_final: true, is_cancel: true },
    Hypocenter: { Name: 'カムチャツカ半島付近', Coordinate: [], Depth: '' },
    Forecast: [],
  }, t3);
  const cancelSnap = { ...cancelRes.state, seq: 4, sourceHealth: health(t3) };

  return { idleSnap, alarm1Snap, alarm2Snap, cancelSnap };
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

    await page.goto(`file:///${HTML_PATH.replace(/\\/g, '/')}`, { waitUntil: 'domcontentloaded' });
    await page.addStyleTag({ content: OVERLAY_CSS });
    await page.waitForFunction(() => typeof window.applyAtlasSnapshot === 'function');

    const states = [
      { name: 'idle', snap: snaps.idleSnap },
      { name: 'alarm1', snap: snaps.alarm1Snap },
      { name: 'alarm2', snap: snaps.alarm2Snap },
      { name: 'cancel', snap: snaps.cancelSnap },
    ];

    for (const st of states) {
      await page.evaluate((snap) => {
        window.applyAtlasSnapshot(snap);
      }, st.snap);
      await page.waitForTimeout(200);
      await page.screenshot({
        path: path.join(tmpDir, `${st.name}_rgba.png`),
        omitBackground: true,
      });
    }
  } finally {
    await browser.close();
  }

  // tools/overlay_sender.py の compose_overlay() で 1280x1440 (上:RGB / 下:Alpha輝度) に変換
  const pyCompose = `
import os, sys
from pathlib import Path
from PIL import Image
os.environ["OVERLAY_TEST_MARK"] = "0"
os.environ["OVERLAY_IDLE_MARK"] = "0"
sys.path.insert(0, ${JSON.stringify(path.join(ROOT, 'tools'))})
from overlay_sender import compose_overlay

tmp = Path(${JSON.stringify(tmpDir)})
for name in ("idle", "alarm1", "alarm2", "cancel"):
    img = Image.open(tmp / f"{name}_rgba.png")
    composed = compose_overlay(img)
    composed.save(tmp / f"{name}.png", format="PNG")
`;
  execFileSync('python', ['-c', pyCompose], { stdio: 'inherit' });
}

function generateTimelinePcm(pcmPath) {
  const pyScript = `
import sys
from pathlib import Path
sys.path.insert(0, ${JSON.stringify(path.join(ROOT, 'tools'))})
from eew_audio_stream import AudioClipCache, build_eew_audio_playlist, SAMPLE_RATE, CHANNELS, SAMPLE_WIDTH, DEFAULT_AUDIO_DIR

cache = AudioClipCache(ffmpeg="ffmpeg", sample_rate=SAMPLE_RATE)
bps = SAMPLE_RATE * CHANNELS * SAMPLE_WIDTH  # 96000 bytes/sec

def render_playlist(areas, is_update, duration_sec):
    playlist = build_eew_audio_playlist("カムチャツカ半島付近", areas, is_update=is_update)
    chunks = []
    for p, pause_ms in playlist:
        chunks.append(cache.get_pcm(p))
        chunks.append(b"\\x00" * (int(SAMPLE_RATE * pause_ms / 1000) * CHANNELS * SAMPLE_WIDTH))
    full = b"".join(chunks)
    target = int(duration_sec * bps)
    if len(full) >= target:
        return full[:target]
    return full + b"\\x00" * (target - len(full))

idle_pcm = b"\\x00" * (2 * bps)
alarm1_pcm = render_playlist(${JSON.stringify(AREAS_STEP1)}, False, 20)
alarm2_pcm = render_playlist(${JSON.stringify(AREAS_STEP2)}, True, 16)
cancel_raw = cache.get_pcm(DEFAULT_AUDIO_DIR / "phrases" / "alert_cancel.mp3")
cancel_pcm = cancel_raw[:6 * bps] + b"\\x00" * max(0, 6 * bps - len(cancel_raw))

Path(${JSON.stringify(pcmPath)}).write_bytes(idle_pcm + alarm1_pcm + alarm2_pcm + cancel_pcm)
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
        `file '${path.join(tmpDir, 'alarm1.png').replace(/\\/g, '/')}'`,
        'duration 20.0',
        `file '${path.join(tmpDir, 'alarm2.png').replace(/\\/g, '/')}'`,
        'duration 16.0',
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
      '-vf', 'fps=30,scale=out_color_matrix=bt709:out_range=tv,format=yuv420p',
      '-colorspace', 'bt709', '-color_primaries', 'bt709',
      '-color_trc', 'bt709', '-color_range', 'tv',
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
