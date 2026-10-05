// Two-way branch rank sync between the game and Discord roles.
//
//   Game -> Discord : rank_changed (Source "game"), join and link events set the
//                     linked member's branch + rank roles to match the game.
//   Discord -> game : when staff give a linked member a rank role, the bot queues
//                     a setRank action (applied live, or on their next join) and
//                     tidies their other rank roles.
//
// The bot's own role edits are suppressed for a few seconds so they don't
// bounce back as Discord-side changes.
import { Events, type Client, type GuildMember } from "discord.js";
import { config } from "../config.js";
import { log } from "../log.js";
import { store } from "../store.js";
import { on, who, type PlayerInfo } from "../bridge/events.js";
import { queueAction } from "../bridge/game.js";
import { line } from "./channels.js";

const SUPPRESS_MS = 8000;
const suppressed = new Map<string, number>(); // discordId -> until
let client: Client;

function isSuppressed(id: string) {
  const until = suppressed.get(id);
  return until !== undefined && until > Date.now();
}

/** Every role the sync manages (branch roles + rank roles). */
function managedRoles(): Set<string> {
  const set = new Set<string>();
  for (const b of Object.values(config.branches)) {
    if (b.role) set.add(b.role);
    for (const r of Object.values(b.ranks)) if (r) set.add(r);
  }
  return set;
}

/** rank role id -> { branch, rank, order } */
function rankRoleIndex() {
  const index = new Map<string, { branch: string; rank: string; order: number }>();
  for (const [branch, b] of Object.entries(config.branches)) {
    Object.entries(b.ranks).forEach(([rank, role], order) => {
      if (role) index.set(role, { branch, rank, order });
    });
  }
  return index;
}

function desiredRoles(branch?: string, rank?: string): string[] {
  const b = branch ? config.branches[branch] : undefined;
  if (!b) return [];
  return [b.role, rank ? b.ranks[rank] : ""].filter((r): r is string => Boolean(r));
}

async function member(discordId: string): Promise<GuildMember | undefined> {
  const guild = client.guilds.cache.get(config.guildId) ?? (await client.guilds.fetch(config.guildId).catch(() => undefined));
  return guild?.members.fetch(discordId).catch(() => undefined);
}

/** Make a member's managed roles exactly match (branch, rank). */
export async function applyRoles(discordId: string, branch?: string, rank?: string): Promise<boolean> {
  const m = await member(discordId);
  if (!m) return false;
  const managed = managedRoles();
  const keep = m.roles.cache.filter((r) => !managed.has(r.id)).map((r) => r.id);
  const next = [...new Set([...keep, ...desiredRoles(branch, rank), ...(config.linkedRole ? [config.linkedRole] : [])])];
  const current = new Set(m.roles.cache.map((r) => r.id));
  if (next.length === current.size && next.every((id) => current.has(id))) return true;
  suppressed.set(discordId, Date.now() + SUPPRESS_MS);
  await m.roles.set(next.filter((id) => id !== m.guild.id), "Odyssey rank sync");
  return true;
}

/** Discord -> game: set a Roblox user's branch rank (and their roles). */
export async function setRankFromDiscord(robloxId: number, branch: string, rank: string | undefined, by: string) {
  await queueAction(robloxId, "setRank", { Branch: branch, Rank: rank }, by);
  const link = store.linkByRoblox(robloxId);
  if (link) await applyRoles(link.discordId, branch === "None" ? undefined : branch, rank);
}

async function syncFromGame(p: PlayerInfo) {
  const link = store.linkByRoblox(p.UserId);
  if (!link) return;
  await applyRoles(link.discordId, p.Branch && p.Branch !== "None" ? p.Branch : undefined, p.Rank).catch((err) =>
    log.warn("rank role sync failed:", err instanceof Error ? err.message : err),
  );
}

export function registerRanks(c: Client) {
  client = c;

  on("rank_changed", async (e) => {
    const p = e as unknown as PlayerInfo & { Source?: string };
    const branchName = (p.Branch && config.branches[p.Branch]?.name) || p.Branch || "None";
    line("ranks", `<t:${e.At}:T> 🎖️ **${who(p)}** is now **${p.Rank || "—"}** in **${branchName}** *(changed in ${p.Source === "discord" ? "Discord" : "game"})*`);
    if (p.Source !== "discord") await syncFromGame(p);
  });
  on("join", (e) => syncFromGame(e as unknown as PlayerInfo));

  client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
    if (newMember.guild.id !== config.guildId || isSuppressed(newMember.id)) return;
    const link = store.linkByDiscord(newMember.id);
    if (!link) return;

    const index = rankRoleIndex();
    const added = newMember.roles.cache.filter((r) => !oldMember.roles.cache.has(r.id) && index.has(r.id));
    const removed = oldMember.roles.cache.filter((r) => !newMember.roles.cache.has(r.id) && index.has(r.id));

    if (added.size > 0) {
      // Highest rank among the newly added roles wins.
      const target = [...added.keys()].map((id) => index.get(id)!).sort((a, b) => b.order - a.order)[0];
      try {
        await setRankFromDiscord(link.robloxId, target.branch, target.rank, `Discord (${newMember.user.tag})`);
        line("ranks", `🎖️ ${newMember} → **${target.rank}** in **${config.branches[target.branch].name}** *(set from Discord, syncing to game)*`);
      } catch (err) {
        log.warn("Discord -> game rank sync failed:", err);
        line("ranks", `⚠️ Couldn't sync ${newMember}'s new rank to the game: ${err instanceof Error ? err.message : err}`);
      }
      return;
    }

    if (removed.size > 0 && config.removeBranchWhenRankRoleRemoved) {
      const stillHasRank = newMember.roles.cache.some((r) => index.has(r.id));
      if (!stillHasRank) {
        await setRankFromDiscord(link.robloxId, "None", undefined, `Discord (${newMember.user.tag})`).catch(() => undefined);
        line("ranks", `🎖️ ${newMember} lost their rank role in Discord — removed from their branch in game`);
      }
    }
  });
}
