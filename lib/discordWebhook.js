const DISCORD_MESSAGE_LIMIT = 1900;

function formatLinesForDebug(formatted) {
  const lines = (formatted.lines || [])
    .map((line) => (typeof line === 'string' ? line : line.text))
    .filter(Boolean);
  return lines.join('\n\n---\n\n');
}

function splitDiscordMessage(text, limit = DISCORD_MESSAGE_LIMIT) {
  const chunks = [];
  for (let i = 0; i < text.length; i += limit) {
    chunks.push(text.slice(i, i + limit));
  }
  return chunks;
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

  const chunks = splitDiscordMessage(buildDiscordDebugMessage(formatted));

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
};
