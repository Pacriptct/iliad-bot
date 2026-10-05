// Registers the slash commands in the configured guild. Run after changing commands:
//   npm run build && npm run deploy-commands
import { REST, Routes } from "discord.js";
import { config, secrets } from "./config.js";
import { commands } from "./commands/index.js";

const rest = new REST().setToken(secrets.discordToken);
const body = commands.map((c) => c.data.toJSON());

await rest.put(Routes.applicationGuildCommands(secrets.discordClientId, config.guildId), { body });
console.log(`Registered ${body.length} commands in guild ${config.guildId}.`);
