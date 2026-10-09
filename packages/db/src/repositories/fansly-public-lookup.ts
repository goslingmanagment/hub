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

/** Why the reader stopped (the state's CHECK). */
export const FANSLY_PUBLIC_LOOKUP_STOP_REASONS = ["rate_limited", "auth_refused", "network", "off_contract"] as const;
export type FanslyPublicLookupStopReason = (typeof FANSLY_PUBLIC_LOOKUP_STOP_REASONS)[number];

/** Why a fan is asked about. */
export const FANSLY_PUBLIC_LOOKUP_DEMANDS = ["deleted_mark", "episode_partner", "page_lookup_miss"] as const;
export type FanslyPublicLookupDemand = (typeof FANSLY_PUBLIC_LOOKUP_DEMANDS)[number];

/** A derived demand (an episode's partner, a page's lookup miss) asks again
 *  only once the fan's latest check is older than this. */
export const FANSLY_PUBLIC_LOOKUP_RECHECK_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

const FANSLY_ID = "^[0-9]{1,30}$";

export interface FanslyPublicLookupState {
  stoppedAt: Date | null;
  stopReason: FanslyPublicLookupStopReason | null;
  stopHttpStatus: number | null;
  stopDetail: string | null;
  retryNotBefore: Date | null;
  firstAnswerAt: Date | null;
  lastAnswerAt: Date | null;
  resumedAt: Date | null;
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
  retryNotBefore: Date | string | null;
  firstAnswerAt: Date | string | null;
  lastAnswerAt: Date | string | null;
  resumedAt: Date | string | null;
  updatedAt: Date | string;
};

export async function readFanslyPublicLookupState(db: Database): Promise<FanslyPublicLookupState> {
  const result = await db.execute<StateSqlRow>(sql`
    select stopped_at as "stoppedAt", stop_reason as "stopReason", stop_http_status as "stopHttpStatus",
           stop_detail as "stopDetail", retry_not_before as "retryNotBefore", first_answer_at as "firstAnswerAt",
           last_answer_at as "lastAnswerAt", resumed_at as "resumedAt", updated_at as "updatedAt"
      from fansly_public_lookup_state
     where id = 1
  `);
  const row = result.rows[0];
  if (!row) throw new Error("fansly_public_lookup_state has no row (the migration seeds it)");
  return {
    stoppedAt: date(row.stoppedAt),
    stopReason: row.stopReason,
    stopHttpStatus: row.stopHttpStatus === null ? null : Number(row.stopHttpStatus),
    stopDetail: row.stopDetail,
    retryNotBefore: date(row.retryNotBefore),
    firstAnswerAt: date(row.firstAnswerAt),
    lastAnswerAt: date(row.lastAnswerAt),
    resumedAt: date(row.resumedAt),
    updatedAt: new Date(row.updatedAt),
  };
}

/**
 * Stop the reader (its first failure): the reason, the status and a detail,
 * and the provider's Retry-After as `retry_not_before` (never earlier than one
 * already kept). A reader already stopped keeps its first stop. True when this
 * call stopped it.
 */
export async function stopFanslyPublicLookup(
  db: Database,
  input: {
    at: Date;
    reason: FanslyPublicLookupStopReason;
    httpStatus: number | null;
    detail: string;
    retryNotBefore: Date | null;
  },
): Promise<boolean> {
  const result = await db.execute(sql`
    update fansly_public_lookup_state
       set stopped_at = ${input.at},
           stop_reason = ${input.reason},
           stop_http_status = ${input.httpStatus},
           stop_detail = ${input.detail.slice(0, 2000)},
           retry_not_before = case
             when ${input.retryNotBefore}::timestamptz is null then retry_not_before
             else greatest(retry_not_before, ${input.retryNotBefore}::timestamptz) end,
           updated_at = clock_timestamp()
     where id = 1
       and stopped_at is null
  `);
  return (result.rowCount ?? 0) > 0;
}

/** The owner's resume: the stop is cleared; a Retry-After still in the future
 *  is kept (the reader waits for it). The state as it was, or null when the
 *  reader was not stopped. */
export async function resumeFanslyPublicLookup(db: Database, input: { at: Date }): Promise<FanslyPublicLookupState | null> {
  const before = await readFanslyPublicLookupState(db);
  if (before.stoppedAt === null) return null;
  await db.execute(sql`
    update fansly_public_lookup_state
       set stopped_at = null,
           stop_reason = null,
           stop_http_status = null,
           stop_detail = null,
           resumed_at = ${input.at},
           updated_at = clock_timestamp()
     where id = 1
       and stopped_at is not null
  `);
  return before;
}

/** The reader's own journal in `fansly_send_log`, for its budget and pace. */
export interface FanslyPublicLookupClocks {
  /** The newest attempt's capture (journal) instant. */
  lastCapturedAt: Date | null;
  /** The newest attempt's completion; an attempt that never completed counts
   *  at its upper bound (capture + `inFlightBoundMs`). */
  lastCompletedAt: Date | null;
  /** An attempt younger than `inFlightBoundMs` that has not completed. */
  inFlightSince: Date | null;
  /** Attempts journaled within the last 24 hours, and the oldest of them. */
  sentLastDay: number;
  oldestLastDay: Date | null;
}

export async function readFanslyPublicLookupClocks(
  db: Database,
  input: { now: Date; inFlightBoundMs: number },
): Promise<FanslyPublicLookupClocks> {
  const bound = `${Math.max(0, Math.ceil(input.inFlightBoundMs))} milliseconds`;
  const result = await db.execute<{
    lastCapturedAt: Date | string | null;
    lastCompletedAt: Date | string | null;
    inFlightSince: Date | string | null;
    sentLastDay: number;
    oldestLastDay: Date | string | null;
  }>(sql`
    select max(l.captured_at) as "lastCapturedAt",
           max(coalesce(l.completed_at, l.captured_at + ${bound}::interval)) as "lastCompletedAt",
           min(l.captured_at) filter (
             where l.completed_at is null and l.captured_at > ${input.now}::timestamptz - ${bound}::interval
           ) as "inFlightSince",
           count(*) filter (where l.captured_at > ${input.now}::timestamptz - interval '24 hours')::int as "sentLastDay",
           min(l.captured_at) filter (where l.captured_at > ${input.now}::timestamptz - interval '24 hours') as "oldestLastDay"
      from fansly_send_log l
     where l.page_id is null
       and l.source = ${FANSLY_PUBLIC_LOOKUP_SEND_SOURCE}
       and l.captured_at > ${input.now}::timestamptz - interval '25 hours'
  `);
  const row = result.rows[0];
  return {
    lastCapturedAt: date(row?.lastCapturedAt ?? null),
    lastCompletedAt: date(row?.lastCompletedAt ?? null),
    inFlightSince: date(row?.inFlightSince ?? null),
    sentLastDay: Number(row?.sentLastDay ?? 0),
    oldestLastDay: date(row?.oldestLastDay ?? null),
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
      select pf.fan_id, 'page_lookup_miss', 2, pf.account_probe_at
        from page_fans pf
       where pf.account_probe_resolved = false
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
 * Write one accepted answer (in the caller's transaction): every asked fan
 * gets `public_checked_at = answeredAt` and `public_found` = whether the
 * answer returned its id; a found fan carrying the legacy deleted mark loses
 * it (Р2 (а): found → the mark goes; not found → it stays, and none is ever
 * set here); the owner's queue rows of these fans are done; the state records
 * the answer. A fan erased since the batch was picked has no row and gets
 * nothing. Page facts (`page_fans`), notes and aliases are not touched.
 */
export async function applyFanslyPublicLookupAnswer(
  tx: Database,
  input: { fanIds: readonly number[]; foundPlatformUserIds: readonly string[]; answeredAt: Date },
): Promise<FanslyPublicLookupApplyResult> {
  const fanIds = [...new Set(input.fanIds)].sort((a, b) => a - b).map(String);
  const found = [...new Set(input.foundPlatformUserIds)];
  const result = await tx.execute<{ written: number; found: number; notFound: number; marksCleared: number; queueDone: number; answered: number }>(sql`
    with target as (
      select f.id, f.deleted_detected_at is not null as marked,
             f.platform_user_id = any(${sql.param(found)}::text[]) as found
        from fans f
       where f.id = any(${sql.param(fanIds)}::bigint[])
         and f.platform = 'fansly'
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
         set first_answer_at = coalesce(first_answer_at, ${input.answeredAt}),
             last_answer_at = ${input.answeredAt},
             updated_at = clock_timestamp()
       where id = 1
      returning id
    )
    select (select count(*) from written)::int as written,
           (select count(*) from written where found)::int as found,
           (select count(*) from written where not found)::int as "notFound",
           (select count(*) from written where found and marked)::int as "marksCleared",
           (select count(*) from queued)::int as "queueDone",
           (select count(*) from answered)::int as answered
  `);
  const row = result.rows[0];
  if (Number(row?.answered ?? 0) !== 1) throw new Error("fansly_public_lookup_state has no row (the migration seeds it)");
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
