const areaZones = require('../protocol/atlas-ii-eew-areas-v1.json').zones;
const areaByName = new Map(areaZones.map(({ areaId, name }) => [name, areaId]));

const SCALE = { '-1': 0, 0: 1, 10: 2, 20: 3, 30: 4, 40: 5, 45: 6, 50: 7, 55: 8, 60: 9, 70: 10, 99: 11 };
const normalizedPref = (value) => String(value || '').replace(/[都府県]$/, '');

function scaleCode(value, upper = false) {
  const text = String(value ?? '').replace(/\s/g, '');
  if (['45', '46'].includes(text)) return 6;
  if (text === '50') return 7;
  if (text === '55') return 8;
  if (text === '60') return 9;
  if (text === '70') return 10;
  if (text === '5+') return 7;
  if (text === '5-') return 6;
  if (text === '6-') return 8;
  if (text === '6+') return 9;
  if (text === '7') return 10;
  if (text === '4+') return 5;
  if (text === '以上') return upper ? 11 : 0;
  return SCALE[text] ?? (/^[0-4]$/.test(text) ? Number(text) + 1 : 0);
}

function buildEEWEvent(bulletin, previous) {
  const source = [...(bulletin.eewForecastAreas || [])];
  const byName = new Set(source.map(area => area.name));
  for (const area of bulletin.eewAreaDetails || []) if (!byName.has(area.name)) source.push(area);
  const warningIds = new Set((bulletin.eewAreaDetails || []).map(area => areaByName.get(area.name)).filter(Boolean));
  const oldWarnings = new Set((previous?.areas || []).filter(a => a.areaFlags & 4).map(a => a.areaId));
  const priorComparable = !!previous;
  const cancelled = bulletin.infoType === '取消';
  const byId = new Map();
  if (!cancelled) for (const area of source) {
    const mapped = areaByName.get(area.name);
    const id = Number(area.code) || mapped;
    const mapEntry = areaZones.find(zone => zone.areaId === mapped);
    if (!mapped || (area.code && id !== mapped) ||
        (area.pref && normalizedPref(area.pref) !== normalizedPref(mapEntry?.pref))) {
      throw new Error(`unmapped JMA EEW area: ${area.pref || ''}/${area.name || ''}`);
    }
    const warning = warningIds.has(id) && bulletin.isWarning !== false;
    const issueSeconds = Math.floor(Date.parse(bulletin.reportDateTime || bulletin.reportTime || 0) / 1000) || 0;
    const arrivalSeconds = Date.parse(area.arrivalTime || '') / 1000;
    const offset = Number.isFinite(arrivalSeconds) && issueSeconds
      ? Math.max(-32767, Math.min(32767, Math.round(arrivalSeconds - issueSeconds))) : -32768;
    const arrivalKind = area.kindCode === 10 ? 1 : area.kindCode === 11 ? 2 : area.kindCode === 19 ? 3
      : offset === -32768 ? 0 : offset <= 0 ? 2 : 1;
    const areaFlags = (arrivalKind | (warning ? 4 : 0) | (warning && priorComparable && !oldWarnings.has(id) ? 8 : 0));
    byId.set(id, { areaId: id, scalePair: scaleCode(area.scaleFrom) | (scaleCode(area.scaleTo, true) << 4),
      areaFlags, arrivalOffsetSeconds: offset });
  }
  const areas = [...byId.values()].sort((a, b) => a.areaId - b.areaId);
  const warningSetComplete = !cancelled && (typeof bulletin.warningSetComplete === 'boolean' ? bulletin.warningSetComplete : (bulletin.eewAreaDetails || []).length > 0);
  const predictionSetComplete = !cancelled && (typeof bulletin.predictionSetComplete === 'boolean' ? bulletin.predictionSetComplete : (bulletin.eewForecastAreas || []).length > 0);
  const eventFlags = (cancelled ? 1 : 0) |
    (warningSetComplete ? 2 : 0) |
    (predictionSetComplete ? 4 : 0) |
    (priorComparable ? 8 : 0);
  const issueMs = Date.parse(bulletin.reportDateTime || bulletin.reportTime || '') || 0;
  const scales = areas.map(a => [a.scalePair & 15, a.scalePair >> 4]);
  return { eventId: String(bulletin.eventId || bulletin.reportId || ''), eventFlags,
    issueUnixSeconds: Math.floor(issueMs / 1000) >>> 0,
    serial: Number.isInteger(Number(bulletin.serial)) ? Math.min(65534, Number(bulletin.serial)) : 65535,
    maxScalePair: scales.length ? Math.max(...scales.map(x => x[0])) | (Math.max(...scales.map(x => x[1])) << 4) : 0,
    areas: cancelled ? [] : areas };
}

function buildTsunamiSection(bulletin) {
  const byCode = new Map(require('../protocol/atlas-ii-tsunami-areas-v1.json').zones.map((z, i) => [z.code, i]));
  const states = Array(66).fill(0);
  const forecasts = bulletin.tsunami?.forecasts || [];
  for (const item of forecasts) {
    const i = byCode.get(Number(item.area?.code));
    if (i === undefined) throw new Error(`unmapped JMA tsunami area: ${item.area?.code}/${item.area?.name}`);
    const code = String(item.category?.code);
    states[i] = ['52', '53'].includes(code) ? 3 : code === '51' ? 2 : code === '62' ? 1 : 0;
  }
  return states;
}

module.exports = { buildEEWEvent, buildTsunamiSection, scaleCode };
