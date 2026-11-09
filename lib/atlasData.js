const { formatEarthquake, formatTsunami } = require('./formatter');

function createAtlasData(kind, bulletin, previous = null) {
  const action = bulletin.infoType === '取消' ? 'cancel' : Number(bulletin.serial) > 1 || (previous?.kind === kind && previous?.eventId === bulletin.eventId) ? 'update' : 'normal';
  const base = { version: 1, kind, action, eventId: bulletin.eventId, serial: bulletin.serial, infoType: bulletin.infoType };

  if (kind === 'eew') {
    const formatted = formatEarthquake(bulletin);
    const coordinate = bulletin.earthquake?.hypocenter?.coordinate?.match(/^([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)/);
    return {
      ...base,
      top: formatted ? { type: formatted.type, lines: formatted.lines.map(({ text }) => text) } : null,
      eew: { visible: action !== 'cancel' && Boolean(formatted), hypocenterName: bulletin.earthquake?.hypocenter?.name || '', latitude: coordinate ? Number(coordinate[1]) : null, longitude: coordinate ? Number(coordinate[2]) : null, areas: bulletin.eewAreas || [] },
      tsunami: { visible: false, major: [], warning: [], advisory: [] },
    };
  }

  if (kind === 'tsunami') {
    const groups = action === 'cancel' ? {} : bulletin.tsunami?.groups || {};
    const formatted = action === 'cancel' ? null : formatTsunami(bulletin);
    return {
      ...base,
      top: formatted ? { type: formatted.type, lines: formatted.lines.map(({ text }) => text) } : action === 'cancel' ? { type: 'tsunami_cancel', lines: ['津波警報・注意報は解除されました。'] } : null,
      eew: { visible: false },
      tsunami: { visible: action !== 'cancel' && ['majorTsunami', 'warning', 'advisory'].some((key) => groups[key]?.length), major: groups.majorTsunami || [], warning: groups.warning || [], advisory: groups.advisory || [] },
    };
  }
  throw new TypeError(`Unsupported atlas bulletin kind: ${kind}`);
}

module.exports = { createAtlasData };
