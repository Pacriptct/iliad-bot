// Routes game events to their log channels. Lines are grouped into cards per
// log kind by channels.ts (which also stamps the time), so lines here stay short:
//   emoji  **Character** (username)  what happened  · `server`
import { EmbedBuilder } from "discord.js";
import { config } from "../config.js";
import { name, on, type BatchMeta, type PlayerInfo } from "../bridge/events.js";
import { store } from "../store.js";
import { rankOrder } from "./ranks.js";
import { embed, line } from "./channels.js";

const asPlayer = (e: unknown) => e as PlayerInfo;
/** Trailing server tag: · `0a1e5fe2` (+ Studio). */
const at = (meta: BatchMeta) => ` · \`${meta.JobId ? meta.JobId.slice(0, 8) : "studio"}\`${meta.Studio ? " *(Studio)*" : ""}`;
/** Keep player-written text from pinging anyone or breaking formatting. */
const quote = (text: unknown) => String(text ?? "").replace(/@/g, "@\u200b").replace(/`/g, "ˋ");
const branchName = (id?: string) => (id && config.branches[id]?.name) || id || "a branch";

function offer(o: { Gold?: number; Items?: Record<string, number> } | undefined): string {
  if (!o) return "nothing";
  const parts: string[] = [];
  if (o.Gold) parts.push(`${o.Gold} Gold`);
  for (const [id, n] of Object.entries(o.Items ?? {})) parts.push(`${n}× ${id}`);
  return parts.length ? parts.join(", ") : "nothing";
}

/** "was killed by a titan (Abnormal)", "was shot by **Bob**", ... */
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
    case "Steam":
      return by ? `was scalded to death by ${by}'s Colossal` : "was scalded to death";
    case "Executed":
      return by ? `was executed by ${by}` : "was executed";
    case "Explosion":
      return by ? `was blown up by ${by}` : "was blown up";
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
  return parts.length ? `\n-# Dropped: ${parts.join(", ")}` : "";
}

/** Chat kinds from the game's ChatService. */
const CHAT: Record<string, { emoji: string; verb: string }> = {
  N: { emoji: "💬", verb: "" },
  W: { emoji: "🤫", verb: " *(whisper)*" },
  T: { emoji: "💭", verb: " *(thought)*" },
  S: { emoji: "📢", verb: " *(shout)*" },
  K: { emoji: "🤐", verb: " *(knocked out)*" },
  SYS: { emoji: "⚙️", verb: " *(system)*" },
  PM: { emoji: "✉️", verb: " *(private message)*" },
};

/** A branch audit event as one readable line. */
function branchLine(e: Record<string, any>): string {
  const target = `**${e.targetName ?? "Someone"}**`;
  const actor = e.actorName ? ` · by ${e.actorName}` : "";
  const note = e.note ? ` · *${e.note}*` : "";
  const branch = `**${branchName(e.bid) || e.branchName}**`;
  switch (e.eventType) {
    case "promote":
    case "demote": {
      const up = rankOrder(e.bid, e.newRank) >= rankOrder(e.bid, e.oldRank);
      const known = rankOrder(e.bid, e.newRank) >= 0 && rankOrder(e.bid, e.oldRank) >= 0;
      const dir = known ? (up ? "promoted" : "demoted") : e.eventType === "promote" ? "promoted" : "demoted";
      return `${dir === "promoted" ? "⬆️" : "⬇️"} ${target} ${dir}: ${e.oldRank ?? "?"} → **${e.newRank ?? "?"}** in ${branch}${actor}${note}`;
    }
    case "join":
      return `➕ ${target} joined ${branch}${e.newRank ? ` as **${e.newRank}**` : ""}${actor}${note}`;
    case "leave":
      return `➖ ${target} left ${branch}${actor}${note}`;
    case "kick":
      return `👢 ${target} was removed from ${branch}${actor}${note}`;
    case "transfer":
      return `🔁 ${target} transferred to ${branch}${e.newRank ? ` as **${e.newRank}**` : ""}${actor}${note}`;
    default:
      return `🏷️ ${target}: ${e.eventType} in ${branch}${actor}${note}`;
  }
}

export function registerLogs() {
  on("join", (e, meta) => {
    store.updateRobloxName(e.UserId, e.Name);
    line("joins", `🟢 ${name(asPlayer(e))} joined${e.WipeState ? " *(new character)*" : ""}${at(meta)}`);
  });
  on("leave", (e, meta) => {
    line("joins", `🔴 ${name(asPlayer(e))} left${at(meta)}`);
  });
  on("server_start", (_e, meta) => line("servers", `▶️ Server started${at(meta)}`));
  on("server_close", (e, meta) => line("servers", `⏹️ Server closed${e.Players ? ` with ${e.Players} player${e.Players === 1 ? "" : "s"}` : ""}${at(meta)}`));

  on("chat", (e, meta) => {
    const kind = CHAT[String(e.Kind)] ?? { emoji: "💬", verb: ` *(${e.Kind})*` };
    line("chat", `${kind.emoji} **${e.Sender}**${kind.verb}: ${quote(e.Text)}${at(meta)}`);
  });

  on("admin_command", (e, meta) => {
    line("adminCommands", `🛠️ ${name(e.By)} ran \`${quote(e.Content)}\`${at(meta)}`);
  });

  on("death", (e, meta) => {
    const pos = Array.isArray(e.Position) ? ` at ${e.Position.join(", ")}` : "";
    line("deaths", `💀 ${name(asPlayer(e))} ${deathCause(e)}${e.DuringPD ? " **during a PD**" : ""}${pos}${at(meta)}${dropped(e.Dropped)}`);
  });

  on("item_drop", (e, meta) => {
    const what = `${e.Count > 1 ? `${e.Count}× ` : ""}${e.Item}`;
    const why = e.Reason === "overflow" ? " *(didn't fit)*" : "";
    line("items", `📦 ${name(asPlayer(e))} dropped ${what}${why}${at(meta)}`);
  });
  on("item_pickup", (e, meta) => {
    const what = `${e.Count > 1 ? `${e.Count}× ` : ""}${e.Item}`;
    line("items", `✋ ${name(asPlayer(e))} picked up ${what} dropped by **${e.DroppedBy ?? e.DroppedById}**${at(meta)}`);
  });
  on("corpse_loot", (e, meta) => {
    const taken = Array.isArray(e.Taken) ? e.Taken.join(", ") : "something";
    line("loot", `🪦 ${name(asPlayer(e))} looted **${e.OwnerName}**'s body: ${taken}${at(meta)}`);
  });

  on("titan_kill", (e, meta) => {
    line("titanKills", `⚔️ ${name(asPlayer(e))} killed ${e.Titan ? `a ${e.Titan}` : "a titan"} · ${e.Total ?? "?"} total${at(meta)}`);
  });

  on("trade", (e) => {
    embed(
      "trades",
      new EmbedBuilder()
        .setAuthor({ name: "Trade" })
        .setDescription(`🤝 ${name(e.A)} ⇄ ${name(e.B)}`)
        .addFields(
          { name: `${e.A?.Character || e.A?.Name || "?"} gave`, value: offer(e.OfferA), inline: true },
          { name: `${e.B?.Character || e.B?.Name || "?"} gave`, value: offer(e.OfferB), inline: true },
        )
        .setTimestamp(e.At * 1000),
    );
  });

  on("crate_pick", (e) => {
    line("crates", `🔓 ${name(e.By)} picked the lock on **${e.OwnerName}**'s crate · ${Math.round((e.Chance ?? 0) * 100)}% chance`);
  });
  on("crate_theft", (e) => {
    line("crates", `🧺 ${name(e.By)} took ${e.What} from **${e.OwnerName}**'s crate`);
  });

  on("branch", (e) => line("branchAudit", branchLine(e)));

  on("action_applied", (e) => {
    line("moderation", `✅ ${e.Kind} applied to **${e.Name}** · queued by ${e.By}`);
  });
  on("announce_failed", (e) => {
    line("moderation", `⚠️ An announcement from ${e.By} was blocked by the Roblox filter`);
  });
}
