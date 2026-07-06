require("dotenv").config();

const http = require("http");
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
    .setDescription("존냥아")
    .toJSON(),
  new SlashCommandBuilder()
    .setName("2시")
    .setDescription("2시라니..... 그렇게 밤늦게 일어나 있다니 이상해!")
    .toJSON(),
  new SlashCommandBuilder()
    .setName("2시테스트")
    .setDescription("지금 지정한 스티커를 즉시 테스트 전송합니다")
    .toJSON(),
  new SlashCommandBuilder()
    .setName("룰렛")
    .setDescription("일정 확률로 역할을 얻는 룰렛을 돌립니다")
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
    const botMember = interaction.guild.members.me;
    return true;
  } catch (error) {
    console.error("Failed to award random role:", error);
    return false;

    if (!botMember) {
      return { success: true, message: "성공! 하지만 봇 멤버를 확인할 수 없어 역할은 지급하지 못했습니다." };
    }

    if (!botMember.permissions.has("ManageRoles")) {
      return { success: true, message: "성공! 하지만 봇에 역할 관리 권한이 없어 역할은 지급하지 못했습니다." };
    }

    if (!role.editable) {
      return { success: true, message: `성공! 하지만 봇 역할이 \`${role.name}\`보다 아래에 있어 역할은 지급하지 못했습니다.` };
    }
  }
}

async function runRoulette(interaction) {
  if (!interaction.guild) {
    return { success: false, message: "서버에서만 사용할 수 있습니다." };
  }

  if (!randomRoleId) {
    return { success: false, message: "RANDOM_ROLE_ID가 설정되지 않았습니다." };
  }

  if (!Number.isFinite(randomRoleChancePercent) || randomRoleChancePercent <= 0) {
    return { success: false, message: "RANDOM_ROLE_CHANCE_PERCENT가 올바르지 않습니다." };
  }

  const roll = Math.random() * 100;
  if (roll >= randomRoleChancePercent) {
    return { success: false, message: `실패! (확률 ${randomRoleChancePercent}%)` };
  }

  try {
    const member = await interaction.guild.members.fetch(interaction.user.id);
    const role = await interaction.guild.roles.fetch(randomRoleId);

    if (!role) {
      return { success: false, message: "지정한 역할을 찾을 수 없습니다." };
    }

    if (!member.roles.cache.has(role.id)) {
      await member.roles.add(role.id);
    }

    return { success: true, message: `성공! ${role.name} 역할을 획득했습니다. (확률 ${randomRoleChancePercent}%)` };
  } catch (error) {
    console.error("Failed to run roulette:", error);
    return { success: false, message: "룰렛 처리 중 오류가 발생했습니다." };
  }
}

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(token);
  await rest.put(Routes.applicationGuildCommands(clientId, guildId), {
    body: commands,
  });
  console.log(`Registered commands for guild ${guildId}: /안녕, /2시, /2시테스트, /룰렛`);
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
    await interaction.reply("<:ema:1463844904307261450>");
    await maybeAwardRandomRole(interaction);
  }

  if (interaction.commandName === "2시") {
    try {
      const guild = interaction.guild;
      if (!guild) {
        await interaction.reply({ content: "서버에서만 사용할 수 있습니다.", flags: 64 });
        return;
      }

      await sendStickerByNameToChannel(guild, interaction.channelId, dailyStickerName);
      await interaction.reply({ content: `스티커 전송 완료: ${dailyStickerName}`, flags: 64 });
      await maybeAwardRandomRole(interaction);
    } catch (error) {
      console.error("2시 명령어 실행 중 오류:", error);
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content: "오류가 발생했습니다.", flags: 64 });
      } else {
        await interaction.reply({ content: "스티커를 가져오는 중 오류가 발생했습니다.", flags: 64 });
      }
    }
    return;
  }

  if (interaction.commandName === "2시테스트") {
    try {
      const guild = interaction.guild;
      if (!guild) {
        await interaction.reply({ content: "서버에서만 사용할 수 있습니다.", flags: 64 });
        return;
      }

      await sendStickerByNameToChannel(guild, interaction.channelId, dailyStickerName);
      await interaction.reply({ content: `테스트 전송 완료: ${dailyStickerName}`, flags: 64 });
      await maybeAwardRandomRole(interaction);
    } catch (error) {
      console.error("2시테스트 명령어 실행 중 오류:", error);
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content: "테스트 전송 실패", flags: 64 });
      } else {
        await interaction.reply({ content: "테스트 전송 실패", flags: 64 });
      }
    }
    return;
  }

  if (interaction.commandName === "룰렛") {
    const result = await runRoulette(interaction);
    const publicMessage = `${interaction.user} | ${result.message}`;

    if (result.success) {
      await interaction.reply({ content: result.message, flags: 64 });

      if (interaction.channel?.isTextBased()) {
        interaction.channel.send({ content: publicMessage }).catch((error) => {
          console.error("Failed to post roulette success message to channel:", error);
        });
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
