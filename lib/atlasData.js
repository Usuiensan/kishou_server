const { formatEarthquake, formatTsunami } = require('./formatter');
const { getAreaReading } = require('./areaRuby');
const { buildEEWEvent, buildTsunamiSection } = require('./atlasII');
const { lookupEpicenterRegion } = require('./epicenterRegion');

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

function createTsunamiFrames(bulletin) {
  return (bulletin.tsunami?.forecasts || []).flatMap((forecast) => {
    const code = String(forecast.category?.code || '');
    const level = ['52', '53'].includes(code) ? 'major' : code === '51' ? 'warning' : code === '62' ? 'advisory' : '';
    if (!level) return [];
    const condition = String(forecast.firstHeight?.condition || '')
      .replace('ただちに津波来襲と予測', 'すぐ来る')
      .replace(/(?:津波到達中|既に津波到達|すでに津波到達)と推測|津波到達中と予測/, '到達か')
      .replace('すでに津波到達と予測', 'すでに到達と予測');
    return [{
      level,
      label: level === 'major' ? '大津波警報' : level === 'warning' ? '津波警報' : '津波注意報',
      additional: String(forecast.category?.kind || '').includes('追加'),
      area: forecast.area?.name || '地域不明',
      height: forecast.maxHeight || '不明',
      arrival: condition || forecast.formattedArrivalTime || '到達時刻不明',
    }];
  });
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
    payload = { lines: formatted?.lines.map(({ text }) => text) || [], render: {
      hypocenterName,
      latitude,
      longitude,
      areas: (bulletin.eewAreaDetails || []).map(({ name }) => name),
    }, atlasII: buildEEWEvent(bulletin) };
  } else if (kind === 'tsunami') {
    const formatted = action === 'cancel' ? null : formatTsunami(bulletin);
    payload = { lines: formatted?.lines.map(({ text }) => text) || (action === 'cancel' ? ['津波警報・注意報は解除されました。'] : []), notice: action === 'cancel' ? '津波警報・注意報は解除されました' : null, tsunamiFrames: action === 'cancel' ? [] : createTsunamiFrames(bulletin), render: { major: bulletin.tsunami?.groups?.majorTsunami || [], warning: bulletin.tsunami?.groups?.warning || [], advisory: bulletin.tsunami?.groups?.advisory || [] }, atlasII: buildTsunamiSection(bulletin) };
  } else if (kind === 'intensity') {
    const formatted = formatEarthquake(bulletin);
    const intensity = bulletin.intensity || null;
    const cityReadings = Object.fromEntries([...new Set(Object.values(intensity?.cityGroups || {}).flat())]
      .map((name) => [name, getAreaReading(name)])
      .filter(([, reading]) => reading));
    payload = { lines: formatted?.lines.map(({ text }) => text) || [], summaryFrames: createEarthquakeSummaryFrames(bulletin, formatted), render: intensity ? { ...intensity, cityReadings } : null };
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
