// JMA 高頻度フィードの取得タイミング。
// フィードは毎分更新で、新しい生成分は毎分20秒頃に読めるようになる
// (気象庁の保証はないが実測・経験則。生成は分の終わりで締められ、
// 次の分の17〜20秒頃に配置される)。取得を毎分20秒に揃えると、
// 電文の検知が最大で約1分早まる。50秒の回は CDN エッジ側の
// キャッシュ差し替え遅れに対する保険で、合わせてもリクエスト数は
// 従来の30秒間隔ポーリングと同じ。
const FEED_FETCH_SECONDS = [20, 50];

// 次の取得時刻までの遅延 (ms) を返す。
function nextFeedFetchDelay(now = new Date()) {
  const base = new Date(now.getTime());
  base.setMilliseconds(0);
  for (const sec of FEED_FETCH_SECONDS) {
    const candidate = new Date(base.getTime());
    candidate.setSeconds(sec);
    if (candidate.getTime() > now.getTime()) return candidate.getTime() - now.getTime();
  }
  const next = new Date(base.getTime());
  next.setMinutes(next.getMinutes() + 1);
  next.setSeconds(FEED_FETCH_SECONDS[0]);
  return next.getTime() - now.getTime();
}

module.exports = { FEED_FETCH_SECONDS, nextFeedFetchDelay };
