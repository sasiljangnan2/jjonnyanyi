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
const loseRoleId = (process.env.LOSE_ROLE_ID || "").trim();
const loseRoleChancePercent = Number(process.env.LOSE_ROLE_CHANCE_PERCENT || 10);
const rouletteUsagePath = path.join(__dirname, "..", "roulette_usage.json");
const rouletteDailyLimit = Number(process.env.ROULETTE_DAILY_LIMIT || 3);
const rouletteRemovalTimers = new Map();
const rouletteRoleRemovalDelayMs = Number(process.env.ROULETTE_ROLE_REMOVAL_DELAY_MS || 5 * 60 * 1000);
const loseRoleRemovalDelayMs = Number(process.env.LOSE_ROLE_REMOVAL_DELAY_MS || rouletteRoleRemovalDelayMs);

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
  new SlashCommandBuilder()
    .setName("타패추천")
    .setDescription("쫀냥이가 버릴 패를 골라준다냥!")
    .toJSON(),
  new SlashCommandBuilder()
    .setName("역조합")
    .setDescription("이치히메가 오늘 노릴 역을 골라준다냥!")
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

  if (interaction.commandName === "타패추천") {
    const tiles = [
      "1만", "2만", "3만", "4만", "5만", "6만", "7만", "8만", "9만",
      "1통", "2통", "3통", "4통", "5통", "6통", "7통", "8통", "9통",
      "1삭", "2삭", "3삭", "4삭", "5삭", "6삭", "7삭", "8삭", "9삭",
      "동", "남", "서", "북", "백", "발", "중"
    ];
    const dropTile = tiles[Math.floor(Math.random() * tiles.length)];
    await interaction.reply({ content: `🀄 이번엔 **${dropTile}** (을)를 버려라냥! 책임은 안 진다냥~` });
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
