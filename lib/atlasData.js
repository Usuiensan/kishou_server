const { formatEarthquake, formatTsunami } = require('./formatter');
const { getAreaReading } = require('./areaRuby');

const KINDS = ['eew', 'tsunami', 'intensity', 'vertical'];
const TTL = { eew: 60_000, tsunami: 3 * 60 * 60_000, intensity: 3 * 60 * 60_000, vertical: 3 * 60 * 60_000 };
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
    } };
  } else if (kind === 'tsunami') {
    const formatted = action === 'cancel' ? null : formatTsunami(bulletin);
    payload = { lines: formatted?.lines.map(({ text }) => text) || (action === 'cancel' ? ['津波警報・注意報は解除されました。'] : []), render: { major: bulletin.tsunami?.groups?.majorTsunami || [], warning: bulletin.tsunami?.groups?.warning || [], advisory: bulletin.tsunami?.groups?.advisory || [] } };
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
  return { version: 1, updatedAt, layers: Object.fromEntries(KINDS.map((kind) => [kind, []])) };
}

function applyAtlasBulletin(snapshot, bulletin, now = Date.now()) {
  if (!snapshot || snapshot.version !== 1 || !snapshot.layers || !KINDS.every((kind) => Array.isArray(snapshot.layers[kind]))) throw new TypeError('invalid atlas snapshot');
  if (!bulletin || bulletin.version !== 1 || !KINDS.includes(bulletin.kind) || !['upsert', 'cancel'].includes(bulletin.action) || !bulletin.event?.id) throw new TypeError('invalid atlas bulletin');
  const layers = Object.fromEntries(KINDS.map((kind) => [kind, snapshot.layers[kind].filter((entry) => now - entry.receivedAt < TTL[kind])]));
  const current = layers[bulletin.kind].find((entry) => entry.event.id === String(bulletin.event.id));
  if (current) {
    const oldTime = Date.parse(current.event.publishedAt || '') || 0;
    const newTime = Date.parse(bulletin.event.publishedAt || '') || 0;
    if (newTime < oldTime || (newTime === oldTime && Number(bulletin.event.serial || 0) < Number(current.event.serial || 0))) {
      return { version: 1, updatedAt: now, layers };
    }
  }
  layers[bulletin.kind] = layers[bulletin.kind].filter((entry) => entry.event.id !== String(bulletin.event.id));
  if (bulletin.action === 'upsert') layers[bulletin.kind].push({ ...bulletin, receivedAt: now });
  for (const kind of KINDS) layers[kind].sort((a, b) => (Date.parse(b.event.publishedAt || '') || 0) - (Date.parse(a.event.publishedAt || '') || 0) || Number(b.event.serial || 0) - Number(a.event.serial || 0));
  return { version: 1, updatedAt: now, layers };
}

module.exports = { createAtlasData, createAtlasSnapshot, applyAtlasBulletin, KINDS };
