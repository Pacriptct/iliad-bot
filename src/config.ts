// Loads config.json (copy config.example.json) + secrets from the environment.
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

export type Tier = "moderator" | "admin" | "owner";
export const TIERS: Tier[] = ["moderator", "admin", "owner"];

export interface BranchConfig {
  name: string;
  /** The branch's own Discord server. "" = its roles live in the main server. */
  guildId: string;
  /** Role every member of the branch gets, in the branch's server. */
  role: string;
  /** Rank id (as in the game's BranchConfig) -> role id in the branch's server, lowest rank first. */
  ranks: Record<string, string>;
  /** Roles in the branch's server allowed to use /rank there (on ranks below their own). */
  officerRoles: string[];
  /** Role in the main server marking members of this branch ("" = none). */
  mainRole: string;
  /** Channel in the branch's server for its rank changes ("" = none). */
  rankLog: string;
  /** Channel in the branch's server where transfer requests OUT of this branch are approved ("" = rankLog). */
  transferChannel: string;
}

/**
 * A Discord-only role the bot hands out from someone's game rank, e.g. "Other
 * Branch Hicom" in the SL server for MP/SG/TC commanders. Game -> Discord only.
 */
export interface RoleRule {
  /** Server the role is in ("" = main server). */
  guildId: string;
  role: string;
  /** Branch ids that qualify, "others" (every branch except the one whose server this is) or "any". */
  branches: string[] | "others" | "any";
  /** Rank ids that qualify (in any of those branches). Empty / missing = any rank. */
  ranks?: string[];
  /** Optional note for yourself, e.g. "Other Branch Hicom". */
  name?: string;
}

export interface Config {
  guildId: string;
  roblox: {
    universeId: string;
    /** Place name -> place id, e.g. { "Main": 123, "Shiganshina": 456 }. Used by /restart, /shutdown and /servers. */
    places: Record<string, number>;
    profileStore: string;
    profileKeyPrefix: string;
    outboxQueue: string;
    topic: string;
    pendingStore: string;
  };
  poll: { intervalMs: number; batchSize: number };
  channels: Record<
    | "joins"
    | "chat"
    | "adminCommands"
    | "deaths"
    | "titanKills"
    | "trades"
    | "pdLog"
    | "pdAnnouncements"
    | "branchAudit"
    | "ranks"
    | "crates"
    | "items"
    | "loot"
    | "pigeons"
    | "moderation"
    | "servers",
    string
  >;
  /** Role id, "@everyone", "@here" or "" for the PD start announcement. */
  pdAnnouncePing: string;
  staffRoles: Record<Tier, string[]>;
  commandPermissions: Record<string, Tier>;
  /** Role given to members who linked their Roblox account ("" = none). */
  linkedRole: string;
  /** If a linked member loses their last rank role in Discord, remove them from their branch in game. */
  removeBranchWhenRankRoleRemoved: boolean;
  /**
   * Allow a branch server to pull someone out of another branch by giving them a
   * rank role. Off: only main-server staff (/rank) can move people between branches.
   */
  allowDiscordTransfers: boolean;
  /** Extra roles given from game rank (see RoleRule). */
  roleRules: RoleRule[];
  branches: Record<string, BranchConfig>;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing environment variable ${name} (see .env.example)`);
  }
  return value;
}

const path = resolve(process.cwd(), "config.json");
if (!existsSync(path)) {
  throw new Error("config.json not found. Copy config.example.json to config.json and fill it in.");
}

export const config: Config = JSON.parse(readFileSync(path, "utf8"));

export const secrets = {
  get discordToken() {
    return required("DISCORD_TOKEN");
  },
  get discordClientId() {
    return required("DISCORD_CLIENT_ID");
  },
  get robloxApiKey() {
    return required("ROBLOX_API_KEY");
  },
};

if (!config.roblox.universeId) {
  throw new Error("config.json: roblox.universeId is required");
}

// Defaults for fields added after a config was written.
config.allowDiscordTransfers ??= false;
config.roleRules ??= [];
config.roblox.places ??= {};
{
  // Older configs had a bare placeIds list.
  const legacy = (config.roblox as { placeIds?: number[] }).placeIds;
  for (const id of legacy ?? []) config.roblox.places[`Place ${id}`] ??= id;
  // Drop unfilled placeholders ("Main": 0).
  for (const [name, id] of Object.entries(config.roblox.places)) if (!Number(id)) delete config.roblox.places[name];
}
for (const b of Object.values(config.branches)) {
  b.guildId ??= "";
  b.officerRoles ??= [];
  b.mainRole ??= "";
  b.rankLog ??= "";
  b.transferChannel ??= "";
}

/** The Discord server a branch's roles live in. */
export const branchGuild = (b: BranchConfig) => b.guildId || config.guildId;

/** Branch whose own server this is (undefined for the main server). */
export function branchOfGuild(guildId: string | null): string | undefined {
  if (!guildId || guildId === config.guildId) return undefined;
  return Object.entries(config.branches).find(([, b]) => b.guildId === guildId)?.[0];
}

/** Display name for a place id ("Main (123)" or just the id). */
export function placeName(id: number): string {
  const name = Object.entries(config.roblox.places).find(([, pid]) => pid === id)?.[0];
  return name ? `${name} (${id})` : String(id);
}

/** Resolve "Main", "main" or "123456" to a place id. */
export function resolvePlace(input: string): number | undefined {
  const text = input.trim();
  const named = Object.entries(config.roblox.places).find(([name]) => name.toLowerCase() === text.toLowerCase());
  if (named) return named[1];
  return /^\d+$/.test(text) ? Number(text) : undefined;
}

/** Main server + every branch server. */
export function allGuilds(): string[] {
  return [...new Set([config.guildId, ...Object.values(config.branches).map(branchGuild)])].filter(Boolean);
}
