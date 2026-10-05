// Player-facing commands: /link, /unlink, /pigeon, and /whois (staff).
import { EmbedBuilder, SlashCommandBuilder } from "discord.js";
import { store } from "../store.js";
import { resolvePlayer } from "../features/resolve.js";
import { sendPigeonFromDiscord, MAX_LETTER } from "../features/pigeons.js";
import { applyRoles } from "../features/ranks.js";
import { profileUrl } from "../roblox/users.js";
import type { Command } from "./types.js";

export const link: Command = {
  data: new SlashCommandBuilder().setName("link").setDescription("Link your Roblox account (keeps your branch roles in sync)."),
  async execute(i) {
    const existing = store.linkByDiscord(i.user.id);
    const code = store.createCode(i.user.id);
    await i.reply({
      ephemeral: true,
      content:
        (existing ? `You're currently linked to **${existing.robloxName}**. Linking again replaces it.\n\n` : "") +
        `Join the game and type this in chat within 10 minutes:\n\`\`\`/link ${code}\`\`\``,
    });
  },
};

export const unlink: Command = {
  data: new SlashCommandBuilder().setName("unlink").setDescription("Unlink your Roblox account."),
  async execute(i) {
    const removed = store.removeLink(i.user.id);
    if (removed) await applyRoles(i.user.id, undefined, undefined).catch(() => undefined);
    await i.reply({ ephemeral: true, content: removed ? `Unlinked **${removed.robloxName}**.` : "You aren't linked." });
  },
};

export const pigeon: Command = {
  data: new SlashCommandBuilder()
    .setName("pigeon")
    .setDescription("Send a messenger pigeon to someone in game.")
    .addStringOption((o) => o.setName("to").setDescription("Their Roblox username").setRequired(true))
    .addStringOption((o) => o.setName("message").setDescription("Your letter").setRequired(true).setMaxLength(MAX_LETTER)),
  async execute(i) {
    await i.deferReply({ ephemeral: true });
    const target = await resolvePlayer(i.options.getString("to", true));
    if (!target) {
      await i.editReply("No Roblox user by that name.");
      return;
    }
    const error = await sendPigeonFromDiscord(i.user, target.id, target.name, i.options.getString("message", true)).catch(
      (err) => `The pigeon couldn't take off: ${err instanceof Error ? err.message : err}`,
    );
    await i.editReply(error ?? `🕊️ Your pigeon is flying to **${target.name}**. They'll get it next time they're in game (or right away if they're on).`);
  },
};

export const whois: Command = {
  staff: true,
  data: new SlashCommandBuilder()
    .setName("whois")
    .setDescription("Show the Roblox / Discord link for someone.")
    .addStringOption((o) => o.setName("player").setDescription("Roblox username, user id, or @member").setRequired(true)),
  async execute(i) {
    const target = await resolvePlayer(i.options.getString("player", true));
    const link = target ? store.linkByRoblox(target.id) : undefined;
    if (!target) {
      await i.reply({ ephemeral: true, content: "Not found (Discord members must be linked)." });
      return;
    }
    await i.reply({
      ephemeral: true,
      embeds: [
        new EmbedBuilder()
          .setTitle(target.name)
          .setURL(profileUrl(target.id))
          .setDescription(link ? `Linked to <@${link.discordId}> since <t:${Math.floor(link.linkedAt / 1000)}:D>` : "Not linked to Discord.")
          .setFooter({ text: `Roblox id ${target.id}` }),
      ],
    });
  },
};
