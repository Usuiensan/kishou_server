const DEFAULT_BASE_URL = 'https://unnerv.jp';
const DEFAULT_ACCOUNT = 'UN_NERV';
const { toUnityDisplayText } = require('./displayText');

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

function normalizeNervContent(text) {
  let normalized = removeHashtags(text);
  const tornadoHeader = normalized.match(/^【([^】]+)気象防災速報（竜巻注意）】/m);
  if (tornadoHeader) {
    const validity = normalized.match(/この情報は[^\n。]*?まで有効です[。]?/u)?.[0].replace(/。$/u, '');
    return [
      `竜巻注意情報　${tornadoHeader[1].trim()}`,
      '竜巻など突風のおそれ　安全確保を',
      validity,
    ].filter(Boolean).join('\n');
  }
  return normalized.trim();
}

function classifyNervStatus(status) {
  const text = `${status.content || ''} ${(status.tags || []).map((tag) => tag.name).join(' ')}`;
  if (/停電|電力|停電情報/.test(text)) return 'blackout';
  if (/避難|避難所|避難情報|警戒レベル/.test(text)) return 'evacuation';
  if (/運転|運休|遅延|鉄道|電車|新幹線|バス|交通|欠航|閉鎖/.test(text)) return 'transit';
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

function isTornadoAlert(status) {
  return /^【[^】]*竜巻注意[^】]*】/m.test(decodeHtml(status.content || ''));
}

function isNervRelevantStatus(status) {
  const text = decodeHtml(status.content || '');
  if (isDuplicateEarthquakeSource(status) || isExcludedNervStatus(status) || isTornadoAlert(status)) return false;
  const header = text.match(/^【([^】]+)】/)?.[1] || '';
  const highRisk = /レベル\s*[４4５5]|避難|危険|警戒区域|非常|緊急安全確保/.test(text);
  const currentHeaderRisk = /レベル\s*[４4５5]|避難指示|緊急安全確保|危険警報|警戒区域|避難所/.test(header);
  const weatherAdvisory = /気象警報|気象注意報|警報級|注意報/.test(text);
  const nationwideNews = /NHKニュース速報|ニュース速報/.test(`${header} ${text}`);
  const routineExcluded = /台風(?:第|[0-9０-９])?.*(?:実況|予報)|全般気象解説情報|気象情報|火山の状況に関する解説情報|噴火に関する火山観測報|降灰予報/.test(header);
  const volcano = /噴火|火山|降灰/.test(header);
  if ((routineExcluded || volcano) && !nationwideNews) return false;
  const futureForecast = /見込み|予想|可能性|おそれ|今後|以降|にかけて|到達する/.test(text);
  // 「避難判断水位に上る見込み」「レベル4に到達する見込み」など、
  // 現時点ではまだレベル4/5でない予測情報は通知しない。
  if (weatherAdvisory) return currentHeaderRisk;
  if (futureForecast && highRisk && !currentHeaderRisk) return false;
  // レベル1〜3相当・単なる注意報/警報級予告は対象外。ただしレベル4/5等の
  // 明示的な危険情報は、同じ投稿内に注意報文があっても対象にする。
  if (weatherAdvisory && !highRisk) return false;
  return true;
}

function normalizeStatus(status, account = DEFAULT_ACCOUNT) {
  const decodedContent = decodeHtml(status.content);
  const content = normalizeNervContent(decodedContent);
  return {
    type: 'nerv',
    id: `nerv_${status.id}`,
    source: 'nerv',
    sourceAccount: account,
    sourceUrl: status.url || status.uri || '',
    publishedAt: status.created_at,
    nervCategory: classifyNervStatus({ ...status, content: decodedContent }),
    lines: [{ text: toUnityDisplayText(content), duration: 10 }],
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
    .filter((status) => status && status.id && status.content && isNervRelevantStatus(status))
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
  isTornadoAlert,
  isNervRelevantStatus,
  normalizeStatus,
  removeHashtags,
  normalizeNervContent,
};
