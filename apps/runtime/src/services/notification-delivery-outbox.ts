import {
  getTelegramSettings,
  leaseNotificationDeliveryOutbox,
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
  const sender = input?.sender ?? ((delivery: NotificationOutboxDelivery) =>
    sendTelegramMessage(app, {
      text: delivery.text,
      idempotencyKey: delivery.idempotencyKey,
    }));
  const result = {
    leased: 0,
    delivered: 0,
    retrying: 0,
    exhausted: 0,
    suppressed: 0,
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
      continue;
    }
    if (settled.state === "delivered") {
      result.delivered += 1;
    } else if (settled.state === "exhausted") {
      result.exhausted += 1;
    } else {
      result.retrying += 1;
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
    if (result.exhausted > 0) {
      app.logger.warn(result, "Notification outbox delivery exhausted");
    } else if (result.leased > 0) {
      app.logger.info(result, "Notification outbox delivery sweep complete");
    }
  });
}
