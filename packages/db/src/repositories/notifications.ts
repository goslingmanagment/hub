import { and, eq } from "drizzle-orm";

import type { Database } from "../client.ts";
import { notificationIncidents } from "../schema.ts";

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
