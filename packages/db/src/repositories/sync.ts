import { and, eq, lt, sql } from "drizzle-orm";

import type { Database } from "../client.ts";
import {
  platformAccounts,
  rawPayloads,
  syncCheckpoints,
  syncRequestAttempts,
  syncRunEvents,
  syncRuns,
} from "../schema.ts";

type TimestampValue = Date | string | null | undefined;

function parseTimestamp(value: TimestampValue, field: string) {
  if (value === null || value === undefined) {
    return null;
  }

  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Expected ${field} to be a valid timestamp`);
  }

  return parsed;
}

function requireTimestamp(value: Date | string, field: string) {
  const parsed = parseTimestamp(value, field);
  if (!parsed) {
    throw new Error(`Expected ${field} to be present`);
  }
  return parsed;
}

function normalizeSyncRunRow<T extends {
  startedAt: Date | string;
  finishedAt: TimestampValue;
}>(row: T): Omit<T, "startedAt" | "finishedAt"> & { startedAt: Date; finishedAt: Date | null } {
  return {
    ...row,
    startedAt: requireTimestamp(row.startedAt, "startedAt"),
    finishedAt: parseTimestamp(row.finishedAt, "finishedAt"),
  };
}

function normalizeRunningSyncRunRow<T extends {
  startedAt: Date | string;
  finishedAt: TimestampValue;
  lastActivityAt: TimestampValue;
}>(
  row: T,
): Omit<T, "startedAt" | "finishedAt" | "lastActivityAt"> & {
  startedAt: Date;
  finishedAt: Date | null;
  lastActivityAt: Date;
} {
  const normalized = parseTimestamp(row.lastActivityAt, "lastActivityAt");
  if (!normalized) {
    throw new Error("Expected lastActivityAt to be present");
  }

  return {
    ...row,
    startedAt: requireTimestamp(row.startedAt, "startedAt"),
    finishedAt: parseTimestamp(row.finishedAt, "finishedAt"),
    lastActivityAt: normalized,
  };
}

function normalizeSyncRunEventRow<T extends {
  emittedAt: Date | string;
}>(row: T): Omit<T, "emittedAt"> & { emittedAt: Date } {
  return {
    ...row,
    emittedAt: requireTimestamp(row.emittedAt, "emittedAt"),
  };
}

function normalizeSyncRequestAttemptRow<T extends {
  startedAt: Date | string;
  finishedAt: TimestampValue;
}>(row: T): Omit<T, "startedAt" | "finishedAt"> & { startedAt: Date; finishedAt: Date | null } {
  return {
    ...row,
    startedAt: requireTimestamp(row.startedAt, "startedAt"),
    finishedAt: parseTimestamp(row.finishedAt, "finishedAt"),
  };
}

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
    status: "success" | "partial" | "failed" | "skipped";
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

export async function insertSyncRequestAttempt(
  db: Database,
  input: {
    syncRunId: number;
    platformAccountId: number;
    provider: "fansly" | "onlyfans";
    stream: "light" | "followers" | "transactions" | "subscribers" | "cleanup";
    operation: string;
    logicalRequestId: string;
    attemptNumber: number;
    requestShape?: Record<string, unknown>;
    startedAt?: Date;
  },
) {
  const [attempt] = await db
    .insert(syncRequestAttempts)
    .values({
      syncRunId: input.syncRunId,
      platformAccountId: input.platformAccountId,
      provider: input.provider,
      stream: input.stream,
      operation: input.operation,
      logicalRequestId: input.logicalRequestId,
      attemptNumber: input.attemptNumber,
      state: "started",
      requestShape: input.requestShape ?? {},
      startedAt: input.startedAt ?? new Date(),
    })
    .returning();

  return attempt;
}

export async function finishSyncRequestAttempt(
  db: Database,
  attemptId: number,
  input: {
    state: "success" | "retry" | "failed";
    failureKind?: "timeout" | "transport" | "http" | "provider" | null;
    httpStatus?: number | null;
    retryDelayMs?: number | null;
    durationMs?: number | null;
    responseShape?: Record<string, unknown>;
    errorMessage?: string | null;
    finishedAt?: Date;
  },
) {
  const [attempt] = await db
    .update(syncRequestAttempts)
    .set({
      state: input.state,
      failureKind: input.failureKind ?? null,
      httpStatus: input.httpStatus ?? null,
      retryDelayMs: input.retryDelayMs ?? null,
      durationMs: input.durationMs ?? null,
      responseShape: input.responseShape ?? {},
      errorMessage: input.errorMessage ?? null,
      finishedAt: input.finishedAt ?? new Date(),
    })
    .where(eq(syncRequestAttempts.id, attemptId))
    .returning();

  return attempt;
}

export async function insertSyncRunEvent(
  db: Database,
  input: {
    syncRunId: number;
    platformAccountId: number;
    provider: "fansly" | "onlyfans";
    stream: "light" | "followers" | "transactions" | "subscribers" | "cleanup";
    eventType: string;
    severity?: "info" | "warn" | "error";
    message: string;
    details?: Record<string, unknown>;
    emittedAt?: Date;
  },
) {
  const [event] = await db
    .insert(syncRunEvents)
    .values({
      syncRunId: input.syncRunId,
      platformAccountId: input.platformAccountId,
      provider: input.provider,
      stream: input.stream,
      eventType: input.eventType,
      severity: input.severity ?? "info",
      message: input.message,
      details: input.details ?? {},
      emittedAt: input.emittedAt ?? new Date(),
    })
    .returning();

  return event;
}

export async function deleteExpiredRawPayloads(db: Database, now = new Date()) {
  return db.delete(rawPayloads).where(lt(rawPayloads.retainUntil, now));
}

export async function deleteExpiredSyncObservability(db: Database, cutoff: Date) {
  const [deletedAttempts, deletedEvents] = await Promise.all([
    db
      .delete(syncRequestAttempts)
      .where(lt(sql`coalesce(${syncRequestAttempts.finishedAt}, ${syncRequestAttempts.startedAt})`, cutoff)),
    db.delete(syncRunEvents).where(lt(syncRunEvents.emittedAt, cutoff)),
  ]);

  return {
    deletedAttempts,
    deletedEvents,
  };
}

export async function listRecentSyncRuns(
  db: Database,
  input?: {
    limit?: number;
    platformAccountId?: number;
    since?: Date;
  },
) {
  const clauses = [sql`true`];

  if (input?.platformAccountId !== undefined) {
    clauses.push(sql`sr.platform_account_id = ${input.platformAccountId}`);
  }

  if (input?.since) {
    clauses.push(sql`sr.started_at >= ${input.since}`);
  }

  const result = await db.execute<{
    runId: number;
    platformAccountId: number;
    pageLabel: string;
    platform: "fansly" | "onlyfans";
    stream: "light" | "followers" | "transactions" | "subscribers" | "cleanup";
    trigger: string;
    status: "running" | "success" | "partial" | "failed" | "skipped";
    startedAt: Date;
    finishedAt: Date | null;
    errorSummary: string | null;
    stats: Record<string, unknown>;
  }>(sql`
    select sr.id as "runId",
           sr.platform_account_id as "platformAccountId",
           pa.label as "pageLabel",
           pa.platform as "platform",
           sr.stream as "stream",
           sr.trigger as "trigger",
           sr.status as "status",
           sr.started_at as "startedAt",
           sr.finished_at as "finishedAt",
           sr.error_summary as "errorSummary",
           sr.stats as "stats"
    from sync_runs sr
    inner join platform_accounts pa on pa.id = sr.platform_account_id
    where ${and(...clauses)}
    order by sr.started_at desc, sr.id desc
    limit ${input?.limit ?? 20}
  `);

  return result.rows.map((row) => normalizeSyncRunRow(row));
}

export async function getSyncRun(db: Database, runId: number) {
  const result = await db.execute<{
    runId: number;
    platformAccountId: number;
    pageLabel: string;
    platform: "fansly" | "onlyfans";
    stream: "light" | "followers" | "transactions" | "subscribers" | "cleanup";
    trigger: string;
    status: "running" | "success" | "partial" | "failed" | "skipped";
    startedAt: Date;
    finishedAt: Date | null;
    errorSummary: string | null;
    stats: Record<string, unknown>;
  }>(sql`
    select sr.id as "runId",
           sr.platform_account_id as "platformAccountId",
           pa.label as "pageLabel",
           pa.platform as "platform",
           sr.stream as "stream",
           sr.trigger as "trigger",
           sr.status as "status",
           sr.started_at as "startedAt",
           sr.finished_at as "finishedAt",
           sr.error_summary as "errorSummary",
           sr.stats as "stats"
    from sync_runs sr
    inner join platform_accounts pa on pa.id = sr.platform_account_id
    where sr.id = ${runId}
    limit 1
  `);

  return result.rows[0] ? normalizeSyncRunRow(result.rows[0]) : null;
}

export async function listSyncRunEvents(
  db: Database,
  input: {
    runId?: number;
    afterId?: number;
    since?: Date;
    platformAccountId?: number;
    limit?: number;
  },
) {
  const clauses = [sql`true`];

  if (input.runId !== undefined) {
    clauses.push(sql`e.sync_run_id = ${input.runId}`);
  }

  if (input.afterId !== undefined) {
    clauses.push(sql`e.id > ${input.afterId}`);
  }

  if (input.since) {
    clauses.push(sql`e.emitted_at >= ${input.since}`);
  }

  if (input.platformAccountId !== undefined) {
    clauses.push(sql`e.platform_account_id = ${input.platformAccountId}`);
  }

  const result = await db.execute<{
    id: number;
    runId: number;
    platformAccountId: number;
    pageLabel: string;
    provider: "fansly" | "onlyfans";
    stream: "light" | "followers" | "transactions" | "subscribers" | "cleanup";
    eventType: string;
    severity: "info" | "warn" | "error";
    message: string;
    details: Record<string, unknown>;
    emittedAt: Date;
  }>(sql`
    select e.id as "id",
           e.sync_run_id as "runId",
           e.platform_account_id as "platformAccountId",
           pa.label as "pageLabel",
           e.provider as "provider",
           e.stream as "stream",
           e.event_type as "eventType",
           e.severity as "severity",
           e.message as "message",
           e.details as "details",
           e.emitted_at as "emittedAt"
    from sync_run_events e
    inner join platform_accounts pa on pa.id = e.platform_account_id
    where ${and(...clauses)}
    order by e.id asc
    limit ${input.limit ?? 200}
  `);

  return result.rows.map((row) => normalizeSyncRunEventRow(row));
}

export async function listSyncRequestAttempts(
  db: Database,
  input: {
    runId?: number;
    platformAccountId?: number;
    inFlightOnly?: boolean;
    limit?: number;
  },
) {
  const clauses = [sql`true`];

  if (input.runId !== undefined) {
    clauses.push(sql`a.sync_run_id = ${input.runId}`);
  }

  if (input.platformAccountId !== undefined) {
    clauses.push(sql`a.platform_account_id = ${input.platformAccountId}`);
  }

  if (input.inFlightOnly) {
    clauses.push(sql`a.finished_at is null`);
  }

  const result = await db.execute<{
    attemptId: number;
    runId: number;
    platformAccountId: number;
    pageLabel: string;
    provider: "fansly" | "onlyfans";
    stream: "light" | "followers" | "transactions" | "subscribers" | "cleanup";
    operation: string;
    logicalRequestId: string;
    attemptNumber: number;
    state: "started" | "success" | "retry" | "failed";
    failureKind: "timeout" | "transport" | "http" | "provider" | null;
    httpStatus: number | null;
    retryDelayMs: number | null;
    durationMs: number | null;
    requestShape: Record<string, unknown>;
    responseShape: Record<string, unknown>;
    errorMessage: string | null;
    startedAt: Date;
    finishedAt: Date | null;
  }>(sql`
    select a.id as "attemptId",
           a.sync_run_id as "runId",
           a.platform_account_id as "platformAccountId",
           pa.label as "pageLabel",
           a.provider as "provider",
           a.stream as "stream",
           a.operation as "operation",
           a.logical_request_id as "logicalRequestId",
           a.attempt_number as "attemptNumber",
           a.state as "state",
           a.failure_kind as "failureKind",
           a.http_status as "httpStatus",
           a.retry_delay_ms as "retryDelayMs",
           a.duration_ms as "durationMs",
           a.request_shape as "requestShape",
           a.response_shape as "responseShape",
           a.error_message as "errorMessage",
           a.started_at as "startedAt",
           a.finished_at as "finishedAt"
    from sync_request_attempts a
    inner join platform_accounts pa on pa.id = a.platform_account_id
    where ${and(...clauses)}
    order by a.started_at asc, a.id asc
    limit ${input.limit ?? 1000}
  `);

  return result.rows.map((row) => normalizeSyncRequestAttemptRow(row));
}

export async function listRunningSyncRuns(
  db: Database,
  input?: {
    platformAccountId?: number;
    limit?: number;
  },
) {
  const clauses = [sql`sr.status = 'running'`];

  if (input?.platformAccountId !== undefined) {
    clauses.push(sql`sr.platform_account_id = ${input.platformAccountId}`);
  }

  const result = await db.execute<{
    runId: number;
    platformAccountId: number;
    pageLabel: string;
    platform: "fansly" | "onlyfans";
    stream: "light" | "followers" | "transactions" | "subscribers" | "cleanup";
    trigger: string;
    status: "running";
    startedAt: Date;
    finishedAt: Date | null;
    errorSummary: string | null;
    stats: Record<string, unknown>;
    lastActivityAt: Date;
  }>(sql`
    with request_activity as (
      select sync_run_id,
             max(coalesce(finished_at, started_at)) as last_attempt_at
      from sync_request_attempts
      group by sync_run_id
    ),
    event_activity as (
      select sync_run_id,
             max(emitted_at) as last_event_at
      from sync_run_events
      group by sync_run_id
    )
    select sr.id as "runId",
           sr.platform_account_id as "platformAccountId",
           pa.label as "pageLabel",
           pa.platform as "platform",
           sr.stream as "stream",
           sr.trigger as "trigger",
           sr.status as "status",
           sr.started_at as "startedAt",
           sr.finished_at as "finishedAt",
           sr.error_summary as "errorSummary",
           sr.stats as "stats",
           greatest(
             sr.started_at,
             coalesce(ra.last_attempt_at, sr.started_at),
             coalesce(ea.last_event_at, sr.started_at)
           ) as "lastActivityAt"
    from sync_runs sr
    inner join platform_accounts pa on pa.id = sr.platform_account_id
    left join request_activity ra on ra.sync_run_id = sr.id
    left join event_activity ea on ea.sync_run_id = sr.id
    where ${and(...clauses)}
    order by sr.started_at asc, sr.id asc
    limit ${input?.limit ?? 20}
  `);

  return result.rows.map((row) => normalizeRunningSyncRunRow(row));
}
