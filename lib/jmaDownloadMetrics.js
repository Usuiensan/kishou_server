const JST_TIME_ZONE = 'Asia/Tokyo';

function getJstDateKey(value = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: JST_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(value));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function createJmaDownloadMetrics({ logger = console.log, logIntervalMs = 10 * 60 * 1000 } = {}) {
  let current = createSnapshot(getJstDateKey());
  let lastLoggedAt = null;

  function rollover(now = new Date()) {
    const dateKey = getJstDateKey(now);
    if (current.date !== dateKey) {
      current = createSnapshot(dateKey);
      lastLoggedAt = null;
    }
  }

  function record(kind, bytes, now = new Date()) {
    rollover(now);
    const counter = current[kind];
    if (!counter) throw new Error(`未知のJMA取得種別です: ${kind}`);
    counter.requests += 1;
    counter.bytes += Math.max(0, Number(bytes) || 0);
  }

  function snapshot(now = new Date()) {
    rollover(now);
    return JSON.parse(JSON.stringify(current));
  }

  function formatSnapshot(now = new Date()) {
    const value = snapshot(now);
    const total = {
      requests: value.feed.requests + value.detail.requests,
      bytes: value.feed.bytes + value.detail.bytes,
    };
    const formatNumber = (number) => number.toLocaleString('ja-JP');
    return [
      `📊 JMA取得量（日次累計 JST ${value.date}）`,
      `feed ${formatNumber(value.feed.requests)}件/${formatNumber(value.feed.bytes)}B`,
      `detail ${formatNumber(value.detail.requests)}件/${formatNumber(value.detail.bytes)}B`,
      `total ${formatNumber(total.requests)}件/${formatNumber(total.bytes)}B`,
    ].join(' ');
  }

  function logIfDue(now = new Date(), force = false) {
    rollover(now);
    const timestamp = new Date(now).getTime();
    if (!force && lastLoggedAt !== null && timestamp - lastLoggedAt < logIntervalMs) return false;
    logger(formatSnapshot(now));
    lastLoggedAt = timestamp;
    return true;
  }

  return { record, snapshot, formatSnapshot, logIfDue };
}

function createSnapshot(date) {
  return {
    date,
    feed: { requests: 0, bytes: 0 },
    detail: { requests: 0, bytes: 0 },
  };
}

const jmaDownloadMetrics = createJmaDownloadMetrics();

module.exports = {
  createJmaDownloadMetrics,
  getJstDateKey,
  jmaDownloadMetrics,
};
