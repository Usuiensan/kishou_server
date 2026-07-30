const DISCORD_MESSAGE_LIMIT = 1900;
const DISCORD_AREA_SEPARATOR = '　';
const DISCORD_PRINT_LINE_WIDTH = 32;
const DISCORD_SEND_INTERVAL_MS = Math.max(250, Number(process.env.DISCORD_SEND_INTERVAL_MS || 1500));
const { toFullwidthDigits } = require('./displayText');
const { getAreaReading } = require('./areaRuby');
let nextDiscordSendAt = 0;

async function waitForDiscordSend() {
  const now = Date.now();
  const waitMs = Math.max(0, nextDiscordSendAt - now);
  nextDiscordSendAt = Math.max(now, nextDiscordSendAt) + DISCORD_SEND_INTERVAL_MS;
  if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
}

// Unity向けのリッチテキストをDiscordのMarkdownへ変換する。
function toDiscordMarkdown(value) {
  return String(value || '')
    .replace(/<size=50%><voffset=[^>]*>.*?<\/voffset><\/size>/gi, '')
    .replace(/<color(?:=[^>]*)?>/gi, '**')
    .replace(/<\/color>/gi, '**')
    .replace(/<u>/gi, '__')
    .replace(/<\/u>/gi, '__')
    .replace(/<nobr>/gi, '')
    .replace(/<\/nobr>/gi, '')
    .replace(/<space(?:=[^>]*)?>/gi, '')
    .replace(/<(?:align|indent|voffset|size|b|i|s)(?:=[^>]*)?>/gi, '')
    .replace(/<\/(?:align|indent|voffset|size|b|i|s)>/gi, '')
    .replace(/<br\s*\/?>(?=.)/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\*{4}/g, '**')
    .trim();
}

function getDiscordDisplayWidth(value) {
  const text = String(value || '').replace(/(?:\*\*|__)/g, '');
  let width = 0;
  for (const character of text) {
    width += /[\uFF61-\uFF9F]/u.test(character) || /[\x00-\x7F]/u.test(character) ? 1 : 2;
  }
  return width;
}

function getAreaReadingForDisplay(area) {
  return getAreaReading(area) || '?';
}

function wrapAreaPairs(prefix, areas, lineLimit = DISCORD_PRINT_LINE_WIDTH) {
  if (areas.length === 0) return [prefix];

  const chunks = [];
  let currentAreas = [];
  let currentKanji = prefix;
  let currentKana = '';

  const flush = () => {
    if (currentAreas.length === 0) {
      chunks.push([currentKanji.trimEnd(), '']);
    } else {
      chunks.push([currentKanji, currentKana]);
    }
    currentAreas = [];
    currentKanji = '';
    currentKana = '';
  };

  for (const area of areas) {
    const reading = getAreaReadingForDisplay(area);
    const nextKanji = currentAreas.length > 0
      ? `${currentKanji}${DISCORD_AREA_SEPARATOR}${area}`
      : `${currentKanji}${area}`;
    const nextKana = currentAreas.length > 0
      ? `${currentKana}${DISCORD_AREA_SEPARATOR}${reading}`
      : reading;
    const exceeds = currentAreas.length > 0
      && (getDiscordDisplayWidth(nextKanji) > lineLimit || getDiscordDisplayWidth(nextKana) > lineLimit);

    if (exceeds) flush();

    if (currentAreas.length === 0 && currentKanji === prefix && getDiscordDisplayWidth(`${prefix}${area}`) > lineLimit) {
      chunks.push([prefix.trimEnd(), '']);
      currentKanji = '';
    }

    currentAreas.push(area);
    currentKanji = currentAreas.length === 1 ? `${currentKanji}${area}` : `${currentKanji}${DISCORD_AREA_SEPARATOR}${area}`;
    currentKana = currentAreas.length === 1 ? reading : `${currentKana}${DISCORD_AREA_SEPARATOR}${reading}`;
  }
  if (currentAreas.length > 0) flush();

  return chunks.flatMap(([kanji, kana]) => kana ? [kanji, kana] : [kanji]);
}

function formatLinesForDebug(formatted) {
  const sourceLines = (formatted.lines || [])
    .map((line) => toDiscordMarkdown(typeof line === 'string' ? line : line.text))
    .filter(Boolean);
  const lines = [];
  const intensityLines = new Map();
  const longPeriodLines = new Map();
  let pendingLegacyLongPeriodKey = null;

  for (const line of sourceLines) {
    const legacyLongPeriodMatch = line.match(/^【長周期地震動　階級([1-4１-４])】$/);
    if (legacyLongPeriodMatch) {
      pendingLegacyLongPeriodKey = `階級${String(legacyLongPeriodMatch[1]).replace(/[１-４]/g, (value) => String('１２３４'.indexOf(value) + 1))}`;
      continue;
    }
    const match = line.match(/^__?震度([7654321７６５４３２１]|5弱|5強|6弱|6強)__?\s*(.*)$/);
    const longPeriodMatch = line.match(/^\*\*階級([1-4１-４])：\*\*\s*(.*)$/);
    if (longPeriodMatch) {
      const key = `階級${String(longPeriodMatch[1]).replace(/[１-４]/g, (value) => String('１２３４'.indexOf(value) + 1))}`;
      const areaText = longPeriodMatch[2].trim().split(/\s+/).filter(Boolean);
      if (!longPeriodLines.has(key)) longPeriodLines.set(key, []);
      longPeriodLines.get(key).push(...areaText);
      continue;
    }
    if (pendingLegacyLongPeriodKey) {
      const areaText = line.trim().split(/\s+/).filter(Boolean);
      if (!longPeriodLines.has(pendingLegacyLongPeriodKey)) longPeriodLines.set(pendingLegacyLongPeriodKey, []);
      longPeriodLines.get(pendingLegacyLongPeriodKey).push(...areaText);
      pendingLegacyLongPeriodKey = null;
      continue;
    }
    if (!match) {
      lines.push(line);
      continue;
    }
    const key = `震度${match[1]}`;
    const numericIntensity = Number(String(match[1]).replace(/[５]/g, '5').replace(/[６]/g, '6').replace(/[７]/g, '7').replace(/[４]/g, '4').replace(/[３]/g, '3').replace(/[２]/g, '2').replace(/[１]/g, '1'));
    if (Number.isFinite(numericIntensity) && numericIntensity < 1) continue;
    const areas = match[2].trim().split(/\s+/).filter(Boolean);
    if (!intensityLines.has(key)) intensityLines.set(key, []);
    intensityLines.get(key).push(...areas);
  }

  if (intensityLines.size > 0) {
    const firstIntensityIndex = lines.length;
    const compact = [];
    for (const [key, areas] of intensityLines.entries()) {
      const prefix = `**${key}**`;
      compact.push(prefix, ...wrapAreaPairs('', areas));
    }
    lines.splice(firstIntensityIndex, 0, ...compact);
  }

  if (longPeriodLines.size > 0) {
    const compact = [...longPeriodLines.entries()]
      .flatMap(([key, areas]) => [`**【長周期地震動】${key}**：`, ...wrapAreaPairs('', areas)]);
    lines.push(...compact);
  }

  return lines.join('\n');
}

function splitDiscordMessage(text, limit = DISCORD_MESSAGE_LIMIT) {
  const chunks = [];
  for (let i = 0; i < text.length; i += limit) {
    chunks.push(text.slice(i, i + limit));
  }
  return chunks;
}

function splitDiscordMessageByLines(text, limit = DISCORD_MESSAGE_LIMIT) {
  const chunks = [];
  let current = '';
  for (const line of text.split('\n')) {
    const candidate = current ? `${current}\n${line}` : line;
    if (current && candidate.length > limit) {
      chunks.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks.length > 0 ? chunks : [''];
}

function toHalfwidthDigits(value) {
  return String(value ?? '').replace(/[０-９]/g, (digit) => (
    String.fromCharCode(digit.charCodeAt(0) - 0xfee0)
  ));
}

function wrapTextAtSpaces(value, lineLimit = DISCORD_PRINT_LINE_WIDTH) {
  return String(value || '').split('\n').flatMap((line) => {
    const words = line.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return [''];
    const wrapped = [];
    let current = '';
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (current && getDiscordDisplayWidth(candidate) > lineLimit) {
        wrapped.push(current);
        current = word;
      } else {
        current = candidate;
      }
    }
    if (current) wrapped.push(current);
    return wrapped;
  }).join('\n');
}

function formatJstTime(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '不明';
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
    hourCycle: 'h23',
  }).format(date);
}

function buildDiscordDebugMessage(formatted) {
  let body = formatLinesForDebug(formatted);
  if (formatted.source === 'nerv') {
    // body = [`【NERV防災・${formatted.nervCategory || 'その他'}】`, body].filter(Boolean).join('\n');
  }
  if (formatted.isEEW && formatted.eewHeadline) {
    const areas = (formatted.eewAreas || []).filter(Boolean);
    const additionalSet = new Set((formatted.eewAdditionalAreas || []).filter(Boolean));
    const primaryAreas = areas.filter((area) => !additionalSet.has(area));
    const additionalAreas = areas.filter((area) => additionalSet.has(area));
    body = [
      '緊急地震速報',
      `${toDiscordMarkdown(formatted.eewHeadline)}：`,
      ...wrapAreaPairs('', primaryAreas),
      ...(additionalAreas.length > 0 ? wrapAreaPairs('追加：', additionalAreas) : []),
    ].filter(Boolean).join('\n');
  }
  const sourceLabel = formatted.source === 'nerv' ? 'mastodon' : 'jma';
  const sourceTimestamp = formatted.sourceTimestamp || formatted.publishedAt || formatted.reportDateTime || formatted.timestamp;
  const sentTimestamp = formatted.sentTimestamp || new Date().toISOString();
  const metadata = `-# ${sourceLabel} 情報源 ${formatJstTime(sourceTimestamp)} / 送出 ${formatJstTime(sentTimestamp)}`;
  const displayBody = formatted.source === 'nerv' && formatted.nervCategory === 'news'
    ? wrapTextAtSpaces(toHalfwidthDigits(body))
    : toFullwidthDigits(body);
  return `${displayBody}${displayBody ? '\n\n' : ''}${metadata}`;
}

async function readResponseBody(response) {
  try {
    return (await response.text()).slice(0, 500);
  } catch (_) {
    return '';
  }
}

async function sendDiscordDebugMessage(formatted, { webhookUrl, fetchImpl, logger = console }) {
  if (!webhookUrl) {
    return { sent: false, reason: 'disabled' };
  }

  const chunks = splitDiscordMessageByLines(buildDiscordDebugMessage(formatted));

  try {
    for (let index = 0; index < chunks.length; index += 1) {
      let response;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        await waitForDiscordSend();
        response = await fetchImpl(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: chunks[index] }),
        });
        if (response.status !== 429 || attempt === 3) break;
        const retryAfter = Number(response.headers?.get?.('retry-after') || response.headers?.get?.('Retry-After') || 2);
        await new Promise((resolve) => setTimeout(resolve, Math.min(Math.max(retryAfter * 1000, 1000), 60000)));
      }

      if (!response.ok) {
        const responseBody = await readResponseBody(response);
        throw new Error(`HTTP ${response.status} ${response.statusText}${responseBody ? `: ${responseBody}` : ''}`);
      }
    }

    logger.log(`✅ Discord webhook 通知を送信しました (Type: ${formatted.type}, ID: ${formatted.id}, ${chunks.length}件)`);
    return { sent: true, chunks: chunks.length };
  } catch (err) {
    logger.error(`❌ Discord webhook 送信エラー (Type: ${formatted.type}, ID: ${formatted.id}): ${err.message}`);
    return { sent: false, reason: 'error', error: err };
  }
}

module.exports = {
  buildDiscordDebugMessage,
  formatLinesForDebug,
  formatJstTime,
  getDiscordDisplayWidth,
  sendDiscordDebugMessage,
  splitDiscordMessage,
  splitDiscordMessageByLines,
  waitForDiscordSend,
  toDiscordMarkdown,
  toFullwidthDigits,
  toHalfwidthDigits,
  wrapTextAtSpaces,
};
