const fs = require('fs');
const path = require('path');
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
} = require('discord.js');
const { buildDiscordDebugMessage, splitDiscordMessageByLines, waitForDiscordSend } = require('./discordWebhook');

const subscriptionsPath = process.env.DISCORD_SUBSCRIPTIONS_FILE || path.join(__dirname, '..', 'data', 'discord-subscriptions.json');
const commands = [
  new SlashCommandBuilder().setName('subscribe').setDescription('このチャンネルへ防災通知を送る'),
  new SlashCommandBuilder().setName('unsubscribe').setDescription('このチャンネルへの防災通知を停止する'),
  new SlashCommandBuilder().setName('status').setDescription('このチャンネルの通知設定を確認する'),
].map((command) => command.toJSON());

function loadSubscriptions() {
  try { return JSON.parse(fs.readFileSync(subscriptionsPath, 'utf8')); } catch (_) { return {}; }
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

  client.once('ready', async () => {
    logger.log(`✅ Discord Bot ログイン: ${client.user.tag}`);
    for (const guild of client.guilds.cache.values()) {
      await command.put(Routes.applicationGuildCommands(clientId, guild.id), { body: commands });
    }
    logger.log(`✅ Discord Bot コマンド登録: ${client.guilds.cache.size}サーバー`);
  });

  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand() || !interaction.channelId) return;
    if (interaction.commandName === 'subscribe') {
      subscriptions[interaction.guildId] = [...new Set([...(subscriptions[interaction.guildId] || []), interaction.channelId])];
      saveSubscriptions(subscriptions);
      await interaction.reply('✅ このチャンネルへの防災通知を開始しました。');
    } else if (interaction.commandName === 'unsubscribe') {
      subscriptions[interaction.guildId] = (subscriptions[interaction.guildId] || []).filter((id) => id !== interaction.channelId);
      saveSubscriptions(subscriptions);
      await interaction.reply('✅ このチャンネルへの防災通知を停止しました。');
    } else if (interaction.commandName === 'status') {
      const enabled = (subscriptions[interaction.guildId] || []).includes(interaction.channelId);
      await interaction.reply(enabled ? '✅ このチャンネルは通知対象です。' : 'ℹ️ このチャンネルは通知対象ではありません。');
    }
  });

  client.login(token).catch((error) => logger.error(`❌ Discord Bot ログイン失敗: ${error.message}`));
  return {
    async send(formatted) {
      const message = buildDiscordDebugMessage(formatted);
      for (const channelIds of Object.values(subscriptions)) {
        for (const channelId of channelIds) {
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
