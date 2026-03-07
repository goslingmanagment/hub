import { and, eq, lt, sql } from "drizzle-orm";

import type { Database } from "../client.ts";
import { platformAccounts, rawPayloads, syncCheckpoints, syncRuns } from "../schema.ts";

export async function startSyncRun(
  db: Database,
  input: {
    platformAccountId: number;
    stream: "light" | "followers" | "transactions" | "subscribers" | "cleanup";
    trigger: string;
  },
) {
  const [run] = await db
    .insert(syncRuns)
    .values({
      platformAccountId: input.platformAccountId,
      stream: input.stream,
      trigger: input.trigger,
      status: "running",
    })
    .returning();

  return run;
}

export async function finishSyncRun(
  db: Database,
  runId: number,
  input: {
    status: "success" | "partial" | "failed";
    stats?: Record<string, unknown>;
    errorSummary?: string | null;
  },
) {
  const [run] = await db
    .update(syncRuns)
    .set({
      status: input.status,
      stats: input.stats ?? {},
      errorSummary: input.errorSummary ?? null,
      finishedAt: new Date(),
    })
    .where(eq(syncRuns.id, runId))
    .returning();
  return run;
}

export async function getCheckpoint(
  db: Database,
  platformAccountId: number,
  stream: "light" | "followers" | "transactions" | "subscribers" | "cleanup",
) {
  return (await db.query.syncCheckpoints.findFirst({
    where: and(
      eq(syncCheckpoints.platformAccountId, platformAccountId),
      eq(syncCheckpoints.stream, stream),
    ),
  })) ?? null;
}

export async function upsertCheckpoint(
  db: Database,
  input: {
    platformAccountId: number;
    stream: "light" | "followers" | "transactions" | "subscribers" | "cleanup";
    cursorText?: string | null;
    cursorTimestamp?: Date | null;
    state?: Record<string, unknown>;
    lastSuccessfulRunId?: number | null;
  },
) {
  const [checkpoint] = await db
    .insert(syncCheckpoints)
    .values({
      platformAccountId: input.platformAccountId,
      stream: input.stream,
      cursorText: input.cursorText ?? null,
      cursorTimestamp: input.cursorTimestamp ?? null,
      state: input.state ?? {},
      lastSuccessfulRunId: input.lastSuccessfulRunId ?? null,
      lastSuccessfulAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [syncCheckpoints.platformAccountId, syncCheckpoints.stream],
      set: {
        cursorText: input.cursorText ?? null,
        cursorTimestamp: input.cursorTimestamp ?? null,
        state: input.state ?? {},
        lastSuccessfulRunId: input.lastSuccessfulRunId ?? null,
        lastSuccessfulAt: new Date(),
        updatedAt: new Date(),
      },
    })
    .returning();
  return checkpoint;
}

export async function insertRawPayload(
  db: Database,
  input: {
    platformAccountId: number;
    syncRunId?: number | null;
    endpoint: string;
    requestParams: Record<string, unknown>;
    responsePayload: unknown;
    mapperVersion: string;
    payloadKind: "mapping_critical" | "failed";
    statusCode?: number | null;
    errorMessage?: string | null;
    retainUntil: Date;
  },
) {
  const [created] = await db
    .insert(rawPayloads)
    .values({
      platformAccountId: input.platformAccountId,
      syncRunId: input.syncRunId ?? null,
      endpoint: input.endpoint,
      requestParams: input.requestParams,
      responsePayload: input.responsePayload,
      mapperVersion: input.mapperVersion,
      payloadKind: input.payloadKind,
      statusCode: input.statusCode ?? null,
      errorMessage: input.errorMessage ?? null,
      retainUntil: input.retainUntil,
    })
    .returning();
  return created;
}

export async function deleteExpiredRawPayloads(db: Database, now = new Date()) {
  return db.delete(rawPayloads).where(lt(rawPayloads.retainUntil, now));
}

export async function listRecentSyncRuns(
  db: Database,
  input?: {
    limit?: number;
    platformAccountId?: number;
  },
) {
  const clauses = [
    sql`true`,
  ];

  if (input?.platformAccountId !== undefined) {
    clauses.push(sql`${syncRuns.platformAccountId} = ${input.platformAccountId}`);
  }

  return db
    .select({
      runId: syncRuns.id,
      pageLabel: platformAccounts.label,
      stream: syncRuns.stream,
      trigger: syncRuns.trigger,
      status: syncRuns.status,
      startedAt: syncRuns.startedAt,
      finishedAt: syncRuns.finishedAt,
      errorSummary: syncRuns.errorSummary,
    })
    .from(syncRuns)
    .innerJoin(platformAccounts, eq(platformAccounts.id, syncRuns.platformAccountId))
    .where(and(...clauses))
    .orderBy(sql`${syncRuns.startedAt} desc`, sql`${syncRuns.id} desc`)
    .limit(input?.limit ?? 20);
}
