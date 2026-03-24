import { and, eq, inArray, lt, sql } from "drizzle-orm";

import { FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_KEY } from "@agency_hub_core/shared";

import type { Database } from "../client.ts";
import {
  fanPages,
  models,
  pageDmConversations,
  pageDmMessages,
  pageFollows,
  pageSubscriptions,
  platformAccounts,
  platformAccountProxies,
  rawPayloads,
  syncCheckpoints,
  syncProviderRateLimits,
  syncRequestAttempts,
  syncStreamState,
  syncRunEvents,
  syncRuns,
  transactions,
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
  followers: { stream: "followers", cadenceSeconds: 43200, basePriority: 35, streamIndex: 4 },
  followers_reconcile: {
    stream: "followers_reconcile",
    cadenceSeconds: 172800,
    basePriority: 34,
    streamIndex: 5,
  },
  dm_conversations: {
    stream: "dm_conversations",
    cadenceSeconds: 1800,
    basePriority: 30,
    streamIndex: 6,
  },
  dm_messages: { stream: "dm_messages", cadenceSeconds: 7200, basePriority: 25, streamIndex: 7 },
};

const SYNC_STREAM_TIE_BREAK_ORDER: Record<SyncControlStream, number> = {
  light: 1,
  transactions: 2,
  subscribers: 3,
  followers: 4,
  followers_reconcile: 5,
  dm_conversations: 6,
  dm_messages: 7,
};

const SYNC_REQUEST_PRIORITY_BY_REASON: Record<
  SyncRequestReason,
  Record<SyncControlStream, number>
> = {
  scheduled: {
    light: 60,
    transactions: 50,
    subscribers: 40,
    followers: 35,
    followers_reconcile: 34,
    dm_conversations: 30,
    dm_messages: 25,
  },
  recovery: {
    light: 70,
    transactions: 60,
    subscribers: 50,
    followers: 45,
    followers_reconcile: 44,
    dm_conversations: 40,
    dm_messages: 35,
  },
  anomaly: {
    light: 70,
    transactions: 60,
    subscribers: 50,
    followers: 45,
    followers_reconcile: 44,
    dm_conversations: 40,
    dm_messages: 35,
  },
  manual: {
    light: 100,
    transactions: 90,
    subscribers: 80,
    followers: 75,
    followers_reconcile: 74,
    dm_conversations: 70,
    dm_messages: 65,
  },
  onboarding: {
    light: 100,
    transactions: 90,
    subscribers: 80,
    followers: 75,
    followers_reconcile: 74,
    dm_conversations: 70,
    dm_messages: 65,
  },
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

function normalizeNullableNumber(value: NumericValue, field: string) {
  if (value === null || value === undefined) {
    return null;
  }

  return normalizeNumber(value, field);
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
  return SYNC_REQUEST_PRIORITY_BY_REASON[reason][stream];
}

function syncBasePriorityCaseSql(streamColumnName: string) {
  return sql.raw(`
    case ${streamColumnName}
      when 'light' then ${SYNC_STREAM_CONFIG.light.basePriority}
      when 'transactions' then ${SYNC_STREAM_CONFIG.transactions.basePriority}
      when 'subscribers' then ${SYNC_STREAM_CONFIG.subscribers.basePriority}
      when 'followers' then ${SYNC_STREAM_CONFIG.followers.basePriority}
      when 'followers_reconcile' then ${SYNC_STREAM_CONFIG.followers_reconcile.basePriority}
      when 'dm_conversations' then ${SYNC_STREAM_CONFIG.dm_conversations.basePriority}
      when 'dm_messages' then ${SYNC_STREAM_CONFIG.dm_messages.basePriority}
      else 0
    end
  `);
}

function syncRequestedPriorityCaseSql(
  streamColumnName: string,
  reasonColumnName: string,
) {
  const priorityCase = (reason: SyncRequestReason) => `
    case ${streamColumnName}
      when 'light' then ${SYNC_REQUEST_PRIORITY_BY_REASON[reason].light}
      when 'transactions' then ${SYNC_REQUEST_PRIORITY_BY_REASON[reason].transactions}
      when 'subscribers' then ${SYNC_REQUEST_PRIORITY_BY_REASON[reason].subscribers}
      when 'followers' then ${SYNC_REQUEST_PRIORITY_BY_REASON[reason].followers}
      when 'followers_reconcile' then ${SYNC_REQUEST_PRIORITY_BY_REASON[reason].followers_reconcile}
      when 'dm_conversations' then ${SYNC_REQUEST_PRIORITY_BY_REASON[reason].dm_conversations}
      when 'dm_messages' then ${SYNC_REQUEST_PRIORITY_BY_REASON[reason].dm_messages}
      else 0
    end
  `;

  return sql.raw(`
    case ${reasonColumnName}
      when 'scheduled' then ${priorityCase("scheduled")}
      when 'recovery' then ${priorityCase("recovery")}
      when 'anomaly' then ${priorityCase("anomaly")}
      when 'manual' then ${priorityCase("manual")}
      when 'onboarding' then ${priorityCase("onboarding")}
      else ${priorityCase("scheduled")}
    end
  `);
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

export interface CloseOrphanedSyncRunsResult {
  totalCount: number;
  failedCount: number;
  partialCount: number;
}

export interface CloseInactiveSyncRunsResult {
  totalCount: number;
  failedCount: number;
  partialCount: number;
}

export async function closeOrphanedSyncRuns(
  db: Database,
  input: {
    startedBefore: Date;
    finishedAt: Date;
    errorSummary: string;
  },
): Promise<CloseOrphanedSyncRunsResult> {
  const result = await db.execute<{
    status: "failed" | "partial";
  }>(sql`
    with orphaned_runs as (
      select sr.id,
             case
               when exists (
                 select 1
                 from ${syncRunEvents} e
                 where e.sync_run_id = sr.id
                   and e.event_type = 'checkpoint_advanced'
               )
               then 'partial'::sync_run_status
               else 'failed'::sync_run_status
             end as next_status
      from ${syncRuns} sr
      where sr.status = 'running'
        and sr.started_at < ${input.startedBefore}
    )
    update ${syncRuns} sr
    set status = orphaned_runs.next_status,
        error_summary = ${input.errorSummary},
        finished_at = ${input.finishedAt}
    from orphaned_runs
    where sr.id = orphaned_runs.id
    returning sr.status as status
  `);

  let failedCount = 0;
  let partialCount = 0;

  for (const row of result.rows) {
    if (row.status === "failed") {
      failedCount += 1;
    } else if (row.status === "partial") {
      partialCount += 1;
    }
  }

  return {
    totalCount: failedCount + partialCount,
    failedCount,
    partialCount,
  };
}

export async function closeInactiveSyncRuns(
  db: Database,
  input: {
    inactiveBefore: Date;
    finishedAt: Date;
    errorSummary: string;
  },
): Promise<CloseInactiveSyncRunsResult> {
  const result = await db.execute<{
    status: "failed" | "partial";
  }>(sql`
    with request_activity as (
      select a.sync_run_id as "runId",
             max(coalesce(a.finished_at, a.started_at)) as "lastAttemptAt"
      from ${syncRequestAttempts} a
      group by a.sync_run_id
    ),
    event_activity as (
      select e.sync_run_id as "runId",
             max(e.emitted_at) as "lastEventAt"
      from ${syncRunEvents} e
      group by e.sync_run_id
    ),
    inactive_runs as (
      select sr.id,
             case
               when exists (
                 select 1
                 from ${syncRunEvents} e
                 where e.sync_run_id = sr.id
                   and e.event_type = 'checkpoint_advanced'
               )
               then 'partial'::sync_run_status
               else 'failed'::sync_run_status
             end as next_status
      from ${syncRuns} sr
      left join request_activity ra on ra."runId" = sr.id
      left join event_activity ea on ea."runId" = sr.id
      where sr.status = 'running'
        and greatest(
          sr.started_at,
          coalesce(ra."lastAttemptAt", sr.started_at),
          coalesce(ea."lastEventAt", sr.started_at)
        ) < ${input.inactiveBefore}
    )
    update ${syncRuns} sr
    set status = inactive_runs.next_status,
        error_summary = ${input.errorSummary},
        finished_at = ${input.finishedAt}
    from inactive_runs
    where sr.id = inactive_runs.id
    returning sr.status as status
  `);

  let failedCount = 0;
  let partialCount = 0;

  for (const row of result.rows) {
    if (row.status === "failed") {
      failedCount += 1;
    } else if (row.status === "partial") {
      partialCount += 1;
    }
  }

  return {
    totalCount: failedCount + partialCount,
    failedCount,
    partialCount,
  };
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

  clauses.push(sql`e.event_type <> 'worker_heartbeat'`);

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

export async function countRecentTerminalDmMessageConversationFailureStreak(
  db: Database,
  input: {
    platformAccountId: number;
    platformConversationId: string;
    limit?: number;
  },
) {
  const result = await db.execute<{
    logicalRequestId: string;
    terminalState: "success" | "failed";
    httpStatus: number | null;
    terminalAt: Date | string;
  }>(sql`
    with logical_requests as (
      select a.logical_request_id as "logicalRequestId",
             max(a.id) filter (where a.state in ('success', 'failed')) as "terminalAttemptId"
      from ${syncRequestAttempts} a
      where a.platform_account_id = ${input.platformAccountId}
        and a.stream = 'dm_messages'
        and a.operation = 'messages'
        and a.request_shape ->> 'groupId' = ${input.platformConversationId}
      group by a.logical_request_id
    )
    select a.logical_request_id as "logicalRequestId",
           a.state as "terminalState",
           a.http_status as "httpStatus",
           coalesce(a.finished_at, a.started_at) as "terminalAt"
    from logical_requests lr
    inner join ${syncRequestAttempts} a on a.id = lr."terminalAttemptId"
    order by "terminalAt" desc, a.id desc
    limit ${input.limit ?? 20}
  `);

  let streak = 0;
  for (const row of result.rows) {
    if (row.terminalState !== "failed") {
      break;
    }

    const httpStatus = normalizeNullableNumber(row.httpStatus, "httpStatus");
    if (httpStatus === null || httpStatus < 500 || httpStatus >= 600) {
      break;
    }

    streak += 1;
  }

  return streak;
}

export async function hasRecentTerminalProxyFailure(
  db: Database,
  input: {
    runId: number;
    limit?: number;
  },
) {
  const result = await db.execute<{ hasFailure: boolean }>(sql`
    with recent_attempts as (
      select a.state,
             a.failure_kind as "failureKind"
      from sync_request_attempts a
      where a.sync_run_id = ${input.runId}
      order by a.started_at desc, a.id desc
      limit ${input.limit ?? 2000}
    )
    select exists(
      select 1
      from recent_attempts
      where state = 'failed'
        and "failureKind" in ('timeout', 'transport')
    ) as "hasFailure"
  `);

  return Boolean(result.rows[0]?.hasFailure);
}

export async function listSyncMonitorRecentRequests(
  db: Database,
  input?: {
    pageIds?: number[];
    since?: Date;
    limit?: number;
  },
) {
  if (input?.pageIds !== undefined && input.pageIds.length === 0) {
    return [] as Array<{
      attemptId: number;
      runId: number;
      pageId: number;
      platformAccountId: number;
      pageLabel: string;
      provider: "fansly" | "onlyfans";
      stream: SyncAuditStream;
      operation: string;
      attemptNumber: number;
      state: "started" | "success" | "retry" | "failed";
      httpStatus: number | null;
      durationMs: number | null;
      startedAt: Date;
      finishedAt: Date | null;
      requestShape: Record<string, unknown> | null;
      responseShape: Record<string, unknown> | null;
      partnerUsername: string | null;
      returnedItems: number | null;
      syncDone: boolean | null;
    }>;
  }

  const pageClauses = [sql`true`];
  if (input?.pageIds !== undefined) {
    pageClauses.push(inArray(platformAccounts.id, input.pageIds));
  }

  const requestClauses = [sql`true`];
  if (input?.since) {
    requestClauses.push(sql`a.started_at >= ${input.since}`);
  }

  const result = await db.execute<{
    attemptId: NumericValue;
    runId: NumericValue;
    pageId: NumericValue;
    platformAccountId: NumericValue;
    pageLabel: string;
    provider: "fansly" | "onlyfans";
    stream: string;
    operation: string;
    attemptNumber: number;
    state: "started" | "success" | "retry" | "failed";
    httpStatus: number | null;
    durationMs: number | null;
    startedAt: Date | string;
    finishedAt: TimestampValue;
    requestShape: Record<string, unknown> | null;
    responseShape: Record<string, unknown> | null;
    partnerUsername: string | null;
    returnedItems: NumericValue;
    syncDone: boolean | null;
  }>(sql`
    with visible_pages as (
      select ${platformAccounts.id} as "pageId",
             ${platformAccounts.label} as "pageLabel"
      from ${platformAccounts}
      where ${and(...pageClauses)}
    )
    select a.id as "attemptId",
           a.sync_run_id as "runId",
           vp."pageId" as "pageId",
           a.platform_account_id as "platformAccountId",
           vp."pageLabel" as "pageLabel",
           a.provider as "provider",
           a.stream as "stream",
           a.operation as "operation",
           a.attempt_number as "attemptNumber",
           a.state as "state",
           a.http_status as "httpStatus",
           a.duration_ms as "durationMs",
           a.started_at as "startedAt",
           a.finished_at as "finishedAt",
           a.request_shape as "requestShape",
           a.response_shape as "responseShape",
           c.partner_username as "partnerUsername",
           case
             when jsonb_typeof(a.response_shape) = 'object'
              and jsonb_typeof(a.response_shape -> 'returnedItems') = 'number'
             then (a.response_shape ->> 'returnedItems')::integer
             else null
           end as "returnedItems",
           case
             when jsonb_typeof(a.response_shape) = 'object'
              and jsonb_typeof(a.response_shape -> 'done') = 'boolean'
             then (a.response_shape ->> 'done')::boolean
             else null
           end as "syncDone"
    from ${syncRequestAttempts} a
    inner join visible_pages vp on vp."pageId" = a.platform_account_id
    left join ${pageDmConversations} c
      on c.platform_account_id = a.platform_account_id
     and c.platform_conversation_id = a.request_shape ->> 'groupId'
    where ${and(...requestClauses)}
    order by a.started_at desc, a.id desc
    limit ${input?.limit ?? 100}
  `);

  return result.rows.map((row) => {
    const normalized = normalizeSyncRequestAttemptRow(row);
    return {
      ...normalized,
      pageId: normalizeNumber(row.pageId, "pageId"),
      stream: asSyncAuditStream(row.stream),
      requestShape: normalizeNullableJsonRecord(row.requestShape, "requestShape"),
      responseShape: normalizeNullableJsonRecord(row.responseShape, "responseShape"),
      partnerUsername: row.partnerUsername,
      returnedItems: normalizeNullableNumber(row.returnedItems, "returnedItems"),
      syncDone: row.syncDone,
    };
  });
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

export async function listSyncMonitorStreamRows(
  db: Database,
  input?: {
    pageIds?: number[];
    pageLabel?: string;
    windowStart?: Date;
    streams?: SyncControlStream[];
  },
) {
  if (
    (input?.pageIds !== undefined && input.pageIds.length === 0) ||
    (input?.streams !== undefined && input.streams.length === 0)
  ) {
    return [] as SyncMonitorStreamRow[];
  }

  const pageClauses = [sql`true`];
  if (input?.pageIds !== undefined) {
    pageClauses.push(inArray(platformAccounts.id, input.pageIds));
  }
  if (input?.pageLabel) {
    pageClauses.push(eq(platformAccounts.label, input.pageLabel));
  }

  const windowStart = input?.windowStart ?? new Date(Date.now() - 24 * 60 * 60 * 1000);
  const requestedStreams = input?.streams ?? SYNC_CONTROL_STREAMS;
  const requestedStreamsSql = sql.raw(
    `ARRAY[${requestedStreams.map((stream) => `'${stream}'`).join(", ")}]::sync_stream[]`,
  );
  const fanslyStreams = requestedStreams
    .filter((stream) => getSyncStreamsForPlatform("fansly").includes(stream))
    .map((stream) => `'${stream}'`)
    .join(", ");
  const onlyFansStreams = requestedStreams
    .filter((stream) => getSyncStreamsForPlatform("onlyfans").includes(stream))
    .map((stream) => `'${stream}'`)
    .join(", ");

  const result = await db.execute<{
    pageId: NumericValue;
    pageLabel: string;
    platform: unknown;
    modelSlug: string;
    modelName: string;
    username: string | null;
    displayName: string | null;
    fanCount: NumericValue;
    followerCount: NumericValue;
    subscriberCount: NumericValue;
    transactionCount: NumericValue;
    dmConversationCount: NumericValue;
    dmMessageCount: NumericValue;
    dmEligibleConversationCount: NumericValue;
    dmBackfillCompleteConversationCount: NumericValue;
    dmLaggingConversationCount: NumericValue;
    stream: string;
    targetStatus: string | null;
    cadenceSeconds: NumericValue;
    nextDueAt: TimestampValue;
    desiredRevision: NumericValue;
    satisfiedRevision: NumericValue;
    desiredAt: TimestampValue;
    backoffUntil: TimestampValue;
    lastEnqueuedAt: TimestampValue;
    lastStartedAt: TimestampValue;
    lastFinishedAt: TimestampValue;
    lastSucceededAt: TimestampValue;
    lastFailedAt: TimestampValue;
    consecutiveFailures: NumericValue;
    lastErrorCode: string | null;
    lastErrorSummary: string | null;
    checkpointCursorText: string | null;
    checkpointCursorTimestamp: TimestampValue;
    checkpointState: unknown;
    checkpointLastSuccessfulAt: TimestampValue;
    checkpointLastSuccessfulRunId: NumericValue;
    runningRunId: NumericValue;
    runningTrigger: string | null;
    runningStartedAt: TimestampValue;
    runningLastActivityAt: TimestampValue;
    runningStats: unknown;
    runningErrorSummary: string | null;
    lastCompletedRunId: NumericValue;
    lastCompletedTrigger: string | null;
    lastCompletedStatus: "success" | "partial" | "failed" | "skipped" | null;
    lastCompletedStartedAt: TimestampValue;
    lastCompletedFinishedAt: TimestampValue;
    lastCompletedDurationMs: NumericValue;
    lastCompletedStats: unknown;
    lastCompletedErrorSummary: string | null;
    recentRunningCount: NumericValue;
    recentSuccessCount: NumericValue;
    recentPartialCount: NumericValue;
    recentFailedCount: NumericValue;
    recentSkippedCount: NumericValue;
    recent429Count: NumericValue;
    recent5xxCount: NumericValue;
    recentFailedAttemptCount: NumericValue;
    recentRetryCount: NumericValue;
    last429At: TimestampValue;
    last5xxAt: TimestampValue;
    providerNextAvailableAt: TimestampValue;
    providerMinSpacingMs: NumericValue;
  }>(sql`
    with visible_pages as (
      select ${platformAccounts.id} as "pageId",
             ${platformAccounts.label} as "pageLabel",
             ${platformAccounts.platform} as "platform",
             ${platformAccounts.username} as "username",
             ${platformAccounts.displayName} as "displayName",
             ${models.slug} as "modelSlug",
             ${models.name} as "modelName"
      from ${platformAccounts}
      inner join ${models} on ${models.id} = ${platformAccounts.modelId}
      where ${and(...pageClauses)}
    ),
    page_streams as (
      select vp."pageId",
             vp."pageLabel",
             vp."platform",
             vp."username",
             vp."displayName",
             vp."modelSlug",
             vp."modelName",
             s.stream::sync_stream as "stream"
      from visible_pages vp
      cross join lateral unnest(
        case
          when vp."platform" = 'fansly'
            then ARRAY[${sql.raw(fanslyStreams)}]::sync_stream[]
          else ARRAY[${sql.raw(onlyFansStreams)}]::sync_stream[]
        end
      ) as s(stream)
    ),
    fan_counts as (
      select fp.platform_account_id as "pageId",
             count(distinct fp.fan_id)::int as "fanCount"
      from ${fanPages} fp
      inner join visible_pages vp on vp."pageId" = fp.platform_account_id
      group by fp.platform_account_id
    ),
    follower_counts as (
      select pf.platform_account_id as "pageId",
             count(*) filter (where pf.is_active = true)::int as "followerCount"
      from ${pageFollows} pf
      inner join visible_pages vp on vp."pageId" = pf.platform_account_id
      group by pf.platform_account_id
    ),
    subscriber_counts as (
      select ps.platform_account_id as "pageId",
             count(*) filter (where ps.is_current = true)::int as "subscriberCount"
      from ${pageSubscriptions} ps
      inner join visible_pages vp on vp."pageId" = ps.platform_account_id
      group by ps.platform_account_id
    ),
    transaction_counts as (
      select t.platform_account_id as "pageId",
             count(*)::int as "transactionCount"
      from ${transactions} t
      inner join visible_pages vp on vp."pageId" = t.platform_account_id
      group by t.platform_account_id
    ),
    dm_conversation_counts as (
      select c.platform_account_id as "pageId",
             count(*) filter (where c.is_visible = true)::int as "dmConversationCount",
             count(*) filter (
               where c.is_visible = true
                 and c.fan_id is not null
                 and ${dmMessageSyncEligibleSql("c")}
             )::int as "dmEligibleConversationCount",
             count(*) filter (
               where c.is_visible = true
                 and c.fan_id is not null
                 and ${dmMessageSyncEligibleSql("c")}
                 and c.message_backfill_complete = true
             )::int as "dmBackfillCompleteConversationCount",
             count(*) filter (
               where c.is_visible = true
                 and c.fan_id is not null
                 and ${dmMessageSyncEligibleSql("c")}
                 and c.last_message_id is distinct from c.newest_stored_message_id
                 and (
                   c.last_message_sync_at is null
                   or (c.last_message_at is not null and c.last_message_sync_at < c.last_message_at)
                 )
             )::int as "dmLaggingConversationCount"
      from ${pageDmConversations} c
      inner join visible_pages vp on vp."pageId" = c.platform_account_id
      group by c.platform_account_id
    ),
    dm_message_counts as (
      select m.platform_account_id as "pageId",
             count(*)::int as "dmMessageCount"
      from ${pageDmMessages} m
      inner join visible_pages vp on vp."pageId" = m.platform_account_id
      group by m.platform_account_id
    ),
    request_activity as (
      select a.sync_run_id as "runId",
             max(coalesce(a.finished_at, a.started_at)) as "lastAttemptAt"
      from ${syncRequestAttempts} a
      inner join visible_pages vp on vp."pageId" = a.platform_account_id
      group by a.sync_run_id
    ),
    event_activity as (
      select e.sync_run_id as "runId",
             max(e.emitted_at) as "lastEventAt"
      from ${syncRunEvents} e
      inner join visible_pages vp on vp."pageId" = e.platform_account_id
      group by e.sync_run_id
    ),
    running_runs as (
      select ranked.*
      from (
        select sr.platform_account_id as "pageId",
               sr.stream as "stream",
               sr.id as "runningRunId",
               sr.trigger as "runningTrigger",
               sr.started_at as "runningStartedAt",
               greatest(
                 sr.started_at,
                 coalesce(ra."lastAttemptAt", sr.started_at),
                 coalesce(ea."lastEventAt", sr.started_at)
               ) as "runningLastActivityAt",
               sr.stats as "runningStats",
               sr.error_summary as "runningErrorSummary",
               row_number() over (
                 partition by sr.platform_account_id, sr.stream
                 order by sr.started_at desc, sr.id desc
               ) as "rank"
        from ${syncRuns} sr
        inner join visible_pages vp on vp."pageId" = sr.platform_account_id
        left join request_activity ra on ra."runId" = sr.id
        left join event_activity ea on ea."runId" = sr.id
        where sr.status = 'running'
          and sr.stream = any(${requestedStreamsSql})
      ) ranked
      where ranked."rank" = 1
    ),
    completed_runs as (
      select ranked.*
      from (
        select sr.platform_account_id as "pageId",
               sr.stream as "stream",
               sr.id as "lastCompletedRunId",
               sr.trigger as "lastCompletedTrigger",
               sr.status as "lastCompletedStatus",
               sr.started_at as "lastCompletedStartedAt",
               sr.finished_at as "lastCompletedFinishedAt",
               greatest(
                 0,
                 floor(extract(epoch from (sr.finished_at - sr.started_at)) * 1000)
               )::int as "lastCompletedDurationMs",
               sr.stats as "lastCompletedStats",
               sr.error_summary as "lastCompletedErrorSummary",
               row_number() over (
                 partition by sr.platform_account_id, sr.stream
                 order by sr.finished_at desc, sr.id desc
               ) as "rank"
        from ${syncRuns} sr
        inner join visible_pages vp on vp."pageId" = sr.platform_account_id
        where sr.status <> 'running'
          and sr.finished_at is not null
          and sr.stream = any(${requestedStreamsSql})
      ) ranked
      where ranked."rank" = 1
    ),
    recent_run_counts as (
      select sr.platform_account_id as "pageId",
             sr.stream as "stream",
             count(*) filter (where sr.status = 'running')::int as "recentRunningCount",
             count(*) filter (where sr.status = 'success')::int as "recentSuccessCount",
             count(*) filter (where sr.status = 'partial')::int as "recentPartialCount",
             count(*) filter (where sr.status = 'failed')::int as "recentFailedCount",
             count(*) filter (where sr.status = 'skipped')::int as "recentSkippedCount"
      from ${syncRuns} sr
      inner join visible_pages vp on vp."pageId" = sr.platform_account_id
      where sr.started_at >= ${windowStart}
        and sr.stream = any(${requestedStreamsSql})
      group by sr.platform_account_id, sr.stream
    ),
    recent_attempt_counts as (
      select a.platform_account_id as "pageId",
             a.stream as "stream",
             count(*) filter (where a.http_status = 429)::int as "recent429Count",
             count(*) filter (where a.http_status >= 500 and a.http_status < 600)::int as "recent5xxCount",
             count(*) filter (where a.state = 'failed')::int as "recentFailedAttemptCount",
             count(*) filter (where a.state = 'retry')::int as "recentRetryCount",
             max(a.started_at) filter (where a.http_status = 429) as "last429At",
             max(a.started_at) filter (
               where a.http_status >= 500 and a.http_status < 600
             ) as "last5xxAt"
      from ${syncRequestAttempts} a
      inner join visible_pages vp on vp."pageId" = a.platform_account_id
      where a.started_at >= ${windowStart}
        and a.stream = any(${requestedStreamsSql})
      group by a.platform_account_id, a.stream
    ),
    provider_rate_limits as (
      select rl.provider as "platform",
             max(rl.next_available_at) as "providerNextAvailableAt",
             max(rl.min_spacing_ms)::int as "providerMinSpacingMs"
      from ${syncProviderRateLimits} rl
      group by rl.provider
    )
    select ps."pageId" as "pageId",
           ps."pageLabel" as "pageLabel",
           ps."platform" as "platform",
           ps."modelSlug" as "modelSlug",
           ps."modelName" as "modelName",
           ps."username" as "username",
           ps."displayName" as "displayName",
           coalesce(fc."fanCount", 0)::int as "fanCount",
           coalesce(foc."followerCount", 0)::int as "followerCount",
           coalesce(scnt."subscriberCount", 0)::int as "subscriberCount",
           coalesce(tc."transactionCount", 0)::int as "transactionCount",
           coalesce(dcc."dmConversationCount", 0)::int as "dmConversationCount",
           coalesce(dmc."dmMessageCount", 0)::int as "dmMessageCount",
           coalesce(dcc."dmEligibleConversationCount", 0)::int as "dmEligibleConversationCount",
           coalesce(dcc."dmBackfillCompleteConversationCount", 0)::int as "dmBackfillCompleteConversationCount",
           coalesce(dcc."dmLaggingConversationCount", 0)::int as "dmLaggingConversationCount",
           ps."stream" as "stream",
           sss.status as "targetStatus",
           sss.cadence_seconds as "cadenceSeconds",
           sss.next_due_at as "nextDueAt",
           sss.desired_revision as "desiredRevision",
           sss.satisfied_revision as "satisfiedRevision",
           sss.desired_at as "desiredAt",
           sss.backoff_until as "backoffUntil",
           sss.last_enqueued_at as "lastEnqueuedAt",
           sss.last_started_at as "lastStartedAt",
           sss.last_finished_at as "lastFinishedAt",
           sss.last_succeeded_at as "lastSucceededAt",
           sss.last_failed_at as "lastFailedAt",
           coalesce(sss.consecutive_failures, 0)::int as "consecutiveFailures",
           sss.last_error_code as "lastErrorCode",
           sss.last_error_summary as "lastErrorSummary",
           cp.cursor_text as "checkpointCursorText",
           cp.cursor_timestamp as "checkpointCursorTimestamp",
           cp.state as "checkpointState",
           cp.last_successful_at as "checkpointLastSuccessfulAt",
           cp.last_successful_run_id as "checkpointLastSuccessfulRunId",
           rr."runningRunId" as "runningRunId",
           rr."runningTrigger" as "runningTrigger",
           rr."runningStartedAt" as "runningStartedAt",
           rr."runningLastActivityAt" as "runningLastActivityAt",
           rr."runningStats" as "runningStats",
           rr."runningErrorSummary" as "runningErrorSummary",
           cr."lastCompletedRunId" as "lastCompletedRunId",
           cr."lastCompletedTrigger" as "lastCompletedTrigger",
           cr."lastCompletedStatus" as "lastCompletedStatus",
           cr."lastCompletedStartedAt" as "lastCompletedStartedAt",
           cr."lastCompletedFinishedAt" as "lastCompletedFinishedAt",
           cr."lastCompletedDurationMs" as "lastCompletedDurationMs",
           cr."lastCompletedStats" as "lastCompletedStats",
           cr."lastCompletedErrorSummary" as "lastCompletedErrorSummary",
           coalesce(rrc."recentRunningCount", 0)::int as "recentRunningCount",
           coalesce(rrc."recentSuccessCount", 0)::int as "recentSuccessCount",
           coalesce(rrc."recentPartialCount", 0)::int as "recentPartialCount",
           coalesce(rrc."recentFailedCount", 0)::int as "recentFailedCount",
           coalesce(rrc."recentSkippedCount", 0)::int as "recentSkippedCount",
           coalesce(rac."recent429Count", 0)::int as "recent429Count",
           coalesce(rac."recent5xxCount", 0)::int as "recent5xxCount",
           coalesce(rac."recentFailedAttemptCount", 0)::int as "recentFailedAttemptCount",
           coalesce(rac."recentRetryCount", 0)::int as "recentRetryCount",
           rac."last429At" as "last429At",
           rac."last5xxAt" as "last5xxAt",
           prl."providerNextAvailableAt" as "providerNextAvailableAt",
           prl."providerMinSpacingMs" as "providerMinSpacingMs"
    from page_streams ps
    left join ${syncStreamState} sss
      on sss.platform_account_id = ps."pageId"
     and sss.stream = ps."stream"
    left join ${syncCheckpoints} cp
      on cp.platform_account_id = ps."pageId"
     and cp.stream = ps."stream"
    left join running_runs rr
      on rr."pageId" = ps."pageId"
     and rr."stream" = ps."stream"
    left join completed_runs cr
      on cr."pageId" = ps."pageId"
     and cr."stream" = ps."stream"
    left join recent_run_counts rrc
      on rrc."pageId" = ps."pageId"
     and rrc."stream" = ps."stream"
    left join recent_attempt_counts rac
      on rac."pageId" = ps."pageId"
     and rac."stream" = ps."stream"
    left join provider_rate_limits prl on prl."platform" = ps."platform"
    left join fan_counts fc on fc."pageId" = ps."pageId"
    left join follower_counts foc on foc."pageId" = ps."pageId"
    left join subscriber_counts scnt on scnt."pageId" = ps."pageId"
    left join transaction_counts tc on tc."pageId" = ps."pageId"
    left join dm_conversation_counts dcc on dcc."pageId" = ps."pageId"
    left join dm_message_counts dmc on dmc."pageId" = ps."pageId"
    order by ps."pageLabel" asc, ${streamOrderSql('ps."stream"')} asc
  `);

  return result.rows.map((row) => normalizeSyncMonitorStreamRow(row));
}

export async function listSyncMonitorRecentEvents(
  db: Database,
  input?: {
    pageIds?: number[];
    pageLabel?: string;
    since?: Date;
    limit?: number;
  },
) {
  if (input?.pageIds !== undefined && input.pageIds.length === 0) {
    return [] as SyncMonitorRecentEventRow[];
  }

  const pageClauses = [sql`true`];
  if (input?.pageIds !== undefined) {
    pageClauses.push(inArray(platformAccounts.id, input.pageIds));
  }
  if (input?.pageLabel) {
    pageClauses.push(eq(platformAccounts.label, input.pageLabel));
  }

  const eventClauses = [sql`true`];
  if (input?.since) {
    eventClauses.push(sql`e.emitted_at >= ${input.since}`);
  }
  eventClauses.push(sql`e.event_type <> 'worker_heartbeat'`);

  const result = await db.execute<{
    id: NumericValue;
    runId: NumericValue;
    pageId: NumericValue;
    pageLabel: string;
    provider: unknown;
    stream: string;
    eventType: string;
    severity: "info" | "warn" | "error";
    message: string;
    details: Record<string, unknown>;
    emittedAt: Date | string;
  }>(sql`
    with visible_pages as (
      select ${platformAccounts.id} as "pageId",
             ${platformAccounts.label} as "pageLabel"
      from ${platformAccounts}
      where ${and(...pageClauses)}
    )
    select e.id as "id",
           e.sync_run_id as "runId",
           vp."pageId" as "pageId",
           vp."pageLabel" as "pageLabel",
           e.provider as "provider",
           e.stream as "stream",
           e.event_type as "eventType",
           e.severity as "severity",
           e.message as "message",
           e.details as "details",
           e.emitted_at as "emittedAt"
    from ${syncRunEvents} e
    inner join visible_pages vp on vp."pageId" = e.platform_account_id
    where ${and(...eventClauses)}
      and e.stream <> 'cleanup'
    order by e.emitted_at desc, e.id desc
    limit ${input?.limit ?? 50}
  `);

  return result.rows.map((row) => normalizeSyncMonitorRecentEventRow(row));
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

function dmMessageSyncEligibleSql(alias: string) {
  return sql`coalesce(${sql.raw(alias)}.metadata ->> ${FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_KEY}, '') = ''`;
}

export interface SyncMonitorStreamRow {
  pageId: number;
  pageLabel: string;
  platform: "fansly" | "onlyfans";
  modelSlug: string;
  modelName: string;
  username: string | null;
  displayName: string | null;
  fanCount: number;
  followerCount: number;
  subscriberCount: number;
  transactionCount: number;
  dmConversationCount: number;
  dmMessageCount: number;
  dmEligibleConversationCount: number;
  dmBackfillCompleteConversationCount: number;
  dmLaggingConversationCount: number;
  stream: SyncControlStream;
  targetStatus: SyncTargetStatus | null;
  cadenceSeconds: number | null;
  nextDueAt: Date | null;
  desiredRevision: number | null;
  satisfiedRevision: number | null;
  desiredAt: Date | null;
  backoffUntil: Date | null;
  lastEnqueuedAt: Date | null;
  lastStartedAt: Date | null;
  lastFinishedAt: Date | null;
  lastSucceededAt: Date | null;
  lastFailedAt: Date | null;
  consecutiveFailures: number;
  lastErrorCode: string | null;
  lastErrorSummary: string | null;
  checkpointCursorText: string | null;
  checkpointCursorTimestamp: Date | null;
  checkpointState: Record<string, unknown> | null;
  checkpointLastSuccessfulAt: Date | null;
  checkpointLastSuccessfulRunId: number | null;
  runningRunId: number | null;
  runningTrigger: string | null;
  runningStartedAt: Date | null;
  runningLastActivityAt: Date | null;
  runningStats: Record<string, unknown> | null;
  runningErrorSummary: string | null;
  lastCompletedRunId: number | null;
  lastCompletedTrigger: string | null;
  lastCompletedStatus: "success" | "partial" | "failed" | "skipped" | null;
  lastCompletedStartedAt: Date | null;
  lastCompletedFinishedAt: Date | null;
  lastCompletedDurationMs: number | null;
  lastCompletedStats: Record<string, unknown> | null;
  lastCompletedErrorSummary: string | null;
  recentRunningCount: number;
  recentSuccessCount: number;
  recentPartialCount: number;
  recentFailedCount: number;
  recentSkippedCount: number;
  recent429Count: number;
  recent5xxCount: number;
  recentFailedAttemptCount: number;
  recentRetryCount: number;
  last429At: Date | null;
  last5xxAt: Date | null;
  providerNextAvailableAt: Date | null;
  providerMinSpacingMs: number | null;
}

export interface SyncMonitorRecentEventRow {
  id: number;
  runId: number;
  pageId: number;
  pageLabel: string;
  provider: "fansly" | "onlyfans";
  stream: SyncControlStream;
  eventType: string;
  severity: "info" | "warn" | "error";
  message: string;
  details: Record<string, unknown>;
  emittedAt: Date;
}

function normalizeSyncMonitorStreamRow(row: {
  pageId: NumericValue;
  pageLabel: string;
  platform: unknown;
  modelSlug: string;
  modelName: string;
  username: string | null;
  displayName: string | null;
  fanCount: NumericValue;
  followerCount: NumericValue;
  subscriberCount: NumericValue;
  transactionCount: NumericValue;
  dmConversationCount: NumericValue;
  dmMessageCount: NumericValue;
  dmEligibleConversationCount: NumericValue;
  dmBackfillCompleteConversationCount: NumericValue;
  dmLaggingConversationCount: NumericValue;
  stream: string;
  targetStatus: string | null;
  cadenceSeconds: NumericValue;
  nextDueAt: TimestampValue;
  desiredRevision: NumericValue;
  satisfiedRevision: NumericValue;
  desiredAt: TimestampValue;
  backoffUntil: TimestampValue;
  lastEnqueuedAt: TimestampValue;
  lastStartedAt: TimestampValue;
  lastFinishedAt: TimestampValue;
  lastSucceededAt: TimestampValue;
  lastFailedAt: TimestampValue;
  consecutiveFailures: NumericValue;
  lastErrorCode: string | null;
  lastErrorSummary: string | null;
  checkpointCursorText: string | null;
  checkpointCursorTimestamp: TimestampValue;
  checkpointState: unknown;
  checkpointLastSuccessfulAt: TimestampValue;
  checkpointLastSuccessfulRunId: NumericValue;
  runningRunId: NumericValue;
  runningTrigger: string | null;
  runningStartedAt: TimestampValue;
  runningLastActivityAt: TimestampValue;
  runningStats: unknown;
  runningErrorSummary: string | null;
  lastCompletedRunId: NumericValue;
  lastCompletedTrigger: string | null;
  lastCompletedStatus: "success" | "partial" | "failed" | "skipped" | null;
  lastCompletedStartedAt: TimestampValue;
  lastCompletedFinishedAt: TimestampValue;
  lastCompletedDurationMs: NumericValue;
  lastCompletedStats: unknown;
  lastCompletedErrorSummary: string | null;
  recentRunningCount: NumericValue;
  recentSuccessCount: NumericValue;
  recentPartialCount: NumericValue;
  recentFailedCount: NumericValue;
  recentSkippedCount: NumericValue;
  recent429Count: NumericValue;
  recent5xxCount: NumericValue;
  recentFailedAttemptCount: NumericValue;
  recentRetryCount: NumericValue;
  last429At: TimestampValue;
  last5xxAt: TimestampValue;
  providerNextAvailableAt: TimestampValue;
  providerMinSpacingMs: NumericValue;
}): SyncMonitorStreamRow {
  const stream = asSyncAuditStream(row.stream);
  if (stream === "cleanup") {
    throw new Error("Sync monitor rows cannot contain cleanup stream");
  }

  return {
    pageId: normalizeNumber(row.pageId, "pageId"),
    pageLabel: row.pageLabel,
    platform: normalizePlatformValue(row.platform, "platform"),
    modelSlug: row.modelSlug,
    modelName: row.modelName,
    username: row.username ?? null,
    displayName: row.displayName ?? null,
    fanCount: normalizeNumber(row.fanCount, "fanCount"),
    followerCount: normalizeNumber(row.followerCount, "followerCount"),
    subscriberCount: normalizeNumber(row.subscriberCount, "subscriberCount"),
    transactionCount: normalizeNumber(row.transactionCount, "transactionCount"),
    dmConversationCount: normalizeNumber(row.dmConversationCount, "dmConversationCount"),
    dmMessageCount: normalizeNumber(row.dmMessageCount, "dmMessageCount"),
    dmEligibleConversationCount: normalizeNumber(
      row.dmEligibleConversationCount,
      "dmEligibleConversationCount",
    ),
    dmBackfillCompleteConversationCount: normalizeNumber(
      row.dmBackfillCompleteConversationCount,
      "dmBackfillCompleteConversationCount",
    ),
    dmLaggingConversationCount: normalizeNumber(
      row.dmLaggingConversationCount,
      "dmLaggingConversationCount",
    ),
    stream,
    targetStatus: row.targetStatus ? row.targetStatus as SyncTargetStatus : null,
    cadenceSeconds: normalizeNullableNumber(row.cadenceSeconds, "cadenceSeconds"),
    nextDueAt: parseTimestamp(row.nextDueAt, "nextDueAt"),
    desiredRevision: normalizeNullableNumber(row.desiredRevision, "desiredRevision"),
    satisfiedRevision: normalizeNullableNumber(row.satisfiedRevision, "satisfiedRevision"),
    desiredAt: parseTimestamp(row.desiredAt, "desiredAt"),
    backoffUntil: parseTimestamp(row.backoffUntil, "backoffUntil"),
    lastEnqueuedAt: parseTimestamp(row.lastEnqueuedAt, "lastEnqueuedAt"),
    lastStartedAt: parseTimestamp(row.lastStartedAt, "lastStartedAt"),
    lastFinishedAt: parseTimestamp(row.lastFinishedAt, "lastFinishedAt"),
    lastSucceededAt: parseTimestamp(row.lastSucceededAt, "lastSucceededAt"),
    lastFailedAt: parseTimestamp(row.lastFailedAt, "lastFailedAt"),
    consecutiveFailures: normalizeNumber(row.consecutiveFailures, "consecutiveFailures"),
    lastErrorCode: row.lastErrorCode ?? null,
    lastErrorSummary: row.lastErrorSummary ?? null,
    checkpointCursorText: row.checkpointCursorText ?? null,
    checkpointCursorTimestamp: parseTimestamp(
      row.checkpointCursorTimestamp,
      "checkpointCursorTimestamp",
    ),
    checkpointState: normalizeNullableJsonRecord(row.checkpointState, "checkpointState"),
    checkpointLastSuccessfulAt: parseTimestamp(
      row.checkpointLastSuccessfulAt,
      "checkpointLastSuccessfulAt",
    ),
    checkpointLastSuccessfulRunId: normalizeNullableNumber(
      row.checkpointLastSuccessfulRunId,
      "checkpointLastSuccessfulRunId",
    ),
    runningRunId: normalizeNullableNumber(row.runningRunId, "runningRunId"),
    runningTrigger: row.runningTrigger ?? null,
    runningStartedAt: parseTimestamp(row.runningStartedAt, "runningStartedAt"),
    runningLastActivityAt: parseTimestamp(row.runningLastActivityAt, "runningLastActivityAt"),
    runningStats: normalizeNullableJsonRecord(row.runningStats, "runningStats"),
    runningErrorSummary: row.runningErrorSummary ?? null,
    lastCompletedRunId: normalizeNullableNumber(row.lastCompletedRunId, "lastCompletedRunId"),
    lastCompletedTrigger: row.lastCompletedTrigger ?? null,
    lastCompletedStatus: row.lastCompletedStatus ?? null,
    lastCompletedStartedAt: parseTimestamp(
      row.lastCompletedStartedAt,
      "lastCompletedStartedAt",
    ),
    lastCompletedFinishedAt: parseTimestamp(
      row.lastCompletedFinishedAt,
      "lastCompletedFinishedAt",
    ),
    lastCompletedDurationMs: normalizeNullableNumber(
      row.lastCompletedDurationMs,
      "lastCompletedDurationMs",
    ),
    lastCompletedStats: normalizeNullableJsonRecord(
      row.lastCompletedStats,
      "lastCompletedStats",
    ),
    lastCompletedErrorSummary: row.lastCompletedErrorSummary ?? null,
    recentRunningCount: normalizeNumber(row.recentRunningCount, "recentRunningCount"),
    recentSuccessCount: normalizeNumber(row.recentSuccessCount, "recentSuccessCount"),
    recentPartialCount: normalizeNumber(row.recentPartialCount, "recentPartialCount"),
    recentFailedCount: normalizeNumber(row.recentFailedCount, "recentFailedCount"),
    recentSkippedCount: normalizeNumber(row.recentSkippedCount, "recentSkippedCount"),
    recent429Count: normalizeNumber(row.recent429Count, "recent429Count"),
    recent5xxCount: normalizeNumber(row.recent5xxCount, "recent5xxCount"),
    recentFailedAttemptCount: normalizeNumber(
      row.recentFailedAttemptCount,
      "recentFailedAttemptCount",
    ),
    recentRetryCount: normalizeNumber(row.recentRetryCount, "recentRetryCount"),
    last429At: parseTimestamp(row.last429At, "last429At"),
    last5xxAt: parseTimestamp(row.last5xxAt, "last5xxAt"),
    providerNextAvailableAt: parseTimestamp(
      row.providerNextAvailableAt,
      "providerNextAvailableAt",
    ),
    providerMinSpacingMs: normalizeNullableNumber(row.providerMinSpacingMs, "providerMinSpacingMs"),
  };
}

function normalizeSyncMonitorRecentEventRow(row: {
  id: NumericValue;
  runId: NumericValue;
  pageId: NumericValue;
  pageLabel: string;
  provider: unknown;
  stream: string;
  eventType: string;
  severity: "info" | "warn" | "error";
  message: string;
  details: Record<string, unknown>;
  emittedAt: Date | string;
}): SyncMonitorRecentEventRow {
  const stream = asSyncAuditStream(row.stream);
  if (stream === "cleanup") {
    throw new Error("Sync monitor events cannot contain cleanup stream");
  }

  return {
    id: normalizeNumber(row.id, "id"),
    runId: normalizeNumber(row.runId, "runId"),
    pageId: normalizeNumber(row.pageId, "pageId"),
    pageLabel: row.pageLabel,
    provider: normalizePlatformValue(row.provider, "provider"),
    stream,
    eventType: row.eventType,
    severity: row.severity,
    message: row.message,
    details: row.details ?? {},
    emittedAt: requireTimestamp(row.emittedAt, "emittedAt"),
  };
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
    await rebalanceSyncStreamPriorities(db, {
      platformAccountId: input?.platformAccountId,
      now,
    });
    return existingRows;
  }

  await db.insert(syncStreamState).values(values).onConflictDoNothing();
  await rebalanceSyncStreamPriorities(db, {
    platformAccountId: input?.platformAccountId,
    now,
  });
  return listSyncStreamStateRows(db, input?.platformAccountId !== undefined
    ? { platformAccountId: input.platformAccountId }
    : undefined);
}

export async function rebalanceSyncStreamPriorities(
  db: Database,
  input?: {
    platformAccountId?: number;
    now?: Date;
  },
) {
  const now = input?.now ?? new Date();
  const clauses = [sql`true`];
  if (input?.platformAccountId !== undefined) {
    clauses.push(sql`platform_account_id = ${input.platformAccountId}`);
  }

  await db.execute(sql`
    update sync_stream_state
    set base_priority = ${syncBasePriorityCaseSql("stream")},
        effective_priority = case
          when desired_revision > satisfied_revision
            then ${syncRequestedPriorityCaseSql("stream", "pending_reason")}
          else ${syncBasePriorityCaseSql("stream")}
        end,
        updated_at = ${now}
    where ${and(...clauses)}
  `);
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
    select sss.platform_account_id as "platformAccountId",
           pa.platform as "platform",
           max(sss.effective_priority)::int as "priority",
           min(sss.desired_at) as "desiredAt",
           pap.url as "proxyUrl"
    from sync_stream_state sss
    inner join platform_accounts pa on pa.id = sss.platform_account_id
    left join platform_account_proxies pap on pap.platform_account_id = sss.platform_account_id
    where sss.status = 'active'
      and sss.desired_revision > sss.satisfied_revision
      and sss.backoff_until <= ${now}
    group by sss.platform_account_id, pa.platform, pap.url
    order by max(sss.effective_priority) desc,
             min(sss.desired_at) asc nulls last,
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
      row.nextAvailableAt = normalizeRateLimitDate(row.nextAvailableAt);
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

function normalizeRateLimitDate(value: Date | string) {
  if (value instanceof Date) {
    return value;
  }

  const normalized = new Date(value);
  if (Number.isNaN(normalized.getTime())) {
    throw new Error(`Invalid sync provider rate-limit timestamp: ${String(value)}`);
  }

  return normalized;
}
