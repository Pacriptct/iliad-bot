// Server + event commands: /announce, /servers, /shutdown, /restart, /status.
// (PDs are started and ended in game only.)
import { randomUUID } from "node:crypto";
import { EmbedBuilder, SlashCommandBuilder } from "discord.js";
import { store } from "../store.js";
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
    await i.deferReply({ ephemeral: true });
    // Roblox requires text to be filtered as written by a real account.
    const link = store.linkByDiscord(i.user.id);
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
      await i.reply({ ephemeral: true, content: "No servers have checked in (they report every 60 seconds)." });
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
        name: `${s.players.length}/${s.maxPlayers || "?"} · up ${formatDuration(s.uptime)}${tags ? ` · ${tags}` : ""}`,
        value: `\`${s.jobId}\`\n${names}`.slice(0, 1024),
      });
    }
    await i.reply({ ephemeral: true, embeds: [e] });
  },
};

// ── /shutdown ────────────────────────────────────────────────────────────────

export const shutdown: Command = {
  staff: true,
  data: new SlashCommandBuilder()
    .setName("shutdown")
    .setDescription("Shut down one server (by job id) or all of them.")
    .addStringOption((o) => o.setName("server").setDescription("Job id from /servers, or \"all\"").setRequired(true))
    .addStringOption((o) => o.setName("reason").setDescription("Shown to players").setMaxLength(200)),
  async execute(i) {
    await i.deferReply({ ephemeral: true });
    const server = i.options.getString("server", true).trim();
    const reason = i.options.getString("reason") ?? "Server shutting down.";
    const all = server.toLowerCase() === "all";
    try {
      await game.shutdown(reason, all ? undefined : server);
      line("moderation", `⛔ ${i.user} shut down ${all ? "**all servers**" : `server \`${server}\``}: ${reason}`);
      await i.editReply(all ? "Shutting down every server." : `Shutting down \`${server}\`.`);
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
    .setDescription("Restart every server (players are moved to fresh servers on the latest version).")
    .addBooleanOption((o) => o.setName("confirm").setDescription("Set to True to restart").setRequired(true))
    .addIntegerOption((o) =>
      o.setName("bleed_minutes").setDescription("Let servers empty out over this many minutes instead of closing now").setMinValue(1).setMaxValue(60),
    ),
  async execute(i) {
    if (!i.options.getBoolean("confirm", true)) {
      await i.reply({ ephemeral: true, content: "Not restarted (confirm was False)." });
      return;
    }
    await i.deferReply({ ephemeral: true });
    const bleed = i.options.getInteger("bleed_minutes") ?? undefined;
    try {
      await restartServers(bleed);
      line("moderation", `🔄 ${i.user} restarted all servers${bleed ? ` (bleed-off ${bleed}m)` : ""}`);
      await i.editReply(bleed ? `Restarting: servers will bleed off over ${bleed} minutes.` : "Restarting all servers.");
    } catch (err) {
      await i.editReply(`Failed: ${errText(err)}`);
    }
  },
};

// ── /status ──────────────────────────────────────────────────────────────────

export const status: Command = {
  staff: true,
  data: new SlashCommandBuilder().setName("status").setDescription("Check the bot <-> game connection."),
  async execute(i) {
    await i.deferReply({ ephemeral: true });
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
