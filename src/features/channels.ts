// Batched channel sender: log lines and embeds are queued per channel and
// flushed every couple of seconds, so busy servers can't hit Discord rate limits.
import type { Client, EmbedBuilder, TextBasedChannel } from "discord.js";
import { config } from "../config.js";
import { log } from "../log.js";

type ChannelKey = keyof typeof config.channels;

interface Pending {
  lines: string[];
  embeds: EmbedBuilder[];
}

const queues = new Map<string, Pending>();
let client: Client | undefined;

export function startChannels(c: Client) {
  client = c;
  setInterval(flush, 2000);
  checkChannels().catch(() => undefined);
}

/** Startup check: say which logs are off and which channel ids can't be reached. */
async function checkChannels() {
  const off = Object.entries(config.channels).filter(([, id]) => !id).map(([k]) => k);
  if (off.length) log.info(`logs turned off (no channel id): ${off.join(", ")}`);
  for (const [key, id] of Object.entries(config.channels)) {
    if (id && !(await resolve(id))) log.warn(`channels.${key}: can't reach channel ${id} (wrong id, or the bot can't see it)`);
  }
}

function queueFor(key: ChannelKey): Pending | undefined {
  return queueForId(config.channels[key]);
}

function queueForId(id: string): Pending | undefined {
  if (!id) return undefined;
  let q = queues.get(id);
  if (!q) {
    q = { lines: [], embeds: [] };
    queues.set(id, q);
  }
  return q;
}

/** Queue a plain log line (grouped into one message per flush). */
export function line(key: ChannelKey, text: string) {
  queueFor(key)?.lines.push(text.length > 1800 ? `${text.slice(0, 1800)}…` : text);
}

/** Queue a log line for a channel by id (e.g. a branch server's rank log). */
export function lineTo(channelId: string, text: string) {
  queueForId(channelId)?.lines.push(text.length > 1800 ? `${text.slice(0, 1800)}…` : text);
}

/** Queue an embed. */
export function embed(key: ChannelKey, e: EmbedBuilder) {
  queueFor(key)?.embeds.push(e);
}

/** Send right away (announcements that should ping). */
export async function sendNow(key: ChannelKey, payload: { content?: string; embeds?: EmbedBuilder[] }) {
  const channel = await resolve(config.channels[key]);
  if (channel && "send" in channel) {
    await channel.send({ ...payload, allowedMentions: { parse: ["everyone", "roles"] } });
  }
}

async function resolve(id: string): Promise<TextBasedChannel | undefined> {
  if (!client || !id) return undefined;
  const channel = client.channels.cache.get(id) ?? (await client.channels.fetch(id).catch(() => null));
  return channel && channel.isTextBased() ? channel : undefined;
}

async function flush() {
  for (const [id, q] of queues) {
    if (!q.lines.length && !q.embeds.length) continue;
    const channel = await resolve(id);
    if (!channel || !("send" in channel)) {
      log.warn(`can't post to channel ${id}: not found, not a text channel, or the bot can't see it (check the channel ids in config.json)`);
      q.lines = [];
      q.embeds = [];
      continue;
    }
    try {
      // Lines: pack into ≤1900-char messages.
      while (q.lines.length) {
        let content = "";
        while (q.lines.length && content.length + q.lines[0].length + 1 <= 1900) {
          content += (content ? "\n" : "") + q.lines.shift();
        }
        if (!content) content = q.lines.shift()!.slice(0, 1900);
        await channel.send({ content, allowedMentions: { parse: [] } });
      }
      // Embeds: up to 10 per message.
      while (q.embeds.length) {
        await channel.send({ embeds: q.embeds.splice(0, 10), allowedMentions: { parse: [] } });
      }
    } catch (err) {
      log.warn(`send to channel ${id} failed:`, err instanceof Error ? err.message : err);
      q.lines = [];
      q.embeds = [];
    }
  }
}
