const fs = require('node:fs');
const path = require('node:path');
const { normalizeStatus, isExcludedNervStatus } = require('../../lib/nervSource');
const { buildDiscordDebugMessage } = require('../../lib/discordWebhook');

const samples = [
  {
    id: 'test-news',
    url: 'https://unnerv.jp/@UN_NERV/test-news',
    created_at: '2026-07-29T12:00:00Z',
    content: '<p>NHKニュース速報：大雨に関する最新情報をお伝えします。</p>',
    tags: [{ name: 'NHK' }, { name: 'ニュース' }],
  },
  {
    id: 'test-transit',
    url: 'https://unnerv.jp/@UN_NERV/test-transit',
    created_at: '2026-07-29T12:01:00Z',
    content: '<p>交通情報：大雨のため、鉄道の一部区間で運転を見合わせています。</p>',
    tags: [{ name: '交通' }],
  },
];

const output = samples
  .filter((status) => !isExcludedNervStatus(status))
  .map((status) => buildDiscordDebugMessage(normalizeStatus(status)))
  .join('\n\n');
const outputPath = path.join(__dirname, '../results/test_result_NERV.md');
fs.writeFileSync(outputPath, output, 'utf8');
console.log(`NERVニュース・交通情報のDiscord本文を保存しました: ${outputPath}`);
console.log(output);
