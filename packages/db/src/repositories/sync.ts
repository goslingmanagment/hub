import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";

import { FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_KEY } from "@agency_hub_core/shared";

import type { Database } from "../client.ts";
import {
  egressEndpoints,
  fanPages,
  models,
  pageDmConversations,
  pageDmMessages,
  pageFollows,
  pageSubscriptions,
  pageSyncCursors,
  pageSyncStates,
  pages,
  syncHttpAttempts,
  syncRateLimits,
  syncRawPayloads,
  syncRunEvents,
  syncRuns,
  transactions,
} from "../schema.ts";
import {
  SYNC_DOMAIN_POLICY,
  SYNC_STREAM_DEPENDENCIES,
  SYNC_STREAM_POLICY,
  getSyncStreamsForPlatform,
  resolvePageSyncPriority,
  type PageSyncStatus,
  type SyncRequestSource,
  type SyncStream,
} from "./page-sync.ts";
import { getPageSyncExecutionContext } from "./sync-context.ts";

type TimestampValue = Date | string | null | undefined;
type NumericValue = number | bigint | null | undefined;

export * from "./page-sync.ts";

export const SYNC_CONTROL_STREAMS = [...Object.keys(SYNC_STREAM_POLICY)] as SyncStream[];
export const SYNC_STREAM_CONFIG: Record<SyncStream, {
  stream: SyncStream;
  cadenceSeconds: number;
  basePriority: number;
  streamIndex: number;
}> = Object.fromEntries(
  Object.entries(SYNC_STREAM_POLICY).map(([stream, policy]) => [
    stream,
    {
      stream: stream as SyncStream,
      cadenceSeconds: policy.cadenceSeconds,
      basePriority: policy.basePriority,
      streamIndex: policy.streamIndex,
    },
  ]),
) as Record<SyncStream, {
  stream: SyncStream;
  cadenceSeconds: number;
  basePriority: number;
  streamIndex: number;
}>;
export const DM_SYNC_DEPENDENCY_STREAMS = [
  "light",
  "top_spenders",
  "transactions",
  "subscribers",
  "followers",
] as const satisfies readonly SyncStream[];

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

  throw new Error(`Expected ${field} to be numeric`);
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
    if (field === "retryAt") {
      return new Date(0);
    }

    throw new Error(`Expected ${field} to be a valid timestamp`);
  }

  return parsed;
}

function requireTimestamp(value: Date | string | null | undefined, field: string) {
  const parsed = parseTimestamp(value, field);
  if (!parsed) {
    throw new Error(`Expected ${field} to be present`);
  }

  return parsed;
}

function normalizePlatformValue(value: unknown, field: string) {
  if (value === "fansly" || value === "onlyfans") {
    return value;
  }

  throw new Error(`Expected ${field} to be a supported platform`);
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

function normalizeJsonRecord(value: unknown, field: string) {
  if (value === null || value === undefined) {
    return {};
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Expected ${field} to be an object`);
  }

  return value as Record<string, unknown>;
}

function asSyncStream(value: string): SyncStream {
  if ((SYNC_CONTROL_STREAMS as readonly string[]).includes(value)) {
    return value as SyncStream;
  }

  throw new Error(`Unsupported sync stream "${value}"`);
}

function normalizeOutcomeStatus(outcome: "running" | "succeeded" | "partial" | "failed" | "skipped") {
  if (outcome === "succeeded") {
    return "success" as const;
  }

  return outcome;
}

function normalizeStatusOutcome(status: "success" | "partial" | "failed" | "skipped") {
  if (status === "success") {
    return "succeeded" as const;
  }

  return status;
}

function normalizeTriggerToSource(trigger: string | null | undefined): SyncRequestSource | null {
  switch (trigger) {
    case "scheduled":
    case "manual":
    case "onboarding":
    case "recovery":
    case "anomaly":
    case "reset":
      return trigger;
    case "worker":
      return "scheduled";
    case "cli":
      return "manual";
    default:
      return null;
  }
}

function renderSourceAsTrigger(source: SyncRequestSource | null | undefined) {
  return source ?? "scheduled";
}

function computeNextDueAt(state: {
  cadenceSeconds: number;
  slotOffsetSeconds: number;
  lastScheduledSlot: number;
}) {
  return new Date(((state.lastScheduledSlot + 1) * state.cadenceSeconds + state.slotOffsetSeconds) * 1000);
}

export function computeSyncStreamSlotOffsetSeconds(
  platformAccountId: number,
  stream: SyncStream,
) {
  const policy = SYNC_STREAM_POLICY[stream];
  return Number(
    ((BigInt(platformAccountId) * 2654435761n) + (BigInt(policy.streamIndex) * 2246822519n)) %
      BigInt(policy.cadenceSeconds),
  );
}

export function computeSyncStreamNextDueAt(
  input: {
    cadenceSeconds: number;
    slotOffsetSeconds: number;
    lastScheduledSlot: number;
  },
) {
  return computeNextDueAt(input);
}

export function resolveSyncRequestPriority(stream: SyncStream, reason: SyncRequestSource) {
  return resolvePageSyncPriority(stream, reason);
}

function streamArraySql(streams: readonly SyncStream[]) {
  if (streams.length === 0) {
    return sql`ARRAY[]::sync_stream[]`;
  }

  return sql`ARRAY[${sql.join(streams.map((stream) => sql`${stream}::sync_stream`), sql`, `)}]::sync_stream[]`;
}

function streamOrderSql(columnName: string) {
  return sql.raw(`
    case ${columnName}
      when 'light' then ${SYNC_STREAM_POLICY.light.streamIndex}
      when 'transactions' then ${SYNC_STREAM_POLICY.transactions.streamIndex}
      when 'fan_identities' then ${SYNC_STREAM_POLICY.fan_identities.streamIndex}
      when 'top_spenders' then ${SYNC_STREAM_POLICY.top_spenders.streamIndex}
      when 'subscribers' then ${SYNC_STREAM_POLICY.subscribers.streamIndex}
      when 'followers' then ${SYNC_STREAM_POLICY.followers.streamIndex}
      when 'followers_reconcile' then ${SYNC_STREAM_POLICY.followers_reconcile.streamIndex}
      when 'dm_conversations' then ${SYNC_STREAM_POLICY.dm_conversations.streamIndex}
      when 'dm_messages' then ${SYNC_STREAM_POLICY.dm_messages.streamIndex}
      else 999
    end
  `);
}

function dmMessageSyncEligibleSql(alias: string) {
  return sql`coalesce(${sql.raw(alias)}.metadata ->> ${FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_KEY}, '') = ''`;
}

export async function startSyncRun(
  db: Database,
  input: {
    platformAccountId: number;
    stream: SyncStream;
    trigger: string;
    generation?: number | null;
    leaseToken?: string | null;
    startedAt?: Date;
  },
) {
  const [run] = await db.insert(syncRuns).values({
    pageId: input.platformAccountId,
    requestSeq: input.generation ?? null,
    leasedSeq: input.generation ?? null,
    source: normalizeTriggerToSource(input.trigger),
    leaseToken: input.leaseToken ?? null,
    stream: input.stream,
    outcome: "running",
    startedAt: input.startedAt ?? new Date(),
  }).returning();

  return run;
}

export async function finishSyncRun(
  db: Database,
  runId: number,
  input: {
    status: "success" | "partial" | "failed" | "skipped";
    stats?: Record<string, unknown>;
    errorSummary?: string | null;
    finishedAt?: Date;
  },
) {
  const [run] = await db.update(syncRuns).set({
    outcome: normalizeStatusOutcome(input.status),
    stats: input.stats ?? {},
    errorSummary: input.errorSummary ?? null,
    finishedAt: input.finishedAt ?? new Date(),
  }).where(eq(syncRuns.id, runId)).returning();

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
  const result = await db.execute<{ outcome: "failed" | "partial" }>(sql`
    with orphaned_runs as (
      select sr.id,
             case
               when exists (
                 select 1
                 from ${syncRunEvents} e
                 where e.sync_run_id = sr.id
                   and e.event_type = 'checkpoint_advanced'
               )
               then 'partial'::sync_run_outcome
               else 'failed'::sync_run_outcome
             end as next_outcome
      from ${syncRuns} sr
      where sr.outcome = 'running'
        and sr.started_at < ${input.startedBefore}
        and not exists (
          select 1
          from ${pageSyncStates} st
          where st.page_id = sr.page_id
            and st.stream = sr.stream
            and st.status = 'running'
            and st.leased_seq is not distinct from sr.leased_seq
            and st.lease_token is not distinct from sr.lease_token
            and st.lease_expires_at >= ${input.finishedAt}
        )
    )
    update ${syncRuns} sr
    set outcome = orphaned_runs.next_outcome,
        error_summary = ${input.errorSummary},
        finished_at = ${input.finishedAt}
    from orphaned_runs
    where sr.id = orphaned_runs.id
    returning sr.outcome as "outcome"
  `);

  const failedCount = result.rows.filter((row) => row.outcome === "failed").length;
  const partialCount = result.rows.filter((row) => row.outcome === "partial").length;

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
  const result = await db.execute<{ outcome: "failed" | "partial" }>(sql`
    with request_activity as (
      select a.sync_run_id as "runId",
             max(coalesce(a.finished_at, a.started_at)) as "lastAttemptAt"
      from ${syncHttpAttempts} a
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
               then 'partial'::sync_run_outcome
               else 'failed'::sync_run_outcome
             end as next_outcome
      from ${syncRuns} sr
      left join request_activity ra on ra."runId" = sr.id
      left join event_activity ea on ea."runId" = sr.id
      where sr.outcome = 'running'
        and greatest(
          sr.started_at,
          coalesce(ra."lastAttemptAt", sr.started_at),
          coalesce(ea."lastEventAt", sr.started_at)
        ) < ${input.inactiveBefore}
    )
    update ${syncRuns} sr
    set outcome = inactive_runs.next_outcome,
        error_summary = ${input.errorSummary},
        finished_at = ${input.finishedAt}
    from inactive_runs
    where sr.id = inactive_runs.id
    returning sr.outcome as "outcome"
  `);

  const failedCount = result.rows.filter((row) => row.outcome === "failed").length;
  const partialCount = result.rows.filter((row) => row.outcome === "partial").length;

  return {
    totalCount: failedCount + partialCount,
    failedCount,
    partialCount,
  };
}

export async function getCheckpoint(
  db: Database,
  platformAccountId: number,
  stream: SyncStream,
) {
  return (await db.query.pageSyncCursors.findFirst({
    where: and(
      eq(pageSyncCursors.pageId, platformAccountId),
      eq(pageSyncCursors.stream, stream),
    ),
  })) ?? null;
}

async function upsertCheckpointRow(
  db: Database,
  input: {
    platformAccountId: number;
    stream: SyncStream;
    cursorText?: string | null;
    cursorTimestamp?: Date | null;
    state?: Record<string, unknown>;
    lastSuccessfulRunId?: number | null;
    touchSuccessMetadata: boolean;
    now: Date;
  },
) {
  const executionContext = getPageSyncExecutionContext();
  const hasLeaseContext = executionContext &&
    executionContext.pageId === input.platformAccountId &&
    executionContext.stream === input.stream;

  if (hasLeaseContext) {
    const result = await db.execute<{ owned: boolean }>(sql`
      with owned_task as (
        select leased_seq
        from ${pageSyncStates}
        where page_id = ${input.platformAccountId}
          and stream = ${input.stream}
          and lease_token = ${executionContext.leaseToken}
          and leased_seq = ${executionContext.requestSeq}
      ),
      checkpoint_upsert as (
        insert into ${pageSyncCursors} (
          page_id,
          stream,
          cursor_text,
          cursor_timestamp,
          cursor_seq,
          state,
          updated_at,
          last_succeeded_run_id,
          last_succeeded_at
        )
        select ${input.platformAccountId},
               ${input.stream},
               ${input.cursorText ?? null},
               ${input.cursorTimestamp ?? null},
               ${executionContext.requestSeq},
               ${input.state ?? {}},
               ${input.now},
               ${input.touchSuccessMetadata ? (input.lastSuccessfulRunId ?? null) : null},
               ${input.touchSuccessMetadata ? input.now : null}
        from owned_task
        on conflict (page_id, stream) do update
        set cursor_text = excluded.cursor_text,
            cursor_timestamp = excluded.cursor_timestamp,
            cursor_seq = excluded.cursor_seq,
            state = excluded.state,
            updated_at = excluded.updated_at,
            last_succeeded_run_id = case
              when ${input.touchSuccessMetadata}
                then excluded.last_succeeded_run_id
              else ${pageSyncCursors.cursorLastSucceededRunId}
            end,
            last_succeeded_at = case
              when ${input.touchSuccessMetadata}
                then excluded.last_succeeded_at
              else ${pageSyncCursors.cursorLastSucceededAt}
            end
        returning 1
      )
      select exists(select 1 from owned_task) as "owned"
      from checkpoint_upsert
    `);

    if (!result.rows[0]?.owned) {
      throw new Error(`Page sync lease lost for ${input.platformAccountId}:${input.stream}`);
    }
  } else {
    await db.insert(pageSyncCursors).values({
      pageId: input.platformAccountId,
      stream: input.stream,
      cursorText: input.cursorText ?? null,
      cursorTimestamp: input.cursorTimestamp ?? null,
      cursorSeq: null,
      state: input.state ?? {},
      updatedAt: input.now,
      cursorLastSucceededRunId: input.touchSuccessMetadata ? (input.lastSuccessfulRunId ?? null) : null,
      cursorLastSucceededAt: input.touchSuccessMetadata ? input.now : null,
    }).onConflictDoUpdate({
      target: [pageSyncCursors.pageId, pageSyncCursors.stream],
      set: {
        cursorText: input.cursorText ?? null,
        cursorTimestamp: input.cursorTimestamp ?? null,
        state: input.state ?? {},
        updatedAt: input.now,
        cursorLastSucceededRunId: input.touchSuccessMetadata
          ? (input.lastSuccessfulRunId ?? null)
          : sql`${pageSyncCursors.cursorLastSucceededRunId}`,
        cursorLastSucceededAt: input.touchSuccessMetadata
          ? input.now
          : sql`${pageSyncCursors.cursorLastSucceededAt}`,
      },
    });
  }

  return getCheckpoint(db, input.platformAccountId, input.stream);
}

export async function upsertCheckpoint(
  db: Database,
  input: {
    platformAccountId: number;
    stream: SyncStream;
    cursorText?: string | null;
    cursorTimestamp?: Date | null;
    state?: Record<string, unknown>;
    lastSuccessfulRunId?: number | null;
  },
) {
  return upsertCheckpointRow(db, {
    ...input,
    touchSuccessMetadata: true,
    now: new Date(),
  });
}

export async function upsertCheckpointProgress(
  db: Database,
  input: {
    platformAccountId: number;
    stream: SyncStream;
    cursorText?: string | null;
    cursorTimestamp?: Date | null;
    state?: Record<string, unknown>;
  },
) {
  return upsertCheckpointRow(db, {
    ...input,
    touchSuccessMetadata: false,
    now: new Date(),
  });
}

export async function deleteCheckpoints(
  db: Database,
  input: {
    platformAccountId: number;
    streams: SyncStream[];
  },
) {
  if (input.streams.length === 0) {
    return;
  }

  await db.delete(pageSyncCursors).where(and(
    eq(pageSyncCursors.pageId, input.platformAccountId),
    inArray(pageSyncCursors.stream, input.streams),
  ));
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
  const executionContext = getPageSyncExecutionContext();
  await db.insert(syncRawPayloads).values({
    pageId: input.platformAccountId,
    syncRunId: input.syncRunId ?? null,
    stream: executionContext?.stream ?? null,
    requestSeq: executionContext?.requestSeq ?? null,
    source: null,
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
    stream: SyncStream;
    generation?: number | null;
    operation: string;
    logicalRequestId: string;
    attemptNumber: number;
    requestShape?: Record<string, unknown>;
    startedAt?: Date;
  },
) {
  const [attempt] = await db.insert(syncHttpAttempts).values({
    syncRunId: input.syncRunId,
    pageId: input.platformAccountId,
    requestSeq: input.generation ?? null,
    source: null,
    provider: input.provider,
    stream: input.stream,
    operation: input.operation,
    logicalRequestId: input.logicalRequestId,
    attemptNumber: input.attemptNumber,
    state: "started",
    requestShape: input.requestShape ?? {},
    responseShape: {},
    startedAt: input.startedAt ?? new Date(),
  }).returning();

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
  const [attempt] = await db.update(syncHttpAttempts).set({
    state: input.state,
    failureKind: input.failureKind ?? null,
    httpStatus: input.httpStatus ?? null,
    retryDelayMs: input.retryDelayMs ?? null,
    durationMs: input.durationMs ?? null,
    responseShape: input.responseShape ?? {},
    errorMessage: input.errorMessage ?? null,
    finishedAt: input.finishedAt ?? new Date(),
  }).where(eq(syncHttpAttempts.id, attemptId)).returning();

  return attempt;
}

export async function insertSyncRunEvent(
  db: Database,
  input: {
    syncRunId: number;
    platformAccountId: number;
    provider: "fansly" | "onlyfans";
    stream: SyncStream;
    generation?: number | null;
    leaseToken?: string | null;
    eventType: string;
    severity?: "info" | "warn" | "error";
    message: string;
    details?: Record<string, unknown>;
    emittedAt?: Date;
  },
) {
  const [event] = await db.insert(syncRunEvents).values({
    syncRunId: input.syncRunId,
    pageId: input.platformAccountId,
    requestSeq: input.generation ?? null,
    source: null,
    leaseToken: input.leaseToken ?? null,
    provider: input.provider,
    stream: input.stream,
    eventType: input.eventType,
    severity: input.severity ?? "info",
    message: input.message,
    details: input.details ?? {},
    emittedAt: input.emittedAt ?? new Date(),
  }).returning();

  return event;
}

export async function deleteExpiredRawPayloads(db: Database, now = new Date()) {
  return db.delete(syncRawPayloads).where(lt(syncRawPayloads.retainUntil, now));
}

export async function deleteExpiredSyncObservability(db: Database, cutoff: Date) {
  const [deletedAttempts, deletedEvents] = await Promise.all([
    db.delete(syncHttpAttempts).where(lt(sql`coalesce(${syncHttpAttempts.finishedAt}, ${syncHttpAttempts.startedAt})`, cutoff)),
    db.delete(syncRunEvents).where(lt(syncRunEvents.emittedAt, cutoff)),
  ]);

  return { deletedAttempts, deletedEvents };
}

type SyncRunRow = {
  runId: NumericValue;
  platformAccountId: NumericValue;
  pageLabel: string;
  platform: "fansly" | "onlyfans";
  stream: string;
  trigger: string;
  status: "running" | "success" | "partial" | "failed" | "skipped";
  startedAt: Date | string;
  finishedAt: TimestampValue;
  errorSummary: string | null;
  stats: Record<string, unknown>;
};

function normalizeSyncRunRow<T extends SyncRunRow>(row: T): Omit<T, "startedAt" | "finishedAt" | "stream"> & {
  runId: number;
  platformAccountId: number;
  stream: SyncStream;
  startedAt: Date;
  finishedAt: Date | null;
} {
  return {
    ...row,
    runId: normalizeNumber(row.runId, "runId"),
    platformAccountId: normalizeNumber(row.platformAccountId, "platformAccountId"),
    stream: asSyncStream(row.stream),
    startedAt: requireTimestamp(row.startedAt, "startedAt"),
    finishedAt: parseTimestamp(row.finishedAt, "finishedAt"),
  };
}

function normalizeRunningSyncRunRow<T extends SyncRunRow & { lastActivityAt: TimestampValue }>(
  row: T,
) {
  return {
    ...normalizeSyncRunRow(row),
    lastActivityAt: requireTimestamp(row.lastActivityAt, "lastActivityAt"),
  };
}

function normalizeSyncRunEventRow<T extends {
  id: NumericValue;
  runId: NumericValue;
  platformAccountId: NumericValue;
  pageLabel: string;
  provider: unknown;
  stream: string;
  eventType: string;
  severity: "info" | "warn" | "error";
  message: string;
  details: Record<string, unknown>;
  emittedAt: Date | string;
}>(row: T) {
  return {
    ...row,
    id: normalizeNumber(row.id, "id"),
    runId: normalizeNumber(row.runId, "runId"),
    platformAccountId: normalizeNumber(row.platformAccountId, "platformAccountId"),
    provider: normalizePlatformValue(row.provider, "provider"),
    stream: asSyncStream(row.stream),
    emittedAt: requireTimestamp(row.emittedAt, "emittedAt"),
  };
}

function normalizeSyncRequestAttemptRow<T extends {
  attemptId: NumericValue;
  runId: NumericValue;
  platformAccountId: NumericValue;
  pageLabel: string;
  provider: unknown;
  stream: string;
  operation: string;
  logicalRequestId: string;
  attemptNumber: number;
  state: "started" | "success" | "retry" | "failed";
  failureKind: "timeout" | "transport" | "http" | "provider" | null;
  httpStatus: number | null;
  retryDelayMs: number | null;
  durationMs: number | null;
  requestShape: unknown;
  responseShape: unknown;
  errorMessage: string | null;
  startedAt: Date | string;
  finishedAt: TimestampValue;
}>(row: T) {
  return {
    ...row,
    attemptId: normalizeNumber(row.attemptId, "attemptId"),
    runId: normalizeNumber(row.runId, "runId"),
    platformAccountId: normalizeNumber(row.platformAccountId, "platformAccountId"),
    provider: normalizePlatformValue(row.provider, "provider"),
    stream: asSyncStream(row.stream),
    requestShape: normalizeNullableJsonRecord(row.requestShape, "requestShape"),
    responseShape: normalizeNullableJsonRecord(row.responseShape, "responseShape"),
    startedAt: requireTimestamp(row.startedAt, "startedAt"),
    finishedAt: parseTimestamp(row.finishedAt, "finishedAt"),
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
    clauses.push(sql`sr.page_id = ${input.platformAccountId}`);
  }
  if (input?.since) {
    clauses.push(sql`sr.started_at >= ${input.since}`);
  }

  const result = await db.execute<SyncRunRow>(sql`
    select sr.id as "runId",
           sr.page_id as "platformAccountId",
           p.label as "pageLabel",
           p.platform as "platform",
           sr.stream as "stream",
           coalesce(sr.source::text, 'scheduled') as "trigger",
           case
             when sr.outcome = 'succeeded' then 'success'
             else sr.outcome::text
           end as "status",
           sr.started_at as "startedAt",
           sr.finished_at as "finishedAt",
           sr.error_summary as "errorSummary",
           sr.stats as "stats"
    from ${syncRuns} sr
    inner join ${pages} p on p.id = sr.page_id
    where ${and(...clauses)}
    order by sr.started_at desc, sr.id desc
    limit ${input?.limit ?? 20}
  `);

  return result.rows.map((row) => normalizeSyncRunRow(row));
}

export async function getSyncRun(db: Database, runId: number) {
  const result = await db.execute<SyncRunRow>(sql`
    select sr.id as "runId",
           sr.page_id as "platformAccountId",
           p.label as "pageLabel",
           p.platform as "platform",
           sr.stream as "stream",
           coalesce(sr.source::text, 'scheduled') as "trigger",
           case
             when sr.outcome = 'succeeded' then 'success'
             else sr.outcome::text
           end as "status",
           sr.started_at as "startedAt",
           sr.finished_at as "finishedAt",
           sr.error_summary as "errorSummary",
           sr.stats as "stats"
    from ${syncRuns} sr
    inner join ${pages} p on p.id = sr.page_id
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
  const clauses = [sql`true`, sql`e.event_type <> 'worker_heartbeat'`];
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
    clauses.push(sql`e.page_id = ${input.platformAccountId}`);
  }

  const result = await db.execute(sql`
    select e.id as "id",
           e.sync_run_id as "runId",
           e.page_id as "platformAccountId",
           p.label as "pageLabel",
           e.provider as "provider",
           e.stream as "stream",
           e.event_type as "eventType",
           e.severity as "severity",
           e.message as "message",
           e.details as "details",
           e.emitted_at as "emittedAt"
    from ${syncRunEvents} e
    inner join ${pages} p on p.id = e.page_id
    where ${and(...clauses)}
    order by e.id asc
    limit ${input.limit ?? 200}
  `);

  return result.rows.map((row) => normalizeSyncRunEventRow(row as any));
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
    clauses.push(sql`a.page_id = ${input.platformAccountId}`);
  }
  if (input.inFlightOnly) {
    clauses.push(sql`a.finished_at is null`);
  }

  const result = await db.execute(sql`
    select a.id as "attemptId",
           a.sync_run_id as "runId",
           a.page_id as "platformAccountId",
           p.label as "pageLabel",
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
    from ${syncHttpAttempts} a
    inner join ${pages} p on p.id = a.page_id
    where ${and(...clauses)}
    order by a.started_at asc, a.id asc
    limit ${input.limit ?? 1000}
  `);

  return result.rows.map((row) => normalizeSyncRequestAttemptRow(row as any));
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
    terminalState: "success" | "failed";
    httpStatus: number | null;
  }>(sql`
    with logical_requests as (
      select a.logical_request_id as "logicalRequestId",
             max(a.id) filter (where a.state in ('success', 'failed')) as "terminalAttemptId"
      from ${syncHttpAttempts} a
      where a.page_id = ${input.platformAccountId}
        and a.stream = 'dm_messages'
        and a.operation = 'messages'
        and a.request_shape ->> 'groupId' = ${input.platformConversationId}
      group by a.logical_request_id
    )
    select a.state as "terminalState",
           a.http_status as "httpStatus"
    from logical_requests lr
    inner join ${syncHttpAttempts} a on a.id = lr."terminalAttemptId"
    order by coalesce(a.finished_at, a.started_at) desc, a.id desc
    limit ${input.limit ?? 20}
  `);

  let streak = 0;
  for (const row of result.rows) {
    if (row.terminalState !== "failed") {
      break;
    }

    if (row.httpStatus === null || row.httpStatus < 500 || row.httpStatus >= 600) {
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
      from ${syncHttpAttempts} a
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

export async function listRunningSyncRuns(
  db: Database,
  input?: {
    platformAccountId?: number;
    limit?: number;
  },
) {
  const clauses = [sql`sr.outcome = 'running'`];
  if (input?.platformAccountId !== undefined) {
    clauses.push(sql`sr.page_id = ${input.platformAccountId}`);
  }

  const result = await db.execute<SyncRunRow & { lastActivityAt: TimestampValue }>(sql`
    with request_activity as (
      select sync_run_id,
             max(coalesce(finished_at, started_at)) as last_attempt_at
      from ${syncHttpAttempts}
      group by sync_run_id
    ),
    event_activity as (
      select sync_run_id,
             max(emitted_at) as last_event_at
      from ${syncRunEvents}
      group by sync_run_id
    )
    select sr.id as "runId",
           sr.page_id as "platformAccountId",
           p.label as "pageLabel",
           p.platform as "platform",
           sr.stream as "stream",
           coalesce(sr.source::text, 'scheduled') as "trigger",
           'running' as "status",
           sr.started_at as "startedAt",
           sr.finished_at as "finishedAt",
           sr.error_summary as "errorSummary",
           sr.stats as "stats",
           greatest(
             sr.started_at,
             coalesce(ra.last_attempt_at, sr.started_at),
             coalesce(ea.last_event_at, sr.started_at)
           ) as "lastActivityAt"
    from ${syncRuns} sr
    inner join ${pages} p on p.id = sr.page_id
    left join request_activity ra on ra.sync_run_id = sr.id
    left join event_activity ea on ea.sync_run_id = sr.id
    where ${and(...clauses)}
    order by sr.started_at asc, sr.id asc
    limit ${input?.limit ?? 20}
  `);

  return result.rows.map((row) => normalizeRunningSyncRunRow(row));
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
  stream: SyncStream;
  status: PageSyncStatus | null;
  blockerKind: string | null;
  cadenceSeconds: number | null;
  nextDueAt: Date | null;
  requestSeq: number | null;
  appliedSeq: number | null;
  requestedAt: Date | null;
  retryAt: Date | null;
  lastEnqueuedAt: Date | null;
  lastStartedAt: Date | null;
  lastFinishedAt: Date | null;
  succeededAt: Date | null;
  failedAt: Date | null;
  consecutiveFailures: number;
  lastErrorCode: string | null;
  lastErrorSummary: string | null;
  checkpointCursorText: string | null;
  checkpointCursorTimestamp: Date | null;
  checkpointState: Record<string, unknown> | null;
  cursorLastSucceededAt: Date | null;
  cursorLastSucceededRunId: number | null;
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
  stream: SyncStream;
  eventType: string;
  severity: "info" | "warn" | "error";
  message: string;
  details: Record<string, unknown>;
  emittedAt: Date;
}

function normalizeSyncMonitorStreamRow(row: Record<string, unknown>): SyncMonitorStreamRow {
  return {
    pageId: normalizeNumber(row.pageId as NumericValue, "pageId"),
    pageLabel: String(row.pageLabel ?? ""),
    platform: normalizePlatformValue(row.platform, "platform"),
    modelSlug: String(row.modelSlug ?? ""),
    modelName: String(row.modelName ?? ""),
    username: typeof row.username === "string" ? row.username : null,
    displayName: typeof row.displayName === "string" ? row.displayName : null,
    fanCount: normalizeNumber(row.fanCount as NumericValue, "fanCount"),
    followerCount: normalizeNumber(row.followerCount as NumericValue, "followerCount"),
    subscriberCount: normalizeNumber(row.subscriberCount as NumericValue, "subscriberCount"),
    transactionCount: normalizeNumber(row.transactionCount as NumericValue, "transactionCount"),
    dmConversationCount: normalizeNumber(row.dmConversationCount as NumericValue, "dmConversationCount"),
    dmMessageCount: normalizeNumber(row.dmMessageCount as NumericValue, "dmMessageCount"),
    dmEligibleConversationCount: normalizeNumber(row.dmEligibleConversationCount as NumericValue, "dmEligibleConversationCount"),
    dmBackfillCompleteConversationCount: normalizeNumber(row.dmBackfillCompleteConversationCount as NumericValue, "dmBackfillCompleteConversationCount"),
    dmLaggingConversationCount: normalizeNumber(row.dmLaggingConversationCount as NumericValue, "dmLaggingConversationCount"),
    stream: asSyncStream(String(row.stream ?? "")),
    status: row.status ? row.status as PageSyncStatus : null,
    blockerKind: typeof row.blockerKind === "string" ? row.blockerKind : null,
    cadenceSeconds: normalizeNullableNumber(row.cadenceSeconds as NumericValue, "cadenceSeconds"),
    nextDueAt: parseTimestamp(row.nextDueAt as TimestampValue, "nextDueAt"),
    requestSeq: normalizeNullableNumber(row.requestSeq as NumericValue, "requestSeq"),
    appliedSeq: normalizeNullableNumber(row.appliedSeq as NumericValue, "appliedSeq"),
    requestedAt: parseTimestamp(row.requestedAt as TimestampValue, "requestedAt"),
    retryAt: parseTimestamp(row.retryAt as TimestampValue, "retryAt"),
    lastEnqueuedAt: parseTimestamp(row.lastEnqueuedAt as TimestampValue, "lastEnqueuedAt"),
    lastStartedAt: parseTimestamp(row.lastStartedAt as TimestampValue, "lastStartedAt"),
    lastFinishedAt: parseTimestamp(row.lastFinishedAt as TimestampValue, "lastFinishedAt"),
    succeededAt: parseTimestamp(row.succeededAt as TimestampValue, "succeededAt"),
    failedAt: parseTimestamp(row.failedAt as TimestampValue, "failedAt"),
    consecutiveFailures: normalizeNumber(row.consecutiveFailures as NumericValue, "consecutiveFailures"),
    lastErrorCode: typeof row.lastErrorCode === "string" ? row.lastErrorCode : null,
    lastErrorSummary: typeof row.lastErrorSummary === "string" ? row.lastErrorSummary : null,
    checkpointCursorText: typeof row.checkpointCursorText === "string" ? row.checkpointCursorText : null,
    checkpointCursorTimestamp: parseTimestamp(row.checkpointCursorTimestamp as TimestampValue, "checkpointCursorTimestamp"),
    checkpointState: normalizeNullableJsonRecord(row.checkpointState, "checkpointState"),
    cursorLastSucceededAt: parseTimestamp(row.cursorLastSucceededAt as TimestampValue, "cursorLastSucceededAt"),
    cursorLastSucceededRunId: normalizeNullableNumber(row.cursorLastSucceededRunId as NumericValue, "cursorLastSucceededRunId"),
    runningRunId: normalizeNullableNumber(row.runningRunId as NumericValue, "runningRunId"),
    runningTrigger: typeof row.runningTrigger === "string" ? row.runningTrigger : null,
    runningStartedAt: parseTimestamp(row.runningStartedAt as TimestampValue, "runningStartedAt"),
    runningLastActivityAt: parseTimestamp(row.runningLastActivityAt as TimestampValue, "runningLastActivityAt"),
    runningStats: normalizeNullableJsonRecord(row.runningStats, "runningStats"),
    runningErrorSummary: typeof row.runningErrorSummary === "string" ? row.runningErrorSummary : null,
    lastCompletedRunId: normalizeNullableNumber(row.lastCompletedRunId as NumericValue, "lastCompletedRunId"),
    lastCompletedTrigger: typeof row.lastCompletedTrigger === "string" ? row.lastCompletedTrigger : null,
    lastCompletedStatus: row.lastCompletedStatus ? row.lastCompletedStatus as SyncMonitorStreamRow["lastCompletedStatus"] : null,
    lastCompletedStartedAt: parseTimestamp(row.lastCompletedStartedAt as TimestampValue, "lastCompletedStartedAt"),
    lastCompletedFinishedAt: parseTimestamp(row.lastCompletedFinishedAt as TimestampValue, "lastCompletedFinishedAt"),
    lastCompletedDurationMs: normalizeNullableNumber(row.lastCompletedDurationMs as NumericValue, "lastCompletedDurationMs"),
    lastCompletedStats: normalizeNullableJsonRecord(row.lastCompletedStats, "lastCompletedStats"),
    lastCompletedErrorSummary: typeof row.lastCompletedErrorSummary === "string" ? row.lastCompletedErrorSummary : null,
    recentRunningCount: normalizeNumber(row.recentRunningCount as NumericValue, "recentRunningCount"),
    recentSuccessCount: normalizeNumber(row.recentSuccessCount as NumericValue, "recentSuccessCount"),
    recentPartialCount: normalizeNumber(row.recentPartialCount as NumericValue, "recentPartialCount"),
    recentFailedCount: normalizeNumber(row.recentFailedCount as NumericValue, "recentFailedCount"),
    recentSkippedCount: normalizeNumber(row.recentSkippedCount as NumericValue, "recentSkippedCount"),
    recent429Count: normalizeNumber(row.recent429Count as NumericValue, "recent429Count"),
    recent5xxCount: normalizeNumber(row.recent5xxCount as NumericValue, "recent5xxCount"),
    recentFailedAttemptCount: normalizeNumber(row.recentFailedAttemptCount as NumericValue, "recentFailedAttemptCount"),
    recentRetryCount: normalizeNumber(row.recentRetryCount as NumericValue, "recentRetryCount"),
    last429At: parseTimestamp(row.last429At as TimestampValue, "last429At"),
    last5xxAt: parseTimestamp(row.last5xxAt as TimestampValue, "last5xxAt"),
    providerNextAvailableAt: parseTimestamp(row.providerNextAvailableAt as TimestampValue, "providerNextAvailableAt"),
    providerMinSpacingMs: normalizeNullableNumber(row.providerMinSpacingMs as NumericValue, "providerMinSpacingMs"),
  };
}

function normalizeSyncMonitorRecentEventRow(row: Record<string, unknown>): SyncMonitorRecentEventRow {
  return {
    id: normalizeNumber(row.id as NumericValue, "id"),
    runId: normalizeNumber(row.runId as NumericValue, "runId"),
    pageId: normalizeNumber(row.pageId as NumericValue, "pageId"),
    pageLabel: String(row.pageLabel ?? ""),
    provider: normalizePlatformValue(row.provider, "provider"),
    stream: asSyncStream(String(row.stream ?? "")),
    eventType: String(row.eventType ?? ""),
    severity: row.severity as "info" | "warn" | "error",
    message: String(row.message ?? ""),
    details: normalizeJsonRecord(row.details, "details"),
    emittedAt: requireTimestamp(row.emittedAt as TimestampValue, "emittedAt"),
  };
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
    return [];
  }

  const pageClauses = [sql`true`];
  if (input?.pageIds !== undefined) {
    pageClauses.push(inArray(pages.id, input.pageIds));
  }

  const requestClauses = [sql`true`];
  if (input?.since) {
    requestClauses.push(sql`a.started_at >= ${input.since}`);
  }

  const result = await db.execute(sql`
    with visible_pages as (
      select ${pages.id} as "pageId",
             ${pages.label} as "pageLabel"
      from ${pages}
      where ${and(...pageClauses)}
    )
    select a.id as "attemptId",
           a.sync_run_id as "runId",
           vp."pageId" as "pageId",
           a.page_id as "platformAccountId",
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
    from ${syncHttpAttempts} a
    inner join visible_pages vp on vp."pageId" = a.page_id
    left join ${pageDmConversations} c
      on c.platform_account_id = a.page_id
     and c.platform_conversation_id = a.request_shape ->> 'groupId'
    where ${and(...requestClauses)}
    order by a.started_at desc, a.id desc
    limit ${input?.limit ?? 100}
  `);

  return result.rows.map((row) => {
    const normalized = normalizeSyncRequestAttemptRow(row as any);
    return {
      ...normalized,
      pageId: normalizeNumber((row as any).pageId, "pageId"),
      partnerUsername: typeof (row as any).partnerUsername === "string" ? (row as any).partnerUsername : null,
      returnedItems: normalizeNullableNumber((row as any).returnedItems, "returnedItems"),
      syncDone: (row as any).syncDone ?? null,
    };
  });
}

export async function listSyncMonitorStreamRows(
  db: Database,
  input?: {
    pageIds?: number[];
    pageLabel?: string;
    windowStart?: Date;
    streams?: SyncStream[];
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
    pageClauses.push(inArray(pages.id, input.pageIds));
  }
  if (input?.pageLabel) {
    pageClauses.push(eq(pages.label, input.pageLabel));
  }

  const windowStart = input?.windowStart ?? new Date(Date.now() - 24 * 60 * 60 * 1000);
  const requestedStreams = input?.streams ?? SYNC_CONTROL_STREAMS;
  const requestedStreamsSql = streamArraySql(requestedStreams);
  const fanslyStreamsSql = streamArraySql(
    requestedStreams.filter((stream) => getSyncStreamsForPlatform("fansly").includes(stream)),
  );
  const onlyFansStreamsSql = streamArraySql(
    requestedStreams.filter((stream) => getSyncStreamsForPlatform("onlyfans").includes(stream)),
  );

  const result = await db.execute<Record<string, unknown>>(sql`
    with visible_pages as (
      select ${pages.id} as "pageId",
             ${pages.label} as "pageLabel",
             ${pages.platform} as "platform",
             ${pages.username} as "username",
             ${pages.displayName} as "displayName",
             ${models.slug} as "modelSlug",
             ${models.name} as "modelName",
             coalesce(${egressEndpoints.rateLimitScopeKey}, ${egressEndpoints.url}, 'direct') as "egressKey"
      from ${pages}
      inner join ${models} on ${models.id} = ${pages.modelId}
      left join ${egressEndpoints} on ${egressEndpoints.platformAccountId} = ${pages.id}
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
             vp."egressKey",
             s.stream::sync_stream as "stream"
      from visible_pages vp
      cross join lateral unnest(
        case
          when vp."platform" = 'fansly'
            then ${fanslyStreamsSql}
          else ${onlyFansStreamsSql}
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
                 and c.message_coverage_status in (
                   'complete'::dm_message_coverage_status,
                   'partial_window'::dm_message_coverage_status
                 )
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
      from ${syncHttpAttempts} a
      inner join visible_pages vp on vp."pageId" = a.page_id
      group by a.sync_run_id
    ),
    event_activity as (
      select e.sync_run_id as "runId",
             max(e.emitted_at) as "lastEventAt"
      from ${syncRunEvents} e
      inner join visible_pages vp on vp."pageId" = e.page_id
      group by e.sync_run_id
    ),
    running_runs as (
      select ranked.*
      from (
        select sr.page_id as "pageId",
               sr.stream as "stream",
               sr.id as "runningRunId",
               coalesce(sr.source::text, 'scheduled') as "runningTrigger",
               sr.started_at as "runningStartedAt",
               greatest(
                 sr.started_at,
                 coalesce(ra."lastAttemptAt", sr.started_at),
                 coalesce(ea."lastEventAt", sr.started_at)
               ) as "runningLastActivityAt",
               sr.stats as "runningStats",
               sr.error_summary as "runningErrorSummary",
               row_number() over (
                 partition by sr.page_id, sr.stream
                 order by sr.started_at desc, sr.id desc
               ) as "rank"
        from ${syncRuns} sr
        inner join visible_pages vp on vp."pageId" = sr.page_id
        left join request_activity ra on ra."runId" = sr.id
        left join event_activity ea on ea."runId" = sr.id
        where sr.outcome = 'running'
          and sr.stream = any(${requestedStreamsSql})
      ) ranked
      where ranked."rank" = 1
    ),
    completed_runs as (
      select ranked.*
      from (
        select sr.page_id as "pageId",
               sr.stream as "stream",
               sr.id as "lastCompletedRunId",
               coalesce(sr.source::text, 'scheduled') as "lastCompletedTrigger",
               case
                 when sr.outcome = 'succeeded' then 'success'
                 else sr.outcome::text
               end as "lastCompletedStatus",
               sr.started_at as "lastCompletedStartedAt",
               sr.finished_at as "lastCompletedFinishedAt",
               greatest(
                 0,
                 floor(extract(epoch from (sr.finished_at - sr.started_at)) * 1000)
               )::int as "lastCompletedDurationMs",
               sr.stats as "lastCompletedStats",
               sr.error_summary as "lastCompletedErrorSummary",
               row_number() over (
                 partition by sr.page_id, sr.stream
                 order by sr.finished_at desc, sr.id desc
               ) as "rank"
        from ${syncRuns} sr
        inner join visible_pages vp on vp."pageId" = sr.page_id
        where sr.outcome <> 'running'
          and sr.finished_at is not null
          and sr.stream = any(${requestedStreamsSql})
      ) ranked
      where ranked."rank" = 1
    ),
    recent_run_counts as (
      select sr.page_id as "pageId",
             sr.stream as "stream",
             count(*) filter (where sr.outcome = 'running')::int as "recentRunningCount",
             count(*) filter (where sr.outcome = 'succeeded')::int as "recentSuccessCount",
             count(*) filter (where sr.outcome = 'partial')::int as "recentPartialCount",
             count(*) filter (where sr.outcome = 'failed')::int as "recentFailedCount",
             count(*) filter (where sr.outcome = 'skipped')::int as "recentSkippedCount"
      from ${syncRuns} sr
      inner join visible_pages vp on vp."pageId" = sr.page_id
      where sr.started_at >= ${windowStart}
        and sr.stream = any(${requestedStreamsSql})
      group by sr.page_id, sr.stream
    ),
    recent_attempt_counts as (
      select a.page_id as "pageId",
             a.stream as "stream",
             count(*) filter (where a.http_status = 429)::int as "recent429Count",
             count(*) filter (where a.http_status >= 500 and a.http_status < 600)::int as "recent5xxCount",
             count(*) filter (where a.state = 'failed')::int as "recentFailedAttemptCount",
             count(*) filter (where a.state = 'retry')::int as "recentRetryCount",
             max(a.started_at) filter (where a.http_status = 429) as "last429At",
             max(a.started_at) filter (where a.http_status >= 500 and a.http_status < 600) as "last5xxAt"
      from ${syncHttpAttempts} a
      inner join visible_pages vp on vp."pageId" = a.page_id
      where a.started_at >= ${windowStart}
        and a.stream = any(${requestedStreamsSql})
      group by a.page_id, a.stream
    ),
    provider_rate_limits as (
      select rl.provider as "platform",
             rl.egress_key as "egressKey",
             max(rl.next_available_at) as "providerNextAvailableAt",
             max(rl.min_spacing_ms)::int as "providerMinSpacingMs"
      from ${syncRateLimits} rl
      group by rl.provider, rl.egress_key
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
           st.status as "status",
           st.blocker_kind as "blockerKind",
           st.cadence_seconds as "cadenceSeconds",
           to_timestamp(((st.last_scheduled_slot + 1) * st.cadence_seconds) + st.slot_offset_seconds) as "nextDueAt",
           st.request_seq as "requestSeq",
           st.applied_seq as "appliedSeq",
           st.requested_at as "requestedAt",
           st.retry_at as "retryAt",
           st.enqueued_at as "lastEnqueuedAt",
           st.started_at as "lastStartedAt",
           st.finished_at as "lastFinishedAt",
           st.succeeded_at as "succeededAt",
           st.failed_at as "failedAt",
           coalesce(st.consecutive_failures, 0)::int as "consecutiveFailures",
           st.last_error_code as "lastErrorCode",
           st.last_error_summary as "lastErrorSummary",
           cp.cursor_text as "checkpointCursorText",
           cp.cursor_timestamp as "checkpointCursorTimestamp",
           cp.state as "checkpointState",
           cp.last_succeeded_at as "cursorLastSucceededAt",
           cp.last_succeeded_run_id as "cursorLastSucceededRunId",
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
    left join ${pageSyncStates} st
      on st.page_id = ps."pageId"
     and st.stream::text = ps."stream"::text
    left join ${pageSyncCursors} cp
      on cp.page_id = ps."pageId"
     and cp.stream::text = ps."stream"::text
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
    left join provider_rate_limits prl
      on prl."platform" = ps."platform"
     and prl."egressKey" = ps."egressKey"
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
    return [];
  }

  const pageClauses = [sql`true`];
  if (input?.pageIds !== undefined) {
    pageClauses.push(inArray(pages.id, input.pageIds));
  }
  if (input?.pageLabel) {
    pageClauses.push(eq(pages.label, input.pageLabel));
  }

  const eventClauses = [sql`true`, sql`e.event_type <> 'worker_heartbeat'`];
  if (input?.since) {
    eventClauses.push(sql`e.emitted_at >= ${input.since}`);
  }

  const result = await db.execute<Record<string, unknown>>(sql`
    with visible_pages as (
      select ${pages.id} as "pageId",
             ${pages.label} as "pageLabel"
      from ${pages}
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
    inner join visible_pages vp on vp."pageId" = e.page_id
    where ${and(...eventClauses)}
    order by e.emitted_at desc, e.id desc
    limit ${input?.limit ?? 50}
  `);

  return result.rows.map((row) => normalizeSyncMonitorRecentEventRow(row));
}

export async function getLatestSyncRunPerPage(
  db: Database,
  pageIds: number[],
  input?: {
    stream?: SyncStream;
  },
) {
  if (pageIds.length === 0) {
    return [];
  }

  const clauses = [inArray(syncRuns.pageId, pageIds)];
  if (input?.stream) {
    clauses.push(eq(syncRuns.stream, input.stream));
  }

  const result = await db.execute(sql`
    select distinct on (${syncRuns.pageId})
           ${syncRuns.pageId} as "platformAccountId",
           ${syncRuns.id} as "runId",
           ${syncRuns.stream} as "stream",
           case
             when ${syncRuns.outcome} = 'succeeded' then 'success'
             else ${syncRuns.outcome}::text
           end as "status",
           coalesce(${syncRuns.source}::text, 'scheduled') as "trigger",
           ${syncRuns.startedAt} as "startedAt",
           ${syncRuns.finishedAt} as "finishedAt",
           ${syncRuns.errorSummary} as "errorSummary"
    from ${syncRuns}
    where ${and(...clauses)}
    order by ${syncRuns.pageId}, ${syncRuns.startedAt} desc, ${syncRuns.id} desc
  `);

  return result.rows.map((row) => ({
    ...row,
    platformAccountId: normalizeNumber((row as any).platformAccountId, "platformAccountId"),
    runId: normalizeNumber((row as any).runId, "runId"),
    stream: asSyncStream(String((row as any).stream ?? "")),
    status: String((row as any).status ?? ""),
    trigger: typeof (row as any).trigger === "string" ? (row as any).trigger : null,
    startedAt: requireTimestamp((row as any).startedAt, "startedAt"),
    finishedAt: parseTimestamp((row as any).finishedAt, "finishedAt"),
    errorSummary: typeof (row as any).errorSummary === "string" ? (row as any).errorSummary : null,
  }));
}

export async function updatePageSyncTimestampCache(
  db: Database,
  input: {
    pageId: number;
    syncType: "light" | "followers";
    now?: Date;
  },
) {
  const now = input.now ?? new Date();
  await db.update(pages).set(
    input.syncType === "light"
      ? { lastLightSyncAt: now, updatedAt: now }
      : { lastFollowerSyncAt: now, updatedAt: now },
  ).where(eq(pages.id, input.pageId));
}

export async function ensureSyncProviderRateLimitProfile(
  db: Database,
  input: {
    provider: "fansly" | "onlyfans";
    egressKey: string;
    scopes: Array<{ scope: string; minSpacingMs: number }>;
    now?: Date;
  },
) {
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
    insert into sync_rate_limits (
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

  return db.transaction(async (tx) => {
    const database = tx as unknown as Database;
    const lockedRows: Array<{
      provider: "fansly" | "onlyfans";
      scope: string;
      egressKey: string;
      minSpacingMs: number;
      nextAvailableAt: Date;
    }> = [];

    for (const scope of sortedScopes) {
      const result = await database.execute<{
        provider: "fansly" | "onlyfans";
        scope: string;
        egressKey: string;
        minSpacingMs: number;
        nextAvailableAt: Date | string;
      }>(sql`
        select provider as "provider",
               scope as "scope",
               egress_key as "egressKey",
               min_spacing_ms as "minSpacingMs",
               next_available_at as "nextAvailableAt"
        from sync_rate_limits
        where provider = ${scope.provider}
          and scope = ${scope.scope}
          and egress_key = ${scope.egressKey}
        for update
      `);

      const row = result.rows[0];
      if (!row) {
        throw new Error(`Missing sync rate-limit row for ${scope.provider}/${scope.scope}/${scope.egressKey}`);
      }

      lockedRows.push({
        ...row,
        nextAvailableAt: normalizeRateLimitDate(row.nextAvailableAt),
      });
    }

    const scheduledAt = lockedRows.reduce((current, row) =>
      row.nextAvailableAt > current ? row.nextAvailableAt : current, now);

    for (const row of lockedRows) {
      const nextAvailableAt = new Date(scheduledAt.getTime() + row.minSpacingMs);
      await database.execute(sql`
        update sync_rate_limits
        set next_available_at = ${nextAvailableAt},
            updated_at = ${now}
        where provider = ${row.provider}
          and scope = ${row.scope}
          and egress_key = ${row.egressKey}
      `);
    }

    return scheduledAt;
  });
}
