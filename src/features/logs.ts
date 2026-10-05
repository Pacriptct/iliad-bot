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
    line("deaths", `${ts(e.At)} 💀 **${who(e as unknown as PlayerInfo)}** died${e.DuringPD ? " **during a PD**" : ""} in ${server(meta)}${tag(meta)}`);
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
