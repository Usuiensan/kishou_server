const DISCORD_MESSAGE_LIMIT = 1900;
const DISCORD_SEND_INTERVAL_MS = Math.max(250, Number(process.env.DISCORD_SEND_INTERVAL_MS || 1500));
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
    .replace(/<color(?:=[^>]*)?>/gi, '**')
    .replace(/<\/color>/gi, '**')
    .replace(/<u>/gi, '__')
    .replace(/<\/u>/gi, '__')
    .replace(/<nobr>/gi, '')
    .replace(/<\/nobr>/gi, '')
    .replace(/<(?:align|indent|voffset|size|b|i|s)(?:=[^>]*)?>/gi, '')
    .replace(/<\/(?:align|indent|voffset|size|b|i|s)>/gi, '')
    .replace(/<br\s*\/?>(?=.)/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\*{4}/g, '**')
    .trim();
}

function formatLinesForDebug(formatted) {
  const sourceLines = (formatted.lines || [])
    .map((line) => toDiscordMarkdown(typeof line === 'string' ? line : line.text))
    .filter(Boolean);
  const lines = [];
  const intensityLines = new Map();

  for (const line of sourceLines) {
    const match = line.match(/^__?震度([7654321７６５４３２１]|5弱|5強|6弱|6強)__?\s*(.*)$/);
    if (!match) {
      lines.push(line);
      continue;
    }
    const key = `震度${match[1]}`;
    const numericIntensity = Number(String(match[1]).replace(/[５]/g, '5').replace(/[６]/g, '6').replace(/[７]/g, '7').replace(/[４]/g, '4').replace(/[３]/g, '3').replace(/[２]/g, '2').replace(/[１]/g, '1'));
    if (Number.isFinite(numericIntensity) && numericIntensity < 4) continue;
    const areaText = match[2].replace(/\s{2,}/g, '、').replace(/\s+/g, ' ').trim();
    if (!intensityLines.has(key)) intensityLines.set(key, []);
    if (areaText) intensityLines.get(key).push(areaText);
  }

  if (intensityLines.size > 0) {
    const firstIntensityIndex = lines.length;
    const compact = [...intensityLines.entries()].map(([key, areas]) => `- **${key}**: ${areas.join('、')}`);
    lines.splice(firstIntensityIndex, 0, ...compact);
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
      primaryAreas.join('　'),
      additionalAreas.length > 0 ? `追加：${additionalAreas.join('　')}` : '',
    ].filter(Boolean).join('\n');
  }
  const sourceLabel = formatted.source === 'nerv' ? 'mastodon' : 'jma';
  const metadata = `-# ${sourceLabel} ${formatted.timestamp || new Date().toISOString()}`;
  return `${body}${body ? '\n\n' : ''}${metadata}`;
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
  sendDiscordDebugMessage,
  splitDiscordMessage,
  splitDiscordMessageByLines,
  waitForDiscordSend,
  toDiscordMarkdown,
};
