// Player-facing commands: /link, /unlink, /pigeon, and /whois (staff).
import { EmbedBuilder, SlashCommandBuilder, MessageFlags } from "discord.js";
import { config } from "../config.js";
import { store } from "../store.js";
import { resolvePlayer } from "../features/resolve.js";
import { sendPigeonFromDiscord, MAX_LETTER } from "../features/pigeons.js";
import { applyRoles } from "../features/ranks.js";
import { ensureLinked } from "../features/autolink.js";
import { profileUrl } from "../roblox/users.js";
import type { Command } from "./types.js";

export const link: Command = {
  data: new SlashCommandBuilder().setName("link").setDescription("Link your Roblox account (keeps your branch roles in sync)."),
  async execute(i) {
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const before = store.linkByDiscord(i.user.id);
    // Verified with Bloxlink / RoVer? Then there's nothing to do.
    const auto = before ? undefined : await ensureLinked(i.user.id);
    if (auto) {
      await i.editReply(`✅ You're linked to Roblox **${auto.robloxName}** (from your ${config.autoLink.provider} verification). You're all set!`);
      return;
    }
    const code = store.createCode(i.user.id);
    await i.editReply(
      (before ? `You're linked to **${before.robloxName}**. To switch accounts, use the code below on the new one.\n\n` : "") +
        `Join the game and type this in chat within 10 minutes:\n\`\`\`/link ${code}\`\`\``,
    );
  },
};

export const unlink: Command = {
  data: new SlashCommandBuilder().setName("unlink").setDescription("Unlink your Roblox account."),
  async execute(i) {
    const removed = store.removeLink(i.user.id);
    if (removed) await applyRoles(i.user.id, undefined, undefined, false).catch(() => undefined);
    await i.reply({ flags: MessageFlags.Ephemeral, content: removed ? `Unlinked **${removed.robloxName}**.` : "You aren't linked." });
  },
};

export const pigeon: Command = {
  data: new SlashCommandBuilder()
    .setName("pigeon")
    .setDescription("Send a messenger pigeon to someone in game.")
    .addStringOption((o) => o.setName("to").setDescription("Their Roblox username").setRequired(true))
    .addStringOption((o) => o.setName("message").setDescription("Your letter").setRequired(true).setMaxLength(MAX_LETTER)),
  async execute(i) {
    await i.deferReply({ flags: MessageFlags.Ephemeral });
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
    const known = target ? store.rankOf(target.id) : undefined;
    if (!target) {
      await i.reply({ flags: MessageFlags.Ephemeral, content: "Not found (Discord members must be linked)." });
      return;
    }
    await i.reply({
      flags: MessageFlags.Ephemeral,
      embeds: [
        new EmbedBuilder()
          .setTitle(target.name)
          .setURL(profileUrl(target.id))
          .setDescription(
            (link ? `Linked to <@${link.discordId}> since <t:${Math.floor(link.linkedAt / 1000)}:D>` : "Not linked to Discord.") +
              (known?.branch ? `\nLast seen as **${known.rank ?? "—"}** in **${config.branches[known.branch]?.name ?? known.branch}**` : ""),
          )
          .setFooter({ text: `Roblox id ${target.id}` }),
      ],
    });
  },
};
