const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, Collection } = require('discord.js');
const { joinVoiceChannel, getVoiceConnection, EndBehaviorType } = require('@discordjs/voice');
const prism = require('prism-media');

const TOKEN = 'YOUR_BOT_TOKEN_HERE'; // <-- Replace with your bot token
const REPORT_CHANNEL_ID = 'YOUR_TEXT_CHANNEL_ID'; // <-- Replace with your text channel ID
const CLIENT_ID = 'YOUR_CLIENT_ID'; // <-- Discord Developer Portal App ID

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent,
  ],
});

const dataWindow = 5 * 60 * 1000; // 5 minutes
let voiceData = []; // [{ userId, rms, timestamp }]
let interval = null;

function calculateRMS(buffer) {
  let total = 0;
  for (let i = 0; i < buffer.length; i += 2) {
    let val = buffer.readInt16LE(i);
    total += val * val;
  }
  let rms = Math.sqrt(total / (buffer.length / 2));
  return rms;
}

// SLASH COMMAND REGISTRATION
const commands = [
  new SlashCommandBuilder().setName('join').setDescription('Join your current voice channel.'),
  new SlashCommandBuilder().setName('leave').setDescription('Leave voice channel and stop recording.'),
  new SlashCommandBuilder().setName('post-summary').setDescription('Post dB summary for last 5 minutes.'),
].map(cmd => cmd.toJSON());

client.commands = new Collection();
client.commands.set('join', {});
client.commands.set('leave', {});
client.commands.set('post-summary', {});

client.once('ready', async () => {
  // Register slash commands globally (for single-server bot, change as needed)
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
  console.log(`Bot logged in as ${client.user.tag} and slash commands registered!`);
});

async function postSummary(guild) {
  const channel = await guild.channels.fetch(REPORT_CHANNEL_ID);
  if (!channel) return;

  const now = Date.now();
  // Only last 5 min
  const recentData = voiceData.filter(v => now - v.timestamp <= dataWindow);

  if (recentData.length === 0) {
    channel.send('No voice activity detected in the last 5 minutes.');
    return;
  }

  // Group by user
  const users = {};
  for (const { userId, rms } of recentData) {
    if (!users[userId]) users[userId] = { total: 0, count: 0 };
    users[userId].total += rms;
    users[userId].count++;
  }

  let summary = `**Voice Loudness Report (Last 5 Minutes, Relative RMS):**\n`;
  for (const [userId, { total, count }] of Object.entries(users)) {
    let avg = total / count;
    summary += `<@${userId}>: ${avg.toFixed(1)}\n`;
  }
  channel.send(summary);
}

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  const { commandName, guild, member } = interaction;

  if (commandName === 'join') {
    const voiceChannel = member.voice.channel;
    if (!voiceChannel) return interaction.reply({ content: 'You must be in a voice channel first.', ephemeral: true });

    joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
    });

    interaction.reply({ content: `Joined voice channel: ${voiceChannel.name}`, ephemeral: true });

    // Clear interval if running
    if (interval) clearInterval(interval);

    // Start cleaning up old voiceData every minute
    interval = setInterval(() => {
      const now = Date.now();
      voiceData = voiceData.filter(d => now - d.timestamp <= dataWindow);
    }, 60 * 1000);

    const connection = getVoiceConnection(guild.id);
    if (!connection) return;

    const receiver = connection.receiver;
    receiver.speaking.on('start', (userId) => {
      const opusStream = receiver.subscribe(userId, { end: { behavior: EndBehaviorType.AfterSilence, duration: 1000 } });
      const pcmStream = opusStream.pipe(new prism.opus.Decoder({ channels: 2, rate: 48000, frameSize: 960 }));

      pcmStream.on('data', (chunk) => {
        const rms = calculateRMS(chunk);
        voiceData.push({ userId, rms, timestamp: Date.now() });
      });
    });
  }

  if (commandName === 'leave') {
    const connection = getVoiceConnection(guild.id);
    if (connection) connection.destroy();
    if (interval) clearInterval(interval);
    voiceData = [];
    interaction.reply({ content: 'Left the voice channel and stopped recording.', ephemeral: true });
  }

  if (commandName === 'post-summary') {
    await interaction.deferReply({ ephemeral: false });
    await postSummary(guild);
    await interaction.editReply('Posted dB summary for the last 5 minutes!');
  }
});

client.login(TOKEN);
