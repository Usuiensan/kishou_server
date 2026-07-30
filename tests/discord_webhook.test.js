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
  assert.match(content, /本文\n\n-# jma 情報源 09:00:00\.000 /);
  assert.match(content, /送出 09:00:01\.234$/);
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
  assert.match(content, /緊急地震速報\n東京都で地震 強い揺れに警戒：\n東京　千葉　神奈川\nとうきょう　ちば　かながわ\n追加：埼玉\nさいたま/);
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
    toDiscordMarkdown('<space=0.5em><size=50%><voffset=0.7em>きょうと</voffset></size><space=-2.5em>京都市'),
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
  assert.match(body, /\*\*震度4\*\*:\n東京　千葉/);
  assert.match(body, /\nとうきょう　ちば/);
  assert.match(body, /神奈川/);
  assert.match(body, /\nとうきょう　ちば　かながわ\n/);
  assert.match(body, /\*\*震度2\*\*:\n埼玉/);
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
    '**震度4**',
    '東京　千葉　神奈川',
    'とうきょう　ちば　かながわ',
    '埼玉　茨城　群馬',
    'さいたま　いばらき　ぐんま',
    '栃木',
    'とちぎ',
    '**震度3**',
    '山梨　長野　静岡',
    'やまなし　ながの　しずおか',
    '愛知',
    'あいち',
  ]);
  assert.doesNotMatch(body, /\n\n/);
  assert.doesNotMatch(body, /\n\s{1,}- \*\*/);
});

test('地域名を途中で分割せず、長い地域名は単独行にする', () => {
  const body = formatLinesForDebug({ lines: [
    { text: '<u>震度5弱</u> <nobr>北海道渡島地方</nobr> <nobr>青森県</nobr> <nobr>岩手県</nobr> <nobr>宮城県</nobr>' },
  ] });
  assert.equal(body, '**震度5弱**\n北海道渡島地方　青森県　岩手県\n?　あおもりけん　いわてけん\n宮城県\nみやぎけん');
});

test('先頭行に1地域しか入らない場合はラベルだけを先頭行にする', () => {
  const body = formatLinesForDebug({ lines: [
    { text: '<u>震度4</u> <nobr>八代市</nobr> <nobr>氷川町</nobr>' },
  ] });
  assert.equal(body, '**震度4**\n八代市　氷川町\nやつしろし　ひかわちょう');
});

test('長周期地震動を指定の階級形式へ統合する', () => {
  const body = formatLinesForDebug({ lines: [
    { text: '<color=#FFFFFF>階級1：</color><nobr>東京</nobr> <nobr>千葉</nobr>' },
    { text: '<color=#FFFFFF>階級1：</color><nobr>神奈川</nobr>' },
  ] });
  assert.match(body, /\*\*【長周期地震動】階級1\*\*：\n東京　千葉　神奈川\nとうきょう　ちば　かながわ/);
});

test('地域名を漢字行と半角カタカナ行で印刷幅内に表示する', () => {
  const body = formatLinesForDebug({ lines: [
    { text: '<u>震度4</u> <nobr>熊本県天草・芦北</nobr> <nobr>鹿児島県薩摩</nobr>' },
  ] });
  assert.equal(body, '**震度4**\n熊本県天草・芦北\nくまもとけんあまくさ・あしきた\n鹿児島県薩摩\nかごしまけんさつま');
});

test('NHKニュース本文は数字を半角化し、空白位置で印刷幅内に折り返す', () => {
  const { buildDiscordDebugMessage, getDiscordDisplayWidth } = require('../lib/discordWebhook');
  const body = buildDiscordDebugMessage({
    source: 'nerv',
    nervCategory: 'news',
    lines: [{ text: 'NHKニュース速報 震度５を発表しました。 詳細は次の情報をご確認ください。' }],
    sourceTimestamp: '2026-01-01T00:00:00Z',
    sentTimestamp: '2026-01-01T00:00:00Z',
  });
  const content = body.split('\n\n-# ')[0];
  assert.match(content, /震度5/);
  assert.doesNotMatch(content, /[０-９]/);
  assert.ok(content.split('\n').every((line) => getDiscordDisplayWidth(line) <= 32));
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
  assert.match(body, /ニュース\n\n-# mastodon 情報源 09:00:00\.000 \/ 送出 09:00:00\.000$/);
  assert.doesNotMatch(body, /source:|unnerv\.jp/);
});
