require("dotenv").config();

const http = require("http");
const fs = require("fs");
const path = require("path");
const cron = require("node-cron");

const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
} = require("discord.js");

const token = (process.env.DISCORD_TOKEN || "").trim();
const clientId = (process.env.DISCORD_CLIENT_ID || "").trim();
const guildId = (process.env.DISCORD_GUILD_ID || "").trim();
const dailyStickerName = (process.env.DAILY_STICKER_NAME || "Emaclock").trim();
const dailyChannelId = (process.env.DAILY_CHANNEL_ID || "").trim();
const dailyCronTimezone = (process.env.DAILY_TIMEZONE || "Asia/Seoul").trim();
const randomRoleId = (process.env.RANDOM_ROLE_ID || "").trim();
const randomRoleChancePercent = Number(process.env.RANDOM_ROLE_CHANCE_PERCENT || 10);
const rouletteUsagePath = path.join(__dirname, "..", "roulette_usage.json");
const rouletteDailyLimit = Number(process.env.ROULETTE_DAILY_LIMIT || 3);
const rouletteRemovalTimers = new Map();
const rouletteRoleRemovalDelayMs = Number(process.env.ROULETTE_ROLE_REMOVAL_DELAY_MS || 5 * 60 * 1000);

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
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
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
];

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
  if (roll >= randomRoleChancePercent) {
    return { success: false, message: `❌ **꽝이다냥!** (확률 ${randomRoleChancePercent}%)` };
  }

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
        message: `🎀 **당첨이다냥!** ${role.name} 역할 획득했다냥! (확률 ${randomRoleChancePercent}%)`,
        grantedRoleId: role.id,
      };
    }

    return { success: true, message: `🎀 **당첨이다냥!** 이미 ${role.name} 역할 가지고 있다냥. (확률 ${randomRoleChancePercent}%)` };
  } catch (error) {
    console.error("Failed to run roulette:", error);
    return { success: true, message: "🎀 **당첨이다냥!** 근데 역할 지급 중에 문제 터졌다냥." };
  }
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
    await interaction.reply("<:ema:1463844904307261450> 냥! 이치히메 등장이다냥~");
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

  if (interaction.commandName === "룰렛") {
    if (!isAdminInteraction(interaction)) {
      const quota = consumeRouletteQuota(interaction.user.id);
      if (!quota.allowed) {
        await interaction.reply({ content: `❌ 오늘은 이미 ${rouletteDailyLimit}번 돌렸다냥. 내일 다시 와라냥.`, flags: 64 });
        return;
      }
    }

    const result = await runRoulette(interaction);
    const publicMessage = `${interaction.user} | ${result.message}`;

    if (result.success) {
      await interaction.reply({ content: result.message, flags: 64 });

      if (interaction.channel?.isTextBased()) {
        interaction.channel.send({ content: publicMessage }).catch((error) => {
          console.error("Failed to post roulette success message to channel:", error);
        });
      }

      if (result.grantedRoleId && rouletteRoleRemovalDelayMs > 0) {
        scheduleRouletteRoleRemoval(interaction.guildId, interaction.user.id, result.grantedRoleId);
      }

      return;
    }

    await interaction.reply({ content: result.message, flags: 64 });

    if (interaction.channel?.isTextBased()) {
      interaction.channel.send({ content: publicMessage }).catch((error) => {
        console.error("Failed to post roulette failure message to channel:", error);
      });
    }

    return;
  }

  if (interaction.commandName === "룰렛초기화") {
    if (!isAdminInteraction(interaction)) {
      await interaction.reply({ content: "❌ 관리자만 쓸 수 있다냥.", flags: 64 });
      return;
    }

    const targetUser = interaction.options.getUser("대상");
    if (!targetUser) {
      await interaction.reply({ content: "❌ 초기화할 대상을 못 찾았다냥.", flags: 64 });
      return;
    }

    resetRouletteQuotaForUser(targetUser.id);
    await interaction.reply({ content: `✅ ${targetUser.tag} 오늘 룰렛 횟수 초기화 끝났다냥.`, flags: 64 });
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
