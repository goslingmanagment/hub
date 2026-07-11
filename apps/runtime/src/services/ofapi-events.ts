import { syncEventSchema, type SyncEvent } from "@agency_hub_core/contracts";
import { sanitizeLoneSurrogatesDeep } from "@agency_hub_core/shared";
import {
  deleteExpiredOfapiWebhookEvents,
  findPageByOfapiAccountId,
  getOfapiWebhookEventById,
  listPendingOfapiWebhookEventIds,
  settleOfapiWebhookEvent,
} from "@agency_hub_core/db";
import { sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";

import type { AppContext } from "../bootstrap.ts";
import {
  applyOfapiAccountHealthEvent,
  runOfapiAccountHealthMonitor,
} from "./ofapi-account-health.ts";
import { runOfapiCreditBurnMonitor } from "./ofapi-credits.ts";
import {
  cleanupExpiredDmMessageArchive,
  runOfapiDmColdArchiveForSettledRow,
  sweepOfapiDmColdArchives,
} from "./ofapi-dm-archive.ts";
import {
  runOfapiDmProjectionForSettledRow,
  sweepOfapiDmProjections,
} from "./ofapi-dm-projection.ts";
import {
  runOfapiPresenceProjectionForSettledRow,
  sweepOfapiPresenceProjections,
} from "./ofapi-presence-projection.ts";
import {
  runOfapiSpendProjectionForSettledRow,
  sweepOfapiSpendProjections,
} from "./ofapi-spend-projection.ts";
import {
  runOfapiSubscriptionProjectionForSettledRow,
  sweepOfapiSubscriptionProjections,
} from "./ofapi-subscription-projection.ts";
import { verifyOfapiCommandFromSentWebhook } from "./ofapi-command-executor.ts";
import {
  asRecord,
  idToString,
  normalizeOfapiSyncMessage,
  ofapiWebhookEnvelopeSchema,
  extractMessageIdFromNotification,
  notificationChatId,
  parseEpochMs,
  type OfapiWebhookEnvelope,
} from "./ofapi-payloads.ts";
import { ensureQueueCreated, type QueueCreationClient } from "./sync-queue.ts";

export { ofapiWebhookEnvelopeSchema, type OfapiWebhookEnvelope } from "./ofapi-payloads.ts";

// v2 replaces the original standard-policy queue. The old queue accepted duplicate
// singleton keys, so the minutely safety sweep could enqueue the same pending event
// repeatedly while a batchSize=1 worker fell behind. A new name lets production create
// the queue with the correct exclusive-per-event policy without deleting live pg-boss
// metadata in place.
export const OFAPI_EVENT_PROCESS_QUEUE = "ofapi.events.process.v2";
export const OFAPI_EVENT_SWEEP_QUEUE = "ofapi.events.sweep";
export const OFAPI_EVENT_CLEANUP_QUEUE = "ofapi.events.cleanup";
export const OFAPI_EVENT_PROCESS_BATCH_SIZE = 100;

// Postgres NOTIFY channel carrying journal row ids from the worker's event
// processor to the API process's SSE fanout (services/events-stream.ts).
export const OFAPI_SYNC_EVENT_CHANNEL = "ofapi_sync_events";

// Stage 1 retention stand-down: journal rows are business facts (money events
// included) and must outlive the ledger build-out; effectively-forever.
const DEFAULT_OFAPI_EVENT_RETENTION_DAYS = 36500;
// Rows still pending after this grace period get re-enqueued by the sweep job;
// long enough that the normal receive-time enqueue always wins the race.
const SWEEP_PENDING_GRACE_MS = 30_000;
const SWEEP_BATCH_LIMIT = 200;
const OFAPI_EVENT_WORKER_LOCK_NAMESPACE = 58211;
const OFAPI_EVENT_WORKER_LOCK_KEY = 1;

export interface OfapiEventProcessPayload {
  eventId: number;
}

export function sortOfapiEventJobs<T extends { data: OfapiEventProcessPayload }>(
  jobs: readonly T[],
): T[] {
  return [...jobs].sort((left, right) => left.data.eventId - right.data.eventId);
}

type SettledOfapiEventRow = Parameters<typeof runOfapiDmColdArchiveForSettledRow>[1] &
  Parameters<typeof runOfapiDmProjectionForSettledRow>[1] &
  Parameters<typeof runOfapiSubscriptionProjectionForSettledRow>[1] &
  Parameters<typeof runOfapiPresenceProjectionForSettledRow>[1] &
  Parameters<typeof applyOfapiAccountHealthEvent>[1];

// Best-effort post-settle steps (DM/subscription/presence projections, account
// health) — all internally flag-gated and never throw into the settle path.
async function runPostSettleOfapiProjections(app: AppContext, row: SettledOfapiEventRow) {
  const settledRow = await getOfapiWebhookEventById(app.db, row.id);
  const projectionRow = (settledRow ?? row) as SettledOfapiEventRow;
  await verifyOfapiCommandFromSentWebhook(app, projectionRow).catch((error) => {
    app.logger.warn(
      { err: error, eventId: projectionRow.id },
      "OFAPI command webhook verification failed; continuing",
    );
  });
  await runOfapiDmColdArchiveForSettledRow(app, projectionRow);
  await runOfapiDmProjectionForSettledRow(app, projectionRow);
  await runOfapiSubscriptionProjectionForSettledRow(app, projectionRow);
  await runOfapiPresenceProjectionForSettledRow(app, projectionRow);
  await runOfapiSpendProjectionForSettledRow(app, projectionRow);
  await applyOfapiAccountHealthEvent(app, projectionRow);
}

/**
 * Derives the SSE SyncEvent frame for a webhook envelope, or null for events that
 * are journaled but not fanned out (transactions.new — desktop has no frame for it
 * and a chat-list hint would trigger credit-charged refetches; chat_queue, posts,
 * data exports, fan summaries, unknown future types).
 */
export function mapOfapiEventToSyncEvent(envelope: OfapiWebhookEnvelope): SyncEvent | null {
  const accountId = envelope.account_id ?? null;
  if (!accountId) {
    return null;
  }

  const payload = asRecord(envelope.payload) ?? {};

  switch (envelope.event) {
    case "messages.received": {
      const chatId = idToString(asRecord(payload.fromUser)?.id);
      const messageId = idToString(payload.id);
      const message = chatId
        ? normalizeOfapiSyncMessage({ payload, chatId, isSentByMe: false })
        : null;
      return chatId && messageId
        ? {
          type: "messageReceived",
          accountId,
          chatId,
          messageId,
          ...(message ? { message } : {}),
        }
        : null;
    }
    case "messages.sent": {
      const chatId = idToString(asRecord(payload.toUser)?.id);
      const messageId = idToString(payload.id);
      const message = chatId
        ? normalizeOfapiSyncMessage({ payload, chatId, isSentByMe: true })
        : null;
      return chatId && messageId
        ? {
          type: "messageSent",
          accountId,
          chatId,
          messageId,
          ...(message ? { message } : {}),
        }
        : null;
    }
    case "messages.deleted": {
      const messageId = idToString(payload.id);
      return messageId ? { type: "messageDeleted", accountId, messageId } : null;
    }
    case "messages.ppv.unlocked": {
      const chatId = notificationChatId(payload);
      return chatId
        ? {
          type: "ppvUnlocked",
          accountId,
          chatId,
          messageId: extractMessageIdFromNotification(payload),
        }
        : null;
    }
    case "tips.received": {
      const chatId = notificationChatId(payload);
      const amount = payload.amountGross;
      return chatId
        ? {
          type: "tipReceived",
          accountId,
          chatId,
          messageId: extractMessageIdFromNotification(payload),
          ...(typeof amount === "number" && amount >= 0 ? { amountUsd: amount } : {}),
        }
        : null;
    }
    case "subscriptions.new":
    case "subscriptions.renewed":
      return { type: "chatListUpdated", accountId };
    case "users.online":
    case "users.offline": {
      const chatId = idToString(asRecord(payload.fan)?.id);
      const lastSeenAt = parseEpochMs(payload.last_seen_online_at);
      return chatId
        ? {
          type: "presence",
          accountId,
          chatId,
          online: envelope.event === "users.online",
          ...(lastSeenAt === undefined ? {} : { lastSeenAt }),
        }
        : null;
    }
    case "users.typing": {
      const chatId = idToString(payload.id);
      return chatId ? { type: "typing", accountId, chatId } : null;
    }
    // session_expired fires when OFAPI recovered the session silently (still
    // authenticated); the *_required / failed states need operator action.
    case "accounts.connected":
    case "accounts.reconnected":
    case "accounts.session_expired":
      return { type: "accountAuthChanged", accountId, authenticated: true };
    case "accounts.authentication_failed":
    case "accounts.otp_code_required":
    case "accounts.face_otp_required":
      return { type: "accountAuthChanged", accountId, authenticated: false };
    default:
      return null;
  }
}

export async function ensureOfapiQueues(
  boss: QueueCreationClient,
  createdQueues?: Set<string>,
) {
  await Promise.all([
    ensureQueueCreated(boss, OFAPI_EVENT_PROCESS_QUEUE, {
      // Every job supplies singletonKey=eventId. Exclusive therefore permits many
      // different events while preventing duplicate queued/active jobs for one event.
      policy: "exclusive",
      retryLimit: 2,
      retryDelay: 30,
      retryBackoff: true,
    }, createdQueues),
    ensureQueueCreated(boss, OFAPI_EVENT_SWEEP_QUEUE, {
      policy: "exclusive",
    }, createdQueues),
    ensureQueueCreated(boss, OFAPI_EVENT_CLEANUP_QUEUE, {
      policy: "standard",
    }, createdQueues),
  ]);
}

export async function ensureOfapiSchedules(boss: QueueCreationClient) {
  if (!boss.schedule) {
    return;
  }

  // Minutely sweep re-enqueues pending rows whose receive-time send was lost;
  // cleanup at 02:30 UTC follows the raw-payload cleanup slot.
  await boss.schedule(OFAPI_EVENT_SWEEP_QUEUE, "* * * * *", null, { tz: "UTC" });
  await boss.schedule(OFAPI_EVENT_CLEANUP_QUEUE, "30 2 * * *", null, { tz: "UTC" });
}

export async function sendOfapiEventProcessJob(
  boss: Pick<PgBoss, "send">,
  eventId: number,
): Promise<string | null | unknown> {
  return boss.send(
    OFAPI_EVENT_PROCESS_QUEUE,
    { eventId } satisfies OfapiEventProcessPayload,
    { singletonKey: String(eventId) },
  );
}

/**
 * Worker-side processing of one journaled delivery: resolve the page via
 * pages.ofapi_account_id, derive the SyncEvent frame, settle the row, and NOTIFY
 * the SSE fanout. Data problems settle the row as skipped/failed (no retry);
 * only infrastructure errors propagate into pg-boss retries.
 *
 * The DM projection runs strictly AFTER the settle commit as a best-effort
 * post-settle step (own bookkeeping columns; the minutely sweep retries) — it
 * can never block, fail, or reorder the settle/fanout path.
 */
export async function processOfapiWebhookEvent(app: AppContext, eventId: number) {
  const row = await getOfapiWebhookEventById(app.db, eventId);
  if (!row || row.status !== "pending") {
    return;
  }

  const processedAt = new Date();
  const envelope = ofapiWebhookEnvelopeSchema.safeParse(row.payload);
  if (!envelope.success) {
    await settleOfapiWebhookEvent(app.db, {
      id: row.id,
      status: "failed",
      error: "Journaled payload is not a valid OFAPI envelope",
      processedAt,
    });
    await runPostSettleOfapiProjections(app, row);
    return;
  }

  const page = row.ofapiAccountId
    ? await findPageByOfapiAccountId(app.db, row.ofapiAccountId)
    : null;
  if (!page) {
    await settleOfapiWebhookEvent(app.db, {
      id: row.id,
      status: "skipped",
      error: row.ofapiAccountId
        ? `No page mapped to OFAPI account "${row.ofapiAccountId}"`
        : "Envelope has no account_id",
      processedAt,
    });
    await runPostSettleOfapiProjections(app, row);
    return;
  }

  const mapped = mapOfapiEventToSyncEvent(envelope.data);
  const frame = mapped ? syncEventSchema.safeParse(mapped) : null;
  if (!frame?.success) {
    await settleOfapiWebhookEvent(app.db, {
      id: row.id,
      status: "skipped",
      platformAccountId: page.id,
      error: frame
        ? "Derived frame failed SyncEvent validation"
        : `Event type "${envelope.data.event}" is journaled without fanout`,
      processedAt,
    });
    await runPostSettleOfapiProjections(app, row);
    return;
  }

  await app.db.transaction(async (tx) => {
    const settled = await settleOfapiWebhookEvent(tx, {
      id: row.id,
      status: "processed",
      platformAccountId: page.id,
      // Belt for the truncation fix: vendor strings can carry their own
      // unpaired surrogates — never let a derived frame wedge the settle.
      syncEvent: sanitizeLoneSurrogatesDeep(frame.data),
      processedAt,
    });
    if (!settled) {
      // Another worker settled this row first (sweep racing the immediate job);
      // it also owns the notification.
      return;
    }
    // Same transaction: the notification fires on commit, after the row is visible.
    await tx.execute(sql`select pg_notify(${OFAPI_SYNC_EVENT_CHANNEL}, ${String(row.id)})`);
  });
  await runPostSettleOfapiProjections(app, row);
}

export async function sweepPendingOfapiEvents(
  app: AppContext,
  boss: Pick<PgBoss, "send">,
) {
  const ids = await listPendingOfapiWebhookEventIds(app.db, {
    receivedBefore: new Date(Date.now() - SWEEP_PENDING_GRACE_MS),
    limit: SWEEP_BATCH_LIMIT,
  });

  for (const id of ids) {
    await sendOfapiEventProcessJob(boss, id);
  }

  return ids.length;
}

export function resolveOfapiEventRetentionDays(app: AppContext) {
  return app.config.ofapiEventRetentionDays ?? DEFAULT_OFAPI_EVENT_RETENTION_DAYS;
}

export async function cleanupExpiredOfapiEvents(app: AppContext, now = new Date()) {
  const retentionDays = resolveOfapiEventRetentionDays(app);
  await deleteExpiredOfapiWebhookEvents(
    app.db,
    new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000),
  );
}

type OfapiWorkerBoss = Pick<PgBoss, "send" | "work">;

function assertOfapiEventWorkerSingleton(app: Pick<AppContext, "config">) {
  const replicas = app.config.ofapiEventWorkerReplicas ?? 1;
  if (replicas !== 1) {
    throw new Error(
      `OFAPI event worker requires exactly one replica; received OFAPI_EVENT_WORKER_REPLICAS=${replicas}`,
    );
  }
}

export class OfapiEventWorkerLockError extends Error {
  constructor() {
    super("OFAPI event worker advisory lock is already held");
    this.name = "OfapiEventWorkerLockError";
  }
}

export async function acquireOfapiEventWorkerLock(app: Pick<AppContext, "pool" | "logger">) {
  const client = await app.pool.connect();
  let released = false;

  try {
    const result = await client.query<{ locked: boolean }>(
      "select pg_try_advisory_lock($1, $2) as locked",
      [OFAPI_EVENT_WORKER_LOCK_NAMESPACE, OFAPI_EVENT_WORKER_LOCK_KEY],
    );
    if (!result.rows[0]?.locked) {
      throw new OfapiEventWorkerLockError();
    }
  } catch (error) {
    client.release(error instanceof Error ? error : undefined);
    throw error;
  }

  return async () => {
    if (released) {
      return;
    }
    released = true;
    let releaseError: Error | undefined;
    try {
      const result = await client.query<{ unlocked: boolean }>(
        "select pg_advisory_unlock($1, $2) as unlocked",
        [OFAPI_EVENT_WORKER_LOCK_NAMESPACE, OFAPI_EVENT_WORKER_LOCK_KEY],
      );
      if (!result.rows[0]?.unlocked) {
        throw new Error("OFAPI event worker advisory lock was not held by this session");
      }
    } catch (error) {
      releaseError = error instanceof Error ? error : new Error(String(error));
      app.logger.warn({ err: releaseError }, "Failed to release OFAPI event worker advisory lock");
      throw releaseError;
    } finally {
      client.release(releaseError);
    }
  };
}

/** Registers the OFAPI event handlers; shared by the worker and integration tests. */
export async function startOfapiEventWorker(app: AppContext, boss: OfapiWorkerBoss) {
  assertOfapiEventWorkerSingleton(app);
  const releaseWorkerLock = await acquireOfapiEventWorkerLock(app);

  try {
    await boss.work<OfapiEventProcessPayload>(
      OFAPI_EVENT_PROCESS_QUEUE,
      // One handler still settles rows sequentially, preserving the single-worker
      // fanout-order invariant. Fetching a batch avoids pg-boss's idle poll delay between
      // every event and keeps sustained webhook traffic from outrunning the worker.
      { batchSize: OFAPI_EVENT_PROCESS_BATCH_SIZE },
      async (jobs) => {
        // pg-boss does not promise the returned batch array is journal-ordered.
        // Restore receive order explicitly before assigning settle-order fanout_seq.
        for (const job of sortOfapiEventJobs(jobs)) {
          await processOfapiWebhookEvent(app, job.data.eventId);
        }
      },
    );

    await boss.work(OFAPI_EVENT_SWEEP_QUEUE, { batchSize: 1 }, async () => {
      const requeued = await sweepPendingOfapiEvents(app, boss);
      if (requeued > 0) {
        app.logger.warn({ requeued }, "OFAPI event sweep re-enqueued pending webhook events");
      }
      const projected = await sweepOfapiDmProjections(app);
      if (projected > 0) {
        app.logger.info({ projected }, "OFAPI DM projection sweep processed journal rows");
      }
      const archived = await sweepOfapiDmColdArchives(app);
      if (archived > 0) {
        app.logger.info({ archived }, "OFAPI DM cold archive sweep processed journal rows");
      }
      const subscriptionProjected = await sweepOfapiSubscriptionProjections(app);
      if (subscriptionProjected > 0) {
        app.logger.info(
          { projected: subscriptionProjected },
          "OFAPI subscription projection sweep processed journal rows",
        );
      }
      const presenceProjected = await sweepOfapiPresenceProjections(app);
      if (presenceProjected > 0) {
        app.logger.info(
          { projected: presenceProjected },
          "OFAPI presence projection sweep processed journal rows",
        );
      }
      const spendProjected = await sweepOfapiSpendProjections(app);
      if (spendProjected > 0) {
        app.logger.info(
          { projected: spendProjected },
          "OFAPI spend shadow projection sweep processed journal rows",
        );
      }
      await runOfapiAccountHealthMonitor(app);
      await runOfapiCreditBurnMonitor(app);
    });

    await boss.work(OFAPI_EVENT_CLEANUP_QUEUE, { batchSize: 1 }, async () => {
      await cleanupExpiredOfapiEvents(app);
      const purged = await cleanupExpiredDmMessageArchive(app);
      if (purged > 0) {
        app.logger.info({ purged }, "OFAPI DM cold archive retention purge complete");
      }
    });
  } catch (error) {
    await releaseWorkerLock().catch(() => undefined);
    throw error;
  }

  return releaseWorkerLock;
}
