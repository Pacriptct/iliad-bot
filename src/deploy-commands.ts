// Registers the slash commands in the main server and every branch server.
// Run after changing commands:  npm run build && npm run deploy-commands
import { REST, Routes } from "discord.js";
import { allGuilds, config, secrets } from "./config.js";
import { branchCommands, mainCommands } from "./commands/index.js";

const rest = new REST().setToken(secrets.discordToken);

for (const guildId of allGuilds()) {
  const isMain = guildId === config.guildId;
  const body = (isMain ? mainCommands : branchCommands).map((c) => c.data.toJSON());
  try {
    await rest.put(Routes.applicationGuildCommands(secrets.discordClientId, guildId), { body });
    console.log(`Registered ${body.length} commands in ${isMain ? "the main server" : "branch server"} ${guildId}.`);
  } catch (err) {
    console.error(`Couldn't register commands in ${guildId} (is the bot in that server?):`, err instanceof Error ? err.message : err);
  }
}
