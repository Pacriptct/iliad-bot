// Loads config.json (copy config.example.json) + secrets from the environment.
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

export type Tier = "moderator" | "admin" | "owner";
export const TIERS: Tier[] = ["moderator", "admin", "owner"];

export interface BranchConfig {
  name: string;
  /** Discord role every member of the branch gets. */
  role: string;
  /** Rank id (as in the game's BranchConfig) -> Discord role id, lowest rank first. */
  ranks: Record<string, string>;
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
