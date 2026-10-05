// Discord <-> Roblox account linking. /link gives a code; the player types
// "/link CODE" in game; the game emits a `link` event and we match it here.
import type { Client } from "discord.js";
import { log } from "../log.js";
import { store } from "../store.js";
import { on, type PlayerInfo } from "../bridge/events.js";
import { game } from "../bridge/game.js";
import { applyRoles } from "./ranks.js";
import { line } from "./channels.js";

export function registerLinking(client: Client) {
  on("link", async (e) => {
    const p = e as unknown as PlayerInfo & { Code?: string };
    const discordId = p.Code ? store.consumeCode(p.Code) : undefined;
    if (!discordId) {
      log.info(`link: unknown/expired code from ${p.Name}`);
      return;
    }
    store.setLink({ discordId, robloxId: p.UserId, robloxName: p.Name, linkedAt: Date.now() });
    store.setRank(p.UserId, p.Branch, p.Rank);
    const user = await client.users.fetch(discordId).catch(() => undefined);
    await applyRoles(discordId, p.Branch && p.Branch !== "None" ? p.Branch : undefined, p.Rank).catch(() => undefined);
    await game.linked(p.UserId, user?.username ?? discordId).catch(() => undefined);
    await user?.send(`✅ Linked to Roblox account **${p.Name}**${p.Character ? ` (${p.Character})` : ""}. Your branch roles will now stay in sync.`).catch(() => undefined);
    line("moderation", `🔗 <@${discordId}> linked Roblox **${p.Name}** (\`${p.UserId}\`)`);
  });
}
