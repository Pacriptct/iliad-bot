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
}

export interface Config {
  guildId: string;
  roblox: {
    universeId: string;
    placeIds: number[];
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
for (const b of Object.values(config.branches)) {
  b.guildId ??= "";
  b.officerRoles ??= [];
  b.mainRole ??= "";
  b.rankLog ??= "";
}

/** The Discord server a branch's roles live in. */
export const branchGuild = (b: BranchConfig) => b.guildId || config.guildId;

/** Branch whose own server this is (undefined for the main server). */
export function branchOfGuild(guildId: string | null): string | undefined {
  if (!guildId || guildId === config.guildId) return undefined;
  return Object.entries(config.branches).find(([, b]) => b.guildId === guildId)?.[0];
}

/** Main server + every branch server. */
export function allGuilds(): string[] {
  return [...new Set([config.guildId, ...Object.values(config.branches).map(branchGuild)])].filter(Boolean);
}
