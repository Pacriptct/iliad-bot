// Server + event commands: /announce, /servers, /shutdown, /restart, /status.
// (PDs are started and ended in game only.)
import { randomUUID } from "node:crypto";
import { EmbedBuilder, SlashCommandBuilder, MessageFlags } from "discord.js";
import { config, placeName, resolvePlace } from "../config.js";
import { ensureLinked } from "../features/autolink.js";
import { line } from "../features/channels.js";
import { game } from "../bridge/game.js";
import { on } from "../bridge/events.js";
import { liveServers } from "../bridge/servers.js";
import { outboxStats } from "../bridge/outbox.js";
import { restartServers } from "../roblox/openCloud.js";
import { formatDuration } from "../roblox/profile.js";
import type { Command } from "./types.js";

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

// /status sends a ping to every server and counts the pongs that come back.
const pongs = new Map<string, { servers: number; players: number }>();
on("pong", (e) => {
  const tally = pongs.get(String(e.Nonce));
  if (tally) {
    tally.servers++;
    tally.players += Number(e.Players) || 0;
  }
});

// ── /announce ────────────────────────────────────────────────────────────────

export const announce: Command = {
  staff: true,
  data: new SlashCommandBuilder()
    .setName("announce")
    .setDescription("Broadcast a message to every server.")
    .addStringOption((o) => o.setName("message").setDescription("What to say").setRequired(true).setMaxLength(400))
    .addStringOption((o) =>
      o
        .setName("style")
        .setDescription("How it shows in game")
        .addChoices({ name: "System message (chat)", value: "system" }, { name: "Shout (center of screen)", value: "shout" }),
    ),
  async execute(i) {
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    // Roblox requires text to be filtered as written by a real account.
    const link = await ensureLinked(i.user.id);
    if (!link) {
      await i.editReply("Link your Roblox account first (`/link`) — announcements are filtered as written by you.");
      return;
    }
    const style = (i.options.getString("style") ?? "system") as "system" | "shout";
    const text = i.options.getString("message", true);
    try {
      await game.announce(style, text, link.robloxName, link.robloxId);
      line("moderation", `📢 ${i.user} announced (${style}): ${text.replace(/@/g, "@​")}`);
      await i.editReply(`Sent to all servers as a ${style === "shout" ? "shout" : "system message"}.`);
    } catch (err) {
      await i.editReply(`Failed: ${errText(err)}`);
    }
  },
};

// ── /servers ─────────────────────────────────────────────────────────────────

export const servers: Command = {
  staff: true,
  data: new SlashCommandBuilder().setName("servers").setDescription("List live game servers and who's on them."),
  async execute(i) {
    const list = liveServers();
    if (!list.length) {
      await i.reply({ flags: MessageFlags.Ephemeral, content: "No servers have checked in (they report every 60 seconds)." });
      return;
    }
    const total = list.reduce((n, s) => n + s.players.length, 0);
    const e = new EmbedBuilder()
      .setColor(0x5b7c99)
      .setTitle(`${list.length} server${list.length === 1 ? "" : "s"} · ${total} player${total === 1 ? "" : "s"}`);
    for (const s of list.slice(0, 25)) {
      const tags = [s.studio && "Studio", s.private && "Private"].filter(Boolean).join(", ");
      const names = s.players.map((p) => p.Name).join(", ") || "*empty*";
      e.addFields({
        name: `${placeName(s.placeId)} · ${s.players.length}/${s.maxPlayers || "?"} · up ${formatDuration(s.uptime)}${tags ? ` · ${tags}` : ""}`,
        value: `\`${s.jobId}\`\n${names}`.slice(0, 1024),
      });
    }
    await i.reply({ flags: MessageFlags.Ephemeral, embeds: [e] });
  },
};

// ── /shutdown ────────────────────────────────────────────────────────────────

export const shutdown: Command = {
  staff: true,
  data: new SlashCommandBuilder()
    .setName("shutdown")
    .setDescription("Shut down one server, every server of one place, or everything.")
    .addStringOption((o) =>
      o.setName("target").setDescription("A server (job id), a place (name or place id), or \"all\"").setRequired(true).setAutocomplete(true),
    )
    .addStringOption((o) => o.setName("reason").setDescription("Shown to players").setMaxLength(200)),
  async execute(i) {
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const target = resolveTarget(i.options.getString("target", true));
    if (!target) {
      await i.editReply("Unknown target. Use a job id from `/servers`, a place name / place id from config, or `all`.");
      return;
    }
    const reason = i.options.getString("reason") ?? "Server shutting down.";
    try {
      await game.shutdown(reason, target);
      line("moderation", `⛔ ${i.user} shut down ${describeTarget(target)}: ${reason}`);
      await i.editReply(`Shutting down ${describeTarget(target)}.`);
    } catch (err) {
      await i.editReply(`Failed: ${errText(err)}`);
    }
  },
};

// ── /restart ─────────────────────────────────────────────────────────────────

export const restart: Command = {
  staff: true,
  data: new SlashCommandBuilder()
    .setName("restart")
    .setDescription("Restart servers onto the latest version (one place, or every place).")
    .addStringOption((o) => o.setName("place").setDescription("Place name / place id, or \"all\"").setRequired(true).setAutocomplete(true))
    .addBooleanOption((o) => o.setName("confirm").setDescription("Set to True to restart").setRequired(true))
    .addIntegerOption((o) =>
      o.setName("bleed_minutes").setDescription("Let servers empty out over this many minutes instead of closing now").setMinValue(1).setMaxValue(60),
    ),
  async execute(i) {
    if (!i.options.getBoolean("confirm", true)) {
      await i.reply({ flags: MessageFlags.Ephemeral, content: "Not restarted (confirm was False)." });
      return;
    }
    const input = i.options.getString("place", true);
    const all = input.trim().toLowerCase() === "all";
    const placeId = all ? undefined : resolvePlace(input);
    if (!all && !placeId) {
      await i.reply({ flags: MessageFlags.Ephemeral, content: "Unknown place. Use a place name from config, a place id, or `all`." });
      return;
    }
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const bleed = i.options.getInteger("bleed_minutes") ?? undefined;
    const what = placeId ? placeName(placeId) : "every place";
    try {
      await restartServers(placeId ? [placeId] : undefined, bleed);
      line("moderation", `🔄 ${i.user} restarted ${what}${bleed ? ` (bleed-off ${bleed}m)` : ""}`);
      await i.editReply(bleed ? `Restarting ${what}: servers will bleed off over ${bleed} minutes.` : `Restarting ${what}.`);
    } catch (err) {
      await i.editReply(`Failed: ${errText(err)}`);
    }
  },
};

type Target = { jobId?: string; placeId?: number };

/** "all" -> {}, a live job id -> { jobId }, a place name / id -> { placeId }. */
function resolveTarget(input: string): Target | undefined {
  const text = input.trim();
  if (text.toLowerCase() === "all") return {};
  const job = liveServers().find((s) => s.jobId === text || (text.length >= 8 && s.jobId.startsWith(text)));
  if (job) return { jobId: job.jobId };
  const placeId = resolvePlace(text);
  if (placeId) return { placeId };
  // A job id we haven't heard a heartbeat from yet.
  return /^[0-9a-f-]{36}$/i.test(text) ? { jobId: text } : undefined;
}

function describeTarget(t: Target): string {
  if (t.jobId) return `server \`${t.jobId}\``;
  if (t.placeId) return `every server of ${placeName(t.placeId)}`;
  return "**all servers**";
}

/** Autocomplete for /restart place and /shutdown target. */
export function targetChoices(command: string, typed: string): { name: string; value: string }[] {
  const out = [{ name: command === "restart" ? "All places" : "All servers", value: "all" }];
  for (const [name, id] of Object.entries(config.roblox.places)) {
    const count = liveServers().filter((s) => s.placeId === id).length;
    out.push({ name: `${command === "restart" ? "" : "Place: "}${name} (${id}) · ${count} live`, value: String(id) });
  }
  if (command === "shutdown") {
    for (const s of liveServers()) {
      out.push({ name: `Server ${s.jobId.slice(0, 8)} · ${placeName(s.placeId)} · ${s.players.length} players`, value: s.jobId });
    }
  }
  const t = typed.toLowerCase();
  return out.filter((c) => c.name.toLowerCase().includes(t) || c.value.toLowerCase().includes(t)).slice(0, 25);
}

// ── /status ──────────────────────────────────────────────────────────────────

export const status: Command = {
  staff: true,
  data: new SlashCommandBuilder().setName("status").setDescription("Check the bot <-> game connection."),
  async execute(i) {
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    const nonce = randomUUID();
    pongs.set(nonce, { servers: 0, players: 0 });
    let pingError: string | undefined;
    try {
      await game.ping(nonce);
    } catch (err) {
      pingError = errText(err);
    }
    // Game flushes its outbox every ~2s and the bot polls every ~2s.
    if (!pingError) await new Promise((r) => setTimeout(r, 8000));
    const tally = pongs.get(nonce)!;
    pongs.delete(nonce);

    const ago = (t: number) => (t ? `<t:${Math.floor(t / 1000)}:R>` : "never");
    const known = liveServers();
    const e = new EmbedBuilder()
      .setColor(pingError ? 0xc0392b : tally.servers ? 0x2e8b57 : 0xd4a017)
      .setTitle("Bridge status")
      .addFields(
        { name: "Outbox", value: `last poll ${ago(outboxStats.lastPoll)}\nlast event ${ago(outboxStats.lastEvent)}\n${outboxStats.events} events · ${outboxStats.errors} errors` },
        { name: "Servers (heartbeats)", value: `${known.length} live · ${known.reduce((n, s) => n + s.players.length, 0)} players` },
        {
          name: "Ping",
          value: pingError ? `publish failed: ${pingError}` : `${tally.servers} server${tally.servers === 1 ? "" : "s"} answered (${tally.players} players)`,
        },
      );
    await i.editReply({ embeds: [e] });
  },
};
