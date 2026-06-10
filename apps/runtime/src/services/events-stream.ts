import {
  getMaxOfapiFanoutSeq,
  getOfapiWebhookEventById,
  listOfapiSyncEventsForReplay,
} from "@agency_hub_core/db";
import type { PoolClient } from "pg";

import type { AppContext } from "../bootstrap.ts";
import { OFAPI_SYNC_EVENT_CHANNEL } from "./ofapi-events.ts";

const LISTEN_RECONNECT_MIN_MS = 1_000;
const LISTEN_RECONNECT_MAX_MS = 30_000;
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
}

export interface SyncEventHub {
  subscribe(subscriber: SyncEventSubscriber): () => void;
  /** Resolves once the current LISTEN attempt finishes (success or scheduled retry). */
  ready(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Single shared LISTEN connection fanning worker-processed journal rows out to
 * the API process's SSE subscribers. The worker NOTIFYs row ids on commit
 * (services/ofapi-events.ts); each notification is one indexed row fetch here.
 * NOTIFY only reaches sessions listening at commit time, so after every
 * (re)connect the hub catches up from its delivery watermark via the journal.
 */
export function createSyncEventHub(app: AppContext): SyncEventHub {
  const subscribers = new Set<SyncEventSubscriber>();
  let listenClient: PoolClient | null = null;
  let connecting: Promise<void> | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let reconnectDelayMs = LISTEN_RECONNECT_MIN_MS;
  let closed = false;
  // Highest fanout seq delivered to subscribers; null until the first delivery.
  let deliveredSeq: number | null = null;

  function broadcast(frame: SyncEventFrame) {
    if (deliveredSeq === null || frame.id > deliveredSeq) {
      deliveredSeq = frame.id;
    }
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

  async function handleNotification(payload: string | undefined) {
    const id = Number(payload);
    if (!Number.isInteger(id) || id <= 0) {
      return;
    }

    const row = await getOfapiWebhookEventById(app.db, id);
    if (
      !row || row.status !== "processed" || !row.syncEvent ||
      row.platformAccountId === null || row.fanoutSeq === null
    ) {
      return;
    }

    broadcast({
      id: row.fanoutSeq,
      platformAccountId: row.platformAccountId,
      syncEvent: row.syncEvent,
    });
  }

  // Frames settled while no LISTEN connection existed (or before its NOTIFYs were
  // wired) are re-read from the journal so connected clients don't silently miss them.
  async function catchUpFromJournal() {
    if (deliveredSeq === null) {
      return;
    }

    for (;;) {
      const rows = await listOfapiSyncEventsForReplay(app.db, {
        afterSeq: deliveredSeq,
        limit: CATCH_UP_BATCH_SIZE,
      });
      for (const row of rows) {
        broadcast(row);
      }
      if (rows.length < CATCH_UP_BATCH_SIZE) {
        return;
      }
    }
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
          void handleNotification(message.payload).catch((error) => {
            app.logger.warn({ err: error }, "Failed to fan out OFAPI sync event notification");
          });
        });
        client.on("error", (error) => {
          app.logger.warn({ err: error }, "OFAPI sync event LISTEN connection failed; reconnecting");
          dropListenClient();
          scheduleReconnect();
        });
        await client.query(`listen ${OFAPI_SYNC_EVENT_CHANNEL}`);
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
      // First LISTEN: baseline the watermark at the journal's current high-water
      // mark so later reconnect catch-ups cover exactly the gap, nothing more.
      if (deliveredSeq === null) {
        deliveredSeq = await getMaxOfapiFanoutSeq(app.db).catch(() => null);
      }
      await catchUpFromJournal().catch((error) => {
        app.logger.warn({ err: error }, "OFAPI sync event journal catch-up failed");
      });
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
    },
    async close() {
      closed = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      subscribers.clear();
      // An in-flight connect re-checks `closed` and releases its own client.
      await connecting?.catch(() => undefined);
      dropListenClient();
    },
  };
}
