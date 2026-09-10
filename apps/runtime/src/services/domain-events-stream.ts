import {
  DOMAIN_EVENTS_APPENDED_CHANNEL,
  isProjectionOnlyDomainEventType,
  listDomainEventAccountBounds,
  listDomainEventHighWaters,
  listEventsSince,
  type DomainEventRow,
} from "@agency_hub_core/db";
import type { PoolClient } from "pg";

import type { AppContext } from "../bootstrap.ts";
import { validateGaplessReplayBatch } from "./sse-replay-buffer.ts";

// Kernel Stage 21: the domain-event fan-out hub — createSyncEventHub's
// discipline (one shared LISTEN connection, notify = wake-up only, serialized
// drain, watermark advanced only after broadcast) generalized to PER-ACCOUNT
// watermarks over the gapless domain_events ledger. v1's hub keeps running
// untouched beside it until Stage 25.

const LISTEN_RECONNECT_MIN_MS = 1_000;
const LISTEN_RECONNECT_MAX_MS = 30_000;
const DRAIN_RETRY_MIN_MS = 1_000;
const DRAIN_RETRY_MAX_MS = 30_000;
const CATCH_UP_BATCH_SIZE = 500;

export interface DomainEventSubscriber {
  /** undefined = every account (owner grants / the smoke consumer). */
  accountIds: ReadonlySet<number> | undefined;
  deliver(event: DomainEventRow): void;
  /** The hub could not read a gapless interval through this captured head. */
  continuityLost?(accountId: number, afterSeq: number, throughSeq: number): void;
}

export interface DomainEventHub {
  subscribe(subscriber: DomainEventSubscriber): () => void;
  /** Resolves once the current LISTEN attempt finishes (success or scheduled retry). */
  ready(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Per-connection, per-account monotonic guard (v1's createMonotonicSeqGuard
 * generalized). `advance` is true exactly when the frame moves that account's
 * stream forward; a jump of more than one is the gapless-ledger bug signal the
 * caller counts — never a normal condition (Stage 8's CI proof).
 */
export function createAccountSeqGuards(initial: ReadonlyMap<number, number>) {
  const lastWritten = new Map<number, number>(initial);
  return {
    advance(accountId: number, seq: number): { deliver: boolean; gap: boolean } {
      const last = lastWritten.get(accountId);
      if (last !== undefined && seq <= last) {
        return { deliver: false, gap: false };
      }
      const gap = last !== undefined && seq > last + 1;
      if (gap) {
        // Never advance a connection cursor across a missing account_seq. The
        // caller closes and reconnects from the unchanged safe watermark.
        return { deliver: false, gap: true };
      }
      lastWritten.set(accountId, seq);
      return { deliver: true, gap: false };
    },
    /**
     * Advances across a ledger gap only while replaying a cursor that proves a
     * complete durable-state snapshot was applied first. The route never uses
     * this on the ordinary or live lanes; retained rows still deliver in order
     * and the recovery marker is cleared before live fan-out starts.
     */
    advanceAfterSnapshot(accountId: number, seq: number): { deliver: boolean } {
      const last = lastWritten.get(accountId);
      if (last !== undefined && seq <= last) {
        return { deliver: false };
      }
      lastWritten.set(accountId, seq);
      return { deliver: true };
    },
    advanceProjectionCheckpoint(
      accountId: number,
      seq: number,
      hiddenCount: number,
    ): { deliver: boolean; gap: boolean } {
      const last = lastWritten.get(accountId);
      if (last !== undefined && seq <= last) {
        return { deliver: false, gap: false };
      }
      if (
        last === undefined ||
        !Number.isSafeInteger(hiddenCount) ||
        hiddenCount < 0 ||
        seq !== last + hiddenCount + 1
      ) {
        return { deliver: false, gap: true };
      }
      lastWritten.set(accountId, seq);
      return { deliver: true, gap: false };
    },
    watermarks(): ReadonlyMap<number, number> {
      return lastWritten;
    },
  };
}

export function createDomainEventHub(app: AppContext): DomainEventHub {
  const subscribers = new Set<DomainEventSubscriber>();
  let listenClient: PoolClient | null = null;
  let connecting: Promise<void> | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let reconnectDelayMs = LISTEN_RECONNECT_MIN_MS;
  let closed = false;
  // Per-account delivered watermarks; null until the first LISTEN baselines
  // them at the ledger's current high-waters. Advanced only by the drain.
  let delivered: Map<number, number> | null = null;
  const dirtyAccounts = new Set<number>();
  let rebaselineAll = false;
  let draining: Promise<void> | null = null;
  let drainAgain = false;
  let drainRetryTimer: NodeJS.Timeout | null = null;
  let drainRetryDelayMs = DRAIN_RETRY_MIN_MS;

  function broadcast(event: DomainEventRow) {
    if (isProjectionOnlyDomainEventType(event.type, event.schemaVersion)) {
      // Projection-only rows advance the shared durable drain, but never enter
      // per-client buffers. Their atomic checkpoint carries the cursor jump.
      return;
    }
    for (const subscriber of subscribers) {
      if (subscriber.accountIds !== undefined && !subscriber.accountIds.has(event.accountId)) {
        continue;
      }
      try {
        subscriber.deliver(event);
      } catch (error) {
        app.logger.warn({ err: error }, "domain-event subscriber delivery failed");
      }
    }
  }

  function reportContinuityLoss(accountId: number, afterSeq: number, throughSeq: number) {
    for (const subscriber of subscribers) {
      if (subscriber.accountIds !== undefined && !subscriber.accountIds.has(accountId)) {
        continue;
      }
      try {
        subscriber.continuityLost?.(accountId, afterSeq, throughSeq);
      } catch (error) {
        app.logger.warn({ err: error }, "domain-event subscriber continuity callback failed");
      }
    }
  }

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
          await drainLedger();
        } while (drainAgain && !closed);
      } finally {
        draining = null;
      }
    })();
  }

  async function drainLedger() {
    if (delivered === null) {
      return;
    }

    if (rebaselineAll) {
      // A LISTEN gap may hide appends on accounts we have never heard of;
      // re-list every counter row and mark the moved ones dirty.
      rebaselineAll = false;
      let heads: Map<number, number>;
      try {
        heads = await listDomainEventHighWaters(app.db);
      } catch (error) {
        rebaselineAll = true;
        app.logger.warn({ err: error }, "domain-event head listing failed; retrying");
        scheduleDrainRetry();
        return;
      }
      for (const [accountId, head] of heads) {
        const watermark = delivered.get(accountId);
        if (watermark === undefined) {
          // The account appeared after our baseline (its whole history is
          // younger than this hub instance) — deliver it from the start.
          delivered.set(accountId, 0);
          dirtyAccounts.add(accountId);
        } else if (head > watermark) {
          dirtyAccounts.add(accountId);
        }
      }
    }

    while (dirtyAccounts.size > 0) {
      if (closed) {
        return;
      }
      const accountId = dirtyAccounts.values().next().value;
      if (accountId === undefined) {
        break;
      }
      dirtyAccounts.delete(accountId);
      const watermark = delivered.get(accountId) ?? 0;
      let throughSeq: number;
      try {
        throughSeq = (await listDomainEventAccountBounds(app.db, [accountId]))
          .get(accountId)!.currentSeq;
      } catch (error) {
        dirtyAccounts.add(accountId);
        app.logger.warn({ err: error, accountId }, "domain-event head read failed; retrying");
        scheduleDrainRetry();
        return;
      }
      if (throughSeq <= watermark) {
        continue;
      }
      let afterSeq = watermark;
      for (;;) {
        let rows: DomainEventRow[];
        try {
          rows = await listEventsSince(app.db, {
            accountId,
            afterSeq,
            throughSeq,
            limit: CATCH_UP_BATCH_SIZE,
          });
        } catch (error) {
          // Watermark untouched — the failed read is retried, not skipped.
          dirtyAccounts.add(accountId);
          app.logger.warn({ err: error, accountId }, "domain-event ledger drain failed; retrying");
          scheduleDrainRetry();
          return;
        }
        drainRetryDelayMs = DRAIN_RETRY_MIN_MS;
        const continuity = validateGaplessReplayBatch({
          rows,
          afterSeq,
          throughSeq,
          limit: CATCH_UP_BATCH_SIZE,
        });
        if (!continuity.ok) {
          // All affected connections close at their last safe cursor. Rebase
          // the shared hub to the captured head so a snapshot-recovered client
          // can receive later appends instead of wedging this account forever.
          reportContinuityLoss(accountId, afterSeq, throughSeq);
          delivered.set(accountId, throughSeq);
          break;
        }
        for (const row of rows) {
          broadcast(row);
          delivered.set(accountId, row.accountSeq);
        }
        afterSeq = continuity.nextSeq;
        if (continuity.done) {
          break;
        }
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
          if (message.channel !== DOMAIN_EVENTS_APPENDED_CHANNEL) {
            return;
          }
          const accountId = Number(message.payload?.split(":", 1)[0]);
          if (Number.isInteger(accountId) && accountId > 0) {
            if (delivered !== null && !delivered.has(accountId)) {
              // First event ever for this account while we are live: nothing
              // was skipped, so its history starts at zero.
              delivered.set(accountId, 0);
            }
            dirtyAccounts.add(accountId);
          } else {
            rebaselineAll = true;
          }
          requestDrain();
        });
        client.on("error", (error) => {
          app.logger.warn({ err: error }, "domain-event LISTEN connection failed; reconnecting");
          dropListenClient();
          scheduleReconnect();
        });
        await client.query(`listen ${DOMAIN_EVENTS_APPENDED_CHANNEL}`);
        // First LISTEN: baseline every account at its current high-water so
        // catch-ups cover exactly the gap. A baseline failure fails the connect
        // (retried with backoff) — a null map would silently disable delivery.
        if (delivered === null) {
          delivered = await listDomainEventHighWaters(app.db);
        } else {
          // Reconnect after a LISTEN gap: appends may have happened anywhere.
          rebaselineAll = true;
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
      requestDrain();
    })();

    try {
      await connecting;
    } catch (error) {
      app.logger.warn({ err: error }, "Failed to open domain-event LISTEN connection");
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
        throw new Error("domain-event LISTEN connection is not ready");
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
