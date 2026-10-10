import { randomUUID } from "node:crypto";

import { and, eq, inArray, isNull, sql } from "drizzle-orm";

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
 * Д2: the delivery horizon of every `sync_failure` row (opening, recovery,
 * missed-alerts summary). After the four fast retries (1, 2, 4, 8 min) a row
 * gets at most 8 attempts an hour — one by its own 15-minute backoff ceiling
 * and at most one by a backoff release, itself at most once per
 * RELEASE_AFTER_SILENCE_MS — so 4 + 396 attempts outlast ≥ 49 h of any mix
 * of successes and failures (≈ 99 h of a solid outage, which releases
 * nothing). The count is only a backstop now: whether an opening still
 * matters is the paging sweep's call at recovery time, not the counter's.
 */
export const ALERT_DELIVERY_MAX_ATTEMPTS = 400;
/** Equal to the backoff ceiling: a delivery after this long without any
 * delivered row ends an outage and releases the backed-off alerts. */
export const RELEASE_AFTER_SILENCE_MS = 15 * 60_000;
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
 * Called only inside a transaction that also commits the state the row
 * answers for: the incident transition for the AI critical pair, the paging
 * sweep's paging row for every other kind (Decision 381). The selected paging
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

/**
 * Д2: ends an outage. The delivery pass calls it on its first delivered row:
 * when no other row was delivered in the RELEASE_AFTER_SILENCE_MS before it,
 * every backed-off `sync_failure` row becomes due at once, so the alerts that
 * are still open go out in this pass or the next instead of each waiting out
 * its own backoff (up to the 15-minute ceiling). The silence condition sits
 * in the same statement, so there is at most one release per
 * RELEASE_AFTER_SILENCE_MS, and a row that fails after the channel is back
 * waits its ordinary backoff — together with the 15-minute ceiling that keeps
 * a row at ≤ 8 attempts an hour (ALERT_DELIVERY_MAX_ATTEMPTS). The AI critical
 * pair is never released: its own horizon (5 attempts, ≈ 15 min) would burn
 * in minutes. A row another transaction holds (the paging sweep settling its
 * page) is skipped, not waited for.
 */
export async function releaseNotificationDeliveryBackoff(
  db: Database,
  input: { now: Date; deliveredOutboxId: number },
): Promise<number> {
  const silentSince = new Date(input.now.getTime() - RELEASE_AFTER_SILENCE_MS);
  const released = await db.execute<{ id: number | string }>(sql`
    update ${notificationDeliveryOutbox}
       set available_at = ${input.now},
           updated_at = ${input.now}
     where id in (
       select backed_off.id
         from notification_delivery_outbox backed_off
        where backed_off.state = 'pending'
          and backed_off.paging_policy = 'sync_failure'
          and backed_off.attempt_count > 0
          and backed_off.available_at > ${input.now}
          and not exists (
            select 1
              from notification_delivery_outbox recent
             where recent.state = 'delivered'
               and recent.delivered_at > ${silentSince}
               and recent.id <> ${input.deliveredOutboxId}
          )
        for update of backed_off skip locked
     )
    returning id
  `);
  return released.rows.length;
}

export const MISSED_ALERT_ERROR = "Not delivered: the page resolved before Telegram accepted it";
export const MANUALLY_RESOLVED_ALERT_ERROR = "Not delivered: manually resolved from the dashboard";

/** The summary text with one more line, or null when it would pass
 * `maxChars` (then the line starts a new summary). Counted in UTF-16 units,
 * as Telegram counts its 4 096. */
export function appendMissedAlertsLine(text: string, line: string, maxChars: number): string | null {
  const appended = `${text}\n${line}`;
  return appended.length <= maxChars ? appended : null;
}

export type UndeliveredPageSettlement =
  /** An opening reached Telegram, or the page has no outbox row (the 0205
   *  seed): the recovery is announced as usual. */
  | { outcome: "delivered" }
  /** Every opening was suppressed (alerts were off): settled silently. */
  | { outcome: "suppressed" }
  /** An opening is being sent right now: nothing was written; the next sweep
   *  decides once the send has settled. */
  | { outcome: "deferred" }
  /** The openings never reached Telegram and are terminal now; `missed` put
   *  the episode in a summary, `manual` retired them without one. */
  | { outcome: "retired"; summaryOutboxId: number | null; retiredOutboxIds: number[] };

/**
 * Д2: the paging sweep's decision about a page that resolved, made inside the
 * sweep's transaction with the page's opening rows locked (`FOR UPDATE`), so
 * no delivery pass can lease one of them while it is decided and none can
 * reach Telegram after it.
 *
 * A page whose opening never reached Telegram (`pending` or `exhausted`) gets
 * neither a late "🚨" nor a "✅" without its opening nor silence: with `mode:
 * "missed"` the openings are retired (`exhausted`, MISSED_ALERT_ERROR) and the
 * episode becomes one line of a missed-alerts summary — appended to the open
 * summary (the newest `pending` one that already reports a page) when the line
 * fits, with a full horizon on top of the attempts it has used; otherwise a new
 * summary carried by this incident under its standard recovery key. A summary
 * in flight (`leased`) is never edited: its text is already on the wire. With
 * `mode: "manual"` (the dashboard's own "Manually resolved" line went out) the
 * pending openings are retired without a summary.
 *
 * The caller renders the texts; this only stores them. Serialised against
 * other sweeps by the sweep's advisory lock; delivery leases skip the rows it
 * holds (`skip locked`).
 */
export async function settleUndeliveredPage(
  tx: Database,
  input: {
    incidentId: number;
    pagedAt: Date;
    mode: "missed" | "manual";
    summary: { header: string; line: string; transitionAt: Date; maxChars: number };
    now: Date;
  },
): Promise<UndeliveredPageSettlement> {
  const { now } = input;
  // An opening already reported in a summary belongs to an earlier page.
  const locked = await tx.execute<{ id: number | string; state: NotificationDeliveryOutboxState }>(sql`
    select id, state
      from ${notificationDeliveryOutbox}
     where notification_incident_id = ${input.incidentId}
       and transition <> 'resolved'
       and created_at >= ${input.pagedAt}
       and reported_in_outbox_id is null
     order by id
     for update
  `);
  const openings = locked.rows.map((row) => ({ id: Number(row.id), state: row.state }));
  if (openings.length === 0 || openings.some((row) => row.state === "delivered")) {
    return { outcome: "delivered" };
  }
  if (openings.some((row) => row.state === "leased")) {
    return { outcome: "deferred" };
  }
  if (openings.every((row) => row.state === "suppressed")) {
    return { outcome: "suppressed" };
  }
  const pendingIds = openings.filter((row) => row.state === "pending").map((row) => row.id);
  const exhaustedIds = openings.filter((row) => row.state === "exhausted").map((row) => row.id);

  const retire = (lastError: string, summaryOutboxId: number | null) => tx.update(notificationDeliveryOutbox)
    .set({
      state: "exhausted",
      availableAt: now,
      leaseToken: null,
      leaseExpiresAt: null,
      lastError,
      exhaustedAt: now,
      reportedInOutboxId: summaryOutboxId,
      updatedAt: now,
    })
    .where(and(
      inArray(notificationDeliveryOutbox.id, pendingIds),
      eq(notificationDeliveryOutbox.state, "pending"),
    ));

  if (input.mode === "manual") {
    if (pendingIds.length > 0) {
      await retire(MANUALLY_RESOLVED_ALERT_ERROR, null);
    }
    return { outcome: "retired", summaryOutboxId: null, retiredOutboxIds: pendingIds };
  }

  const open = await tx.execute<{ id: number | string; messageText: string }>(sql`
    select summary.id, summary.message_text as "messageText"
      from notification_delivery_outbox summary
     where summary.transition = 'resolved'
       and summary.paging_policy = 'sync_failure'
       and summary.channel = 'telegram'
       and summary.state = 'pending'
       and exists (
         select 1
           from notification_delivery_outbox reported
          where reported.reported_in_outbox_id = summary.id
       )
     order by summary.id desc
     limit 1
     for update of summary
  `);
  const current = open.rows[0];
  const appended = current
    ? appendMissedAlertsLine(current.messageText, input.summary.line, input.summary.maxChars)
    : null;
  let summaryOutboxId: number;
  if (current && appended !== null) {
    summaryOutboxId = Number(current.id);
    // The new episode gets a full horizon, whatever the summary has used.
    await tx.update(notificationDeliveryOutbox)
      .set({
        messageText: appended,
        maxAttempts: sql`${notificationDeliveryOutbox.attemptCount} + ${ALERT_DELIVERY_MAX_ATTEMPTS}`,
        updatedAt: now,
      })
      .where(eq(notificationDeliveryOutbox.id, summaryOutboxId));
  } else {
    const created = await enqueueNotificationDeliveryOutbox(tx, {
      notificationIncidentId: input.incidentId,
      transition: "resolved",
      transitionAt: input.summary.transitionAt,
      request: {
        channel: "telegram",
        messageText: `${input.summary.header}\n${input.summary.line}`,
        pagingPolicy: "sync_failure",
        maxAttempts: ALERT_DELIVERY_MAX_ATTEMPTS,
      },
      now,
    });
    summaryOutboxId = created.id;
  }

  if (pendingIds.length > 0) {
    await retire(MISSED_ALERT_ERROR, summaryOutboxId);
  }
  if (exhaustedIds.length > 0) {
    await tx.update(notificationDeliveryOutbox)
      .set({ reportedInOutboxId: summaryOutboxId, updatedAt: now })
      .where(and(
        inArray(notificationDeliveryOutbox.id, exhaustedIds),
        isNull(notificationDeliveryOutbox.reportedInOutboxId),
      ));
  }
  return { outcome: "retired", summaryOutboxId, retiredOutboxIds: [...pendingIds, ...exhaustedIds] };
}

/**
 * Д2: the digest's page counts — the `sync_failure` openings created since
 * `since` (suppressed ones were never meant to go out), by where they ended:
 * delivered, not delivered (`exhausted`, including the ones retired into a
 * missed-alerts summary) and still in the queue.
 */
export async function summarizeNotificationPageDelivery(
  db: Database,
  input: { since: Date },
): Promise<{ delivered: number; missed: number; queued: number }> {
  const result = await db.execute<{ delivered: number | string; missed: number | string; queued: number | string }>(sql`
    select count(*) filter (where state = 'delivered') as delivered,
           count(*) filter (where state = 'exhausted') as missed,
           count(*) filter (where state in ('pending', 'leased')) as queued
      from ${notificationDeliveryOutbox}
     where paging_policy = 'sync_failure'
       and transition <> 'resolved'
       and state <> 'suppressed'
       and created_at >= ${input.since}
  `);
  const row = result.rows[0];
  return {
    delivered: Number(row?.delivered ?? 0),
    missed: Number(row?.missed ?? 0),
    queued: Number(row?.queued ?? 0),
  };
}
