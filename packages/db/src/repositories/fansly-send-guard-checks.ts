import { sql, type SQL } from "drizzle-orm";

import type { Database } from "../client.ts";

// Plan §2.4 «проверка, а не вера» and §10: what the send guard's journal
// (fansly_send_log, 0225) proves, read back. Two readers:
//
//   - the minutely pace check (apps/runtime/.../fansly-send-guard/monitor.ts):
//     every new journal row, through a durable cursor (0227), is compared with
//     its neighbours by actual send time across ALL sources; any pair of sends
//     of one page closer than the pause setting in force for the later one is
//     a violation;
//   - the acceptance report (`fansly-send-guard report`): per page, what was
//     sent, how close, what the guard held back, what came back, and when the
//     page was closed. Read-only.
//
// Sends are compared by `sent_at`: the sender's wall clock when the transport
// was about to write the request headers. Every process of the hub runs on the
// one production host, so they share that clock.

/** How long a journal row may stay without a completion before the pace check
 *  takes it as it is (a holder that died before completing; its send moment
 *  was written when it sent). Longer than any lease. */
export const FANSLY_SEND_PACE_STALE_MS = 5 * 60_000;
/** A row younger than this is not examined yet: ids are drawn at insert, so a
 *  smaller id can still be committing. */
export const FANSLY_SEND_PACE_SETTLE_MS = 10_000;
/** Neighbours are searched this far around a batch, at least: the pause
 *  setting is at most 60 s (FANSLY_PAUSE_MAX_MS), so a closer pair is never
 *  further apart. A larger setting on a batch row widens it. */
const PACE_NEIGHBOUR_PAD_MS = 60_000;
/** A send is at most its send window after its capture; the capture-time
 *  index is searched this much wider than the send-time span. */
const SEND_AFTER_CAPTURE_PAD_MS = 10 * 60_000;

export interface FanslySendPaceCursor {
  afterId: number;
  checkedAt: Date | null;
}

export async function readFanslySendPaceCursor(db: Database): Promise<FanslySendPaceCursor> {
  const result = await db.execute<{ afterId: string; checkedAt: Date | string | null }>(sql`
    select after_id::text as "afterId", checked_at as "checkedAt"
      from fansly_send_pace_cursor
     where id = 1
  `);
  const row = result.rows[0];
  if (!row) {
    // The 0227 seed row is gone (a hand edit): start over from the beginning.
    await db.execute(sql`insert into fansly_send_pace_cursor (id) values (1) on conflict (id) do nothing`);
    return { afterId: 0, checkedAt: null };
  }
  return {
    afterId: Number(row.afterId),
    checkedAt: row.checkedAt === null ? null : new Date(row.checkedAt),
  };
}

/**
 * The newest journal id the pace check may examine now: the end of the
 * longest run of rows after `afterId` (in id order, at most `limit`) that are
 * settled (older than FANSLY_SEND_PACE_SETTLE_MS) and final — completed, or
 * older than FANSLY_SEND_PACE_STALE_MS. The run stops at the first row still
 * in flight, so no row is ever skipped. Returns `afterId` when nothing is ready.
 */
export async function findFanslySendPaceBatchEnd(
  db: Database,
  input: { afterId: number; limit: number },
): Promise<{ throughId: number; examined: number }> {
  const result = await db.execute<{ id: string; ready: boolean }>(sql`
    select id::text as id,
           (captured_at <= clock_timestamp() - ${FANSLY_SEND_PACE_SETTLE_MS}::double precision * interval '1 millisecond'
             and (completed_at is not null
               or captured_at <= clock_timestamp() - ${FANSLY_SEND_PACE_STALE_MS}::double precision * interval '1 millisecond'))
             as ready
      from fansly_send_log
     where id > ${input.afterId}
     order by id
     limit ${input.limit}
  `);
  let throughId = input.afterId;
  let examined = 0;
  for (const row of result.rows) {
    if (row.ready !== true) break;
    throughId = Number(row.id);
    examined += 1;
  }
  return { throughId, examined };
}

export interface FanslySendPaceSend {
  id: number;
  sentAt: Date;
  source: string;
  operation: string;
  holderRole: string;
  holderHost: string;
}

export interface FanslySendPaceViolation {
  pageId: number;
  pageLabel: string | null;
  earlier: FanslySendPaceSend;
  later: FanslySendPaceSend;
  /** later.sentAt − earlier.sentAt. */
  gapMs: number;
  /** The setting in force for the later send (read before its capture). */
  settingMs: number;
}

type ViolationSqlRow = {
  pageId: string;
  pageLabel: string | null;
  earlierId: string;
  earlierSentAt: Date | string;
  earlierSource: string;
  earlierOperation: string;
  earlierRole: string;
  earlierHost: string;
  laterId: string;
  laterSentAt: Date | string;
  laterSource: string;
  laterOperation: string;
  laterRole: string;
  laterHost: string;
  gapMs: string | number;
  settingMs: number;
};

function toViolation(row: ViolationSqlRow): FanslySendPaceViolation {
  return {
    pageId: Number(row.pageId),
    pageLabel: row.pageLabel,
    earlier: {
      id: Number(row.earlierId),
      sentAt: new Date(row.earlierSentAt),
      source: row.earlierSource,
      operation: row.earlierOperation,
      holderRole: row.earlierRole,
      holderHost: row.earlierHost,
    },
    later: {
      id: Number(row.laterId),
      sentAt: new Date(row.laterSentAt),
      source: row.laterSource,
      operation: row.laterOperation,
      holderRole: row.laterRole,
      holderHost: row.laterHost,
    },
    gapMs: Number(row.gapMs),
    settingMs: Number(row.settingMs),
  };
}

/** The columns both violation queries select from their `ordered` CTE. */
const violationColumns = sql`
  o.page_id::text as "pageId",
  p.label as "pageLabel",
  o.prev_id::text as "earlierId",
  o.prev_sent_at as "earlierSentAt",
  o.prev_source as "earlierSource",
  o.prev_operation as "earlierOperation",
  o.prev_role as "earlierRole",
  o.prev_host as "earlierHost",
  o.id::text as "laterId",
  o.sent_at as "laterSentAt",
  o.source as "laterSource",
  o.operation as "laterOperation",
  o.holder_role as "laterRole",
  o.holder_host as "laterHost",
  extract(epoch from (o.sent_at - o.prev_sent_at)) * 1000 as "gapMs",
  o.setting_ms as "settingMs"
`;

/** Consecutive sends per page by send time, each with its predecessor. */
const orderedSendsWindow = sql`
  select s.*,
         lag(s.id) over w as prev_id,
         lag(s.sent_at) over w as prev_sent_at,
         lag(s.source) over w as prev_source,
         lag(s.operation) over w as prev_operation,
         lag(s.holder_role) over w as prev_role,
         lag(s.holder_host) over w as prev_host
    from sends s
  window w as (partition by s.page_id order by s.sent_at, s.id)
`;

/**
 * Every pair of consecutive sends of one page (by `sent_at`, all sources)
 * closer than the setting of the later send, whose newer row (the larger id)
 * is in (afterId, throughId]. Each pair is found exactly once over a sequence
 * of contiguous batches; neighbours outside the batch are searched among all
 * journal rows.
 */
export async function findFanslySendPaceViolations(
  db: Database,
  input: { afterId: number; throughId: number },
): Promise<FanslySendPaceViolation[]> {
  if (input.throughId <= input.afterId) return [];
  const result = await db.execute<ViolationSqlRow>(sql`
    with batch as (
      select id, page_id, sent_at, setting_ms
        from fansly_send_log
       where id > ${input.afterId} and id <= ${input.throughId}
         and page_id is not null and sent_at is not null
    ), pad as (
      select greatest(${PACE_NEIGHBOUR_PAD_MS}, coalesce(max(setting_ms), 0))::double precision
               * interval '1 millisecond' as span
        from batch
    ), span as (
      select b.page_id, min(b.sent_at) - pad.span as lo, max(b.sent_at) + pad.span as hi
        from batch b cross join pad
       group by b.page_id, pad.span
    ), sends as (
      select l.id, l.page_id, l.sent_at, l.setting_ms, l.source, l.operation, l.holder_role, l.holder_host
        from fansly_send_log l
        join span s on s.page_id = l.page_id
       where l.sent_at is not null
         and l.sent_at between s.lo and s.hi
         and l.captured_at between s.lo - ${SEND_AFTER_CAPTURE_PAD_MS}::double precision * interval '1 millisecond'
                               and s.hi
    ), ordered as (${orderedSendsWindow})
    select ${violationColumns}
      from ordered o
      left join pages p on p.id = o.page_id
     where o.prev_id is not null
       and o.setting_ms is not null
       and o.sent_at - o.prev_sent_at < o.setting_ms::double precision * interval '1 millisecond'
       and greatest(o.id, o.prev_id) > ${input.afterId}
       and greatest(o.id, o.prev_id) <= ${input.throughId}
     order by o.sent_at, o.id
  `);
  return result.rows.map(toViolation);
}

/** Move the cursor from `fromId` to `toId`. Compare-and-set: false when
 *  another checker moved it first (its batch covered the same rows). */
export async function advanceFanslySendPaceCursor(
  db: Database,
  input: { fromId: number; toId: number },
): Promise<boolean> {
  const result = await db.execute(sql`
    update fansly_send_pace_cursor
       set after_id = ${input.toId},
           checked_at = clock_timestamp(),
           updated_at = clock_timestamp()
     where id = 1
       and after_id = ${input.fromId}
  `);
  return (result.rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// The acceptance report.

export interface FanslySendReportPage {
  pageId: number;
  pageLabel: string | null;
}

export interface FanslySendReportAttempts {
  pageId: number;
  attempts: number;
  sends: number;
  inFlight: number;
  /** Attempts whose capture the guard refused at least once (pause or busy). */
  attemptsThatWaited: number;
  captureRefusals: number;
  /** Dispatches the send check refused (nothing was written to the socket). */
  sendRefusals: number;
  captureWaitMsTotal: number;
  captureWaitMsMax: number;
  settingMsMin: number | null;
  settingMsMax: number | null;
}

export interface FanslySendReportSourceRow {
  pageId: number;
  source: string;
  attempts: number;
  sends: number;
}

export interface FanslySendReportOutcomeRow {
  pageId: number;
  outcome: string | null;
  httpStatus: number | null;
  attempts: number;
}

export interface FanslySendReportGaps {
  pageId: number;
  /** Consecutive pairs whose later send is in the window. */
  pairs: number;
  pairsCloserThanSetting: number;
  minGapMs: number | null;
  minGapSettingMs: number | null;
  minGapAt: Date | null;
}

export interface FanslySendReportClosedPeriod {
  pageId: number;
  /** The lease end: from here the page was closed. */
  closedFrom: Date;
  /** The completion or confirmed termination; null = still closed. */
  closedUntil: Date | null;
  outcome: string | null;
  outcomeDetail: string | null;
  source: string;
  operation: string;
  holderRole: string;
  holderHost: string;
  holderPid: number;
  guardToken: string;
}

export interface FanslySendReportData {
  since: Date;
  until: Date;
  pages: FanslySendReportPage[];
  attempts: FanslySendReportAttempts[];
  sources: FanslySendReportSourceRow[];
  outcomes: FanslySendReportOutcomeRow[];
  gaps: FanslySendReportGaps[];
  violations: FanslySendPaceViolation[];
  closedPeriods: FanslySendReportClosedPeriod[];
  /** Attempts without a page (checks of an unknown session) in the window. */
  unpacedAttempts: number;
}

/** The Fansly pages the report covers: every page with a guard row, or the
 *  one named. */
async function listReportPages(db: Database, pageLabel: string | null): Promise<FanslySendReportPage[]> {
  const result = await db.execute<{ pageId: string; pageLabel: string | null }>(sql`
    select g.page_id::text as "pageId", p.label as "pageLabel"
      from fansly_page_send_guards g
      left join pages p on p.id = g.page_id
     where (${pageLabel}::text is null or p.label = ${pageLabel})
     order by p.label nulls last, g.page_id
  `);
  return result.rows.map((row) => ({ pageId: Number(row.pageId), pageLabel: row.pageLabel }));
}

/**
 * Everything the acceptance report prints, for attempts captured since
 * `since` (sends: sent since `since`). Read-only.
 */
export async function readFanslySendReport(
  db: Database,
  input: { since: Date; pageLabel: string | null; violationLimit: number },
): Promise<FanslySendReportData> {
  const clock = await db.execute<{ now: Date | string }>(sql`select clock_timestamp() as now`);
  const until = new Date(clock.rows[0]?.now ?? Date.now());
  const pages = await listReportPages(db, input.pageLabel);
  const pageIds = pages.map((page) => page.pageId);
  const empty: FanslySendReportData = {
    since: input.since,
    until,
    pages,
    attempts: [],
    sources: [],
    outcomes: [],
    gaps: [],
    violations: [],
    closedPeriods: [],
    unpacedAttempts: 0,
  };
  if (pageIds.length === 0) return empty;
  const pageList = sql.join(pageIds.map((id) => sql`${id}`), sql`, `);

  const attempts = await db.execute<{
    pageId: string; attempts: string; sends: string; inFlight: string; attemptsThatWaited: string;
    captureRefusals: string; sendRefusals: string; waitTotal: string; waitMax: string | null;
    settingMin: number | null; settingMax: number | null;
  }>(sql`
    select page_id::text as "pageId",
           count(*)::text as attempts,
           count(*) filter (where sent_at is not null)::text as sends,
           count(*) filter (where completed_at is null)::text as "inFlight",
           count(*) filter (where capture_refusals > 0)::text as "attemptsThatWaited",
           coalesce(sum(capture_refusals), 0)::text as "captureRefusals",
           count(*) filter (where outcome = 'aborted_before_send')::text as "sendRefusals",
           coalesce(sum(capture_wait_ms), 0)::text as "waitTotal",
           max(capture_wait_ms)::text as "waitMax",
           min(setting_ms) as "settingMin",
           max(setting_ms) as "settingMax"
      from fansly_send_log
     where page_id in (${pageList}) and captured_at >= ${input.since}
     group by page_id
  `);

  const sources = await db.execute<{ pageId: string; source: string; attempts: string; sends: string }>(sql`
    select page_id::text as "pageId", source,
           count(*)::text as attempts,
           count(*) filter (where sent_at is not null)::text as sends
      from fansly_send_log
     where page_id in (${pageList}) and captured_at >= ${input.since}
     group by page_id, source
     order by page_id, source
  `);

  const outcomes = await db.execute<{ pageId: string; outcome: string | null; httpStatus: number | null; attempts: string }>(sql`
    select page_id::text as "pageId", outcome, http_status as "httpStatus", count(*)::text as attempts
      from fansly_send_log
     where page_id in (${pageList}) and captured_at >= ${input.since}
     group by page_id, outcome, http_status
     order by page_id, outcome nulls first, http_status nulls first
  `);

  // The send just before the window counts as the first pair's predecessor.
  const gaps = await db.execute<{
    pageId: string; pairs: string; closer: string; minGapMs: string | null;
    minGapSettingMs: number | null; minGapAt: Date | string | null;
  }>(sql`
    with sends as (
      select page_id, id, sent_at, setting_ms,
             lag(sent_at) over (partition by page_id order by sent_at, id) as prev_sent_at
        from fansly_send_log
       where page_id in (${pageList})
         and sent_at is not null
         and captured_at >= ${input.since}::timestamptz
           - ${PACE_NEIGHBOUR_PAD_MS + SEND_AFTER_CAPTURE_PAD_MS}::double precision * interval '1 millisecond'
    ), pairs as (
      select page_id, sent_at, setting_ms,
             extract(epoch from (sent_at - prev_sent_at)) * 1000 as gap_ms
        from sends
       where prev_sent_at is not null and sent_at >= ${input.since}
    ), smallest as (
      select distinct on (page_id) page_id, gap_ms, setting_ms, sent_at
        from pairs
       order by page_id, gap_ms, sent_at
    )
    select p.page_id::text as "pageId",
           count(*)::text as pairs,
           count(*) filter (where p.setting_ms is not null and p.gap_ms < p.setting_ms)::text as closer,
           s.gap_ms::text as "minGapMs",
           s.setting_ms as "minGapSettingMs",
           s.sent_at as "minGapAt"
      from pairs p
      join smallest s on s.page_id = p.page_id
     group by p.page_id, s.gap_ms, s.setting_ms, s.sent_at
  `);

  const violations = await findFanslySendReportViolations(db, {
    pageList, since: input.since, limit: input.violationLimit,
  });

  const closed = await db.execute<{
    pageId: string; closedFrom: Date | string; closedUntil: Date | string | null; outcome: string | null;
    outcomeDetail: string | null; source: string; operation: string; holderRole: string; holderHost: string;
    holderPid: number; guardToken: string;
  }>(sql`
    select page_id::text as "pageId",
           lease_until as "closedFrom",
           completed_at as "closedUntil",
           outcome,
           outcome_detail as "outcomeDetail",
           source, operation,
           holder_role as "holderRole",
           holder_host as "holderHost",
           holder_pid as "holderPid",
           guard_token::text as "guardToken"
      from fansly_send_log
     where page_id in (${pageList})
       and lease_until is not null
       and lease_until < coalesce(completed_at, clock_timestamp())
       and coalesce(completed_at, clock_timestamp()) >= ${input.since}
     order by lease_until
  `);

  const unpaced = await db.execute<{ attempts: string }>(sql`
    select count(*)::text as attempts
      from fansly_send_log
     where page_id is null and captured_at >= ${input.since}
  `);

  return {
    ...empty,
    attempts: attempts.rows.map((row) => ({
      pageId: Number(row.pageId),
      attempts: Number(row.attempts),
      sends: Number(row.sends),
      inFlight: Number(row.inFlight),
      attemptsThatWaited: Number(row.attemptsThatWaited),
      captureRefusals: Number(row.captureRefusals),
      sendRefusals: Number(row.sendRefusals),
      captureWaitMsTotal: Number(row.waitTotal),
      captureWaitMsMax: row.waitMax === null ? 0 : Number(row.waitMax),
      settingMsMin: row.settingMin === null ? null : Number(row.settingMin),
      settingMsMax: row.settingMax === null ? null : Number(row.settingMax),
    })),
    sources: sources.rows.map((row) => ({
      pageId: Number(row.pageId),
      source: row.source,
      attempts: Number(row.attempts),
      sends: Number(row.sends),
    })),
    outcomes: outcomes.rows.map((row) => ({
      pageId: Number(row.pageId),
      outcome: row.outcome,
      httpStatus: row.httpStatus === null ? null : Number(row.httpStatus),
      attempts: Number(row.attempts),
    })),
    gaps: gaps.rows.map((row) => ({
      pageId: Number(row.pageId),
      pairs: Number(row.pairs),
      pairsCloserThanSetting: Number(row.closer),
      minGapMs: row.minGapMs === null ? null : Number(row.minGapMs),
      minGapSettingMs: row.minGapSettingMs === null ? null : Number(row.minGapSettingMs),
      minGapAt: row.minGapAt === null ? null : new Date(row.minGapAt),
    })),
    violations,
    closedPeriods: closed.rows.map((row) => ({
      pageId: Number(row.pageId),
      closedFrom: new Date(row.closedFrom),
      closedUntil: row.closedUntil === null ? null : new Date(row.closedUntil),
      outcome: row.outcome,
      outcomeDetail: row.outcomeDetail,
      source: row.source,
      operation: row.operation,
      holderRole: row.holderRole,
      holderHost: row.holderHost,
      holderPid: Number(row.holderPid),
      guardToken: row.guardToken,
    })),
    unpacedAttempts: Number(unpaced.rows[0]?.attempts ?? 0),
  };
}

/** The pairs closer than the setting whose later send is in the window, the
 *  earliest first, at most `limit`. */
async function findFanslySendReportViolations(
  db: Database,
  input: { pageList: SQL; since: Date; limit: number },
): Promise<FanslySendPaceViolation[]> {
  const result = await db.execute<ViolationSqlRow>(sql`
    with sends as (
      select id, page_id, sent_at, setting_ms, source, operation, holder_role, holder_host
        from fansly_send_log
       where page_id in (${input.pageList})
         and sent_at is not null
         and captured_at >= ${input.since}::timestamptz
           - ${PACE_NEIGHBOUR_PAD_MS + SEND_AFTER_CAPTURE_PAD_MS}::double precision * interval '1 millisecond'
    ), ordered as (${orderedSendsWindow})
    select ${violationColumns}
      from ordered o
      left join pages p on p.id = o.page_id
     where o.prev_id is not null
       and o.setting_ms is not null
       and o.sent_at >= ${input.since}
       and o.sent_at - o.prev_sent_at < o.setting_ms::double precision * interval '1 millisecond'
     order by o.sent_at, o.id
     limit ${input.limit}
  `);
  return result.rows.map(toViolation);
}
