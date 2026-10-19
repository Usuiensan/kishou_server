function isVolcanicEntry(entry) {
  const link = entry?.link?.href || entry?.link || entry?.id || '';
  return /(?:^|[^A-Z])(?:VFV\d{3}|VZSE40)(?:[^A-Z0-9]|$)/i.test(String(link));
}

module.exports = { isVolcanicEntry };
