// 緊急地震速報 (EEW) の報単位の追跡。
// P2P (556) と JMA XML 電文の両経路から届く EEW をここで一元管理し、
// 同一報の二重投稿を防ぎつつ、初回は通常投稿 (full)、続報は追加地域だけの
// 差分投稿 (delta)、追加がなければキャッシュ更新のみ (silent) と振り分ける。
// 取消は postable な経路で届いた最初のものを必ず投稿する (cancel)。

class EewTracker {
  constructor(maxEvents = 1000) {
    this.reports = new Set(); // `${eventId}_${infoType}_${reportKey}`
    this.events = new Map(); // eventId -> { seen: Set<string>, posted: boolean }
    this.maxEvents = maxEvents;
  }

  _trim() {
    while (this.reports.size > this.maxEvents) {
      this.reports.delete(this.reports.values().next().value);
    }
    while (this.events.size > this.maxEvents) {
      this.events.delete(this.events.keys().next().value);
    }
  }

  // postable: その報が投稿対象か (警報または取消)。予報など投稿対象外の報は
  // 重複登録だけ行い、地域の既出管理や投稿済みフラグには影響させない。
  // 戻り値: { action: 'full' | 'delta' | 'silent' | 'cancel' | 'skip', additionalAreas: string[] }
  accept(parsed, { postable = true } = {}) {
    if (!parsed || !parsed.eventId) return { action: 'skip', additionalAreas: [] };
    const reportKey = parsed.reportId || parsed.serial || parsed.reportTime || 'unknown-report';
    const key = `${parsed.eventId}_${parsed.infoType}_${reportKey}`;
    if (this.reports.has(key)) return { action: 'skip', additionalAreas: [] };
    this.reports.add(key);

    if (!postable) {
      this._trim();
      return { action: 'skip', additionalAreas: [] };
    }

    if (parsed.infoType === '取消') {
      this._trim();
      return { action: 'cancel', additionalAreas: [] };
    }

    const areas = Array.isArray(parsed.eewAreas) ? parsed.eewAreas : [];
    let entry = this.events.get(parsed.eventId);
    if (!entry) {
      entry = { seen: new Set(), posted: false };
      this.events.set(parsed.eventId, entry);
    }
    const additionalAreas = areas.filter((area) => !entry.seen.has(area));
    for (const area of areas) entry.seen.add(area);
    this._trim();

    if (!entry.posted) {
      entry.posted = true;
      return { action: 'full', additionalAreas };
    }
    if (additionalAreas.length > 0) {
      return { action: 'delta', additionalAreas };
    }
    return { action: 'silent', additionalAreas: [] };
  }
}

module.exports = { EewTracker };
