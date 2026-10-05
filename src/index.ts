// Bot entrypoint.
import { Client, Events, GatewayIntentBits, Partials } from "discord.js";
import { config, secrets } from "./config.js";
import { log } from "./log.js";
import { registerServers } from "./bridge/servers.js";
import { startOutbox } from "./bridge/outbox.js";
import { startChannels } from "./features/channels.js";
import { registerLogs } from "./features/logs.js";
import { registerPd } from "./features/pd.js";
import { registerRanks } from "./features/ranks.js";
import { registerLinking } from "./features/linking.js";
import { registerPigeons } from "./features/pigeons.js";
import { registerCommands } from "./commands/index.js";

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.DirectMessages],
  partials: [Partials.Channel],
});

registerServers();
registerLogs();
registerPd();
registerRanks(client);
registerLinking(client);
registerPigeons(client);
registerCommands(client);

client.once(Events.ClientReady, async (c) => {
  log.info(`logged in as ${c.user.tag}`);
  const guild = await c.guilds.fetch(config.guildId).catch(() => undefined);
  if (!guild) {
    log.error(`not in guild ${config.guildId} — check guildId in config.json and invite the bot`);
  } else {
    // Cache members so rank-role changes are seen.
    await guild.members.fetch().catch((err) => log.warn("member fetch failed:", err.message));
  }
  startChannels(client);
  startOutbox();
});

process.on("unhandledRejection", (err) => log.error("unhandled rejection:", err));

client.login(secrets.discordToken);
