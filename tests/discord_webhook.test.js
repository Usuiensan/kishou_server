const assert = require('node:assert/strict');
const test = require('node:test');
const {
  sendDiscordDebugMessage,
  splitDiscordMessage,
  formatLinesForDebug,
  toDiscordMarkdown,
} = require('../lib/discordWebhook');

const formatted = {
  type: 'earthquake_4',
  id: 'test-report',
  timestamp: '2026-07-22T00:00:00.000Z',
  lines: [{ text: 'テロップ本文', duration: 7.5 }],
};

test('Discordの上限に合わせて本文を分割する', () => {
  assert.deepEqual(splitDiscordMessage('abcdefgh', 3), ['abc', 'def', 'gh']);
});

test('Webhook成功時に送信済みを返す', async () => {
  const requests = [];
  const result = await sendDiscordDebugMessage(formatted, {
    webhookUrl: 'https://discord.example/webhook',
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, status: 204, statusText: 'No Content' };
    },
    logger: { log() {}, error() {} },
  });

  assert.equal(result.sent, true);
  assert.equal(requests.length, 1);
  assert.match(JSON.parse(requests[0].options.body).content, /テロップ本文/);
});

test('Discord本文の末尾にコンパクトな一行メタデータを表示する', async () => {
  let content = '';
  const result = await sendDiscordDebugMessage({
    type: 'earthquake_4',
    id: 'id-1',
  timestamp: '2026-07-29T00:00:00.000Z',
    sourceTimestamp: '2026-07-29T00:00:00.000Z',
    sentTimestamp: '2026-07-29T00:00:01.234Z',
    lines: [{ text: '本文' }],
  }, {
    webhookUrl: 'https://discord.example/webhook',
    fetchImpl: async (_url, options) => { content = JSON.parse(options.body).content; return { ok: true, status: 204, statusText: 'No Content' }; },
    logger: { log() {}, error() {} },
  });
  assert.equal(result.sent, true);
  assert.match(content, /本文\n\n-# jma 情報源 ０９:００:００\.０００ /);
  assert.match(content, /送出 ０９:００:０１\.２３４$/);
  assert.doesNotMatch(content, /type:|id:|timestamp:/);
  assert.doesNotMatch(content, /JMA API Debug/);
});

test('EEWは専用の優先通知形式で整形する', async () => {
  let content = '';
  await sendDiscordDebugMessage({
    type: 'eew', id: 'eew-1', isEEW: true,
    eewHeadline: '東京都で地震 強い揺れに警戒',
    eewAreas: ['東京', '千葉', '神奈川', '埼玉'],
    eewAdditionalAreas: ['埼玉'],
    lines: [{ text: '内部表示' }],
  }, {
    webhookUrl: 'https://discord.example/webhook',
    fetchImpl: async (_url, options) => { content = JSON.parse(options.body).content; return { ok: true, status: 204, statusText: '' }; },
    logger: { log() {}, error() {} },
  });
  assert.match(content, /緊急地震速報\n東京都で地震 強い揺れに警戒：\n東京　千葉　神奈川\n追加：埼玉/);
});

test('WebhookのHTTPエラーを失敗として記録する', async () => {
  const errors = [];
  const result = await sendDiscordDebugMessage(formatted, {
    webhookUrl: 'https://discord.example/webhook',
    fetchImpl: async () => ({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      text: async () => '{"message":"Unknown Webhook"}',
    }),
    logger: { log() {}, error(message) { errors.push(message); } },
  });

  assert.equal(result.sent, false);
  assert.match(errors[0], /HTTP 404 Not Found/);
  assert.match(errors[0], /Unknown Webhook/);
});

test('Webhook未設定時は送信を無効として返す', async () => {
  const result = await sendDiscordDebugMessage(formatted, {
    webhookUrl: '',
    fetchImpl: async () => assert.fail('呼ばれないこと'),
    logger: { log() {}, error() {} },
  });
  assert.deepEqual(result, { sent: false, reason: 'disabled' });
});

test('UnityリッチテキストをDiscord Markdownへ変換する', () => {
  assert.equal(toDiscordMarkdown('<color=#FF2800>【津波警報】</color><nobr>静岡県</nobr>'), '**【津波警報】**静岡県');
});

test('Discord変換ではUnity用ルビの読みを除去し、地域名だけ残す', () => {
  assert.equal(
    toDiscordMarkdown('<size=50%><voffset=0.7em>きょうと</voffset></size>京都市'),
    '京都市',
  );
});

test('震度行を統合し、分割線を使わない', () => {
  const body = formatLinesForDebug({ lines: [
    { text: '地震情報' },
    { text: '<u>震度4</u> <nobr>東京</nobr>    <nobr>千葉</nobr>' },
    { text: '<u>震度4</u> <nobr>神奈川</nobr>' },
    { text: '<u>震度2</u> <nobr>埼玉</nobr>' },
  ] });
  assert.match(body, /\*\*震度4\*\*: 東京　千葉/);
  assert.match(body, /\n神奈川/);
  assert.match(body, /震度2/);
  assert.doesNotMatch(body, /---/);
});

test('震度別地域を幅に応じて折り返し、インデントしない', () => {
  const body = formatLinesForDebug({ lines: [
    { text: '<u>震度4</u> <nobr>東京</nobr> <nobr>千葉</nobr> <nobr>神奈川</nobr>' },
    { text: '<u>震度4</u> <nobr>埼玉</nobr> <nobr>茨城</nobr> <nobr>群馬</nobr>' },
    { text: '<u>震度4</u> <nobr>栃木</nobr>' },
    { text: '<u>震度3</u> <nobr>山梨</nobr> <nobr>長野</nobr> <nobr>静岡</nobr> <nobr>愛知</nobr>' },
  ] });
  const lines = body.split('\n');
  assert.deepEqual(lines, [
    '- **震度4**: 東京　千葉',
    '神奈川　埼玉　茨城　群馬　栃木',
    '- **震度3**: 山梨　長野',
    '静岡　愛知',
  ]);
  assert.doesNotMatch(body, /\n\n/);
  assert.doesNotMatch(body, /\n\s{1,}- \*\*/);
});

test('地域名を途中で分割せず、長い地域名は単独行にする', () => {
  const body = formatLinesForDebug({ lines: [
    { text: '<u>震度5弱</u> <nobr>北海道渡島地方</nobr> <nobr>青森県</nobr> <nobr>岩手県</nobr> <nobr>宮城県</nobr>' },
  ] });
  assert.equal(body, '- **震度5弱**: \n北海道渡島地方　青森県　岩手県\n宮城県');
});

test('先頭行に1地域しか入らない場合はラベルだけを先頭行にする', () => {
  const body = formatLinesForDebug({ lines: [
    { text: '<u>震度4</u> <nobr>八代市</nobr> <nobr>氷川町</nobr>' },
  ] });
  assert.equal(body, '- **震度4**: \n八代市　氷川町');
});

test('長周期地震動を指定の階級形式へ統合する', () => {
  const body = formatLinesForDebug({ lines: [
    { text: '<color=#FFFFFF>階級1：</color><nobr>東京</nobr> <nobr>千葉</nobr>' },
    { text: '<color=#FFFFFF>階級1：</color><nobr>神奈川</nobr>' },
  ] });
  assert.match(body, /- \*\*【長周期地震動】階級1\*\*：東京　千葉　神奈川/);
});

test('Discord本文を行単位で分割する', () => {
  const { splitDiscordMessageByLines } = require('../lib/discordWebhook');
  assert.deepEqual(splitDiscordMessageByLines('abc\ndef\nghi', 7), ['abc\ndef', 'ghi']);
});

test('NERV通知はMastodonと時刻だけを一行表示する', () => {
  const { buildDiscordDebugMessage } = require('../lib/discordWebhook');
  const body = buildDiscordDebugMessage({
    source: 'nerv',
    nervCategory: 'news',
    sourceUrl: 'https://unnerv.jp/@UN_NERV/123',
    publishedAt: '2026-01-01T00:00:00Z',
    lines: [{ text: 'ニュース' }],
    type: 'nerv',
    id: 'nerv_123',
    timestamp: '2026-01-01T00:00:00Z',
    sentTimestamp: '2026-01-01T00:00:00Z',
  });
  assert.match(body, /ニュース\n\n-# mastodon 情報源 ０９:００:００\.０００ \/ 送出 ０９:００:００\.０００$/);
  assert.doesNotMatch(body, /source:|unnerv\.jp/);
});
