const fs = require('fs');
const path = require('path');
const {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
} = require('discord.js');
const { buildDiscordDebugMessage, splitDiscordMessageByLines, waitForDiscordSend } = require('./discordWebhook');

const subscriptionsPath = process.env.DISCORD_SUBSCRIPTIONS_FILE || path.join(__dirname, '..', 'data', 'discord-subscriptions.json');
const commands = [
  new SlashCommandBuilder().setName('subscribe').setDescription('このチャンネルの防災通知カテゴリを選択する'),
  new SlashCommandBuilder().setName('unsubscribe').setDescription('このチャンネルの防災通知カテゴリを解除する'),
  new SlashCommandBuilder().setName('status').setDescription('このチャンネルの通知設定を確認する'),
].map((command) => command.toJSON());

function loadSubscriptions() {
  try {
    const raw = JSON.parse(fs.readFileSync(subscriptionsPath, 'utf8'));
    const migrated = {};
    for (const [guildId, channels] of Object.entries(raw)) {
      migrated[guildId] = {};
      if (Array.isArray(channels)) {
        for (const channelId of channels) migrated[guildId][channelId] = { categories: ['default'] };
        continue;
      }
      for (const [channelId, value] of Object.entries(channels || {})) {
        migrated[guildId][channelId] = Array.isArray(value) ? { categories: ['default'] } : value;
      }
    }
    return migrated;
  } catch (_) { return {}; }
}

function saveSubscriptions(subscriptions) {
  fs.mkdirSync(path.dirname(subscriptionsPath), { recursive: true });
  fs.writeFileSync(subscriptionsPath, `${JSON.stringify(subscriptions, null, 2)}\n`, 'utf8');
}

function createDiscordBot({ token = process.env.DISCORD_BOT_TOKEN, clientId = process.env.DISCORD_CLIENT_ID, logger = console } = {}) {
  if (!token || !clientId) {
    logger.warn('⚠️ Discord Bot 無効（DISCORD_BOT_TOKEN / DISCORD_CLIENT_ID が未設定）');
    return null;
  }

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  const subscriptions = loadSubscriptions();
  const command = new REST({ version: '10' }).setToken(token);
  const categoryOptions = [
    ...Array.from({ length: 7 }, (_, index) => ({ label: `震度${index + 1}以上`, value: `intensity_${index + 1}` })),
    { label: '緊急地震速報', value: 'eew' },
    { label: 'NERV経由情報', value: 'nerv' },
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
  const intensityValue = (type) => ({ earthquake_1: 1, earthquake_2: 2, earthquake_3: 3, earthquake_4: 4, earthquake_5l: 5, earthquake_5h: 5, earthquake_6l: 6, earthquake_6h: 6, earthquake_7: 7 }[type] || 0);
  const shouldDeliver = (formatted, config) => {
    const categories = config?.categories || ['default'];
    if (categories.includes('default')) return formatted.type === 'eew' || intensityValue(formatted.type) >= 4;
    if (formatted.type === 'eew') return categories.includes('eew');
    if (formatted.source === 'nerv') return categories.includes('nerv');
    const value = intensityValue(formatted.type);
    return value > 0 && categories.some((category) => category.startsWith('intensity_') && value >= Number(category.split('_')[1]));
  };

  client.once('ready', async () => {
    logger.log(`✅ Discord Bot ログイン: ${client.user.tag}`);
    for (const guild of client.guilds.cache.values()) {
      await command.put(Routes.applicationGuildCommands(clientId, guild.id), { body: commands });
    }
    logger.log(`✅ Discord Bot コマンド登録: ${client.guilds.cache.size}サーバー`);
  });

  client.on('interactionCreate', async (interaction) => {
    if (!interaction.channelId || !hasPermission(interaction)) {
      if (interaction.isChatInputCommand() || interaction.isStringSelectMenu()) await interaction.reply({ content: '⚠️ サーバー管理権限が必要です。', ephemeral: true });
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
      await interaction.update({ content: `✅ 購読カテゴリを更新しました: ${[...current].join(', ') || 'デフォルト'}`, components: [] });
      return;
    }
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName === 'subscribe' || interaction.commandName === 'unsubscribe') {
      await interaction.reply({ content: '通知カテゴリを選択してください（複数選択可）。', components: [makeCategoryMenu(interaction.commandName)], ephemeral: true });
    } else if (interaction.commandName === 'status') {
      const config = getChannelConfig(interaction.guildId, interaction.channelId);
      await interaction.reply(config ? `✅ 購読中: ${config.categories.join(', ')}` : 'ℹ️ 未設定（デフォルト: EEW または最大震度4以上）');
    }
  });

  client.login(token).catch((error) => logger.error(`❌ Discord Bot ログイン失敗: ${error.message}`));
  return {
    async send(formatted) {
      const message = buildDiscordDebugMessage(formatted);
      for (const channels of Object.values(subscriptions)) {
        for (const [channelId, config] of Object.entries(channels)) {
          if (!shouldDeliver(formatted, config)) continue;
          const channel = await client.channels.fetch(channelId).catch(() => null);
          if (!channel || !channel.isTextBased()) continue;
          for (const chunk of splitDiscordMessageByLines(message)) {
            await waitForDiscordSend();
            await channel.send({ content: chunk });
          }
        }
      }
    },
    client,
  };
}

module.exports = { createDiscordBot, loadSubscriptions, saveSubscriptions };
