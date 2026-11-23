const { formatTime } = require('./earthquake');

function toJst(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return String(value ?? '');
  const text = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(date);
  return `${text.replace(' ', 'T')}+09:00`;
}

function xmlScalar(value) {
  return typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value;
}

function mapWolfxEqEvent(event) {
  const report = event?.reports?.find((item) => item?.product === 'VXSE51');
  const observation = report?.observation;
  if (typeof event?.eventId !== 'string' || !event.eventId || report?.status !== 'issued' ||
      !report.time || !report.targetTime || !observation || observation.maxIntensity == null ||
      !Array.isArray(observation.prefs) || !Array.isArray(observation.areas)) return null;
  const prefs = observation.prefs.map((pref, index) => ({
    name: pref.name, code: xmlScalar(pref.code), maxInt: xmlScalar(pref.int),
    areas: observation.areas.filter((area) => area.pref === index).map((area) => ({
      name: area.name, code: xmlScalar(area.code), maxInt: xmlScalar(area.int), cities: [],
    })),
  }));
  const groups = {};
  for (const pref of prefs) for (const area of pref.areas) (groups[area.maxInt] ||= []).push(area.name);
  const targetDateTime = toJst(report.targetTime);
  return {
    eventId: event.eventId, reportDateTime: toJst(report.time), targetDateTime,
    originTimeFormatted: formatTime(targetDateTime), infoType: '発表', serial: null,
    infoKind: '震度速報', title: '震度速報', headline: '', comment: report.comments?.forecast || '', tsunamiWorry: null,
    isEEW: false,
    intensity: { maxInt: xmlScalar(observation.maxIntensity), maxLgInt: null, prefs, groups, cityGroups: {} },
  };
}

module.exports = { mapWolfxEqEvent };
