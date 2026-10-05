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

interface Data {
  links: Record<string, Link>; // discordId -> link
  codes: Record<string, { discordId: string; expires: number }>;
  warnings: Record<string, Warning[]>; // robloxId -> warnings
  ranks: Record<string, KnownRank>; // robloxId -> last known branch/rank
  transfers: Record<string, Transfer>; // id -> transfer request
  mutes: Record<string, { until: number; reason: string; by: string }>; // robloxId -> mute (until: ms, -1 = permanent)
}

const dir = resolve(process.cwd(), "data");
const file = resolve(dir, "store.json");

function load(): Data {
  if (!existsSync(file)) {
    return { links: {}, codes: {}, warnings: {}, ranks: {}, transfers: {}, mutes: {} };
  }
  const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<Data>;
  return { links: parsed.links ?? {}, codes: parsed.codes ?? {}, warnings: parsed.warnings ?? {}, ranks: parsed.ranks ?? {}, transfers: parsed.transfers ?? {}, mutes: parsed.mutes ?? {} };
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

  // ── Mutes (mirrors the game, so Discord pigeons respect them too) ────────
  muteOf(robloxId: number): { until: number; reason: string; by: string } | undefined {
    const m = data.mutes[String(robloxId)];
    if (m && m.until !== -1 && m.until <= Date.now()) {
      delete data.mutes[String(robloxId)];
      save();
      return undefined;
    }
    return m;
  },
  setMute(robloxId: number, mute: { until: number; reason: string; by: string } | undefined) {
    if (mute) data.mutes[String(robloxId)] = mute;
    else delete data.mutes[String(robloxId)];
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
};
