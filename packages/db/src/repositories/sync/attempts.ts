import { sql, type SQL } from "drizzle-orm";

import type { Database } from "../../client.ts";
import { OwnershipLostError } from "./pages.ts";
import type { SyncEngineWorkClass } from "./work.ts";
import {
  generationParam,
  jsonParam,
  timestampParam,
  toDate,
  toNumber,
  toRequiredDate,
} from "./values.ts";

// Fansly Sync Engine (plan §2.4, §8, §11; design §2.2, §3.3, §3.7): the
// journal of attempts — one row per physical request of a page (or per
// simulated one in shadow). An attempt is ADMITTED before anything is sent
// (tx 1), records its actual send instant and outcome, the observation that
// captured its raw response (tx 2), and its apply state (tx 3). The rows are
// the truth for the takeover floor (I5) and for the pace audit (§2.4
// "проверка, а не вера").

export const SYNC_ATTEMPT_OUTCOMES = [
  "admitted",
  "sent",
  "response",
  "transport_error",
  "timeout",
  "aborted_before_send",
  "unknown",
  "shadow",
] as const;
export type SyncAttemptOutcome = (typeof SYNC_ATTEMPT_OUTCOMES)[number];

export const SYNC_APPLY_STATES = ["none", "captured", "applied", "deferred", "quarantined", "skipped"] as const;
export type SyncApplyState = (typeof SYNC_APPLY_STATES)[number];

export const SYNC_SEND_MARKS = ["request_start", "completion_fallback", "shadow"] as const;
export type SyncSendMark = (typeof SYNC_SEND_MARKS)[number];

/** Admission issue → onRequestStart; a later send is refused (design §3.3).
 *  The takeover floor bounds an unsent admission by admitted_at + this. */
export const SYNC_SEND_WINDOW_MS = 15_000;
/** Unfinished attempts older than this cannot still be sending (≫ window + timeout). */
export const SYNC_FLOOR_LOOKBACK_MS = 600_000;
/** First send after a takeover ≥ this × S after every earlier send (I5). */
export const SYNC_TAKEOVER_FACTOR = 1.2;
/** How far before its window the pace audit looks for the page's previous
 *  send. A longer gap is far above the largest pause a page can be held to
 *  (`FANSLY_PAUSE_MAX_MS` = 60 s, × 1.2 at most with jitter or a takeover),
 *  so it can never be a pace violation; the bound keeps the audit's cost
 *  proportional to its window, not to the page's whole journal. */
export const SYNC_PACE_AUDIT_LOOKBACK_MS = 300_000;
/** Generic apply errors before the attempt and its work are quarantined (§3.7.3). */
export const SYNC_APPLY_FAILURES_TO_QUARANTINE = 3;

export interface SyncAttemptRow {
  id: number;
  pageId: number;
  shadow: boolean;
  workId: number | null;
  resource: string;
  subject: string;
  class: SyncEngineWorkClass;
  slot: number | null;
  ownerGeneration: bigint;
  demandRevision: number | null;
  settingMs: number;
  jitterU: number;
  pauseMs: number;
  admittedAt: Date;
  sentAt: Date | null;
  sendMark: SyncSendMark | null;
  sendMonoOffsetMs: number | null;
  gapPrevMs: number | null;
  completedAt: Date | null;
  operation: string;
  request: unknown;
  outcome: SyncAttemptOutcome;
  httpStatus: number | null;
  retryAfterMs: number | null;
  errorClass: string | null;
  durationMs: number | null;
  responseBytes: number | null;
  observationId: number | null;
  observationReceivedAt: Date | null;
  applyState: SyncApplyState;
  applyError: string | null;
  applyFailures: number;
  applyRetryAt: Date | null;
  appliedAt: Date | null;
  evidence: boolean;
}

type AttemptSqlRow = Omit<
  SyncAttemptRow,
  | "id" | "pageId" | "workId" | "ownerGeneration" | "demandRevision" | "admittedAt" | "sentAt" | "completedAt"
  | "observationId" | "observationReceivedAt" | "applyRetryAt" | "appliedAt"
> & {
  id: string;
  pageId: string;
  workId: string | null;
  ownerGeneration: string;
  demandRevision: string | null;
  admittedAt: Date | string;
  sentAt: Date | string | null;
  completedAt: Date | string | null;
  observationId: string | null;
  observationReceivedAt: Date | string | null;
  applyRetryAt: Date | string | null;
  appliedAt: Date | string | null;
};

const attemptColumns = sql`
  a.id::text as id,
  a.page_id::text as "pageId",
  a.shadow,
  a.work_id::text as "workId",
  a.resource,
  a.subject,
  a.class,
  a.slot,
  a.owner_generation::text as "ownerGeneration",
  a.demand_revision::text as "demandRevision",
  a.setting_ms as "settingMs",
  a.jitter_u as "jitterU",
  a.pause_ms as "pauseMs",
  a.admitted_at as "admittedAt",
  a.sent_at as "sentAt",
  a.send_mark as "sendMark",
  a.send_mono_offset_ms as "sendMonoOffsetMs",
  a.gap_prev_ms as "gapPrevMs",
  a.completed_at as "completedAt",
  a.operation,
  a.request,
  a.outcome,
  a.http_status as "httpStatus",
  a.retry_after_ms as "retryAfterMs",
  a.error_class as "errorClass",
  a.duration_ms as "durationMs",
  a.response_bytes as "responseBytes",
  a.observation_id::text as "observationId",
  a.observation_received_at as "observationReceivedAt",
  a.apply_state as "applyState",
  a.apply_error as "applyError",
  a.apply_failures as "applyFailures",
  a.apply_retry_at as "applyRetryAt",
  a.applied_at as "appliedAt",
  a.evidence
`;

function normalizeAttemptRow(row: AttemptSqlRow): SyncAttemptRow {
  return {
    ...row,
    id: Number(row.id),
    pageId: Number(row.pageId),
    shadow: row.shadow === true,
    workId: toNumber(row.workId),
    slot: toNumber(row.slot),
    ownerGeneration: BigInt(row.ownerGeneration),
    demandRevision: toNumber(row.demandRevision),
    settingMs: Number(row.settingMs),
    jitterU: Number(row.jitterU),
    pauseMs: Number(row.pauseMs),
    admittedAt: toRequiredDate(row.admittedAt),
    sentAt: toDate(row.sentAt),
    sendMonoOffsetMs: toNumber(row.sendMonoOffsetMs),
    gapPrevMs: toNumber(row.gapPrevMs),
    completedAt: toDate(row.completedAt),
    httpStatus: toNumber(row.httpStatus),
    retryAfterMs: toNumber(row.retryAfterMs),
    durationMs: toNumber(row.durationMs),
    responseBytes: toNumber(row.responseBytes),
    observationId: toNumber(row.observationId),
    observationReceivedAt: toDate(row.observationReceivedAt),
    applyFailures: Number(row.applyFailures),
    applyRetryAt: toDate(row.applyRetryAt),
    appliedAt: toDate(row.appliedAt),
    evidence: row.evidence === true,
  };
}

function boundedInt(value: number | null | undefined, max = 2_147_483_647): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(max, Math.trunc(value)));
}

// ── admission (tx 1) ──────────────────────────────────────────────────────────

export interface InsertAdmissionInput {
  pageId: number;
  shadow: boolean;
  workId: number;
  resource: string;
  subject: string;
  class: SyncEngineWorkClass;
  /** Position of the 10-slot cycle that admitted it (null outside the cycle). */
  slot: number | null;
  /** The cycle position the next pick starts from; null keeps it. */
  nextCyclePos: number | null;
  generation: bigint;
  /** `markWorkRunning`'s revision. */
  demandRevision: number;
  settingMs: number;
  jitterU: number;
  pauseMs: number;
  /** Wire spec id, e.g. `messages.page`. */
  operation: string;
  /** Request shape without secrets: `{path, query}`. */
  request: unknown;
  /** Coverage evidence (registry); a shadow attempt never is. */
  evidence: boolean;
}

/**
 * Admission, step 2 (tx 1, after `lockOwnedPage` and `markWorkRunning`): the
 * attempt row, the work's link to it, and the page's cycle pointer, last
 * admission and — for the planned class — its round-robin stamp, all under the
 * page's generation. Throws `OwnershipLostError` (rolling the caller's
 * transaction back) when the generation no longer owns the page.
 */
export async function insertAdmission(
  db: Database,
  input: InsertAdmissionInput,
): Promise<{ attemptId: number; admittedAt: Date }> {
  if (input.slot !== null && !(Number.isInteger(input.slot) && input.slot >= 0 && input.slot <= 9)) {
    throw new Error(`Cycle slot must be 0..9, received ${input.slot}`);
  }
  if (input.nextCyclePos !== null
    && !(Number.isInteger(input.nextCyclePos) && input.nextCyclePos >= 0 && input.nextCyclePos <= 9)) {
    throw new Error(`Cycle position must be 0..9, received ${input.nextCyclePos}`);
  }
  const result = await db.execute<{ attemptId: string; admittedAt: Date | string }>(sql`
    with page as (
      update sync_pages
         set cycle_pos = coalesce(${input.nextCyclePos}::smallint, cycle_pos),
             last_admitted_at = clock_timestamp(),
             planned_rr = case when ${input.class}::text = 'planned'
               then jsonb_set(planned_rr, array[${input.resource}::text], to_jsonb(clock_timestamp()))
               else planned_rr end,
             updated_at = clock_timestamp()
       where page_id = ${input.pageId}
         and owner_generation = ${generationParam(input.generation)}
      returning page_id
    ), attempt as (
      insert into sync_attempts (
        page_id, shadow, work_id, resource, subject, class, slot, owner_generation, demand_revision,
        setting_ms, jitter_u, pause_ms, operation, request, evidence
      )
      select page.page_id, ${input.shadow}::boolean, ${input.workId}::bigint, ${input.resource}::text,
             ${input.subject}::text, ${input.class}::text, ${input.slot}::smallint,
             ${generationParam(input.generation)}, ${input.demandRevision}::bigint,
             ${input.settingMs}::integer, ${input.jitterU}::double precision, ${input.pauseMs}::integer,
             ${input.operation}::text, ${jsonParam(input.request)},
             ${input.evidence}::boolean and not ${input.shadow}::boolean
        from page
      returning id, admitted_at
    ), work as (
      update sync_work w
         set last_attempt_id = attempt.id
        from attempt
       where w.id = ${input.workId}
      returning w.id
    )
    select attempt.id::text as "attemptId", attempt.admitted_at as "admittedAt"
      from attempt
  `);
  const row = result.rows[0];
  if (!row) {
    const current = await db.execute<{ generation: string }>(sql`
      select owner_generation::text as generation from sync_pages where page_id = ${input.pageId}
    `);
    const found = current.rows[0];
    throw new OwnershipLostError(input.pageId, input.generation, found ? BigInt(found.generation) : null);
  }
  return { attemptId: Number(row.attemptId), admittedAt: toRequiredDate(row.admittedAt) };
}

/** Best effort right after onRequestStart (never awaited by the send): the
 *  send instant, so a takeover after a crash sees it. Only an `admitted` row. */
export async function markAttemptSent(
  db: Database,
  input: { attemptId: number; sentAt: Date },
): Promise<boolean> {
  const result = await db.execute(sql`
    update sync_attempts
       set outcome = 'sent',
           sent_at = ${input.sentAt}::timestamptz
     where id = ${input.attemptId}
       and outcome = 'admitted'
  `);
  return (result.rowCount ?? 0) > 0;
}

// ── capture (tx 2) ────────────────────────────────────────────────────────────

export interface CaptureAttemptInput {
  attemptId: number;
  pageId: number;
  outcome: "response" | "transport_error" | "timeout";
  /** Whether the request reached onRequestStart (or the completion fallback). */
  sent: boolean;
  /** Wall clock of the send; for `completion_fallback` the completion instant. */
  sentAt: Date | null;
  sendMark: "request_start" | "completion_fallback" | null;
  /** Monotonic admission issue → send. */
  sendMonoOffsetMs?: number | null;
  /** Monotonic gap to this owner's previous send of the page. */
  gapPrevMs?: number | null;
  httpStatus?: number | null;
  retryAfterMs?: number | null;
  errorClass?: string | null;
  durationMs?: number | null;
  responseBytes?: number | null;
  /** The observation that journaled the raw response (live, 2xx and failed bodies). */
  observation?: { id: number; receivedAt: Date } | null;
  /** `captured`: an applicable 2xx; `none`: nothing to apply. */
  applyState: "captured" | "none";
}

export interface CaptureAttemptResult {
  /** False: the attempt was settled already (a repeated capture). */
  captured: boolean;
  /** `sync_pages.last_send_at` before this capture (any owner). */
  previousSendAt: Date | null;
  /** This send minus the previous recorded send of the page, ms; the caller
   *  compares it with the attempt's setting (alert 1 `pace_violation`). */
  paceGapMs: number | null;
}

/**
 * Capture (tx 2, live, after `lockOwnedPage`): the attempt's outcome, its
 * actual send instant and the observation of its raw response; when it was
 * sent, the page's `last_send_at` (never moved backwards),
 * `last_send_attempt_id` and `last_completed_at`. Idempotent: only an
 * `admitted`/`sent` attempt is settled.
 */
export async function captureAttempt(db: Database, input: CaptureAttemptInput): Promise<CaptureAttemptResult> {
  const observation = input.observation ?? null;
  const result = await db.execute<{ captured: number; previousSendAt: Date | string | null; sentAt: Date | string | null }>(sql`
    with prev as (
      select last_send_at from sync_pages where page_id = ${input.pageId}
    ), att as (
      update sync_attempts
         set outcome = ${input.outcome}::text,
             sent_at = case when ${input.sent}::boolean
               then coalesce(${timestampParam(input.sentAt)}, sent_at, clock_timestamp()) else sent_at end,
             send_mark = ${input.sent ? input.sendMark ?? "request_start" : null}::text,
             send_mono_offset_ms = ${input.sendMonoOffsetMs ?? null}::double precision,
             gap_prev_ms = ${input.gapPrevMs ?? null}::double precision,
             completed_at = clock_timestamp(),
             http_status = ${boundedInt(input.httpStatus, 32_767)}::smallint,
             retry_after_ms = ${boundedInt(input.retryAfterMs)}::integer,
             error_class = ${input.errorClass ?? null}::text,
             duration_ms = ${boundedInt(input.durationMs)}::integer,
             response_bytes = ${boundedInt(input.responseBytes)}::integer,
             observation_id = ${observation?.id ?? null}::bigint,
             observation_received_at = ${timestampParam(observation?.receivedAt)},
             apply_state = ${input.applyState}::text,
             apply_retry_at = case when ${input.applyState}::text = 'captured' then clock_timestamp() end
       where id = ${input.attemptId}
         and page_id = ${input.pageId}
         and not shadow
         and outcome in ('admitted', 'sent')
      returning id, sent_at
    ), page as (
      update sync_pages sp
         set last_send_at = greatest(coalesce(sp.last_send_at, '-infinity'::timestamptz), att.sent_at),
             last_send_attempt_id = att.id,
             last_completed_at = clock_timestamp(),
             updated_at = clock_timestamp()
        from att
       where sp.page_id = ${input.pageId}
         and ${input.sent}::boolean
         and att.sent_at is not null
      returning sp.page_id
    )
    select (select count(*) from att)::int as captured,
           (select last_send_at from prev) as "previousSendAt",
           (select sent_at from att) as "sentAt"
  `);
  const row = result.rows[0];
  const previousSendAt = toDate(row?.previousSendAt);
  const sentAt = toDate(row?.sentAt);
  const captured = Number(row?.captured ?? 0) > 0;
  return {
    captured,
    previousSendAt,
    paceGapMs: captured && input.sent && previousSendAt !== null && sentAt !== null
      ? sentAt.getTime() - previousSendAt.getTime()
      : null,
  };
}

/**
 * Settle an attempt that captured nothing: `aborted_before_send` (the send
 * check refused, no bytes), `shadow` (simulated: `send_mark='shadow'`, the
 * simulated send instant, apply `skipped`), or `unknown`. Never touches the
 * page's live send facts. Idempotent like the capture.
 */
export async function settleAttemptWithoutCapture(
  db: Database,
  input: {
    attemptId: number;
    outcome: "aborted_before_send" | "shadow" | "unknown";
    sentAt?: Date | null;
    sendMonoOffsetMs?: number | null;
    gapPrevMs?: number | null;
    errorClass?: string | null;
    durationMs?: number | null;
  },
): Promise<boolean> {
  const isShadow = input.outcome === "shadow";
  const result = await db.execute(sql`
    update sync_attempts
       set outcome = ${input.outcome}::text,
           send_mark = case when ${isShadow}::boolean then 'shadow' else send_mark end,
           sent_at = case when ${isShadow}::boolean then coalesce(${timestampParam(input.sentAt)}, clock_timestamp())
                          else sent_at end,
           send_mono_offset_ms = coalesce(${input.sendMonoOffsetMs ?? null}::double precision, send_mono_offset_ms),
           gap_prev_ms = coalesce(${input.gapPrevMs ?? null}::double precision, gap_prev_ms),
           error_class = coalesce(${input.errorClass ?? null}::text, error_class),
           duration_ms = coalesce(${boundedInt(input.durationMs)}::integer, duration_ms),
           completed_at = clock_timestamp(),
           apply_state = case when ${isShadow}::boolean then 'skipped' else apply_state end
     where id = ${input.attemptId}
       and outcome in ('admitted', 'sent')
       and (shadow = ${isShadow}::boolean or ${input.outcome}::text <> 'shadow')
  `);
  return (result.rowCount ?? 0) > 0;
}

// ── apply (tx 3) ──────────────────────────────────────────────────────────────

/** Apply done (tx 3's last statement). */
export async function markApplied(db: Database, input: { attemptId: number }): Promise<boolean> {
  const result = await db.execute(sql`
    update sync_attempts
       set apply_state = 'applied',
           applied_at = clock_timestamp(),
           apply_retry_at = null,
           apply_error = null
     where id = ${input.attemptId}
       and apply_state in ('captured', 'deferred')
  `);
  return (result.rowCount ?? 0) > 0;
}

/** A typed deferral or a transient error (§3.7.3): retried after `retryInMs`,
 *  not counted against the attempt. */
export async function markDeferred(
  db: Database,
  input: { attemptId: number; error: string; retryInMs: number },
): Promise<boolean> {
  const result = await db.execute(sql`
    update sync_attempts
       set apply_state = 'deferred',
           apply_error = ${input.error},
           apply_retry_at = clock_timestamp() + ${Math.max(0, input.retryInMs)}::double precision * interval '1 millisecond'
     where id = ${input.attemptId}
       and apply_state in ('captured', 'deferred')
  `);
  return (result.rowCount ?? 0) > 0;
}

/**
 * A failed apply that must be counted (§3.7.3). `deterministic` (a data or
 * contract error the same input hits every time) quarantines at once; any
 * other error defers with backoff and quarantines at the
 * `SYNC_APPLY_FAILURES_TO_QUARANTINE`-th failure. The work row is the caller's
 * (`quarantineWork`). Null: the attempt has nothing pending to apply.
 */
export async function recordApplyFailure(
  db: Database,
  input: { attemptId: number; error: string; retryInMs: number; deterministic: boolean; quarantineAfter?: number },
): Promise<{ failures: number; quarantined: boolean } | null> {
  const limit = Math.max(1, input.quarantineAfter ?? SYNC_APPLY_FAILURES_TO_QUARANTINE);
  const result = await db.execute<{ failures: number; applyState: string }>(sql`
    update sync_attempts
       set apply_failures = least(apply_failures + 1, 32767),
           apply_error = ${input.error},
           apply_state = case when ${input.deterministic}::boolean or apply_failures + 1 >= ${limit}::int
             then 'quarantined' else 'deferred' end,
           apply_retry_at = case when ${input.deterministic}::boolean or apply_failures + 1 >= ${limit}::int
             then null
             else clock_timestamp() + ${Math.max(0, input.retryInMs)}::double precision * interval '1 millisecond' end
     where id = ${input.attemptId}
       and apply_state in ('captured', 'deferred')
    returning apply_failures as failures, apply_state as "applyState"
  `);
  const row = result.rows[0];
  if (!row) return null;
  return { failures: Number(row.failures), quarantined: row.applyState === "quarantined" };
}

// ── recovery and reads ────────────────────────────────────────────────────────

/**
 * Unfinished attempts of a page: `send` = admitted or sent (no outcome yet),
 * `apply` = captured or deferred (live), `any` = both. `dueOnly` limits the
 * apply side to rows whose retry time passed (the actor's apply drain).
 */
export async function listUnfinishedAttempts(
  db: Database,
  input: { pageId: number; phase?: "send" | "apply" | "any"; dueOnly?: boolean; limit?: number },
): Promise<SyncAttemptRow[]> {
  const phase = input.phase ?? "any";
  const send = sql`a.outcome in ('admitted', 'sent')`;
  const apply = input.dueOnly === true
    ? sql`(a.apply_state in ('captured', 'deferred') and coalesce(a.apply_retry_at, '-infinity') <= clock_timestamp())`
    : sql`a.apply_state in ('captured', 'deferred')`;
  const predicate: SQL = phase === "send" ? send : phase === "apply" ? apply : sql`(${send} or ${apply})`;
  const result = await db.execute<AttemptSqlRow>(sql`
    select ${attemptColumns}
      from sync_attempts a
     where a.page_id = ${input.pageId}
       and ${predicate}
     order by ${input.dueOnly === true ? sql`a.apply_retry_at nulls first, a.id` : sql`a.id`}
     limit ${Math.max(1, Math.min(10_000, input.limit ?? 1_000))}
  `);
  return result.rows.map(normalizeAttemptRow);
}

export interface RecoverUnfinishedAttemptsResult {
  /** Live attempts admitted or sent by a previous run: outcome `unknown`. */
  unknown: number;
  /** Shadow attempts left admitted: closed as `shadow` (nothing was sent). */
  shadowClosed: number;
  /** Running work rows whose attempt ended without anything to apply: open again. */
  workReopened: number;
  /** Live captured/deferred applies made due now (applied before any admission). */
  appliesDue: number;
}

/**
 * Recovery at actor start (design §3.7.5), after `acquireSyncPageOwnership`
 * and inside the new generation's transaction: an unfinished live attempt
 * becomes `unknown` (the read is safe to repeat as a NEW attempt; the takeover
 * floor already covers its possible send), an admitted shadow attempt is
 * closed as `shadow`, running work without a pending apply opens again, and
 * pending applies are due now — "сбой между (3) и (4) доприменяется из
 * сохранённого ответа без нового HTTP".
 */
export async function recoverUnfinishedAttempts(
  db: Database,
  input: { pageId: number },
): Promise<RecoverUnfinishedAttemptsResult> {
  const result = await db.execute<{ unknown: number; shadowClosed: number; appliesDue: number }>(sql`
    with live_unknown as (
      update sync_attempts
         set outcome = 'unknown', completed_at = clock_timestamp()
       where page_id = ${input.pageId} and not shadow and outcome in ('admitted', 'sent')
      returning id
    ), shadow_closed as (
      update sync_attempts
         set outcome = 'shadow', send_mark = 'shadow', completed_at = clock_timestamp(), apply_state = 'skipped'
       where page_id = ${input.pageId} and shadow and outcome in ('admitted', 'sent')
      returning id
    ), applies_due as (
      update sync_attempts
         set apply_retry_at = clock_timestamp()
       where page_id = ${input.pageId} and not shadow and apply_state in ('captured', 'deferred')
      returning id
    )
    select (select count(*) from live_unknown)::int as unknown,
           (select count(*) from shadow_closed)::int as "shadowClosed",
           (select count(*) from applies_due)::int as "appliesDue"
  `);
  // A separate statement, so it sees the attempts settled above.
  const reopened = await db.execute(sql`
    update sync_work w
       set state = 'open',
           waiting_reason = null,
           waiting_until = null,
           updated_at = clock_timestamp()
     where w.page_id = ${input.pageId}
       and w.state = 'running'
       and not exists (
         select 1 from sync_attempts a
          where a.id = w.last_attempt_id
            and a.apply_state in ('captured', 'deferred')
       )
  `);
  const row = result.rows[0];
  return {
    unknown: Number(row?.unknown ?? 0),
    shadowClosed: Number(row?.shadowClosed ?? 0),
    workReopened: reopened.rowCount ?? 0,
    appliesDue: Number(row?.appliesDue ?? 0),
  };
}

/**
 * The takeover floor (I5, design §3.3), computed by the DATABASE clock: how
 * long from now until the first send of a new owner may happen, i.e.
 * max(now, last live send, last live completion, the send bound of every live
 * attempt of the last 10 minutes that may still be sending (sent_at, or
 * admitted_at + the send window), the legacy guard's last completion and — if
 * a legacy request holds the guard right now — its lease end) + 1.2 × S.
 */
export async function paceFloorFromDb(
  db: Database,
  input: { pageId: number; settingMs: number },
): Promise<number> {
  if (!(Number.isFinite(input.settingMs) && input.settingMs > 0)) {
    throw new Error(`paceFloorFromDb needs a positive setting, received ${input.settingMs}`);
  }
  const result = await db.execute<{ floorDelayMs: string }>(sql`
    select ceil(greatest(0, extract(epoch from (
             greatest(
               clock_timestamp(),
               coalesce(sp.last_send_at, '-infinity'::timestamptz),
               coalesce(sp.last_completed_at, '-infinity'::timestamptz),
               coalesce((
                 select max(coalesce(a.sent_at,
                   a.admitted_at + ${SYNC_SEND_WINDOW_MS}::double precision * interval '1 millisecond'))
                   from sync_attempts a
                  where a.page_id = sp.page_id
                    and not a.shadow
                    and a.admitted_at > clock_timestamp()
                      - ${SYNC_FLOOR_LOOKBACK_MS}::double precision * interval '1 millisecond'
                    and a.outcome in ('admitted', 'sent', 'unknown')
               ), '-infinity'::timestamptz),
               coalesce(g.last_completed_at, '-infinity'::timestamptz),
               coalesce(case when g.holder_token is not null then g.lease_until end, '-infinity'::timestamptz)
             )
             + ${input.settingMs * SYNC_TAKEOVER_FACTOR}::double precision * interval '1 millisecond'
             - clock_timestamp()
           )) * 1000))::bigint::text as "floorDelayMs"
      from sync_pages sp
      left join fansly_page_send_guards g on g.page_id = sp.page_id
     where sp.page_id = ${input.pageId}
  `);
  const row = result.rows[0];
  if (!row) throw new Error(`Fansly sync page ${input.pageId} has no sync_pages row`);
  return Number(row.floorDelayMs);
}

export interface SyncPaceAuditSend {
  attemptId: number;
  sentAt: Date;
  settingMs: number;
  ownerGeneration: bigint;
  /** Gap to the previous recorded send of the page (any owner), ms; null for
   *  the window's first send when no send precedes it within
   *  `SYNC_PACE_AUDIT_LOOKBACK_MS` before `since`. */
  gapMs: number | null;
}

/**
 * Every recorded send of a page in [since, until), in send order, each with
 * the gap to the previous send of the page (including the last one in the
 * `SYNC_PACE_AUDIT_LOOKBACK_MS` before `since`) — the pace audit of §2.4 and
 * alert 1. Live and shadow are separate journals (`shadow`). The look-back
 * bound keeps the search for that previous send an index range: the
 * `sync_attempts_page_sent` index does not carry `shadow`, so an unbounded
 * search on a page whose whole history is the other journal walks all of it.
 */
export async function listSendsForPaceAudit(
  db: Database,
  input: { pageId: number; since: Date; until?: Date | null; shadow?: boolean },
): Promise<SyncPaceAuditSend[]> {
  const shadow = input.shadow === true;
  const until = input.until === undefined || input.until === null ? sql`'infinity'::timestamptz` : sql`${input.until}::timestamptz`;
  const result = await db.execute<{
    attemptId: string;
    sentAt: Date | string;
    settingMs: number;
    ownerGeneration: string;
    gapMs: number | string | null;
  }>(sql`
    select s.id::text as "attemptId", s.sent_at as "sentAt", s.setting_ms as "settingMs",
           s.owner_generation::text as "ownerGeneration", s.gap_ms as "gapMs"
      from (
        select a.id, a.sent_at, a.setting_ms, a.owner_generation,
               extract(epoch from a.sent_at - lag(a.sent_at) over (order by a.sent_at, a.id)) * 1000 as gap_ms
          from sync_attempts a
         where a.page_id = ${input.pageId}
           and a.shadow = ${shadow}::boolean
           and a.sent_at is not null
           and a.sent_at >= coalesce((
             select max(b.sent_at) from sync_attempts b
              where b.page_id = ${input.pageId}
                and b.shadow = ${shadow}::boolean
                and b.sent_at < ${input.since}::timestamptz
                and b.sent_at >= ${input.since}::timestamptz
                  - ${SYNC_PACE_AUDIT_LOOKBACK_MS}::double precision * interval '1 millisecond'
           ), ${input.since}::timestamptz)
           and a.sent_at < ${until}
      ) s
     where s.sent_at >= ${input.since}::timestamptz
     order by s.sent_at, s.id
  `);
  return result.rows.map((row) => ({
    attemptId: Number(row.attemptId),
    sentAt: toRequiredDate(row.sentAt),
    settingMs: Number(row.settingMs),
    ownerGeneration: BigInt(row.ownerGeneration),
    gapMs: row.gapMs === null ? null : Number(row.gapMs),
  }));
}

/**
 * The apply's entry (tx 3, design §3.7.3): the attempt row locked `for
 * update` while it still has something to apply (`captured` / `deferred`).
 * Null when it was applied, quarantined or never captured — a repeated apply
 * is a no-op (idempotent re-entry).
 */
export async function lockAttemptForApply(db: Database, attemptId: number): Promise<SyncAttemptRow | null> {
  const result = await db.execute<AttemptSqlRow>(sql`
    select ${attemptColumns}
      from sync_attempts a
     where a.id = ${attemptId}
       and a.apply_state in ('captured', 'deferred')
       for update of a
  `);
  const row = result.rows[0];
  return row ? normalizeAttemptRow(row) : null;
}

/** Quarantine an attempt whose answer broke its contract (or whose apply
 *  failed for good): the raw answer stays journaled; the owner re-applies it
 *  from the journal after a fix (§9). */
export async function markAttemptQuarantined(
  db: Database,
  input: { attemptId: number; error: string },
): Promise<boolean> {
  const result = await db.execute(sql`
    update sync_attempts
       set apply_state = 'quarantined',
           apply_error = ${input.error},
           apply_retry_at = null
     where id = ${input.attemptId}
       and apply_state in ('none', 'captured', 'deferred')
  `);
  return (result.rowCount ?? 0) > 0;
}

/**
 * The newest 429 of a page before this outcome (the [A8] ladder decay), among
 * the attempts admitted within the last `withinMs`; null when there is none.
 * The bound keeps it a short range scan of `sync_attempts_page_admitted` (it
 * runs inside the capture transaction under the page row lock): the caller
 * passes its decay window plus the longest admission → completion span, so a
 * 429 outside the bound is one the ladder has already forgotten. The bound is
 * by `statement_timestamp()`: a volatile `clock_timestamp()` cannot bound an
 * index scan.
 */
export async function lastRateLimitAt(
  db: Database,
  input: { pageId: number; withinMs: number; excludeAttemptId?: number | null },
): Promise<Date | null> {
  const result = await db.execute<{ at: Date | string | null }>(sql`
    select max(coalesce(a.completed_at, a.admitted_at)) as at
      from sync_attempts a
     where a.page_id = ${input.pageId}
       and a.admitted_at > statement_timestamp() - ${Math.max(0, input.withinMs)}::double precision * interval '1 millisecond'
       and not a.shadow
       and a.http_status = 429
       -- A conversation-list 429 holds only the list (its own ladder): it
       -- never keeps the page's ladder up.
       and a.error_class is distinct from 'rate_limit_list'
       and a.id is distinct from ${input.excludeAttemptId ?? null}::bigint
  `);
  return toDate(result.rows[0]?.at);
}

/**
 * Distinct subjects of one resource file whose request failed as a subject
 * failure within the last `windowMs` (the §9 resource breaker counts them).
 * Keys a resource hold never stops are left out. Bounded by the stable
 * `statement_timestamp()` so the window is an index range, not the page's
 * whole journal.
 */
export async function countRecentFailedSubjects(
  db: Database,
  input: { pageId: number; file: string; windowMs: number; exemptKeys?: readonly string[] },
): Promise<number> {
  const result = await db.execute<{ subjects: number }>(sql`
    select count(distinct a.subject)::int as subjects
      from sync_attempts a
     where a.page_id = ${input.pageId}
       and not a.shadow
       and split_part(a.resource, '.', 1) = ${input.file}
       and not (a.resource = any(${sql.param([...(input.exemptKeys ?? [])])}::text[]))
       and a.error_class in ('subject_failure', 'envelope_unsuccessful')
       and a.admitted_at > statement_timestamp() - ${Math.max(0, input.windowMs)}::double precision * interval '1 millisecond'
  `);
  return Number(result.rows[0]?.subjects ?? 0);
}

export interface SyncSendCounts {
  urgent: number;
  requests: number;
  planned: number;
  byResource: Record<string, number>;
}

/** Sends of a page since `since` by class and by resource (status). Live and
 *  shadow are separate journals. */
export async function countSendsSince(
  db: Database,
  input: { pageId: number; since: Date; shadow: boolean },
): Promise<SyncSendCounts> {
  const result = await db.execute<{ class: SyncEngineWorkClass; resource: string; sends: number }>(sql`
    select a.class, a.resource, count(*)::int as sends
      from sync_attempts a
     where a.page_id = ${input.pageId}
       and a.shadow = ${input.shadow}::boolean
       and a.sent_at >= ${input.since}::timestamptz
     group by a.class, a.resource
  `);
  const counts: SyncSendCounts = { urgent: 0, requests: 0, planned: 0, byResource: {} };
  for (const row of result.rows) {
    const sends = Number(row.sends);
    counts[row.class] += sends;
    counts.byResource[row.resource] = (counts.byResource[row.resource] ?? 0) + sends;
  }
  return counts;
}

/** One attempt by id (status, the apply path). */
export async function getSyncAttempt(db: Database, attemptId: number): Promise<SyncAttemptRow | null> {
  const result = await db.execute<AttemptSqlRow>(sql`
    select ${attemptColumns} from sync_attempts a where a.id = ${attemptId}
  `);
  const row = result.rows[0];
  return row ? normalizeAttemptRow(row) : null;
}
