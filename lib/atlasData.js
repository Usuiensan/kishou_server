const { formatEarthquake, formatTsunami } = require('./formatter');
const { getAreaReading } = require('./areaRuby');
const { buildEEWEvent, buildTsunamiSection } = require('./atlasII');

const KINDS = ['eew', 'tsunami', 'intensity', 'vertical'];
const TTL = { eew: Infinity, tsunami: Infinity, intensity: 3 * 60 * 60_000, vertical: 3 * 60 * 60_000 };
const DEFAULT_DISPLAY = { tsunamiMap: true, tsunamiLeftMap: true, tsunamiLines: true, eewHorizontal: true, eewVertical: true, earthquakeTelop: true };
const PREFECTURE_READINGS = { 栃木県: 'とちぎけん', 群馬県: 'ぐんまけん', 埼玉県: 'さいたまけん', 東京都: 'とうきょうと', 山梨県: 'やまなしけん', 長野県: 'ながのけん', 岐阜県: 'ぎふけん', 滋賀県: 'しがけん', 沖縄県: 'おきなわけん' };

function createAtlasData(kind, bulletin) {
  if (!KINDS.includes(kind)) throw new TypeError(`Unsupported atlas bulletin kind: ${kind}`);
  if (!bulletin?.eventId || !bulletin.infoType) throw new TypeError('bulletin must include eventId and infoType');
  const action = bulletin.infoType === '取消' ? 'cancel' : 'upsert';
  const event = { id: String(bulletin.eventId), publishedAt: bulletin.reportDateTime || null, serial: bulletin.serial == null ? null : Number(bulletin.serial), infoType: bulletin.infoType || null, infoKind: bulletin.infoKind || null };
  let payload;

  if (kind === 'eew') {
    const formatted = formatEarthquake(bulletin);
    const coordinate = bulletin.earthquake?.hypocenter?.coordinate?.match(/^([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)/);
    payload = { lines: formatted?.lines.map(({ text }) => text) || [], render: {
      hypocenterName: bulletin.earthquake?.hypocenter?.name || '',
      latitude: coordinate ? Number(coordinate[1]) : null,
      longitude: coordinate ? Number(coordinate[2]) : null,
      areas: (bulletin.eewAreaDetails || []).map(({ name }) => name),
    }, atlasII: buildEEWEvent(bulletin) };
  } else if (kind === 'tsunami') {
    const formatted = action === 'cancel' ? null : formatTsunami(bulletin);
    payload = { lines: formatted?.lines.map(({ text }) => text) || (action === 'cancel' ? ['津波警報・注意報は解除されました。'] : []), render: { major: bulletin.tsunami?.groups?.majorTsunami || [], warning: bulletin.tsunami?.groups?.warning || [], advisory: bulletin.tsunami?.groups?.advisory || [] }, atlasII: buildTsunamiSection(bulletin) };
  } else if (kind === 'intensity') {
    const formatted = formatEarthquake(bulletin);
    const intensity = bulletin.intensity || null;
    const cityReadings = Object.fromEntries([...new Set(Object.values(intensity?.cityGroups || {}).flat())]
      .map((name) => [name, getAreaReading(name)])
      .filter(([, reading]) => reading));
    payload = { lines: formatted?.lines.map(({ text }) => text) || [], render: intensity ? { ...intensity, cityReadings } : null };
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
  return { version: 1, updatedAt, display: { ...DEFAULT_DISPLAY }, layers: Object.fromEntries(KINDS.map((kind) => [kind, []])) };
}

function pruneAtlasSnapshot(snapshot, now = Date.now()) {
  if (!snapshot || snapshot.version !== 1 || !snapshot.layers || !KINDS.every((kind) => Array.isArray(snapshot.layers[kind]))) throw new TypeError('invalid atlas snapshot');
  const layers = Object.fromEntries(KINDS.map((kind) => [kind, snapshot.layers[kind].filter((entry) =>
    entry.action === 'cancel' ? now - entry.receivedAt < 60_000 : now - entry.receivedAt < TTL[kind])]));
  if (KINDS.every((kind) => layers[kind].length === snapshot.layers[kind].length)) return snapshot;
  return { version: 1, updatedAt: now, display: { ...DEFAULT_DISPLAY, ...snapshot.display }, layers };
}

function applyAtlasBulletin(snapshot, bulletin, now = Date.now()) {
  if (!bulletin || bulletin.version !== 1 || !KINDS.includes(bulletin.kind) || !['upsert', 'cancel'].includes(bulletin.action) || !bulletin.event?.id) throw new TypeError('invalid atlas bulletin');
  const pruned = pruneAtlasSnapshot(snapshot, now);
  const layers = Object.fromEntries(KINDS.map((kind) => [kind, [...pruned.layers[kind]]]));
  const current = layers[bulletin.kind].find((entry) => entry.event.id === String(bulletin.event.id));
  if (current) {
    const oldTime = Date.parse(current.event.publishedAt || '') || 0;
    const newTime = Date.parse(bulletin.event.publishedAt || '') || 0;
    if (newTime < oldTime || (newTime === oldTime && Number(bulletin.event.serial || 0) < Number(current.event.serial || 0))) {
      return { version: 1, updatedAt: now, display: { ...DEFAULT_DISPLAY, ...pruned.display }, layers };
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
  } else layers[bulletin.kind].push({ ...bulletin, receivedAt: now });
  for (const kind of KINDS) layers[kind].sort((a, b) => (Date.parse(b.event.publishedAt || '') || 0) - (Date.parse(a.event.publishedAt || '') || 0) || Number(b.event.serial || 0) - Number(a.event.serial || 0));
  return { version: 1, updatedAt: now, display: { ...DEFAULT_DISPLAY, ...pruned.display }, layers };
}

module.exports = { createAtlasData, createAtlasSnapshot, applyAtlasBulletin, pruneAtlasSnapshot, KINDS };
