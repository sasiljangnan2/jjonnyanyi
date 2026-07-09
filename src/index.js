require("dotenv").config();

const http = require("http");
const fs = require("fs");
const path = require("path");
const cron = require("node-cron");
const prism = require("prism-media");

const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
} = require("discord.js");

const {
  joinVoiceChannel,
  entersState,
  VoiceConnectionStatus,
  EndBehaviorType,
} = require("@discordjs/voice");

const token = (process.env.DISCORD_TOKEN || "").trim();
const clientId = (process.env.DISCORD_CLIENT_ID || "").trim();
const guildId = (process.env.DISCORD_GUILD_ID || "").trim();
const dailyStickerName = (process.env.DAILY_STICKER_NAME || "Emaclock").trim();
const dailyChannelId = (process.env.DAILY_CHANNEL_ID || "").trim();
const dailyCronTimezone = (process.env.DAILY_TIMEZONE || "Asia/Seoul").trim();
const randomRoleId = (process.env.RANDOM_ROLE_ID || "").trim();
const randomRoleChancePercent = Number(process.env.RANDOM_ROLE_CHANCE_PERCENT || 10);
const loseRoleId = (process.env.LOSE_ROLE_ID || "").trim();
const loseRoleChancePercent = Number(process.env.LOSE_ROLE_CHANCE_PERCENT || 10);
const rouletteUsagePath = path.join(__dirname, "..", "roulette_usage.json");
const rouletteDailyLimit = Number(process.env.ROULETTE_DAILY_LIMIT || 3);
const rouletteRemovalTimers = new Map();
const rouletteRoleRemovalDelayMs = Number(process.env.ROULETTE_ROLE_REMOVAL_DELAY_MS || 5 * 60 * 1000);
const loseRoleRemovalDelayMs = Number(process.env.LOSE_ROLE_REMOVAL_DELAY_MS || rouletteRoleRemovalDelayMs);
const whisperApiUrl = (process.env.WHISPER_API_URL || "").trim();
const whisperApiKey = (process.env.WHISPER_API_KEY || "").trim();
const whisperModelName = (process.env.WHISPER_MODEL || "base").trim();
const whisperLanguage = (process.env.WHISPER_LANGUAGE || "ko").trim();
const voiceTempDir = path.join(__dirname, "..", "tmp", "voice");
const voiceSessions = new Map();

fs.mkdirSync(voiceTempDir, { recursive: true });

if (!token) {
  console.error("DISCORD_TOKEN is missing. Add it to your .env file.");
  process.exit(1);
}

if (!clientId) {
  console.error("DISCORD_CLIENT_ID is missing. Add it to your .env file.");
  process.exit(1);
}

if (!guildId) {
  console.error("DISCORD_GUILD_ID is missing. Add it to your .env file.");
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildVoiceStates],
});

const port = Number(process.env.PORT || 3000);

const server = http.createServer((request, response) => {
  if (request.url === "/" || request.url === "/health") {
    response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("ok");
    return;
  }

  response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  response.end("not found");
});

server.listen(port, () => {
  console.log(`HTTP health server listening on port ${port}`);
});

const commands = [
  new SlashCommandBuilder()
    .setName("안녕")
    .setDescription("이치히메 인사 받아라냥")
    .toJSON(),
  new SlashCommandBuilder()
    .setName("2시")
    .setDescription("2시 스티커 발사다냥")
    .toJSON(),
  new SlashCommandBuilder()
    .setName("2시테스트")
    .setDescription("스티커 바로 테스트한다냥")
    .toJSON(),
  new SlashCommandBuilder()
    .setName("룰렛")
    .setDescription("운 시험하는 룰렛이다냥")
    .toJSON(),
  new SlashCommandBuilder()
    .setName("룰렛초기화")
    .setDescription("오늘 룰렛 횟수 초기화한다냥 (관리자 전용)")
    .addUserOption((option) =>
      option
        .setName("대상")
        .setDescription("초기화할 대상을 골라라냥")
        .setRequired(true)
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName("타패추천")
    .setDescription("쫀냥이가 버릴 패를 골라준다냥!")
    .toJSON(),
  new SlashCommandBuilder()
    .setName("역조합")
    .setDescription("이치히메가 오늘 노릴 역을 골라준다냥!")
    .toJSON(),
  new SlashCommandBuilder()
    .setName("패뽑기")
    .setDescription("랜덤으로 13장 손패를 뽑아준다냥!")
    .toJSON(),
  new SlashCommandBuilder()
    .setName("음성입장")
    .setDescription("내 음성채팅에 들어와서 듣기 시작한다냥!")
    .toJSON(),
  new SlashCommandBuilder()
    .setName("음성퇴장")
    .setDescription("음성채팅 듣기를 멈추고 나간다냥!")
    .toJSON(),
];

function buildWavHeader(pcmDataLength, sampleRate = 16000, channels = 1, bitsPerSample = 16) {
  const blockAlign = channels * (bitsPerSample / 8);
  const byteRate = sampleRate * blockAlign;
  const buffer = Buffer.alloc(44);

  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + pcmDataLength, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(pcmDataLength, 40);

  return buffer;
}

async function transcribeAudioFile(audioPath) {
  const audioBuffer = await fs.promises.readFile(audioPath);

  if (whisperApiUrl) {
    const response = await fetch(whisperApiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "audio/wav",
        ...(whisperApiKey ? { "X-Whisper-Key": whisperApiKey } : {}),
        "X-Whisper-Model": whisperModelName,
        "X-Whisper-Language": whisperLanguage,
      },
      body: audioBuffer,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(errorText || `Whisper API returned ${response.status}`);
    }

    const parsed = await response.json();
    return (parsed.text || "").trim();
  }

  throw new Error("WHISPER_API_URL is missing. Start the local Whisper server and set WHISPER_API_URL in Railway.");
}

async function transcribeUserSpeech(guild, userId, outputChannelId, opusStream) {
  const decoder = new prism.opus.Decoder({ rate: 16000, channels: 1, frameSize: 960 });
  const pcmChunks = [];

  return new Promise((resolve, reject) => {
    opusStream.pipe(decoder);

    opusStream.on("error", reject);
    decoder.on("error", reject);
    decoder.on("data", (chunk) => {
      pcmChunks.push(chunk);
    });

    decoder.on("end", async () => {
      try {
        const pcmBuffer = Buffer.concat(pcmChunks);
        if (pcmBuffer.length === 0) {
          resolve("");
          return;
        }

        const fileName = `${guild.id}-${userId}-${Date.now()}.wav`;
        const audioPath = path.join(voiceTempDir, fileName);
        await fs.promises.writeFile(audioPath, Buffer.concat([buildWavHeader(pcmBuffer.length), pcmBuffer]));

        const text = await transcribeAudioFile(audioPath);
        await fs.promises.unlink(audioPath).catch(() => null);
        resolve(text);
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function cleanupVoiceSession(guildId) {
  const session = voiceSessions.get(guildId);
  if (!session) return;

  try {
    session.connection.destroy();
  } catch (error) {
    console.error("Failed to destroy voice connection:", error);
  }

  voiceSessions.delete(guildId);
}

async function startVoiceSession(interaction) {
  if (!interaction.guild) {
    return { ok: false, message: "서버에서만 쓸 수 있다냥." };
  }

  const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  const voiceChannel = member?.voice?.channel;
  if (!voiceChannel) {
    return { ok: false, message: "음성채팅에 먼저 들어가 있어야 한다냥." };
  }

  await cleanupVoiceSession(interaction.guild.id);

  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: interaction.guild.id,
    adapterCreator: interaction.guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: true,
  });

  await entersState(connection, VoiceConnectionStatus.Ready, 20_000);

  const session = {
    connection,
    outputChannelId: interaction.channelId,
    guildId: interaction.guild.id,
    activeUsers: new Set(),
  };

  voiceSessions.set(interaction.guild.id, session);

  connection.receiver.speaking.on("start", async (userId) => {
    if (session.activeUsers.has(userId)) return;
    if (userId === client.user.id) return;
    session.activeUsers.add(userId);

    try {
      const outputChannel = await interaction.guild.channels.fetch(session.outputChannelId).catch(() => null);
      if (outputChannel && outputChannel.isTextBased()) {
        const memberTag = interaction.guild.members.cache.get(userId)?.user?.tag || userId;
        await outputChannel.send({ content: `🎙️ ${memberTag} 말하는 중... 인식 시작한다냥.` });
      }

      const opusStream = connection.receiver.subscribe(userId, {
        end: { behavior: EndBehaviorType.AfterSilence, duration: 1000 },
      });
      const text = await transcribeUserSpeech(interaction.guild, userId, session.outputChannelId, opusStream);

      if (outputChannel && outputChannel.isTextBased()) {
        const memberTag = interaction.guild.members.cache.get(userId)?.user?.tag || userId;
        if (!text) {
          await outputChannel.send({ content: `🗣️ ${memberTag} 말은 들었는데 인식 결과가 비어 있다냥.` });
        } else {
          await outputChannel.send({ content: `🗣️ ${memberTag}: ${text}` });
        }
      }
    } catch (error) {
      console.error("Voice transcription failed:", error);
      const outputChannel = await interaction.guild.channels.fetch(session.outputChannelId).catch(() => null);
      if (outputChannel && outputChannel.isTextBased()) {
        await outputChannel.send({ content: `⚠️ 음성 인식 실패했다냥: ${error.message || error}` }).catch(() => null);
      }
    } finally {
      session.activeUsers.delete(userId);
    }
  });

  connection.on("stateChange", (_, newState) => {
    if (
      newState.status === VoiceConnectionStatus.Disconnected ||
      newState.status === VoiceConnectionStatus.Destroyed
    ) {
      cleanupVoiceSession(interaction.guild.id).catch(() => null);
    }
  });

  return { ok: true, message: `음성채팅 ${voiceChannel.name}에 들어가서 듣기 시작했다냥.` };
}

async function sendStickerByNameToChannel(guild, channelId, stickerName) {
  const channel = await guild.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) {
    throw new Error(`Channel ${channelId} not found or is not a text channel.`);
  }

  const stickers = await guild.stickers.fetch();
  const sticker = stickers.find((s) => s.name === stickerName);

  if (!sticker) {
    throw new Error(`Sticker ${stickerName} not found in guild.`);
  }

  await channel.send({ stickers: [sticker.id] });
  return sticker;
}

function getSeoulDateKey(date = new Date()) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function getMsUntilMidnightSeoul() {
  const now = new Date();
  // 현재 서울 시각을 구한다 (년/월/일 기준)
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const [year, month, day] = formatter.format(now).split("-").map(Number);
  // 다음 자정 = 오늘 날짜 + 1일 00:00:00 KST (= UTC+9)
  const midnightKST = new Date(Date.UTC(year, month - 1, day + 1, 0, 0, 0) - 9 * 60 * 60 * 1000);
  return midnightKST.getTime() - now.getTime();
}

function readRouletteUsage() {
  try {
    if (!fs.existsSync(rouletteUsagePath)) {
      return { date: getSeoulDateKey(), users: {} };
    }

    const raw = fs.readFileSync(rouletteUsagePath, "utf8");
    const parsed = JSON.parse(raw || "{}");
    if (!parsed.date || typeof parsed.users !== "object" || !parsed.users) {
      return { date: getSeoulDateKey(), users: {} };
    }

    if (parsed.date !== getSeoulDateKey()) {
      return { date: getSeoulDateKey(), users: {} };
    }

    return parsed;
  } catch (error) {
    console.error("Failed to read roulette usage:", error);
    return { date: getSeoulDateKey(), users: {} };
  }
}

function writeRouletteUsage(data) {
  try {
    fs.writeFileSync(rouletteUsagePath, JSON.stringify(data, null, 2), "utf8");
  } catch (error) {
    console.error("Failed to write roulette usage:", error);
  }
}

function consumeRouletteQuota(userId) {
  const today = getSeoulDateKey();
  const usage = readRouletteUsage();

  if (usage.date !== today) {
    usage.date = today;
    usage.users = {};
  }

  const currentCount = Number(usage.users[userId] || 0);
  if (currentCount >= rouletteDailyLimit) {
    return { allowed: false, remaining: 0 };
  }

  usage.users[userId] = currentCount + 1;
  writeRouletteUsage(usage);

  return { allowed: true, remaining: rouletteDailyLimit - usage.users[userId] };
}

function resetRouletteQuotaForUser(userId) {
  const usage = readRouletteUsage();
  const today = getSeoulDateKey();

  if (usage.date !== today) {
    usage.date = today;
    usage.users = {};
  }

  delete usage.users[userId];
  writeRouletteUsage(usage);
}

function isAdminInteraction(interaction) {
  return Boolean(interaction.memberPermissions?.has("Administrator"));
}

async function maybeAwardRandomRole(interaction) {
  if (!randomRoleId) return false;
  if (!interaction.guild) return false;
  if (!Number.isFinite(randomRoleChancePercent) || randomRoleChancePercent <= 0) return false;
  if (Math.random() * 100 >= randomRoleChancePercent) return false;

  try {
    const member = await interaction.guild.members.fetch(interaction.user.id);
    const role = await interaction.guild.roles.fetch(randomRoleId);
    const botMember = interaction.guild.members.me;

    if (!role) {
      console.error(`Random role ${randomRoleId} not found.`);
      return false;
    }

    if (!botMember) {
      console.error("Bot member could not be resolved in guild.");
      return false;
    }

    if (!botMember.permissions.has("ManageRoles")) {
      console.error("Bot is missing Manage Roles permission.");
      return false;
    }

    if (!role.editable) {
      console.error(`Role ${role.name} is not editable by the bot. Move the bot role above ${role.name}.`);
      return false;
    }

    if (member.roles.cache.has(role.id)) {
      return true;
    }

    await member.roles.add(role.id);
    console.log(`Random role awarded: ${role.name} -> ${interaction.user.tag}`);
    return true;
  } catch (error) {
    console.error("Failed to award random role:", error);
    return false;
  }
}

function scheduleRouletteRoleRemoval(guildId, userId, roleId, delayMs = rouletteRoleRemovalDelayMs) {
  const timerKey = `${guildId}:${userId}:${roleId}`;
  const existingTimer = rouletteRemovalTimers.get(timerKey);

  if (existingTimer) {
    clearTimeout(existingTimer);
  }

  const timer = setTimeout(async () => {
    rouletteRemovalTimers.delete(timerKey);

    try {
      const guild = await client.guilds.fetch(guildId).catch(() => null);
      if (!guild) {
        console.error(`Guild ${guildId} not found for roulette role removal.`);
        return;
      }

      const member = await guild.members.fetch(userId).catch(() => null);
      if (!member) {
        console.error(`Member ${userId} not found for roulette role removal.`);
        return;
      }

      const role = await guild.roles.fetch(roleId);
      if (!role) {
        console.error(`Role ${roleId} not found for roulette role removal.`);
        return;
      }

      if (member.roles.cache.has(role.id)) {
        await member.roles.remove(role.id);
        console.log(`Roulette role removed after delay: ${role.name} -> ${member.user.tag}`);
      }
    } catch (error) {
      console.error("Failed to remove roulette role after delay:", error);
    }
  }, delayMs);

  rouletteRemovalTimers.set(timerKey, timer);
}

async function runRoulette(interaction) {
  if (!interaction.guild) {
    return { success: false, message: "여긴 서버에서만 되는 거다냥!" };
  }

  if (!randomRoleId) {
    return { success: false, message: "RANDOM_ROLE_ID 설정이 비어 있다냥." };
  }

  if (!Number.isFinite(randomRoleChancePercent) || randomRoleChancePercent <= 0) {
    return { success: false, message: "확률 값이 이상하다냥. 설정 다시 봐라냥." };
  }

    if (!Number.isFinite(rouletteRoleRemovalDelayMs) || rouletteRoleRemovalDelayMs < 0) {
      return { success: false, message: "역할 제거 시간 값이 이상하다냥." };
    }

  const roll = Math.random() * 100;
  
  if (roll < randomRoleChancePercent) {
    try {
      const member = await interaction.guild.members.fetch(interaction.user.id);
      const role = await interaction.guild.roles.fetch(randomRoleId);
      const botMember = interaction.guild.members.me;

      if (!role) {
        return { success: false, message: "❌ **꽝이다냥!** 지정한 역할이 안 보인다냥." };
      }

      if (!botMember) {
        return { success: true, message: "🎀 **당첨이다냥!** 근데 봇 멤버 확인이 안 돼서 역할은 못 줬다냥." };
      }

      if (!botMember.permissions.has("ManageRoles")) {
        return { success: true, message: "🎀 **당첨이다냥!** 근데 역할 관리 권한이 없어서 못 줬다냥." };
      }

      if (!role.editable) {
        return { success: true, message: `🎀 **당첨이다냥!** 근데 봇 역할이 \`${role.name}\`보다 아래라서 못 줬다냥.` };
      }

      if (!member.roles.cache.has(role.id)) {
        try {
          await member.roles.add(role.id);
        } catch (roleError) {
          console.error("Failed to add roulette role:", roleError);
          return { success: true, message: `🎀 **당첨이다냥!** ${role.name} 지급은 실패했지만 당첨은 인정이다냥.` };
        }

        return {
          success: true,
          message: `🎀 **당첨이다냥!** ${role.name} 역할 획득했다냥!`,
          grantedRoleId: role.id,
          removalDelayMs: getMsUntilMidnightSeoul()
        };
      }

      return { success: true, message: `🎀 **당첨이다냥!** 이미 ${role.name} 역할 가지고 있다냥.` };
    } catch (error) {
      console.error("Failed to run roulette:", error);
      return { success: true, message: "🎀 **당첨이다냥!** 근데 역할 지급 중에 문제 터졌다냥." };
    }
  } else if (loseRoleId && roll >= 100 - loseRoleChancePercent) {
    try {
      const member = await interaction.guild.members.fetch(interaction.user.id);
      const role = await interaction.guild.roles.fetch(loseRoleId);
      const botMember = interaction.guild.members.me;

      if (!role || !botMember || !botMember.permissions.has("ManageRoles") || !role.editable) {
        return { success: false, message: "💀 **유배 확정이다냥!** 근데 냥이가 유배 보낼 권한이 없다냥. 운 좋은 줄 알아라냥." };
      }

      if (!member.roles.cache.has(role.id)) {
        await member.roles.add(role.id);
        return {
          success: false,
          message: `💀 **유배 확정이다냥!** 짐 싸서 당장 떠나라냥!`,
          grantedRoleId: role.id,
          removalDelayMs: loseRoleRemovalDelayMs,
          isPenalty: true
        };
      }
      return { success: false, message: `💀 **유배 확정이다냥!** 이미 유배 중이면서 또 가고 싶냐냥? `, isPenalty: true };
    } catch (error) {
      console.error("Failed to run penalty roulette:", error);
      return { success: false, message: "💀 **유배 확정이다냥!** 근데 유배 보내다가 시스템 문제 터졌다냥." };
    }
  }

  return { success: false, message: `❌ **꽝이다냥!**` };
}

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(token);
  await rest.put(Routes.applicationGuildCommands(clientId, guildId), {
    body: commands,
  });
  console.log(`Registered commands for guild ${guildId}: /안녕, /2시, /2시테스트, /룰렛, /룰렛초기화`);
}

client.once("ready", async () => {
  try {
    await registerCommands();
    console.log("Slash commands registered.");
  } catch (error) {
    console.error("Failed to register slash commands:", error);
  }

  console.log(`Logged in as ${client.user.tag}`);

  // Schedule to run at 2:00 AM every day (server timezone)
  cron.schedule("0 2 * * *", async () => {
    console.log("Running daily sticker job...");
    if (!dailyChannelId || dailyChannelId === "여기에_보낼_채널_아이디_입력") {
      console.log("DAILY_CHANNEL_ID is not configured. Skipping.");
      return;
    }

    try {
      const guild = await client.guilds.fetch(guildId).catch(() => null);
      if (!guild) {
        console.error(`Guild ${guildId} not found.`);
        return;
      }

      await sendStickerByNameToChannel(guild, dailyChannelId, dailyStickerName);
      console.log(`Successfully sent sticker ${dailyStickerName} to channel ${dailyChannelId}`);
    } catch (error) {
      console.error("Error in daily sticker job:", error);
    }
  }, { timezone: dailyCronTimezone });
  console.log(`Daily 2:00 AM sticker job scheduled. timezone=${dailyCronTimezone}`);
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "안녕") {
    await interaction.reply("<:ema:1463844904307261450> 냥! 쫀냥이 등장이다냥~");
    await maybeAwardRandomRole(interaction);
  }

  if (interaction.commandName === "2시") {
    try {
      const guild = interaction.guild;
      if (!guild) {
        await interaction.reply({ content: "서버에서만 쓸 수 있다냥.", flags: 64 });
        return;
      }

      await sendStickerByNameToChannel(guild, interaction.channelId, dailyStickerName);
      await interaction.reply({ content: `스티커 발사 완료다냥: ${dailyStickerName}`, flags: 64 });
      await maybeAwardRandomRole(interaction);
    } catch (error) {
      console.error("2시 명령어 실행 중 오류:", error);
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content: "문제가 생겼다냥.", flags: 64 });
      } else {
        await interaction.reply({ content: "스티커 가져오다가 문제 생겼다냥.", flags: 64 });
      }
    }
    return;
  }

  if (interaction.commandName === "2시테스트") {
    try {
      const guild = interaction.guild;
      if (!guild) {
        await interaction.reply({ content: "서버에서만 쓸 수 있다냥.", flags: 64 });
        return;
      }

      await sendStickerByNameToChannel(guild, interaction.channelId, dailyStickerName);
      await interaction.reply({ content: `테스트 발사 끝났다냥: ${dailyStickerName}`, flags: 64 });
      await maybeAwardRandomRole(interaction);
    } catch (error) {
      console.error("2시테스트 명령어 실행 중 오류:", error);
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content: "테스트 중 문제 생겼다냥.", flags: 64 });
      } else {
        await interaction.reply({ content: "테스트 중 문제 생겼다냥.", flags: 64 });
      }
    }
    return;
  }

  if (interaction.commandName === "음성입장") {
    try {
      const result = await startVoiceSession(interaction);
      await interaction.reply({ content: result.message, flags: 64 });
    } catch (error) {
      console.error("음성입장 명령어 실행 중 오류:", error);
      await interaction.reply({ content: "음성채팅에 들어가는 중 문제가 생겼다냥.", flags: 64 });
    }
    return;
  }

  if (interaction.commandName === "음성퇴장") {
    try {
      if (interaction.guild) {
        await cleanupVoiceSession(interaction.guild.id);
      }
      await interaction.reply({ content: "음성채팅 듣기를 멈추고 나왔다냥.", flags: 64 });
    } catch (error) {
      console.error("음성퇴장 명령어 실행 중 오류:", error);
      await interaction.reply({ content: "음성채팅에서 나오는 중 문제가 생겼다냥.", flags: 64 });
    }
    return;
  }

  if (interaction.commandName === "룰렛") {
    const member = await interaction.guild?.members.fetch(interaction.user.id).catch(() => null);
    if (member && loseRoleId && member.roles.cache.has(loseRoleId)) {
      const penaltyMsg = "❌ 유배 간 죄인은 룰렛 못 돌린다냥! 반성이나 해라냥!";
      await interaction.reply({ content: `${interaction.user} | ${penaltyMsg}` });
      return;
    }

    if (!isAdminInteraction(interaction)) {
      const quota = consumeRouletteQuota(interaction.user.id);
      if (!quota.allowed) {
        const limitMsg = `❌ 오늘은 이미 ${rouletteDailyLimit}번 돌렸다냥. 내일 다시 와라냥.`;
        await interaction.reply({ content: `${interaction.user} | ${limitMsg}` });
        return;
      }
    }

    const result = await runRoulette(interaction);
    const publicMessage = `${interaction.user} | ${result.message}`;

    if (result.success) {
      await interaction.reply({ content: publicMessage });

      if (result.grantedRoleId && (result.removalDelayMs || rouletteRoleRemovalDelayMs) > 0) {
        scheduleRouletteRoleRemoval(interaction.guildId, interaction.user.id, result.grantedRoleId, result.removalDelayMs || rouletteRoleRemovalDelayMs);
      }

      return;
    }

    await interaction.reply({ content: publicMessage });

    if (result.grantedRoleId && (result.removalDelayMs || rouletteRoleRemovalDelayMs) > 0) {
      scheduleRouletteRoleRemoval(interaction.guildId, interaction.user.id, result.grantedRoleId, result.removalDelayMs || rouletteRoleRemovalDelayMs);
    }

    return;
  }

  if (interaction.commandName === "룰렛초기화") {
    if (!isAdminInteraction(interaction)) {
      await interaction.reply({ content: "❌ 관리자만 쓸 수 있다냥." });
      return;
    }

    const targetUser = interaction.options.getUser("대상");
    if (!targetUser) {
      await interaction.reply({ content: "❌ 초기화할 대상을 못 찾았다냥." });
      return;
    }

    resetRouletteQuotaForUser(targetUser.id);
    await interaction.reply({ content: `✅ ${targetUser.tag} 오늘 룰렛 횟수 초기화 끝났다냥.` });
    return;
  }

  if (interaction.commandName === "패뽑기") {
    const tileTypes = [
      ...Array.from({ length: 9 }, (_, i) => ({ label: `${i + 1}만`, emoji: `${i + 1}m`, suit: 0, num: i + 1 })),
      ...Array.from({ length: 9 }, (_, i) => ({ label: `${i + 1}통`, emoji: `${i + 1}p`, suit: 1, num: i + 1 })),
      ...Array.from({ length: 9 }, (_, i) => ({ label: `${i + 1}삭`, emoji: `${i + 1}s`, suit: 2, num: i + 1 })),
      { label: "동", emoji: "1z", suit: 3, num: 1 }, { label: "남", emoji: "2z", suit: 3, num: 2 },
      { label: "서", emoji: "3z", suit: 3, num: 3 }, { label: "북", emoji: "4z", suit: 3, num: 4 },
      { label: "백", emoji: "5z", suit: 3, num: 5 }, { label: "발", emoji: "6z", suit: 3, num: 6 },
      { label: "중", emoji: "7z", suit: 3, num: 7 },
    ];
    // 각 패 4장씩 136장 덱 생성
    const deck = tileTypes.flatMap((t) => [t, t, t, t]);
    // Fisher-Yates 셔플 후 13장 뽑기
    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    const hand = deck.slice(0, 13);
    // 만→통→삭→자패, 숫자 오름차순 정렬
    hand.sort((a, b) => a.suit - b.suit || a.num - b.num);

    // 서버 커스텀 이모지 가져오기
    let emojiMap = new Map();
    if (interaction.guild) {
      const guildEmojis = await interaction.guild.emojis.fetch().catch(() => null);
      if (guildEmojis) {
        guildEmojis.forEach((e) => emojiMap.set(e.name, `<:${e.name}:${e.id}>`));
      }
    }

    const handStr = hand.map((t) => emojiMap.get(t.emoji) || t.label).join("");
    await interaction.reply({ content: `🀄 뽑은 손패다냥!\n${handStr}\n어떤 역을 노릴지는 네 자유다냥~` });
    return;
  }

  if (interaction.commandName === "타패추천") {
    const tileTypes = [
      ...Array.from({ length: 9 }, (_, i) => ({ label: `${i + 1}만`, emoji: `${i + 1}m` })),
      ...Array.from({ length: 9 }, (_, i) => ({ label: `${i + 1}통`, emoji: `${i + 1}p` })),
      ...Array.from({ length: 9 }, (_, i) => ({ label: `${i + 1}삭`, emoji: `${i + 1}s` })),
      { label: "동", emoji: "1z" }, { label: "남", emoji: "2z" },
      { label: "서", emoji: "3z" }, { label: "북", emoji: "4z" },
      { label: "백", emoji: "5z" }, { label: "발", emoji: "6z" },
      { label: "중", emoji: "7z" },
    ];

    let emojiMap = new Map();
    if (interaction.guild) {
      const guildEmojis = await interaction.guild.emojis.fetch().catch(() => null);
      if (guildEmojis) {
        guildEmojis.forEach((e) => emojiMap.set(e.name, `<:${e.name}:${e.id}>`));
      }
    }

    const dropTile = tileTypes[Math.floor(Math.random() * tileTypes.length)];
    const tileDisplay = emojiMap.get(dropTile.emoji) || dropTile.label;
    await interaction.reply({ content: `🀄 이번엔 **${tileDisplay}**를 버려라냥! 책임은 안 진다냥~` });
    return;
  }

  if (interaction.commandName === "역조합") {
    const yakuList = [
      // 1판
      { name: "리치", han: "1판", desc: "멘젠 텐파이 후 리치 선언이다냥! 기본 중의 기본이냥!" },
      { name: "멘젠쯔모", han: "1판", desc: "멘젠으로 쓰모 화료냥! 리치 없어도 된다냥!" },
      { name: "핑후", han: "1판", desc: "멘젠 슌쯔 조합 + 양면 대기냥! 깔끔하냥!" },
      { name: "탕야오", han: "1판", desc: "2~8 수패만으로 승부다냥! 자패 다 버려라냥!" },
      { name: "이페코", han: "1판", desc: "같은 슌쯔 두 세트냥! 멘젠 한정이다냥!" },
      { name: "역패 (백)", han: "1판", desc: "백을 커쯔 하나만 해도 역이다냥! 간단하냥!" },
      { name: "역패 (발)", han: "1판", desc: "발을 커쯔 하나만 해도 역이다냥! 초록이 좋다냥!" },
      { name: "역패 (중)", han: "1판", desc: "중을 커쯔 하나만 해도 역이다냥! 빨간 게 최고냥!" },
      { name: "역패 (자풍)", han: "1판", desc: "내 자리 바람패 커쯔냥! 자리마다 다르다냥!" },
      { name: "역패 (장풍)", han: "1판", desc: "현재 국 바람패 커쯔냥! 동장엔 동, 남장엔 남이다냥!" },
      { name: "영상개화", han: "1판", desc: "깡 후 영전패 뽑아서 화료냥! 운도 실력이냥!" },
      { name: "창깡", han: "1판", desc: "상대 가깡패에서 낚아채는 거다냥! 방심 금지냥!" },
      { name: "해저로월", han: "1판", desc: "마지막 수패로 쓰모다냥! 끝까지 포기 금지냥!" },
      { name: "하저로어", han: "1판", desc: "마지막 버림패로 론이다냥! 배짱 승부냥!" },
      // 2판
      { name: "더블리치", han: "2판", desc: "첫 순에 바로 리치냥! 배포 있어야 쓸 수 있다냥!" },
      { name: "치또이즈", han: "2판", desc: "대자 7쌍이다냥! 독자적인 손패 구성이냥!" },
      { name: "삼색동순", han: "2판(오픈 1판)", desc: "세 종류에서 같은 숫자 슌쯔 세트냥! 깔끔하냥!" },
      { name: "일기통관", han: "2판(오픈 1판)", desc: "한 종류로 1~9 슌쯔 연결이다냥! 개인기냥!" },
      { name: "찬타", han: "2판(오픈 1판)", desc: "모든 세트에 1·9·자패 포함이냥!" },
      { name: "산안커", han: "2판", desc: "커쯔 세 세트를 자력으로냥! 어렵지만 값지다냥!" },
      { name: "삼색동각", han: "2판", desc: "세 종류에서 같은 숫자 커쯔냥! 숨은 고수냥!" },
      { name: "산깡즈", han: "2판", desc: "깡을 세 번이나 하는 거다냥! 용감하냥!" },
      { name: "또이또이", han: "2판", desc: "전부 커쯔냥! 슌쯔 한 세트도 없다냥!" },
      { name: "소삼원", han: "2판", desc: "삼원패 두 커쯔 + 한 쌍이냥! 대삼원 전 단계냥!" },
      { name: "혼노두", han: "2판", desc: "1·9·자패만으로 전부 커쯔냥! 또이또이나 치또이즈랑 같이 나온다냥!" },
      // 3판
      { name: "혼일색", han: "3판(오픈 2판)", desc: "한 종류 수패 + 자패만이냥! 패 고르기가 핵심냥!" },
      { name: "준찬타", han: "3판(오픈 2판)", desc: "모든 세트에 1이나 9만 넣는 거냥! 깐깐하냥!" },
      { name: "량페코", han: "3판", desc: "이페코 두 세트냥! 멘젠 한정이냥! 진짜 멋지다냥!" },
      // 6판
      { name: "청일색", han: "6판(오픈 5판)", desc: "한 종류 수패만으로 화료냥!! 화려하다냥!!" },
      // 역만
      { name: "천화", han: "역만", desc: "동가 배패 직후 바로 화료냥!! 태어날 때부터 역만이냥!!" },
      { name: "지화", han: "역만", desc: "자가 첫 쓰모로 바로 화료냥!! 하늘 아래 땅도 역만이냥!!" },
      { name: "국사무쌍", han: "역만", desc: "1·9·자패 13종 + 1장 대기냥!! 고독하지만 강하다냥!!" },
      { name: "쓰안커", han: "역만", desc: "커쯔 네 세트 전부 자력으로냥!! 아무도 못 막는다냥!!" },
      { name: "대삼원", han: "역만", desc: "백·발·중 세 종류 전부 커쯔냥!! 삼원패 완전 제압이냥!!" },
      { name: "소사희", han: "역만", desc: "동남서북 중 셋은 커쯔, 하나는 쌍이냥!! 바람의 역만이냥!!" },
      { name: "자일색", han: "역만", desc: "자패만으로 화료냥!! 수패 한 장도 없다냥!!" },
      { name: "녹일색", han: "역만", desc: "2·3·4·6·8삭 + 발만으로 화료냥!! 온통 초록이냥!!" },
      { name: "청노두", han: "역만", desc: "1과 9 수패만으로 화료냥!! 극단의 역만이냥!!" },
      { name: "쓰깡즈", han: "역만", desc: "깡을 무려 네 번이냥!! 패산이 무너질 것 같다냥!!" },
      { name: "구련보등", han: "역만", desc: "한 종류로 1112345678999 + 1장 대기냥!! 꿈의 역이다냥!!" },
      // 더블 역만
      { name: "대사희", han: "더블 역만", desc: "동남서북 전부 커쯔냥!! 바람의 왕이다냥!!" },
      { name: "쓰안커 단기", han: "더블 역만", desc: "커쯔 네 세트 자력 + 단기 대기냥!! 최강의 폼이냥!!" },
      { name: "국사무쌍 13면", han: "더블 역만", desc: "13종 전부 대기냥!! 이건 전설이다냥!!" },
      { name: "순정구련보등", han: "더블 역만", desc: "구련보등 9면 대기냥!! 이런 손패가 실제로 온다고?냥!!" },
    ];
    const yaku = yakuList[Math.floor(Math.random() * yakuList.length)];
    await interaction.reply({ content: `🀄 오늘의 역은 **${yaku.name}** (${yaku.han})이다냥!\n${yaku.desc}` });
    return;
  }
});

process.on("unhandledRejection", (error) => {
  console.error("Unhandled promise rejection:", error);
});

client.login(token).catch((error) => {
  if (error && error.code === "TokenInvalid") {
    console.error("DISCORD_TOKEN is invalid. Reset the token in Discord Developer Portal and update .env.");
    return;
  }

  console.error("Failed to login:", error);
});
