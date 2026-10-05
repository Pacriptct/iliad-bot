// Turn a command argument into a Roblox account: a Roblox username, a numeric
// user id, or a Discord mention / id of a linked member.
import { store } from "../store.js";
import { userById, userByName, type RobloxUser } from "../roblox/users.js";

export async function resolvePlayer(input: string): Promise<RobloxUser | undefined> {
  const text = input.trim();
  const mention = text.match(/^<@!?(\d+)>$/);
  if (mention) {
    const link = store.linkByDiscord(mention[1]);
    return link ? { id: link.robloxId, name: link.robloxName, displayName: link.robloxName } : undefined;
  }
  if (/^\d{5,}$/.test(text)) {
    // A long number: a Discord id of a linked member, else a Roblox user id.
    const link = store.linkByDiscord(text);
    if (link) return { id: link.robloxId, name: link.robloxName, displayName: link.robloxName };
    return userById(Number(text));
  }
  return userByName(text);
}
