// Batched channel sender. Log lines are queued per channel and flushed every
// couple of seconds as tidy cards: consecutive lines of the same kind become
// one embed with that kind's colour and title (so several logs can share a
// channel and still read cleanly), and Discord rate limits are never hit.
import { EmbedBuilder, type Client, type TextBasedChannel } from "discord.js";
import { config } from "../config.js";
import { log } from "../log.js";

type ChannelKey = keyof typeof config.channels;

/** Card title + colour per log kind ("rankLog" is a branch server's rank log). */
const KINDS: Record<ChannelKey | "rankLog", { title: string; color: number }> = {
  joins: { title: "Joins & leaves", color: 0x3ba55d },
  servers: { title: "Servers", color: 0x5865f2 },
  chat: { title: "Chat", color: 0x99aab5 },
  adminCommands: { title: "Admin commands", color: 0xfaa61a },
  deaths: { title: "Deaths", color: 0x2f3136 },
  titanKills: { title: "Titan kills", color: 0xc27c0e },
  trades: { title: "Trades", color: 0xfabc22 },
  pdLog: { title: "PD log", color: 0xed4245 },
  pdAnnouncements: { title: "PD", color: 0xed4245 },
  branchAudit: { title: "Branches", color: 0x4ab6ff },
  ranks: { title: "Ranks", color: 0x9b59b6 },
  rankLog: { title: "Ranks", color: 0x9b59b6 },
  crates: { title: "Crates", color: 0x8b5a2b },
  items: { title: "Items", color: 0x1abc9c },
  loot: { title: "Corpse looting", color: 0x607d8b },
  pigeons: { title: "Pigeons", color: 0xc8a96e },
  moderation: { title: "Moderation", color: 0xe67e22 },
};

interface Line {
  kind: keyof typeof KINDS;
  text: string;
}

interface Pending {
  lines: Line[];
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

function queueForId(id: string): Pending | undefined {
  if (!id) return undefined;
  let q = queues.get(id);
  if (!q) {
    q = { lines: [], embeds: [] };
    queues.set(id, q);
  }
  return q;
}

const clip = (text: string) => (text.length > 1000 ? `${text.slice(0, 1000)}…` : text);

/** Queue a log line (grouped into a card per kind on the next flush). */
export function line(key: ChannelKey, text: string) {
  queueForId(config.channels[key])?.lines.push({ kind: key, text: clip(text) });
}

/** Queue a log line for a channel by id (a branch server's rank log). */
export function lineTo(channelId: string, text: string) {
  queueForId(channelId)?.lines.push({ kind: "rankLog", text: clip(text) });
}

/** Queue a standalone embed. */
export function embed(key: ChannelKey, e: EmbedBuilder) {
  if (!e.data.color) e.setColor(KINDS[key].color);
  queueForId(config.channels[key])?.embeds.push(e);
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

/** Turn queued lines into cards: one per run of same-kind lines, ≤ 4000 chars each. */
function toCards(lines: Line[]): EmbedBuilder[] {
  const cards: EmbedBuilder[] = [];
  let kind: Line["kind"] | undefined;
  let body = "";
  const close = () => {
    if (!kind || !body) return;
    cards.push(new EmbedBuilder().setColor(KINDS[kind].color).setAuthor({ name: KINDS[kind].title }).setDescription(body).setTimestamp());
    body = "";
  };
  for (const l of lines) {
    if (l.kind !== kind || body.length + l.text.length + 1 > 4000) {
      close();
      kind = l.kind;
    }
    body += (body ? "\n" : "") + l.text;
  }
  close();
  return cards;
}

async function flush() {
  for (const [id, q] of queues) {
    if (!q.lines.length && !q.embeds.length) continue;
    const embeds = [...toCards(q.lines.splice(0)), ...q.embeds.splice(0)];
    const channel = await resolve(id);
    if (!channel || !("send" in channel)) {
      log.warn(`can't post to channel ${id}: not found, not a text channel, or the bot can't see it (check the channel ids in config.json)`);
      continue;
    }
    try {
      // Up to 10 embeds and ~6000 characters per message.
      while (embeds.length) {
        const batch: EmbedBuilder[] = [];
        let size = 0;
        while (embeds.length && batch.length < 10) {
          const len = embeds[0].length;
          if (batch.length && size + len > 5800) break;
          batch.push(embeds.shift()!);
          size += len;
        }
        await channel.send({ embeds: batch, allowedMentions: { parse: [] } });
      }
    } catch (err) {
      log.warn(`send to channel ${id} failed:`, err instanceof Error ? err.message : err);
    }
  }
}
