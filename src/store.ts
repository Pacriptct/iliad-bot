// Small JSON-file store (data/store.json): account links, pending link codes and
// the bot-side warning history. Writes are atomic (temp file + rename).
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

interface Data {
  links: Record<string, Link>; // discordId -> link
  codes: Record<string, { discordId: string; expires: number }>;
  warnings: Record<string, Warning[]>; // robloxId -> warnings
}

const dir = resolve(process.cwd(), "data");
const file = resolve(dir, "store.json");

function load(): Data {
  if (!existsSync(file)) {
    return { links: {}, codes: {}, warnings: {} };
  }
  const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<Data>;
  return { links: parsed.links ?? {}, codes: parsed.codes ?? {}, warnings: parsed.warnings ?? {} };
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
};
