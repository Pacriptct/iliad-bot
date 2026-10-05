// Command registry + interaction routing.
//
// The main server gets every command. Each branch's own server gets the player
// commands plus a branch-scoped /rank for its officers (see branch.ts).
import { Events, type Client, type Interaction, MessageFlags } from "discord.js";
import { branchOfGuild, config } from "../config.js";
import { log } from "../log.js";
import { allowed } from "./permissions.js";
import { link, unlink, pigeon, whois } from "./player.js";
import { lookup, kick, ban, unban, warn, voidCmd, rank, mute, unmute, linkall } from "./moderation.js";
import { announce, servers, shutdown, restart, status, targetChoices } from "./server.js";
import { branchRank, officerLevel } from "./branch.js";
import { transferCmd } from "../features/transfers.js";
import { rankOrder } from "../features/ranks.js";
import type { Command } from "./types.js";

export const mainCommands: Command[] = [
  link,
  unlink,
  pigeon,
  whois,
  lookup,
  kick,
  ban,
  unban,
  warn,
  mute,
  unmute,
  voidCmd,
  rank,
  linkall,
  announce,
  servers,
  shutdown,
  restart,
  status,
];

export const branchCommands: Command[] = [link, unlink, pigeon, branchRank, transferCmd];

const mainByName = new Map(mainCommands.map((c) => [c.data.name, c]));
const branchByName = new Map(branchCommands.map((c) => [c.data.name, c]));

async function handle(interaction: Interaction) {
  const branch = branchOfGuild(interaction.guildId);

  if (interaction.isAutocomplete()) {
    if (!branch && (interaction.commandName === "restart" || interaction.commandName === "shutdown")) {
      await interaction.respond(targetChoices(interaction.commandName, interaction.options.getFocused())).catch(() => undefined);
      return;
    }
    if (interaction.commandName !== "rank" && interaction.commandName !== "transfer") return;
    const typed = interaction.options.getFocused().toLowerCase();
    let choices: string[];
    if (branch) {
      // Branch server: ranks below the officer's own, plus None (discharge).
      const { level } = officerLevel(interaction);
      choices = Object.keys(config.branches[branch].ranks).filter((r) => rankOrder(branch, r) < level);
      if (interaction.commandName === "rank") choices.push("None");
    } else {
      choices = Object.keys(config.branches[interaction.options.getString("branch") ?? ""]?.ranks ?? {});
    }
    await interaction
      .respond(choices.filter((r) => r.toLowerCase().includes(typed)).slice(0, 25).map((r) => ({ name: r, value: r })))
      .catch(() => undefined);
    return;
  }
  if (!interaction.isChatInputCommand()) return;

  const command = (branch ? branchByName : mainByName).get(interaction.commandName);
  if (!command) return;
  if (command.staff && !allowed(interaction)) {
    await interaction.reply({ flags: MessageFlags.Ephemeral, content: "You don't have permission to use this command." });
    return;
  }
  try {
    await command.execute(interaction);
  } catch (err) {
    log.error(`/${interaction.commandName} failed:`, err);
    const content = `Something went wrong: ${err instanceof Error ? err.message : err}`;
    if (interaction.deferred || interaction.replied) await interaction.editReply(content).catch(() => undefined);
    else await interaction.reply({ flags: MessageFlags.Ephemeral, content }).catch(() => undefined);
  }
}

export function registerCommands(client: Client) {
  client.on(Events.InteractionCreate, (interaction) => {
    handle(interaction).catch((err) => log.error("interaction failed:", err));
  });
}
