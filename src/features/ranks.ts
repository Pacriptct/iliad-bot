// Two-way branch rank sync between the game and Discord roles, across the main
// server and every branch's own server.
//
// Where roles live:
//   * Branch server (branches.<id>.guildId): the branch role + one role per rank.
//   * Main server: the branch's mainRole (if set) and the linkedRole.
//   * Any server: roleRules (Discord-only roles such as "Other Branch Hicom")
//     given from someone's branch + rank. These only go game -> Discord.
//   A branch with no guildId keeps its branch/rank roles in the main server.
//
//   Game -> Discord : rank_changed (Source "game"), join and link events make a
//                     linked member's managed roles in EVERY server match the
//                     game. Leaving a branch strips its roles in its server.
//   Discord -> game : when someone gives a linked member a rank role in a branch's
//                     server, the bot queues a setRank action (applied live, or on
//                     their next join). Moving someone out of a different branch
//                     this way is refused unless allowDiscordTransfers is on.
//
// The bot's own role edits are suppressed for a few seconds (per server) so they
// don't bounce back as Discord-side changes.
import { Events, type Client, type GuildMember } from "discord.js";
import { allGuilds, branchGuild, branchOfGuild, config, type RoleRule } from "../config.js";
import { log } from "../log.js";
import { store } from "../store.js";
import { name, on, type PlayerInfo } from "../bridge/events.js";
import { queueAction } from "../bridge/game.js";
import { line, lineTo } from "./channels.js";

const SUPPRESS_MS = 8000;
const suppressed = new Map<string, number>(); // `${guildId}:${discordId}` -> until
let client: Client;

const key = (guildId: string, discordId: string) => `${guildId}:${discordId}`;

function isSuppressed(guildId: string, discordId: string) {
  const until = suppressed.get(key(guildId, discordId));
  return until !== undefined && until > Date.now();
}

const inBranch = (branch?: string) => (branch && branch !== "None" && config.branches[branch] ? branch : undefined);

/** Every role the sync manages in one server. */
function managedRoles(guildId: string): Set<string> {
  const set = new Set<string>();
  for (const b of Object.values(config.branches)) {
    if (branchGuild(b) === guildId) {
      if (b.role) set.add(b.role);
      for (const r of Object.values(b.ranks)) if (r) set.add(r);
    }
    if (guildId === config.guildId && b.mainRole) set.add(b.mainRole);
  }
  if (guildId === config.guildId && config.linkedRole) set.add(config.linkedRole);
  for (const rule of config.roleRules) if (rule.role && ruleGuild(rule) === guildId) set.add(rule.role);
  return set;
}

const ruleGuild = (rule: RoleRule) => rule.guildId || config.guildId;

/** Does (branch, rank) earn this rule's role? */
function ruleMatches(rule: RoleRule, branch: string | undefined, rank: string | undefined): boolean {
  if (!branch) return false;
  const home = branchOfGuild(ruleGuild(rule));
  const branchOk =
    rule.branches === "any" || (rule.branches === "others" ? branch !== home : Array.isArray(rule.branches) && rule.branches.includes(branch));
  const rankOk = !rule.ranks?.length || (rank !== undefined && rule.ranks.includes(rank));
  return branchOk && rankOk;
}

/** Roles a member should hold in one server for (branch, rank). */
function desiredRoles(guildId: string, branch: string | undefined, rank: string | undefined, linked: boolean): string[] {
  const roles: string[] = [];
  const b = branch ? config.branches[branch] : undefined;
  if (b && branchGuild(b) === guildId) {
    roles.push(b.role, rank ? b.ranks[rank] ?? "" : "");
  }
  if (guildId === config.guildId) {
    if (b?.mainRole) roles.push(b.mainRole);
    if (linked && config.linkedRole) roles.push(config.linkedRole);
  }
  for (const rule of config.roleRules) {
    if (rule.role && ruleGuild(rule) === guildId && ruleMatches(rule, branch, rank)) roles.push(rule.role);
  }
  return roles.filter(Boolean);
}

/** rank role id -> where it sits. Role ids are unique across Discord. */
export function rankRoleIndex() {
  const index = new Map<string, { branch: string; rank: string; order: number; guildId: string }>();
  for (const [branch, b] of Object.entries(config.branches)) {
    Object.entries(b.ranks).forEach(([rank, role], order) => {
      if (role) index.set(role, { branch, rank, order, guildId: branchGuild(b) });
    });
  }
  return index;
}

/** Index of a rank within its branch (lowest = 0), or -1. */
export const rankOrder = (branch: string, rank?: string) => (rank ? Object.keys(config.branches[branch]?.ranks ?? {}).indexOf(rank) : -1);

async function fetchMember(guildId: string, discordId: string): Promise<GuildMember | undefined> {
  const guild = client.guilds.cache.get(guildId) ?? (await client.guilds.fetch(guildId).catch(() => undefined));
  return guild?.members.fetch(discordId).catch(() => undefined);
}

async function applyIn(guildId: string, discordId: string, branch: string | undefined, rank: string | undefined, linked: boolean) {
  const m = await fetchMember(guildId, discordId);
  if (!m) return; // not in that server
  const managed = managedRoles(guildId);
  const keep = m.roles.cache.filter((r) => !managed.has(r.id)).map((r) => r.id);
  const next = [...new Set([...keep, ...desiredRoles(guildId, branch, rank, linked)])].filter((id) => id !== m.guild.id);
  const current = new Set(m.roles.cache.filter((r) => r.id !== m.guild.id).map((r) => r.id));
  if (next.length === current.size && next.every((id) => current.has(id))) return;
  suppressed.set(key(guildId, discordId), Date.now() + SUPPRESS_MS);
  await m.roles.set(next, "Odyssey rank sync");
}

/** Make a member's managed roles in every server match (branch, rank). */
export async function applyRoles(discordId: string, branch?: string, rank?: string, linked = true): Promise<void> {
  const b = inBranch(branch);
  for (const guildId of allGuilds()) {
    await applyIn(guildId, discordId, b, b ? rank : undefined, linked).catch((err) =>
      log.warn(`role sync in ${guildId} failed:`, err instanceof Error ? err.message : err),
    );
  }
}

/** Log a rank change to the main rank log and the branch servers involved. */
function logRank(text: string, ...branches: (string | undefined)[]) {
  line("ranks", text);
  for (const id of new Set(branches.filter(Boolean) as string[])) {
    const channel = config.branches[id]?.rankLog;
    if (channel) lineTo(channel, text);
  }
}

/** Discord -> game: set a Roblox user's branch rank (and their roles). */
export async function setRankFromDiscord(robloxId: number, branch: string, rank: string | undefined, by: string) {
  await queueAction(robloxId, "setRank", { Branch: branch, Rank: rank }, by);
  store.setRank(robloxId, branch, rank);
  const link = store.linkByRoblox(robloxId);
  if (link) await applyRoles(link.discordId, branch, rank);
}

async function syncFromGame(p: PlayerInfo) {
  store.setRank(p.UserId, p.Branch, p.Rank);
  const link = store.linkByRoblox(p.UserId);
  if (!link) return;
  await applyRoles(link.discordId, p.Branch, p.Rank);
}

export function registerRanks(c: Client) {
  client = c;

  on("rank_changed", async (e) => {
    const p = e as unknown as PlayerInfo & { Source?: string };
    const before = store.rankOf(p.UserId);
    const branch = inBranch(p.Branch);
    const where = `*(changed in ${p.Source === "discord" ? "Discord" : "game"})*`;
    const text = branch
      ? `🎖️ ${name(p)} is now **${p.Rank || "—"}** in **${config.branches[branch].name}** ${where}`
      : `🎖️ ${name(p)} left **${(before?.branch && config.branches[before.branch]?.name) || "their branch"}** ${where}`;
    logRank(text, branch, before?.branch);
    if (p.Source !== "discord") await syncFromGame(p);
    else store.setRank(p.UserId, p.Branch, p.Rank);
  });
  on("join", (e) => syncFromGame(e as unknown as PlayerInfo));

  // A linked member joins one of the servers: give them their roles there.
  client.on(Events.GuildMemberAdd, async (member) => {
    if (!allGuilds().includes(member.guild.id)) return;
    const link = store.linkByDiscord(member.id);
    if (!link) return;
    const known = store.rankOf(link.robloxId);
    await applyIn(member.guild.id, member.id, inBranch(known?.branch), known?.rank, true).catch(() => undefined);
  });

  client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
    const guildId = newMember.guild.id;
    if (!allGuilds().includes(guildId) || isSuppressed(guildId, newMember.id)) return;
    const link = store.linkByDiscord(newMember.id);
    if (!link) return;

    const index = rankRoleIndex();
    const inThisGuild = (id: string) => index.get(id)?.guildId === guildId;
    const added = [...newMember.roles.cache.keys()].filter((id) => !oldMember.roles.cache.has(id) && inThisGuild(id));
    const removed = [...oldMember.roles.cache.keys()].filter((id) => !newMember.roles.cache.has(id) && inThisGuild(id));
    const known = store.rankOf(link.robloxId);

    if (added.length > 0) {
      // Highest rank among the newly added roles wins.
      const target = added.map((id) => index.get(id)!).sort((a, b) => b.order - a.order)[0];
      const fromOther = Boolean(known?.branch && known.branch !== target.branch);
      if (fromOther && !config.allowDiscordTransfers) {
        await applyRoles(newMember.id, known!.branch, known!.rank).catch(() => undefined);
        logRank(
          `⚠️ ${newMember} was given **${target.rank}** in **${config.branches[target.branch].name}**, but they're in **${config.branches[known!.branch!]?.name ?? known!.branch}**. Reverted — use \`/transfer\` to request them from their branch.`,
          target.branch,
        );
        return;
      }
      try {
        await setRankFromDiscord(link.robloxId, target.branch, target.rank, `Discord (${newMember.user.tag})`);
        logRank(
          `🎖️ ${newMember} → **${target.rank}** in **${config.branches[target.branch].name}** *(set from Discord, syncing to game)*`,
          target.branch,
          fromOther ? known?.branch : undefined,
        );
      } catch (err) {
        log.warn("Discord -> game rank sync failed:", err);
        logRank(`⚠️ Couldn't sync ${newMember}'s new rank to the game: ${err instanceof Error ? err.message : err}`, target.branch);
      }
      return;
    }

    if (removed.length > 0 && config.removeBranchWhenRankRoleRemoved) {
      const branch = index.get(removed[0])!.branch;
      const stillHasRank = newMember.roles.cache.some((r) => index.get(r.id)?.branch === branch);
      if (!stillHasRank && known?.branch === branch) {
        await setRankFromDiscord(link.robloxId, "None", undefined, `Discord (${newMember.user.tag})`).catch(() => undefined);
        logRank(`🎖️ ${newMember} lost their rank role — removed from **${config.branches[branch].name}** in game`, branch);
      }
    }
  });
}
