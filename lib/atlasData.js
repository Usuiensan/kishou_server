const { formatEarthquake, formatTsunami } = require('./formatter');
const { formatTime } = require('./parsers/tsunami');
const { getAreaReading, getAreaRubyMono } = require('./areaRuby');
const { buildEEWEvent, buildTsunamiSection } = require('./atlasII');
const { lookupEpicenterRegion } = require('./epicenterRegion');
const { deriveEewMaxInt } = require('./eewAnnounce');

const KINDS = ['eew', 'tsunami', 'intensity', 'vertical'];
const TTL = { eew: Infinity, tsunami: Infinity, intensity: 3 * 60 * 60_000, vertical: 3 * 60 * 60_000 };
const NOTICE_TTL = 15_000;
const DEFAULT_DISPLAY = { tsunamiMap: true, tsunamiLeftMap: true, tsunamiLines: true, eewHorizontal: true, eewVertical: true, earthquakeTelop: true };
const PREFECTURE_READINGS = { 栃木県: 'とちぎけん', 群馬県: 'ぐんまけん', 埼玉県: 'さいたまけん', 東京都: 'とうきょうと', 山梨県: 'やまなしけん', 長野県: 'ながのけん', 岐阜県: 'ぎふけん', 滋賀県: 'しがけん', 沖縄県: 'おきなわけん' };

function createEarthquakeSummaryFrames(bulletin, formatted) {
  const lines = formatted?.lines.map(({ text }) => text) || [];
  const eventLine = lines.find((line) => line.includes('地震がありました'));
  const maxIntensity = String(bulletin.intensity?.maxInt || '');
  if (!eventLine || !maxIntensity) return [];

  const intensityLabel = ({ '6+': '6強', '6-': '6弱', '5+': '5強', '5-': '5弱' })[maxIntensity] || maxIntensity;
  const asciiDigits = (text) => text.replace(/[０-９]/g, (digit) => String.fromCharCode(digit.charCodeAt(0) - 0xfee0));
  const clean = (text) => asciiDigits(String(text || '').replace(/<[^>]*>/g, '').trim());
  const first = clean(eventLine).replace(/ごろ\s+/, 'ごろ').replace(/\s*地震がありました\s*/, `震度${intensityLabel}`);
  const tsunamiText = bulletin.tsunamiWorry === false
    ? '津波の心配はありません'
    : bulletin.infoKind === '震度速報' || bulletin.tsunamiWorry !== true
      ? '沿岸部では念のため津波に注意'
      : '津波情報が発表されています';
  const frames = [{ lines: [first, tsunamiText] }];
  const source = lines.find((line) => line.startsWith('震源は'));
  if (source) {
    const sourceLines = source.split(/\r?\n/).map(clean);
    if (sourceLines[1]) sourceLines[1] = sourceLines[1].replace(/ {2,}/, '　');
    frames.push({ lines: sourceLines });
  }
  return frames;
}

const TSUNAMI_LEVEL_ORDER = ['major', 'warning', 'advisory'];
const TSUNAMI_LEVEL_LABELS = { major: '大津波警報', warning: '津波警報', advisory: '津波注意報' };

function tsunamiLevelOf(code) {
  const value = String(code || '');
  return ['52', '53'].includes(value) ? 'major' : value === '51' ? 'warning' : value === '62' ? 'advisory' : '';
}

// 津波の地名一覧 (初期版の出し方): 予想 (詳細) の前に、種別ごと
// (大津波警報 → 津波警報 → 津波注意報) に全対象区域をまとめて出す。
// 地名だけの内容をここで消化し、ローテーションの総時間を圧縮する。
// 区域名は種別ごとに集め、フレームに区切る。区切りは初期版の6件/行を
// 上限としつつ、区域名＋区切りの合計が18字以内にも制限する。種別バッジ
// (最大の「大津波警報」5字×58px＋padding 24px＋border 8px＝322px、gap
// 22px) を除いた区域名列は 1382.4−344＝1038.4px。本文は36px (EEW
// 見出しと同サイズ)、ルビは18px (本文との比率1:2) で、本文だけなら
// 1038.4÷36≒28.8字分
// あるが、読みは漢字より長く (例: 北海道太平洋沿岸中部 10字→読み
// 21字)、ルビ側が幅を決める。実データ (公式サンプル全件) の全フレーム
// (361件) を Chromium 実レイアウトで検証し、19字では19フレームが列幅を
// 最大約65px超えたため、はみ出し0件になる18字を上限とする (検証は
// ルビ30px時代のもの。18px化で余裕は増えるが上限は据え置く)。単一の
// 区域名が18字を超える場合は、その区域だけで1フレームにする
// (区域名の途中で切らない)。
const TSUNAMI_OVERVIEW_MAX_AREAS = 6;
const TSUNAMI_OVERVIEW_MAX_CHARACTERS = 18;

// 総ルビ用: 名前→読みのマップ (読みが引けない名前は含めない)。
const areaReadingsOf = (names) => Object.fromEntries([...new Set(names)]
  .map((name) => [name, getAreaReading(name)])
  .filter(([, reading]) => reading));

// モノルビ用: 名前→セグメント配列のマップ。分割はルビマスター
// (data/area_ruby_mono.json) の確定データだけを使い、ここでは推測しない
// (引けない名前は含めず、描画側は従来のグループルビへフォールバック)。
const areaMonoReadingsOf = (names) => Object.fromEntries([...new Set(names)]
  .map((name) => [name, getAreaRubyMono(name)])
  .filter(([, segments]) => segments));

function chunkTsunamiOverviewAreas(areas) {
  const chunks = [];
  let chunk = [];
  let characters = 0;
  for (const name of areas) {
    const length = [...name].length + (chunk.length ? 1 : 0);
    if (chunk.length && (chunk.length >= TSUNAMI_OVERVIEW_MAX_AREAS
      || characters + length > TSUNAMI_OVERVIEW_MAX_CHARACTERS)) {
      chunks.push(chunk);
      chunk = [];
      characters = 0;
    }
    chunk.push(name);
    characters += [...name].length + (chunk.length > 1 ? 1 : 0);
  }
  if (chunk.length) chunks.push(chunk);
  return chunks;
}

function createTsunamiOverviewFrames(bulletin) {
  const areasByLevel = Object.fromEntries(TSUNAMI_LEVEL_ORDER.map((level) => [level, []]));
  const additionalByLevel = Object.fromEntries(TSUNAMI_LEVEL_ORDER.map((level) => [level, false]));
  for (const forecast of bulletin.tsunami?.forecasts || []) {
    const level = tsunamiLevelOf(forecast.category?.code);
    if (!level) continue;
    areasByLevel[level].push(forecast.area?.name || '地域不明');
    additionalByLevel[level] = additionalByLevel[level]
      || String(forecast.category?.kind || '').includes('追加');
  }
  const frames = [];
  for (const level of TSUNAMI_LEVEL_ORDER) {
    for (const chunk of chunkTsunamiOverviewAreas(areasByLevel[level])) {
      frames.push({
        overview: true,
        level,
        label: TSUNAMI_LEVEL_LABELS[level],
        additional: additionalByLevel[level],
        area: chunk.join('　'),
        areas: chunk,
        readings: areaReadingsOf(chunk),
        monoReadings: areaMonoReadingsOf(chunk),
      });
    }
  }
  return frames;
}

function createTsunamiFrames(bulletin) {
  return (bulletin.tsunami?.forecasts || []).flatMap((forecast) => {
    const level = tsunamiLevelOf(forecast.category?.code);
    if (!level) return [];
    const condition = String(forecast.firstHeight?.condition || '')
      .replace('ただちに津波来襲と予測', 'すぐ来る')
      .replace(/(?:津波到達中|既に津波到達|すでに津波到達)と推測|津波到達中と予測/, '到達か')
      .replace('すでに津波到達と予測', 'すでに到達と予測');
    // 予想行のデータ有無は、フォールバック文言 ('不明' / '到達時刻不明')
    // ではなく実データで判定する。注意報では警報級の高さ文言 (巨大・高い)
    // は気象庁が高さとして述べたものではないため、高さデータなしとする。
    const heightWord = String(forecast.maxHeight || '').trim();
    const hasHeight = level === 'advisory'
      ? !['', '巨大', '高い'].includes(heightWord)
      : heightWord !== '';
    const hasArrival = condition !== ''
      || Boolean(forecast.formattedArrivalTime)
      || Boolean(forecast.firstHeight?.arrivalTime);
    return [{
      hasHeight,
      hasArrival,
      level,
      label: TSUNAMI_LEVEL_LABELS[level],
      additional: String(forecast.category?.kind || '').includes('追加'),
      area: forecast.area?.name || '地域不明',
      readings: areaReadingsOf([forecast.area?.name || '地域不明']),
      monoReadings: areaMonoReadingsOf([forecast.area?.name || '地域不明']),
      height: forecast.maxHeight || '不明',
      arrival: condition || forecast.formattedArrivalTime
        || (forecast.firstHeight?.arrivalTime ? formatTime(forecast.firstHeight.arrivalTime) : '')
        || '到達時刻不明',
    }];
  });
}

// 長周期地震動テロップ用フレーム群。見出し (発生時刻つき) + 階級4→1の観測地点フレーム。
// 地点名は観測点 (市区町村名を含む観測点名) を優先し、無い電文では細分区域名で代替する。
// 実データ確認: VXSE62 (公式サンプル・実電文とも) は IntensityStation に LgInt を持つ。
// VXSE53 の LgIntensity 要素はパーサが細分区域単位の groups までしか保持しないため区域名になる。
function createLongPeriodFrames(bulletin) {
  const lg = bulletin.lgIntensity;
  if (!lg?.maxLgInt) return [];
  const originTime = bulletin.earthquake?.originTime;
  const origin = originTime ? new Date(originTime) : null;
  if (!origin || Number.isNaN(origin.getTime())) return [];
  // OriginTime は +09:00 表記。JST の壁時計として午前/午後を作る。
  const jst = new Date(origin.getTime() + 9 * 60 * 60_000);
  const hour24 = jst.getUTCHours();
  const hour = hour24 % 12 === 0 ? 12 : hour24 % 12;
  const classFrames = [];
  for (const level of ['4', '3', '2', '1']) {
    const names = lg.stationGroups?.[level]?.length ? lg.stationGroups[level] : lg.groups?.[level] || [];
    if (names.length) classFrames.push({ type: 'class', level, names: [...names] });
  }
  if (!classFrames.length) return [];
  return [
    {
      type: 'heading',
      lines: [`${hour24 < 12 ? '午前' : '午後'}${hour}時${jst.getUTCMinutes()}分ごろの地震により`, '長周期地震動を観測しました'],
    },
    // 初期版にあった説明行。見出しの直後、階級フレームの前に1フレーム置く。
    { type: 'note', lines: ['高層のビルやタワーで大きな揺れが', '長く続いた可能性があります'] },
    ...classFrames,
  ];
}

function createAtlasData(kind, bulletin) {
  if (!KINDS.includes(kind)) throw new TypeError(`Unsupported atlas bulletin kind: ${kind}`);
  if (!bulletin?.eventId || !bulletin.infoType) throw new TypeError('bulletin must include eventId and infoType');
  const action = bulletin.infoType === '取消' ? 'cancel' : 'upsert';
  const event = { id: String(bulletin.eventId), publishedAt: bulletin.reportDateTime || null, serial: bulletin.serial == null ? null : Number(bulletin.serial), infoType: bulletin.infoType || null, infoKind: bulletin.infoKind || null };
  let payload;

  if (kind === 'eew') {
    const formatted = formatEarthquake(bulletin);
    const coordinate = bulletin.earthquake?.hypocenter?.coordinate?.match(/^([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)/);
    const latitude = coordinate ? Number(coordinate[1]) : null;
    const longitude = coordinate ? Number(coordinate[2]) : null;
    // 震央地名が電文に無い場合だけ、座標の包含判定で補完する（電文の地名は上書きしない）
    const hypocenterName = bulletin.earthquake?.hypocenter?.name
      || lookupEpicenterRegion(latitude, longitude)?.name || '';
    // 予報級ウィンドウの2行テキスト (報数・マグニチュード・深さ) の材料。
    // 深さは座標文字列の末尾「-20000/」 (メートル) にだけ入っている
    // (lib/formatter.js の抽出と同じ規則)。0 は「ごく浅い」。
    const magnitudeValue = Number.parseFloat(bulletin.earthquake?.magnitude);
    const depthMatch = bulletin.earthquake?.hypocenter?.coordinate?.match(/[+-](\d+)\/$/);
    payload = { lines: formatted?.lines.map(({ text }) => text) || [], render: {
      hypocenterName,
      latitude,
      longitude,
      areas: (bulletin.eewAreaDetails || []).map(({ name }) => name),
      // 発表基準 (lib/eewAnnounce.js) の判定材料。従来はここで捨てられて
      // おり、表示側で警報/予報の別と予想最大震度が分からなかった。
      // maxInt は JMA XML の EEW では区域別予想 (scaleTo) から導出する。
      isWarning: bulletin.isWarning === true,
      maxInt: deriveEewMaxInt(bulletin),
      serial: bulletin.serial == null ? null : Number(bulletin.serial),
      magnitude: Number.isFinite(magnitudeValue) ? magnitudeValue : null,
      depthKm: depthMatch ? Math.round(Number(depthMatch[1]) / 1000) : null,
    }, atlasII: buildEEWEvent(bulletin) };
  } else if (kind === 'tsunami') {
    const formatted = action === 'cancel' ? null : formatTsunami(bulletin);
    payload = { lines: formatted?.lines.map(({ text }) => text) || (action === 'cancel' ? ['津波警報・注意報は解除されました。'] : []), notice: action === 'cancel' ? '津波警報・注意報は解除されました' : null, tsunamiOverviewFrames: action === 'cancel' ? [] : createTsunamiOverviewFrames(bulletin), tsunamiFrames: action === 'cancel' ? [] : createTsunamiFrames(bulletin), render: { major: bulletin.tsunami?.groups?.majorTsunami || [], warning: bulletin.tsunami?.groups?.warning || [], advisory: bulletin.tsunami?.groups?.advisory || [] }, atlasII: buildTsunamiSection(bulletin) };
  } else if (kind === 'intensity') {
    const formatted = formatEarthquake(bulletin);
    const intensity = bulletin.intensity || null;
    // 総ルビ: 読みマップは震度行の市町村名 (cityGroups) だけでなく、細分
    // 区域名 (groups) と長周期の観測点名・細分区域名まで含む共通マップ。
    // モノルビのセグメントマップも同じ名前集合で用意する。
    const readingNames = [
      ...Object.values(intensity?.cityGroups || {}).flat(),
      ...Object.values(intensity?.groups || {}).flat(),
      ...Object.values(bulletin.lgIntensity?.stationGroups || {}).flat(),
      ...Object.values(bulletin.lgIntensity?.groups || {}).flat(),
    ];
    const cityReadings = areaReadingsOf(readingNames);
    const cityMonoReadings = areaMonoReadingsOf(readingNames);
    payload = { lines: formatted?.lines.map(({ text }) => text) || [], summaryFrames: createEarthquakeSummaryFrames(bulletin, formatted), longPeriodFrames: createLongPeriodFrames(bulletin), render: intensity ? { ...intensity, cityReadings, cityMonoReadings } : null };
  } else {
    const intensity = bulletin.intensity;
    const level = String(intensity?.maxInt || '');
    const prefecture = intensity?.prefs?.find((item) => String(item.maxInt) === level)?.name || '';
    const place = prefecture.replace(/(?:都|府|県)$/, '');
    const rawReading = PREFECTURE_READINGS[prefecture] || getAreaReading(prefecture) || '';
    const reading = prefecture.endsWith('県') ? rawReading.replace(/けん$/, '')
      : prefecture.endsWith('府') ? rawReading.replace(/ふ$/, '')
        : prefecture.endsWith('都') ? rawReading.replace(/と$/, '') : rawReading;
    const levelLabel = ({ '6+': '6強', '6-': '6弱', '5+': '5強', '5-': '5弱' })[level] || level;
    payload = bulletin.verticalHeadline
      ? { text: bulletin.verticalHeadline }
      : place && levelLabel
        ? { text: `${place}で震度${levelLabel}`, place, reading, intensity: levelLabel }
        : { text: bulletin.headline || bulletin.headTitle || '' };
  }

  return { version: 1, kind, action, event, payload };
}

function createAtlasSnapshot(updatedAt = 0) {
  return { version: 1, updatedAt, display: { ...DEFAULT_DISPLAY }, sourceHealth: { jma: null, p2p: null },
    layers: Object.fromEntries(KINDS.map((kind) => [kind, []])), notices: [] };
}

function pruneAtlasSnapshot(snapshot, now = Date.now()) {
  if (!snapshot || snapshot.version !== 1 || !snapshot.layers || !KINDS.every((kind) => Array.isArray(snapshot.layers[kind]))) throw new TypeError('invalid atlas snapshot');
  const layers = Object.fromEntries(KINDS.map((kind) => [kind, snapshot.layers[kind].filter((entry) =>
    entry.action === 'cancel' ? now - entry.receivedAt < 60_000 : now - entry.receivedAt < TTL[kind])]));
  const notices = (snapshot.notices || []).filter((notice) => now - notice.receivedAt < NOTICE_TTL);
  if (KINDS.every((kind) => layers[kind].length === snapshot.layers[kind].length) && notices.length === (snapshot.notices || []).length) return snapshot;
  return { ...snapshot, version: 1, updatedAt: now, display: { ...DEFAULT_DISPLAY, ...snapshot.display }, layers, notices };
}

function applyAtlasBulletin(snapshot, bulletin, now = Date.now()) {
  if (!bulletin || bulletin.version !== 1 || !KINDS.includes(bulletin.kind) || !['upsert', 'cancel'].includes(bulletin.action) || !bulletin.event?.id) throw new TypeError('invalid atlas bulletin');
  const pruned = pruneAtlasSnapshot(snapshot, now);
  const layers = Object.fromEntries(KINDS.map((kind) => [kind, [...pruned.layers[kind]]]));
  let notices = [...(pruned.notices || [])].filter((notice) => !(notice.kind === bulletin.kind && notice.event.id === String(bulletin.event.id)));
  const current = layers[bulletin.kind].find((entry) => entry.event.id === String(bulletin.event.id));
  if (current) {
    const oldTime = Date.parse(current.event.publishedAt || '') || 0;
    const newTime = Date.parse(bulletin.event.publishedAt || '') || 0;
    if (newTime < oldTime || (newTime === oldTime && Number(bulletin.event.serial || 0) < Number(current.event.serial || 0))) {
      return { ...pruned, version: 1, updatedAt: now, display: { ...DEFAULT_DISPLAY, ...pruned.display }, layers, notices };
    }
  }
  layers[bulletin.kind] = layers[bulletin.kind].filter((entry) => entry.event.id !== String(bulletin.event.id));
  if (bulletin.action === 'upsert') {
    let accepted = bulletin;
    if (bulletin.kind === 'eew' && current?.payload?.atlasII && bulletin.payload?.atlasII) {
      const nextEvent = { ...bulletin.payload.atlasII };
      const previous = current.payload.atlasII;
      const sameReport = String(current.event.serial ?? '') === String(bulletin.event.serial ?? '') &&
        (Date.parse(current.event.publishedAt || '') || 0) === (Date.parse(bulletin.event.publishedAt || '') || 0);
      if (sameReport) nextEvent.areas = previous.areas.map((area) => ({ ...area }));
      const comparable = !!(previous?.eventFlags & 2);
      const warned = new Set((previous?.areas || []).filter((area) => area.areaFlags & 4).map((area) => area.areaId));
      nextEvent.eventFlags = (nextEvent.eventFlags & ~8) | (sameReport ? previous.eventFlags & 8 : comparable ? 8 : 0);
      if (!sameReport) nextEvent.areas = nextEvent.areas.map((area) => ({ ...area,
        areaFlags: (area.areaFlags & ~8) | (comparable && (area.areaFlags & 4) && !warned.has(area.areaId) ? 8 : 0),
      }));
      accepted = { ...bulletin, payload: { ...bulletin.payload, atlasII: nextEvent } };
    }
    layers[bulletin.kind].push({ ...accepted, receivedAt: now });
  } else {
    layers[bulletin.kind].push({ ...bulletin, receivedAt: now });
    if (bulletin.kind === 'tsunami') notices.push({ kind: 'tsunami', event: bulletin.event, payload: { notice: bulletin.payload?.notice || '津波警報・注意報は解除されました' }, receivedAt: now });
  }
  for (const kind of KINDS) layers[kind].sort((a, b) => (Date.parse(b.event.publishedAt || '') || 0) - (Date.parse(a.event.publishedAt || '') || 0) || Number(b.event.serial || 0) - Number(a.event.serial || 0));
  return { ...pruned, version: 1, updatedAt: now, display: { ...DEFAULT_DISPLAY, ...pruned.display }, layers, notices };
}

module.exports = { createAtlasData, createAtlasSnapshot, applyAtlasBulletin, pruneAtlasSnapshot, KINDS };
