// Live server registry built from the game's heartbeats.
import { on, type PlayerInfo } from "./events.js";

export interface ServerInfo {
  jobId: string;
  placeId: number;
  studio: boolean;
  private: boolean;
  players: PlayerInfo[];
  maxPlayers: number;
  uptime: number;
  lastSeen: number;
}

const STALE_MS = 150_000; // heartbeat is every 60s

const servers = new Map<string, ServerInfo>();

export function liveServers(): ServerInfo[] {
  const now = Date.now();
  for (const [id, s] of servers) {
    if (now - s.lastSeen > STALE_MS) servers.delete(id);
  }
  return [...servers.values()].sort((a, b) => b.players.length - a.players.length);
}

/** Server a player is currently on, if any. */
export function findPlayer(userId: number): ServerInfo | undefined {
  return liveServers().find((s) => s.players.some((p) => p.UserId === userId));
}

export function registerServers() {
  on("server", (e, meta) => {
    servers.set(meta.JobId, {
      jobId: meta.JobId,
      placeId: meta.PlaceId,
      studio: meta.Studio,
      private: Boolean(e.Private),
      players: Array.isArray(e.Players) ? e.Players : [],
      maxPlayers: Number(e.MaxPlayers) || 0,
      uptime: Number(e.Uptime) || 0,
      lastSeen: Date.now(),
    });
  });
  on("server_close", (_e, meta) => {
    servers.delete(meta.JobId);
  });
  // Keep rosters fresh between heartbeats.
  on("join", (e, meta) => {
    const s = servers.get(meta.JobId);
    if (s && !s.players.some((p) => p.UserId === e.UserId)) s.players.push(e as unknown as PlayerInfo);
  });
  on("leave", (e, meta) => {
    const s = servers.get(meta.JobId);
    if (s) s.players = s.players.filter((p) => p.UserId !== e.UserId);
  });
}
