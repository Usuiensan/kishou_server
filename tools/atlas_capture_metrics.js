function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function summarizeCaptures(samples, changedFrames, measuredAtUnixMs) {
  const intervals = samples.slice(1).map((sample, index) => sample.at - samples[index].at);
  const durations = samples.map((sample) => sample.durationMs);
  const average = (values) => values.length ? Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2)) : null;
  const rounded = (value) => value === null ? null : Number(value.toFixed(2));
  const last = samples.at(-1);
  const span = samples.length > 1 ? last.at - samples[0].at : 0;
  return {
    stage: 'Chromium capture', source: 'page.locator(#stage).screenshot',
    sampleCount: samples.length, changedFrames, measuredAtUnixMs,
    lastAtUnixMs: last?.unixMs ?? null,
    fps: span > 0 ? Number(((samples.length - 1) * 1000 / span).toFixed(2)) : null,
    intervalMs: { average: average(intervals), max: rounded(intervals.length ? Math.max(...intervals) : null),
      p95: rounded(percentile(intervals, .95)) },
    durationMs: { average: average(durations), max: rounded(durations.length ? Math.max(...durations) : null),
      p95: rounded(percentile(durations, .95)) },
  };
}

module.exports = { summarizeCaptures };
