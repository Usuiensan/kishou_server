const DEFAULT_BASE_URL = 'https://unnerv.jp';
const DEFAULT_ACCOUNT = 'UN_NERV';

function decodeHtml(text) {
  return String(text || '')
    .replace(/<br\s*\/?>(?=.)/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ')
    .trim();
}

function removeHashtags(text) {
  return String(text || '')
    .replace(/(?:^|\s)#[^\s#]+/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .trim();
}

function classifyNervStatus(status) {
  const text = `${status.content || ''} ${(status.tags || []).map((tag) => tag.name).join(' ')}`;
  if (/停電|電力|停電情報/.test(text)) return 'blackout';
  if (/避難|避難所|避難情報|警戒レベル/.test(text)) return 'evacuation';
  if (/運転見合わせ|運休|遅延|鉄道|電車|新幹線|バス|交通/.test(text)) return 'transit';
  if (/ニュース|NHK|速報/.test(text)) return 'news';
  return 'other';
}

function isDuplicateEarthquakeSource(status) {
  const text = `${status.content || ''} ${(status.tags || []).map((tag) => tag.name).join(' ')}`;
  return /#?緊急|緊急地震速報|震度速報|地震情報|(?:^|[#［【\s])地震|津波|大津波警報|津波警報|津波注意報/.test(text);
}

function isExcludedNervStatus(status) {
  // 「死去」は訃報・人物ニュースとして扱い、災害・事件報道と混同しやすい
  // 「死亡」は除外しない。
  return /死去/.test(decodeHtml(status.content || ''));
}

function normalizeStatus(status, account = DEFAULT_ACCOUNT) {
  const decodedContent = decodeHtml(status.content);
  const content = removeHashtags(decodedContent);
  return {
    type: 'nerv',
    id: `nerv_${status.id}`,
    source: 'nerv',
    sourceAccount: account,
    sourceUrl: status.url || status.uri || '',
    publishedAt: status.created_at,
    nervCategory: classifyNervStatus({ ...status, content: decodedContent }),
    lines: [{ text: content, duration: 10 }],
  };
}

async function fetchNervStatuses({ fetchImpl, baseUrl = DEFAULT_BASE_URL, account = DEFAULT_ACCOUNT, sinceId = null, maxId = null, limit = 20 }) {
  const lookupUrl = `${baseUrl}/api/v1/accounts/lookup?acct=${encodeURIComponent(account)}`;
  const lookupResponse = await fetchImpl(lookupUrl, { headers: { Accept: 'application/json' } });
  if (!lookupResponse.ok) throw new Error(`NERV account lookup HTTP ${lookupResponse.status}`);
  const accountData = await lookupResponse.json();
  const params = new URLSearchParams({ limit: String(limit), exclude_replies: 'true', exclude_reblogs: 'false' });
  if (sinceId) params.set('since_id', sinceId);
  if (maxId) params.set('max_id', maxId);
  const statusesUrl = `${baseUrl}/api/v1/accounts/${accountData.id}/statuses?${params}`;
  const statusesResponse = await fetchImpl(statusesUrl, { headers: { Accept: 'application/json' } });
  if (!statusesResponse.ok) throw new Error(`NERV statuses HTTP ${statusesResponse.status}`);
  const statuses = await statusesResponse.json();
  const normalized = statuses
    .filter((status) => status && status.id && status.content && !isDuplicateEarthquakeSource(status) && !isExcludedNervStatus(status))
    .map((status) => normalizeStatus(status, account));
  normalized.latestId = statuses[0]?.id || null;
  return normalized;
}

module.exports = {
  classifyNervStatus,
  decodeHtml,
  fetchNervStatuses,
  isDuplicateEarthquakeSource,
  isExcludedNervStatus,
  normalizeStatus,
  removeHashtags,
};
