// Staff moderation commands.
import { AttachmentBuilder, EmbedBuilder, SlashCommandBuilder, type ChatInputCommandInteraction } from "discord.js";
import { config } from "../config.js";
import { store } from "../store.js";
import { resolvePlayer } from "../features/resolve.js";
import { setRankFromDiscord } from "../features/ranks.js";
import { line } from "../features/channels.js";
import { game, queueAction } from "../bridge/game.js";
import { findPlayer } from "../bridge/servers.js";
import { getBan, setBan } from "../roblox/openCloud.js";
import { checkHealth, formatDuration, loadProfile } from "../roblox/profile.js";
import { profileUrl, type RobloxUser } from "../roblox/users.js";
import { autoLinkEnabled, linkAll } from "../features/autolink.js";
import { muteMember, unmuteMember } from "../features/mutes.js";
import type { Command } from "./types.js";

const playerOption = (b: SlashCommandBuilder) =>
  b.addStringOption((o) => o.setName("player").setDescription("Roblox username, user id, or @member").setRequired(true));

async function target(i: ChatInputCommandInteraction): Promise<RobloxUser | undefined> {
  const user = await resolvePlayer(i.options.getString("player", true));
  if (!user) await i.editReply("Couldn't find that player (Discord members must be linked).");
  return user;
}

const staffName = (i: ChatInputCommandInteraction) => `${i.user.username} (Discord)`;
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** "30m", "12h", "7d", "2w" -> seconds; "perm" / "permanent" / "" -> undefined (permanent). */
function parseDuration(text: string | null): number | undefined | null {
  if (!text || /^perm/i.test(text)) return undefined;
  const m = text.trim().match(/^(\d+)\s*([mhdw])$/i);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = { m: 60, h: 3600, d: 86400, w: 604800 }[m[2].toLowerCase() as "m" | "h" | "d" | "w"];
  return n * unit;
}

/** A linked member's Discord mute -> a status line. */
function muteText(discordId: string | undefined): string | undefined {
  const m = discordId ? store.muteOf(discordId) : undefined;
  if (!m) return undefined;
  const why = m.reason ? `: ${m.reason}` : "";
  return m.until === -1 ? `🔇 Muted on Discord permanently${why}` : `🔇 Muted on Discord until <t:${Math.floor(m.until / 1000)}:f>${why}`;
}

// ── /lookup ──────────────────────────────────────────────────────────────────

export const lookup: Command = {
  staff: true,
  data: playerOption(new SlashCommandBuilder().setName("lookup").setDescription("Look up a player's saved data and check it for corruption.")).addBooleanOption(
    (o) => o.setName("raw").setDescription("Attach the full saved data as a JSON file"),
  ),
  async execute(i) {
    await i.deferReply({ ephemeral: true });
    const user = await target(i);
    if (!user) return;

    const [profile, ban] = await Promise.all([loadProfile(user.id), getBan(user.id).catch(() => undefined)]);
    if (!profile) {
      await i.editReply(`**${user.name}** has no saved data (never played, or a different data store).`);
      return;
    }
    const d = profile.data;
    const issues = checkHealth(profile);
    const server = findPlayer(user.id);
    const session = profile.record.MetaData?.ActiveSession;
    const inv = d.ToolInventory ?? {};
    const toolCount = Array.isArray(inv.Tools) ? inv.Tools.length : Object.keys(inv.Tools ?? {}).length;
    const itemKinds = Object.keys(inv.Items ?? {}).length;
    const warnings = (Array.isArray(d.Warnings) ? d.Warnings.length : 0) + store.warnings(user.id).length;
    const branch = d.Branch && d.Branch !== "None" ? `${config.branches[d.Branch]?.name ?? d.Branch} — ${d.BranchRank ?? "?"}` : "None";
    const link = store.linkByRoblox(user.id);

    const embed = new EmbedBuilder()
      .setColor(issues.length ? 0xf66c6c : 0x44da7a)
      .setTitle(`${d.FullName || "(no character)"} — @${user.name}`)
      .setURL(profileUrl(user.id))
      .addFields(
        {
          name: "Status",
          value: [
            server ? `🟢 Online (\`${server.jobId.slice(0, 8)}\`)` : session ? "🟡 Session open (may be in game)" : "⚫ Offline",
            d.WipeState ? "☠️ **Wiped** (creating a character)" : "Alive",
            ban?.active ? `⛔ Banned${ban.duration ? ` (${ban.duration})` : " permanently"}: ${ban.privateReason ?? ""}` : "Not banned",
            link ? `Linked: <@${link.discordId}>` : "Not linked",
            muteText(link?.discordId),
          ]
            .filter(Boolean)
            .join("\n"),
          inline: true,
        },
        { name: "Branch", value: branch, inline: true },
        { name: "Title / Status", value: `${d.ActiveTitle || "—"}\n${d.Status || "—"}\nRep ${d.Reputation ?? 0}`, inline: true },
        { name: "Gold", value: `${d.Gold ?? 0} (bank ${d.Bank?.Currency ?? 0})`, inline: true },
        { name: "Playtime", value: formatDuration(d.TotalPlaytime), inline: true },
        {
          name: "PDs",
          value: `${d.PDsSurvived ?? 0}/${d.PDsAttended ?? 0} survived\n${formatDuration(d.PDSurvivalTime)} in PDs`,
          inline: true,
        },
        { name: "Titan kills", value: String(d.TitanKills ?? 0), inline: true },
        { name: "Inventory", value: `${toolCount} tools, ${itemKinds} item types`, inline: true },
        { name: "Warnings", value: String(warnings), inline: true },
        {
          name: issues.length ? `⚠️ ${issues.length} issue${issues.length === 1 ? "" : "s"}` : "✅ Data looks healthy",
          value: issues.length ? issues.slice(0, 15).map((x) => `• ${x}`).join("\n").slice(0, 1024) : "No corruption found.",
        },
      )
      .setFooter({ text: `Roblox id ${user.id}${profile.revisionTime ? ` · last saved ${new Date(profile.revisionTime).toUTCString()}` : ""}` });

    const files = i.options.getBoolean("raw")
      ? [new AttachmentBuilder(Buffer.from(JSON.stringify(profile.record, null, 2)), { name: `${user.name}-${user.id}.json` })]
      : [];
    await i.editReply({ embeds: [embed], files });
  },
};

// ── /kick /ban /unban /warn /void ───────────────────────────────────────────

export const kick: Command = {
  staff: true,
  data: playerOption(new SlashCommandBuilder().setName("kick").setDescription("Kick a player from whatever server they're on.")).addStringOption((o) =>
    o.setName("reason").setDescription("Shown to the player").setRequired(true),
  ),
  async execute(i) {
    await i.deferReply({ ephemeral: true });
    const user = await target(i);
    if (!user) return;
    const reason = i.options.getString("reason", true);
    try {
      await game.kick(user.id, reason);
      line("moderation", `👢 ${i.user} kicked **${user.name}** (\`${user.id}\`): ${reason}`);
      await i.editReply(`Kick sent for **${user.name}**${findPlayer(user.id) ? "" : " (they don't look online right now)"}.`);
    } catch (err) {
      await i.editReply(`Failed: ${errText(err)}`);
    }
  },
};

export const ban: Command = {
  staff: true,
  data: playerOption(new SlashCommandBuilder().setName("ban").setDescription("Ban a player from the game (Roblox ban API)."))
    .addStringOption((o) => o.setName("reason").setDescription("Shown to the player").setRequired(true))
    .addStringOption((o) => o.setName("duration").setDescription("e.g. 30m, 12h, 7d, 2w — leave empty for permanent"))
    .addBooleanOption((o) => o.setName("alts").setDescription("Also ban their alt accounts (default yes)")),
  async execute(i) {
    await i.deferReply({ ephemeral: true });
    const user = await target(i);
    if (!user) return;
    const reason = i.options.getString("reason", true);
    const seconds = parseDuration(i.options.getString("duration"));
    if (seconds === null) {
      await i.editReply("Duration must look like 30m, 12h, 7d or 2w (or be empty for permanent).");
      return;
    }
    try {
      await setBan(user.id, {
        active: true,
        ...(seconds ? { duration: `${seconds}s` } : {}),
        privateReason: `${reason} — by ${i.user.username} via Discord`,
        displayReason: reason,
        excludeAltAccounts: i.options.getBoolean("alts") === false,
      });
      await game.kick(user.id, `Banned: ${reason}`).catch(() => undefined);
      const length = seconds ? `for ${i.options.getString("duration")}` : "permanently";
      line("moderation", `⛔ ${i.user} banned **${user.name}** (\`${user.id}\`) ${length}: ${reason}`);
      await i.editReply(`**${user.name}** is banned ${length}.`);
    } catch (err) {
      await i.editReply(`Failed: ${errText(err)}`);
    }
  },
};

export const unban: Command = {
  staff: true,
  data: playerOption(new SlashCommandBuilder().setName("unban").setDescription("Lift a player's ban.")),
  async execute(i) {
    await i.deferReply({ ephemeral: true });
    const user = await target(i);
    if (!user) return;
    try {
      await setBan(user.id, { active: false });
      line("moderation", `✅ ${i.user} unbanned **${user.name}** (\`${user.id}\`)`);
      await i.editReply(`**${user.name}** is unbanned.`);
    } catch (err) {
      await i.editReply(`Failed: ${errText(err)}`);
    }
  },
};

export const warn: Command = {
  staff: true,
  data: playerOption(new SlashCommandBuilder().setName("warn").setDescription("Warn a player (shown in game, logged, DMed if linked).")).addStringOption(
    (o) => o.setName("reason").setDescription("The warning").setRequired(true),
  ),
  async execute(i) {
    await i.deferReply({ ephemeral: true });
    const user = await target(i);
    if (!user) return;
    const reason = i.options.getString("reason", true);
    try {
      await queueAction(user.id, "warn", { Reason: reason }, staffName(i));
      store.addWarning(user.id, { reason, by: i.user.username, at: Date.now() });
      const link = store.linkByRoblox(user.id);
      if (link) {
        const member = await i.client.users.fetch(link.discordId).catch(() => undefined);
        await member?.send(`⚠️ You received a warning from staff: ${reason}`).catch(() => undefined);
      }
      line("moderation", `⚠️ ${i.user} warned **${user.name}** (\`${user.id}\`): ${reason}`);
      await i.editReply(`Warned **${user.name}** (${store.warnings(user.id).length} warning(s) on record).`);
    } catch (err) {
      await i.editReply(`Failed: ${errText(err)}`);
    }
  },
};

export const voidCmd: Command = {
  staff: true,
  data: playerOption(new SlashCommandBuilder().setName("void").setDescription("Void a player's death (clears their wipe).")),
  async execute(i) {
    await i.deferReply({ ephemeral: true });
    const user = await target(i);
    if (!user) return;
    try {
      await queueAction(user.id, "void", {}, staffName(i));
      line("moderation", `🕯️ ${i.user} voided **${user.name}**'s death (\`${user.id}\`)`);
      await i.editReply(`Void queued for **${user.name}** — applied right away if they're online, otherwise when they next join.`);
    } catch (err) {
      await i.editReply(`Failed: ${errText(err)}`);
    }
  },
};

// ── /rank ────────────────────────────────────────────────────────────────────

export const rank: Command = {
  staff: true,
  data: playerOption(new SlashCommandBuilder().setName("rank").setDescription("Set a player's branch rank (syncs game + Discord roles)."))
    .addStringOption((o) =>
      o
        .setName("branch")
        .setDescription("Branch")
        .setRequired(true)
        .addChoices(
          { name: "None (remove from branch)", value: "None" },
          ...Object.entries(config.branches).slice(0, 24).map(([id, b]) => ({ name: b.name, value: id })),
        ),
    )
    .addStringOption((o) => o.setName("rank").setDescription("Rank (leave empty for the lowest)").setAutocomplete(true)),
  async execute(i) {
    await i.deferReply({ ephemeral: true });
    const user = await target(i);
    if (!user) return;
    const branch = i.options.getString("branch", true);
    const ranks = Object.keys(config.branches[branch]?.ranks ?? {});
    const rankId = branch === "None" ? undefined : i.options.getString("rank") ?? ranks[0];
    if (branch !== "None" && (!rankId || !ranks.includes(rankId))) {
      await i.editReply(`Unknown rank. ${config.branches[branch]?.name ?? branch} ranks: ${ranks.join(", ")}`);
      return;
    }
    try {
      await setRankFromDiscord(user.id, branch, rankId, staffName(i));
      const what = branch === "None" ? "removed from their branch" : `set to **${rankId}** in **${config.branches[branch].name}**`;
      line("ranks", `🎖️ ${i.user} ${what.replace("removed", `removed **${user.name}**`).replace(/^set/, `set **${user.name}**`)}`);
      await i.editReply(`**${user.name}** ${what}. Applied right away if they're online, otherwise when they next join.`);
    } catch (err) {
      await i.editReply(`Failed: ${errText(err)}`);
    }
  },
};

// ── /mute /unmute (Discord) ─────────────────────────────────────────────────

export const mute: Command = {
  staff: true,
  data: new SlashCommandBuilder()
    .setName("mute")
    .setDescription("Mute (time out) someone in the main server and every branch server.")
    .addUserOption((o) => o.setName("member").setDescription("Who to mute").setRequired(true))
    .addStringOption((o) => o.setName("duration").setDescription("e.g. 30m, 12h, 7d, 2w — leave empty for permanent"))
    .addStringOption((o) => o.setName("reason").setDescription("Shown in their DM and the audit log").setMaxLength(200)),
  async execute(i) {
    await i.deferReply({ ephemeral: true });
    const member = i.options.getUser("member", true);
    if (member.bot || member.id === i.user.id) {
      await i.editReply("You can't mute that member.");
      return;
    }
    const seconds = parseDuration(i.options.getString("duration"));
    if (seconds === null) {
      await i.editReply("Couldn't read that duration. Use something like `30m`, `12h`, `7d` or `2w`, or leave it empty for permanent.");
      return;
    }
    const reason = i.options.getString("reason") ?? "";
    const until = seconds === undefined ? -1 : Date.now() + seconds * 1000;
    const length = seconds === undefined ? "permanently" : `for ${formatDuration(seconds)}`;
    const { done, failed } = await muteMember(member.id, { until, reason, by: i.user.username, at: Date.now() });
    await member.send(`🔇 You've been muted in the Odyssey Discord servers ${length}${reason ? `: ${reason}` : "."}`).catch(() => undefined);
    line("moderation", `🔇 ${i.user} muted ${member} ${length}${reason ? `: ${reason}` : ""}`);
    await i.editReply(
      `Muted ${member} ${length}` +
        (done.length ? ` in ${done.join(", ")}.` : ". They aren't in any of the servers right now; it'll apply if they join.") +
        (failed.length ? `\n⚠️ Couldn't time them out in ${failed.join(", ")} (the bot needs **Timeout Members** and a role above theirs).` : ""),
    );
  },
};

export const unmute: Command = {
  staff: true,
  data: new SlashCommandBuilder()
    .setName("unmute")
    .setDescription("Unmute someone in every server.")
    .addUserOption((o) => o.setName("member").setDescription("Who to unmute").setRequired(true)),
  async execute(i) {
    await i.deferReply({ ephemeral: true });
    const member = i.options.getUser("member", true);
    const { failed } = await unmuteMember(member.id);
    line("moderation", `🔊 ${i.user} unmuted ${member}`);
    await i.editReply(`Unmuted ${member}.${failed.length ? ` ⚠️ Couldn't clear the timeout in ${failed.join(", ")}.` : ""}`);
  },
};

// ── /linkall ────────────────────────────────────────────────────────────────

export const linkall: Command = {
  staff: true,
  data: new SlashCommandBuilder().setName("linkall").setDescription("Auto-link everyone in this server who verified with Bloxlink / RoVer."),
  async execute(i) {
    if (!autoLinkEnabled()) {
      await i.reply({ ephemeral: true, content: "Auto-link is off. Set `autoLink.provider` in config.json and its API key in .env." });
      return;
    }
    await i.reply({ ephemeral: true, content: "Linking everyone who's verified… this takes about a second per unlinked member. I'll post the result in the moderation log." });
    linkAll()
      .then(({ checked, linked }) => line("moderation", `🔗 /linkall by ${i.user}: linked ${linked} of ${checked} unlinked member(s)`))
      .catch((err) => line("moderation", `⚠️ /linkall failed: ${errText(err)}`));
  },
};
