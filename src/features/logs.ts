// Routes game events to their log channels.
import { EmbedBuilder } from "discord.js";
import { on, who, type BatchMeta, type PlayerInfo } from "../bridge/events.js";
import { store } from "../store.js";
import { embed, line } from "./channels.js";

const ts = (at: number) => `<t:${at}:T>`;
const tag = (meta: BatchMeta) => (meta.Studio ? " `[Studio]`" : "");
const server = (meta: BatchMeta) => `\`${meta.JobId ? meta.JobId.slice(0, 8) : "studio"}\``;

function offer(o: { Gold?: number; Items?: Record<string, number> } | undefined): string {
  if (!o) return "nothing";
  const parts: string[] = [];
  if (o.Gold) parts.push(`${o.Gold} Gold`);
  for (const [id, n] of Object.entries(o.Items ?? {})) parts.push(`${n}× ${id}`);
  return parts.length ? parts.join(", ") : "nothing";
}

/** "killed by a titan (Abnormal)", "shot by Bob", ... */
function deathCause(e: { Cause?: string; Killer?: string; [key: string]: unknown }): string {
  const by = e.Killer ? `**${e.Killer}**` : undefined;
  switch (e.Cause) {
    case "Titan":
      return `was killed by a titan${e.Killer ? ` (${e.Killer})` : ""}`;
    case "Eaten":
      return `was eaten by a titan${e.Killer ? ` (${e.Killer})` : ""}`;
    case "Blade":
      return by ? `was cut down by ${by}` : "was cut down";
    case "Melee":
      return by ? `was beaten to death by ${by}` : "was beaten to death";
    case "Shot":
      return by ? `was shot by ${by}` : "was shot";
    case "Shifter":
      return by ? `was killed by ${by}'s shifter` : "was killed by a shifter";
    default:
      return "died";
  }
}

function dropped(d?: { Gold?: number; Items?: Record<string, number>; Tools?: string[]; GearParts?: number }): string {
  if (!d) return "";
  const parts: string[] = [];
  if (d.Gold) parts.push(`${d.Gold} Gold`);
  for (const [id, n] of Object.entries(d.Items ?? {})) parts.push(`${n}× ${id}`);
  parts.push(...(d.Tools ?? []));
  if (d.GearParts) parts.push(`${d.GearParts} gear part${d.GearParts === 1 ? "" : "s"}`);
  return parts.length ? ` — dropped ${parts.join(", ")}` : "";
}

export function registerLogs() {
  on("join", (e, meta) => {
    store.updateRobloxName(e.UserId, e.Name);
    line("joins", `${ts(e.At)} 🟢 **${who(e as unknown as PlayerInfo)}** joined ${server(meta)}${e.WipeState ? " *(wiped / creating character)*" : ""}${tag(meta)}`);
  });
  on("leave", (e, meta) => {
    line("joins", `${ts(e.At)} 🔴 **${who(e as unknown as PlayerInfo)}** left ${server(meta)}${tag(meta)}`);
  });
  on("server_start", (e, meta) => line("servers", `${ts(e.At)} ▶️ Server ${server(meta)} started${tag(meta)}`));
  on("server_close", (e, meta) => line("servers", `${ts(e.At)} ⏹️ Server ${server(meta)} closed (${e.Players ?? 0} players)${tag(meta)}`));

  on("chat", (e, meta) => {
    line("chat", `${ts(e.At)} ${server(meta)} [${e.Kind}] **${e.Sender}**: ${String(e.Text ?? "").replace(/@/g, "@​")}`);
  });

  on("admin_command", (e, meta) => {
    line("adminCommands", `${ts(e.At)} 🛠️ **${who(e.By)}** ran \`${String(e.Content).replace(/`/g, "ˋ")}\` in ${server(meta)}${tag(meta)}`);
  });

  on("death", (e, meta) => {
    const pos = Array.isArray(e.Position) ? ` at \`${e.Position.join(", ")}\`` : "";
    line(
      "deaths",
      `${ts(e.At)} 💀 **${who(e as unknown as PlayerInfo)}** ${deathCause(e)}${e.DuringPD ? " **during a PD**" : ""}${pos} in ${server(meta)}${dropped(e.Dropped)}${tag(meta)}`,
    );
  });

  on("item_drop", (e, meta) => {
    const what = `${e.Count > 1 ? `${e.Count}× ` : ""}${e.Item}`;
    const why = e.Reason === "overflow" ? " *(didn't fit)*" : "";
    line("items", `${ts(e.At)} 📦 **${who(e as unknown as PlayerInfo)}** dropped ${what}${why} in ${server(meta)}${tag(meta)}`);
  });
  on("item_pickup", (e, meta) => {
    const what = `${e.Count > 1 ? `${e.Count}× ` : ""}${e.Item}`;
    line("items", `${ts(e.At)} ✋ **${who(e as unknown as PlayerInfo)}** picked up ${what} dropped by **${e.DroppedBy ?? e.DroppedById}** in ${server(meta)}${tag(meta)}`);
  });
  on("corpse_loot", (e, meta) => {
    const taken = Array.isArray(e.Taken) ? e.Taken.join(", ") : "something";
    line("loot", `${ts(e.At)} 🪦 **${who(e as unknown as PlayerInfo)}** looted **${e.OwnerName}**'s body: ${taken} in ${server(meta)}${tag(meta)}`);
  });

  on("titan_kill", (e) => {
    line("titanKills", `${ts(e.At)} ⚔️ **${who(e as unknown as PlayerInfo)}** killed ${e.Titan ? `a ${e.Titan}` : "a titan"} (total ${e.Total ?? "?"})`);
  });

  on("trade", (e) => {
    embed(
      "trades",
      new EmbedBuilder()
        .setColor(0xfabc22)
        .setTitle("Trade completed")
        .addFields(
          { name: who(e.A), value: offer(e.OfferA), inline: true },
          { name: who(e.B), value: offer(e.OfferB), inline: true },
        )
        .setTimestamp(e.At * 1000),
    );
  });

  on("crate_pick", (e) => {
    line("crates", `${ts(e.At)} 🔓 **${who(e.By)}** picked the lock on **${e.OwnerName}**'s crate (\`${e.CrateId}\`, ${Math.round((e.Chance ?? 0) * 100)}% chance)`);
  });
  on("crate_theft", (e) => {
    line("crates", `${ts(e.At)} 🧺 **${who(e.By)}** took ${e.What} from **${e.OwnerName}**'s crate (\`${e.CrateId}\`)`);
  });

  on("branch", (e) => {
    const fields = Object.entries(e)
      .filter(([k]) => !["Type", "At"].includes(k))
      .map(([k, v]) => `**${k}**: ${String(v)}`)
      .join("\n");
    embed("branchAudit", new EmbedBuilder().setColor(0x4ab6ff).setTitle(`Branch: ${e.eventType}`).setDescription(fields.slice(0, 4000)).setTimestamp(e.At * 1000));
  });

  on("action_applied", (e) => {
    line("moderation", `${ts(e.At)} ✅ \`${e.Kind}\` applied to **${e.Name}** (\`${e.UserId}\`) — queued by ${e.By}`);
  });
  on("announce_failed", (e) => {
    line("moderation", `${ts(e.At)} ⚠️ Announcement from ${e.By} was blocked by the Roblox filter`);
  });
}
