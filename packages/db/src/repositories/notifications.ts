import { and, count, desc, eq, sql } from "drizzle-orm";

import type { Database } from "../client.ts";
import { notificationIncidents, pages, telegramDeliveryAttempts } from "../schema.ts";

export type NotificationIncidentKind = "auth_blocked" | "proxy_failed" | "stream_failed_threshold";
export type NotificationIncidentStatus = "open" | "resolved";
export type NotificationIncidentRow = typeof notificationIncidents.$inferSelect;
export type NotificationIncidentTransition = "opened" | "reopened" | "existing";
const MAX_OPEN_INCIDENT_ATTEMPTS = 3;

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
    clauses.push(eq(pages.label, input.pageLabel));
  }

  const whereClause = clauses.length > 0 ? and(...clauses) : undefined;
  const limit = input?.limit ?? 50;
  const offset = input?.offset ?? 0;

  const countResult = await db
    .select({ total: count() })
    .from(notificationIncidents)
    .innerJoin(pages, eq(notificationIncidents.platformAccountId, pages.id))
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
    })
    .from(notificationIncidents)
    .innerJoin(pages, eq(notificationIncidents.platformAccountId, pages.id))
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
  const existingUpdate = {
    lastSeenAt: now,
    errorCode: input.errorCode ?? null,
    errorSummary: input.errorSummary ?? null,
    metadata: input.metadata ?? {},
    updatedAt: now,
  };

  for (let attempt = 0; attempt < MAX_OPEN_INCIDENT_ATTEMPTS; attempt += 1) {
    try {
      return await db.transaction(async (tx) => {
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

          return {
            incident: inserted,
            transition: "opened" as const,
          };
        }

        if (locked.status === "resolved") {
          const lockedId = Number(locked.id);
          if (isAfter(locked.resolvedAt, now)) {
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

          return {
            incident: reopened,
            transition: "reopened" as const,
          };
        }

        const lockedId = Number(locked.id);
        if (isAfter(locked.lastSeenAt, now)) {
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
