// Discord mutes, using Discord's own timeout ("Time out member").
//
// A mute applies in the main server and every branch server the member is in,
// and follows them if they join another of the servers (or leave and rejoin).
// Discord caps a single timeout at 28 days, so longer and permanent mutes are
// renewed automatically before they run out. Unmute with /unmute (removing the
// timeout by hand gets re-applied on the next renewal).
import { Events, type Client } from "discord.js";
import { allGuilds } from "../config.js";
import { log } from "../log.js";
import { store, type Mute } from "../store.js";

const MAX_TIMEOUT_MS = 28 * 24 * 60 * 60 * 1000 - 60_000;
const RENEW_WITHIN_MS = 2 * 24 * 60 * 60 * 1000;
let client: Client;

/** How long the next Discord timeout should last for this mute (ms), or 0 if it's over. */
function nextTimeout(mute: Mute): number {
  const left = mute.until === -1 ? Infinity : mute.until - Date.now();
  return left <= 0 ? 0 : Math.min(left, MAX_TIMEOUT_MS);
}

async function applyIn(guildId: string, discordId: string, mute: Mute | undefined): Promise<boolean> {
  const guild = client.guilds.cache.get(guildId);
  const member = await guild?.members.fetch(discordId).catch(() => undefined);
  if (!member) return false;
  const ms = mute ? nextTimeout(mute) : 0;
  if (ms > 0) await member.timeout(ms, mute!.reason || "Muted");
  else if (member.communicationDisabledUntilTimestamp) await member.timeout(null, "Unmuted");
  return true;
}

/** Apply (or clear) a member's mute in every server. Returns the server names it applied in. */
async function applyEverywhere(discordId: string, mute: Mute | undefined): Promise<{ done: string[]; failed: string[] }> {
  const done: string[] = [];
  const failed: string[] = [];
  for (const guildId of allGuilds()) {
    const name = client.guilds.cache.get(guildId)?.name ?? guildId;
    try {
      if (await applyIn(guildId, discordId, mute)) done.push(name);
    } catch (err) {
      failed.push(name);
      log.warn(`mute in ${name} failed:`, err instanceof Error ? err.message : err);
    }
  }
  return { done, failed };
}

export async function muteMember(discordId: string, mute: Mute) {
  store.setMute(discordId, mute);
  return applyEverywhere(discordId, mute);
}

export async function unmuteMember(discordId: string) {
  store.setMute(discordId, undefined);
  return applyEverywhere(discordId, undefined);
}

/** Re-apply timeouts that are about to run out on long / permanent mutes. */
async function renew() {
  for (const [discordId, mute] of store.activeMutes()) {
    if (nextTimeout(mute) === 0) continue;
    for (const guildId of allGuilds()) {
      const member = await client.guilds.cache.get(guildId)?.members.fetch(discordId).catch(() => undefined);
      if (!member) continue;
      const endsAt = member.communicationDisabledUntilTimestamp ?? 0;
      const muteEnds = mute.until === -1 ? Infinity : mute.until;
      if (endsAt - Date.now() < RENEW_WITHIN_MS && endsAt < muteEnds) {
        await member.timeout(nextTimeout(mute), mute.reason || "Muted").catch((err) => log.warn("mute renewal failed:", err.message));
      }
    }
  }
}

export function registerMutes(c: Client) {
  client = c;
  // Follow them into other servers / back in after leaving.
  c.on(Events.GuildMemberAdd, async (member) => {
    if (!allGuilds().includes(member.guild.id)) return;
    const mute = store.muteOf(member.id);
    if (mute) await applyIn(member.guild.id, member.id, mute).catch(() => undefined);
  });
  c.once(Events.ClientReady, () => {
    renew().catch(() => undefined);
    setInterval(() => renew().catch(() => undefined), 60 * 60 * 1000);
  });
}
