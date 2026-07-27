import { randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";

import type { Database } from "../client.ts";
import {
  notificationDeliveryOutbox,
  telegramDeliveryAttempts,
  telegramSettings,
} from "../schema.ts";

export type NotificationDeliveryOutboxRow = typeof notificationDeliveryOutbox.$inferSelect;
export type NotificationDeliveryTransition = "opened" | "reopened" | "resolved";
export type NotificationDeliveryChannel = "telegram";
export type NotificationDeliveryOutboxState =
  | "pending"
  | "leased"
  | "delivered"
  | "suppressed"
  | "exhausted";

export interface NotificationDeliveryOutboxRequest {
  channel: NotificationDeliveryChannel;
  messageText: string;
  /** Existing sync incidents can migrate later by changing only the caller
   * from direct send to this request. Stage 1B activates only ai_critical. */
  pagingPolicy: "sync_failure" | "ai_critical";
  maxAttempts?: number;
}

const DEFAULT_MAX_ATTEMPTS = 5;
/**
 * Must outlast the slowest PHYSICAL send a worker can make, or a second runner
 * reclaims a row that is still in flight and Telegram — which has no
 * idempotency primitive — gets the message twice. The Telegram sender can burn
 * `TELEGRAM_SEND_RETRY_WINDOW_MS` (~150s: three 10s requests plus two capped
 * retry delays); `tests/notification-outbox-lease.test.ts` pins this constant
 * above it, since packages/db cannot import the runtime's sender.
 */
export const NOTIFICATION_OUTBOX_LEASE_MS = 300_000;

function notificationDeliveryIdempotencyKey(input: {
  notificationIncidentId: number;
  transition: NotificationDeliveryTransition;
  transitionAt: Date;
  channel: NotificationDeliveryChannel;
}) {
  return [
    "notification",
    input.notificationIncidentId,
    input.transition,
    input.transitionAt.toISOString(),
    input.channel,
  ].join(":");
}

/**
 * Called only from the incident transition transaction. The selected paging
 * setting is read in that same transaction: paging-off persists a suppressed
 * outbox row instead of silently omitting delivery state.
 */
export async function enqueueNotificationDeliveryOutbox(
  db: Database,
  input: {
    notificationIncidentId: number;
    transition: NotificationDeliveryTransition;
    transitionAt: Date;
    request: NotificationDeliveryOutboxRequest;
    now?: Date;
  },
): Promise<NotificationDeliveryOutboxRow> {
  const now = input.now ?? new Date();
  const [settings] = await db.select({
    enabled: telegramSettings.enabled,
    syncFailureAlertsEnabled: telegramSettings.syncFailureAlertsEnabled,
    aiCriticalAlertsEnabled: telegramSettings.aiCriticalAlertsEnabled,
  })
    .from(telegramSettings)
    .where(eq(telegramSettings.id, 1))
    .limit(1);

  const notificationsEnabled = settings?.enabled ?? true;
  const policyEnabled = input.request.pagingPolicy === "ai_critical"
    ? settings?.aiCriticalAlertsEnabled ?? false
    : settings?.syncFailureAlertsEnabled ?? true;
  const suppressionReason = !notificationsEnabled
    ? "notifications_disabled"
    : !policyEnabled
      ? input.request.pagingPolicy === "ai_critical"
        ? "ai_critical_alerts_disabled"
        : "sync_failure_alerts_disabled"
      : null;
  const state: NotificationDeliveryOutboxState = suppressionReason ? "suppressed" : "pending";
  const idempotencyKey = notificationDeliveryIdempotencyKey({
    notificationIncidentId: input.notificationIncidentId,
    transition: input.transition,
    transitionAt: input.transitionAt,
    channel: input.request.channel,
  });

  const [inserted] = await db.insert(notificationDeliveryOutbox)
    .values({
      notificationIncidentId: input.notificationIncidentId,
      transition: input.transition,
      transitionAt: input.transitionAt,
      channel: input.request.channel,
      pagingPolicy: input.request.pagingPolicy,
      idempotencyKey,
      messageText: input.request.messageText,
      state,
      attemptCount: 0,
      maxAttempts: Math.max(1, Math.floor(input.request.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)),
      availableAt: now,
      suppressionReason,
      updatedAt: now,
    })
    .onConflictDoNothing({
      target: notificationDeliveryOutbox.idempotencyKey,
    })
    .returning();

  if (inserted) {
    return inserted;
  }

  const [existing] = await db.select()
    .from(notificationDeliveryOutbox)
    .where(eq(notificationDeliveryOutbox.idempotencyKey, idempotencyKey))
    .limit(1);
  if (!existing) {
    throw new Error(`Notification delivery outbox row "${idempotencyKey}" could not be read`);
  }
  return existing;
}

export async function getNotificationDeliveryOutboxByIncident(
  db: Database,
  notificationIncidentId: number,
): Promise<NotificationDeliveryOutboxRow[]> {
  return db.query.notificationDeliveryOutbox.findMany({
    where: eq(notificationDeliveryOutbox.notificationIncidentId, notificationIncidentId),
    orderBy: [
      notificationDeliveryOutbox.createdAt,
      notificationDeliveryOutbox.id,
    ],
  });
}

/**
 * Claims one due row. An expired lease is reclaimable without consuming an
 * attempt: the crash may have happened before the sender was called.
 *
 * Per-incident FIFO is enforced by the `not exists` fence, not by `order by`
 * alone: the due-filter runs BEFORE the ordering, so a backed-off `opened` row
 * is simply invisible while a freshly enqueued `resolved` row is due. Without
 * the fence one transient Telegram failure on the open alert is enough to page
 * "✅ resolved" first and deliver the stale "🚨 opened" a minute later.
 *
 * Ordering is by `transition_at` — the incident transition time that already
 * identifies the row in the idempotency key — not by insertion time. Terminal
 * states (`delivered`, `suppressed`, `exhausted`) never block a successor.
 * Known consequence, deliberately left to a separate owner decision: when an
 * `opened` row ends `exhausted` or `suppressed`, its `resolved` successor is
 * released and pages on its own.
 */
export async function leaseNotificationDeliveryOutbox(
  db: Database,
  input?: {
    now?: Date;
    leaseMs?: number;
  },
): Promise<NotificationDeliveryOutboxRow | null> {
  const now = input?.now ?? new Date();
  const leaseExpiresAt = new Date(now.getTime() + Math.max(1, input?.leaseMs ?? NOTIFICATION_OUTBOX_LEASE_MS));
  const leaseToken = randomUUID();

  return db.transaction(async (tx) => {
    const candidate = await tx.execute<{ id: number | string }>(sql`
      select ${notificationDeliveryOutbox.id} as id
      from ${notificationDeliveryOutbox}
      where (
        (
          ${notificationDeliveryOutbox.state} = 'pending'
          and ${notificationDeliveryOutbox.availableAt} <= ${now}
        ) or (
          ${notificationDeliveryOutbox.state} = 'leased'
          and ${notificationDeliveryOutbox.leaseExpiresAt} <= ${now}
        )
      )
      and not exists (
        select 1
        from ${notificationDeliveryOutbox} predecessor
        where predecessor.notification_incident_id
                = ${notificationDeliveryOutbox.notificationIncidentId}
          and predecessor.channel = ${notificationDeliveryOutbox.channel}
          and predecessor.state in ('pending', 'leased')
          and (predecessor.transition_at, predecessor.id)
                < (${notificationDeliveryOutbox.transitionAt}, ${notificationDeliveryOutbox.id})
      )
      order by ${notificationDeliveryOutbox.transitionAt} asc,
               ${notificationDeliveryOutbox.id} asc
      for update skip locked
      limit 1
    `);
    const candidateId = candidate.rows[0]?.id;
    if (candidateId === undefined) {
      return null;
    }

    const [leased] = await tx.update(notificationDeliveryOutbox)
      .set({
        state: "leased",
        leaseToken,
        leaseExpiresAt,
        updatedAt: now,
      })
      .where(eq(notificationDeliveryOutbox.id, Number(candidateId)))
      .returning();

    return leased ?? null;
  });
}

export async function suppressLeasedNotificationDelivery(
  db: Database,
  input: {
    outboxId: number;
    leaseToken: string;
    reason:
      | "notifications_disabled"
      | "sync_failure_alerts_disabled"
      | "ai_critical_alerts_disabled";
    now?: Date;
  },
): Promise<NotificationDeliveryOutboxRow | null> {
  const now = input.now ?? new Date();
  const [suppressed] = await db.update(notificationDeliveryOutbox)
    .set({
      state: "suppressed",
      suppressionReason: input.reason,
      leaseToken: null,
      leaseExpiresAt: null,
      updatedAt: now,
    })
    .where(and(
      eq(notificationDeliveryOutbox.id, input.outboxId),
      eq(notificationDeliveryOutbox.state, "leased"),
      eq(notificationDeliveryOutbox.leaseToken, input.leaseToken),
    ))
    .returning();

  return suppressed ?? null;
}

export async function settleNotificationDeliveryOutboxAttempt(
  db: Database,
  input: {
    outboxId: number;
    leaseToken: string;
    delivery:
      | { status: "sent"; messageId: number | null }
      | { status: "failed"; error: string }
      | { status: "skipped"; error: string };
    now?: Date;
    retryDelayMs?: number;
  },
): Promise<NotificationDeliveryOutboxRow | null> {
  const now = input.now ?? new Date();

  return db.transaction(async (tx) => {
    const lockedResult = await tx.execute<{
      id: number | string;
      notificationIncidentId: number | string;
      transition: NotificationDeliveryTransition;
      attemptCount: number | string;
      maxAttempts: number | string;
    }>(sql`
      select ${notificationDeliveryOutbox.id} as id,
             ${notificationDeliveryOutbox.notificationIncidentId} as "notificationIncidentId",
             ${notificationDeliveryOutbox.transition} as transition,
             ${notificationDeliveryOutbox.attemptCount} as "attemptCount",
             ${notificationDeliveryOutbox.maxAttempts} as "maxAttempts"
      from ${notificationDeliveryOutbox}
      where ${notificationDeliveryOutbox.id} = ${input.outboxId}
        and ${notificationDeliveryOutbox.state} = 'leased'
        and ${notificationDeliveryOutbox.leaseToken} = ${input.leaseToken}
      for update
    `);
    const locked = lockedResult.rows[0];
    if (!locked) {
      return null;
    }

    const attemptCount = Number(locked.attemptCount) + 1;
    const maxAttempts = Number(locked.maxAttempts);
    const delivery = input.delivery;
    const delivered = delivery.status === "sent";
    const exhausted = !delivered && attemptCount >= maxAttempts;
    const retryDelayMs = Math.max(
      0,
      input.retryDelayMs ?? Math.min(15 * 60_000, 60_000 * 2 ** (attemptCount - 1)),
    );
    const nextState: NotificationDeliveryOutboxState = delivered
      ? "delivered"
      : exhausted
        ? "exhausted"
        : "pending";
    const lastError = delivery.status === "sent" ? null : delivery.error;

    await tx.insert(telegramDeliveryAttempts).values({
      kind: locked.transition === "resolved" ? "incident_resolved" : "incident_opened",
      status: delivery.status,
      notificationIncidentId: Number(locked.notificationIncidentId),
      messageId: delivery.status === "sent" ? delivery.messageId : null,
      error: lastError,
    });

    const [updated] = await tx.update(notificationDeliveryOutbox)
      .set({
        state: nextState,
        attemptCount,
        availableAt: delivered || exhausted
          ? now
          : new Date(now.getTime() + retryDelayMs),
        leaseToken: null,
        leaseExpiresAt: null,
        lastError,
        deliveredAt: delivered ? now : null,
        exhaustedAt: exhausted ? now : null,
        updatedAt: now,
      })
      .where(eq(notificationDeliveryOutbox.id, Number(locked.id)))
      .returning();

    return updated ?? null;
  });
}
