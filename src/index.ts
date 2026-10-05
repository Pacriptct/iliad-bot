// Bot entrypoint.
import { Client, Events, GatewayIntentBits, Partials } from "discord.js";
import { allGuilds, config, secrets } from "./config.js";
import { log } from "./log.js";
import { registerServers } from "./bridge/servers.js";
import { startOutbox } from "./bridge/outbox.js";
import { startChannels } from "./features/channels.js";
import { registerLogs } from "./features/logs.js";
import { registerPd } from "./features/pd.js";
import { registerRanks } from "./features/ranks.js";
import { registerLinking } from "./features/linking.js";
import { registerPigeons } from "./features/pigeons.js";
import { registerTransfers } from "./features/transfers.js";
import { registerAutoLink } from "./features/autolink.js";
import { registerMutes } from "./features/mutes.js";
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
registerTransfers(client);
registerAutoLink(client);
registerMutes(client);
registerCommands(client);

client.once(Events.ClientReady, async (c) => {
  log.info(`logged in as ${c.user.tag}`);
  for (const guildId of allGuilds()) {
    const guild = await c.guilds.fetch(guildId).catch(() => undefined);
    if (!guild) {
      log.error(`not in server ${guildId}${guildId === config.guildId ? " (main)" : ""} — check config.json and invite the bot there`);
      continue;
    }
    // Cache members so rank-role changes are seen.
    await guild.members.fetch().catch((err) => log.warn(`member fetch in ${guild.name} failed:`, err.message));
    log.info(`watching ${guild.name}`);
  }
  startChannels(client);
  startOutbox();
});

process.on("unhandledRejection", (err) => log.error("unhandled rejection:", err));

client.login(secrets.discordToken);
