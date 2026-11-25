const { formatEarthquake, formatTsunami } = require('./formatter');
const { formatTime } = require('./parsers/tsunami');
const { getAreaReading, getAreaRubyMono } = require('./areaRuby');
const { buildEEWEvent, buildTsunamiSection } = require('./atlasII');
const { lookupEpicenterRegion, lookupEpicenterReading } = require('./epicenterRegion');
const { deriveEewMaxInt, isEewAnnounceableMaxInt } = require('./eewAnnounce');
const { buildEewAudioPlaylist, playlistDurationMs } = require('./eewAudio');
const EEW_AUDIO_DURATIONS = require('./eewAudioDurations');

const KINDS = ['eew', 'tsunami', 'intensity', 'vertical'];
const TTL = { eew: 30_000, tsunami: Infinity, intensity: 3 * 60 * 60_000, vertical: 3 * 60 * 60_000 };
const NOTICE_TTL = 15_000;
// 表示・投稿に出した EEW のイベント ID の保持期間 (地震情報の表示判定で
// 「EEW が出た地震か」を引くため)。EEW 本体の保持 (最大でも取消60秒)
// よりはるかに長く、続報の地震情報が届く時間幅を覆う。
const EEW_OUTPUT_REGISTRY_TTL_MS = 24 * 60 * 60_000;
// EEW 警報級の状態保持は固定秒数ではなく、その報のアナウンス
// (音声メッセージ) が最後まで鳴り終わる時刻 + この余白で決める
// (2026-11-24 ユーザー決定)。固定 30 秒では長い最終報のアナウンスが
// 途中で打ち切られていた。
const EEW_ANNOUNCE_TAIL_MS = 10_000;

// EEW エントリの保持時間 (ms)。警報級 (音声が鳴る) は、その報の
// プレイリスト総尺 + EEW_ANNOUNCE_TAIL_MS。プレイリストは本番音声
// (tools/eew_audio_stream.py) と同じ lib/eewAudio.js の構築規則で
// 組み、実尺は lib/eewAudioDurations.js (実ファイルの実測) を使う。
// 総尺が求まらない場合と、音声の鳴らない予報級は従来の TTL.eew。
// 取消は A2 wire の cancelled Event 保持 (60秒) が別要件のため対象外。
function eewRetentionMs(bulletin, isUpdate) {
  const render = bulletin?.payload?.render;
  if (bulletin?.action !== 'upsert' || render?.isWarning !== true) return TTL.eew;
  const playlist = buildEewAudioPlaylist(
    { hypocenterName: render.hypocenterName || '', areas: render.areas || [], isCancel: false },
    { isUpdate: Boolean(isUpdate), repeatCount: 2, basePath: '' },
  );
  const duration = playlistDurationMs(playlist, EEW_AUDIO_DURATIONS);
  return duration == null ? TTL.eew : duration + EEW_ANNOUNCE_TAIL_MS;
}
const DEFAULT_DISPLAY = { tsunamiMap: true, tsunamiLeftMap: true, tsunamiLines: true, eewHorizontal: true, eewVertical: true, earthquakeTelop: true };

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
    const hypocenterName = sourceLines[0].slice('震源は'.length);
    frames.push({ lines: sourceLines, hypocenterName, hypocenterReading: lookupEpicenterReading(hypocenterName) });
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
// 上限としつつ、区域名＋区切りの合計が28字以内にも制限する。種別バッジ
// (最大の「大津波警報」5字×31px＝155px＋padding 24px＋border 8px＝
// 187px、gap 22px) を除いた区域名列は 1382.4−209＝1173.4px。本文は
// 40px、ルビは20px (モノルビ) で、本文だけなら 1173.4÷40≒29.3字分
// あるが、読みは漢字より長く (例: 北海道太平洋沿岸中部 10字→読み
// 21字)、ルビ側が幅を決める。実データ (公式サンプル全件) の全フレーム
// (19字割りで361件) を新寸法の CSS で Chromium 実レイアウト検証し、
// 29字では11フレームが列幅を最大約6.6px超えたため、はみ出し0件になる
// 28字を上限とする。単一の区域名が28字を超える場合は、その区域だけで
// 1フレームにする (区域名の途中で切らない)。
const TSUNAMI_OVERVIEW_MAX_AREAS = 6;
const TSUNAMI_OVERVIEW_MAX_CHARACTERS = 27;
// 「追加」表示と【訓練】バッジは行を右へ押し広げるため、その分だけ
// 予算を狭める (2026-11-19 実レイアウト計測: 追加あり・訓練は28字で
// はみ出し、追加-4字・訓練-4字・両方-8字で最長バッジ「大津波警報」
// でも収まることを確認)。変更フレームの区域行にはバッジも追加表示も
// 無いため、従来の28字のままにする。
const TSUNAMI_OVERVIEW_NARROW_PER_FLAG = 4;

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

function chunkTsunamiOverviewAreas(areas, maxCharacters = TSUNAMI_OVERVIEW_MAX_CHARACTERS) {
  const chunks = [];
  let chunk = [];
  let characters = 0;
  for (const name of areas) {
    const length = [...name].length + (chunk.length ? 1 : 0);
    if (chunk.length && (chunk.length >= TSUNAMI_OVERVIEW_MAX_AREAS
      || characters + length > maxCharacters)) {
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
    const maxCharacters = TSUNAMI_OVERVIEW_MAX_CHARACTERS
      - (additionalByLevel[level] ? TSUNAMI_OVERVIEW_NARROW_PER_FLAG : 0)
      - (bulletin.training ? TSUNAMI_OVERVIEW_NARROW_PER_FLAG : 0);
    for (const chunk of chunkTsunamiOverviewAreas(areasByLevel[level], maxCharacters)) {
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

function createTsunamiChangeFrames(previousForecasts, currentForecasts) {
  const previousByCode = new Map((previousForecasts || [])
    .map((forecast) => [String(forecast.area?.code || ''), tsunamiLevelOf(forecast.category?.code)])
    .filter(([code, level]) => code && level));
  const namesByPair = new Map();
  for (const forecast of currentForecasts || []) {
    const code = String(forecast.area?.code || '');
    const oldLevel = previousByCode.get(code);
    const newLevel = tsunamiLevelOf(forecast.category?.code);
    if (!oldLevel || !newLevel || TSUNAMI_LEVEL_ORDER.indexOf(oldLevel) >= TSUNAMI_LEVEL_ORDER.indexOf(newLevel)) continue;
    const key = `${oldLevel}:${newLevel}`;
    if (!namesByPair.has(key)) namesByPair.set(key, { oldLevel, newLevel, names: [] });
    namesByPair.get(key).names.push(forecast.area?.name || '地域不明');
  }
  return [...namesByPair.values()]
    .sort((a, b) => TSUNAMI_LEVEL_ORDER.indexOf(a.oldLevel) - TSUNAMI_LEVEL_ORDER.indexOf(b.oldLevel)
      || TSUNAMI_LEVEL_ORDER.indexOf(a.newLevel) - TSUNAMI_LEVEL_ORDER.indexOf(b.newLevel))
    .flatMap(({ oldLevel, newLevel, names }) =>
    chunkTsunamiOverviewAreas(names).map((chunk) => ({
      change: true,
      oldLevel,
      newLevel,
      headline: `${TSUNAMI_LEVEL_LABELS[oldLevel]}が${TSUNAMI_LEVEL_LABELS[newLevel]}に変更`,
      area: chunk.join('　'),
      areas: chunk,
      readings: areaReadingsOf(chunk),
      monoReadings: areaMonoReadingsOf(chunk),
    })));
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

// 津波観測テロップ用フレーム群。観測点 (沖合・沿岸の Station) ごとに
// 「津波観測」札+地点名 / 時刻+高さ の1フレームを作る。最大波の実測が
// ある観測点を高さの大きい順に先に並べ、第1波だけ届いている観測点は
// 到達時刻+「第1波 (押し/引き)」で後ろに続ける。回転が長くなりすぎ
// ないよう全体で12点まで。
function formatTsunamiHeight(value) {
  const meters = Number(value);
  if (!Number.isFinite(meters) || meters <= 0) return '';
  if (meters < 1) return `${Math.round(meters * 100)}cm`;
  return `${Number(meters.toFixed(1))}m`;
}

function createTsunamiObservationFrames(bulletin) {
  const stations = bulletin.tsunami?.offshoreObservations || [];
  const observed = [];
  const firstWave = [];
  for (const station of stations) {
    const name = station.name || '';
    if (!name) continue;
    const heightLabel = formatTsunamiHeight(station.maxHeight?.value);
    if (heightLabel && station.maxHeight?.formattedDateTime) {
      observed.push({
        observation: true,
        station: name,
        timeLabel: station.maxHeight.formattedDateTime,
        heightLabel,
        heightMeters: Number(station.maxHeight.value),
        readings: areaReadingsOf([name]),
        monoReadings: areaMonoReadingsOf([name]),
      });
    } else if (station.firstHeight?.formattedArrivalTime) {
      firstWave.push({
        observation: true,
        station: name,
        timeLabel: station.firstHeight.formattedArrivalTime,
        heightLabel: station.firstHeight.initial ? `第1波 ${station.firstHeight.initial}` : '第1波',
        heightMeters: 0,
        readings: areaReadingsOf([name]),
        monoReadings: areaMonoReadingsOf([name]),
      });
    }
  }
  observed.sort((a, b) => b.heightMeters - a.heightMeters);
  return [...observed, ...firstWave].slice(0, 12)
    .map(({ heightMeters, ...frame }) => frame);
}

// 長周期地震動テロップ用フレーム群。見出し (発生時刻つき) + 階級4→1の観測地点フレーム。
// 地点名は市区町村単位に丸めた名前 (市区町村ごとの最大階級) を優先し、無い電文では
// 細分区域名で代替する。
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
    const names = lg.cityGroups?.[level]?.length ? lg.cityGroups[level] : lg.groups?.[level] || [];
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
  const event = { id: String(bulletin.eventId), publishedAt: bulletin.reportDateTime || null, serial: bulletin.serial == null ? null : Number(bulletin.serial), infoType: bulletin.infoType || null, infoKind: bulletin.infoKind || null, title: bulletin.title || null, ...(bulletin.training ? { training: true } : {}), ...(kind === 'eew' && (bulletin.isFinal === true || bulletin.infoType === '最終報') ? { isFinal: true } : {}) };
  let payload;

  if (kind === 'eew') {
    const formatted = formatEarthquake(bulletin);
    // 仮定震源要素 (PLUM 法のみで震源未推定) は震源が存在しないものとして扱う:
    // ×印・震源名・M・深さの材料をここで落とし、座標からの地名補完もしない
    const hypocenterAssumed = bulletin.earthquake?.hypocenter?.assumed === true;
    const coordinate = bulletin.earthquake?.hypocenter?.coordinate?.match(/^([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)/);
    const latitude = hypocenterAssumed ? null : (coordinate ? Number(coordinate[1]) : null);
    const longitude = hypocenterAssumed ? null : (coordinate ? Number(coordinate[2]) : null);
    // 震央地名が電文に無い場合だけ、座標の包含判定で補完する（電文の地名は上書きしない）
    const hypocenterName = hypocenterAssumed ? '' : (bulletin.earthquake?.hypocenter?.name
      || lookupEpicenterRegion(latitude, longitude)?.name || '');
    const hypocenterReading = lookupEpicenterReading(hypocenterName);
    // 予報級ウィンドウの2行テキスト (報数・マグニチュード・深さ) の材料。
    // 深さは座標文字列の末尾「-20000/」 (メートル) にだけ入っている
    // (lib/formatter.js の抽出と同じ規則)。0 は「ごく浅い」。
    const magnitudeValue = Number.parseFloat(bulletin.earthquake?.magnitude);
    const depthMatch = bulletin.earthquake?.hypocenter?.coordinate?.match(/[+-](\d+)\/$/);
    payload = { lines: formatted?.lines.map(({ text }) => text) || [], render: {
      hypocenterName,
      hypocenterReading,
      latitude,
      longitude,
      areas: (bulletin.eewAreaDetails || []).map(({ name }) => name),
      // 発表基準 (lib/eewAnnounce.js) の判定材料。従来はここで捨てられて
      // おり、表示側で警報/予報の別と予想最大震度が分からなかった。
      // maxInt は JMA XML の EEW では区域別予想 (scaleTo) から導出する。
      isWarning: bulletin.isWarning === true,
      isFinal: bulletin.isFinal === true || bulletin.infoType === '最終報',
      maxInt: deriveEewMaxInt(bulletin),
      serial: bulletin.serial == null ? null : Number(bulletin.serial),
      magnitude: !hypocenterAssumed && Number.isFinite(magnitudeValue) ? magnitudeValue : null,
      depthKm: !hypocenterAssumed && depthMatch ? Math.round(Number(depthMatch[1]) / 1000) : null,
      ...(bulletin.training ? { training: true } : {}),
    }, atlasII: buildEEWEvent(bulletin) };
  } else if (kind === 'tsunami') {
    const formatted = action === 'cancel' ? null : formatTsunami(bulletin);
    payload = { lines: formatted?.lines.map(({ text }) => text) || (action === 'cancel' ? ['津波警報・注意報は解除されました。'] : []), notice: action === 'cancel' ? '津波警報・注意報は解除されました' : null, tsunamiForecasts: bulletin.tsunami?.forecasts || [], tsunamiOverviewFrames: action === 'cancel' ? [] : createTsunamiOverviewFrames(bulletin), tsunamiChangeFrames: [], tsunamiObservationFrames: action === 'cancel' ? [] : createTsunamiObservationFrames(bulletin), tsunamiFrames: action === 'cancel' ? [] : createTsunamiFrames(bulletin), render: { major: bulletin.tsunami?.groups?.majorTsunami || [], warning: bulletin.tsunami?.groups?.warning || [], advisory: bulletin.tsunami?.groups?.advisory || [] }, atlasII: buildTsunamiSection(bulletin) };
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
      ...Object.values(bulletin.lgIntensity?.cityGroups || {}).flat(),
      ...Object.values(bulletin.lgIntensity?.groups || {}).flat(),
    ];
    const cityReadings = areaReadingsOf(readingNames);
    const cityMonoReadings = areaMonoReadingsOf(readingNames);
    payload = { lines: formatted?.lines.map(({ text }) => text) || [], summaryFrames: createEarthquakeSummaryFrames(bulletin, formatted), longPeriodFrames: createLongPeriodFrames(bulletin), render: intensity ? { ...intensity, cityReadings, cityMonoReadings, ...(bulletin.training ? { training: true } : {}) } : null };
  } else {
    const intensity = bulletin.intensity;
    const level = String(intensity?.maxInt || '');
    const prefecture = intensity?.prefs?.find((item) => String(item.maxInt) === level)?.name || '';
    const place = prefecture.replace(/(?:都|府|県)$/, '');
    const rawReading = getAreaReading(prefecture) || '';
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
    layers: Object.fromEntries(KINDS.map((kind) => [kind, []])), notices: [], eewOutputEvents: {} };
}

function pruneAtlasSnapshot(snapshot, now = Date.now()) {
  if (!snapshot || snapshot.version !== 1 || !snapshot.layers || !KINDS.every((kind) => Array.isArray(snapshot.layers[kind]))) throw new TypeError('invalid atlas snapshot');
  const layers = Object.fromEntries(KINDS.map((kind) => [kind, snapshot.layers[kind].filter((entry) => {
    // EEW 警報級は受信時に確定した retentionMs (アナウンス終了+10秒) を使う。
    // retentionMs を持たない旧エントリは従来規則 (取消60秒 / その他TTL) に落とす。
    if (kind === 'eew' && entry.action !== 'cancel' && Number.isFinite(entry.retentionMs)) {
      return now - entry.receivedAt < entry.retentionMs;
    }
    return entry.action === 'cancel' ? now - entry.receivedAt < 60_000 : now - entry.receivedAt < TTL[kind];
  })]));
  const notices = (snapshot.notices || []).filter((notice) => now - notice.receivedAt < NOTICE_TTL);
  const eewOutputEvents = Object.fromEntries(Object.entries(snapshot.eewOutputEvents || {})
    .filter(([, at]) => now - at < EEW_OUTPUT_REGISTRY_TTL_MS));
  if (KINDS.every((kind) => layers[kind].length === snapshot.layers[kind].length) && notices.length === (snapshot.notices || []).length
    && Object.keys(eewOutputEvents).length === Object.keys(snapshot.eewOutputEvents || {}).length) return snapshot;
  return { ...snapshot, version: 1, updatedAt: now, display: { ...DEFAULT_DISPLAY, ...snapshot.display }, layers, notices, eewOutputEvents };
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
  // 表示基準ゲート (2026-11-24 ユーザー決定)。本番モード (testMode で
  // なく訓練でもない) のときだけ適用する。
  // - EEW: 警報級・取消 (表示中のもの)・予想最大震度が投稿基準の震度
  //   集合 (不明・4以上) のときだけ状態に入れる。一度表示した EEW の
  //   続報は予想が下がっても受け続ける。表示していない EEW の取消は
  //   状態に入れない。
  // - 地震情報 (intensity / vertical): 実震度1・2だけのものは、長周期
  //   地震動を含む場合と、その地震の EEW が表示・投稿に出た場合
  //   (eewOutputEvents) を除き、状態に入れない。表示中のイベントの
  //   続報・取消は従来どおり受ける。表示していないイベントの取消は
  //   状態に入れない。
  const gateExempt = pruned.testMode === true || bulletin.event?.training === true;
  if (!gateExempt && bulletin.kind === 'eew') {
    if (bulletin.action === 'cancel') {
      if (!current) return { ...pruned, version: 1, updatedAt: now, display: { ...DEFAULT_DISPLAY, ...pruned.display }, layers, notices };
    } else if (!current) {
      const render = bulletin.payload?.render || {};
      // maxInt は経路により数値のことがある (JMA XML 由来) ため文字列へ寄せる
      const maxInt = render.maxInt == null ? null : String(render.maxInt);
      if (render.isWarning !== true && !isEewAnnounceableMaxInt(maxInt)) {
        return { ...pruned, version: 1, updatedAt: now, display: { ...DEFAULT_DISPLAY, ...pruned.display }, layers, notices };
      }
    }
  }
  if (!gateExempt && (bulletin.kind === 'intensity' || bulletin.kind === 'vertical')) {
    if (bulletin.action === 'cancel') {
      if (!current) return { ...pruned, version: 1, updatedAt: now, display: { ...DEFAULT_DISPLAY, ...pruned.display }, layers, notices };
    } else if (!current) {
      const rawLevel = bulletin.kind === 'intensity' ? bulletin.payload?.render?.maxInt : bulletin.payload?.intensity;
      // maxInt は経路により数値のことがある (JMA XML 由来) ため文字列へ寄せる
      const level = rawLevel == null ? null : String(rawLevel);
      const hasLongPeriod = bulletin.kind === 'intensity'
        && Array.isArray(bulletin.payload?.longPeriodFrames) && bulletin.payload.longPeriodFrames.length > 0;
      const eewOutput = Boolean((pruned.eewOutputEvents || {})[String(bulletin.event.id)]);
      if ((level === '1' || level === '2') && !hasLongPeriod && !eewOutput) {
        return { ...pruned, version: 1, updatedAt: now, display: { ...DEFAULT_DISPLAY, ...pruned.display }, layers, notices };
      }
    }
  }
  layers[bulletin.kind] = layers[bulletin.kind].filter((entry) => entry.event.id !== String(bulletin.event.id));
  if (bulletin.action === 'upsert') {
    let accepted = bulletin;
    if (bulletin.kind === 'tsunami' && current?.payload?.tsunamiForecasts && bulletin.payload?.tsunamiForecasts) {
      const oldTime = Date.parse(current.event.publishedAt || '') || 0;
      const newTime = Date.parse(bulletin.event.publishedAt || '') || 0;
      const isNewer = newTime > oldTime || (newTime === oldTime && Number(bulletin.event.serial || 0) > Number(current.event.serial || 0));
      accepted = { ...accepted, payload: { ...accepted.payload,
        tsunamiChangeFrames: isNewer ? createTsunamiChangeFrames(current.payload.tsunamiForecasts, bulletin.payload.tsunamiForecasts) : [],
      } };
      if (bulletin.payload.tsunamiForecasts.length === 0 && current.payload.tsunamiForecasts.length > 0) {
        accepted = { ...accepted, payload: { ...accepted.payload,
          tsunamiForecasts: current.payload.tsunamiForecasts,
          tsunamiOverviewFrames: current.payload.tsunamiOverviewFrames,
          tsunamiFrames: current.payload.tsunamiFrames,
          render: current.payload.render,
          atlasII: current.payload.atlasII,
          tsunamiChangeFrames: [],
        } };
      }
    }
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
    layers[bulletin.kind].push({ ...accepted, receivedAt: now,
      ...(bulletin.kind === 'eew' ? { retentionMs: eewRetentionMs(accepted, Boolean(current)) } : {}) });
  } else {
    layers[bulletin.kind].push({ ...bulletin, receivedAt: now });
    if (bulletin.kind === 'tsunami') notices.push({ kind: 'tsunami', event: bulletin.event, payload: { notice: bulletin.payload?.notice || '津波警報・注意報は解除されました' }, receivedAt: now });
  }
  for (const kind of KINDS) layers[kind].sort((a, b) => (Date.parse(b.event.publishedAt || '') || 0) - (Date.parse(a.event.publishedAt || '') || 0) || Number(b.event.serial || 0) - Number(a.event.serial || 0));
  // ゲートを通って状態に入った EEW は「出た EEW」として記録し、後続の
  // 地震情報 (実震度1・2) の表示判定と、画像 Webhook 側の判定で使う。
  const eewOutputEvents = bulletin.kind === 'eew'
    ? { ...(pruned.eewOutputEvents || {}), [String(bulletin.event.id)]: now }
    : pruned.eewOutputEvents || {};
  return { ...pruned, version: 1, updatedAt: now, display: { ...DEFAULT_DISPLAY, ...pruned.display }, layers, notices, eewOutputEvents };
}

module.exports = { createAtlasData, createAtlasSnapshot, applyAtlasBulletin, pruneAtlasSnapshot, KINDS, eewRetentionMs, EEW_ANNOUNCE_TAIL_MS };
