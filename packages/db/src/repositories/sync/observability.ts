import { sql, type SQL } from "drizzle-orm";
import { FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_KEY } from "@agency_hub_core/shared";

import type { Database } from "../../client.ts";
import { capturePayloadRefFromColumns, type CapturePayloadRef } from "../capture-payloads.ts";
import { SYNC_PACE_AUDIT_LOOKBACK_MS } from "./attempts.ts";
import { textArrayParam, toDate, toRequiredDate } from "./values.ts";

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
  /** The page's poll rows (one per poll key). */
  polls: Array<{ resource: string; lastServedAt: Date | null; createdAt: Date }>;
  /** The newest finished `transactions.rescan` proved the ledger short of the
   *  vendor's lifetime total by this many rows. */
  ledgerIncomplete: { missing: number; at: Date } | null;
  /** Open history requests with runnable work and no read within the bound. */
  stalledRequests: Array<{ requestRef: string; lastServedAt: Date | null; createdAt: Date }>;
}

/**
 * The journal facts of one page's alerts 1, 2 (quarantine), 3 (urgent wait)
 * and 4 (design §9.6), as of the database clock.
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
  const polls = await db.execute<{ resource: string; lastServedAt: Date | string | null; createdAt: Date | string }>(sql`
    select w.resource, w.last_served_at as "lastServedAt", w.created_at as "createdAt"
      from sync_work w
     where w.page_id = ${input.pageId}
       and not w.shadow
       and w.kind = 'poll'
       and w.state in ('open', 'running')
  `);
  const ledger = await db.execute<{ missing: string | null; at: Date | string }>(sql`
    select w.proof ->> 'ledgerIncomplete' as missing, w.closed_at as at
      from sync_work w
     where w.page_id = ${input.pageId}
       and w.resource = 'transactions.rescan'
       and w.subject = ''
       and not w.shadow
       and w.state = 'done'
     order by w.id desc
     limit 1
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
  const ledgerRow = ledger.rows[0];
  const missing = ledgerRow?.missing === null || ledgerRow?.missing === undefined ? 0 : Number(ledgerRow.missing);
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
      lastServedAt: toDate(row.lastServedAt),
      createdAt: toRequiredDate(row.createdAt),
    })),
    ledgerIncomplete: ledgerRow && missing > 0 ? { missing, at: toRequiredDate(ledgerRow.at) } : null,
    stalledRequests: stalled.rows.map((row) => ({
      requestRef: row.requestRef,
      lastServedAt: toDate(row.lastServedAt),
      createdAt: toRequiredDate(row.createdAt),
    })),
  };
}

/**
 * The one definition of a socket message still awaiting its REST
 * confirmation, for every reader that counts "unconfirmed" (alert 3's
 * `message_unconfirmed`, `sync check live-hour`). `message` is the qualified
 * alias of a `dm_live_messages` row. Awaiting means:
 * - no verdict (`confirmed_at` null) and not deferred (`confirm_wait_reason`
 *   null): a row the parity window passed without a REST copy, or of a chat
 *   Fansly does not serve to the page, is no longer awaited — a later REST
 *   read still settles it, nothing pages for it;
 * - a next look of the parity pass (`confirm_due_at`): every awaited row has
 *   one, a deferred row and a deletion stub have none (it also keeps the
 *   partial index `dm_live_messages_confirm_due` usable);
 * - not deleted on the socket;
 * - not in a chat excluded from message sync or hidden (a message of a chat
 *   Hub has no thread row for counts).
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

export interface SyncLivePathFacts {
  /** The page's socket: up = a connection row renewed within the stale bound;
   *  else when it was last seen alive (null: the page never had one). */
  socket: { up: boolean; lastAliveAt: Date | null };
  /** Receipts captured within `decodeWindowMs`, and how many the overlay
   *  acked as decode debt. */
  decode: { receipts: number; debt: number };
  /** Fan messages the socket showed that no REST read confirmed for longer
   *  than `unconfirmedAfterMs` and that are still awaited
   *  (`dmLiveAwaitingConfirmSql`: deferred rows, excluded and hidden chats
   *  left out), whenever the parity pass looks next. */
  unconfirmed: { count: number; oldestVisibleAt: Date | null };
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
  // counts; deletion stubs have no next look either.
  const unconfirmed = await db.execute<{ n: number; oldest: Date | string | null }>(sql`
    select count(*)::int as n, min(m.first_visible_at) as oldest
      from dm_live_messages m
     where m.page_id = ${input.pageId}
       and m.is_sent_by_page is false
       and m.first_visible_at < statement_timestamp() - ${input.unconfirmedAfterMs}::double precision * interval '1 millisecond'
       and ${dmLiveAwaitingConfirmSql(sql`m`)}
  `);
  const socketRow = socket.rows[0];
  return {
    socket: { up: socketRow?.up === true, lastAliveAt: toDate(socketRow?.lastAliveAt) },
    decode: { receipts: Number(decode.rows[0]?.receipts ?? 0), debt: Number(decode.rows[0]?.debt ?? 0) },
    unconfirmed: { count: Number(unconfirmed.rows[0]?.n ?? 0), oldestVisibleAt: toDate(unconfirmed.rows[0]?.oldest) },
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
  blockedByVendor: number;
  quarantined: number;
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
           count(*) filter (where w.blocked_by_vendor_at is not null)::int as blocked,
           count(*) filter (where w.state = 'quarantined')::int as quarantined
      from sync_work w
     where w.page_id = any(${pages})
       and not w.shadow
       and w.state in ('open', 'running', 'quarantined')
     group by w.page_id
  `);
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
