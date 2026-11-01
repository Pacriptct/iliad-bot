// Small JSON-file store (data/store.json): account links, pending link codes,
// the bot-side warning history and each player's last known branch/rank. Writes are atomic (temp file + rename).
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

export interface Link {
  discordId: string;
  robloxId: number;
  robloxName: string;
  linkedAt: number;
}

export interface Warning {
  reason: string;
  by: string;
  at: number;
}

export interface KnownRank {
  branch?: string;
  rank?: string;
  at: number;
}

export interface Transfer {
  id: string;
  robloxId: number;
  robloxName: string;
  from: string;
  fromRank?: string;
  to: string;
  rank: string;
  requestedBy: string; // discord id
  requestedAt: number;
  status: "pending" | "approved" | "denied" | "cancelled" | "expired";
  decidedBy?: string; // discord id
  /** Approval message, so it can be updated. */
  message?: { channelId: string; messageId: string };
}

export interface Mute {
  /** When it ends (ms since epoch), or -1 for permanent. */
  until: number;
  reason: string;
  by: string;
  at: number;
}

/** A bloodline application's review card in Discord (features/bloodlines.ts). */
export interface BloodlineCard {
  appId: string;
  revision: number;
  /** The game's state (Pending, Approved, ...), or Superseded by a newer revision's card. */
  state: string;
  name: string;
  surname: string;
  lore: string;
  ranks: string[];
  founderName: string;
  applicantId: number;
  applicantName: string;
  submittedAt: number; // seconds
  channelId: string;
  messageId: string;
  /** A decision sent to the game and not answered yet. */
  queued?: { decisionId: string; by: string; action: "approve" | "changes" | "reject"; at: number };
  decidedBy?: string;
  reason?: string;
  supersededBy?: number;
  /** Shown under the status (a refused attempt). */
  note?: string;
}

interface Data {
  links: Record<string, Link>; // discordId -> link
  codes: Record<string, { discordId: string; expires: number }>;
  warnings: Record<string, Warning[]>; // robloxId -> warnings
  ranks: Record<string, KnownRank>; // robloxId -> last known branch/rank
  transfers: Record<string, Transfer>; // id -> transfer request
  mutes: Record<string, Mute>; // discordId -> Discord mute
  bloodlineCards: Record<string, BloodlineCard>; // appId -> its latest card
}

const dir = resolve(process.cwd(), "data");
const file = resolve(dir, "store.json");

function load(): Data {
  if (!existsSync(file)) {
    return { links: {}, codes: {}, warnings: {}, ranks: {}, transfers: {}, mutes: {}, bloodlineCards: {} };
  }
  const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<Data>;
  return {
    links: parsed.links ?? {},
    codes: parsed.codes ?? {},
    warnings: parsed.warnings ?? {},
    ranks: parsed.ranks ?? {},
    transfers: parsed.transfers ?? {},
    mutes: parsed.mutes ?? {},
    bloodlineCards: parsed.bloodlineCards ?? {},
  };
}

const data = load();

function save() {
  mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, file);
}

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
const CODE_TTL_MS = 10 * 60 * 1000;

export const store = {
  // ── Links ────────────────────────────────────────────────────────────────
  linkByDiscord(discordId: string): Link | undefined {
    return data.links[discordId];
  },
  linkByRoblox(robloxId: number): Link | undefined {
    return Object.values(data.links).find((l) => l.robloxId === robloxId);
  },
  setLink(link: Link) {
    // One Roblox account per Discord account and vice versa.
    for (const [discordId, existing] of Object.entries(data.links)) {
      if (existing.robloxId === link.robloxId) delete data.links[discordId];
    }
    data.links[link.discordId] = link;
    save();
  },
  removeLink(discordId: string): Link | undefined {
    const link = data.links[discordId];
    if (link) {
      delete data.links[discordId];
      save();
    }
    return link;
  },
  updateRobloxName(robloxId: number, name: string) {
    const link = this.linkByRoblox(robloxId);
    if (link && link.robloxName !== name) {
      link.robloxName = name;
      save();
    }
  },

  // ── Link codes ───────────────────────────────────────────────────────────
  createCode(discordId: string): string {
    const now = Date.now();
    for (const [code, entry] of Object.entries(data.codes)) {
      if (entry.expires < now || entry.discordId === discordId) delete data.codes[code];
    }
    let code = "";
    do {
      code = Array.from({ length: 6 }, () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]).join("");
    } while (data.codes[code]);
    data.codes[code] = { discordId, expires: now + CODE_TTL_MS };
    save();
    return code;
  },
  consumeCode(code: string): string | undefined {
    const entry = data.codes[code.toUpperCase()];
    if (!entry) return undefined;
    delete data.codes[code.toUpperCase()];
    save();
    return entry.expires >= Date.now() ? entry.discordId : undefined;
  },

  // ── Warnings ─────────────────────────────────────────────────────────────
  addWarning(robloxId: number, warning: Warning) {
    (data.warnings[String(robloxId)] ??= []).push(warning);
    save();
  },
  warnings(robloxId: number): Warning[] {
    return data.warnings[String(robloxId)] ?? [];
  },

  // ── Known ranks (from the game) ──────────────────────────────────────────
  rankOf(robloxId: number): KnownRank | undefined {
    return data.ranks[String(robloxId)];
  },
  setRank(robloxId: number, branch: string | undefined, rank: string | undefined) {
    const known = branch && branch !== "None" ? { branch, rank, at: Date.now() } : { at: Date.now() };
    const old = data.ranks[String(robloxId)];
    if (old && old.branch === known.branch && old.rank === known.rank) return;
    data.ranks[String(robloxId)] = known;
    save();
  },

  // ── Discord mutes ────────────────────────────────────────────────────────
  muteOf(discordId: string): Mute | undefined {
    const m = data.mutes[discordId];
    if (m && m.until !== -1 && m.until <= Date.now()) {
      delete data.mutes[discordId];
      save();
      return undefined;
    }
    return m;
  },
  activeMutes(): [string, Mute][] {
    return Object.keys(data.mutes)
      .map((id) => [id, this.muteOf(id)] as [string, Mute | undefined])
      .filter((e): e is [string, Mute] => e[1] !== undefined);
  },
  setMute(discordId: string, mute: Mute | undefined) {
    if (mute) data.mutes[discordId] = mute;
    else delete data.mutes[discordId];
    save();
  },

  // ── Transfers ────────────────────────────────────────────────────────────
  transfer(id: string): Transfer | undefined {
    return data.transfers[id];
  },
  pendingTransferFor(robloxId: number): Transfer | undefined {
    return Object.values(data.transfers).find((t) => t.robloxId === robloxId && t.status === "pending");
  },
  pendingTransfers(): Transfer[] {
    return Object.values(data.transfers).filter((t) => t.status === "pending");
  },
  saveTransfer(t: Transfer) {
    data.transfers[t.id] = t;
    // Keep the last 500 decided requests.
    const decided = Object.values(data.transfers)
      .filter((x) => x.status !== "pending")
      .sort((a, b) => b.requestedAt - a.requestedAt);
    for (const old of decided.slice(500)) delete data.transfers[old.id];
    save();
  },

  // ── Bloodline review cards ───────────────────────────────────────────────
  bloodlineCard(appId: string): BloodlineCard | undefined {
    return data.bloodlineCards[appId];
  },
  saveBloodlineCard(card: BloodlineCard) {
    data.bloodlineCards[card.appId] = card;
    // Keep the last 500 decided cards.
    const decided = Object.values(data.bloodlineCards)
      .filter((c) => c.state !== "Pending")
      .sort((a, b) => b.submittedAt - a.submittedAt);
    for (const old of decided.slice(500)) delete data.bloodlineCards[old.appId];
    save();
  },
};
