import {
  getMaxOfapiFanoutSeq,
  getOfapiSyncReplayFloor,
  listOfapiSyncEventsForReplay,
} from "@agency_hub_core/db";
import type { PoolClient } from "pg";

import type { AppContext } from "../bootstrap.ts";
import { OFAPI_SYNC_EVENT_CHANNEL } from "./ofapi-events.ts";

const LISTEN_RECONNECT_MIN_MS = 1_000;
const LISTEN_RECONNECT_MAX_MS = 30_000;
const DRAIN_RETRY_MIN_MS = 1_000;
const DRAIN_RETRY_MAX_MS = 30_000;
const CATCH_UP_BATCH_SIZE = 500;

export interface SyncEventFrame {
  // Settle-ordered fanout sequence — the SSE event id.
  id: number;
  platformAccountId: number;
  syncEvent: Record<string, unknown>;
}

export interface SyncEventSubscriber {
  pageIds: ReadonlySet<number>;
  deliver(frame: SyncEventFrame): void;
  /** The global replay prefix advanced beyond this connection's cursor. */
  continuityLost?(replayFloor: number): void;
}

export interface SyncEventHub {
  subscribe(subscriber: SyncEventSubscriber): () => void;
  /** Resolves once the current LISTEN attempt finishes (success or scheduled retry). */
  ready(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Per-connection monotonic Last-Event-ID guard. SSE frame ids on one connection
 * must be strictly increasing: a frame can legitimately reach a connection twice
 * (journal replay plus a live broadcast landing after the replay flushed), and
 * EventSource resume relies on the last written id being the stream's maximum —
 * a non-monotonic id would make the strict `fanout_seq > Last-Event-ID` replay
 * skip frames after a reconnect.
 */
export function createMonotonicSeqGuard(lastSeenSeq: number | null) {
  let lastWrittenSeq = lastSeenSeq;
  return {
    /** True exactly when the frame advances the stream; false = already written/seen. */
    advance(seq: number): boolean {
      if (lastWrittenSeq !== null && seq <= lastWrittenSeq) {
        return false;
      }
      lastWrittenSeq = seq;
      return true;
    },
    watermark(): number | null {
      return lastWrittenSeq;
    },
  };
}

/**
 * Single shared LISTEN connection fanning worker-processed journal rows out to
 * the API process's SSE subscribers. The worker NOTIFYs on settle commit
 * (services/ofapi-events.ts).
 *
 * Delivery contract: a NOTIFY is a wake-up signal only — frames are never built
 * from individual notifications. One serialized drain loop reads the journal
 * forward from the delivery watermark in fanout-seq order and advances the
 * watermark only after a row was broadcast, so delivery is in-order and a
 * transient journal-read failure is retried from the same position instead of
 * dropping frames (NOTIFY itself is one-shot). LISTEN-gap catch-up is the same
 * drain, so a live wake-up arriving mid-catch-up cannot move the watermark past
 * unread rows. Seq-order delivery assumes settles commit in fanout_seq order,
 * which the single serialized event worker guarantees.
 */
export function createSyncEventHub(app: AppContext): SyncEventHub {
  const subscribers = new Set<SyncEventSubscriber>();
  let listenClient: PoolClient | null = null;
  let connecting: Promise<void> | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let reconnectDelayMs = LISTEN_RECONNECT_MIN_MS;
  let closed = false;
  // Highest fanout seq broadcast to subscribers; null until the first LISTEN
  // baselines it at the journal's high-water mark. Advanced only by the drain.
  let deliveredSeq: number | null = null;
  let draining: Promise<void> | null = null;
  let drainAgain = false;
  let drainRetryTimer: NodeJS.Timeout | null = null;
  let drainRetryDelayMs = DRAIN_RETRY_MIN_MS;

  function broadcast(frame: SyncEventFrame) {
    for (const subscriber of subscribers) {
      if (!subscriber.pageIds.has(frame.platformAccountId)) {
        continue;
      }
      try {
        subscriber.deliver(frame);
      } catch (error) {
        app.logger.warn({ err: error }, "SSE subscriber delivery failed");
      }
    }
  }

  function reportContinuityLoss(replayFloor: number) {
    for (const subscriber of subscribers) {
      try {
        subscriber.continuityLost?.(replayFloor);
      } catch (error) {
        app.logger.warn({ err: error }, "SSE subscriber continuity callback failed");
      }
    }
  }

  // Wake-ups arriving while a drain is in flight coalesce into one follow-up
  // pass, so two drains never interleave (and never broadcast out of order).
  function requestDrain() {
    if (closed) {
      return;
    }
    if (draining) {
      drainAgain = true;
      return;
    }
    draining = (async () => {
      try {
        do {
          drainAgain = false;
          await drainJournal();
        } while (drainAgain && !closed);
      } finally {
        draining = null;
      }
    })();
  }

  async function drainJournal() {
    if (deliveredSeq === null) {
      return;
    }

    let retainedThroughSeq: number;
    try {
      // Committed rows only: sequence.last_value can expose an uncommitted
      // nextval and would let the hub baseline/advance past its later commit.
      retainedThroughSeq = await getMaxOfapiFanoutSeq(app.db);
    } catch (error) {
      app.logger.warn({ err: error }, "OFAPI sync event head read failed; retrying");
      scheduleDrainRetry();
      return;
    }

    for (;;) {
      if (closed) {
        return;
      }
      const afterSeq = deliveredSeq;
      let rows: SyncEventFrame[];
      let replayFloor: number;
      try {
        rows = afterSeq >= retainedThroughSeq
          ? []
          : await listOfapiSyncEventsForReplay(app.db, {
              afterSeq,
              throughSeq: retainedThroughSeq,
              limit: CATCH_UP_BATCH_SIZE,
            });
        // Read floors after the rows. If cleanup raced the SELECT and removed a
        // row, its transaction is now visible here; if it commits later, this
        // batch already holds the row object and can still deliver it safely.
        replayFloor = await getOfapiSyncReplayFloor(app.db);
      } catch (error) {
        // Watermark untouched — the failed read is retried, not skipped.
        app.logger.warn({ err: error }, "OFAPI sync event journal drain failed; retrying");
        scheduleDrainRetry();
        return;
      }
      drainRetryDelayMs = DRAIN_RETRY_MIN_MS;
      const throughSeq = Math.max(retainedThroughSeq, replayFloor);
      if (afterSeq >= throughSeq) {
        return;
      }
      if (replayFloor > afterSeq) {
        reportContinuityLoss(replayFloor);
      }
      for (const row of rows) {
        broadcast(row);
        deliveredSeq = row.id;
      }
      if (rows.length < CATCH_UP_BATCH_SIZE) {
        // `fanout_seq` also covers processed rows with no deliverable frame and
        // cleanup can remove the tail. Every retained deliverable row through
        // the captured head was read above; floors closed affected consumers.
        deliveredSeq = throughSeq;
        return;
      }
    }
  }

  function scheduleDrainRetry() {
    if (closed || drainRetryTimer) {
      return;
    }
    drainRetryTimer = setTimeout(() => {
      drainRetryTimer = null;
      requestDrain();
    }, drainRetryDelayMs);
    drainRetryTimer.unref?.();
    drainRetryDelayMs = Math.min(drainRetryDelayMs * 2, DRAIN_RETRY_MAX_MS);
  }

  function dropListenClient() {
    const client = listenClient;
    listenClient = null;
    if (client) {
      releaseListenClient(client);
    }
  }

  function releaseListenClient(client: PoolClient) {
    try {
      // Destroy rather than return to the pool — the connection has LISTEN state.
      client.release(true);
    } catch {
      // Already destroyed.
    }
  }

  function scheduleReconnect() {
    if (closed || reconnectTimer || subscribers.size === 0) {
      return;
    }

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void ensureListening();
    }, reconnectDelayMs);
    reconnectTimer.unref?.();
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, LISTEN_RECONNECT_MAX_MS);
  }

  async function ensureListening(): Promise<void> {
    if (closed || listenClient) {
      return;
    }
    if (connecting) {
      return connecting;
    }

    connecting = (async () => {
      const client = await app.pool.connect();
      try {
        client.on("notification", (message) => {
          if (message.channel !== OFAPI_SYNC_EVENT_CHANNEL) {
            return;
          }
          // The payload (a journal row id) is deliberately unused: building the
          // frame here would reintroduce unordered per-notification fetches.
          requestDrain();
        });
        client.on("error", (error) => {
          app.logger.warn({ err: error }, "OFAPI sync event LISTEN connection failed; reconnecting");
          dropListenClient();
          scheduleReconnect();
        });
        await client.query(`listen ${OFAPI_SYNC_EVENT_CHANNEL}`);
        // First LISTEN: baseline the watermark at the journal's current high-water
        // mark so later catch-ups cover exactly the gap, nothing more. A baseline
        // failure fails the whole connect (and is retried with backoff) — leaving
        // it null would silently disable delivery.
        if (deliveredSeq === null) {
          deliveredSeq = await getMaxOfapiFanoutSeq(app.db);
        }
      } catch (error) {
        releaseListenClient(client);
        throw error;
      }

      if (closed) {
        releaseListenClient(client);
        return;
      }

      listenClient = client;
      reconnectDelayMs = LISTEN_RECONNECT_MIN_MS;
      // Frames settled while no LISTEN connection existed are caught up through
      // the same serialized drain as live delivery.
      requestDrain();
    })();

    try {
      await connecting;
    } catch (error) {
      app.logger.warn({ err: error }, "Failed to open OFAPI sync event LISTEN connection");
      scheduleReconnect();
    } finally {
      connecting = null;
    }
  }

  return {
    subscribe(subscriber) {
      subscribers.add(subscriber);
      void ensureListening();
      return () => {
        subscribers.delete(subscriber);
      };
    },
    async ready() {
      await ensureListening();
      if (!listenClient) {
        throw new Error("OFAPI sync-event LISTEN connection is not ready");
      }
    },
    async close() {
      closed = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (drainRetryTimer) {
        clearTimeout(drainRetryTimer);
        drainRetryTimer = null;
      }
      subscribers.clear();
      // An in-flight connect re-checks `closed` and releases its own client.
      await connecting?.catch(() => undefined);
      await draining?.catch(() => undefined);
      dropListenClient();
    },
  };
}
