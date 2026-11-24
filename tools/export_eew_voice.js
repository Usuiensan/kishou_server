'use strict';

/**
 * VOICEVOX HTTP API を用いて緊急地震速報 (EEW) アナウンス用の
 * NHKアクセント辞書準拠 VOICEVOX プロジェクト (.vvproj) および MP3 音声パーツを一括出力するスクリプト。
 *
 * 出力構成:
 *   <outDir>/eew_voice.vvproj           全248件をまとめたプロジェクトファイル
 *   <outDir>/eew_phrases.vvproj         固定フレーズのみ (6件)
 *   <outDir>/eew_epicenters.vvproj      震央地名のみ (181件)
 *   <outDir>/eew_areas.vvproj           地域名のみ (61件)
 *   <outDir>/phrases/*.mp3              固定フレーズ MP3
 *   <outDir>/epicenters/*.mp3           震央地名 MP3
 *   <outDir>/areas/*.mp3                地域名 MP3
 *   <outDir>/manifest.json              メタデータ一覧
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

const VOICEVOX_URL = process.env.VOICEVOX_URL || 'http://127.0.0.1:50021';
const DEFAULT_SPEAKER_ID = 2; // 四国めたん（ノーマル）
const DEFAULT_OUT_DIR = path.resolve(__dirname, '..', 'telop', 'audio', 'eew');
const EPICENTER_JSON_PATH = path.resolve(__dirname, '..', 'data', 'jma_epicenter_regions.json');

const PREF_NAMES = [
  '北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県',
  '茨城県', '栃木県', '群馬県', '埼玉県', '千葉県', '東京都', '神奈川県',
  '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県', '岐阜県',
  '静岡県', '愛知県', '三重県', '滋賀県', '京都府', '大阪府', '兵庫県',
  '奈良県', '和歌山県', '鳥取県', '島根県', '岡山県', '広島県', '山口県',
  '徳島県', '香川県', '愛媛県', '高知県', '福岡県', '佐賀県', '長崎県',
  '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県',
];

const REGION_NAMES = [
  '東北', '関東', '北陸', '甲信', '東海',
  '近畿', '中国', '四国', '九州', '沖縄',
  '伊豆諸島',
];

const AREA_TTS_OVERRIDES = {
  '甲信': 'こうしん',
};

const HK4_ZONES = [
  { name: '北海道道央', ttsText: 'ほっかいどうどうおう' },
  { name: '北海道道南', ttsText: 'ほっかいどうどうなん' },
  { name: '北海道道北', ttsText: 'ほっかいどうどうほく' },
  { name: '北海道道東', ttsText: 'ほっかいどうどうとう' },
];

// VOICEVOX で誤読される震央地名の読み補正マップ
const EPICENTER_TTS_OVERRIDES = {
  '渡島地方': 'おしまちほう',
  '後志地方': 'しりべしちほう',
  '苫小牧沖': 'とまこまいおき',
  '青森県西方沖': '青森県せいほうおき',
  '新潟県下越沖': '新潟県かえつおき',
  '新潟県上中越沖': '新潟県じょうちゅうえつおき',
  '石川県西方沖': '石川県せいほうおき',
};

const FIXED_PHRASES = [
  { id: 'alert_start', text: '緊急地震速報です', ttsText: '緊急地震速報です' },
  { id: 'alert_update', text: '緊急地震速報,続報です', ttsText: '緊急地震速報、続報です' },
  { id: 'alert_warn', text: '次の地域は強い揺れに警戒してください', ttsText: '次の地域は強い揺れに警戒してください' },
  { id: 'alert_end', text: '緊急地震速報でした', ttsText: '緊急地震速報でした' },
  {
    id: 'alert_action1',
    text: '該当する地域の方がたは、倒れやすい家具などから離れ、テーブルの下などに入って身を守ってください',
    ttsText: '該当する地域の方がたは、倒れやすい家具などから離れ、テーブルの下などに入って身を守ってください',
  },
  {
    id: 'alert_action2',
    text: 'うえから落ちてくるもの、倒れてくるものに気をつけてください。',
    ttsText: 'うえから落ちてくるもの、倒れてくるものに気をつけてください。',
  },
  {
    id: 'alert_cancel',
    text: '先ほどの緊急地震速報は取り消されました。',
    ttsText: '先ほどの緊急地震速報は取り消されました。',
  },
];

// 国内・近海 (id < 930) に加えて含める遠地震央地名 ID (941: カムチャツカ半島付近)
const EXTRA_EPICENTER_IDS = new Set([941]);

const PREF_RE = new RegExp(
  '^(' + PREF_NAMES.slice().sort((a, b) => b.length - a.length).join('|') + ')(.*)$'
);

/**
 * テロップ表示 (telop/eew.html, telop/atlas-1080.html) と同じルールで震央地名を丸める。
 * 「中北部」などの複合方位接尾辞も欠けずに落とす。
 */
function headlinePlace(name) {
  const m = name.match(PREF_RE);
  if (m && m[2] && !m[2].includes('沖') && !m[2].includes('近海')) {
    return m[1];
  }
  return name.replace(/(?:中北部|中南部|中東部|中西部|北西部|北東部|南西部|南東部|東部|西部|南部|北部|中部)$/, '');
}

function buildEpicenterItems() {
  const collection = JSON.parse(fs.readFileSync(EPICENTER_JSON_PATH, 'utf8'));
  const seen = new Set();
  const items = [];
  for (const feature of collection.features || []) {
    const id = Number(feature.properties?.id);
    const rawName = feature.properties?.name;
    if (!Number.isFinite(id) || (id >= 930 && !EXTRA_EPICENTER_IDS.has(id)) || !rawName) continue;
    const place = headlinePlace(rawName);
    if (seen.has(place)) continue;
    seen.add(place);

    const ttsPlace = EPICENTER_TTS_OVERRIDES[place] || place;
    const text = `${place}で地震`;
    items.push({
      category: 'epicenters',
      id: text,
      place,
      text,
      ttsText: `${ttsPlace}で地震`,
      file: `epicenters/${text}.mp3`,
    });
  }
  return items;
}

function buildAreaItems() {
  const items = [];
  for (const name of [...PREF_NAMES, ...REGION_NAMES]) {
    items.push({
      category: 'areas',
      id: name,
      text: name,
      ttsText: AREA_TTS_OVERRIDES[name] || name,
      file: `areas/${name}.mp3`,
    });
  }
  for (const z of HK4_ZONES) {
    items.push({
      category: 'areas',
      id: z.name,
      text: z.name,
      ttsText: z.ttsText,
      file: `areas/${z.name}.mp3`,
    });
  }
  return items;
}

function buildPhraseItems() {
  return FIXED_PHRASES.map((p) => ({
    category: 'phrases',
    id: p.id,
    text: p.text,
    ttsText: p.ttsText,
    file: `phrases/${p.id}.mp3`,
  }));
}

function moraText(phrase) {
  return phrase.moras.map((m) => m.text).join('');
}

/**
 * NHK 日本語発音アクセント新辞典の基準に沿って accent_phrases のアクセント核と句境界を補正する。
 */
function applyNhkAccentFixes(item, phrases) {
  // VOICEVOX の accent は 1 以上 (平板型 [0] は moras.length で表現する)
  const heiban = (p) => { p.accent = p.moras.length; };

  // 1. 固定フレーズ
  if (item.category === 'phrases') {
    if (item.id === 'alert_start') {
      if (phrases[0] && moraText(phrases[0]) === 'キンキュウ') heiban(phrases[0]);
      if (phrases[1] && moraText(phrases[1]) === 'ジシンソクホオデス') phrases[1].accent = 5;
    } else if (item.id === 'alert_update') {
      if (phrases[0] && moraText(phrases[0]) === 'キンキュウ') heiban(phrases[0]);
      if (phrases[1] && moraText(phrases[1]) === 'ジシンソクホオ') phrases[1].accent = 5;
      if (phrases[2] && moraText(phrases[2]) === 'ゾクホオデス') phrases[2].accent = 5;
    } else if (item.id === 'alert_warn') {
      for (const p of phrases) {
        const t = moraText(p);
        if (t === 'ユレニ' || t === 'ケエカイ' || t === 'シテ') heiban(p);
      }
    } else if (item.id === 'alert_end') {
      if (phrases[0] && moraText(phrases[0]) === 'キンキュウ') heiban(phrases[0]);
      if (phrases[1] && moraText(phrases[1]) === 'ジシンソクホオデシタ') phrases[1].accent = 5;
    } else if (item.id === 'alert_cancel') {
      if (phrases[1] && moraText(phrases[1]) === 'キンキュウ') heiban(phrases[1]);
      if (phrases[2] && moraText(phrases[2]) === 'ジシンソクホオワ') phrases[2].accent = 5;
    }
    return phrases;
  }

  // 2. 地域名 (都道府県 + 地方 + 北海道4区分)
  if (item.category === 'areas') {
    if (item.id === '甲信' && phrases[0]) {
      heiban(phrases[0]);
    } else if (item.id.startsWith('北海道道')) {
      // 「北海道」(3/6) + ポーズなし2句目「道央/道南/道北/道東」(4/4) に分け、続けて発音しつつ句境界を明瞭にする
      const allMoras = phrases.flatMap((p) => p.moras);
      const hokkaidoMoras = allMoras.slice(0, 6);
      const zoneMoras = allMoras.slice(6);
      phrases = [
        {
          moras: hokkaidoMoras,
          accent: 3,
          pause_mora: null,
          is_interrogative: false,
        },
        {
          moras: zoneMoras,
          accent: zoneMoras.length,
          pause_mora: null,
          is_interrogative: false,
        },
      ];
    }
    return phrases;
  }

  // 3. 震央地名 (「〇〇で地震」)
  if (item.category === 'epicenters') {
    // 新潟県下越沖: VOICEVOX が「ニイガタケンカ」「エツオキデ」と誤分割する句境界を修正
    if (item.place === '新潟県下越沖' && phrases.length === 3 && moraText(phrases[0]) === 'ニイガタケンカ') {
      const kaMora = phrases[0].moras.pop();
      phrases[0].accent = 4;
      phrases[1].moras.unshift(kaMora);
      phrases[1].accent = 4; // カエツオ↘キデ
    }

    // 伊豆大島近海: 「イズ」「オオシマ」を1句「イズオ↘オシマ」(3/6) に結合
    if (item.place === '伊豆大島近海' && phrases.length === 4 && moraText(phrases[0]) === 'イズ' && moraText(phrases[1]) === 'オオシマ') {
      phrases = [
        {
          moras: [...phrases[0].moras, ...phrases[1].moras],
          accent: 3,
          pause_mora: phrases[1].pause_mora ?? null,
          is_interrogative: phrases[1].is_interrogative ?? false,
        },
        ...phrases.slice(2),
      ];
    }

    // 末尾「ジシン」は NHK 標準で平板
    const last = phrases[phrases.length - 1];
    if (last && moraText(last) === 'ジシン') {
      heiban(last);
    }

    // 地名部分の補正
    for (let i = 0; i < phrases.length - 1; i++) {
      const p = phrases[i];
      const t = moraText(p);

      // 「〇〇地方で」: 1句なら「〇〇チ↘ホオデ」(N-3)、単独「チホオデ」は「チホ↘オデ」(2)
      if (t === 'チホオデ') {
        p.accent = 2;
      } else if (t.endsWith('チホオデ') && t.length > 4) {
        p.accent = Math.max(1, p.moras.length - 3);
      }

      // 単独「オキデ」は平板 (例: 宮城県 沖で)
      if (t === 'オキデ') {
        heiban(p);
      }

      // 単独「キンカイデ」は平板 (例: 伊豆大島 近海で, 硫黄島 近海で)
      if (t === 'キンカイデ') {
        heiban(p);
      }

      // 日本海: NHK標準 [3] (ニホ↘ンカイ)
      if (t === 'ニホンカイデ') {
        p.accent = 3;
      }
    }
  }

  return phrases;
}

function toCamelMora(m) {
  const out = {
    text: m.text,
    vowel: m.vowel,
    vowelLength: m.vowel_length,
    pitch: m.pitch,
  };
  if (m.consonant != null) out.consonant = m.consonant;
  if (m.consonant_length != null) out.consonantLength = m.consonant_length;
  return out;
}

function toCamelAccentPhrase(p) {
  const out = {
    moras: p.moras.map(toCamelMora),
    accent: p.accent,
  };
  if (p.pause_mora) out.pauseMora = toCamelMora(p.pause_mora);
  if (p.is_interrogative) out.isInterrogative = p.is_interrogative;
  return out;
}

function toProjectAudioQuery(q) {
  return {
    accentPhrases: q.accent_phrases.map(toCamelAccentPhrase),
    speedScale: q.speedScale,
    pitchScale: q.pitchScale,
    intonationScale: q.intonationScale,
    volumeScale: q.volumeScale,
    pauseLengthScale: q.pauseLengthScale,
    prePhonemeLength: q.prePhonemeLength,
    postPhonemeLength: q.postPhonemeLength,
    outputSamplingRate: q.outputSamplingRate,
    outputStereo: q.outputStereo,
    kana: q.kana,
  };
}

async function buildQueryWithNhkAccent(item, speakerId) {
  const queryUrl = `${VOICEVOX_URL}/audio_query?speaker=${speakerId}&text=${encodeURIComponent(item.ttsText)}`;
  const qRes = await fetch(queryUrl, { method: 'POST' });
  if (!qRes.ok) {
    throw new Error(`audio_query failed (${qRes.status}): ${await qRes.text()}`);
  }
  const query = await qRes.json();

  // NHKアクセント補正を適用し、mora_pitch でピッチカーブを再計算
  const fixedPhrases = applyNhkAccentFixes(item, query.accent_phrases);
  const pitchUrl = `${VOICEVOX_URL}/mora_pitch?speaker=${speakerId}`;
  const pRes = await fetch(pitchUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(fixedPhrases),
  });
  if (!pRes.ok) {
    throw new Error(`mora_pitch failed (${pRes.status}): ${await pRes.text()}`);
  }
  query.accent_phrases = await pRes.json();
  return query;
}

async function synthesizeWavFromQuery(query, speakerId) {
  const synthUrl = `${VOICEVOX_URL}/synthesis?speaker=${speakerId}`;
  const sRes = await fetch(synthUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(query),
  });
  if (!sRes.ok) {
    throw new Error(`synthesis failed (${sRes.status}): ${await sRes.text()}`);
  }
  return Buffer.from(await sRes.arrayBuffer());
}

async function probeDurationMs(mp3Path) {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', mp3Path,
  ]);
  return Math.round(Number.parseFloat(stdout.trim()) * 1000);
}

async function convertWavToMp3(wavPath, mp3Path) {
  await execFileAsync('ffmpeg', [
    '-y',
    '-loglevel', 'error',
    '-i', wavPath,
    '-codec:a', 'libmp3lame',
    '-ar', '24000',
    '-ac', '1',
    '-b:a', '96k',
    mp3Path,
  ]);
}

function createVvproj({ appVersion, engineId, speakerUuid, styleId, entries }) {
  const audioKeys = [];
  const audioItems = {};
  for (const entry of entries) {
    const key = crypto.randomUUID();
    audioKeys.push(key);
    audioItems[key] = {
      text: entry.ttsText,
      voice: {
        engineId,
        speakerId: speakerUuid,
        styleId,
      },
      query: toProjectAudioQuery(entry.query),
    };
  }
  const trackId = crypto.randomUUID();
  return {
    appVersion,
    talk: {
      audioKeys,
      audioItems,
    },
    song: {
      tpqn: 480,
      tempos: [{ position: 0, bpm: 120 }],
      timeSignatures: [{ measureNumber: 1, beats: 4, beatType: 4 }],
      tracks: {
        [trackId]: {
          name: '無題',
          keyRangeAdjustment: 0,
          volumeRangeAdjustment: 0,
          notes: [],
          pitchEditData: [],
          volumeEditData: [],
          phonemeTimingEditData: {},
          solo: false,
          mute: false,
          gain: 1,
          pan: 0,
        },
      },
      trackOrder: [trackId],
    },
  };
}

function parseArgs(argv) {
  const opts = {
    speaker: DEFAULT_SPEAKER_ID,
    outDir: DEFAULT_OUT_DIR,
    skipMp3: false,
    concurrency: 2,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--speaker' && argv[i + 1]) opts.speaker = Number(argv[++i]);
    else if (a === '--out' && argv[i + 1]) opts.outDir = path.resolve(argv[++i]);
    else if (a === '--concurrency' && argv[i + 1]) opts.concurrency = Math.max(1, Number(argv[++i]));
    else if (a === '--skip-mp3') opts.skipMp3 = true;
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv);

  const [verRes, manifestRes, speakersRes] = await Promise.all([
    fetch(`${VOICEVOX_URL}/version`),
    fetch(`${VOICEVOX_URL}/engine_manifest`),
    fetch(`${VOICEVOX_URL}/speakers`),
  ]);
  if (!verRes.ok || !manifestRes.ok || !speakersRes.ok) {
    throw new Error(`VOICEVOX is not reachable at ${VOICEVOX_URL}`);
  }
  const version = await verRes.json();
  const engineManifest = await manifestRes.json();
  const speakers = await speakersRes.json();

  let speakerUuid = null;
  let speakerLabel = `style:${opts.speaker}`;
  for (const sp of speakers) {
    const st = sp.styles.find((s) => s.id === opts.speaker);
    if (st) {
      speakerUuid = sp.speaker_uuid;
      speakerLabel = `${sp.name}（${st.name}）`;
      break;
    }
  }
  if (!speakerUuid) {
    throw new Error(`Speaker styleId=${opts.speaker} not found in VOICEVOX`);
  }

  console.log(`VOICEVOX v${version} connected: ${speakerLabel} (styleId=${opts.speaker})`);

  const items = [
    ...buildPhraseItems(),
    ...buildEpicenterItems(),
    ...buildAreaItems(),
  ];

  for (const sub of ['phrases', 'epicenters', 'areas']) {
    fs.mkdirSync(path.join(opts.outDir, sub), { recursive: true });
  }
  const tmpDir = path.join(opts.outDir, '.tmp_wav');
  if (!opts.skipMp3) fs.mkdirSync(tmpDir, { recursive: true });

  const results = new Array(items.length);
  let completed = 0;
  let cursor = 0;

  async function worker(workerId) {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) break;
      const item = items[idx];

      const query = await buildQueryWithNhkAccent(item, opts.speaker);
      if (!opts.skipMp3) {
        const mp3Path = path.join(opts.outDir, item.file);
        const wavPath = path.join(tmpDir, `w${workerId}_${idx}.wav`);
        const wavBuffer = await synthesizeWavFromQuery(query, opts.speaker);
        fs.writeFileSync(wavPath, wavBuffer);
        await convertWavToMp3(wavPath, mp3Path);
        fs.unlinkSync(wavPath);
      }

      results[idx] = { ...item, query };
      completed++;
      if (completed % 25 === 0 || completed === items.length) {
        console.log(`Progress: ${completed}/${items.length}`);
      }
    }
  }

  try {
    await Promise.all(
      Array.from({ length: opts.concurrency }, (_, i) => worker(i))
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  // .vvproj 書き出し (全体版 + カテゴリ別3ファイル)
  const commonVvproj = {
    appVersion: String(version),
    engineId: engineManifest.uuid,
    speakerUuid,
    styleId: opts.speaker,
  };
  const vvprojTargets = [
    { name: 'eew_voice.vvproj', entries: results },
    { name: 'eew_phrases.vvproj', entries: results.filter((r) => r.category === 'phrases') },
    { name: 'eew_epicenters.vvproj', entries: results.filter((r) => r.category === 'epicenters') },
    { name: 'eew_areas.vvproj', entries: results.filter((r) => r.category === 'areas') },
  ];
  for (const t of vvprojTargets) {
    const data = createVvproj({ ...commonVvproj, entries: t.entries });
    fs.writeFileSync(path.join(opts.outDir, t.name), JSON.stringify(data), 'utf8');
  }

  // パーツ実尺の一覧 (lib/eewAudioDurations.js) を更新する。
  // EEW の状態保持時間 (アナウンス終了+10秒) の計算が使う。
  const durations = {};
  for (const r of results) {
    durations[r.file] = await probeDurationMs(path.join(opts.outDir, r.file));
  }
  const durationsPath = path.resolve(__dirname, '..', 'lib', 'eewAudioDurations.js');
  const durationsBody = '// EEW 音声パーツの実尺 (ms)。telop/audio/eew 配下の mp3 を実測した一覧で、\n'
    + '// tools/export_eew_voice.js が音声生成のたびに再生成する。手で編集しない。\n'
    + `module.exports = ${JSON.stringify(durations, null, 1)};\n`;
  fs.writeFileSync(durationsPath, durationsBody, 'utf8');
  console.log(`durations: ${durationsPath} (${Object.keys(durations).length} entries)`);

  // manifest.json 更新
  const manifestItems = results.map((r) => ({
    category: r.category,
    id: r.id,
    ...(r.place ? { place: r.place } : {}),
    text: r.text,
    ttsText: r.ttsText,
    file: r.file,
    accents: r.query.accent_phrases.map((p) => `${p.moras.map((m) => m.text).join('')}(${p.accent}/${p.moras.length})`),
  }));
  fs.writeFileSync(
    path.join(opts.outDir, 'manifest.json'),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        voicevoxVersion: version,
        speakerId: opts.speaker,
        speakerUuid,
        engineId: engineManifest.uuid,
        accentReference: 'NHK日本語発音アクセント新辞典準拠補正',
        audioFormat: { codec: 'mp3', sampleRate: 24000, channels: 1, bitrate: '96k' },
        counts: {
          total: results.length,
          phrases: results.filter((x) => x.category === 'phrases').length,
          epicenters: results.filter((x) => x.category === 'epicenters').length,
          areas: results.filter((x) => x.category === 'areas').length,
        },
        vvprojFiles: vvprojTargets.map((t) => t.name),
        items: manifestItems,
      },
      null,
      2
    ),
    'utf8'
  );

  console.log(`Done! Output: ${opts.outDir}`);
  console.log(`vvproj: ${vvprojTargets.map((t) => t.name).join(', ')}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
