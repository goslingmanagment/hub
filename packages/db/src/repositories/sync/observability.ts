import { sql, type SQL } from "drizzle-orm";
import { FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_KEY } from "@agency_hub_core/shared";

import type { Database } from "../../client.ts";
import { capturePayloadRefFromColumns, type CapturePayloadRef } from "../capture-payloads.ts";
import { SYNC_PACE_AUDIT_LOOKBACK_MS } from "./attempts.ts";
import { countUnavailableChats, openChatUnavailabilitySql, syncWorkOfUnavailableChatSql } from "./chat-unavailability.ts";
import { jsonParam, textArrayParam, toDate, toRequiredDate } from "./values.ts";

// Fansly Sync Engine: the reads behind its alerts and its golden signals
// (plan §10, design §9.5, §9.6). Reads only; every window is an index range
// (`sync_attempts_page_admitted`, `_page_sent`, `sync_work_runnable`, the
// receipts' primary key below an id watermark). The rows shadow mode left
// behind are never read (`not shadow`).

/** Attempt error classes that stop a page (alert 1): a refused credential,
 *  another account behind the credentials. A 429 holds only its route (its
 *  own incident, `route_limited:<route>`). */
export const SYNC_PAGE_STOP_ERROR_CLASSES = ["auth", "identity_mismatch"] as const;

/** A socket whose receiver has not renewed its connection row for this long
 *  is down (the receiver renews it every few seconds). */
export const SYNC_WS_CONNECTION_STALE_MS = 60_000;

/** An open urgent work row as the urgent-wait rule reads it. */
export interface SyncUrgentWaitRow {
  dueAt: Date;
  /** The row's own subject breaker (the vendor's block probes on it too). */
  breakerUntil: Date | null;
}

/**
 * When open urgent work began to wait: its due time, or the end of its own
 * subject breaker when that is later. A row its breaker holds — the vendor's
 * block included, whose probe is the breaker's end — is explained, not
 * waiting; once the breaker has ended, a row no pick took waits like any
 * other. Alert 3's `urgent_waiting` and `sync check live-hour`'s
 * `urgentWaiting` are this one rule (`syncUrgentWaitingSql` is its SQL).
 */
export function syncUrgentWaitingSince(row: SyncUrgentWaitRow): Date {
  return row.breakerUntil !== null && row.breakerUntil.getTime() > row.dueAt.getTime() ? row.breakerUntil : row.dueAt;
}

/** Whether open urgent work has waited longer than `afterMs` at `now`. */
export function isSyncUrgentWorkWaiting(row: SyncUrgentWaitRow, now: Date, afterMs: number): boolean {
  return now.getTime() - syncUrgentWaitingSince(row).getTime() > afterMs;
}

/** `syncUrgentWaitingSince` of `sync_work w`. */
const urgentWaitingSinceSql = sql`greatest(w.due_at, coalesce(w.breaker_until, w.due_at))`;

/** The rows of `sync_work w` that `isSyncUrgentWorkWaiting` at `now`: open
 *  urgent work whose due time and own breaker both lie more than `afterMs`
 *  before it (`due_at` stays a range of `sync_work_runnable`). */
export function syncUrgentWaitingSql(input: { now: SQL; afterMs: number }): SQL {
  const bound = sql`${input.now} - ${input.afterMs}::double precision * interval '1 millisecond'`;
  return sql`w.class = 'urgent'
    and w.state = 'open'
    and w.due_at < ${bound}
    and (w.breaker_until is null or w.breaker_until < ${bound})`;
}

export interface SyncJournalAlertFacts {
  /** The newest attempt within the look-back whose class stops the page. */
  lastStopAttempt: { errorClass: string; at: Date } | null;
  /** Quarantined work by resource. */
  quarantined: Record<string, number>;
  /** Open urgent work waiting longer than `urgentAfterMs` (`syncUrgentWaitingSql`),
   *  the longest wait first (at most 200 rows). */
  urgentWaiting: Array<{
    resource: string;
    subject: string;
    dueAt: Date;
    breakerUntil: Date | null;
    waitingReason: string | null;
  }>;
  /** The page's poll rows (one per poll key), each with its newest applied
   *  answer (null: none yet) — an admission whose answer never applied is no
   *  progress (bug hunt Д3/У2). */
  polls: Array<{ resource: string; lastAppliedAt: Date | null; createdAt: Date }>;
  /** The last certified round of the page's `transactions.rescan` (its
   *  standing poll row keeps that round's receipt in `proof`; a withheld round
   *  leaves it) proved the ledger short of the vendor's lifetime total:
   *  `missing` rows of `total`, `ledgerRows` stored, the round's first page
   *  admitted at `roundStartedAt` (database clock). Null: no certified round,
   *  or a complete one. */
  ledgerIncomplete: { missing: number; total: number; ledgerRows: number; roundStartedAt: Date } | null;
  /** The page's `transactions.backfill`: an open (or running) row's progress —
   *  its newest applied answer, else its creation (an admission is no
   *  progress) — and the newest close of a row that completed
   *  (`backfill_complete`; a withheld or cancelled one explains nothing). */
  transactionsBackfill: { openProgressAt: Date | null; lastCompletedAt: Date | null };
  /** Open history requests with runnable work and no read within the bound. */
  stalledRequests: Array<{ requestRef: string; lastServedAt: Date | null; createdAt: Date }>;
}

/** The ledger fact of a `transactions.rescan` receipt (`proof`): a certified
 *  round carries `ledgerRows` and `walkStartedAt` (one receipt writes both);
 *  any other receipt — a withheld one an older image left there — proves
 *  nothing. */
export function rescanLedgerShortfall(proof: unknown): SyncJournalAlertFacts["ledgerIncomplete"] {
  if (typeof proof !== "object" || proof === null || Array.isArray(proof)) return null;
  const receipt = proof as Record<string, unknown>;
  const whole = (value: unknown): number | null =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
  const ledgerRows = whole(receipt.ledgerRows);
  const startedAt = typeof receipt.walkStartedAt === "string" ? new Date(receipt.walkStartedAt) : null;
  if (ledgerRows === null || startedAt === null || Number.isNaN(startedAt.getTime())) return null;
  const missing = whole(receipt.ledgerIncomplete);
  const total = whole(receipt.total);
  if (missing === null || missing === 0 || total === null) return null;
  return { missing, total, ledgerRows, roundStartedAt: startedAt };
}

/**
 * The journal facts of one page's alerts 1, 2 (quarantine), 3 (urgent wait)
 * and 4 (design §9.6), as of the database clock. Alert 4's steps without an
 * outcome are a part of their own (`readSyncStepAlertFacts`).
 */
export async function readSyncJournalAlertFacts(
  db: Database,
  input: { pageId: number; stopLookbackMs: number; urgentAfterMs: number; requestStallMs: number },
): Promise<SyncJournalAlertFacts> {
  const stop = await db.execute<{ errorClass: string; at: Date | string }>(sql`
    select a.error_class as "errorClass", coalesce(a.completed_at, a.admitted_at) as at
      from sync_attempts a
     where a.page_id = ${input.pageId}
       and not a.shadow
       and a.admitted_at > statement_timestamp() - ${input.stopLookbackMs}::double precision * interval '1 millisecond'
       and a.error_class = any(${textArrayParam(SYNC_PAGE_STOP_ERROR_CLASSES)})
     order by a.admitted_at desc
     limit 1
  `);
  const quarantined = await db.execute<{ resource: string; n: number }>(sql`
    select w.resource, count(*)::int as n
      from sync_work w
     where w.page_id = ${input.pageId} and not w.shadow and w.state = 'quarantined'
     group by w.resource
  `);
  const urgent = await db.execute<{
    resource: string;
    subject: string;
    dueAt: Date | string;
    breakerUntil: Date | string | null;
    waitingReason: string | null;
  }>(sql`
    select w.resource, w.subject, w.due_at as "dueAt", w.breaker_until as "breakerUntil", w.waiting_reason as "waitingReason"
      from sync_work w
     where w.page_id = ${input.pageId}
       and not w.shadow
       and ${syncUrgentWaitingSql({ now: sql`statement_timestamp()`, afterMs: input.urgentAfterMs })}
     order by ${urgentWaitingSinceSql}, w.id
     limit 200
  `);
  // The newest applied answer of each poll (`sync_attempts_work`): a poll
  // admitted again and again without an applied answer is stale too.
  const polls = await db.execute<{ resource: string; lastAppliedAt: Date | string | null; createdAt: Date | string }>(sql`
    select w.resource,
           (select a.applied_at
              from sync_attempts a
             where a.work_id = w.id and a.apply_state = 'applied' order by a.id desc limit 1) as "lastAppliedAt",
           w.created_at as "createdAt"
      from sync_work w
     where w.page_id = ${input.pageId}
       and not w.shadow
       and w.kind = 'poll'
       and w.state in ('open', 'running')
  `);
  // The rescan is a poll: its one row stays open, and its receipt (`proof`)
  // is its last certified round's (`sync_work_key_recent`).
  const ledger = await db.execute<{ proof: unknown }>(sql`
    select w.proof
      from sync_work w
     where w.page_id = ${input.pageId}
       and w.resource = 'transactions.rescan'
       and w.subject = ''
       and not w.shadow
     order by w.id desc
     limit 1
  `);
  const backfill = await db.execute<{ openProgressAt: Date | string | null; lastCompletedAt: Date | string | null }>(sql`
    select (select greatest(w.created_at, max(a.applied_at))
              from sync_work w
              left join sync_attempts a on a.work_id = w.id and a.apply_state = 'applied'
             where w.page_id = ${input.pageId}
               and w.resource = 'transactions.backfill'
               and w.subject = ''
               and not w.shadow
               and w.state in ('open', 'running')
             group by w.id
             order by w.id desc
             limit 1) as "openProgressAt",
           (select max(w.closed_at)
              from sync_work w
             where w.page_id = ${input.pageId}
               and w.resource = 'transactions.backfill'
               and w.subject = ''
               and not w.shadow
               and w.close_reason = 'backfill_complete') as "lastCompletedAt"
  `);
  const stalled = await db.execute<{ requestRef: string; lastServedAt: Date | string | null; createdAt: Date | string }>(sql`
    select r.request_ref::text as "requestRef", r.last_served_at as "lastServedAt", r.created_at as "createdAt"
      from history_requests r
     where r.page_id = ${input.pageId}
       and r.state = 'open'
       and coalesce(r.last_served_at, r.created_at)
           < statement_timestamp() - ${input.requestStallMs}::double precision * interval '1 millisecond'
       and exists (
         select 1
           from history_request_items i
           join sync_work w on w.id = i.work_id
          where i.request_id = r.id
            and i.state in ('queued', 'loading')
            and w.state = 'open'
            and w.due_at <= statement_timestamp()
            and (w.breaker_until is null or w.breaker_until <= statement_timestamp())
            and w.blocked_by_vendor_at is null)
     order by r.id
     limit 20
  `);
  const backfillRow = backfill.rows[0];
  const stopRow = stop.rows[0];
  return {
    lastStopAttempt: stopRow ? { errorClass: stopRow.errorClass, at: toRequiredDate(stopRow.at) } : null,
    quarantined: Object.fromEntries(quarantined.rows.map((row) => [row.resource, Number(row.n)])),
    urgentWaiting: urgent.rows.map((row) => ({
      resource: row.resource,
      subject: row.subject,
      dueAt: toRequiredDate(row.dueAt),
      breakerUntil: toDate(row.breakerUntil),
      waitingReason: row.waitingReason,
    })),
    polls: polls.rows.map((row) => ({
      resource: row.resource,
      lastAppliedAt: toDate(row.lastAppliedAt),
      createdAt: toRequiredDate(row.createdAt),
    })),
    ledgerIncomplete: rescanLedgerShortfall(ledger.rows[0]?.proof ?? null),
    transactionsBackfill: {
      openProgressAt: toDate(backfillRow?.openProgressAt ?? null),
      lastCompletedAt: toDate(backfillRow?.lastCompletedAt ?? null),
    },
    stalledRequests: stalled.rows.map((row) => ({
      requestRef: row.requestRef,
      lastServedAt: toDate(row.lastServedAt),
      createdAt: toRequiredDate(row.createdAt),
    })),
  };
}

/** What alert 4 reads of the page's steps that end without an outcome (bug
 *  hunt Д3/У2). */
export interface SyncStepAlertFacts {
  /** Open or running work whose series of steps without an outcome
   *  (`failing_since`) began more than `failingAfterMs` ago: ONE row per key,
   *  the oldest series first — the rule drops the keys a pause or a hold
   *  explains after the read, so however many works one key has never hide
   *  another key. */
  failing: Array<{ resource: string; works: number; failingSince: Date; errorClasses: string[] }>;
  /** Captured or deferred applies admitted more than `applyPendingAfterMs`
   *  ago (`sync check live-hour`'s `applyPending` rule), by id, at most 200. */
  applyPending: Array<{ resource: string; subject: string; attemptId: number; admittedAt: Date; applyError: string | null }>;
}

/**
 * The step facts of one page's alert 4 (bug hunt Д3/У2), as of the database
 * clock: the keys whose works keep failing without an outcome, and the
 * answers whose apply has been pending too long. Two short reads: the page's
 * open and running work (`sync_work_open_uniq`) grouped by key, and the
 * partial index of unfinished attempts.
 */
export async function readSyncStepAlertFacts(
  db: Database,
  input: { pageId: number; failingAfterMs: number; applyPendingAfterMs: number },
): Promise<SyncStepAlertFacts> {
  const failing = await db.execute<{
    resource: string;
    works: number;
    failingSince: Date | string;
    errorClasses: string[] | null;
  }>(sql`
    select w.resource,
           count(*)::int as works,
           min(w.failing_since) as "failingSince",
           array_remove(array_agg(distinct w.last_error_class), null) as "errorClasses"
      from sync_work w
     where w.page_id = ${input.pageId}
       and not w.shadow
       and w.state in ('open', 'running')
       and w.failing_since < statement_timestamp() - ${input.failingAfterMs}::double precision * interval '1 millisecond'
     group by w.resource
     order by min(w.failing_since), w.resource
     limit 200
  `);
  const pending = await db.execute<{
    resource: string;
    subject: string;
    attemptId: string;
    admittedAt: Date | string;
    applyError: string | null;
  }>(sql`
    select a.resource, a.subject, a.id::text as "attemptId", a.admitted_at as "admittedAt", a.apply_error as "applyError"
      from sync_attempts a
     where a.page_id = ${input.pageId}
       and not a.shadow
       and a.apply_state in ('captured', 'deferred')
       and a.admitted_at < statement_timestamp() - ${input.applyPendingAfterMs}::double precision * interval '1 millisecond'
     order by a.id
     limit 200
  `);
  return {
    failing: failing.rows.map((row) => ({
      resource: row.resource,
      works: Number(row.works),
      failingSince: toRequiredDate(row.failingSince),
      errorClasses: row.errorClasses ?? [],
    })),
    applyPending: pending.rows.map((row) => ({
      resource: row.resource,
      subject: row.subject,
      attemptId: Number(row.attemptId),
      admittedAt: toRequiredDate(row.admittedAt),
      applyError: row.applyError,
    })),
  };
}

/** What alert 4 reads of the page's planned demand past its SLO (bug hunt Д5). */
export interface SyncPlannedDemandAlertFacts {
  /** ONE row per judged key that is overdue, the oldest first: `works` its
   *  overdue rows, `since` the oldest of their waits. */
  stale: Array<{ resource: string; works: number; since: Date }>;
}

/**
 * The planned demand of one page's alert 4 (bug hunt Д5), as of the database
 * clock, for the keys in `slos` (a planned goal or trigger without a standing
 * row, with its SLO). Demand is an open or running row whose demand is not
 * served (`applied_revision < demand_revision`); it waits since its first
 * demand, or since its own breaker's end when that is later. Two rows never
 * count: one the vendor blocks (`blocked_by_vendor_at`), and a `dm-messages.*`
 * row of a chat with an open unavailability episode (a lone refused chat
 * never pages). A key is overdue when a row has waited past the key's SLO AND
 * the key applied no answer within the SLO — no attempt of any of its works,
 * open or closed, with `apply_state = 'applied'` admitted since: a history
 * load that moves is no stall, nor is a walk resumed after a breaker. Only the
 * overdue keys, one row each — the rule drops the keys a pause or a hold
 * explains after the read, so however many rows one key has never hide
 * another key. The progress probe runs only for a key with overdue rows.
 */
export async function readSyncPlannedDemandAlertFacts(
  db: Database,
  input: { pageId: number; slos: ReadonlyArray<{ resource: string; staleAfterMs: number }> },
): Promise<SyncPlannedDemandAlertFacts> {
  if (input.slos.length === 0) return { stale: [] };
  const waitingSince = sql`greatest(w.first_demand_at, coalesce(w.breaker_until, w.first_demand_at))`;
  const result = await db.execute<{ resource: string; works: number; since: Date | string }>(sql`
    with overdue as (
      select w.resource, j."staleAfterMs", count(*)::int as works, min(${waitingSince}) as since
        from sync_work w
        join jsonb_to_recordset(${jsonParam(input.slos)}) as j(resource text, "staleAfterMs" double precision)
          on j.resource = w.resource
       where w.page_id = ${input.pageId}
         and not w.shadow
         and w.state in ('open', 'running')
         and w.applied_revision < w.demand_revision
         and w.blocked_by_vendor_at is null
         and ${waitingSince} < statement_timestamp() - j."staleAfterMs" * interval '1 millisecond'
         and not (w.resource like 'dm-messages.%'
                  and ${openChatUnavailabilitySql({ pageId: sql`w.page_id`, groupId: sql`w.subject` })})
       group by w.resource, j."staleAfterMs"
    )
    select o.resource, o.works, o.since
      from overdue o
      left join lateral (
        select a.applied_at
          from sync_attempts a
         where a.page_id = ${input.pageId}
           and not a.shadow
           and a.resource = o.resource
           and a.apply_state = 'applied'
           and a.admitted_at > statement_timestamp() - o."staleAfterMs" * interval '1 millisecond'
         order by a.admitted_at desc
         limit 1
      ) progress on true
     where progress.applied_at is null
     order by o.since, o.resource
     limit 200
  `);
  return {
    stale: result.rows.map((row) => ({ resource: row.resource, works: Number(row.works), since: toRequiredDate(row.since) })),
  };
}

/**
 * The one definition of a socket message still awaiting its REST
 * confirmation, for every reader that counts "unconfirmed" (alert 3's
 * `message_unconfirmed` and `sync check live-hour`, through
 * `dmLiveUnconfirmedSql`, which narrows it to the chats that page). `message`
 * is the qualified alias of a `dm_live_messages` row. Awaiting means:
 * - no verdict (`confirmed_at` null) and not deferred (`confirm_wait_reason`
 *   null): a row the parity window passed without a REST copy, or of a chat
 *   Fansly does not serve to the page, is no longer awaited — a later REST
 *   read still settles it, nothing pages for it;
 * - a next look of the parity pass (`confirm_due_at`): every awaited row has
 *   one, a deferred row and a deletion stub have none (it also keeps the
 *   partial index `dm_live_messages_confirm_due` usable);
 * - not deleted on the socket;
 * - not in a chat excluded from message sync or hidden (a message of a chat
 *   Hub has no thread row for is awaited; it pages nobody).
 * The previous image (before `confirm_wait_reason`) leaves a deferred row
 * alone: its parity pass and alert 3 need `confirm_due_at`, which a deferred
 * row does not have; its readers show it.
 */
export function dmLiveAwaitingConfirmSql(message: SQL): SQL {
  return sql`(${message}.confirmed_at is null
    and ${message}.confirm_wait_reason is null
    and ${message}.confirm_due_at is not null
    and ${message}.deleted_at is null
    and not exists (
      select 1 from page_dm_threads awaiting_chat
       where awaiting_chat.platform_account_id = ${message}.page_id
         and awaiting_chat.platform_conversation_id = ${message}.platform_conversation_id
         and (not awaiting_chat.is_visible
              or coalesce(awaiting_chat.metadata ->> ${FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_KEY}::text, '') <> '')))`;
}

/**
 * The one definition of "the chat of this socket message is one Fansly does
 * not serve to its page": an open chat-unavailability episode of the
 * message's page × chat (`page_dm_thread_unavailability`; `established`: only
 * an established one). `message` is the qualified alias of a
 * `dm_live_messages` row. The passive parity pass defers by the same test
 * (`openChatUnavailabilitySql`), and alert 3's `message_unconfirmed` and `sync
 * check live-hour` leave such a chat out (`dmLiveUnconfirmedSql`).
 */
export function dmLiveChatUnavailableSql(message: SQL, options: { established?: boolean } = {}): SQL {
  return openChatUnavailabilitySql({
    pageId: sql`${message}.page_id`,
    groupId: sql`${message}.platform_conversation_id`,
    ...(options.established === undefined ? {} : { established: options.established }),
  });
}

/** Hub knows the chat of this socket message: the page has a thread row for
 *  it. `message` is the qualified alias of a `dm_live_messages` row. */
export function dmLiveChatKnownSql(message: SQL): SQL {
  return sql`exists (
    select 1 from page_dm_threads known_chat
     where known_chat.platform_account_id = ${message}.page_id
       and known_chat.platform_conversation_id = ${message}.platform_conversation_id)`;
}

/**
 * The one definition of a socket message that pages the owner for its missing
 * REST confirmation — alert 3's `message_unconfirmed` and `sync check
 * live-hour`'s `unconfirmed_over_15m` and confirmation SLO (arena "vanished
 * chat" plan §4): a message still awaited (`dmLiveAwaitingConfirmSql`) of a
 * chat Hub knows (`dmLiveChatKnownSql`) that has no open unavailability
 * episode (`dmLiveChatUnavailableSql`, refusing or established). A chat Fansly
 * refuses to the page was answered — Hub did its part, and only a refusal of
 * five chats within ten minutes pages (`chats_refused`). A message of a chat
 * Hub has no thread for is counted apart, never paged (`dmLiveChatKnownSql`
 * false): the chat's find work pages when it is quarantined (alert 2) or
 * waits (`urgent_waiting`). The caller adds its window and the sender.
 */
export function dmLiveUnconfirmedSql(message: SQL): SQL {
  return sql`(${dmLiveAwaitingConfirmSql(message)}
    and ${dmLiveChatKnownSql(message)}
    and not ${dmLiveChatUnavailableSql(message)})`;
}

export interface SyncLivePathFacts {
  /** The page's socket: up = a connection row renewed within the stale bound;
   *  else when it was last seen alive (null: the page never had one). */
  socket: { up: boolean; lastAliveAt: Date | null };
  /** Receipts captured within `decodeWindowMs`, and how many the overlay
   *  acked as decode debt. */
  decode: { receipts: number; debt: number };
  /** Fan messages the socket showed that no REST read confirmed for longer
   *  than `unconfirmedAfterMs` and that page the owner (`dmLiveUnconfirmedSql`:
   *  still awaited — deferred rows, excluded and hidden chats left out — in a
   *  chat Hub knows that Fansly does not refuse), whenever the parity pass
   *  looks next. */
  unconfirmed: { count: number; oldestVisibleAt: Date | null };
  /** The same age of fan messages still awaited in chats Hub has no thread
   *  for: counted for the status, never paged. */
  unconfirmedWithoutThread: { count: number; oldestVisibleAt: Date | null };
}

/**
 * The live-path facts of a page (alerts 2 and 3): the socket, the decode debt
 * and the overlay's unconfirmed messages. These are facts of the page's
 * socket and overlay whoever owns them (the legacy receiver until the page's
 * switch).
 */
export async function readSyncLivePathFacts(
  db: Database,
  input: { pageId: number; decodeWindowMs: number; unconfirmedAfterMs: number },
): Promise<SyncLivePathFacts> {
  const socket = await db.execute<{ up: boolean; lastAliveAt: Date | string | null }>(sql`
    select coalesce(bool_or(c.closed_at is null
             and c.last_guard_at > statement_timestamp() - ${SYNC_WS_CONNECTION_STALE_MS}::double precision * interval '1 millisecond'),
             false) as up,
           max(coalesce(c.closed_at, c.last_guard_at)) as "lastAliveAt"
      from (select closed_at, last_guard_at from fansly_ws_connections
             where page_id = ${input.pageId} order by started_at desc limit 5) c
  `);
  const decode = await db.execute<{ receipts: number; debt: number }>(sql`
    select count(*)::int as receipts, count(*) filter (where r.live_state = 'debt')::int as debt
      from fansly_ws_decode_receipts r
     where r.observation_id > ${receiptIdFloorSql(sql`statement_timestamp() - ${input.decodeWindowMs}::double precision * interval '1 millisecond'`)}
       and r.page_id = ${input.pageId}
  `);
  // `confirm_due_at` is not a deadline but the parity pass's next look: every
  // look that finds no REST copy moves it 30 s … 10 min ahead, so a message
  // that stays unconfirmed is almost never past it. Its age is
  // `first_visible_at`. A message the parity window passed without a REST
  // copy is deferred (`confirm_wait_reason`, no next look) and no longer
  // counts; deletion stubs have no next look either. Of the awaited ones, a
  // message of a chat Hub has no thread for is counted apart, and one of a
  // chat Fansly refuses to the page not at all (`dmLiveUnconfirmedSql`).
  const unconfirmed = await db.execute<{
    n: number;
    oldest: Date | string | null;
    withoutThread: number;
    withoutThreadOldest: Date | string | null;
  }>(sql`
    select count(*) filter (where c.pages)::int as n,
           min(m.first_visible_at) filter (where c.pages) as oldest,
           count(*) filter (where not c.known)::int as "withoutThread",
           min(m.first_visible_at) filter (where not c.known) as "withoutThreadOldest"
      from dm_live_messages m
     cross join lateral (select ${dmLiveUnconfirmedSql(sql`m`)} as pages, ${dmLiveChatKnownSql(sql`m`)} as known) c
     where m.page_id = ${input.pageId}
       and m.is_sent_by_page is false
       and m.first_visible_at < statement_timestamp() - ${input.unconfirmedAfterMs}::double precision * interval '1 millisecond'
       and ${dmLiveAwaitingConfirmSql(sql`m`)}
  `);
  const socketRow = socket.rows[0];
  const unconfirmedRow = unconfirmed.rows[0];
  return {
    socket: { up: socketRow?.up === true, lastAliveAt: toDate(socketRow?.lastAliveAt) },
    decode: { receipts: Number(decode.rows[0]?.receipts ?? 0), debt: Number(decode.rows[0]?.debt ?? 0) },
    unconfirmed: { count: Number(unconfirmedRow?.n ?? 0), oldestVisibleAt: toDate(unconfirmedRow?.oldest) },
    unconfirmedWithoutThread: {
      count: Number(unconfirmedRow?.withoutThread ?? 0),
      oldestVisibleAt: toDate(unconfirmedRow?.withoutThreadOldest),
    },
  };
}

/** What alert 3 reads of the page's chat-unavailability episodes (arena
 *  "vanished chat" plan §4). */
export interface SyncChatAlertFacts {
  /** Chats Fansly does not serve to the page: open, established episodes.
   *  Counted for the status; never paged. */
  unavailable: number;
  /** Distinct chats of the page that opened an episode within the window,
   *  and the first of those openings: `chats_refused` at the threshold. */
  refused: { chats: number; firstOpenedAt: Date | null };
}

/**
 * The chat-unavailability facts of one page's alert 3: its established
 * chats, and the distinct chats that opened an episode within
 * `refusedWindowMs` — an episode opens only on a refusal Fansly itself made
 * (its error envelope), so several chats at once is Fansly refusing the page's
 * chats, not a chat refusing the page: `dm-messages.head` is out of the
 * resource hold, and nothing else would page for it. An episode counts by its
 * opening, ended since or not.
 */
export async function readSyncChatAlertFacts(
  db: Database,
  input: { pageId: number; refusedWindowMs: number },
): Promise<SyncChatAlertFacts> {
  const windowStart = sql`statement_timestamp() - ${input.refusedWindowMs}::double precision * interval '1 millisecond'`;
  const result = await db.execute<{ unavailable: number; refused: number; firstOpenedAt: Date | string | null }>(sql`
    select count(*) filter (where e.ended_at is null and e.state = 'established')::int as unavailable,
           count(distinct e.thread_id) filter (where e.opened_at > ${windowStart})::int as refused,
           min(e.opened_at) filter (where e.opened_at > ${windowStart}) as "firstOpenedAt"
      from page_dm_thread_unavailability e
      join page_dm_threads t on t.id = e.thread_id
     where t.platform_account_id = ${input.pageId}
       and (e.ended_at is null or e.opened_at > ${windowStart})
  `);
  const row = result.rows[0];
  return {
    unavailable: Number(row?.unavailable ?? 0),
    refused: { chats: Number(row?.refused ?? 0), firstOpenedAt: toDate(row?.firstOpenedAt) },
  };
}

/** The page's socket as the status shows it (`PageStatus.ws`). */
export interface SyncPageWsStatus {
  /** The newest connection row is open and renewed within the stale bound. */
  connected: boolean;
  /** When the newest connection started (null: the page never had one). */
  since: Date | null;
  /** The coverage gap the newest connection opened with. */
  gapSince: Date | null;
  /** Receipts of the window the overlay acked as decode debt. */
  decodeDebt: number;
}

/** The page's socket for the engine status of a `handover`/`live` page:
 *  its newest connection row and the decode debt of the window. */
export async function readSyncPageWsStatus(
  db: Database,
  input: { pageId: number; decodeWindowMs: number },
): Promise<SyncPageWsStatus> {
  const connection = await db.execute<{ connected: boolean; since: Date | string; gapSince: Date | string | null }>(sql`
    select (c.closed_at is null
             and c.last_guard_at > statement_timestamp() - ${SYNC_WS_CONNECTION_STALE_MS}::double precision * interval '1 millisecond')
             as connected,
           c.started_at as since,
           c.gap_since as "gapSince"
      from fansly_ws_connections c
     where c.page_id = ${input.pageId}
     order by c.started_at desc
     limit 1
  `);
  const decode = await db.execute<{ debt: number }>(sql`
    select count(*)::int as debt
      from fansly_ws_decode_receipts r
     where r.observation_id > ${receiptIdFloorSql(sql`statement_timestamp() - ${input.decodeWindowMs}::double precision * interval '1 millisecond'`)}
       and r.page_id = ${input.pageId}
       and r.live_state = 'debt'
  `);
  const row = connection.rows[0];
  return {
    connected: row?.connected === true,
    since: toDate(row?.since),
    gapSince: toDate(row?.gapSince),
    decodeDebt: Number(decode.rows[0]?.debt ?? 0),
  };
}

/**
 * The newest receipt id received at or before `at` (0 without one). The
 * receipts have no time index: a backward scan of the primary key stops at the
 * first row old enough, so a window `observation_id > floor` reads only the
 * receipts received since: a capture stamps `received_at` before it allocates
 * its id, so a receipt below the floor was received before the floor's
 * receipt was captured — outside the window, or short of it by no more than
 * that capture's wait in its connection's queue.
 */
function receiptIdFloorSql(at: ReturnType<typeof sql>) {
  return sql`coalesce((
    select f.observation_id from fansly_ws_decode_receipts f
     where f.received_at <= ${at}
     order by f.observation_id desc
     limit 1), 0)`;
}

/** One captured socket receipt of a window, with its body for decoding. */
export interface SyncWsWindowReceipt {
  observationId: number;
  pageId: number;
  receivedAt: Date;
  ownRef: string | null;
  missing: boolean;
  payload: unknown;
  payloadRef: CapturePayloadRef | null;
}

/**
 * The receipts received in [from, to) of the given pages (all Fansly pages
 * when omitted), in id order, at most `limit` after `afterId`. Paged by the
 * caller through `afterId`.
 */
export async function listSyncWsReceiptsInWindow(
  db: Database,
  input: { from: Date; to: Date; pageIds?: readonly number[]; afterId?: number; limit: number },
): Promise<SyncWsWindowReceipt[]> {
  if (!Number.isSafeInteger(input.limit) || input.limit <= 0) throw new Error(`limit must be positive, received ${input.limit}`);
  const pages = input.pageIds === undefined ? sql`true` : sql`r.page_id = any(${sql.param([...input.pageIds])}::bigint[])`;
  const result = await db.execute<{
    observationId: string;
    pageId: string;
    receivedAt: Date | string;
    found: boolean;
    ownRef: string | null;
    payload: unknown;
    bucket: string | null;
    objectId: string | null;
  }>(sql`
    select r.observation_id::text as "observationId", r.page_id::text as "pageId", r.received_at as "receivedAt",
           o.id is not null as found, o.native_account_ref as "ownRef", o.payload,
           to_char(o.payload_bucket_month, 'YYYY-MM-DD') as bucket, o.payload_object_id::text as "objectId"
      from fansly_ws_decode_receipts r
      left join observations o on o.id = r.observation_id and o.received_at = r.received_at
     where r.observation_id > greatest(${input.afterId ?? 0}::bigint, ${receiptIdFloorSql(sql`${input.from}::timestamptz - interval '1 millisecond'`)})
       and r.received_at >= ${input.from}::timestamptz
       and r.received_at < ${input.to}::timestamptz
       and ${pages}
     order by r.observation_id
     limit ${input.limit}
  `);
  return result.rows.map((row) => ({
    observationId: Number(row.observationId),
    pageId: Number(row.pageId),
    receivedAt: toRequiredDate(row.receivedAt),
    ownRef: row.ownRef,
    missing: row.found !== true,
    payload: row.payload,
    payloadRef: capturePayloadRefFromColumns(row.bucket, row.objectId),
  }));
}

/** When the ledger first stored each of `transactionIds` (absent: not stored). */
export async function readLedgerTransactionsCreatedAt(
  db: Database,
  input: { pageId: number; transactionIds: readonly string[] },
): Promise<Map<string, Date>> {
  if (input.transactionIds.length === 0) return new Map();
  const result = await db.execute<{ transactionId: string; createdAt: Date | string }>(sql`
    select transaction_id as "transactionId", created_at as "createdAt"
      from transactions
     where platform_account_id = ${input.pageId}
       and transaction_id = any(${textArrayParam([...new Set(input.transactionIds)])})
  `);
  return new Map(result.rows.map((row) => [row.transactionId, toRequiredDate(row.createdAt)]));
}

export interface SyncJournalMetrics {
  pageId: number;
  sends: { urgent: number; requests: number; planned: number };
  /** Smallest gap between two consecutive sends of the window (null: < 2 sends). */
  minGapMs: number | null;
  /** Pairs closer than the setting in force for the later send. */
  paceViolations: number;
  breakersOpen: number;
  /** Open work the vendor blocks, a chat Fansly does not serve to the page
   *  left out (`syncWorkOfUnavailableChatSql`: counted in `chatsUnavailable`). */
  blockedByVendor: number;
  quarantined: number;
  /** Chats Fansly does not serve to the page (`sync_chats_unavailable`):
   *  open, established unavailability episodes. */
  chatsUnavailable: number;
}

/**
 * The pace and queue families of the golden signals (design §9.5) per page
 * since `since`. The gap of a window's first send counts against the page's
 * previous send within the pace-audit look-back.
 */
export async function readSyncJournalMetrics(
  db: Database,
  input: { pageIds: readonly number[]; since: Date; until?: Date },
): Promise<SyncJournalMetrics[]> {
  if (input.pageIds.length === 0) return [];
  const pages = sql`${sql.param([...input.pageIds])}::bigint[]`;
  const until = input.until === undefined ? sql`'infinity'::timestamptz` : sql`${input.until}::timestamptz`;
  const sends = await db.execute<{
    pageId: string;
    urgent: number;
    requests: number;
    planned: number;
    minGapMs: number | string | null;
    violations: number;
  }>(sql`
    select s.page_id::text as "pageId",
           count(*) filter (where s.class = 'urgent')::int as urgent,
           count(*) filter (where s.class = 'requests')::int as requests,
           count(*) filter (where s.class = 'planned')::int as planned,
           min(s.gap_ms) as "minGapMs",
           count(*) filter (where s.gap_ms < s.setting_ms)::int as violations
      from (
        select a.page_id, a.class, a.setting_ms, a.sent_at,
               extract(epoch from a.sent_at - lag(a.sent_at) over (partition by a.page_id order by a.sent_at, a.id)) * 1000 as gap_ms
          from sync_attempts a
         where a.page_id = any(${pages})
           and not a.shadow
           and a.sent_at is not null
           and a.sent_at >= ${input.since}::timestamptz - ${SYNC_PACE_AUDIT_LOOKBACK_MS}::double precision * interval '1 millisecond'
           and a.sent_at < ${until}
      ) s
     where s.sent_at >= ${input.since}::timestamptz
     group by s.page_id
  `);
  const queue = await db.execute<{ pageId: string; breakers: number; blocked: number; quarantined: number }>(sql`
    select w.page_id::text as "pageId",
           count(*) filter (where w.breaker_until > statement_timestamp())::int as breakers,
           count(*) filter (where w.blocked_by_vendor_at is not null
                              and not ${syncWorkOfUnavailableChatSql(sql`w`)})::int as blocked,
           count(*) filter (where w.state = 'quarantined')::int as quarantined
      from sync_work w
     where w.page_id = any(${pages})
       and not w.shadow
       and w.state in ('open', 'running', 'quarantined')
     group by w.page_id
  `);
  const chats = await countUnavailableChats(db, { pageIds: input.pageIds });
  const sendsByPage = new Map(sends.rows.map((row) => [Number(row.pageId), row]));
  const queueByPage = new Map(queue.rows.map((row) => [Number(row.pageId), row]));
  return input.pageIds.map((pageId) => {
    const sent = sendsByPage.get(pageId);
    const work = queueByPage.get(pageId);
    return {
      pageId,
      sends: { urgent: Number(sent?.urgent ?? 0), requests: Number(sent?.requests ?? 0), planned: Number(sent?.planned ?? 0) },
      minGapMs: sent?.minGapMs === null || sent?.minGapMs === undefined ? null : Number(sent.minGapMs),
      paceViolations: Number(sent?.violations ?? 0),
      breakersOpen: Number(work?.breakers ?? 0),
      blockedByVendor: Number(work?.blocked ?? 0),
      quarantined: Number(work?.quarantined ?? 0),
      chatsUnavailable: chats.get(pageId) ?? 0,
    };
  });
}

export interface SyncOverlayMetrics {
  /** confirmed_at − first_visible_at over the window's confirmations. */
  confirmLagP50Ms: number | null;
  confirmLagP95Ms: number | null;
  /** Mismatch verdicts of the window by field (`ws_rest_mismatch{field}`). */
  mismatchByField: Record<string, number>;
  /** `not_found` verdicts of the window (`dm_live_not_found`). The DM apply is
   *  their one writer: a REST read covered the message's place without it.
   *  (During a rollback the image before `confirm_wait_reason` writes them on
   *  its 24-hour timer too.) */
  notFound: number;
}

export async function readSyncOverlayMetrics(db: Database, input: { since: Date }): Promise<SyncOverlayMetrics> {
  const lag = await db.execute<{ p50: number | string | null; p95: number | string | null }>(sql`
    select percentile_cont(0.5) within group (order by extract(epoch from (confirmed_at - first_visible_at)) * 1000) as p50,
           percentile_cont(0.95) within group (order by extract(epoch from (confirmed_at - first_visible_at)) * 1000) as p95
      from dm_live_messages
     where confirmed_at > ${input.since}::timestamptz and first_visible_at is not null
  `);
  const mismatch = await db.execute<{ field: string; n: number }>(sql`
    select f.field, count(*)::int as n
      from dm_live_messages m, unnest(m.mismatch_fields) as f(field)
     where m.confirmed_at > ${input.since}::timestamptz and m.confirm_outcome = 'mismatch'
     group by f.field
  `);
  const notFound = await db.execute<{ n: number }>(sql`
    select count(*)::int as n
      from dm_live_messages
     where confirmed_at > ${input.since}::timestamptz and confirm_outcome = 'not_found'
  `);
  const number = (value: number | string | null | undefined) => value === null || value === undefined ? null : Number(value);
  return {
    confirmLagP50Ms: number(lag.rows[0]?.p50),
    confirmLagP95Ms: number(lag.rows[0]?.p95),
    mismatchByField: Object.fromEntries(mismatch.rows.map((row) => [row.field, Number(row.n)])),
    notFound: Number(notFound.rows[0]?.n ?? 0),
  };
}

export interface SyncHistoryMetrics {
  requestsOpen: number;
  readsDone: number;
  /** Σ max(estimate − spent, 0) over the open requests' unfinished fans. */
  readsRemaining: number;
  /** reads spent / reads estimated over the fans satisfied since `since`. */
  factOverForecast: number[];
}

export async function readSyncHistoryMetrics(db: Database, input: { since: Date }): Promise<SyncHistoryMetrics> {
  const open = await db.execute<{ requests: number; done: string | null; remaining: string | null }>(sql`
    select count(distinct r.id)::int as requests,
           sum(i.reads_spent)::text as done,
           sum(greatest(coalesce(i.estimate_reads, 0) - i.reads_spent, 0))
             filter (where i.state in ('queued', 'loading', 'blocked'))::text as remaining
      from history_requests r
      left join history_request_items i on i.request_id = r.id
     where r.state = 'open'
  `);
  const ratios = await db.execute<{ ratio: number | string }>(sql`
    select i.reads_spent::double precision / i.estimate_reads as ratio
      from history_request_items i
     where i.satisfied_at > ${input.since}::timestamptz
       and i.estimate_reads > 0
       and i.satisfied_by is distinct from 'already_satisfied'
  `);
  return {
    requestsOpen: Number(open.rows[0]?.requests ?? 0),
    readsDone: Number(open.rows[0]?.done ?? 0),
    readsRemaining: Number(open.rows[0]?.remaining ?? 0),
    factOverForecast: ratios.rows.map((row) => Number(row.ratio)),
  };
}

/** The newest owner acknowledgement of a page's pace violations. */
export const SYNC_ALERTS_ACK_AUDIT_EVENT = "admin.sync_alerts_ack";

/** Whether any Fansly page is in the engine (`handover`, `live`): then the
 *  `sync` process must be beating (alert 5). */
export async function hasSyncPageInEngine(db: Database): Promise<boolean> {
  const result = await db.execute<{ engaged: boolean }>(sql`
    select exists (select 1 from sync_pages where mode in ('handover', 'live')) as engaged
  `);
  return result.rows[0]?.engaged === true;
}
