const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  PermissionFlagsBits,
  MessageFlags,
  REST,
  Routes,
  SlashCommandBuilder,
} = require('discord.js');
const { buildDiscordDebugMessage, splitDiscordMessageByLines, waitForDiscordSend } = require('./discordWebhook');

const subscriptionsPath = process.env.DISCORD_SUBSCRIPTIONS_FILE || path.join(__dirname, '..', 'data', 'discord-subscriptions.json');
const deliveryStatePath = process.env.DISCORD_BOT_DELIVERY_FILE || path.join(__dirname, '..', 'data', 'discord-bot-delivery.json');
const COMMAND_SYNC_INTERVAL_MS = Number(process.env.DISCORD_COMMAND_SYNC_INTERVAL_MS || 10 * 60 * 1000);
const MAX_DELIVERY_KEYS = 10000;
const SUBSCRIPTION_CATEGORIES = [
  ...Array.from({ length: 7 }, (_, index) => `intensity_${index + 1}`),
  'eew',
  'nerv_tornado',
  'nerv_level4',
  'nerv_level5',
  'nerv_evacuation',
  'nerv_blackout',
  'nerv_transit',
  'nerv_news',
  'nerv_other',
];
const SUBSCRIPTION_CATEGORY_SET = new Set(SUBSCRIPTION_CATEGORIES);
const commands = [
  new SlashCommandBuilder().setName('subscribe').setDescription('このチャンネルの防災通知カテゴリを選択する'),
  new SlashCommandBuilder().setName('unsubscribe').setDescription('このチャンネルの防災通知カテゴリを解除する'),
  new SlashCommandBuilder().setName('status').setDescription('このチャンネルの通知設定を確認する'),
].map((command) => command.toJSON());

function loadSubscriptions() {
  try {
    const raw = JSON.parse(fs.readFileSync(subscriptionsPath, 'utf8'));
    const migrated = {};
    let changed = false;
    for (const [guildId, channels] of Object.entries(raw)) {
      migrated[guildId] = {};
      if (Array.isArray(channels)) {
        changed = true;
        continue;
      }
      for (const [channelId, value] of Object.entries(channels || {})) {
        if (Array.isArray(value)) {
          changed = true;
          continue;
        }
        const categories = [...new Set((value?.categories || []).filter((category) => SUBSCRIPTION_CATEGORY_SET.has(category)))];
        if (categories.length > 0) migrated[guildId][channelId] = { categories };
        if (JSON.stringify(value) !== JSON.stringify({ categories })) changed = true;
      }
    }
    if (changed) saveSubscriptions(migrated);
    return migrated;
  } catch (_) { return {}; }
}

function saveSubscriptions(subscriptions) {
  fs.mkdirSync(path.dirname(subscriptionsPath), { recursive: true });
  fs.writeFileSync(subscriptionsPath, `${JSON.stringify(subscriptions, null, 2)}\n`, 'utf8');
}

function loadDeliveryKeys(filePath = deliveryStatePath) {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return new Set(Array.isArray(raw?.keys) ? raw.keys.filter((key) => typeof key === 'string') : []);
  } catch (_) {
    return new Set();
  }
}

function saveDeliveryKeys(keys, filePath = deliveryStatePath) {
  const values = [...keys].slice(-MAX_DELIVERY_KEYS);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify({ version: 1, keys: values }, null, 2)}\n`, 'utf8');
}

function normalizeDeliveryValue(value, key = '') {
  if (Array.isArray(value)) return value.map((item) => normalizeDeliveryValue(item));
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value).sort().reduce((result, childKey) => {
    if (childKey === 'timestamp' || childKey === 'sentTimestamp' || childKey === 'id') return result;
    result[childKey] = normalizeDeliveryValue(value[childKey], childKey);
    return result;
  }, {});
}

function createDiscordDeliveryKey(formatted) {
  const normalized = normalizeDeliveryValue(formatted);
  return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

function createDiscordDeliveryChunkKey(channelId, deliveryKey, chunkIndex) {
  return `${channelId}:${deliveryKey}:${chunkIndex}`;
}

function intensityValue(type) {
  return ({
    earthquake_1: 1,
    earthquake_2: 2,
    earthquake_3: 3,
    earthquake_4: 4,
    earthquake_5l: 5,
    earthquake_5h: 5,
    earthquake_6l: 6,
    earthquake_6h: 6,
    earthquake_7: 7,
  }[type] || 0);
}

function shouldDeliver(formatted, config) {
  const categories = Array.isArray(config?.categories) ? config.categories : [];
  if (formatted.source === 'nerv') {
    const nervCategories = formatted.nervCategories || (formatted.nervCategory ? [`nerv_${formatted.nervCategory}`] : []);
    return nervCategories.some((category) => categories.includes(category));
  }
  if (formatted.type === 'eew') return categories.includes('eew');

  const value = intensityValue(formatted.type);
  return value > 0 && categories.some((category) => category.startsWith('intensity_') && value >= Number(category.split('_')[1]));
}

function createDiscordBot({ token = process.env.DISCORD_BOT_TOKEN, clientId = process.env.DISCORD_CLIENT_ID, logger = console } = {}) {
  if (!token || !clientId) {
    logger.warn('⚠️ Discord Bot 無効（DISCORD_BOT_TOKEN / DISCORD_CLIENT_ID が未設定）');
    return null;
  }

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  const subscriptions = loadSubscriptions();
  const deliveredChunks = loadDeliveryKeys();
  const command = new REST({ version: '10' }).setToken(token);
  const categoryOptions = [
    ...Array.from({ length: 7 }, (_, index) => ({ label: `震度${index + 1}以上`, value: `intensity_${index + 1}` })),
    { label: '緊急地震速報', value: 'eew' },
    { label: 'NERV・竜巻注意', value: 'nerv_tornado' },
    { label: 'NERV・避難レベル4', value: 'nerv_level4' },
    { label: 'NERV・避難レベル5', value: 'nerv_level5' },
    { label: 'NERV・避難情報', value: 'nerv_evacuation' },
    { label: 'NERV・停電', value: 'nerv_blackout' },
    { label: 'NERV・交通', value: 'nerv_transit' },
    { label: 'NERV・ニュース', value: 'nerv_news' },
    { label: 'NERV・その他', value: 'nerv_other' },
  ];
  const makeCategoryMenu = (action) => new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`nerv:${action}`)
      .setPlaceholder('通知カテゴリを選択')
      .setMinValues(1)
      .setMaxValues(categoryOptions.length)
      .addOptions(categoryOptions),
  );

  const hasPermission = (interaction) => interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
  const getChannelConfig = (guildId, channelId) => subscriptions[guildId]?.[channelId];

  let commandSyncInFlight = null;
  const syncCommands = async () => {
    if (commandSyncInFlight) return commandSyncInFlight;
    commandSyncInFlight = (async () => {
      for (const guild of client.guilds.cache.values()) {
        await command.put(Routes.applicationGuildCommands(clientId, guild.id), { body: commands });
      }
      logger.log(`✅ Discord Bot コマンド同期: ${client.guilds.cache.size}サーバー`);
    })().catch((error) => logger.error(`❌ Discord Bot コマンド同期エラー: ${error.message}`))
      .finally(() => { commandSyncInFlight = null; });
    return commandSyncInFlight;
  };

  client.once('ready', async () => {
    logger.log(`✅ Discord Bot ログイン: ${client.user.tag}`);
    await syncCommands();
    const commandSyncTimer = setInterval(() => void syncCommands(), COMMAND_SYNC_INTERVAL_MS);
    commandSyncTimer.unref?.();
  });

  client.on('interactionCreate', async (interaction) => {
    if (!interaction.channelId || !hasPermission(interaction)) {
      if (interaction.isChatInputCommand() || interaction.isStringSelectMenu()) await interaction.reply({ content: '⚠️ サーバー管理権限が必要です。', flags: MessageFlags.Ephemeral });
      return;
    }
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('nerv:')) {
      const action = interaction.customId.split(':')[1];
      subscriptions[interaction.guildId] ||= {};
      subscriptions[interaction.guildId][interaction.channelId] ||= {};
      const current = new Set(subscriptions[interaction.guildId][interaction.channelId].categories || []);
      if (action === 'subscribe') interaction.values.forEach((value) => current.add(value));
      else interaction.values.forEach((value) => current.delete(value));
      if (current.size === 0) delete subscriptions[interaction.guildId][interaction.channelId];
      else subscriptions[interaction.guildId][interaction.channelId] = { categories: [...current] };
      saveSubscriptions(subscriptions);
      await interaction.update({ content: `✅ 購読カテゴリを更新しました: ${[...current].join(', ') || '購読なし'}`, components: [] });
      return;
    }
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName === 'subscribe' || interaction.commandName === 'unsubscribe') {
      await interaction.reply({ content: '通知カテゴリを選択してください（複数選択可）。', components: [makeCategoryMenu(interaction.commandName)], flags: MessageFlags.Ephemeral });
    } else if (interaction.commandName === 'status') {
      const config = getChannelConfig(interaction.guildId, interaction.channelId);
      await interaction.reply(config ? `✅ 購読中: ${config.categories.join(', ')}` : 'ℹ️ 未設定（購読なし）');
    }
  });

  client.login(token).catch((error) => logger.error(`❌ Discord Bot ログイン失敗: ${error.message}`));
  return {
    async send(formatted) {
      const message = buildDiscordDebugMessage(formatted);
      const chunks = splitDiscordMessageByLines(message);
      const deliveryKey = createDiscordDeliveryKey(formatted);
      for (const channels of Object.values(subscriptions)) {
        for (const [channelId, config] of Object.entries(channels)) {
          if (!shouldDeliver(formatted, config)) continue;
          const channel = await client.channels.fetch(channelId).catch(() => null);
          if (!channel || !channel.isTextBased()) continue;
          for (const [chunkIndex, chunk] of chunks.entries()) {
            const chunkKey = createDiscordDeliveryChunkKey(channelId, deliveryKey, chunkIndex);
            if (deliveredChunks.has(chunkKey)) continue;
            await waitForDiscordSend();
            await channel.send({ content: chunk });
            deliveredChunks.add(chunkKey);
            while (deliveredChunks.size > MAX_DELIVERY_KEYS) {
              deliveredChunks.delete(deliveredChunks.values().next().value);
            }
            saveDeliveryKeys(deliveredChunks);
          }
        }
      }
    },
    client,
  };
}

module.exports = {
  createDiscordBot,
  loadSubscriptions,
  saveSubscriptions,
  loadDeliveryKeys,
  saveDeliveryKeys,
  createDiscordDeliveryKey,
  createDiscordDeliveryChunkKey,
  intensityValue,
  SUBSCRIPTION_CATEGORIES,
  shouldDeliver,
};
