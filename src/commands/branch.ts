// Commands registered in each branch's own Discord server.
//
// /rank there is for the branch's officers (branches.<id>.officerRoles, or the
// server's Administrators): they can promote / demote / discharge members of
// THEIR branch, only to ranks below their own, and only people ranked below
// them. Recruiting someone with no branch is allowed; pulling someone out of
// another branch needs allowDiscordTransfers (otherwise main-server staff do it).
import { PermissionFlagsBits, SlashCommandBuilder, type BaseInteraction } from "discord.js";
import { branchOfGuild, config } from "../config.js";
import { store } from "../store.js";
import { resolvePlayer } from "../features/resolve.js";
import { rankOrder, rankRoleIndex, setRankFromDiscord } from "../features/ranks.js";
import { line, lineTo } from "../features/channels.js";
import type { Command } from "./types.js";

const DISCHARGE = "None";

/** The caller's authority in this branch server: highest rank order they may act below. */
export function officerLevel(i: BaseInteraction): { branch?: string; level: number } {
  const branch = branchOfGuild(i.guildId);
  if (!branch || !i.inCachedGuild()) return { branch, level: -1 };
  const member = i.member;
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return { branch, level: Infinity };
  const b = config.branches[branch];
  if (!b.officerRoles.some((id) => member.roles.cache.has(id))) return { branch, level: -1 };
  // Their own rank: highest rank role they hold in this branch (officer roles
  // without a rank role still count as able to manage the bottom rank).
  const index = rankRoleIndex();
  let own = 0;
  for (const id of member.roles.cache.keys()) {
    const r = index.get(id);
    if (r && r.branch === branch) own = Math.max(own, r.order);
  }
  return { branch, level: own };
}

export const branchRank: Command = {
  data: new SlashCommandBuilder()
    .setName("rank")
    .setDescription("Promote, demote or discharge a member of this branch (syncs to the game).")
    .addStringOption((o) => o.setName("player").setDescription("Roblox username, user id, or @member").setRequired(true))
    .addStringOption((o) => o.setName("rank").setDescription("New rank, or None to discharge").setRequired(true).setAutocomplete(true)),
  async execute(i) {
    await i.deferReply({ ephemeral: true });
    const { branch, level } = officerLevel(i);
    if (!branch || level < 0) {
      await i.editReply("Only this branch's officers can change ranks here.");
      return;
    }
    const b = config.branches[branch];
    const user = await resolvePlayer(i.options.getString("player", true));
    if (!user) {
      await i.editReply("Couldn't find that player (Discord members must be linked).");
      return;
    }
    const wanted = i.options.getString("rank", true);
    const discharge = wanted === DISCHARGE;
    if (!discharge && !(wanted in b.ranks)) {
      await i.editReply(`Unknown rank. ${b.name} ranks: ${Object.keys(b.ranks).join(", ")}`);
      return;
    }

    const known = store.rankOf(user.id);
    const caller = store.linkByDiscord(i.user.id);
    if (caller?.robloxId === user.id && level !== Infinity) {
      await i.editReply("You can't change your own rank.");
      return;
    }
    if (known?.branch && known.branch !== branch) {
      if (discharge || !config.allowDiscordTransfers) {
        await i.editReply(`**${user.name}** is in **${config.branches[known.branch]?.name ?? known.branch}**. Transfers between branches go through staff.`);
        return;
      }
    }
    if (known?.branch === branch && rankOrder(branch, known.rank) >= level) {
      await i.editReply(`**${user.name}** is ${known.rank}, which isn't below your rank.`);
      return;
    }
    if (!discharge && rankOrder(branch, wanted) >= level) {
      await i.editReply(`You can only give ranks below your own.`);
      return;
    }
    if (discharge && known?.branch !== branch) {
      await i.editReply(`**${user.name}** isn't in ${b.name} (as far as the bot knows — they may need to join the game once).`);
      return;
    }

    try {
      await setRankFromDiscord(user.id, discharge ? DISCHARGE : branch, discharge ? undefined : wanted, `${i.user.username} (${b.name} Discord)`);
      const text = discharge
        ? `🎖️ ${i.user} discharged **${user.name}** from **${b.name}**`
        : `🎖️ ${i.user} set **${user.name}** to **${wanted}** in **${b.name}**${known?.branch === branch ? ` (was ${known.rank ?? "—"})` : ""}`;
      line("ranks", text);
      if (b.rankLog) lineTo(b.rankLog, text);
      await i.editReply(`Done: ${discharge ? "discharged" : `now **${wanted}**`}. Applied right away if they're online, otherwise when they next join.`);
    } catch (err) {
      await i.editReply(`Failed: ${err instanceof Error ? err.message : err}`);
    }
  },
};
