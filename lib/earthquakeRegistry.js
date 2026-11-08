// 地震情報のイベント単位レジストリ。
// P2P (551) と JMA 電文の両経路から届く同一イベントの情報をここで突き合わせ、
// 最初に届いたものを「full」、後着は新規分だけを抽出した「delta」として返す。
// 同一内容の再送は「skip」になり、経路を問わず二重投稿を防ぐ。

const INTENSITY_RANK = {
  '1': 1, '2': 2, '3': 3, '4': 4, '5-': 5, '5+': 6, '6-': 7, '6+': 8, '7': 9,
};

function intensityRank(value) {
  return INTENSITY_RANK[String(value)] || 0;
}

// 発生時刻を分単位のキーに正規化する (P2P の "2026/11/08 01:04:00" と
// JMA の ISO 形式を同じ土俵に載せる)。
function normalizeOriginTime(value) {
  if (!value) return '';
  const text = String(value).replace(/\//g, '-').replace(' ', 'T');
  const date = new Date(text);
  if (isNaN(date.getTime())) return String(value);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date);
  const get = (type) => (parts.find((p) => p.type === type) || {}).value || '';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
}

function originTimeOf(parsed) {
  return parsed?.earthquake?.originTime || parsed?.originTime || '';
}

function hypocenterNameOf(parsed) {
  return parsed?.earthquake?.hypocenter?.name || '';
}

function eventKeyOf(parsed) {
  return `${normalizeOriginTime(originTimeOf(parsed))}|${hypocenterNameOf(parsed)}`;
}

// formatter と同じ優先順位 (市区町村レベル cityGroups > 区域レベル groups) で
// 地点名 -> 震度 の対応を作る。
function pointMapOf(parsed) {
  const intensity = parsed?.intensity || {};
  const groups = intensity.cityGroups && Object.keys(intensity.cityGroups).length > 0
    ? intensity.cityGroups
    : intensity.groups || {};
  const map = new Map();
  for (const [scale, names] of Object.entries(groups)) {
    for (const name of names || []) map.set(name, scale);
  }
  return map;
}

function groupPoints(points) {
  const groups = {};
  for (const [name, scale] of points) {
    if (!groups[scale]) groups[scale] = [];
    groups[scale].push(name);
  }
  return groups;
}

class EarthquakeRegistry {
  constructor(maxEvents = 100) {
    this.events = new Map();
    this.maxEvents = maxEvents;
  }

  keyFor(parsed) {
    return eventKeyOf(parsed);
  }

  _findEntry(parsed) {
    const origin = normalizeOriginTime(originTimeOf(parsed));
    const name = hypocenterNameOf(parsed);
    const exact = this.events.get(`${origin}|${name}`);
    if (exact) return exact;
    if (name) {
      // 震度速報など震源名が無い先行エントリを引き継ぐ
      const unnamed = this.events.get(`${origin}|`);
      if (unnamed) {
        this.events.delete(`${origin}|`);
        unnamed.name = name;
        this.events.set(`${origin}|${name}`, unnamed);
        return unnamed;
      }
      return null;
    }
    // 震源名なしの後着は、同じ発生時刻のエントリが1件だけならそれとみなす
    const sameOrigin = [...this.events.values()].filter((e) => e.origin === origin);
    return sameOrigin.length === 1 ? sameOrigin[0] : null;
  }

  // 戻り値: { action: 'full' | 'delta' | 'skip', delta: object | null }
  merge(parsed) {
    const origin = normalizeOriginTime(originTimeOf(parsed));
    const incomingPoints = pointMapOf(parsed);
    const incomingMaxRank = intensityRank(parsed?.intensity?.maxInt);
    const incomingLg = Boolean(parsed?.lgIntensity?.maxLgInt);
    const incomingComment = parsed?.comment || '';

    const entry = this._findEntry(parsed);
    if (!entry) {
      const created = {
        origin,
        name: hypocenterNameOf(parsed),
        points: new Map(incomingPoints),
        maxRank: incomingMaxRank,
        hasLg: incomingLg,
        comment: incomingComment,
      };
      this.events.set(`${origin}|${created.name}`, created);
      while (this.events.size > this.maxEvents) {
        this.events.delete(this.events.keys().next().value);
      }
      return { action: 'full', delta: null };
    }

    const newPoints = new Map();
    for (const [name, scale] of incomingPoints) {
      if (entry.points.get(name) !== scale) newPoints.set(name, scale);
    }
    const maxIncreased = incomingMaxRank > entry.maxRank;
    const newLg = incomingLg && !entry.hasLg;
    const newComment = Boolean(incomingComment) && incomingComment !== entry.comment;

    if (newPoints.size === 0 && !maxIncreased && !newLg && !newComment) {
      return { action: 'skip', delta: null };
    }

    const deltaGroups = groupPoints(newPoints);
    const delta = {
      ...parsed,
      isDelta: true,
      intensity: {
        ...(parsed.intensity || {}),
        groups: deltaGroups,
        cityGroups: deltaGroups,
      },
    };
    if (!newLg) delete delta.lgIntensity;
    if (!newComment) delta.comment = parsed.infoKind === '震度速報' ? parsed.comment : '';

    for (const [name, scale] of incomingPoints) entry.points.set(name, scale);
    entry.maxRank = Math.max(entry.maxRank, incomingMaxRank);
    entry.hasLg = entry.hasLg || incomingLg;
    if (incomingComment) entry.comment = incomingComment;

    return { action: 'delta', delta };
  }
}

module.exports = {
  EarthquakeRegistry,
  normalizeOriginTime,
  eventKeyOf,
  pointMapOf,
  intensityRank,
};
