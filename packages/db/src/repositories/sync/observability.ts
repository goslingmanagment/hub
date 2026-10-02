import { sql } from "drizzle-orm";
import { FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_KEY } from "@agency_hub_core/shared";

import type { Database } from "../../client.ts";
import { capturePayloadRefFromColumns, type CapturePayloadRef } from "../capture-payloads.ts";
import { SYNC_PACE_AUDIT_LOOKBACK_MS } from "./attempts.ts";
import { textArrayParam, toDate, toRequiredDate } from "./values.ts";

// Fansly Sync Engine: the reads behind its alerts, its golden signals and the
// shadow report (plan §10, design §3.12, §9.5, §9.6). Reads only; every
// window is an index range (`sync_attempts_page_admitted`, `_page_sent`,
// `sync_work_runnable`, the receipts' primary key below an id watermark).
// Live and shadow are separate journals (`shadow`).

/** Attempt error classes that stop a page (alert 1): a 429 of the page, a
 *  refused credential, another account behind the credentials. */
export const SYNC_PAGE_STOP_ERROR_CLASSES = ["rate_limit", "auth", "identity_mismatch"] as const;

/** A socket whose receiver has not renewed its connection row for this long
 *  is down (the receiver renews it every few seconds). */
export const SYNC_WS_CONNECTION_STALE_MS = 60_000;

export interface SyncJournalAlertFacts {
  /** The newest attempt within the look-back whose class stops the page. */
  lastStopAttempt: { errorClass: string; at: Date } | null;
  /** Quarantined work by resource. */
  quarantined: Record<string, number>;
  /** Open urgent work due longer than `urgentAfterMs` ago (at most 200 rows). */
  urgentWaiting: Array<{ resource: string; subject: string; dueAt: Date; waitingReason: string | null }>;
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
  input: { pageId: number; shadow: boolean; stopLookbackMs: number; urgentAfterMs: number; requestStallMs: number },
): Promise<SyncJournalAlertFacts> {
  const stop = await db.execute<{ errorClass: string; at: Date | string }>(sql`
    select a.error_class as "errorClass", coalesce(a.completed_at, a.admitted_at) as at
      from sync_attempts a
     where a.page_id = ${input.pageId}
       and a.shadow = ${input.shadow}::boolean
       and a.admitted_at > statement_timestamp() - ${input.stopLookbackMs}::double precision * interval '1 millisecond'
       and a.error_class = any(${textArrayParam(SYNC_PAGE_STOP_ERROR_CLASSES)})
     order by a.admitted_at desc
     limit 1
  `);
  const quarantined = await db.execute<{ resource: string; n: number }>(sql`
    select w.resource, count(*)::int as n
      from sync_work w
     where w.page_id = ${input.pageId} and w.shadow = ${input.shadow}::boolean and w.state = 'quarantined'
     group by w.resource
  `);
  const urgent = await db.execute<{ resource: string; subject: string; dueAt: Date | string; waitingReason: string | null }>(sql`
    select w.resource, w.subject, w.due_at as "dueAt", w.waiting_reason as "waitingReason"
      from sync_work w
     where w.page_id = ${input.pageId}
       and w.shadow = ${input.shadow}::boolean
       and w.class = 'urgent'
       and w.state = 'open'
       and w.due_at < statement_timestamp() - ${input.urgentAfterMs}::double precision * interval '1 millisecond'
     order by w.due_at
     limit 200
  `);
  const polls = await db.execute<{ resource: string; lastServedAt: Date | string | null; createdAt: Date | string }>(sql`
    select w.resource, w.last_served_at as "lastServedAt", w.created_at as "createdAt"
      from sync_work w
     where w.page_id = ${input.pageId}
       and w.shadow = ${input.shadow}::boolean
       and w.kind = 'poll'
       and w.state in ('open', 'running')
  `);
  const ledger = await db.execute<{ missing: string | null; at: Date | string }>(sql`
    select w.proof ->> 'ledgerIncomplete' as missing, w.closed_at as at
      from sync_work w
     where w.page_id = ${input.pageId}
       and w.resource = 'transactions.rescan'
       and w.subject = ''
       and w.shadow = ${input.shadow}::boolean
       and w.state = 'done'
     order by w.id desc
     limit 1
  `);
  // History requests exist only on live pages (the intake refuses the rest).
  const stalled = input.shadow
    ? { rows: [] as Array<{ requestRef: string; lastServedAt: Date | string | null; createdAt: Date | string }> }
    : await db.execute<{ requestRef: string; lastServedAt: Date | string | null; createdAt: Date | string }>(sql`
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

export interface SyncLivePathFacts {
  /** The page's socket: up = a connection row renewed within the stale bound;
   *  else when it was last seen alive (null: the page never had one). */
  socket: { up: boolean; lastAliveAt: Date | null };
  /** Receipts captured within `decodeWindowMs`, and how many the overlay
   *  acked as decode debt. */
  decode: { receipts: number; debt: number };
  /** Fan messages the socket showed that no REST read confirmed for longer
   *  than `unconfirmedAfterMs` (excluded and hidden chats left out). */
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
  const unconfirmed = await db.execute<{ n: number; oldest: Date | string | null }>(sql`
    select count(*)::int as n, min(m.first_visible_at) as oldest
      from dm_live_messages m
      left join page_dm_threads t
        on t.platform_account_id = m.page_id and t.platform_conversation_id = m.platform_conversation_id
     where m.page_id = ${input.pageId}
       and m.confirmed_at is null
       and m.confirm_due_at is not null
       and m.confirm_due_at < statement_timestamp()
       and m.deleted_at is null
       and m.is_sent_by_page is false
       and m.first_visible_at < statement_timestamp() - ${input.unconfirmedAfterMs}::double precision * interval '1 millisecond'
       and coalesce(t.is_visible, true)
       and coalesce(t.metadata ->> ${FANSLY_DM_MESSAGE_SYNC_EXCLUDED_REASON_KEY}::text, '') = ''
  `);
  const socketRow = socket.rows[0];
  return {
    socket: { up: socketRow?.up === true, lastAliveAt: toDate(socketRow?.lastAliveAt) },
    decode: { receipts: Number(decode.rows[0]?.receipts ?? 0), debt: Number(decode.rows[0]?.debt ?? 0) },
    unconfirmed: { count: Number(unconfirmed.rows[0]?.n ?? 0), oldestVisibleAt: toDate(unconfirmed.rows[0]?.oldest) },
  };
}

/**
 * The newest receipt id received at or before `at` (0 without one). The
 * receipts have no time index: a backward scan of the primary key stops at the
 * first row old enough, so a window `observation_id > floor` reads only the
 * receipts received since (a capture stamps `received_at` before it allocates
 * its id, the same argument as `wsRouterHorizonWatermark`).
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
  input: { pageIds: readonly number[]; shadow: boolean; since: Date; until?: Date },
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
           and a.shadow = ${input.shadow}::boolean
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
       and w.shadow = ${input.shadow}::boolean
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
  const number = (value: number | string | null | undefined) => value === null || value === undefined ? null : Number(value);
  return {
    confirmLagP50Ms: number(lag.rows[0]?.p50),
    confirmLagP95Ms: number(lag.rows[0]?.p95),
    mismatchByField: Object.fromEntries(mismatch.rows.map((row) => [row.field, Number(row.n)])),
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

/** Whether any Fansly page is in the engine (`shadow`, `handover`, `live`):
 *  then the `sync` process must be beating (alert 5). */
export async function hasSyncPageInEngine(db: Database): Promise<boolean> {
  const result = await db.execute<{ engaged: boolean }>(sql`
    select exists (select 1 from sync_pages where mode <> 'off') as engaged
  `);
  return result.rows[0]?.engaged === true;
}

// ── the shadow report (design §3.12) ─────────────────────────────────────────

/** Attempts of the pages sent (or, in shadow, simulated) in [from, to), by
 *  page, class and resource. */
export async function countSyncAttemptsByKey(
  db: Database,
  input: { pageIds: readonly number[]; shadow: boolean; from: Date; to: Date },
): Promise<Array<{ pageId: number; class: string; resource: string; attempts: number }>> {
  if (input.pageIds.length === 0) return [];
  const result = await db.execute<{ pageId: string; class: string; resource: string; attempts: number }>(sql`
    select a.page_id::text as "pageId", a.class, a.resource, count(*)::int as attempts
      from sync_attempts a
     where a.page_id = any(${sql.param([...input.pageIds])}::bigint[])
       and a.shadow = ${input.shadow}::boolean
       and a.sent_at >= ${input.from}::timestamptz
       and a.sent_at < ${input.to}::timestamptz
     group by a.page_id, a.class, a.resource
  `);
  return result.rows.map((row) => ({ pageId: Number(row.pageId), class: row.class, resource: row.resource, attempts: Number(row.attempts) }));
}

/** The admissions of `resources` in [from, to) (admission order). */
export async function listSyncAdmissions(
  db: Database,
  input: { pageIds: readonly number[]; shadow: boolean; resources: readonly string[]; from: Date; to: Date },
): Promise<Array<{ pageId: number; resource: string; subject: string; admittedAt: Date }>> {
  if (input.pageIds.length === 0 || input.resources.length === 0) return [];
  const result = await db.execute<{ pageId: string; resource: string; subject: string; admittedAt: Date | string }>(sql`
    select a.page_id::text as "pageId", a.resource, a.subject, a.admitted_at as "admittedAt"
      from sync_attempts a
     where a.page_id = any(${sql.param([...input.pageIds])}::bigint[])
       and a.shadow = ${input.shadow}::boolean
       and a.resource = any(${textArrayParam(input.resources)})
       and a.admitted_at >= ${input.from}::timestamptz
       and a.admitted_at < ${input.to}::timestamptz
     order by a.admitted_at, a.id
  `);
  return result.rows.map((row) => ({
    pageId: Number(row.pageId),
    resource: row.resource,
    subject: row.subject,
    admittedAt: toRequiredDate(row.admittedAt),
  }));
}

/** The legacy engine's physical attempts of the pages in [from, to): stream
 *  chunks by stream and operation (`sync_http_attempts`), and the guarded
 *  senders outside stream runs by source (`fansly_send_log`). */
export async function countLegacyFanslyAttempts(
  db: Database,
  input: { pageIds: readonly number[]; from: Date; to: Date },
): Promise<{
  streams: Array<{ pageId: number; stream: string; operation: string; attempts: number }>;
  senders: Array<{ pageId: number; source: string; attempts: number }>;
}> {
  if (input.pageIds.length === 0) return { streams: [], senders: [] };
  const pages = sql`${sql.param([...input.pageIds])}::bigint[]`;
  const streams = await db.execute<{ pageId: string; stream: string; operation: string; attempts: number }>(sql`
    select a.page_id::text as "pageId", a.stream::text as stream, a.operation, count(*)::int as attempts
      from sync_http_attempts a
     where a.started_at >= ${input.from}::timestamptz
       and a.started_at < ${input.to}::timestamptz
       and a.provider = 'fansly'
       and a.page_id = any(${pages})
     group by a.page_id, a.stream, a.operation
  `);
  const senders = await db.execute<{ pageId: string; source: string; attempts: number }>(sql`
    select l.page_id::text as "pageId", l.source, count(*)::int as attempts
      from fansly_send_log l
     where l.page_id = any(${pages})
       and l.captured_at >= ${input.from}::timestamptz
       and l.captured_at < ${input.to}::timestamptz
       and l.source <> 'sync_stream'
       and l.sent_at is not null
     group by l.page_id, l.source
  `);
  return {
    streams: streams.rows.map((row) => ({ pageId: Number(row.pageId), stream: row.stream, operation: row.operation, attempts: Number(row.attempts) })),
    senders: senders.rows.map((row) => ({ pageId: Number(row.pageId), source: row.source, attempts: Number(row.attempts) })),
  };
}

/** When the legacy stores first held each of `messageIds` of the page: the
 *  earlier of `page_dm_messages.synced_at` and `message_archive.archived_at`. */
export async function readLegacyMessageArrivals(
  db: Database,
  input: { pageId: number; messageIds: readonly string[] },
): Promise<Map<string, Date>> {
  if (input.messageIds.length === 0) return new Map();
  const ids = textArrayParam([...new Set(input.messageIds)]);
  const result = await db.execute<{ messageId: string; at: Date | string }>(sql`
    select s.message_id as "messageId", min(s.at) as at
      from (
        select m.platform_message_id as message_id, m.synced_at as at
          from page_dm_messages m
         where m.platform_account_id = ${input.pageId} and m.platform_message_id = any(${ids})
        union all
        select a.message_ref, a.archived_at
          from message_archive a
         where a.account_id = ${input.pageId} and a.platform = 'fansly' and a.message_ref = any(${ids})
      ) s
     group by s.message_id
  `);
  return new Map(result.rows.map((row) => [row.messageId, toRequiredDate(row.at)]));
}

/** One journaled observation offered to a resource's replay. */
export interface SyncReplayObservationRow {
  id: number;
  receivedAt: Date;
  pageId: number;
  kind: string;
  payload: unknown;
  payloadRef: CapturePayloadRef | null;
}

/**
 * Observations of one kind of the pages, newest first, strictly before the
 * keyset `before` (served by `observations_kind_received_idx`). Socket frames
 * are not replayed here.
 */
export async function listSyncReplayObservations(
  db: Database,
  input: { kind: string; pageIds: readonly number[]; before: { receivedAt: Date; id: number } | null; limit: number },
): Promise<SyncReplayObservationRow[]> {
  if (input.pageIds.length === 0) return [];
  const before = input.before === null
    ? sql`true`
    : sql`(o.received_at, o.id) < (${input.before.receivedAt}::timestamptz, ${input.before.id}::bigint)`;
  const result = await db.execute<{
    id: string;
    receivedAt: Date | string;
    pageId: string;
    kind: string;
    payload: unknown;
    bucket: string | null;
    objectId: string | null;
  }>(sql`
    select o.id::text as id, o.received_at as "receivedAt", o.account_id::text as "pageId", o.kind, o.payload,
           to_char(o.payload_bucket_month, 'YYYY-MM-DD') as bucket, o.payload_object_id::text as "objectId"
      from observations o
     where o.kind = ${input.kind}
       and o.account_id = any(${sql.param([...input.pageIds])}::bigint[])
       and o.source <> 'fansly_ws'
       and ${before}
     order by o.received_at desc, o.id desc
     limit ${input.limit}
  `);
  return result.rows.map((row) => ({
    id: Number(row.id),
    receivedAt: toRequiredDate(row.receivedAt),
    pageId: Number(row.pageId),
    kind: row.kind,
    payload: row.payload,
    payloadRef: capturePayloadRefFromColumns(row.bucket, row.objectId),
  }));
}
