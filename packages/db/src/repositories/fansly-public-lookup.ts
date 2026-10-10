import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";

// The session-less public Fansly account reader's tables (arena "vanished
// chat" R5, plan §7; migration `*_fans_public_lookup.sql`):
//   - `fans.public_checked_at` / `fans.public_found` — its latest answer for a
//     fan, the one fact it writes on the fan (plus, on a found account, the
//     legacy deleted mark taken off: owner decision Р2 (а));
//   - `fansly_public_lookup_queue` — the fans the owner asked to be checked
//     once (`recheck-marks`);
//   - `fansly_public_lookup_state` — its stop and its answers.
// Its demand, its budget and its journal reads are here; the reader itself is
// apps/runtime/src/sync/fansly/public-lookup.ts. Nothing here sends anything.

/** The source the reader journals under in `fansly_send_log` (page_id null). */
export const FANSLY_PUBLIC_LOOKUP_SEND_SOURCE = "public_lookup";

/** Why the reader stopped (the state's CHECK). `indeterminate`: an attempt
 *  whose outcome nobody recorded (its process died mid-request) — it may have
 *  been sent, so it is never sent again on a guess. */
export const FANSLY_PUBLIC_LOOKUP_STOP_REASONS = ["rate_limited", "auth_refused", "network", "off_contract", "indeterminate"] as const;
export type FanslyPublicLookupStopReason = (typeof FANSLY_PUBLIC_LOOKUP_STOP_REASONS)[number];

/** Why a fan is asked about. */
export const FANSLY_PUBLIC_LOOKUP_DEMANDS = ["deleted_mark", "episode_partner", "page_lookup_miss"] as const;
export type FanslyPublicLookupDemand = (typeof FANSLY_PUBLIC_LOOKUP_DEMANDS)[number];

/** A derived demand (an episode's partner, a page's lookup miss) asks again
 *  only once the fan's latest check is older than this. */
export const FANSLY_PUBLIC_LOOKUP_RECHECK_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/** The reader's advisory lock `(58216, 1)` (two-int4 form: classid, objid,
 *  objsubid 2): one pass at a time across every process. 58211–58215 are
 *  taken. */
export const FANSLY_PUBLIC_LOOKUP_LOCK_NAMESPACE = 58_216;
export const FANSLY_PUBLIC_LOOKUP_LOCK_KEY = 1;

const FANSLY_ID = "^[0-9]{1,30}$";

export interface FanslyPublicLookupState {
  stoppedAt: Date | null;
  stopReason: FanslyPublicLookupStopReason | null;
  stopHttpStatus: number | null;
  stopDetail: string | null;
  /** No answer was ever accepted before the stop. */
  stopFirstBatch: boolean | null;
  /** When the owner's incident for this stop was confirmed open; null while
   *  the reader still has to open it. */
  stopIncidentAt: Date | null;
  retryNotBefore: Date | null;
  firstAnswerAt: Date | null;
  lastAnswerAt: Date | null;
  resumedAt: Date | null;
  /** The attempt admitted and not yet settled: while it is set nothing is
   *  sent; the next pass settles it from the journal. */
  pendingToken: string | null;
  pendingSince: Date | null;
  updatedAt: Date;
}

function date(value: Date | string | null): Date | null {
  return value === null ? null : new Date(value);
}

type StateSqlRow = {
  stoppedAt: Date | string | null;
  stopReason: FanslyPublicLookupStopReason | null;
  stopHttpStatus: number | null;
  stopDetail: string | null;
  stopFirstBatch: boolean | null;
  stopIncidentAt: Date | string | null;
  retryNotBefore: Date | string | null;
  firstAnswerAt: Date | string | null;
  lastAnswerAt: Date | string | null;
  resumedAt: Date | string | null;
  pendingToken: string | null;
  pendingSince: Date | string | null;
  updatedAt: Date | string;
};

/** The reader's state; `forUpdate` locks the row for the caller's transaction. */
export async function readFanslyPublicLookupState(
  db: Database,
  input: { forUpdate?: boolean } = {},
): Promise<FanslyPublicLookupState> {
  const result = await db.execute<StateSqlRow>(sql`
    select stopped_at as "stoppedAt", stop_reason as "stopReason", stop_http_status as "stopHttpStatus",
           stop_detail as "stopDetail", stop_first_batch as "stopFirstBatch", stop_incident_at as "stopIncidentAt",
           retry_not_before as "retryNotBefore", first_answer_at as "firstAnswerAt",
           last_answer_at as "lastAnswerAt", resumed_at as "resumedAt", pending_token::text as "pendingToken",
           pending_since as "pendingSince", updated_at as "updatedAt"
      from fansly_public_lookup_state
     where id = 1
     ${input.forUpdate === true ? sql`for update` : sql``}
  `);
  const row = result.rows[0];
  if (!row) throw new Error("fansly_public_lookup_state has no row (the migration seeds it)");
  return {
    stoppedAt: date(row.stoppedAt),
    stopReason: row.stopReason,
    stopHttpStatus: row.stopHttpStatus === null ? null : Number(row.stopHttpStatus),
    stopDetail: row.stopDetail,
    stopFirstBatch: row.stopFirstBatch,
    stopIncidentAt: date(row.stopIncidentAt),
    retryNotBefore: date(row.retryNotBefore),
    firstAnswerAt: date(row.firstAnswerAt),
    lastAnswerAt: date(row.lastAnswerAt),
    resumedAt: date(row.resumedAt),
    pendingToken: row.pendingToken,
    pendingSince: date(row.pendingSince),
    updatedAt: new Date(row.updatedAt),
  };
}

/** Whether THIS session holds the reader's advisory lock. Run on the lock's
 *  own connection: a dropped connection fails the statement instead. */
export async function holdsFanslyPublicLookupLock(db: Database): Promise<boolean> {
  const result = await db.execute<{ held: boolean }>(sql`
    select exists (
      select 1 from pg_locks l
       where l.locktype = 'advisory'
         and l.classid = ${FANSLY_PUBLIC_LOOKUP_LOCK_NAMESPACE}::oid
         and l.objid = ${FANSLY_PUBLIC_LOOKUP_LOCK_KEY}::oid
         and l.objsubid = 2
         and l.pid = pg_backend_pid()
         and l.granted
    ) as held
  `);
  return result.rows[0]?.held === true;
}

/** Mark the attempt `token` admitted (the caller's admission transaction,
 *  which journals it in `fansly_send_log` too). Refused — false — when an
 *  attempt is still pending or the reader is stopped. */
export async function markFanslyPublicLookupPending(tx: Database, input: { token: string; at: Date }): Promise<boolean> {
  const result = await tx.execute(sql`
    update fansly_public_lookup_state
       set pending_token = ${input.token}::uuid,
           pending_since = ${input.at},
           updated_at = clock_timestamp()
     where id = 1
       and pending_token is null
       and stopped_at is null
  `);
  return (result.rowCount ?? 0) > 0;
}

/** Settle the pending attempt `token` without an answer or a stop (nothing
 *  was sent). False when another settlement got there first. */
export async function clearFanslyPublicLookupPending(db: Database, input: { token: string }): Promise<boolean> {
  const result = await db.execute(sql`
    update fansly_public_lookup_state
       set pending_token = null,
           pending_since = null,
           updated_at = clock_timestamp()
     where id = 1
       and pending_token = ${input.token}::uuid
  `);
  return (result.rowCount ?? 0) > 0;
}

/**
 * Stop the reader (its first failure), settling the pending attempt `token`
 * in the same statement: the reason, the status, a detail, whether it was the
 * first batch, and the provider's Retry-After as `retry_not_before` (never
 * earlier than one already kept). The stop's incident is not confirmed yet
 * (`stop_incident_at` null). Null — nothing written — when the attempt was
 * settled already (another settlement got there first); else the stop instant
 * in force (the earlier stop's, when the reader was stopped already).
 */
export async function stopFanslyPublicLookup(
  db: Database,
  input: {
    token: string | null;
    at: Date;
    reason: FanslyPublicLookupStopReason;
    httpStatus: number | null;
    detail: string;
    firstBatch: boolean;
    retryNotBefore: Date | null;
  },
): Promise<Date | null> {
  const result = await db.execute<{ stoppedAt: Date | string }>(sql`
    update fansly_public_lookup_state
       set stopped_at = coalesce(stopped_at, ${input.at}),
           stop_reason = coalesce(stop_reason, ${input.reason}),
           stop_http_status = case when stopped_at is null then ${input.httpStatus}::int else stop_http_status end,
           stop_detail = coalesce(stop_detail, ${input.detail.slice(0, 2000)}),
           stop_first_batch = coalesce(stop_first_batch, ${input.firstBatch}),
           retry_not_before = case
             when ${input.retryNotBefore}::timestamptz is null then retry_not_before
             else greatest(retry_not_before, ${input.retryNotBefore}::timestamptz) end,
           pending_token = null,
           pending_since = null,
           updated_at = clock_timestamp()
     where id = 1
       and ${input.token === null ? sql`pending_token is null` : sql`pending_token = ${input.token}::uuid`}
    returning stopped_at as "stoppedAt"
  `);
  const row = result.rows[0];
  return row ? new Date(row.stoppedAt) : null;
}

/** Record that the owner's incident for the stop of `stoppedAt` is open. A
 *  later stop (after a resume) is not confirmed by an earlier one. */
export async function confirmFanslyPublicLookupStopIncident(
  db: Database,
  input: { stoppedAt: Date; at: Date },
): Promise<boolean> {
  const result = await db.execute(sql`
    update fansly_public_lookup_state
       set stop_incident_at = ${input.at},
           updated_at = clock_timestamp()
     where id = 1
       and stopped_at = ${input.stoppedAt}
       and stop_incident_at is null
  `);
  return (result.rowCount ?? 0) > 0;
}

/** The owner's resume: the stop is cleared; a Retry-After still in the future
 *  is kept (the reader waits for it), and so is an attempt still pending (the
 *  reader settles it before anything is sent). The state as it was, or null
 *  when the reader was not stopped. */
export async function resumeFanslyPublicLookup(db: Database, input: { at: Date }): Promise<FanslyPublicLookupState | null> {
  const before = await readFanslyPublicLookupState(db, { forUpdate: true });
  if (before.stoppedAt === null) return null;
  await db.execute(sql`
    update fansly_public_lookup_state
       set stopped_at = null,
           stop_reason = null,
           stop_http_status = null,
           stop_detail = null,
           stop_first_batch = null,
           stop_incident_at = null,
           resumed_at = ${input.at},
           updated_at = clock_timestamp()
     where id = 1
       and stopped_at is not null
  `);
  return before;
}

/** The reader's own journal in `fansly_send_log`, for its budget and pace.
 *  An attempt's SEND instant is when its request headers went out
 *  (`sent_at`); one never marked sent counts at its completion (it was never
 *  sent — a later instant is the conservative one), and one neither marked nor
 *  completed at its upper bound (capture + `inFlightBoundMs`), whatever it
 *  became. */
export interface FanslyPublicLookupClocks {
  /** The newest attempt's send instant (as above). */
  lastSentAt: Date | null;
  /** The newest attempt's completion; an attempt that never completed counts
   *  at its upper bound (capture + `inFlightBoundMs`). */
  lastCompletedAt: Date | null;
  /** An attempt younger than `inFlightBoundMs` that has not completed. */
  inFlightSince: Date | null;
  /** Attempts whose send instant is within the last 24 hours, and the oldest
   *  of those instants. */
  sentLastDay: number;
  oldestLastDay: Date | null;
}

export async function readFanslyPublicLookupClocks(
  db: Database,
  input: { now: Date; inFlightBoundMs: number },
): Promise<FanslyPublicLookupClocks> {
  const bound = `${Math.max(0, Math.ceil(input.inFlightBoundMs))} milliseconds`;
  const result = await db.execute<{
    lastSentAt: Date | string | null;
    lastCompletedAt: Date | string | null;
    inFlightSince: Date | string | null;
    sentLastDay: number;
    oldestLastDay: Date | string | null;
  }>(sql`
    with attempts as (
      select l.captured_at, l.completed_at,
             coalesce(l.sent_at, l.completed_at, l.captured_at + ${bound}::interval) as send_at
        from fansly_send_log l
       where l.page_id is null
         and l.source = ${FANSLY_PUBLIC_LOOKUP_SEND_SOURCE}
         and l.captured_at > ${input.now}::timestamptz - interval '25 hours'
    )
    select max(a.send_at) as "lastSentAt",
           max(coalesce(a.completed_at, a.captured_at + ${bound}::interval)) as "lastCompletedAt",
           min(a.captured_at) filter (
             where a.completed_at is null and a.captured_at > ${input.now}::timestamptz - ${bound}::interval
           ) as "inFlightSince",
           count(*) filter (where a.send_at > ${input.now}::timestamptz - interval '24 hours')::int as "sentLastDay",
           min(a.send_at) filter (where a.send_at > ${input.now}::timestamptz - interval '24 hours') as "oldestLastDay"
      from attempts a
  `);
  const row = result.rows[0];
  return {
    lastSentAt: date(row?.lastSentAt ?? null),
    lastCompletedAt: date(row?.lastCompletedAt ?? null),
    inFlightSince: date(row?.inFlightSince ?? null),
    sentLastDay: Number(row?.sentLastDay ?? 0),
    oldestLastDay: date(row?.oldestLastDay ?? null),
  };
}

/** One attempt as its journals keep it: the send-log row and the raw answer
 *  (`observations`, by its idempotency key), each null when absent. */
export interface FanslyPublicLookupAttemptRecord {
  log: {
    capturedAt: Date;
    sentAt: Date | null;
    completedAt: Date | null;
    outcome: string | null;
    outcomeDetail: string | null;
    httpStatus: number | null;
  } | null;
  observation: { id: number; receivedAt: Date; kind: string; payload: unknown } | null;
}

/** The idempotency key the reader journals an attempt's answer under. */
export function fanslyPublicLookupObservationKey(token: string): string {
  return `fansly-public-lookup:${token}`;
}

export async function readFanslyPublicLookupAttempt(
  db: Database,
  input: { token: string },
): Promise<FanslyPublicLookupAttemptRecord> {
  const logs = await db.execute<{
    capturedAt: Date | string;
    sentAt: Date | string | null;
    completedAt: Date | string | null;
    outcome: string | null;
    outcomeDetail: string | null;
    httpStatus: number | null;
  }>(sql`
    select captured_at as "capturedAt", sent_at as "sentAt", completed_at as "completedAt", outcome,
           outcome_detail as "outcomeDetail", http_status as "httpStatus"
      from fansly_send_log
     where guard_token = ${input.token}::uuid
  `);
  const observations = await db.execute<{ id: string; receivedAt: Date | string; kind: string; payload: unknown }>(sql`
    select o.id::text as id, o.received_at as "receivedAt", o.kind, o.payload
      from observation_keys k
      join observations o on o.id = k.observation_id and o.received_at = k.received_at
     where k.source = 'pull'
       and k.idempotency_key = ${fanslyPublicLookupObservationKey(input.token)}
  `);
  const log = logs.rows[0];
  const observation = observations.rows[0];
  return {
    log: log
      ? {
        capturedAt: new Date(log.capturedAt),
        sentAt: date(log.sentAt),
        completedAt: date(log.completedAt),
        outcome: log.outcome,
        outcomeDetail: log.outcomeDetail,
        httpStatus: log.httpStatus === null ? null : Number(log.httpStatus),
      }
      : null,
    observation: observation
      ? { id: Number(observation.id), receivedAt: new Date(observation.receivedAt), kind: observation.kind, payload: observation.payload }
      : null,
  };
}

/** One fan the reader asks about, and why. */
export interface FanslyPublicLookupCandidate {
  fanId: number;
  /** The Fansly account id the request names. */
  platformUserId: string;
  username: string | null;
  demands: FanslyPublicLookupDemand[];
  /** The fan's latest answer, if any. */
  publicCheckedAt: Date | null;
}

type CandidateSqlRow = {
  fanId: string;
  platformUserId: string;
  username: string | null;
  demands: FanslyPublicLookupDemand[];
  publicCheckedAt: Date | string | null;
};

/** The demand of the reader as one SQL: every Fansly fan that needs an answer,
 *  with its reasons and its priority (the owner's queue first, then the
 *  partners of established episodes, then the page lookup misses). */
function demandSql(input: { recheckBefore: Date }) {
  return sql`
    with demand as (
      select q.fan_id, 'deleted_mark'::text as demand, 0 as priority, q.enqueued_at as since
        from fansly_public_lookup_queue q
       where q.done_at is null
      union all
      select coalesce(t.fan_id, fp.id), 'episode_partner', 1, e.established_at
        from page_dm_thread_unavailability e
        join page_dm_threads t on t.id = e.thread_id
        left join fans fp
          on t.fan_id is null and fp.platform = 'fansly' and fp.platform_user_id = t.partner_platform_user_id
       where e.ended_at is null
         and e.state = 'established'
         and coalesce(t.fan_id, fp.id) is not null
      union all
      -- IS FALSE, not = false: the same rows (null fails both), but the planner
      -- reads "= false" as NOT x and prices it 1 - P(true), ignoring that ~99%
      -- of the column is null: 71 520 rows expected for 51 (prod 2026-10-10),
      -- which hash-joined every Fansly fan, regex and all. IS FALSE is priced
      -- from the column's own frequencies and matches 0268's partial index.
      select pf.fan_id, 'page_lookup_miss', 2, pf.account_probe_at
        from page_fans pf
       where pf.account_probe_resolved is false
    ), due as (
      select d.fan_id, min(d.priority) as priority, min(d.since) as since,
             array_agg(distinct d.demand order by d.demand) as demands
        from demand d
        join fans f on f.id = d.fan_id
       where f.platform = 'fansly'
         and f.platform_user_id ~ ${FANSLY_ID}
         and (
           d.priority = 0
           or f.public_checked_at is null
           or f.public_checked_at < ${input.recheckBefore}::timestamptz
         )
       group by d.fan_id
    )
    select f.id::text as "fanId", f.platform_user_id as "platformUserId", f.username,
           due.demands, f.public_checked_at as "publicCheckedAt", due.priority, due.since
      from due
      join fans f on f.id = due.fan_id
  `;
}

/**
 * The next fans to ask about, at most `limit`, each once however many pages
 * and reasons name it: the owner's queue first (oldest request first), then
 * the partners of established unavailability episodes, then the fans a page's
 * lookup missed — the latter two only when the fan was never checked or its
 * latest check is older than `recheckBefore`. Only Fansly fans whose id is
 * digits. Plain read.
 */
export async function pickFanslyPublicLookupBatch(
  db: Database,
  input: { limit: number; recheckBefore: Date },
): Promise<FanslyPublicLookupCandidate[]> {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1) throw new Error(`limit must be a positive integer (${input.limit})`);
  const result = await db.execute<CandidateSqlRow>(sql`
    select c."fanId", c."platformUserId", c.username, c.demands, c."publicCheckedAt"
      from (${demandSql(input)}) c
     order by c.priority, c.since nulls last, c."fanId"::bigint
     limit ${input.limit}
  `);
  return result.rows.map((row) => ({
    fanId: Number(row.fanId),
    platformUserId: row.platformUserId,
    username: row.username,
    demands: row.demands,
    publicCheckedAt: date(row.publicCheckedAt),
  }));
}

/** How much demand there is, by reason (a fan counts under each of its reasons). */
export async function countFanslyPublicLookupDemand(
  db: Database,
  input: { recheckBefore: Date },
): Promise<{ total: number; byDemand: Record<FanslyPublicLookupDemand, number> }> {
  const result = await db.execute<{ total: number; deletedMark: number; episodePartner: number; pageLookupMiss: number }>(sql`
    select count(*)::int as total,
           count(*) filter (where 'deleted_mark' = any(c.demands))::int as "deletedMark",
           count(*) filter (where 'episode_partner' = any(c.demands))::int as "episodePartner",
           count(*) filter (where 'page_lookup_miss' = any(c.demands))::int as "pageLookupMiss"
      from (${demandSql(input)}) c
  `);
  const row = result.rows[0];
  return {
    total: Number(row?.total ?? 0),
    byDemand: {
      deleted_mark: Number(row?.deletedMark ?? 0),
      episode_partner: Number(row?.episodePartner ?? 0),
      page_lookup_miss: Number(row?.pageLookupMiss ?? 0),
    },
  };
}

export interface FanslyPublicLookupApplyResult {
  /** Fans whose row was there to write (an erased fan is not). */
  written: number;
  found: number;
  notFound: number;
  /** Found fans whose legacy deleted mark was taken off. */
  marksCleared: number;
  /** Owner's queue rows this answer closed. */
  queueDone: number;
}

/**
 * Settle the pending attempt `token` with its accepted answer (in the
 * caller's transaction): the state row is locked first and must still name
 * the attempt — null, nothing written, when another settlement got there
 * first. `answeredAt` is when the answer ARRIVED (its journal instant), however
 * late it is applied. Every asked fan (`requestedPlatformUserIds`, the
 * journal's `requestedIds`) whose latest check is not newer gets
 * `public_checked_at = answeredAt` and `public_found` =
 * whether the answer returned its id; a found fan carrying the legacy deleted
 * mark loses it (Р2 (а): found → the mark goes; not found → it stays, and
 * none is ever set here); the owner's queue rows of these fans requested no
 * later than the answer are done (a request made after it stays); the
 * state records the answer and clears the attempt. A fan erased since has no
 * row and gets nothing. Page facts (`page_fans`), notes and aliases are not
 * touched.
 */
export async function applyFanslyPublicLookupAnswer(
  tx: Database,
  input: { token: string; requestedPlatformUserIds: readonly string[]; foundPlatformUserIds: readonly string[]; answeredAt: Date },
): Promise<FanslyPublicLookupApplyResult | null> {
  const state = await readFanslyPublicLookupState(tx, { forUpdate: true });
  if (state.pendingToken !== input.token) return null;
  const requested = [...new Set(input.requestedPlatformUserIds)];
  const found = [...new Set(input.foundPlatformUserIds)];
  const result = await tx.execute<{ written: number; found: number; notFound: number; marksCleared: number; queueDone: number }>(sql`
    with target as (
      select f.id, f.deleted_detected_at is not null as marked,
             f.platform_user_id = any(${sql.param(found)}::text[]) as found
        from fans f
       where f.platform = 'fansly'
         and f.platform_user_id = any(${sql.param(requested)}::text[])
       order by f.id
         for update of f
    ), written as (
      update fans f
         set public_checked_at = ${input.answeredAt},
             public_found = t.found,
             deleted_detected_at = case when t.found then null else f.deleted_detected_at end,
             deleted_last_detected_at = case when t.found then null else f.deleted_last_detected_at end
        from target t
       where f.id = t.id
         -- An answer never replaces a newer one.
         and (f.public_checked_at is null or f.public_checked_at <= ${input.answeredAt})
      returning f.id, t.found, t.marked
    ), queued as (
      update fansly_public_lookup_queue q
         set done_at = ${input.answeredAt},
             found = w.found,
             mark_cleared = w.found and w.marked
        from written w
       where q.fan_id = w.id
         and q.done_at is null
         and q.enqueued_at <= ${input.answeredAt}
      returning q.fan_id
    ), answered as (
      update fansly_public_lookup_state
         set first_answer_at = least(coalesce(first_answer_at, ${input.answeredAt}), ${input.answeredAt}),
             last_answer_at = greatest(coalesce(last_answer_at, ${input.answeredAt}), ${input.answeredAt}),
             pending_token = null,
             pending_since = null,
             updated_at = clock_timestamp()
       where id = 1
         and pending_token = ${input.token}::uuid
      returning id
    )
    select (select count(*) from written)::int as written,
           (select count(*) from written where found)::int as found,
           (select count(*) from written where not found)::int as "notFound",
           (select count(*) from written where found and marked)::int as "marksCleared",
           (select count(*) from queued)::int as "queueDone"
  `);
  const row = result.rows[0];
  return {
    written: Number(row?.written ?? 0),
    found: Number(row?.found ?? 0),
    notFound: Number(row?.notFound ?? 0),
    marksCleared: Number(row?.marksCleared ?? 0),
    queueDone: Number(row?.queueDone ?? 0),
  };
}

/**
 * The owner's one-off re-check (`recheck-marks`, Р2 (а)): every Fansly fan
 * carrying the legacy deleted mark joins the queue — it only enqueues; the
 * reader asks in its own pace. A fan already pending keeps its place; a done
 * row whose fan still carries the mark is asked again. Returns how many rows
 * were enqueued and how many marks there are.
 */
export async function enqueueFanslyPublicLookupDeletedMarks(
  db: Database,
  input: { at: Date },
): Promise<{ enqueued: number; marks: number; alreadyPending: number }> {
  const result = await db.execute<{ enqueued: number; marks: number; alreadyPending: number }>(sql`
    with marked as (
      select f.id
        from fans f
       where f.platform = 'fansly'
         and f.deleted_detected_at is not null
         and f.platform_user_id ~ ${FANSLY_ID}
    ), pending as (
      select q.fan_id from fansly_public_lookup_queue q join marked m on m.id = q.fan_id where q.done_at is null
    ), enqueued as (
      insert into fansly_public_lookup_queue (fan_id, reason, enqueued_at)
      select m.id, 'deleted_mark', ${input.at} from marked m
      on conflict (fan_id) do update
         set reason = excluded.reason,
             enqueued_at = excluded.enqueued_at,
             done_at = null,
             found = null,
             mark_cleared = null
       where fansly_public_lookup_queue.done_at is not null
      returning fan_id
    )
    select (select count(*) from enqueued)::int as enqueued,
           (select count(*) from marked)::int as marks,
           (select count(*) from pending)::int as "alreadyPending"
  `);
  const row = result.rows[0];
  return {
    enqueued: Number(row?.enqueued ?? 0),
    marks: Number(row?.marks ?? 0),
    alreadyPending: Number(row?.alreadyPending ?? 0),
  };
}

/** The owner's queue and the marks, for `status`: what is pending, what the
 *  re-check found (marks taken off) and did not find (marks kept). */
export async function readFanslyPublicLookupProgress(db: Database): Promise<{
  queuePending: number;
  queueDone: number;
  queueFound: number;
  queueMarksCleared: number;
  queueNotFound: number;
  marksRemaining: number;
  checkedFans: number;
}> {
  const result = await db.execute<Record<string, number>>(sql`
    select (select count(*) from fansly_public_lookup_queue where done_at is null)::int as "queuePending",
           (select count(*) from fansly_public_lookup_queue where done_at is not null)::int as "queueDone",
           (select count(*) from fansly_public_lookup_queue where found)::int as "queueFound",
           (select count(*) from fansly_public_lookup_queue where mark_cleared)::int as "queueMarksCleared",
           (select count(*) from fansly_public_lookup_queue where found = false)::int as "queueNotFound",
           (select count(*) from fans where platform = 'fansly' and deleted_detected_at is not null)::int as "marksRemaining",
           (select count(*) from fans where platform = 'fansly' and public_checked_at is not null)::int as "checkedFans"
  `);
  const row = result.rows[0] ?? {};
  return {
    queuePending: Number(row.queuePending ?? 0),
    queueDone: Number(row.queueDone ?? 0),
    queueFound: Number(row.queueFound ?? 0),
    queueMarksCleared: Number(row.queueMarksCleared ?? 0),
    queueNotFound: Number(row.queueNotFound ?? 0),
    marksRemaining: Number(row.marksRemaining ?? 0),
    checkedFans: Number(row.checkedFans ?? 0),
  };
}

/** The public answer the reader holds about a chat's partner, by thread
 *  (the thread's fan, else the Fansly fan named by its partner id). */
export interface ChatPartnerPublicCheck {
  checkedAt: Date;
  found: boolean;
}

export async function readChatPartnerPublicChecks(
  db: Database,
  input: { threadIds: readonly number[] },
): Promise<Map<number, ChatPartnerPublicCheck>> {
  const ids = [...new Set(input.threadIds)].map(String);
  if (ids.length === 0) return new Map();
  const result = await db.execute<{ threadId: string; checkedAt: Date | string | null; found: boolean | null }>(sql`
    select t.id::text as "threadId",
           coalesce(fb.public_checked_at, fp.public_checked_at) as "checkedAt",
           case when fb.id is not null then fb.public_found else fp.public_found end as found
      from page_dm_threads t
      left join fans fb on fb.id = t.fan_id
      left join fans fp
        on t.fan_id is null and fp.platform = 'fansly' and fp.platform_user_id = t.partner_platform_user_id
     where t.id = any(${sql.param(ids)}::bigint[])
  `);
  const checks = new Map<number, ChatPartnerPublicCheck>();
  for (const row of result.rows) {
    if (row.checkedAt !== null && row.found !== null) {
      checks.set(Number(row.threadId), { checkedAt: new Date(row.checkedAt), found: row.found });
    }
  }
  return checks;
}

/** Why Fansly stopped serving a chat, as the chatters and agents read it
 *  (plan §8 (а), owner decision Р3): the partner's public check — found →
 *  `probably_blocked`, not found → `probably_deleted`, none → `unchecked`. A
 *  likelihood, never a proof. */
export type ChatUnavailabilityCause = "unchecked" | "probably_blocked" | "probably_deleted";

export function chatUnavailabilityCause(check: ChatPartnerPublicCheck | null | undefined): ChatUnavailabilityCause {
  if (check === null || check === undefined) return "unchecked";
  return check.found ? "probably_blocked" : "probably_deleted";
}
