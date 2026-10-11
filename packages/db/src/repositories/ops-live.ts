// Reads of `GET /api/v1/ops/live`, the operator screen's one request: the
// active pages, the feed of sent requests over both attempt journals, and the
// job queue. Read-only, and every statement is costed for a caller that asks
// every two seconds — each one names the index it stays in, and the one that
// stays in none says how often it may run.
//
// What these reads never select: an attempt's request parameters, its work
// subject, a response body or an error message.

import { sql } from "drizzle-orm";

import type { Platform } from "@agency_hub_core/shared";

import type { Database } from "../client.ts";
import type { SyncEngineWorkClass } from "./sync/work.ts";
import { timestampParam, toDate, toNumber, toRequiredDate } from "./sync/values.ts";

export interface OpsLivePageRow {
  id: number;
  label: string;
  platform: Platform;
}

/** The active, not deleted pages of both platforms, by platform and label. */
export async function listOpsLivePages(db: Database): Promise<OpsLivePageRow[]> {
  const result = await db.execute<{ id: string; label: string; platform: Platform }>(sql`
    select p.id::text as id, p.label, p.platform
      from pages p
     where p.status = 'active'
       and p.deleted_at is null
     order by p.platform, p.label
  `);
  return result.rows.map((row) => ({ id: Number(row.id), label: row.label, platform: row.platform }));
}

/** Which journal a sent request is read from: the Sync Engine's
 *  (`sync_attempts`) or the older one the legacy pulls write
 *  (`sync_http_attempts`). Ids are unique within a journal only. */
export type OpsLiveAttemptJournal = "engine" | "legacy";

export interface OpsLiveAttemptRow {
  journal: OpsLiveAttemptJournal;
  id: number;
  pageLabel: string;
  /** The registry key (`engine`) or the stream (`legacy`). */
  resource: string;
  operation: string;
  /** Null in the older journal: it has no work classes. */
  class: SyncEngineWorkClass | null;
  sentAt: Date;
  /** Null while the request is unanswered. */
  completedAt: Date | null;
  /** It ended without a usable answer. */
  failed: boolean;
  httpStatus: number | null;
  durationMs: number | null;
  responseBytes: number | null;
}

type AttemptSqlRow = {
  journal: OpsLiveAttemptJournal;
  id: string;
  pageLabel: string;
  resource: string;
  operation: string;
  class: SyncEngineWorkClass | null;
  sentAt: Date | string;
  completedAt: Date | string | null;
  failed: boolean;
  httpStatus: number | string | null;
  durationMs: number | string | null;
  responseBytes: number | string | null;
};

/**
 * The feed of sent requests: every request of either journal sent after
 * `sentAfter` that was sent or completed after `changedAfter`, newest first by
 * send instant, at most `limit` of each journal.
 *
 * Only rows with a send instant: a row is journaled when its request is
 * admitted and stamped when it is sent, so neither a row id nor the admission
 * instant orders the feed. What shadow mode left behind was never sent.
 *
 * Both halves are bounded by the send instant through an index that leads to
 * it — `sync_attempts_page_sent (page_id, sent_at)`, one range per page, and
 * `sync_http_attempts_retention_idx (started_at)` — so the cost follows the
 * requests of the window, not the size of a journal. The page labels are read
 * once for both halves (a label lookup per row doubled the buffers).
 * Production 2026-10-11, 225 engine and 179 older-journal requests in ten
 * minutes: 3.6 ms and 578 buffers for the ten minutes, 0.8 ms and 573
 * buffers for a 32-second window with its ten-minute send floor. Reading the
 * newest 5000 ids of each journal's primary key instead visits every one of
 * those rows: 5–10 ms and 3.9 thousand buffers in the engine's journal, 27 ms
 * and 3.2 thousand blocks read from disk in the older one.
 *
 * `failed`: the engine classed the outcome as an error, or the request ended
 * with no answer at all (`transport_error`, `timeout`, `unknown`); in the
 * older journal, the attempt recorded a failure kind.
 */
export async function listOpsLiveAttempts(
  db: Database,
  input: { sentAfter: Date; changedAfter: Date; limit: number },
): Promise<OpsLiveAttemptRow[]> {
  const sentAfter = timestampParam(input.sentAfter);
  const changedAfter = timestampParam(input.changedAfter);
  const limit = Math.max(1, Math.min(10_000, Math.trunc(input.limit)));
  const result = await db.execute<AttemptSqlRow>(sql`
    with page_labels as materialized (
      select p.id, p.label from pages p
    )
    (select 'engine'::text as journal,
            a.id::text as id,
            p.label as "pageLabel",
            a.resource,
            a.operation,
            a.class,
            a.sent_at as "sentAt",
            a.completed_at as "completedAt",
            (a.error_class is not null or a.outcome in ('transport_error', 'timeout', 'unknown')) as failed,
            a.http_status::integer as "httpStatus",
            a.duration_ms as "durationMs",
            a.response_bytes::bigint as "responseBytes"
       from page_labels p
       join sync_attempts a on a.page_id = p.id
      where a.sent_at > ${sentAfter}
        and not a.shadow
        and (a.sent_at > ${changedAfter} or a.completed_at > ${changedAfter})
      order by a.sent_at desc, a.id desc
      limit ${limit})
    union all
    (select 'legacy'::text,
            a.id::text,
            p.label,
            a.stream::text,
            a.operation,
            null::text,
            a.started_at,
            a.finished_at,
            a.failure_kind is not null,
            a.http_status,
            a.duration_ms,
            a.response_body_bytes
       from sync_http_attempts a
       join page_labels p on p.id = a.page_id
      where a.started_at > ${sentAfter}
        and (a.started_at > ${changedAfter} or a.finished_at > ${changedAfter})
      order by a.started_at desc, a.id desc
      limit ${limit})
  `);
  return result.rows.map((row) => ({
    journal: row.journal,
    id: Number(row.id),
    pageLabel: row.pageLabel,
    resource: row.resource,
    operation: row.operation,
    class: row.class,
    sentAt: toRequiredDate(row.sentAt),
    completedAt: toDate(row.completedAt),
    failed: row.failed === true,
    httpStatus: toNumber(row.httpStatus),
    durationMs: toNumber(row.durationMs),
    responseBytes: toNumber(row.responseBytes),
  }));
}

/**
 * The send instant of the oldest request, of either journal, that was sent
 * after `sentAfter` and has no answer yet; null: every one has.
 *
 * It is what a cursor has to remember: a request can be answered long after
 * the feed's own window has moved past its sending — a sync that was down
 * for a quarter of an hour closes what it left unanswered with the instant
 * of its return — and the next answer has to reach back to it.
 *
 * The engine's half stays in `sync_attempts_unfinished` (its predicate is
 * written here as the literal the planner matches); that index also holds
 * answered rows whose answer is not applied yet, which are not unanswered.
 * The older journal's half is a range of `sync_http_attempts_retention_idx`
 * over the same window.
 */
export async function readOpsLiveOldestUnanswered(db: Database, input: { sentAfter: Date }): Promise<Date | null> {
  const sentAfter = timestampParam(input.sentAfter);
  const result = await db.execute<{ openSince: Date | string | null }>(sql`
    select least(
      (select min(a.sent_at)
         from sync_attempts a
        where a.outcome = any (array['admitted', 'sent'])
          and a.sent_at > ${sentAfter}
          and not a.shadow),
      (select min(a.started_at)
         from sync_http_attempts a
        where a.started_at > ${sentAfter}
          and a.finished_at is null)
    ) as "openSince"
  `);
  return toDate(result.rows[0]?.openSince ?? null);
}

/**
 * Each page's latest request in the older journal since `since`; a page
 * without one in that time is not in the map. For the pages the Sync Engine
 * does not serve — it stores no last send for them.
 *
 * Bounded by the send instant through `sync_http_attempts_retention_idx`:
 * the journal has no index by page and instant, and without the bound this
 * read passes over all of it (production 2026-10-11: 47.9 ms and 64 thousand
 * buffers unbounded; 0.7 ms and 1.4 thousand with six hours).
 */
export async function listOpsLiveLegacyLastSends(
  db: Database,
  input: { pageIds: readonly number[]; since: Date },
): Promise<Map<number, Date>> {
  const lastSends = new Map<number, Date>();
  if (input.pageIds.length === 0) return lastSends;
  const result = await db.execute<{ pageId: string; lastSentAt: Date | string }>(sql`
    select a.page_id::text as "pageId", max(a.started_at) as "lastSentAt"
      from sync_http_attempts a
     where a.started_at > ${timestampParam(input.since)}
       and a.page_id in (${sql.join(input.pageIds.map((pageId) => sql`${pageId}`), sql`, `)})
     group by a.page_id
  `);
  for (const row of result.rows) lastSends.set(Number(row.pageId), toRequiredDate(row.lastSentAt));
  return lastSends;
}

export interface OpsLiveQueueNow {
  /** Ready to run, in a queue that is not a dead-letter queue. */
  waiting: number;
  /** The job queue's own counter; null: not refreshed for every queue lately. */
  active: number | null;
  /** Parked in dead-letter queues. */
  deadLetters: number;
  /** The age of the oldest waiting job; null: none waits. */
  oldestWaitingAgeMs: number | null;
}

const EMPTY_QUEUE_NOW: OpsLiveQueueNow = { waiting: 0, active: 0, deadLetters: 0, oldestWaitingAgeMs: null };

/** How old the job queue's counters may be and still be reported. It
 *  refreshes them every minute by default. */
export const OPS_LIVE_QUEUE_COUNTERS_MAX_AGE_SECONDS = 5 * 60;

async function hasJobQueue(db: Database): Promise<boolean> {
  const schema = await db.execute<{ present: boolean }>(sql`
    select (to_regclass('pgboss.job') is not null and to_regclass('pgboss.queue') is not null) as present
  `);
  return schema.rows[0]?.present === true;
}

/**
 * The job queue as it is now, without a pass over the job table.
 *
 * Waiting jobs, dead letters and the oldest waiting job are read from the
 * rows that have not started: `state < 'active'` is the predicate of
 * `job_common_i5`, written as the literal the planner matches, and that index
 * carries every column read here (production 2026-10-11: 0.3 ms, 68 buffers,
 * against 110–190 ms and 8.6 thousand for the pass over all 207 thousand
 * jobs). A dead-letter queue — one some queue names as its `dead_letter` in
 * pg-boss's own registry — has no consumer: its jobs are a record of past
 * failures, counted apart and never as waiting.
 *
 * `active` has no index of its own. It is the sum of the counters pg-boss
 * keeps per queue and refreshes on its monitor interval (a minute by
 * default): approximate, and not reported at all when any queue's counter
 * has no refresh instant or the oldest one is past the allowed age. That
 * instant is written just before the counters are; it is the instant of the
 * attempt.
 *
 * A database pg-boss has not started in yet has no queue schema: no jobs.
 */
export async function readOpsLiveQueueNow(db: Database): Promise<OpsLiveQueueNow> {
  if (!(await hasJobQueue(db))) return { ...EMPTY_QUEUE_NOW };
  const result = await db.execute<{
    waiting: number | string;
    deadLetters: number | string;
    oldestWaitingAgeMs: number | string | null;
    active: number | string | null;
  }>(sql`
    with dead_letter_queues as (
      select distinct q.dead_letter as name from pgboss.queue q where q.dead_letter is not null
    ), not_started as (
      select j.name, j.start_after, j.created_on from pgboss.job j where j.state < 'active'
    ), counted as (
      select count(*) filter (where d.name is null and j.start_after <= now()) as waiting,
             count(*) filter (where d.name is not null) as dead_letters,
             min(j.created_on) filter (where d.name is null and j.start_after <= now()) as oldest_created_on
        from not_started j
        left join dead_letter_queues d on d.name = j.name
    ), counters as (
      select sum(q.active_count) as active,
             count(*) filter (where q.monitor_on is null) as never_refreshed,
             min(q.monitor_on) as oldest_refresh
        from pgboss.queue q
    )
    select counted.waiting,
           counted.dead_letters as "deadLetters",
           (extract(epoch from now() - counted.oldest_created_on) * 1000)::bigint as "oldestWaitingAgeMs",
           case when counters.never_refreshed = 0
                 and counters.oldest_refresh > now() - make_interval(secs => ${OPS_LIVE_QUEUE_COUNTERS_MAX_AGE_SECONDS})
                then counters.active end as active
      from counted, counters
  `);
  const row = result.rows[0];
  if (row === undefined) return { ...EMPTY_QUEUE_NOW };
  const oldest = toNumber(row.oldestWaitingAgeMs);
  return {
    waiting: Number(row.waiting),
    active: toNumber(row.active),
    deadLetters: Number(row.deadLetters),
    oldestWaitingAgeMs: oldest === null ? null : Math.max(0, oldest),
  };
}

/**
 * Jobs that failed in the last hour. The one number that needs a pass over
 * the whole job table (its indexes serve single queues and unstarted jobs):
 * 70 ms and 8.6 thousand buffers over 207 thousand jobs on production
 * 2026-10-11. The caller keeps the answer for five minutes.
 */
export async function readOpsLiveFailedLastHour(db: Database): Promise<number> {
  if (!(await hasJobQueue(db))) return 0;
  const result = await db.execute<{ failed: number | string }>(sql`
    select count(*) as failed
      from pgboss.job j
     where j.state = 'failed' and j.completed_on > now() - interval '1 hour'
  `);
  return Number(result.rows[0]?.failed ?? 0);
}
