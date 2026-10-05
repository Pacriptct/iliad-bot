// Branch transfers.
//
//   1. An officer of the RECEIVING branch runs /transfer in their branch's server.
//   2. The bot posts the request, with Approve / Deny buttons, in the LEAVING
//      branch's transferChannel (or its rankLog, or the main server's ranks log).
//   3. An officer of the leaving branch who outranks the player (or that
//      server's Administrator, or main-server admin staff) decides.
//   4. On approval the player is moved in game (live, or on their next join) and
//      their roles follow in every server.
// Requests expire after 7 days.
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  Events,
  SlashCommandBuilder,
  type ButtonInteraction,
  type Client,
  MessageFlags,
} from "discord.js";
import { randomUUID } from "node:crypto";
import { config, TIERS as STAFF_TIERS } from "../config.js";
import { log } from "../log.js";
import { store, type Transfer } from "../store.js";
import { officerLevel } from "../commands/branch.js";
import { tierOf } from "../commands/permissions.js";
import type { Command } from "../commands/types.js";
import { resolvePlayer } from "./resolve.js";
import { rankOrder, setRankFromDiscord } from "./ranks.js";
import { line, lineTo } from "./channels.js";

const EXPIRE_MS = 7 * 24 * 60 * 60 * 1000;
let client: Client;

const branchName = (id: string) => config.branches[id]?.name ?? id;

/** Rank log in the main server + the given branches' rank logs. */
function logTransfer(text: string, ...branches: string[]) {
  line("ranks", text);
  for (const id of new Set(branches)) {
    const channel = config.branches[id]?.rankLog;
    if (channel) lineTo(channel, text);
  }
}

function approvalChannel(from: string): string {
  const b = config.branches[from];
  return b?.transferChannel || b?.rankLog || config.channels.ranks;
}

function requestEmbed(t: Transfer): EmbedBuilder {
  const colour = { pending: 0xd4a017, approved: 0x2e8b57, denied: 0xc0392b, cancelled: 0x777777, expired: 0x777777 }[t.status];
  const e = new EmbedBuilder()
    .setColor(colour)
    .setTitle(`Transfer request: ${t.robloxName}`)
    .addFields(
      { name: "From", value: `${branchName(t.from)}${t.fromRank ? ` · ${t.fromRank}` : ""}`, inline: true },
      { name: "To", value: `${branchName(t.to)} · ${t.rank}`, inline: true },
      { name: "Requested by", value: `<@${t.requestedBy}>`, inline: true },
    )
    .setTimestamp(t.requestedAt);
  const status =
    t.status === "pending"
      ? `Waiting for a ${branchName(t.from)} officer who outranks them.`
      : `**${t.status[0].toUpperCase()}${t.status.slice(1)}**${t.decidedBy ? ` by <@${t.decidedBy}>` : ""}`;
  return e.setDescription(status);
}

function buttons(t: Transfer, disabled = false) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`xfer:approve:${t.id}`).setLabel("Approve").setStyle(ButtonStyle.Success).setDisabled(disabled),
    new ButtonBuilder().setCustomId(`xfer:deny:${t.id}`).setLabel("Deny").setStyle(ButtonStyle.Danger).setDisabled(disabled),
  );
}

async function dm(discordId: string | undefined, text: string) {
  if (!discordId) return;
  const user = await client.users.fetch(discordId).catch(() => undefined);
  await user?.send(text).catch(() => undefined);
}

// ── /transfer (branch servers) ───────────────────────────────────────────────

export const transferCmd: Command = {
  data: new SlashCommandBuilder()
    .setName("transfer")
    .setDescription("Request to transfer someone from another branch into this one.")
    .addStringOption((o) => o.setName("player").setDescription("Roblox username, user id, or @member").setRequired(true))
    .addStringOption((o) => o.setName("rank").setDescription("Their rank here (default: the lowest)").setAutocomplete(true))
    .addStringOption((o) => o.setName("note").setDescription("Shown to the other branch's officers").setMaxLength(300)),
  async execute(i) {
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const { branch: to, level } = officerLevel(i);
    if (!to || level < 0) {
      await i.editReply("Only this branch's officers can request transfers.");
      return;
    }
    const user = await resolvePlayer(i.options.getString("player", true));
    if (!user) {
      await i.editReply("Couldn't find that player (Discord members must be linked).");
      return;
    }
    const known = store.rankOf(user.id);
    if (!known?.branch) {
      await i.editReply(`**${user.name}** isn't in a branch (as far as the bot knows), so just use \`/rank\` to recruit them.`);
      return;
    }
    if (known.branch === to) {
      await i.editReply(`**${user.name}** is already in ${branchName(to)}.`);
      return;
    }
    if (store.pendingTransferFor(user.id)) {
      await i.editReply(`There's already a pending transfer request for **${user.name}**.`);
      return;
    }
    const ranks = Object.keys(config.branches[to].ranks);
    const rank = i.options.getString("rank") ?? ranks[0];
    if (!ranks.includes(rank)) {
      await i.editReply(`Unknown rank. ${branchName(to)} ranks: ${ranks.join(", ")}`);
      return;
    }
    if (rankOrder(to, rank) >= level) {
      await i.editReply("You can only bring people in below your own rank.");
      return;
    }

    const t: Transfer = {
      id: randomUUID().slice(0, 8),
      robloxId: user.id,
      robloxName: user.name,
      from: known.branch,
      fromRank: known.rank,
      to,
      rank,
      requestedBy: i.user.id,
      requestedAt: Date.now(),
      status: "pending",
    };

    const channelId = approvalChannel(t.from);
    const channel = channelId ? await client.channels.fetch(channelId).catch(() => null) : null;
    if (!channel || !channel.isTextBased() || !("send" in channel)) {
      await i.editReply(`${branchName(t.from)} has no channel set up for transfer requests. Ask staff to move them with \`/rank\`.`);
      return;
    }
    const note = i.options.getString("note");
    const embed = requestEmbed(t);
    if (note) embed.addFields({ name: "Note", value: note });
    const msg = await channel.send({ embeds: [embed], components: [buttons(t)] });
    t.message = { channelId: msg.channelId, messageId: msg.id };
    store.saveTransfer(t);

    logTransfer(`🔁 ${i.user} requested **${user.name}**'s transfer ${branchName(t.from)} → **${branchName(to)}** as ${rank} (\`${t.id}\`)`, to, t.from);
    await i.editReply(`Request sent to ${branchName(t.from)}'s officers. You'll get a DM when they decide.`);
  },
};

// ── Approve / deny ───────────────────────────────────────────────────────────

/** May this person decide on the transfer? Returns a reason if not. */
function cannotDecide(i: ButtonInteraction, t: Transfer): string | undefined {
  if (i.guildId === config.guildId && i.inCachedGuild()) {
    const tier = tierOf(i.member);
    if (tier && STAFF_TIERS.indexOf(tier) >= STAFF_TIERS.indexOf("admin")) return undefined;
  }
  const { branch, level } = officerLevel(i);
  if (branch !== t.from || level < 0) return `Only ${branchName(t.from)} officers can decide this.`;
  const current = store.rankOf(t.robloxId);
  if (current?.branch === t.from && rankOrder(t.from, current.rank) >= level) return `You need to outrank ${t.robloxName} to decide this.`;
  const own = store.linkByDiscord(i.user.id);
  if (own?.robloxId === t.robloxId) return "You can't decide your own transfer.";
  return undefined;
}

async function decide(i: ButtonInteraction, approve: boolean, id: string) {
  const t = store.transfer(id);
  if (!t || t.status !== "pending") {
    await i.update({ components: t ? [buttons(t, true)] : [] }).catch(() => undefined);
    await i.followUp({ flags: MessageFlags.Ephemeral, content: "This request was already handled." }).catch(() => undefined);
    return;
  }
  const reason = cannotDecide(i, t);
  if (reason) {
    await i.reply({ flags: MessageFlags.Ephemeral, content: reason });
    return;
  }

  // They may have moved since the request was made.
  const current = store.rankOf(t.robloxId);
  if (approve && current?.branch !== t.from) {
    t.status = "cancelled";
    t.decidedBy = i.user.id;
    store.saveTransfer(t);
    await i.update({ embeds: [requestEmbed(t)], components: [buttons(t, true)] });
    await i.followUp({ flags: MessageFlags.Ephemeral, content: `${t.robloxName} isn't in ${branchName(t.from)} any more, so the request was cancelled.` });
    return;
  }

  if (approve) {
    try {
      await setRankFromDiscord(t.robloxId, t.to, t.rank, `Transfer approved by ${i.user.username}`);
    } catch (err) {
      await i.reply({ flags: MessageFlags.Ephemeral, content: `Couldn't apply the transfer: ${err instanceof Error ? err.message : err}` });
      return;
    }
  }
  t.status = approve ? "approved" : "denied";
  t.decidedBy = i.user.id;
  store.saveTransfer(t);
  await i.update({ embeds: [requestEmbed(t)], components: [buttons(t, true)] });

  const verdict = approve ? "approved ✅" : "denied ❌";
  logTransfer(`🔁 ${i.user} ${verdict} **${t.robloxName}**'s transfer ${branchName(t.from)} → ${branchName(t.to)} (\`${t.id}\`)`, t.to, t.from);
  await dm(t.requestedBy, `🔁 ${branchName(t.from)} ${verdict} your transfer request for **${t.robloxName}**.`);
  if (approve) {
    await dm(store.linkByRoblox(t.robloxId)?.discordId, `🔁 You've been transferred from **${branchName(t.from)}** to **${branchName(t.to)}** as **${t.rank}**.`);
  }
}

async function expireOld() {
  for (const t of store.pendingTransfers()) {
    if (Date.now() - t.requestedAt < EXPIRE_MS) continue;
    t.status = "expired";
    store.saveTransfer(t);
    if (t.message) {
      const channel = await client.channels.fetch(t.message.channelId).catch(() => null);
      if (channel?.isTextBased()) {
        const msg = await channel.messages.fetch(t.message.messageId).catch(() => undefined);
        await msg?.edit({ embeds: [requestEmbed(t)], components: [buttons(t, true)] }).catch(() => undefined);
      }
    }
    await dm(t.requestedBy, `🔁 Your transfer request for **${t.robloxName}** expired without a decision.`);
  }
}

export function registerTransfers(c: Client) {
  client = c;
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isButton() || !interaction.customId.startsWith("xfer:")) return;
    const [, action, id] = interaction.customId.split(":");
    await decide(interaction, action === "approve", id).catch((err) => log.error("transfer decision failed:", err));
  });
  setInterval(() => expireOld().catch(() => undefined), 60 * 60 * 1000);
}
