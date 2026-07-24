import {
  getTelegramSettings,
  leaseNotificationDeliveryOutbox,
  settleNotificationDeliveryOutboxAttempt,
  suppressLeasedNotificationDelivery,
} from "@agency_hub_core/db";
import { sanitizeError } from "@agency_hub_core/shared";
import type { PgBoss } from "pg-boss";

import type { AppContext } from "../bootstrap.ts";
import { ensureQueueCreated, type QueueCreationClient } from "./sync-queue.ts";
import { sendTelegramMessage, type TelegramSendResult } from "./telegram.ts";

export const NOTIFICATION_DELIVERY_OUTBOX_QUEUE = "notifications.delivery-outbox.sweep";
const DEFAULT_BATCH_LIMIT = 25;

export interface NotificationOutboxDelivery {
  text: string;
  idempotencyKey: string;
}

export type NotificationOutboxSender = (
  input: NotificationOutboxDelivery,
) => Promise<TelegramSendResult>;

export async function ensureNotificationDeliveryOutboxQueue(
  boss: QueueCreationClient,
  createdQueues?: Set<string>,
): Promise<void> {
  await ensureQueueCreated(boss, NOTIFICATION_DELIVERY_OUTBOX_QUEUE, {
    policy: "exclusive",
  }, createdQueues);
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
    maxRows?: number;
    leaseMs?: number;
    retryDelayMs?: number;
    sender?: NotificationOutboxSender;
  },
) {
  const now = input?.now ?? new Date();
  const maxRows = Math.max(1, Math.floor(input?.maxRows ?? DEFAULT_BATCH_LIMIT));
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
    const row = await leaseNotificationDeliveryOutbox(app.db, {
      now,
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
        now,
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
      now,
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
