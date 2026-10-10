import {
  getTelegramSettings,
  leaseNotificationDeliveryOutbox,
  releaseNotificationDeliveryBackoff,
  settleNotificationDeliveryOutboxAttempt,
  suppressLeasedNotificationDelivery,
} from "@agency_hub_core/db";
import { sanitizeError } from "@agency_hub_core/shared";
import type { PgBoss, Queue } from "pg-boss";

import type { AppContext } from "../bootstrap.ts";
import {
  ensureQueueCreated,
  type QueueCreationClient,
  type SyncQueueLifecycleClient,
} from "./sync-queue.ts";
import { sendTelegramMessage, type TelegramSendResult } from "./telegram.ts";

export const NOTIFICATION_DELIVERY_OUTBOX_QUEUE = "notifications.delivery-outbox.sweep";
const DEFAULT_BATCH_LIMIT = 25;
/**
 * Wall-clock ceiling for one sweep. The batch limit alone does not bound
 * runtime — 25 rows each burning a full Telegram retry window is over an hour
 * — and pg-boss kills an active job at `expireInSeconds` regardless of
 * heartbeats (`failJobsByTimeout` and `failJobsByHeartbeat` are independent
 * checks). Stopping on our own clock lets the row in flight settle instead of
 * being cut mid-send; the minutely schedule picks up the remainder.
 */
const SWEEP_BUDGET_MS = 300_000;

/**
 * `expireInSeconds` is the hard ceiling and must exceed
 * SWEEP_BUDGET_MS plus one full Telegram retry window. `heartbeatSeconds` does
 * NOT extend it — what it buys is releasing the `exclusive` slot ~30s after a
 * worker dies instead of blocking the next sweep for the whole expiry.
 * Delivery retries belong to the durable outbox row, never to pg-boss, hence
 * `retryLimit: 0`.
 */
const notificationDeliveryOutboxQueueOptions = {
  policy: "exclusive",
  expireInSeconds: 600,
  heartbeatSeconds: 30,
  retryLimit: 0,
} satisfies Omit<Queue, "name">;

export interface NotificationOutboxDelivery {
  text: string;
  idempotencyKey: string;
}

export type NotificationOutboxSender = (
  input: NotificationOutboxDelivery,
) => Promise<TelegramSendResult>;

export async function ensureNotificationDeliveryOutboxQueue(
  boss: SyncQueueLifecycleClient,
  createdQueues?: Set<string>,
): Promise<void> {
  await ensureQueueCreated(
    boss,
    NOTIFICATION_DELIVERY_OUTBOX_QUEUE,
    notificationDeliveryOutboxQueueOptions,
    createdQueues,
  );

  // createQueue is INSERT ... ON CONFLICT DO NOTHING, so an already-created
  // queue keeps whatever it was born with — this one was born with only
  // `policy`, i.e. pg-boss's 15-minute default expiry. Same reconcile-then-
  // verify shape as the sync page-execute queue; `policy` is deliberately not
  // in the update because pg-boss cannot change it.
  await boss.updateQueue(NOTIFICATION_DELIVERY_OUTBOX_QUEUE, {
    expireInSeconds: notificationDeliveryOutboxQueueOptions.expireInSeconds,
    heartbeatSeconds: notificationDeliveryOutboxQueueOptions.heartbeatSeconds,
    retryLimit: notificationDeliveryOutboxQueueOptions.retryLimit,
  });

  const queue = await boss.getQueue(NOTIFICATION_DELIVERY_OUTBOX_QUEUE);
  if (!queue) {
    throw new Error(
      `Queue ${NOTIFICATION_DELIVERY_OUTBOX_QUEUE} was not readable after reconciliation`,
    );
  }
  if (
    queue.policy !== notificationDeliveryOutboxQueueOptions.policy ||
    queue.expireInSeconds !== notificationDeliveryOutboxQueueOptions.expireInSeconds ||
    queue.heartbeatSeconds !== notificationDeliveryOutboxQueueOptions.heartbeatSeconds ||
    queue.retryLimit !== notificationDeliveryOutboxQueueOptions.retryLimit
  ) {
    throw new Error(
      `Queue ${NOTIFICATION_DELIVERY_OUTBOX_QUEUE} configuration drift: expected ` +
      `policy=${notificationDeliveryOutboxQueueOptions.policy}, ` +
      `expireInSeconds=${notificationDeliveryOutboxQueueOptions.expireInSeconds}, ` +
      `heartbeatSeconds=${notificationDeliveryOutboxQueueOptions.heartbeatSeconds}, ` +
      `retryLimit=${notificationDeliveryOutboxQueueOptions.retryLimit}`,
    );
  }
}

export async function ensureNotificationDeliveryOutboxSchedule(
  boss: QueueCreationClient,
): Promise<void> {
  if (!boss.schedule) {
    return;
  }
  await boss.schedule(NOTIFICATION_DELIVERY_OUTBOX_QUEUE, "* * * * *", null, {
    tz: "UTC",
  });
}

/**
 * Drains a bounded number of durable notification transitions. The database
 * lease, not the pg-boss tick, owns delivery concurrency and crash recovery.
 *
 * Д2: a send that does not go through (`failed` or `skipped`, whatever the
 * cause — the cause is not reliably classified) is settled as usual and ends
 * the pass: the first due row is the probe of the channel, so an outage costs
 * one call a minute instead of one ~40 s failure per due row, and the rows
 * behind it keep their attempts. The first delivered row of a pass that ends
 * 15 minutes without any delivery releases every backed-off `sync_failure`
 * row (`releaseNotificationDeliveryBackoff`), so what is still open goes out
 * in this pass or the next.
 *
 * Telegram has no provider-side idempotency primitive. The stable key is
 * nevertheless carried through the sender boundary and logs so another
 * channel with such a primitive can use it, and so retries are traceable.
 */
export async function runNotificationDeliveryOutbox(
  app: Pick<AppContext, "config" | "db" | "logger">,
  input?: {
    now?: Date;
    /** Test seam for time MOVING during a sweep; `now` pins it instead. */
    clock?: () => Date;
    maxRows?: number;
    /** Wall-clock ceiling; defaults to SWEEP_BUDGET_MS. */
    budgetMs?: number;
    /** Aborted on shutdown: the row in flight settles, no further row is leased. */
    signal?: AbortSignal;
    leaseMs?: number;
    retryDelayMs?: number;
    sender?: NotificationOutboxSender;
  },
) {
  // One timestamp per batch was wrong twice over: later rows were handed
  // leases that had already expired at grant time (so another runner could
  // reclaim a row mid-send), and retry backoff was measured from sweep start,
  // so a delay could already be in the past by the time the row settled.
  const clock = input?.clock ?? (input?.now ? () => input.now! : () => new Date());
  const sweepStartedAt = Date.now();
  const maxRows = Math.max(1, Math.floor(input?.maxRows ?? DEFAULT_BATCH_LIMIT));
  const budgetMs = Math.max(0, input?.budgetMs ?? SWEEP_BUDGET_MS);
  // A timed-out request is not repeated inside the call: the row repeats it
  // after its backoff.
  const sender = input?.sender ?? ((delivery: NotificationOutboxDelivery) =>
    sendTelegramMessage(app, {
      text: delivery.text,
      idempotencyKey: delivery.idempotencyKey,
      retryTimeouts: false,
    }));
  const result = {
    leased: 0,
    delivered: 0,
    retrying: 0,
    exhausted: 0,
    suppressed: 0,
    /** Backed-off rows the pass's first delivery made due (0 when another
     * row was delivered in the 15 min before it). */
    released: 0,
    /** The pass ended on a send that did not go through. */
    stoppedOnFailure: false,
  };

  for (let index = 0; index < maxRows; index += 1) {
    if (input?.signal?.aborted) {
      // A process on its way out must not lease a row it may not live to
      // settle: that row would sit leased until the lease expired.
      break;
    }
    if (Date.now() - sweepStartedAt >= budgetMs) {
      // Never a silent truncation: the remainder is still due and the next
      // minutely tick takes it.
      app.logger.warn({
        ...result,
        budgetMs,
      }, "Notification outbox sweep stopped on its wall-clock budget");
      break;
    }
    const row = await leaseNotificationDeliveryOutbox(app.db, {
      now: clock(),
      ...(input?.leaseMs !== undefined ? { leaseMs: input.leaseMs } : {}),
    });
    if (!row) {
      break;
    }
    result.leased += 1;

    if (!row.leaseToken) {
      app.logger.warn({
        notificationOutboxId: row.id,
        idempotencyKey: row.idempotencyKey,
      }, "Notification outbox lease returned without a token");
      continue;
    }

    const settings = await getTelegramSettings(app.db, {
      defaultReportHourUtc: app.config.telegramReportHourUtc,
    });
    const policyEnabled = row.pagingPolicy === "ai_critical"
      ? settings.aiCriticalAlertsEnabled
      : settings.syncFailureAlertsEnabled;
    const suppressionReason = !settings.enabled
      ? "notifications_disabled" as const
      : !policyEnabled
        ? row.pagingPolicy === "ai_critical"
          ? "ai_critical_alerts_disabled" as const
          : "sync_failure_alerts_disabled" as const
        : null;
    if (suppressionReason) {
      await suppressLeasedNotificationDelivery(app.db, {
        outboxId: row.id,
        leaseToken: row.leaseToken,
        reason: suppressionReason,
        now: clock(),
      });
      result.suppressed += 1;
      continue;
    }

    let delivery: TelegramSendResult;
    try {
      delivery = await sender({
        text: row.messageText,
        idempotencyKey: row.idempotencyKey,
      });
    } catch (error) {
      delivery = {
        status: "failed",
        error: sanitizeError(error, {
          format: "chain",
          maxChars: 512,
          truncation: "clip",
        }).message,
      };
    }

    const settled = await settleNotificationDeliveryOutboxAttempt(app.db, {
      outboxId: row.id,
      leaseToken: row.leaseToken,
      delivery: delivery.status === "sent"
        ? {
          status: "sent",
          messageId: delivery.messageId,
        }
        : delivery.status === "failed"
          ? delivery
          : {
            status: "skipped",
            error: delivery.reason,
          },
      now: clock(),
      ...(input?.retryDelayMs !== undefined ? { retryDelayMs: input.retryDelayMs } : {}),
    });

    if (!settled) {
      app.logger.warn({
        notificationOutboxId: row.id,
        idempotencyKey: row.idempotencyKey,
      }, "Notification outbox lease was lost before delivery settlement");
    } else if (settled.state === "delivered") {
      result.delivered += 1;
      if (result.delivered === 1) {
        result.released = await releaseNotificationDeliveryBackoff(app.db, {
          now: clock(),
          deliveredOutboxId: settled.id,
        });
      }
    } else if (settled.state === "exhausted") {
      result.exhausted += 1;
    } else {
      result.retrying += 1;
    }
    if (delivery.status !== "sent") {
      // The channel is down (or the row cannot go out): the next due row
      // would only burn an attempt the same way. The next pass probes again.
      result.stoppedOnFailure = true;
      break;
    }
  }

  return result;
}

export function startNotificationDeliveryOutboxWorker(
  app: Pick<AppContext, "config" | "db" | "logger">,
  boss: Pick<PgBoss, "work">,
): Promise<string> {
  return boss.work(NOTIFICATION_DELIVERY_OUTBOX_QUEUE, { batchSize: 1 }, async () => {
    const result = await runNotificationDeliveryOutbox(app);
    if (result.stoppedOnFailure) {
      app.logger.warn(result, result.exhausted > 0
        ? "Notification outbox delivery exhausted; the pass stopped on the failed send"
        : "Notification outbox delivery failed; the pass stopped, the next one retries");
    } else if (result.leased > 0) {
      app.logger.info(result, "Notification outbox delivery sweep complete");
    }
  });
}
