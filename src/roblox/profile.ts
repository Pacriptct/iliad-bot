// Reads a player's saved profile (ProfileService record) straight from the
// game's DataStore through Open Cloud, summarises it and checks it for
// corruption. Read-only: the live game owns writes (ProfileService session lock).
import { config } from "../config.js";
import { getEntry } from "./openCloud.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

export interface ProfileRecord {
  Data?: Record<string, Json>;
  MetaData?: {
    ProfileCreateTime?: number;
    SessionLoadCount?: number;
    ActiveSession?: [number, string] | null; // { placeId, jobId }
    LastUpdate?: number;
  };
}

export interface LoadedProfile {
  record: ProfileRecord;
  data: Record<string, Json>;
  revisionTime?: string;
}

export async function loadProfile(userId: number): Promise<LoadedProfile | undefined> {
  const entry = await getEntry<ProfileRecord>(config.roblox.profileStore, `${config.roblox.profileKeyPrefix}${userId}`);
  if (!entry || typeof entry.value !== "object" || entry.value === null) return undefined;
  return { record: entry.value, data: entry.value.Data ?? {}, revisionTime: entry.revisionCreateTime };
}

// ── Health check ─────────────────────────────────────────────────────────────

type Kind = "string" | "number" | "boolean" | "object" | "array";

// Mirrors the important parts of PlayerService's PROFILE_TEMPLATE.
const EXPECTED: Record<string, Kind> = {
  WipeState: "boolean",
  FirstName: "string",
  LastName: "string",
  FullName: "string",
  Gold: "number",
  HasBankAccount: "boolean",
  Bank: "object",
  ToolInventory: "object",
  Attributes: "object",
  Talents: "object",
  TalentModifiers: "object",
  Skills: "object",
  Keybinds: "object",
  Settings: "object",
  PDsAttended: "number",
  PDsSurvived: "number",
  PDSurvivalTime: "number",
  TotalPlaytime: "number",
  TitanKills: "number",
  OwnedTitles: "array",
  ActiveTitle: "string",
  Reputation: "number",
  Status: "string",
  OwnedGearParts: "object",
  OwnedGear: "object",
  CraftingExperience: "object",
  CharacterSlots: "array",
  ActiveCharacterSlot: "number",
  Letters: "array",
};

const NON_NEGATIVE = ["Gold", "PDsAttended", "PDsSurvived", "PDSurvivalTime", "TotalPlaytime", "TitanKills"];

function kindOf(value: Json): Kind | "null" {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value as Kind;
}

function matches(expected: Kind, actual: Kind | "null", value: Json) {
  if (expected === actual) return true;
  // Luau empty tables / arrays serialise as either [] or {}.
  if ((expected === "array" || expected === "object") && (actual === "array" || actual === "object")) {
    return expected === "object" || Object.keys(value).every((k) => /^\d+$/.test(k));
  }
  return false;
}

export function checkHealth(profile: LoadedProfile): string[] {
  const issues: string[] = [];
  const d = profile.data;

  for (const [key, kind] of Object.entries(EXPECTED)) {
    const actual = kindOf(d[key]);
    if (actual === "null") issues.push(`missing \`${key}\``);
    else if (!matches(kind, actual, d[key])) issues.push(`\`${key}\` is ${actual}, expected ${kind}`);
  }
  for (const key of NON_NEGATIVE) {
    const v = d[key];
    if (typeof v === "number" && (!Number.isFinite(v) || v < 0)) issues.push(`\`${key}\` is ${v}`);
  }
  if (typeof d.Gold === "number" && d.Gold > 1e9) issues.push(`\`Gold\` is suspiciously high (${d.Gold})`);

  const inv = d.ToolInventory;
  if (inv && typeof inv === "object") {
    if (!Array.isArray(inv.Tools) && inv.Tools && Object.keys(inv.Tools).length) issues.push("`ToolInventory.Tools` is not a list");
    for (const [id, count] of Object.entries<Json>(inv.Items ?? {})) {
      if (typeof count !== "number" || !Number.isInteger(count) || count < 0) issues.push(`item \`${id}\` has count ${count}`);
    }
    const tools = new Set<string>(Array.isArray(inv.Tools) ? inv.Tools : []);
    for (const value of Object.values<Json>(inv.Hotbar ?? {})) {
      if (typeof value === "string" && !value.startsWith("item:") && !tools.has(value)) {
        issues.push(`hotbar holds unowned tool \`${value}\``);
      }
    }
  }

  const attrs = d.Attributes;
  if (attrs && typeof attrs === "object") {
    for (const [name, value] of Object.entries<Json>(attrs)) {
      if (name !== "Caps" && (typeof value !== "number" || !Number.isFinite(value))) issues.push(`attribute \`${name}\` is ${JSON.stringify(value)}`);
    }
  }

  const meta = profile.record.MetaData;
  if (meta?.ActiveSession && typeof meta.LastUpdate === "number") {
    const minutes = (Date.now() / 1000 - meta.LastUpdate) / 60;
    if (minutes > 30) issues.push(`session lock looks stuck (no save for ${Math.floor(minutes)} min)`);
  }
  return issues;
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}h ${m}m`;
}
