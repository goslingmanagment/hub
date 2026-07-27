import { and, count, desc, eq, lte, sql } from "drizzle-orm";

import type { Database } from "../client.ts";
import {
  notificationDeliveryOutbox,
  notificationIncidentRecoveries,
  notificationIncidents,
  pages,
  telegramDeliveryAttempts,
} from "../schema.ts";
import {
  enqueueNotificationDeliveryOutbox,
  type NotificationDeliveryOutboxRequest,
  type NotificationDeliveryOutboxState,
} from "./notification-outbox.ts";

export type NotificationIncidentKind =
  | "auth_blocked"
  | "proxy_failed"
  | "proxy_missing"
  | "stream_failed_threshold"
  | "ofapi_auth"
  | "ofapi_low_credit"
  | "ofapi_webhook_silence"
  | "ofapi_burn_rate"
  | "db_disk_usage"
  | "observations_partitions"
  | "wrong_transactions_writer"
  | "read_gateway_capture"
  | "golden_signal_lag"
  | "scheduler_silent"
  | "ops_sampler_silent"
  | "ofapi_chargebacks_reconcile_failed"
  | "ofapi_link_stats_reconcile_failed"
  | "ai_provider_billing"
  | "ai_provider_failed";
export type NotificationIncidentStatus = "open" | "resolved";
export type NotificationIncidentRow = typeof notificationIncidents.$inferSelect;
export type NotificationIncidentTransition = "opened" | "reopened" | "existing";
export type GuardedNotificationIncidentTransition = NotificationIncidentTransition | "suppressed";
const MAX_OPEN_INCIDENT_ATTEMPTS = 3;
const INCIDENT_ADVISORY_LOCK_SEED = 837_451_029;

type LockedNotificationIncidentRow = NotificationIncidentRow & {
  status: NotificationIncidentStatus;
  resolvedAt: Date | string | null;
  lastSeenAt: Date | string | null;
};

function normalizeDate(value: Date | string | null | undefined) {
  if (!value) {
    return null;
  }

  return value instanceof Date ? value : new Date(value);
}

function isAfter(value: Date | string | null | undefined, reference: Date) {
  const date = normalizeDate(value);
  return date !== null && date.getTime() > reference.getTime();
}

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  if ("code" in error && error.code === "23505") {
    return true;
  }

  return "cause" in error && isUniqueViolation(error.cause);
}

async function readNotificationIncidentForReturn(
  db: Database,
  incidentId: number,
) {
  const [incident] = await db.select()
    .from(notificationIncidents)
    .where(eq(notificationIncidents.id, incidentId))
    .limit(1);

  if (!incident) {
    throw new Error(`Notification incident "${incidentId}" could not be read`);
  }

  return incident;
}

async function lockNotificationIncidentKey(
  db: Database,
  incidentKey: string,
) {
  await db.execute(sql`
    select pg_advisory_xact_lock(hashtextextended(${incidentKey}, ${INCIDENT_ADVISORY_LOCK_SEED}))
  `);
}

async function getNotificationIncidentRecovery(
  db: Database,
  incidentKey: string,
) {
  const [recovery] = await db.select()
    .from(notificationIncidentRecoveries)
    .where(eq(notificationIncidentRecoveries.incidentKey, incidentKey))
    .limit(1);

  return recovery ?? null;
}

function isAtOrAfter(value: Date | string | null | undefined, reference: Date) {
  const date = normalizeDate(value);
  return date !== null && date.getTime() >= reference.getTime();
}

export async function getNotificationIncidentByKey(db: Database, incidentKey: string) {
  return (await db.query.notificationIncidents.findFirst({
    where: eq(notificationIncidents.incidentKey, incidentKey),
  })) ?? null;
}

export async function listNotificationIncidents(
  db: Database,
  input?: {
    status?: NotificationIncidentStatus;
    platformAccountId?: number;
  },
) {
  const clauses = [];

  if (input?.status) {
    clauses.push(eq(notificationIncidents.status, input.status));
  }

  if (input?.platformAccountId !== undefined) {
    clauses.push(eq(notificationIncidents.platformAccountId, input.platformAccountId));
  }

  return db.query.notificationIncidents.findMany({
    where: clauses.length > 0 ? and(...clauses) : undefined,
  });
}

export interface NotificationIncidentWithPage {
  id: number;
  incidentKey: string;
  kind: NotificationIncidentKind;
  /** Null for global incidents (db_disk_usage, observations_partitions, …). */
  pageLabel: string | null;
  platform: "fansly" | "onlyfans" | null;
  stream: string | null;
  status: NotificationIncidentStatus;
  openedAt: Date;
  lastSeenAt: Date;
  resolvedAt: Date | null;
  errorCode: string | null;
  errorSummary: string | null;
  notificationCount: number;
  outboxState: NotificationDeliveryOutboxState | null;
  outboxAttemptCount: number | null;
  outboxLastError: string | null;
  outboxSuppressionReason: string | null;
}

export async function listNotificationIncidentsWithPages(
  db: Database,
  input?: {
    status?: NotificationIncidentStatus;
    kind?: NotificationIncidentKind;
    pageLabel?: string;
    limit?: number;
    offset?: number;
  },
): Promise<{ items: NotificationIncidentWithPage[]; total: number }> {
  const clauses = [];

  if (input?.status) {
    clauses.push(eq(notificationIncidents.status, input.status));
  }
  if (input?.kind) {
    clauses.push(eq(notificationIncidents.kind, input.kind));
  }
  if (input?.pageLabel) {
    clauses.push(eq(pages.label, input.pageLabel));
  }

  const whereClause = clauses.length > 0 ? and(...clauses) : undefined;
  const limit = input?.limit ?? 50;
  const offset = input?.offset ?? 0;

  const countResult = await db
    .select({ total: count() })
    .from(notificationIncidents)
    .leftJoin(pages, eq(notificationIncidents.platformAccountId, pages.id))
    .where(whereClause);

  const rows = await db
    .select({
      id: notificationIncidents.id,
      incidentKey: notificationIncidents.incidentKey,
      kind: notificationIncidents.kind,
      pageLabel: pages.label,
      platform: pages.platform,
      stream: notificationIncidents.stream,
      status: notificationIncidents.status,
      openedAt: notificationIncidents.openedAt,
      lastSeenAt: notificationIncidents.lastSeenAt,
      resolvedAt: notificationIncidents.resolvedAt,
      errorCode: notificationIncidents.errorCode,
      errorSummary: notificationIncidents.errorSummary,
      notificationCount: sql<number>`(select count(*)::int from ${telegramDeliveryAttempts} where ${telegramDeliveryAttempts.notificationIncidentId} = ${notificationIncidents.id})`,
      outboxState: sql<NotificationDeliveryOutboxState | null>`(
        select ${notificationDeliveryOutbox.state}
        from ${notificationDeliveryOutbox}
        where ${notificationDeliveryOutbox.notificationIncidentId} = ${notificationIncidents.id}
        order by ${notificationDeliveryOutbox.createdAt} desc,
                 ${notificationDeliveryOutbox.id} desc
        limit 1
      )`,
      outboxAttemptCount: sql<number | null>`(
        select ${notificationDeliveryOutbox.attemptCount}
        from ${notificationDeliveryOutbox}
        where ${notificationDeliveryOutbox.notificationIncidentId} = ${notificationIncidents.id}
        order by ${notificationDeliveryOutbox.createdAt} desc,
                 ${notificationDeliveryOutbox.id} desc
        limit 1
      )`,
      outboxLastError: sql<string | null>`(
        select ${notificationDeliveryOutbox.lastError}
        from ${notificationDeliveryOutbox}
        where ${notificationDeliveryOutbox.notificationIncidentId} = ${notificationIncidents.id}
        order by ${notificationDeliveryOutbox.createdAt} desc,
                 ${notificationDeliveryOutbox.id} desc
        limit 1
      )`,
      outboxSuppressionReason: sql<string | null>`(
        select ${notificationDeliveryOutbox.suppressionReason}
        from ${notificationDeliveryOutbox}
        where ${notificationDeliveryOutbox.notificationIncidentId} = ${notificationIncidents.id}
        order by ${notificationDeliveryOutbox.createdAt} desc,
                 ${notificationDeliveryOutbox.id} desc
        limit 1
      )`,
    })
    .from(notificationIncidents)
    .leftJoin(pages, eq(notificationIncidents.platformAccountId, pages.id))
    .where(whereClause)
    .orderBy(desc(notificationIncidents.openedAt))
    .limit(limit)
    .offset(offset);

  return {
    items: rows as NotificationIncidentWithPage[],
    total: countResult[0]?.total ?? 0,
  };
}

async function openNotificationIncidentInternal(
  db: Database,
  input: {
    incidentKey: string;
    kind: NotificationIncidentKind;
    platformAccountId: number | null;
    stream?: NotificationIncidentRow["stream"] | null;
    errorCode?: string | null;
    errorSummary?: string | null;
    metadata?: Record<string, unknown>;
    outbox?: NotificationDeliveryOutboxRequest;
    now?: Date;
  },
  guard?: {
    occurredAt: Date;
  },
): Promise<{
  incident: NotificationIncidentRow | null;
  transition: GuardedNotificationIncidentTransition;
}> {
  const now = input.now ?? new Date();
  const eventTime = guard?.occurredAt ?? now;
  const values = {
    incidentKey: input.incidentKey,
    kind: input.kind,
    platformAccountId: input.platformAccountId,
    stream: input.stream ?? null,
    status: "open" as const,
    openedAt: eventTime,
    lastSeenAt: eventTime,
    resolvedAt: null,
    errorCode: input.errorCode ?? null,
    errorSummary: input.errorSummary ?? null,
    metadata: input.metadata ?? {},
    updatedAt: now,
  };
  const existingUpdate = {
    lastSeenAt: eventTime,
    errorCode: input.errorCode ?? null,
    errorSummary: input.errorSummary ?? null,
    metadata: input.metadata ?? {},
    updatedAt: now,
  };

  for (let attempt = 0; attempt < MAX_OPEN_INCIDENT_ATTEMPTS; attempt += 1) {
    try {
      return await db.transaction(async (tx) => {
        await lockNotificationIncidentKey(tx as unknown as Database, input.incidentKey);
        if (guard) {
          const recovery = await getNotificationIncidentRecovery(
            tx as unknown as Database,
            input.incidentKey,
          );
          if (recovery && isAtOrAfter(recovery.recoveredAt, guard.occurredAt)) {
            return {
              incident: null,
              transition: "suppressed" as const,
            };
          }
        }

        const lockedResult = await tx.execute(sql<LockedNotificationIncidentRow>`
          select id,
                 status,
                 resolved_at as "resolvedAt",
                 last_seen_at as "lastSeenAt"
          from ${notificationIncidents}
          where ${notificationIncidents.incidentKey} = ${input.incidentKey}
          for update
        `);
        const locked = (lockedResult.rows[0] as LockedNotificationIncidentRow | undefined) ?? null;

        if (!locked) {
          const [inserted] = await tx.insert(notificationIncidents)
            .values(values)
            .returning();

          if (!inserted) {
            throw new Error(`Notification incident "${input.incidentKey}" could not be inserted`);
          }
          if (input.outbox) {
            await enqueueNotificationDeliveryOutbox(tx as unknown as Database, {
              notificationIncidentId: inserted.id,
              transition: "opened",
              transitionAt: eventTime,
              request: input.outbox,
              now,
            });
          }

          return {
            incident: inserted,
            transition: "opened" as const,
          };
        }

        if (locked.status === "resolved") {
          const lockedId = Number(locked.id);
          // Ordering is decided by EVENT time, never by the processing clock:
          // a failure that occurred before the stored terminal is stale even
          // when it reaches us later (concurrent generations settle out of
          // order, so `completedAt` routinely arrives non-monotonically).
          //
          // STRICT `>` here, unlike the `lastSeenAt` branch below: a failure
          // sharing a millisecond with a resolve is new information, and a
          // silently dropped reopen is a page nobody gets.
          //
          // Scope, precisely: this rule only ever decides a tie for the
          // NO-TOMBSTONE resolve primitive (`resolveNotificationIncident`).
          // Every production producer opens through the recovery guard above,
          // and that guard suppresses at `recovery.recoveredAt >= occurredAt`
          // — so on a real recovery the tombstone wins the tie before this
          // line is reached, and `recoverAndResolveNotificationIncident`
          // likewise resolves on `last_seen_at <= recoveredAt`. Production
          // ties therefore go to the RECOVERY. That asymmetry is inherited
          // (the guard predates this change) and is left alone deliberately:
          // both directions self-heal on the next terminal, and tightening
          // the guard would reopen the delayed-retry race it was added for.
          if (isAfter(locked.resolvedAt, eventTime)) {
            return {
              incident: await readNotificationIncidentForReturn(tx as unknown as Database, lockedId),
              transition: "existing" as const,
            };
          }

          const [reopened] = await tx.update(notificationIncidents)
            .set(values)
            .where(eq(notificationIncidents.id, lockedId))
            .returning();

          if (!reopened) {
            throw new Error(`Notification incident "${input.incidentKey}" could not be reopened`);
          }
          if (input.outbox) {
            await enqueueNotificationDeliveryOutbox(tx as unknown as Database, {
              notificationIncidentId: reopened.id,
              transition: "reopened",
              transitionAt: eventTime,
              request: input.outbox,
              now,
            });
          }

          return {
            incident: reopened,
            transition: "reopened" as const,
          };
        }

        const lockedId = Number(locked.id);
        // Same event-time rule as the resolved branch. Returning early also
        // keeps `errorCode`/`errorSummary`/`metadata` owned by the NEWEST
        // event: a delayed failure must not overwrite the current cause, and
        // must not drag `last_seen_at` backwards past a later failure (which
        // would let `maxLastSeenAt` resolve a still-broken incident).
        //
        // `>=` here, unlike the resolved branch: both sides are failures of
        // the same latch, so a same-millisecond repeat carries no new state
        // and first-writer-wins just spares the cause fields pointless churn.
        if (isAtOrAfter(locked.lastSeenAt, eventTime)) {
          return {
            incident: await readNotificationIncidentForReturn(tx as unknown as Database, lockedId),
            transition: "existing" as const,
          };
        }

        const [existing] = await tx.update(notificationIncidents)
          .set(existingUpdate)
          .where(eq(notificationIncidents.id, lockedId))
          .returning();

        if (!existing) {
          throw new Error(`Notification incident "${input.incidentKey}" could not be refreshed`);
        }

        return {
          incident: existing,
          transition: "existing" as const,
        };
      });
    } catch (error) {
      if (attempt < MAX_OPEN_INCIDENT_ATTEMPTS - 1 && isUniqueViolation(error)) {
        continue;
      }
      throw error;
    }
  }

  throw new Error(`Notification incident "${input.incidentKey}" could not be opened`);
}

export async function openNotificationIncident(
  db: Database,
  input: {
    incidentKey: string;
    kind: NotificationIncidentKind;
    platformAccountId: number | null;
    stream?: NotificationIncidentRow["stream"] | null;
    errorCode?: string | null;
    errorSummary?: string | null;
    metadata?: Record<string, unknown>;
    outbox?: NotificationDeliveryOutboxRequest;
    now?: Date;
  },
): Promise<{
  incident: NotificationIncidentRow;
  transition: NotificationIncidentTransition;
}> {
  const result = await openNotificationIncidentInternal(db, input);
  if (!result.incident || result.transition === "suppressed") {
    throw new Error(`Notification incident "${input.incidentKey}" was unexpectedly suppressed`);
  }

  return result as {
    incident: NotificationIncidentRow;
    transition: NotificationIncidentTransition;
  };
}

export async function openNotificationIncidentWithRecoveryGuard(
  db: Database,
  input: {
    incidentKey: string;
    kind: NotificationIncidentKind;
    platformAccountId: number | null;
    stream?: NotificationIncidentRow["stream"] | null;
    errorCode?: string | null;
    errorSummary?: string | null;
    metadata?: Record<string, unknown>;
    outbox?: NotificationDeliveryOutboxRequest;
    occurredAt: Date;
    now?: Date;
  },
): Promise<{
  incident: NotificationIncidentRow | null;
  transition: GuardedNotificationIncidentTransition;
}> {
  return openNotificationIncidentInternal(db, input, {
    occurredAt: input.occurredAt,
  });
}

/** The recovery tombstone upsert alone. The caller owns the transaction and
 * the advisory lock, so it can commit atomically with the resolve. */
async function upsertNotificationIncidentRecovery(
  db: Database,
  input: {
    incidentKey: string;
    recoveredAt: Date;
    metadata?: Record<string, unknown>;
    now: Date;
  },
) {
  await db.insert(notificationIncidentRecoveries)
    .values({
      incidentKey: input.incidentKey,
      recoveredAt: input.recoveredAt,
      metadata: input.metadata ?? {},
      updatedAt: input.now,
    })
    .onConflictDoUpdate({
      target: notificationIncidentRecoveries.incidentKey,
      set: {
        recoveredAt: sql`greatest(${notificationIncidentRecoveries.recoveredAt}, excluded.recovered_at)`,
        metadata: input.metadata ?? {},
        updatedAt: input.now,
      },
    });
}

export async function recordNotificationIncidentRecovery(
  db: Database,
  input: {
    incidentKey: string;
    recoveredAt: Date;
    metadata?: Record<string, unknown>;
    now?: Date;
  },
) {
  const now = input.now ?? new Date();
  await db.transaction(async (tx) => {
    await lockNotificationIncidentKey(tx as unknown as Database, input.incidentKey);
    await upsertNotificationIncidentRecovery(tx as unknown as Database, {
      incidentKey: input.incidentKey,
      recoveredAt: input.recoveredAt,
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      now,
    });
  });
}

/**
 * Tombstone + conditional resolve + resolved-outbox row in ONE transaction
 * under the same advisory lock the opener takes. Splitting them (the previous
 * shape) left a crash seam: a committed tombstone with no resolve pins the
 * incident open forever while silently suppressing every older failure.
 *
 * Event time (`recoveredAt`) decides ordering and is what lands in the row;
 * `processedAt` is audit-only (`updated_at`).
 */
export async function recoverAndResolveNotificationIncident(
  db: Database,
  input: {
    incidentKey: string;
    recoveredAt: Date;
    metadata?: Record<string, unknown>;
    outbox?: NotificationDeliveryOutboxRequest;
    processedAt?: Date;
  },
): Promise<NotificationIncidentRow | null> {
  const processedAt = input.processedAt ?? new Date();

  return db.transaction(async (tx) => {
    const txDb = tx as unknown as Database;
    await lockNotificationIncidentKey(txDb, input.incidentKey);
    await upsertNotificationIncidentRecovery(txDb, {
      incidentKey: input.incidentKey,
      recoveredAt: input.recoveredAt,
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      now: processedAt,
    });

    const [resolved] = await tx.update(notificationIncidents)
      .set({
        status: "resolved",
        resolvedAt: input.recoveredAt,
        lastSeenAt: input.recoveredAt,
        metadata: input.metadata ?? {},
        updatedAt: processedAt,
      })
      .where(and(
        eq(notificationIncidents.incidentKey, input.incidentKey),
        eq(notificationIncidents.status, "open"),
        lte(notificationIncidents.lastSeenAt, input.recoveredAt),
      ))
      .returning();

    if (resolved && input.outbox) {
      await enqueueNotificationDeliveryOutbox(txDb, {
        notificationIncidentId: resolved.id,
        transition: "resolved",
        transitionAt: input.recoveredAt,
        request: input.outbox,
        now: processedAt,
      });
    }

    return resolved ?? null;
  });
}

/**
 * Resolve WITHOUT writing a recovery tombstone. Production recovery paths use
 * `recoverAndResolveNotificationIncident` instead — it commits the tombstone,
 * the resolve and the outbox row together under the incident-key lock. Reach
 * for this one only when there is deliberately no recovery event to record.
 */
export async function resolveNotificationIncident(
  db: Database,
  input: {
    incidentKey: string;
    metadata?: Record<string, unknown>;
    maxLastSeenAt?: Date;
    outbox?: NotificationDeliveryOutboxRequest;
    now?: Date;
  },
): Promise<NotificationIncidentRow | null> {
  const now = input.now ?? new Date();
  const clauses = [
    eq(notificationIncidents.incidentKey, input.incidentKey),
    eq(notificationIncidents.status, "open"),
  ];
  if (input.maxLastSeenAt) {
    clauses.push(lte(notificationIncidents.lastSeenAt, input.maxLastSeenAt));
  }

  const resolveWith = async (connection: Database) => {
    const [resolved] = await connection.update(notificationIncidents)
      .set({
        status: "resolved",
        resolvedAt: now,
        lastSeenAt: now,
        metadata: input.metadata ?? {},
        updatedAt: now,
      })
      .where(and(...clauses))
      .returning();

    if (resolved && input.outbox) {
      await enqueueNotificationDeliveryOutbox(connection, {
        notificationIncidentId: resolved.id,
        transition: "resolved",
        transitionAt: now,
        request: input.outbox,
        now,
      });
    }
    return resolved ?? null;
  };

  return input.outbox
    ? db.transaction((tx) => resolveWith(tx as unknown as Database))
    : resolveWith(db);
}
