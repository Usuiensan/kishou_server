const fs = require('node:fs');
const path = require('node:path');
const { decodeHtml, removeHashtags, classifyNervStatus, isDuplicateEarthquakeSource, isExcludedNervStatus, isNervRelevantStatus } = require('../../lib/nervSource');

const limit = Math.min(Math.max(Number(process.argv[2] || 40), 1), 40);
const maxId = process.argv[3] || '';
const maxPages = Math.min(Math.max(Number(process.argv[4] || process.env.NERV_REVIEW_PAGES || 10), 1), 100);
const baseUrl = 'https://unnerv.jp';

async function main() {
  const account = await (await fetch(`${baseUrl}/api/v1/accounts/lookup?acct=UN_NERV`, { headers: { Accept: 'application/json' } })).json();
  const statuses = [];
  let cursor = maxId;
  for (let page = 0; page < maxPages; page += 1) {
    const params = new URLSearchParams({ limit: String(limit), exclude_replies: 'true', exclude_reblogs: 'false' });
    if (cursor) params.set('max_id', cursor);
    const response = await fetch(`${baseUrl}/api/v1/accounts/${account.id}/statuses?${params}`, { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`NERV statuses HTTP ${response.status}`);
    const pageStatuses = await response.json();
    if (!Array.isArray(pageStatuses) || pageStatuses.length === 0) break;
    statuses.push(...pageStatuses);
    const nextCursor = pageStatuses.at(-1)?.id;
    if (!nextCursor || nextCursor === cursor || pageStatuses.length < limit) break;
    cursor = nextCursor;
  }
  const reviewed = statuses.map((status) => ({
    id: status.id,
    created_at: status.created_at,
    url: status.url,
    visibility: status.visibility,
    category: classifyNervStatus({ ...status, content: decodeHtml(status.content) }),
    excludedByCurrentRules: !isNervRelevantStatus(status),
    exclusionReason: isExcludedNervStatus(status) ? '死去' : (isDuplicateEarthquakeSource(status) ? '既存JMA/P2P対象（地震・津波・緊急）' : (/気象警報|気象注意報|警報級|注意報/.test(decodeHtml(status.content)) ? 'レベル1〜3・気象警報級までの情報' : null)),
    tags: (status.tags || []).map((tag) => tag.name),
    content: removeHashtags(decodeHtml(status.content)),
  }));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const resultDir = path.join(__dirname, '../results');
  const jsonPath = path.join(resultDir, `nerv_archive_${stamp}.json`);
  const mdPath = path.join(resultDir, `nerv_archive_${stamp}.md`);
  fs.writeFileSync(jsonPath, JSON.stringify({ account: account.acct, fetchedAt: new Date().toISOString(), maxId: maxId || null, maxPages, scannedStatuses: statuses.length, statuses: reviewed }, null, 2));
  const markdown = reviewed.map((item) => [
    `## ${item.created_at} | ${item.category} | ${item.excludedByCurrentRules ? `除外候補: ${item.exclusionReason}` : '候補'}`,
    item.content,
    `URL: ${item.url}`,
    `タグ: ${item.tags.join(', ') || 'なし'}`,
  ].join('\n')).join('\n\n---\n\n');
  fs.writeFileSync(mdPath, `# NERV過去投稿レビュー\n\n取得件数: ${reviewed.length}\n\n${markdown}\n`);
  console.log(JSON.stringify({ count: reviewed.length, jsonPath, mdPath, oldestId: reviewed.at(-1)?.id || null }, null, 2));
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
