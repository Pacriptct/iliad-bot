// Polls the game's MemoryStore outbox through Open Cloud and dispatches events.
import { config } from "../config.js";
import { log } from "../log.js";
import { discardQueue, readQueue } from "../roblox/openCloud.js";
import { dispatch, type OutboxBatch } from "./events.js";

export const outboxStats = { lastPoll: 0, lastEvent: 0, events: 0, errors: 0 };

const seen = new Set<string>();
function remember(key: string) {
  seen.add(key);
  if (seen.size > 5000) seen.delete(seen.values().next().value as string);
}

export function startOutbox() {
  const { intervalMs, batchSize } = config.poll;
  const queue = config.roblox.outboxQueue;

  const tick = async () => {
    let drained = false;
    try {
      const read = await readQueue<OutboxBatch>(queue, batchSize);
      outboxStats.lastPoll = Date.now();
      const items = read.items ?? [];
      let fresh = 0;
      for (const item of items) {
        // Never handle the same queue item twice (in case a discard failed).
        const key = item.path ?? item.id;
        if (key) {
          if (seen.has(key)) continue;
          remember(key);
        }
        fresh++;
        const batch = item.data;
        if (!batch || !Array.isArray(batch.Events)) continue;
        const meta = { JobId: batch.JobId, PlaceId: batch.PlaceId, Studio: batch.Studio };
        if (outboxStats.events < 200) {
          log.info(`outbox: ${batch.Events.length} event(s) from server ${String(batch.JobId).slice(0, 8)}: ${batch.Events.map((e) => e.Type).join(", ")}`);
        }
        for (const event of batch.Events) {
          outboxStats.events++;
          outboxStats.lastEvent = Date.now();
          await dispatch(event, meta);
        }
      }
      // Discard after handling (handlers catch their own errors, so a bad event
      // can't wedge the queue).
      if (items.length) {
        if (read.readId) {
          await discardQueue(queue, read.readId).catch((err) => {
            outboxStats.errors++;
            log.warn("outbox: discard failed (events won't be reposted, but they stay in the queue):", err instanceof Error ? err.message : err);
          });
        } else {
          log.warn("outbox: read returned items but no readId, so they can't be discarded (they'll be read again)");
        }
      }
      // Only hurry back while there's a real backlog of new events.
      drained = fresh < batchSize;
    } catch (err) {
      outboxStats.errors++;
      log.warn("outbox poll failed:", err instanceof Error ? err.message : err);
      drained = true;
    }
    // Keep reading immediately while there's a backlog.
    setTimeout(tick, drained ? intervalMs : 50);
  };
  tick();
  log.info(`outbox: polling ${queue} every ${intervalMs}ms`);
}
