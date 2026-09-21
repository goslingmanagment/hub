import { and, desc, eq, gte, isNull, or, sql } from "drizzle-orm";

import type { Database } from "../client.ts";
import {
  notificationIncidentCycles,
  notificationIncidentPaging,
  notificationIncidents,
  pages,
  telegramDeliveryAttempts,
} from "../schema.ts";
import type { NotificationIncidentKind, NotificationIncidentStatus } from "./notifications.ts";

// Decision 381. The paging sweep's persistence: which latch episodes it has
// seen, which one the owner was paged about, and the episode history the flap
// detector and the daily digest read.

export type NotificationIncidentPagingRow = typeof notificationIncidentPaging.$inferSelect;
export type NotificationIncidentCycleRow = typeof notificationIncidentCycles.$inferSelect;
export type NotificationPagingMode = "immediate" | "sustained" | "flapping";

export interface NotificationPagingCandidate {
  incidentId: number;
  incidentKey: string;
  kind: NotificationIncidentKind;
  platformAccountId: number | null;
  pageLabel: string | null;
  platform: "fansly" | "onlyfans" | null;
  stream: string | null;
  status: NotificationIncidentStatus;
  openedAt: Date;
  lastSeenAt: Date;
  resolvedAt: Date | null;
  errorSummary: string | null;
  paging: NotificationIncidentPagingRow | null;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

/**
 * Every latch the sweep has to look at: all open incidents, the resolved ones
 * whose recovery is recent enough to still owe an episode row, and any
 * standing page whose recovery has not been announced yet, however old.
 * `excludeKinds` keeps the kinds that page through their own atomic outbox
 * (the AI critical latches) out of this policy entirely.
 */
export async function listNotificationPagingCandidates(
  db: Database,
  input: {
    resolvedSince: Date;
    excludeKinds?: readonly NotificationIncidentKind[];
  },
): Promise<NotificationPagingCandidate[]> {
  const rows = await db
    .select({
      incidentId: notificationIncidents.id,
      incidentKey: notificationIncidents.incidentKey,
      kind: notificationIncidents.kind,
      platformAccountId: notificationIncidents.platformAccountId,
      pageLabel: pages.label,
      platform: pages.platform,
      stream: notificationIncidents.stream,
      status: notificationIncidents.status,
      openedAt: notificationIncidents.openedAt,
      lastSeenAt: notificationIncidents.lastSeenAt,
      resolvedAt: notificationIncidents.resolvedAt,
      errorSummary: notificationIncidents.errorSummary,
      paging: notificationIncidentPaging,
    })
    .from(notificationIncidents)
    .leftJoin(pages, eq(notificationIncidents.platformAccountId, pages.id))
    .leftJoin(
      notificationIncidentPaging,
      eq(notificationIncidentPaging.notificationIncidentId, notificationIncidents.id),
    )
    .where(and(
      or(
        eq(notificationIncidents.status, "open"),
        gte(notificationIncidents.resolvedAt, input.resolvedSince),
        and(
          sql`${notificationIncidentPaging.pagedAt} is not null`,
          isNull(notificationIncidentPaging.pagedResolvedAt),
        ),
      ),
      ...(input.excludeKinds && input.excludeKinds.length > 0
        ? [sql`${notificationIncidents.kind} not in (${sql.join(
          input.excludeKinds.map((kind) => sql`${kind}::notification_incident_kind`),
          sql`, `,
        )})`]
        : []),
    ))
    .orderBy(notificationIncidents.openedAt, notificationIncidents.id);

  return rows.map((row) => ({
    incidentId: Number(row.incidentId),
    incidentKey: row.incidentKey,
    kind: row.kind,
    platformAccountId: row.platformAccountId === null ? null : Number(row.platformAccountId),
    pageLabel: row.pageLabel ?? null,
    platform: (row.platform ?? null) as "fansly" | "onlyfans" | null,
    stream: row.stream ?? null,
    status: row.status,
    openedAt: toDate(row.openedAt),
    lastSeenAt: toDate(row.lastSeenAt),
    resolvedAt: row.resolvedAt ? toDate(row.resolvedAt) : null,
    errorSummary: row.errorSummary ?? null,
    paging: row.paging ?? null,
  }));
}

export async function getNotificationIncidentPaging(
  db: Database,
  notificationIncidentId: number,
): Promise<NotificationIncidentPagingRow | null> {
  const [row] = await db.select()
    .from(notificationIncidentPaging)
    .where(eq(notificationIncidentPaging.notificationIncidentId, notificationIncidentId))
    .limit(1);
  return row ?? null;
}

export async function upsertNotificationIncidentPaging(
  db: Database,
  input: {
    notificationIncidentId: number;
    observedOpenedAt: Date;
    observedStatus: NotificationIncidentStatus;
    /** Omitted fields keep their stored value on an existing row. */
    pagedOpenedAt?: Date | null;
    pagedAt?: Date | null;
    pagedMode?: NotificationPagingMode | null;
    pagedResolvedAt?: Date | null;
    now?: Date;
  },
): Promise<NotificationIncidentPagingRow> {
  const now = input.now ?? new Date();
  const paged = {
    ...(input.pagedOpenedAt !== undefined ? { pagedOpenedAt: input.pagedOpenedAt } : {}),
    ...(input.pagedAt !== undefined ? { pagedAt: input.pagedAt } : {}),
    ...(input.pagedMode !== undefined ? { pagedMode: input.pagedMode } : {}),
    ...(input.pagedResolvedAt !== undefined ? { pagedResolvedAt: input.pagedResolvedAt } : {}),
  };
  const [row] = await db.insert(notificationIncidentPaging)
    .values({
      notificationIncidentId: input.notificationIncidentId,
      observedOpenedAt: input.observedOpenedAt,
      observedStatus: input.observedStatus,
      pagedOpenedAt: input.pagedOpenedAt ?? null,
      pagedAt: input.pagedAt ?? null,
      pagedMode: input.pagedMode ?? null,
      pagedResolvedAt: input.pagedResolvedAt ?? null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: notificationIncidentPaging.notificationIncidentId,
      set: {
        observedOpenedAt: input.observedOpenedAt,
        observedStatus: input.observedStatus,
        ...paged,
        updatedAt: now,
      },
    })
    .returning();
  if (!row) {
    throw new Error(
      `Notification paging state for incident ${input.notificationIncidentId} could not be written`,
    );
  }
  return row;
}

/** Idempotent on (incident, opened_at): the latch rewrites opened_at on every
 * reopen, so that pair identifies an episode. */
export async function recordNotificationIncidentCycle(
  db: Database,
  input: {
    notificationIncidentId: number;
    incidentKey: string;
    kind: NotificationIncidentKind;
    platformAccountId: number | null;
    openedAt: Date;
    resolvedAt?: Date | null;
    /** True when a page is already standing: the episode is covered by it. */
    paged?: boolean;
    now?: Date;
  },
): Promise<void> {
  await db.insert(notificationIncidentCycles)
    .values({
      notificationIncidentId: input.notificationIncidentId,
      incidentKey: input.incidentKey,
      kind: input.kind,
      platformAccountId: input.platformAccountId,
      openedAt: input.openedAt,
      resolvedAt: input.resolvedAt ?? null,
      paged: input.paged ?? false,
      createdAt: input.now ?? new Date(),
    })
    .onConflictDoNothing({
      target: [notificationIncidentCycles.notificationIncidentId, notificationIncidentCycles.openedAt],
    });
}

export async function settleNotificationIncidentCycle(
  db: Database,
  input: {
    notificationIncidentId: number;
    openedAt: Date;
    resolvedAt: Date;
  },
): Promise<void> {
  await db.update(notificationIncidentCycles)
    .set({ resolvedAt: input.resolvedAt })
    .where(and(
      eq(notificationIncidentCycles.notificationIncidentId, input.notificationIncidentId),
      eq(notificationIncidentCycles.openedAt, input.openedAt),
      isNull(notificationIncidentCycles.resolvedAt),
    ));
}

/** Marks every episode of the incident that started at or after `since` as
 * covered by a page: a flapping page covers the whole storm, not one episode. */
export async function markNotificationIncidentCyclesPaged(
  db: Database,
  input: {
    notificationIncidentId: number;
    since: Date;
  },
): Promise<void> {
  await db.update(notificationIncidentCycles)
    .set({ paged: true })
    .where(and(
      eq(notificationIncidentCycles.notificationIncidentId, input.notificationIncidentId),
      gte(notificationIncidentCycles.openedAt, input.since),
    ));
}

export async function summarizeNotificationIncidentCycles(
  db: Database,
  input: {
    notificationIncidentId: number;
    since: Date;
  },
): Promise<{ count: number; earliestOpenedAt: Date | null }> {
  const [row] = await db
    .select({
      count: sql<number>`count(*)::int`,
      earliestOpenedAt: sql<Date | string | null>`min(${notificationIncidentCycles.openedAt})`,
    })
    .from(notificationIncidentCycles)
    .where(and(
      eq(notificationIncidentCycles.notificationIncidentId, input.notificationIncidentId),
      gte(notificationIncidentCycles.openedAt, input.since),
    ));
  return {
    count: Number(row?.count ?? 0),
    earliestOpenedAt: row?.earliestOpenedAt ? toDate(row.earliestOpenedAt) : null,
  };
}

/** The dashboard's manual resolve sends its own Telegram line; the sweep
 * must not follow it with a second recovery notice. */
export async function hasManualIncidentResolveSince(
  db: Database,
  input: {
    notificationIncidentId: number;
    since: Date;
  },
): Promise<boolean> {
  const [row] = await db
    .select({ id: telegramDeliveryAttempts.id })
    .from(telegramDeliveryAttempts)
    .where(and(
      eq(telegramDeliveryAttempts.notificationIncidentId, input.notificationIncidentId),
      eq(telegramDeliveryAttempts.kind, "incident_manually_resolved"),
      gte(telegramDeliveryAttempts.createdAt, input.since),
    ))
    .limit(1);
  return row !== undefined;
}

export interface NotificationIncidentCycleWithPage {
  incidentId: number;
  incidentKey: string;
  kind: NotificationIncidentKind;
  pageLabel: string | null;
  platform: "fansly" | "onlyfans" | null;
  stream: string | null;
  openedAt: Date;
  resolvedAt: Date | null;
  paged: boolean;
}

/** Digest input: every episode that started in the window, newest first. */
export async function listNotificationIncidentCyclesSince(
  db: Database,
  input: { since: Date; limit?: number },
): Promise<NotificationIncidentCycleWithPage[]> {
  const rows = await db
    .select({
      incidentId: notificationIncidentCycles.notificationIncidentId,
      incidentKey: notificationIncidentCycles.incidentKey,
      kind: notificationIncidentCycles.kind,
      pageLabel: pages.label,
      platform: pages.platform,
      stream: notificationIncidents.stream,
      openedAt: notificationIncidentCycles.openedAt,
      resolvedAt: notificationIncidentCycles.resolvedAt,
      paged: notificationIncidentCycles.paged,
    })
    .from(notificationIncidentCycles)
    .innerJoin(
      notificationIncidents,
      eq(notificationIncidents.id, notificationIncidentCycles.notificationIncidentId),
    )
    .leftJoin(pages, eq(notificationIncidentCycles.platformAccountId, pages.id))
    .where(gte(notificationIncidentCycles.openedAt, input.since))
    .orderBy(desc(notificationIncidentCycles.openedAt), desc(notificationIncidentCycles.id))
    .limit(input.limit ?? 5_000);

  return rows.map((row) => ({
    incidentId: Number(row.incidentId),
    incidentKey: row.incidentKey,
    kind: row.kind,
    pageLabel: row.pageLabel ?? null,
    platform: (row.platform ?? null) as "fansly" | "onlyfans" | null,
    stream: row.stream ?? null,
    openedAt: toDate(row.openedAt),
    resolvedAt: row.resolvedAt ? toDate(row.resolvedAt) : null,
    paged: row.paged,
  }));
}
