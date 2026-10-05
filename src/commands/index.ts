// Command registry + interaction routing.
import { Events, type Client, type Interaction } from "discord.js";
import { config } from "../config.js";
import { log } from "../log.js";
import { allowed } from "./permissions.js";
import { link, unlink, pigeon, whois } from "./player.js";
import { lookup, kick, ban, unban, warn, voidCmd, rank } from "./moderation.js";
import { announce, servers, shutdown, restart, status } from "./server.js";
import type { Command } from "./types.js";

export const commands: Command[] = [
  link,
  unlink,
  pigeon,
  whois,
  lookup,
  kick,
  ban,
  unban,
  warn,
  voidCmd,
  rank,
  announce,
  servers,
  shutdown,
  restart,
  status,
];

const byName = new Map(commands.map((c) => [c.data.name, c]));

async function handle(interaction: Interaction) {
  if (interaction.isAutocomplete()) {
    if (interaction.commandName === "rank") {
      const branch = interaction.options.getString("branch") ?? "";
      const typed = interaction.options.getFocused().toLowerCase();
      const ranks = Object.keys(config.branches[branch]?.ranks ?? {});
      await interaction
        .respond(ranks.filter((r) => r.toLowerCase().includes(typed)).slice(0, 25).map((r) => ({ name: r, value: r })))
        .catch(() => undefined);
    }
    return;
  }
  if (!interaction.isChatInputCommand()) return;

  const command = byName.get(interaction.commandName);
  if (!command) return;
  if (command.staff && !allowed(interaction)) {
    await interaction.reply({ ephemeral: true, content: "You don't have permission to use this command." });
    return;
  }
  try {
    await command.execute(interaction);
  } catch (err) {
    log.error(`/${interaction.commandName} failed:`, err);
    const content = `Something went wrong: ${err instanceof Error ? err.message : err}`;
    if (interaction.deferred || interaction.replied) await interaction.editReply(content).catch(() => undefined);
    else await interaction.reply({ ephemeral: true, content }).catch(() => undefined);
  }
}

export function registerCommands(client: Client) {
  client.on(Events.InteractionCreate, (interaction) => {
    handle(interaction).catch((err) => log.error("interaction failed:", err));
  });
}
