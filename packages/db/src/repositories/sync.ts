import { and, eq, inArray, lt, sql } from "drizzle-orm";

import type { Database } from "../client.ts";
import {
  platformAccounts,
  platformAccountProxies,
  rawPayloads,
  syncCheckpoints,
  syncProviderRateLimits,
  syncRequestAttempts,
  syncStreamState,
  syncRunEvents,
  syncRuns,
} from "../schema.ts";

export const SYNC_CONTROL_STREAMS = [
  "light",
  "transactions",
  "subscribers",
  "dm_conversations",
  "dm_messages",
  "followers",
  "followers_reconcile",
] as const;

export type SyncControlStream = typeof SYNC_CONTROL_STREAMS[number];
export type SyncAuditStream = SyncControlStream | "cleanup";
export type SyncTargetStatus = "active" | "paused" | "auth_failed" | "disabled";
export type SyncRequestReason = "scheduled" | "manual" | "onboarding" | "recovery" | "anomaly";

export interface SyncStreamConfig {
  stream: SyncControlStream;
  cadenceSeconds: number;
  basePriority: number;
  streamIndex: number;
}

export const SYNC_STREAM_CONFIG: Record<SyncControlStream, SyncStreamConfig> = {
  light: { stream: "light", cadenceSeconds: 3600, basePriority: 60, streamIndex: 1 },
  transactions: { stream: "transactions", cadenceSeconds: 3600, basePriority: 50, streamIndex: 2 },
  subscribers: { stream: "subscribers", cadenceSeconds: 3600, basePriority: 40, streamIndex: 3 },
  dm_conversations: {
    stream: "dm_conversations",
    cadenceSeconds: 1800,
    basePriority: 30,
    streamIndex: 4,
  },
  dm_messages: { stream: "dm_messages", cadenceSeconds: 7200, basePriority: 25, streamIndex: 5 },
  followers: { stream: "followers", cadenceSeconds: 43200, basePriority: 20, streamIndex: 6 },
  followers_reconcile: {
    stream: "followers_reconcile",
    cadenceSeconds: 172800,
    basePriority: 10,
    streamIndex: 7,
  },
};

const SYNC_STREAM_TIE_BREAK_ORDER: Record<SyncControlStream, number> = {
  light: 1,
  transactions: 2,
  subscribers: 3,
  dm_conversations: 4,
  dm_messages: 5,
  followers: 6,
  followers_reconcile: 7,
};

function asSyncAuditStream(stream: string): SyncAuditStream {
  if (stream === "cleanup") {
    return "cleanup";
  }

  if (stream in SYNC_STREAM_CONFIG) {
    return stream as SyncControlStream;
  }

  throw new Error(`Unsupported sync stream "${stream}"`);
}

type TimestampValue = Date | string | null | undefined;
type NumericValue = number | bigint | null | undefined;

function normalizeNumber(value: NumericValue, field: string) {
  if (value === null || value === undefined) {
    throw new Error(`Expected ${field} to be present`);
  }

  if (typeof value === "bigint") {
    return Number(value);
  }

  if (typeof value === "number") {
    return value;
  }

  throw new Error(`Expected ${field} to be a number`);
}

function parseTimestamp(value: TimestampValue, field: string) {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "-infinity") {
      return new Date(0);
    }
    if (normalized === "infinity") {
      return new Date(8_640_000_000_000_000);
    }
    if (normalized.includes("bc")) {
      return new Date(0);
    }
  }

  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    if (field === "backoffUntil") {
      return new Date(0);
    }
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
  runId: NumericValue;
  platformAccountId: NumericValue;
  startedAt: Date | string;
  finishedAt: TimestampValue;
}>(row: T): Omit<T, "startedAt" | "finishedAt"> & { startedAt: Date; finishedAt: Date | null } {
  return {
    ...row,
    runId: normalizeNumber(row.runId, "runId"),
    platformAccountId: normalizeNumber(row.platformAccountId, "platformAccountId"),
    startedAt: requireTimestamp(row.startedAt, "startedAt"),
    finishedAt: parseTimestamp(row.finishedAt, "finishedAt"),
  };
}

function normalizeRunningSyncRunRow<T extends {
  runId: NumericValue;
  platformAccountId: NumericValue;
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
    runId: normalizeNumber(row.runId, "runId"),
    platformAccountId: normalizeNumber(row.platformAccountId, "platformAccountId"),
    startedAt: requireTimestamp(row.startedAt, "startedAt"),
    finishedAt: parseTimestamp(row.finishedAt, "finishedAt"),
    lastActivityAt: normalized,
  };
}

function normalizeSyncRunEventRow<T extends {
  id: NumericValue;
  runId: NumericValue;
  platformAccountId: NumericValue;
  emittedAt: Date | string;
}>(row: T): Omit<T, "emittedAt"> & { emittedAt: Date } {
  return {
    ...row,
    id: normalizeNumber(row.id, "id"),
    runId: normalizeNumber(row.runId, "runId"),
    platformAccountId: normalizeNumber(row.platformAccountId, "platformAccountId"),
    emittedAt: requireTimestamp(row.emittedAt, "emittedAt"),
  };
}

function normalizeSyncRequestAttemptRow<T extends {
  attemptId: NumericValue;
  runId: NumericValue;
  platformAccountId: NumericValue;
  startedAt: Date | string;
  finishedAt: TimestampValue;
}>(row: T): Omit<T, "startedAt" | "finishedAt"> & { startedAt: Date; finishedAt: Date | null } {
  return {
    ...row,
    attemptId: normalizeNumber(row.attemptId, "attemptId"),
    runId: normalizeNumber(row.runId, "runId"),
    platformAccountId: normalizeNumber(row.platformAccountId, "platformAccountId"),
    startedAt: requireTimestamp(row.startedAt, "startedAt"),
    finishedAt: parseTimestamp(row.finishedAt, "finishedAt"),
  };
}

function normalizeNullableJsonRecord(value: unknown, field: string) {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Expected ${field} to be an object or null`);
  }

  return value as Record<string, unknown>;
}

function normalizeSyncStreamStateRow<T extends {
  platformAccountId: NumericValue;
  stream: string;
  status: string;
  cadenceSeconds: NumericValue;
  slotOffsetSeconds: NumericValue;
  nextDueAt: Date | string;
  basePriority: NumericValue;
  effectivePriority: NumericValue;
  pendingReason: string;
  desiredRevision: NumericValue;
  satisfiedRevision: NumericValue;
  desiredAt: TimestampValue;
  requestPayload: unknown;
  backoffUntil: Date | string;
  lastEnqueuedAt: TimestampValue;
  lastStartedAt: TimestampValue;
  lastFinishedAt: TimestampValue;
  lastSucceededAt: TimestampValue;
  lastFailedAt: TimestampValue;
  consecutiveFailures: NumericValue;
  lastErrorCode: string | null;
  lastErrorSummary: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}>(row: T) {
  const stream = asSyncAuditStream(row.stream);
  if (stream === "cleanup") {
    throw new Error("sync_stream_state cannot contain cleanup rows");
  }

  return {
    ...row,
    platformAccountId: normalizeNumber(row.platformAccountId, "platformAccountId"),
    stream,
    status: row.status as SyncTargetStatus,
    cadenceSeconds: normalizeNumber(row.cadenceSeconds, "cadenceSeconds"),
    slotOffsetSeconds: normalizeNumber(row.slotOffsetSeconds, "slotOffsetSeconds"),
    nextDueAt: requireTimestamp(row.nextDueAt, "nextDueAt"),
    basePriority: normalizeNumber(row.basePriority, "basePriority"),
    effectivePriority: normalizeNumber(row.effectivePriority, "effectivePriority"),
    pendingReason: row.pendingReason as SyncRequestReason,
    desiredRevision: normalizeNumber(row.desiredRevision, "desiredRevision"),
    satisfiedRevision: normalizeNumber(row.satisfiedRevision, "satisfiedRevision"),
    desiredAt: parseTimestamp(row.desiredAt, "desiredAt"),
    requestPayload: normalizeNullableJsonRecord(row.requestPayload, "requestPayload"),
    backoffUntil: requireTimestamp(row.backoffUntil, "backoffUntil"),
    lastEnqueuedAt: parseTimestamp(row.lastEnqueuedAt, "lastEnqueuedAt"),
    lastStartedAt: parseTimestamp(row.lastStartedAt, "lastStartedAt"),
    lastFinishedAt: parseTimestamp(row.lastFinishedAt, "lastFinishedAt"),
    lastSucceededAt: parseTimestamp(row.lastSucceededAt, "lastSucceededAt"),
    lastFailedAt: parseTimestamp(row.lastFailedAt, "lastFailedAt"),
    consecutiveFailures: normalizeNumber(row.consecutiveFailures, "consecutiveFailures"),
    createdAt: requireTimestamp(row.createdAt, "createdAt"),
    updatedAt: requireTimestamp(row.updatedAt, "updatedAt"),
  };
}

export interface SyncStreamStateRow {
  platformAccountId: number;
  stream: SyncControlStream;
  status: SyncTargetStatus;
  cadenceSeconds: number;
  slotOffsetSeconds: number;
  nextDueAt: Date;
  basePriority: number;
  effectivePriority: number;
  pendingReason: SyncRequestReason;
  desiredRevision: number;
  satisfiedRevision: number;
  desiredAt: Date | null;
  requestPayload: Record<string, unknown> | null;
  backoffUntil: Date;
  lastEnqueuedAt: Date | null;
  lastStartedAt: Date | null;
  lastFinishedAt: Date | null;
  lastSucceededAt: Date | null;
  lastFailedAt: Date | null;
  consecutiveFailures: number;
  lastErrorCode: string | null;
  lastErrorSummary: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export function getSyncStreamsForPlatform(platform: "fansly" | "onlyfans"): SyncControlStream[] {
  return platform === "fansly"
    ? [...SYNC_CONTROL_STREAMS]
    : ["light", "transactions"];
}

export function computeSyncStreamSlotOffsetSeconds(
  platformAccountId: number,
  stream: SyncControlStream,
) {
  const config = SYNC_STREAM_CONFIG[stream];
  return Number(
    ((BigInt(platformAccountId) * 2654435761n) + (BigInt(config.streamIndex) * 2246822519n)) %
      BigInt(config.cadenceSeconds),
  );
}

export function computeSyncStreamNextDueAt(
  now: Date,
  cadenceSeconds: number,
  slotOffsetSeconds: number,
) {
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const slot = Math.floor((nowSeconds - slotOffsetSeconds) / cadenceSeconds) + 1;
  return new Date((slot * cadenceSeconds + slotOffsetSeconds) * 1000);
}

export function resolveSyncRequestPriority(
  stream: SyncControlStream,
  reason: SyncRequestReason,
) {
  const basePriority = SYNC_STREAM_CONFIG[stream].basePriority;
  switch (reason) {
    case "manual":
      return 90;
    case "onboarding":
      return 100;
    case "anomaly":
    case "recovery":
      return Math.max(basePriority, 45);
    case "scheduled":
    default:
      return basePriority;
  }
}

function resolveBackoffDelaySeconds(consecutiveFailures: number) {
  const seconds = 60 * (2 ** Math.max(0, consecutiveFailures - 1));
  return Math.min(seconds, 30 * 60);
}

export async function startSyncRun(
  db: Database,
  input: {
    platformAccountId: number;
    stream: SyncAuditStream;
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
  stream: SyncAuditStream,
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
    stream: SyncAuditStream;
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

export async function upsertCheckpointProgress(
  db: Database,
  input: {
    platformAccountId: number;
    stream: SyncAuditStream;
    cursorText?: string | null;
    cursorTimestamp?: Date | null;
    state?: Record<string, unknown>;
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
    })
    .onConflictDoUpdate({
      target: [syncCheckpoints.platformAccountId, syncCheckpoints.stream],
      set: {
        cursorText: input.cursorText ?? null,
        cursorTimestamp: input.cursorTimestamp ?? null,
        state: input.state ?? {},
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
    payloadKind: "mapping_critical" | "dm_metadata" | "failed";
    statusCode?: number | null;
    errorMessage?: string | null;
    retainUntil: Date;
  },
) {
  await db
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
    });
}

export async function insertSyncRequestAttempt(
  db: Database,
  input: {
    syncRunId: number;
    platformAccountId: number;
    provider: "fansly" | "onlyfans";
    stream: SyncAuditStream;
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
    stream: SyncAuditStream;
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
    stream: SyncAuditStream;
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
    stream: SyncAuditStream;
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
    stream: SyncAuditStream;
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
    stream: SyncAuditStream;
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
    stream: SyncAuditStream;
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

export async function getLatestSyncRunPerPage(
  db: Database,
  pageIds: number[],
  input?: {
    stream?: SyncAuditStream;
  },
) {
  if (pageIds.length === 0) {
    return [];
  }

  const clauses = [inArray(syncRuns.platformAccountId, pageIds)];
  if (input?.stream) {
    clauses.push(eq(syncRuns.stream, input.stream));
  }

  const result = await db.execute<{
    platformAccountId: number;
    runId: number;
    stream: SyncAuditStream;
    status: "running" | "success" | "partial" | "failed" | "skipped";
    startedAt: Date;
    finishedAt: Date | null;
    errorSummary: string | null;
  }>(sql`
    select distinct on (${syncRuns.platformAccountId})
           ${syncRuns.platformAccountId} as "platformAccountId",
           ${syncRuns.id} as "runId",
           ${syncRuns.stream} as "stream",
           ${syncRuns.status} as "status",
           ${syncRuns.startedAt} as "startedAt",
           ${syncRuns.finishedAt} as "finishedAt",
           ${syncRuns.errorSummary} as "errorSummary"
    from ${syncRuns}
    where ${and(...clauses)}
    order by ${syncRuns.platformAccountId}, ${syncRuns.startedAt} desc, ${syncRuns.id} desc
  `);

  return result.rows;
}

type SeedSyncStreamPageRow = {
  platformAccountId: NumericValue;
  platform: "fansly" | "onlyfans";
  lastLightSyncAt: TimestampValue;
  lastFollowerSyncAt: TimestampValue;
  followerCount: NumericValue;
  activeFollowerCount: NumericValue;
};

type NormalizedSeedSyncStreamPageRow = Omit<
  SeedSyncStreamPageRow,
  "platformAccountId" | "lastLightSyncAt" | "lastFollowerSyncAt" | "followerCount" | "activeFollowerCount"
> & {
  platformAccountId: number;
  lastLightSyncAt: Date | null;
  lastFollowerSyncAt: Date | null;
  followerCount: number;
  activeFollowerCount: number;
};

export type SyncPageWakeupRow = {
  platformAccountId: number;
  platform: "fansly" | "onlyfans";
  priority: number;
  desiredAt: Date | null;
  proxyUrl: string | null;
};

function streamOrderSql(columnName: string) {
  return sql.raw(`
    case ${columnName}
      when 'light' then ${SYNC_STREAM_TIE_BREAK_ORDER.light}
      when 'transactions' then ${SYNC_STREAM_TIE_BREAK_ORDER.transactions}
      when 'subscribers' then ${SYNC_STREAM_TIE_BREAK_ORDER.subscribers}
      when 'dm_conversations' then ${SYNC_STREAM_TIE_BREAK_ORDER.dm_conversations}
      when 'dm_messages' then ${SYNC_STREAM_TIE_BREAK_ORDER.dm_messages}
      when 'followers' then ${SYNC_STREAM_TIE_BREAK_ORDER.followers}
      when 'followers_reconcile' then ${SYNC_STREAM_TIE_BREAK_ORDER.followers_reconcile}
      else 999
    end
  `);
}

function normalizeSyncStreamStateRows(rows: unknown[]) {
  return rows.map((row) => normalizeSyncStreamStateRow(row as any));
}

function normalizePlatformValue(value: unknown, field: string) {
  if (value === "fansly" || value === "onlyfans") {
    return value;
  }

  throw new Error(`Expected ${field} to be a supported platform`);
}

function normalizeSeedSyncStreamPageRow<T extends SeedSyncStreamPageRow>(row: T): Omit<T, "platformAccountId" | "lastLightSyncAt" | "lastFollowerSyncAt" | "followerCount" | "activeFollowerCount"> & {
  platformAccountId: number;
  lastLightSyncAt: Date | null;
  lastFollowerSyncAt: Date | null;
  followerCount: number;
  activeFollowerCount: number;
} {
  return {
    ...row,
    platformAccountId: normalizeNumber(row.platformAccountId, "platformAccountId"),
    lastLightSyncAt: parseTimestamp(row.lastLightSyncAt, "lastLightSyncAt"),
    lastFollowerSyncAt: parseTimestamp(row.lastFollowerSyncAt, "lastFollowerSyncAt"),
    followerCount: normalizeNumber(row.followerCount, "followerCount"),
    activeFollowerCount: normalizeNumber(row.activeFollowerCount, "activeFollowerCount"),
  };
}

function buildSeedSyncStreamStateValue(
  page: NormalizedSeedSyncStreamPageRow,
  stream: SyncControlStream,
  now: Date,
  onboarding: boolean,
) {
  const config = SYNC_STREAM_CONFIG[stream];
  const slotOffsetSeconds = computeSyncStreamSlotOffsetSeconds(page.platformAccountId, stream);
  const nextDueAt = computeSyncStreamNextDueAt(now, config.cadenceSeconds, slotOffsetSeconds);
  const trustedLightAt = page.lastLightSyncAt;
  const trustedFollowerAt = page.lastFollowerSyncAt;
  const trustedAt = stream === "light" || stream === "transactions" || stream === "subscribers"
    ? trustedLightAt
    : stream === "followers" || stream === "followers_reconcile"
      ? trustedFollowerAt
      : null;
  const followersReconcileNeedsRecovery = page.platform === "fansly" && (
    page.lastFollowerSyncAt === null ||
    (now.getTime() - page.lastFollowerSyncAt.getTime()) > SYNC_STREAM_CONFIG.followers_reconcile.cadenceSeconds * 1000 ||
    page.followerCount !== page.activeFollowerCount
  );
  const shouldRecover = onboarding
    ? stream !== "followers_reconcile"
    : stream === "followers_reconcile"
      ? followersReconcileNeedsRecovery
      : trustedAt === null;
  const pendingReason: SyncRequestReason = shouldRecover
    ? (onboarding ? "onboarding" : "recovery")
    : "scheduled";
  const effectivePriority = shouldRecover
    ? resolveSyncRequestPriority(stream, pendingReason)
    : config.basePriority;
  const lastSucceededAt = shouldRecover ? null : trustedAt;

  return {
    platformAccountId: page.platformAccountId,
    stream,
    status: "active" as const,
    cadenceSeconds: config.cadenceSeconds,
    slotOffsetSeconds,
    nextDueAt,
    basePriority: config.basePriority,
    effectivePriority,
    pendingReason,
    desiredRevision: shouldRecover ? 1 : 0,
    satisfiedRevision: 0,
    desiredAt: shouldRecover ? now : null,
    requestPayload: null,
    backoffUntil: new Date(0),
    lastEnqueuedAt: null,
    lastStartedAt: null,
    lastFinishedAt: lastSucceededAt,
    lastSucceededAt,
    lastFailedAt: null,
    consecutiveFailures: 0,
    lastErrorCode: null,
    lastErrorSummary: null,
    createdAt: now,
    updatedAt: now,
  };
}

export async function listSyncStreamStateRows(
  db: Database,
  input?: {
    platformAccountId?: number;
    streams?: SyncControlStream[];
  },
) {
  const clauses = [sql`true`];

  if (input?.platformAccountId !== undefined) {
    clauses.push(sql`platform_account_id = ${input.platformAccountId}`);
  }

  if (input?.streams?.length) {
    clauses.push(sql`stream = any(${sql.raw(`ARRAY[${input.streams.map((stream) => `'${stream}'`).join(", ")}]::sync_stream[]`)})`);
  }

  const result = await db.execute(sql`
    select platform_account_id as "platformAccountId",
           stream as "stream",
           status as "status",
           cadence_seconds as "cadenceSeconds",
           slot_offset_seconds as "slotOffsetSeconds",
           next_due_at as "nextDueAt",
           base_priority as "basePriority",
           effective_priority as "effectivePriority",
           pending_reason as "pendingReason",
           desired_revision as "desiredRevision",
           satisfied_revision as "satisfiedRevision",
           desired_at as "desiredAt",
           request_payload as "requestPayload",
           backoff_until as "backoffUntil",
           last_enqueued_at as "lastEnqueuedAt",
           last_started_at as "lastStartedAt",
           last_finished_at as "lastFinishedAt",
           last_succeeded_at as "lastSucceededAt",
           last_failed_at as "lastFailedAt",
           consecutive_failures as "consecutiveFailures",
           last_error_code as "lastErrorCode",
           last_error_summary as "lastErrorSummary",
           created_at as "createdAt",
           updated_at as "updatedAt"
    from sync_stream_state
    where ${and(...clauses)}
    order by platform_account_id asc, ${streamOrderSql("stream")} asc
  `);

  return normalizeSyncStreamStateRows(result.rows);
}

export async function getSyncStreamStateRow(
  db: Database,
  platformAccountId: number,
  stream: SyncControlStream,
) {
  const rows = await listSyncStreamStateRows(db, {
    platformAccountId,
    streams: [stream],
  });
  return rows[0] ?? null;
}

export async function ensureSyncStreamStateRows(
  db: Database,
  input?: {
    platformAccountId?: number;
    onboarding?: boolean;
    now?: Date;
  },
) {
  const now = input?.now ?? new Date();
  const pageClauses = [sql`true`];
  if (input?.platformAccountId !== undefined) {
    pageClauses.push(sql`pa.id = ${input.platformAccountId}`);
  }

  const pageRows = await db.execute<SeedSyncStreamPageRow>(sql`
    select pa.id as "platformAccountId",
           pa.platform as "platform",
           pa.last_light_sync_at as "lastLightSyncAt",
           pa.last_follower_sync_at as "lastFollowerSyncAt",
           pa.follower_count as "followerCount",
           coalesce((
             select count(*)::int
             from page_follows pf
             where pf.platform_account_id = pa.id
               and pf.is_active = true
           ), 0)::int as "activeFollowerCount"
    from platform_accounts pa
    where ${and(...pageClauses)}
    order by pa.id asc
  `);

  if (pageRows.rows.length === 0) {
    return [];
  }

  const existingRows = await listSyncStreamStateRows(db, input?.platformAccountId !== undefined
    ? { platformAccountId: input.platformAccountId }
    : undefined);
  const existingKeys = new Set(existingRows.map((row) => `${row.platformAccountId}:${row.stream}`));
  const values = pageRows.rows
    .map((row) => normalizeSeedSyncStreamPageRow(row))
    .flatMap((page) =>
    getSyncStreamsForPlatform(page.platform).flatMap((stream) => {
      const key = `${page.platformAccountId}:${stream}`;
      if (existingKeys.has(key)) {
        return [];
      }

      return [buildSeedSyncStreamStateValue(page, stream, now, input?.onboarding ?? false)];
    })
    );

  if (values.length === 0) {
    return existingRows;
  }

  await db.insert(syncStreamState).values(values).onConflictDoNothing();
  return listSyncStreamStateRows(db, input?.platformAccountId !== undefined
    ? { platformAccountId: input.platformAccountId }
    : undefined);
}

export async function promoteDueSyncStreamStateRows(
  db: Database,
  now = new Date(),
) {
  const dueRows = await db.execute(sql`
    select platform_account_id as "platformAccountId",
           stream as "stream",
           cadence_seconds as "cadenceSeconds",
           slot_offset_seconds as "slotOffsetSeconds"
    from sync_stream_state
    where status = 'active'
      and desired_revision = satisfied_revision
      and next_due_at <= ${now}
    order by next_due_at asc, platform_account_id asc, ${streamOrderSql("stream")} asc
  `);

  const promoted: Array<{ platformAccountId: number; stream: SyncControlStream; desiredRevision: number }> = [];

  for (const row of dueRows.rows as Array<{
    platformAccountId: number;
    stream: string;
    cadenceSeconds: number;
    slotOffsetSeconds: number;
  }>) {
    const stream = asSyncAuditStream(row.stream);
    if (stream === "cleanup") {
      continue;
    }

    const nextDueAt = computeSyncStreamNextDueAt(now, row.cadenceSeconds, row.slotOffsetSeconds);
    const update = await db.execute(sql`
      update sync_stream_state
      set desired_revision = desired_revision + 1,
          desired_at = ${now},
          pending_reason = 'scheduled',
          effective_priority = base_priority,
          next_due_at = ${nextDueAt},
          updated_at = ${now}
      where platform_account_id = ${row.platformAccountId}
        and stream = ${stream}
        and status = 'active'
        and desired_revision = satisfied_revision
        and next_due_at <= ${now}
      returning desired_revision as "desiredRevision"
    `);

    const desiredRevision = update.rows[0]?.desiredRevision;
    if (typeof desiredRevision === "number") {
      promoted.push({
        platformAccountId: row.platformAccountId,
        stream,
        desiredRevision,
      });
    }
  }

  return promoted;
}

export async function listRunnableSyncPages(
  db: Database,
  now = new Date(),
): Promise<SyncPageWakeupRow[]> {
  const result = await db.execute<SyncPageWakeupRow>(sql`
    select platform_account_id as "platformAccountId",
           pa.platform as "platform",
           max(effective_priority)::int as "priority",
           min(desired_at) as "desiredAt",
           pap.url as "proxyUrl"
    from sync_stream_state sss
    inner join platform_accounts pa on pa.id = sss.platform_account_id
    left join platform_account_proxies pap on pap.platform_account_id = sss.platform_account_id
    where status = 'active'
      and desired_revision > satisfied_revision
      and backoff_until <= ${now}
    group by sss.platform_account_id, pa.platform, pap.url
    order by max(effective_priority) desc,
             min(desired_at) asc nulls last,
             sss.platform_account_id asc
  `);

  return result.rows.map((row) => ({
    platformAccountId: normalizeNumber(row.platformAccountId, "platformAccountId"),
    platform: normalizePlatformValue(row.platform, "platform"),
    priority: normalizeNumber(row.priority, "priority"),
    desiredAt: parseTimestamp(row.desiredAt, "desiredAt"),
    proxyUrl: typeof row.proxyUrl === "string" ? row.proxyUrl : null,
  }));
}

export async function listRunnableSyncStreamStatesForPage(
  db: Database,
  platformAccountId: number,
  now = new Date(),
) {
  const result = await db.execute(sql`
    select platform_account_id as "platformAccountId",
           stream as "stream",
           status as "status",
           cadence_seconds as "cadenceSeconds",
           slot_offset_seconds as "slotOffsetSeconds",
           next_due_at as "nextDueAt",
           base_priority as "basePriority",
           effective_priority as "effectivePriority",
           pending_reason as "pendingReason",
           desired_revision as "desiredRevision",
           satisfied_revision as "satisfiedRevision",
           desired_at as "desiredAt",
           request_payload as "requestPayload",
           backoff_until as "backoffUntil",
           last_enqueued_at as "lastEnqueuedAt",
           last_started_at as "lastStartedAt",
           last_finished_at as "lastFinishedAt",
           last_succeeded_at as "lastSucceededAt",
           last_failed_at as "lastFailedAt",
           consecutive_failures as "consecutiveFailures",
           last_error_code as "lastErrorCode",
           last_error_summary as "lastErrorSummary",
           created_at as "createdAt",
           updated_at as "updatedAt"
    from sync_stream_state
    where platform_account_id = ${platformAccountId}
      and status = 'active'
      and desired_revision > satisfied_revision
      and backoff_until <= ${now}
    order by effective_priority desc,
             desired_at asc nulls last,
             ${streamOrderSql("stream")} asc
  `);

  return normalizeSyncStreamStateRows(result.rows);
}

export async function markSyncPageWakeupEnqueued(
  db: Database,
  platformAccountId: number,
  now = new Date(),
) {
  await db.execute(sql`
    update sync_stream_state
    set last_enqueued_at = ${now},
        updated_at = ${now}
    where platform_account_id = ${platformAccountId}
      and status = 'active'
      and desired_revision > satisfied_revision
      and backoff_until <= ${now}
  `);
}

export async function requestSyncStreamRevisions(
  db: Database,
  input: {
    platformAccountId: number;
    streams: SyncControlStream[];
    reason: SyncRequestReason;
    requestPayloadByStream?: Partial<Record<SyncControlStream, Record<string, unknown> | null>>;
    now?: Date;
  },
) {
  const now = input.now ?? new Date();
  const results: Array<{ stream: SyncControlStream; desiredRevision: number }> = [];

  await ensureSyncStreamStateRows(db, {
    platformAccountId: input.platformAccountId,
    onboarding: input.reason === "onboarding",
    now,
  });

  await db.transaction(async (tx) => {
    const database = tx as unknown as Database;
    for (const stream of input.streams) {
      const payload = input.requestPayloadByStream?.[stream] ?? null;
      const priority = resolveSyncRequestPriority(stream, input.reason);
      const result = await database.execute(sql`
        update sync_stream_state
        set status = case
                       when status in ('paused', 'disabled') then status
                       else 'active'
                     end,
            desired_revision = desired_revision + 1,
            desired_at = ${now},
            pending_reason = ${input.reason}::sync_request_reason,
            effective_priority = ${priority},
            request_payload = ${payload},
            updated_at = ${now}
        where platform_account_id = ${input.platformAccountId}
          and stream = ${stream}
        returning desired_revision as "desiredRevision"
      `);

      const desiredRevisionRaw = result.rows[0]?.desiredRevision;
      if (desiredRevisionRaw === null || desiredRevisionRaw === undefined) {
        throw new Error(`Failed to request revision for stream "${stream}"`);
      }

      results.push({
        stream,
        desiredRevision: normalizeNumber(desiredRevisionRaw as NumericValue, "desiredRevision"),
      });
    }
  });

  return results;
}

export async function recordSyncStreamChunkStarted(
  db: Database,
  platformAccountId: number,
  stream: SyncControlStream,
  now = new Date(),
) {
  await db.execute(sql`
    update sync_stream_state
    set last_started_at = ${now},
        updated_at = ${now}
    where platform_account_id = ${platformAccountId}
      and stream = ${stream}
  `);
}

export async function recordSyncStreamChunkYielded(
  db: Database,
  platformAccountId: number,
  stream: SyncControlStream,
  now = new Date(),
) {
  await db.execute(sql`
    update sync_stream_state
    set last_finished_at = ${now},
        consecutive_failures = 0,
        last_error_code = null,
        last_error_summary = null,
        backoff_until = '-infinity'::timestamptz,
        updated_at = ${now}
    where platform_account_id = ${platformAccountId}
      and stream = ${stream}
  `);
}

export async function recordSyncStreamChunkSucceeded(
  db: Database,
  input: {
    platformAccountId: number;
    stream: SyncControlStream;
    satisfied: boolean;
    targetRevision: number;
    clearRequestPayload?: boolean;
    now?: Date;
  },
) {
  const now = input.now ?? new Date();
  const successSet = input.satisfied
    ? sql`,
        satisfied_revision = greatest(satisfied_revision, ${input.targetRevision}),
        desired_at = case
                       when desired_revision <= ${input.targetRevision} then null
                       else desired_at
                     end,
        last_succeeded_at = ${now},
        request_payload = case
                            when ${input.clearRequestPayload ?? false}
                              and desired_revision <= ${input.targetRevision}
                              then null
                            else request_payload
                          end`
    : sql``;

  await db.execute(sql`
    update sync_stream_state
    set last_finished_at = ${now},
        consecutive_failures = 0,
        last_error_code = null,
        last_error_summary = null,
        backoff_until = '-infinity'::timestamptz,
        updated_at = ${now}
        ${successSet}
    where platform_account_id = ${input.platformAccountId}
      and stream = ${input.stream}
  `);
}

export async function recordSyncStreamChunkFailure(
  db: Database,
  input: {
    platformAccountId: number;
    stream: SyncControlStream;
    errorCode: string | null;
    errorSummary: string;
    now?: Date;
  },
) {
  const now = input.now ?? new Date();
  const row = await getSyncStreamStateRow(db, input.platformAccountId, input.stream);
  const nextFailures = (row?.consecutiveFailures ?? 0) + 1;
  const backoffUntil = new Date(now.getTime() + resolveBackoffDelaySeconds(nextFailures) * 1000);

  await db.execute(sql`
    update sync_stream_state
    set last_finished_at = ${now},
        last_failed_at = ${now},
        consecutive_failures = ${nextFailures},
        last_error_code = ${input.errorCode},
        last_error_summary = ${input.errorSummary},
        backoff_until = ${backoffUntil},
        updated_at = ${now}
    where platform_account_id = ${input.platformAccountId}
      and stream = ${input.stream}
  `);
}

export async function markSyncPageAuthFailed(
  db: Database,
  input: {
    platformAccountId: number;
    errorCode: string | null;
    errorSummary: string;
    now?: Date;
  },
) {
  const now = input.now ?? new Date();
  await db.execute(sql`
    update sync_stream_state
    set status = 'auth_failed',
        last_finished_at = ${now},
        last_failed_at = ${now},
        consecutive_failures = consecutive_failures + 1,
        last_error_code = ${input.errorCode},
        last_error_summary = ${input.errorSummary},
        updated_at = ${now}
    where platform_account_id = ${input.platformAccountId}
      and status = 'active'
  `);
}

export async function clearSyncPageAuthFailed(
  db: Database,
  platformAccountId: number,
  now = new Date(),
) {
  await db.execute(sql`
    update sync_stream_state
    set status = 'active',
        backoff_until = '-infinity'::timestamptz,
        updated_at = ${now}
    where platform_account_id = ${platformAccountId}
      and status = 'auth_failed'
  `);
}

export async function listSyncStreamRevisionStates(
  db: Database,
  platformAccountId: number,
  streams: SyncControlStream[],
) {
  if (streams.length === 0) {
    return [] as SyncStreamStateRow[];
  }

  return listSyncStreamStateRows(db, {
    platformAccountId,
    streams,
  });
}

export async function updateSyncStreamStateRequestPayload(
  db: Database,
  input: {
    platformAccountId: number;
    stream: SyncControlStream;
    requestPayload: Record<string, unknown> | null;
    now?: Date;
  },
) {
  const now = input.now ?? new Date();
  await db.execute(sql`
    update sync_stream_state
    set request_payload = ${input.requestPayload},
        updated_at = ${now}
    where platform_account_id = ${input.platformAccountId}
      and stream = ${input.stream}
  `);
}

export async function updateLegacySyncTimestamp(
  db: Database,
  input: {
    platformAccountId: number;
    syncType: "light" | "followers";
    now?: Date;
  },
) {
  const now = input.now ?? new Date();
  if (input.syncType === "light") {
    await db
      .update(platformAccounts)
      .set({
        lastLightSyncAt: now,
        updatedAt: now,
      })
      .where(eq(platformAccounts.id, input.platformAccountId));
    return;
  }

  await db
    .update(platformAccounts)
    .set({
      lastFollowerSyncAt: now,
      updatedAt: now,
    })
    .where(eq(platformAccounts.id, input.platformAccountId));
}

export async function ensureSyncProviderRateLimitProfile(
  db: Database,
  input: {
    provider: "fansly" | "onlyfans";
    egressKey: string;
    scopes: Array<{ scope: string; minSpacingMs: number }>;
    now?: Date;
  },
): Promise<void> {
  if (input.scopes.length === 0) {
    return;
  }

  const now = input.now ?? new Date();
  const values = input.scopes.map((scope) => sql`(
    ${input.provider},
    ${scope.scope},
    ${input.egressKey},
    ${scope.minSpacingMs},
    ${now}
  )`);

  await db.execute(sql`
    insert into sync_provider_rate_limits (
      provider,
      scope,
      egress_key,
      min_spacing_ms,
      updated_at
    )
    values ${sql.join(values, sql`, `)}
    on conflict (provider, scope, egress_key) do update
    set min_spacing_ms = excluded.min_spacing_ms,
        updated_at = excluded.updated_at
  `);
}

export async function reserveSyncProviderRateLimit(
  db: Database,
  input: {
    scopes: Array<{
      provider: "fansly" | "onlyfans";
      scope: string;
      egressKey: string;
    }>;
    now?: Date;
  },
) {
  const now = input.now ?? new Date();
  if (input.scopes.length === 0) {
    return now;
  }

  const sortedScopes = [...input.scopes].sort((left, right) => {
    if (left.provider !== right.provider) {
      return left.provider.localeCompare(right.provider);
    }

    if (left.scope !== right.scope) {
      return left.scope.localeCompare(right.scope);
    }

    return left.egressKey.localeCompare(right.egressKey);
  });

  const scheduledAt = await db.transaction(async (tx) => {
    const database = tx as unknown as Database;
    const lockedRows = [] as Array<{
      provider: "fansly" | "onlyfans";
      scope: string;
      egressKey: string;
      minSpacingMs: number;
      nextAvailableAt: Date;
    }>;

    for (const scope of sortedScopes) {
      const result = await database.execute<{
        provider: "fansly" | "onlyfans";
        scope: string;
        egressKey: string;
        minSpacingMs: number;
        nextAvailableAt: Date;
      }>(sql`
        select provider as "provider",
               scope as "scope",
               egress_key as "egressKey",
               min_spacing_ms as "minSpacingMs",
               next_available_at as "nextAvailableAt"
        from sync_provider_rate_limits
        where provider = ${scope.provider}
          and scope = ${scope.scope}
          and egress_key = ${scope.egressKey}
        for update
      `);

      const row = result.rows[0];
      if (!row) {
        throw new Error(`Missing sync rate-limit row for ${scope.provider}/${scope.scope}/${scope.egressKey}`);
      }
      lockedRows.push(row);
    }

    const nextAt = lockedRows.reduce((current, row) => {
      return row.nextAvailableAt > current ? row.nextAvailableAt : current;
    }, now);

    for (const row of lockedRows) {
      const nextAvailableAt = new Date(nextAt.getTime() + row.minSpacingMs);
      await database.execute(sql`
        update sync_provider_rate_limits
        set next_available_at = ${nextAvailableAt},
            updated_at = ${now}
        where provider = ${row.provider}
          and scope = ${row.scope}
          and egress_key = ${row.egressKey}
      `);
    }

    return nextAt;
  });

  return scheduledAt;
}
