// Automatic account linking through Bloxlink or RoVer, so players who already
// verified with one of those bots never need a code.
//
//   * When someone joins the main server or a branch server, the bot looks
//     them up and links them straight away (and gives their roles if the bot
//     already knows their rank).
//   * Commands that need a link (/link, /pigeon, /announce, @mentions in staff
//     commands) look the person up on the spot if they aren't linked yet.
//   * /linkall (staff) links everyone already in the main server.
// The /link code flow still works for anyone who isn't verified with either bot.
import { Events, type Client } from "discord.js";
import { config, secrets } from "../config.js";
import { log } from "../log.js";
import { store, type Link } from "../store.js";
import { userById } from "../roblox/users.js";
import { applyRoles } from "./ranks.js";
import { line } from "./channels.js";

const MISS_TTL_MS = 10 * 60 * 1000; // don't re-ask about someone who isn't verified for 10 min
const misses = new Map<string, number>();
let client: Client | undefined;

export const autoLinkEnabled = () => config.autoLink.provider !== "none" && Boolean(secrets.autoLinkKey);

/** Ask the provider which Roblox account a Discord user verified. */
async function lookup(discordId: string): Promise<number | undefined> {
  const guild = config.autoLink.guildId || config.guildId;
  const key = secrets.autoLinkKey!;
  let url: string;
  let headers: Record<string, string>;
  if (config.autoLink.provider === "bloxlink") {
    url = `https://api.blox.link/v4/public/guilds/${guild}/discord-to-roblox/${discordId}`;
    headers = { Authorization: key };
  } else {
    url = `https://registry.rover.link/api/guilds/${guild}/discord-to-roblox/${discordId}`;
    headers = { Authorization: `Bearer ${key}` };
  }
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
  if (res.status === 404) return undefined; // not verified
  if (!res.ok) throw new Error(`${config.autoLink.provider} lookup -> ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { robloxID?: string | number; robloxId?: string | number };
  const id = Number(body.robloxID ?? body.robloxId);
  return Number.isFinite(id) && id > 0 ? id : undefined;
}

/**
 * The member's link, creating it from Bloxlink / RoVer if they don't have one.
 * Never throws; returns undefined if they aren't verified (or the lookup failed).
 */
export async function ensureLinked(discordId: string, quiet = false): Promise<Link | undefined> {
  const existing = store.linkByDiscord(discordId);
  if (existing || !autoLinkEnabled()) return existing;
  const missedAt = misses.get(discordId);
  if (missedAt && Date.now() - missedAt < MISS_TTL_MS) return undefined;

  try {
    const robloxId = await lookup(discordId);
    if (!robloxId) {
      misses.set(discordId, Date.now());
      return undefined;
    }
    // Someone else already holds this Roblox account through a code link: leave it.
    const holder = store.linkByRoblox(robloxId);
    if (holder && holder.discordId !== discordId) {
      misses.set(discordId, Date.now());
      return undefined;
    }
    const user = await userById(robloxId);
    const link: Link = { discordId, robloxId, robloxName: user?.name ?? String(robloxId), linkedAt: Date.now() };
    store.setLink(link);
    misses.delete(discordId);

    // Only touch roles once the bot knows their rank (it learns it when they
    // next join the game), so verified members don't lose hand-given roles.
    const known = store.rankOf(robloxId);
    if (known) await applyRoles(discordId, known.branch, known.rank).catch(() => undefined);

    if (!quiet) line("moderation", `🔗 <@${discordId}> auto-linked to Roblox **${link.robloxName}** (\`${robloxId}\`) via ${config.autoLink.provider}`);
    if (config.autoLink.dm && client) {
      const u = await client.users.fetch(discordId).catch(() => undefined);
      await u
        ?.send(`✅ You're linked to Roblox **${link.robloxName}** (from your ${config.autoLink.provider} verification). Your branch roles will stay in sync with the game.`)
        .catch(() => undefined);
    }
    return link;
  } catch (err) {
    misses.set(discordId, Date.now());
    log.warn("auto-link failed:", err instanceof Error ? err.message : err);
    return undefined;
  }
}

/** Link everyone in the main server who isn't linked yet. Slow on purpose (provider rate limits). */
export async function linkAll(): Promise<{ checked: number; linked: number }> {
  const guild = client?.guilds.cache.get(config.guildId);
  if (!guild) return { checked: 0, linked: 0 };
  const members = await guild.members.fetch();
  let checked = 0;
  let linked = 0;
  for (const member of members.values()) {
    if (member.user.bot || store.linkByDiscord(member.id)) continue;
    checked++;
    misses.delete(member.id);
    if (await ensureLinked(member.id, true)) linked++;
    await new Promise((r) => setTimeout(r, 1100));
  }
  return { checked, linked };
}

export function registerAutoLink(c: Client) {
  client = c;
  if (!autoLinkEnabled()) {
    log.info("auto-link: off (set autoLink.provider and its API key to turn it on)");
    return;
  }
  log.info(`auto-link: on via ${config.autoLink.provider}`);
  c.on(Events.GuildMemberAdd, (member) => {
    if (member.user.bot) return;
    // Give the provider's own bot a moment to verify a brand new member.
    setTimeout(() => ensureLinked(member.id).catch(() => undefined), 5000);
  });
}
