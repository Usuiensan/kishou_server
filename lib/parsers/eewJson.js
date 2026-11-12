"use strict";

// Axis / Wolfx / ProjectBS が配信する EEW JSON を、JMA XML パーサ
// (lib/parsers/earthquake.js) と同じ内部 bulletin 形式へ変換する。
// 3源とも Zero Quake (0Quake) が受信しているものと同一の配信で、
// フィールド対応は同アプリの PROC_EEW.js の変換に合わせた。
// 訓練報は JMA 経路と同じく「通常」以外として扱い、null を返して取り込まない。

const { TARGET_EEW_AREAS, EEW_HOKKAIDO_MAPPING } = require('./earthquake');
const EEW_AREA_ZONES = require('../../protocol/atlas-ii-eew-areas-v1.json').zones;

const zoneByCode = new Map(EEW_AREA_ZONES.map((zone) => [zone.areaId, zone]));
const zoneByName = new Map(EEW_AREA_ZONES.map((zone) => [zone.name, zone]));

const shortPref = (value) => String(value || '').replace(/[都府県]$/, '');

function normalizeTime(value) {
  return typeof value === 'string' ? value.replace(/\//g, '-') : '';
}

// 震度表記ゆれ（'5弱' / '5-' / 数値コード '45'）を内部表記（'5-' 等）へ寄せる
function normalizeIntensity(value) {
  if (value == null) return null;
  const text = String(value).trim();
  const japanese = { '5弱': '5-', '5強': '5+', '6弱': '6-', '6強': '6+' };
  if (japanese[text]) return japanese[text];
  if (/^[1-7]$/.test(text) || ['5-', '5+', '6-', '6+'].includes(text)) return text;
  return { 10: '1', 20: '2', 30: '3', 40: '4', 45: '5-', 46: '5-', 50: '5+', 55: '6-', 60: '6+', 70: '7' }[text] || null;
}

// buildEEWEvent の scaleCode が読める数値コード文字列へ変換する
function intensityCode(value) {
  const normalized = normalizeIntensity(value);
  if (!normalized) return null;
  return { 1: '10', 2: '20', 3: '30', 4: '40', '5-': '45', '5+': '50', '6-': '55', '6+': '60', 7: '70' }[normalized] || null;
}

function coordinateText(latitude, longitude, depthKm) {
  const lat = Number(latitude);
  const lng = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return '';
  const format = (value) => `${value >= 0 ? '+' : '-'}${Math.abs(value)}`;
  const depth = Number(depthKm);
  return `${format(lat)}${format(lng)}${Number.isFinite(depth) && depth > 0 ? `-${Math.round(depth * 1000)}/` : ''}`;
}

// 府県予報区レベルの表示名一覧（P2P マッパと同じ規則）
function prefAreaNames(forecastAreas) {
  const names = new Set();
  for (const area of forecastAreas) {
    const pref = shortPref(area.pref);
    if (!pref) continue;
    if (EEW_HOKKAIDO_MAPPING[pref]) names.add(EEW_HOKKAIDO_MAPPING[pref]);
    else if (TARGET_EEW_AREAS.includes(pref)) names.add(pref);
  }
  return [...names];
}

function buildBulletin({ eventId, serial, reportDateTime, originTime, title, isWarning, isCancel,
  hypocenterName, latitude, longitude, depthKm, magnitude, maxIntensity, forecastAreas, warningAreas }) {
  if (eventId == null || eventId === '') return null;
  const areas = forecastAreas || [];
  return {
    status: '通常',
    title: title || '',
    headTitle: title || '',
    reportDateTime: normalizeTime(reportDateTime),
    reportTime: normalizeTime(reportDateTime),
    eventId: String(eventId),
    infoType: isCancel ? '取消' : '発表',
    serial: serial == null || serial === '' ? null : Number(serial),
    infoKind: '緊急地震速報',
    isEEW: true,
    isWarning: Boolean(isWarning),
    headline: isCancel ? '' : hypocenterName ? `${hypocenterName}で地震 強い揺れに警戒` : '強い揺れに警戒',
    eewAreas: prefAreaNames(areas),
    eewAreaDetails: (warningAreas || []).map(({ name, code }) => ({ name, code: code ?? null })),
    eewForecastAreas: areas,
    earthquake: {
      originTime: normalizeTime(originTime),
      hypocenter: {
        name: hypocenterName || '',
        coordinate: coordinateText(latitude, longitude, depthKm),
        description: '',
      },
      magnitude: magnitude == null || magnitude === '' ? 'NaN' : String(magnitude),
    },
    intensity: { maxInt: normalizeIntensity(maxIntensity) },
  };
}

// 生電文の EBI セグメント（細分区域ごとの予想震度・到達時刻・警報フラグ）を解析する。
// 形式は Zero Quake の ProjectBS / Wolfx 変換と同じ: 区域コード, 震度コード(先頭1字+上限2桁+下限2桁),
// 到達時刻 HHMMSS, フラグ(警報対象, 到達済) の4トークン組。
function parseEbiAreas(telegram, originTime) {
  if (typeof telegram !== 'string') return [];
  const segment = telegram.split('EBI ')[1];
  if (!segment) return [];
  const tokens = segment.split('ECI')[0].split('EII')[0].split(' 9999=')[0].trim().split(/\s+/);
  if (tokens.length % 4 !== 0) return [];
  const datePart = normalizeTime(originTime).slice(0, 10);
  const areas = [];
  for (let index = 0; index < tokens.length; index += 4) {
    const zone = zoneByCode.get(Number(tokens[index]));
    if (!zone) continue;
    const intensity = tokens[index + 1];
    let scaleTo = intensity.substring(1, 3);
    const scaleFrom = intensity.substring(3, 5);
    if (scaleTo === '99') scaleTo = scaleFrom;
    const time = tokens[index + 2];
    const arrivalTime = datePart && /^\d{6}$/.test(time)
      ? `${datePart}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}+09:00` : null;
    const flags = tokens[index + 3];
    areas.push({
      name: zone.name,
      pref: zone.pref || '',
      code: zone.areaId,
      scaleFrom: scaleFrom === '//' ? null : scaleFrom,
      scaleTo: scaleTo === '//' ? null : scaleTo,
      kindCode: flags.charAt(1) === '1' ? 11 : flags.charAt(0) === '1' ? 10 : 19,
      arrivalTime,
      alert: flags.charAt(0) === '1',
    });
  }
  return areas;
}

function mapAxisEew(message) {
  if (!message || typeof message !== 'object') return null;
  if (message.Flag?.is_training) return null;
  const forecastAreas = (Array.isArray(message.Forecast) ? message.Forecast : []).map((area) => {
    const zone = zoneByName.get(area.Name) || zoneByCode.get(Number(area.Code));
    if (!zone) return null;
    return {
      name: zone.name,
      pref: zone.pref || '',
      code: zone.areaId,
      scaleFrom: intensityCode(area.Intensity?.From),
      scaleTo: intensityCode(area.Intensity?.To),
      kindCode: null,
      arrivalTime: null,
    };
  }).filter(Boolean);
  const isWarning = String(message.Title || '').includes('警報');
  return buildBulletin({
    eventId: message.EventID,
    serial: message.Serial,
    reportDateTime: message.ReportDateTime,
    originTime: message.OriginDateTime,
    title: message.Title,
    isWarning,
    isCancel: Boolean(message.Flag?.is_cancel),
    hypocenterName: message.Hypocenter?.Name,
    latitude: message.Hypocenter?.Coordinate?.[1],
    longitude: message.Hypocenter?.Coordinate?.[0],
    depthKm: message.Hypocenter?.Depth != null ? Number(String(message.Hypocenter.Depth).replace(/km/i, '')) : null,
    magnitude: message.Magnitude,
    maxIntensity: message.Intensity,
    forecastAreas,
    // Axis の Forecast には区域ごとの警報フラグが無いため、警報時は全区域を警報対象として扱う
    warningAreas: isWarning ? forecastAreas : [],
  });
}

// Wolfx の WarnArea（警報対象地域の一覧）を区域配列へ変換する
function warnAreas(data) {
  if (!Array.isArray(data.WarnArea)) return [];
  const datePart = normalizeTime(data.OriginTime).slice(0, 10);
  return data.WarnArea.map((area) => {
    const zone = zoneByName.get(area.Chiiki);
    if (!zone) return null;
    const arrived = String(area.Arrive || '').includes('既に到達');
    const alert = area.Type === '警報';
    const time = String(area.Time || '');
    return {
      name: zone.name,
      pref: zone.pref || '',
      code: zone.areaId,
      scaleFrom: intensityCode(area.Shindo2),
      scaleTo: intensityCode(area.Shindo1),
      kindCode: arrived ? 11 : alert ? 10 : null,
      arrivalTime: datePart && /^\d{6}$/.test(time)
        ? `${datePart}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}+09:00` : null,
      alert,
    };
  }).filter(Boolean);
}

function mapWolfxEew(data) {
  if (!data || typeof data !== 'object' || data.type !== 'jma_eew') return null;
  if (data.isTraining) return null;
  const fromWarnArea = warnAreas(data);
  const forecastAreas = fromWarnArea.length ? fromWarnArea : parseEbiAreas(data.OriginalText, data.OriginTime);
  return buildBulletin({
    eventId: data.EventID,
    serial: data.Serial,
    reportDateTime: data.AnnouncedTime,
    originTime: data.OriginTime,
    title: data.Title,
    isWarning: Boolean(data.isWarn),
    isCancel: Boolean(data.isCancel),
    hypocenterName: data.Hypocenter,
    latitude: data.Latitude,
    longitude: data.Longitude,
    depthKm: data.Depth,
    magnitude: data.Magnitude,
    maxIntensity: data.MaxIntensity,
    forecastAreas,
    warningAreas: forecastAreas.filter((area) => area.alert),
  });
}

function mapProjectBsEew(data) {
  if (!data || typeof data !== 'object' || data.type !== 'jma_eew') return null;
  const telegramTokens = typeof data.originalTelegram === 'string' ? data.originalTelegram.split(' ') : [];
  if (telegramTokens[2] === '01' || telegramTokens[2] === '30') return null; // 訓練・試験電文
  const forecastAreas = parseEbiAreas(data.originalTelegram, data.originTime);
  return buildBulletin({
    eventId: data.eventID,
    serial: data.serial,
    reportDateTime: data.issue?.time,
    originTime: data.originTime,
    title: data.isWarn ? '緊急地震速報（警報）' : '緊急地震速報（予報）',
    isWarning: Boolean(data.isWarn),
    isCancel: Boolean(data.isCancel),
    hypocenterName: data.hypocenter?.name,
    latitude: data.hypocenter?.location?.lat,
    longitude: data.hypocenter?.location?.lng,
    depthKm: data.hypocenter?.location?.depth,
    magnitude: data.hypocenter?.magnitude,
    maxIntensity: data.maxIntensity,
    forecastAreas,
    warningAreas: forecastAreas.filter((area) => area.alert),
  });
}

const MAPPERS = { axis: mapAxisEew, wolfx: mapWolfxEew, projectbs: mapProjectBsEew };

function mapEewJson(source, data) {
  const mapper = MAPPERS[source];
  return mapper ? mapper(data) : null;
}

// WebSocket メッセージ（JSON parse 済み）を ingest への中継単位へ振り分ける。
// 戻り値: { endpoint: 'eew', source, data } | { endpoint: 'jma', xml } | { heartbeat: true } | null
function normalizeEewMessage(source, message) {
  if (!message || typeof message !== 'object') return null;
  if (source === 'axis') {
    if (message.channel === 'eew') return { endpoint: 'eew', source, data: message.message };
    if (message.channel === 'jmx-seismology' && typeof message.message === 'string') {
      return { endpoint: 'jma', xml: message.message };
    }
    return null;
  }
  if (message.type === 'heartbeat') return { heartbeat: true };
  if (message.type === 'jma_eew') return { endpoint: 'eew', source, data: message };
  return null;
}

module.exports = { mapAxisEew, mapWolfxEew, mapProjectBsEew, mapEewJson, normalizeEewMessage, parseEbiAreas };
