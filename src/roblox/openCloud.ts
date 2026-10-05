// Roblox Open Cloud client (https://apis.roblox.com/cloud/v2).
// Endpoints/bodies follow Roblox's published OpenAPI spec (creator-docs
// cloud.docs.json). Retries 429 / 5xx with backoff.
import { config, secrets } from "../config.js";
import { log } from "../log.js";

const BASE = "https://apis.roblox.com/cloud/v2";

export class OpenCloudError extends Error {
  constructor(
    public status: number,
    public body: string,
    method: string,
    path: string,
  ) {
    super(`Open Cloud ${method} ${path} -> ${status}: ${body.slice(0, 300)}`);
  }
}

async function request<T>(method: string, path: string, body?: unknown, attempt = 1): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "x-api-key": secrets.robloxApiKey,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if ((res.status === 429 || res.status >= 500) && attempt < 4) {
    const retryAfter = Number(res.headers.get("retry-after")) || 2 ** attempt;
    await new Promise((r) => setTimeout(r, retryAfter * 1000));
    return request<T>(method, path, body, attempt + 1);
  }
  const text = await res.text();
  if (!res.ok) {
    throw new OpenCloudError(res.status, text, method, path);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

const universe = () => `/universes/${config.roblox.universeId}`;
const enc = encodeURIComponent;

// ── MessagingService ─────────────────────────────────────────────────────────

/** Publish to every live server (game listens on config.roblox.topic). Max ~1 kB. */
export async function publish(message: Record<string, unknown>, topic = config.roblox.topic) {
  const text = JSON.stringify(message);
  if (text.length > 1000) {
    log.warn("publish: message over 1 kB, it may be rejected", text.length);
  }
  await request("POST", `${universe()}:publishMessage`, { topic, message: text });
}

// ── MemoryStore queue (game -> bot outbox) ───────────────────────────────────

export interface QueueRead<T> {
  readId?: string;
  items?: { data: T }[];
}

export async function readQueue<T>(queue: string, count: number, invisibility = "30s"): Promise<QueueRead<T>> {
  return request<QueueRead<T>>(
    "GET",
    `${universe()}/memory-store/queues/${enc(queue)}/items:read?count=${count}&allOrNothing=false&invisibilityWindow=${invisibility}`,
  );
}

export async function discardQueue(queue: string, readId: string) {
  await request("POST", `${universe()}/memory-store/queues/${enc(queue)}/items:discard`, { readId });
}

// ── DataStores ───────────────────────────────────────────────────────────────

export interface Entry<T> {
  value: T;
  etag?: string;
  revisionId?: string;
  revisionCreateTime?: string;
  users?: string[];
}

/** Returns undefined if the entry doesn't exist. Default ("global") scope. */
export async function getEntry<T>(store: string, key: string): Promise<Entry<T> | undefined> {
  try {
    return await request<Entry<T>>("GET", `${universe()}/data-stores/${enc(store)}/entries/${enc(key)}`);
  } catch (err) {
    if (err instanceof OpenCloudError && err.status === 404) return undefined;
    throw err;
  }
}

export async function putEntry<T>(store: string, key: string, value: T, etag?: string) {
  await request(
    "PATCH",
    `${universe()}/data-stores/${enc(store)}/entries/${enc(key)}?allowMissing=true`,
    etag ? { value, etag } : { value },
  );
}

/** Read-modify-write with etag; retries if the game wrote in between. */
export async function updateEntry<T>(store: string, key: string, transform: (current: T | undefined) => T) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const current = await getEntry<T>(store, key);
    try {
      await putEntry(store, key, transform(current?.value), current?.etag);
      return;
    } catch (err) {
      const conflict = err instanceof OpenCloudError && (err.status === 409 || err.status === 412 || err.status === 400 && /etag/i.test(err.body));
      if (!conflict || attempt === 5) throw err;
    }
  }
}

// ── Bans (user restrictions) ─────────────────────────────────────────────────

export interface GameJoinRestriction {
  active: boolean;
  startTime?: string;
  duration?: string;
  privateReason?: string;
  displayReason?: string;
  excludeAltAccounts?: boolean;
}

export async function setBan(userId: number, restriction: GameJoinRestriction) {
  await request(
    "PATCH",
    `${universe()}/user-restrictions/${userId}?updateMask=gameJoinRestriction`,
    { gameJoinRestriction: restriction },
  );
}

export async function getBan(userId: number): Promise<GameJoinRestriction | undefined> {
  try {
    const res = await request<{ gameJoinRestriction?: GameJoinRestriction }>(
      "GET",
      `${universe()}/user-restrictions/${userId}`,
    );
    return res.gameJoinRestriction;
  } catch (err) {
    if (err instanceof OpenCloudError && err.status === 404) return undefined;
    throw err;
  }
}

// ── Servers ──────────────────────────────────────────────────────────────────

/** Restart all servers (closeAllVersions), optionally letting them bleed off. */
export async function restartServers(bleedOffMinutes?: number) {
  await request("POST", `${universe()}:restartServers`, {
    ...(config.roblox.placeIds.length ? { placeIds: config.roblox.placeIds } : {}),
    closeAllVersions: true,
    ...(bleedOffMinutes ? { bleedOffServers: true, bleedOffDurationMinutes: bleedOffMinutes } : {}),
  });
}
