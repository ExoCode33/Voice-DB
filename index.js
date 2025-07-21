const { Client, GatewayIntentBits, Events } = require('discord.js');
const { joinVoiceChannel, getVoiceConnection, EndBehaviorType } = require('@discordjs/voice');
const prism = require('prism-media');

const TOKEN = 'YOUR_BOT_TOKEN_HERE'; // <-- Replace with your bot token
const REPORT_CHANNEL_ID = 'YOUR_TEXT_CHANNEL_ID'; // <-- Replace with your text channel ID

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent,
  ],
});

let voiceData = {};
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

async function summarizeAndReset(guild) {
  const channel = await guild.channels.fetch(REPORT_CHANNEL_ID);
  if (!channel) return;

  if (Object.keys(voiceData).length === 0) {
    channel.send('No voice activity detected in the last minute.');
    return;
  }
  let summary = `**Voice Loudness Report (Relative RMS):**\n`;
  for (const [userId, { total, count }] of Object.entries(voiceData)) {
    let avg = total / count;
    summary += `<@${userId}>: ${avg.toFixed(1)}\n`;
  }
  channel.send(summary);
  voiceData = {};
}

client.once(Events.ClientReady, () => {
  console.log(`Logged in as ${client.user.tag}!`);
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (message.content.startsWith('!join')) {
    const { member, guild } = message;
    const voiceChannel = member.voice.channel;
    if (!voiceChannel) return message.reply('You must be in a voice channel first.');

    joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
    });

    message.reply(`Joined voice channel: ${voiceChannel.name}`);

    // Clear any previous intervals
    if (interval) clearInterval(interval);

    // Post report every minute
    interval = setInterval(() => summarizeAndReset(guild), 60000);

    const connection = getVoiceConnection(guild.id);
    if (!connection) return;

    const receiver = connection.receiver;

    receiver.speaking.on('start', (userId) => {
      const opusStream = receiver.subscribe(userId, { end: { behavior: EndBehaviorType.AfterSilence, duration: 1000 } });
      const pcmStream = opusStream.pipe(new prism.opus.Decoder({ channels: 2, rate: 48000, frameSize: 960 }));

      pcmStream.on('data', (chunk) => {
        const rms = calculateRMS(chunk);
        if (!voiceData[userId]) voiceData[userId] = { total: 0, count: 0 };
        voiceData[userId].total += rms;
        voiceData[userId].count++;
      });
    });
  }

  if (message.content.startsWith('!leave')) {
    const { guild } = message;
    const connection = getVoiceConnection(guild.id);
    if (connection) connection.destroy();
    if (interval) clearInterval(interval);
    voiceData = {};
    message.reply('Left the voice channel and stopped reporting.');
  }
});

client.login(TOKEN);
