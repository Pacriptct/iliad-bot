// Game -> bot event shapes. Contract: framework/docs/features/DiscordBridge.md.
/* eslint-disable @typescript-eslint/no-explicit-any */

export interface PlayerInfo {
  UserId: number;
  Name: string;
  Character?: string;
  Branch?: string;
  Rank?: string;
}

export interface BatchMeta {
  JobId: string;
  PlaceId: number;
  Studio: boolean;
}

export interface OutboxBatch extends BatchMeta {
  Events: GameEvent[];
}

export interface GameEvent {
  Type: string;
  At: number;
  [key: string]: any;
}

/** Event handler: gets the event plus the server it came from. */
export type Handler = (event: GameEvent, meta: BatchMeta) => void | Promise<void>;

const handlers = new Map<string, Handler[]>();

export function on(type: string, handler: Handler) {
  const list = handlers.get(type) ?? [];
  list.push(handler);
  handlers.set(type, list);
}

export async function dispatch(event: GameEvent, meta: BatchMeta) {
  for (const handler of [...(handlers.get(event.Type) ?? []), ...(handlers.get("*") ?? [])]) {
    try {
      await handler(event, meta);
    } catch (err) {
      console.error(`handler for ${event.Type} failed:`, err);
    }
  }
}

/** **Character** (username), or **username** if they have no character. */
export function name(p?: Partial<PlayerInfo>): string {
  if (!p) return "**Unknown**";
  return p.Character ? `**${p.Character}** (${p.Name})` : `**${p.Name ?? "Unknown"}**`;
}

/** "Character (username)" or just the username. */
export function who(p?: PlayerInfo): string {
  if (!p) return "Unknown";
  return p.Character ? `${p.Character} (${p.Name})` : p.Name;
}
