require("dotenv").config();

const http = require("http");

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
  intents: [GatewayIntentBits.Guilds],
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
];

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(token);
  await rest.put(Routes.applicationGuildCommands(clientId, guildId), {
    body: commands,
  });
  console.log(`Registered commands for guild ${guildId}: /안녕`);
}

client.once("ready", async () => {
  try {
    await registerCommands();
    console.log("Slash commands registered.");
  } catch (error) {
    console.error("Failed to register slash commands:", error);
  }

  console.log(`Logged in as ${client.user.tag}`);
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "안녕") {
    await interaction.reply("<:ema:1463844904307261450>");
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
