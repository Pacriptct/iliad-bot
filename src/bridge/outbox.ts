// Polls the game's MemoryStore outbox through Open Cloud and dispatches events.
import { config } from "../config.js";
import { log } from "../log.js";
import { discardQueue, readQueue } from "../roblox/openCloud.js";
import { dispatch, type OutboxBatch } from "./events.js";

export const outboxStats = { lastPoll: 0, lastEvent: 0, events: 0, errors: 0 };

export function startOutbox() {
  const { intervalMs, batchSize } = config.poll;
  const queue = config.roblox.outboxQueue;

  const tick = async () => {
    let drained = false;
    try {
      const read = await readQueue<OutboxBatch>(queue, batchSize);
      outboxStats.lastPoll = Date.now();
      const items = read.items ?? [];
      for (const item of items) {
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
        if (read.readId) await discardQueue(queue, read.readId);
        else log.warn("outbox: read returned items but no readId, so they can't be discarded (they'll be read again)");
      }
      drained = items.length < batchSize;
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
