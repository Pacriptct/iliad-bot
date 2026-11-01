// Bot -> game: live commands (MessagingService) and offline-safe pending
// actions (DataStore, applied on the player's next join or live).
// Contract: framework/docs/features/DiscordBridge.md.
import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { publish, updateEntry } from "../roblox/openCloud.js";

export type ActionKind = "void" | "setRank" | "pigeon" | "warn" | "notice";

export interface PendingAction {
  Id: string;
  Kind: ActionKind;
  Args: Record<string, unknown>;
  At: number;
  By: string;
}

interface PendingRecord {
  Actions: PendingAction[];
}

/** Queue an action for a player (online or not) and nudge their server. */
export async function queueAction(userId: number, kind: ActionKind, args: Record<string, unknown>, by: string) {
  const action: PendingAction = {
    Id: randomUUID(),
    Kind: kind,
    Args: args,
    At: Math.floor(Date.now() / 1000),
    By: by,
  };
  await updateEntry<PendingRecord>(config.roblox.pendingStore, `U_${userId}`, (current) => {
    const actions = Array.isArray(current?.Actions) ? current!.Actions : [];
    return { Actions: [...actions, action] };
  });
  await publish({ Cmd: "pending", UserId: userId });
  return action;
}

/** A staff decision on a bloodline application, made in Discord. */
export interface BloodlineDecision {
  Id: string;
  AppId: string;
  Revision: number;
  Action: "approve" | "changes" | "reject";
  Reason: string;
  RobloxUserId: number;
  RobloxName: string;
  DiscordId: string;
  DiscordName: string;
  At: number;
}

/**
 * Queue a bloodline decision (offline-safe: it waits in the pending store until
 * a server claims it) and nudge the live servers.
 */
export async function queueBloodlineDecision(decision: BloodlineDecision) {
  await updateEntry<{ Decisions: BloodlineDecision[] }>(config.roblox.pendingStore, config.roblox.reviewKey, (current) => {
    const decisions = Array.isArray(current?.Decisions) ? current!.Decisions : [];
    return { ...current, Decisions: [...decisions, decision] };
  });
  await publish({ Cmd: "bloodlineReview" });
}

export const game = {
  /** Every server resends its waiting bloodline applications. */
  bloodlineSync: () => publish({ Cmd: "bloodlineSync" }),
  kick: (userId: number, reason: string) => publish({ Cmd: "kick", UserId: userId, Reason: reason }),
  announce: (kind: "system" | "shout", text: string, by: string, byUserId: number) =>
    publish({ Cmd: "announce", Kind: kind, Text: text, By: by, ByUserId: byUserId }),
  /** Shut down one server (jobId), every server of a place (placeId), or all. */
  shutdown: (reason: string, target: { jobId?: string; placeId?: number } = {}) =>
    publish({ Cmd: "shutdown", Reason: reason, ...(target.jobId ? { JobId: target.jobId } : {}), ...(target.placeId ? { PlaceId: target.placeId } : {}) }),
  linked: (userId: number, discord: string) => publish({ Cmd: "linked", UserId: userId, Discord: discord }),
  ping: (nonce: string) => publish({ Cmd: "ping", Nonce: nonce }),
};
