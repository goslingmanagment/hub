import { and, count, desc, eq, sql } from "drizzle-orm";

import type { Database } from "../client.ts";
import { notificationIncidents, platformAccounts, telegramDeliveryAttempts } from "../schema.ts";

export type NotificationIncidentKind = "auth_failed" | "proxy_failed" | "stream_failed_threshold";
export type NotificationIncidentStatus = "open" | "resolved";
export type NotificationIncidentRow = typeof notificationIncidents.$inferSelect;
export type NotificationIncidentTransition = "opened" | "reopened" | "existing";

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
  pageLabel: string;
  platform: "fansly" | "onlyfans";
  stream: string | null;
  status: NotificationIncidentStatus;
  openedAt: Date;
  lastSeenAt: Date;
  resolvedAt: Date | null;
  errorCode: string | null;
  errorSummary: string | null;
  notificationCount: number;
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
    clauses.push(eq(platformAccounts.label, input.pageLabel));
  }

  const whereClause = clauses.length > 0 ? and(...clauses) : undefined;
  const limit = input?.limit ?? 50;
  const offset = input?.offset ?? 0;

  const countResult = await db
    .select({ total: count() })
    .from(notificationIncidents)
    .innerJoin(platformAccounts, eq(notificationIncidents.platformAccountId, platformAccounts.id))
    .where(whereClause);

  const rows = await db
    .select({
      id: notificationIncidents.id,
      incidentKey: notificationIncidents.incidentKey,
      kind: notificationIncidents.kind,
      pageLabel: platformAccounts.label,
      platform: platformAccounts.platform,
      stream: notificationIncidents.stream,
      status: notificationIncidents.status,
      openedAt: notificationIncidents.openedAt,
      lastSeenAt: notificationIncidents.lastSeenAt,
      resolvedAt: notificationIncidents.resolvedAt,
      errorCode: notificationIncidents.errorCode,
      errorSummary: notificationIncidents.errorSummary,
      notificationCount: sql<number>`(select count(*)::int from ${telegramDeliveryAttempts} where ${telegramDeliveryAttempts.notificationIncidentId} = ${notificationIncidents.id})`,
    })
    .from(notificationIncidents)
    .innerJoin(platformAccounts, eq(notificationIncidents.platformAccountId, platformAccounts.id))
    .where(whereClause)
    .orderBy(desc(notificationIncidents.openedAt))
    .limit(limit)
    .offset(offset);

  return {
    items: rows as NotificationIncidentWithPage[],
    total: countResult[0]?.total ?? 0,
  };
}

export async function openNotificationIncident(
  db: Database,
  input: {
    incidentKey: string;
    kind: NotificationIncidentKind;
    platformAccountId: number;
    stream?: NotificationIncidentRow["stream"] | null;
    errorCode?: string | null;
    errorSummary?: string | null;
    metadata?: Record<string, unknown>;
    now?: Date;
  },
): Promise<{
  incident: NotificationIncidentRow;
  transition: NotificationIncidentTransition;
}> {
  const now = input.now ?? new Date();
  const values = {
    incidentKey: input.incidentKey,
    kind: input.kind,
    platformAccountId: input.platformAccountId,
    stream: input.stream ?? null,
    status: "open" as const,
    openedAt: now,
    lastSeenAt: now,
    resolvedAt: null,
    errorCode: input.errorCode ?? null,
    errorSummary: input.errorSummary ?? null,
    metadata: input.metadata ?? {},
    updatedAt: now,
  };

  const [inserted] = await db.insert(notificationIncidents)
    .values(values)
    .onConflictDoNothing()
    .returning();

  if (inserted) {
    return {
      incident: inserted,
      transition: "opened",
    };
  }

  const [reopened] = await db.update(notificationIncidents)
    .set(values)
    .where(and(
      eq(notificationIncidents.incidentKey, input.incidentKey),
      eq(notificationIncidents.status, "resolved"),
    ))
    .returning();

  if (reopened) {
    return {
      incident: reopened,
      transition: "reopened",
    };
  }

  const [existing] = await db.update(notificationIncidents)
    .set({
      lastSeenAt: now,
      errorCode: input.errorCode ?? null,
      errorSummary: input.errorSummary ?? null,
      metadata: input.metadata ?? {},
      updatedAt: now,
    })
    .where(and(
      eq(notificationIncidents.incidentKey, input.incidentKey),
      eq(notificationIncidents.status, "open"),
    ))
    .returning();

  if (!existing) {
    throw new Error(`Notification incident "${input.incidentKey}" could not be opened`);
  }

  return {
    incident: existing,
    transition: "existing",
  };
}

export async function resolveNotificationIncident(
  db: Database,
  input: {
    incidentKey: string;
    metadata?: Record<string, unknown>;
    now?: Date;
  },
): Promise<NotificationIncidentRow | null> {
  const now = input.now ?? new Date();
  const [resolved] = await db.update(notificationIncidents)
    .set({
      status: "resolved",
      resolvedAt: now,
      lastSeenAt: now,
      metadata: input.metadata ?? {},
      updatedAt: now,
    })
    .where(and(
      eq(notificationIncidents.incidentKey, input.incidentKey),
      eq(notificationIncidents.status, "open"),
    ))
    .returning();

  return resolved ?? null;
}
