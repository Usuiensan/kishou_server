const DISCORD_MESSAGE_LIMIT = 1900;

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
  const header = [
    '【JMA API Debug】テロップ送出全文',
    `type: ${formatted.type}`,
    `id: ${formatted.id}`,
    `timestamp: ${formatted.timestamp || new Date().toISOString()}`,
  ].join('\n');
  return `${header}\n\n${formatLinesForDebug(formatted)}`;
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
      const response = await fetchImpl(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: chunks[index] }),
      });

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
  toDiscordMarkdown,
};
