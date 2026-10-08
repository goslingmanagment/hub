import { sql } from "drizzle-orm";

import {
  dmLiveAwaitingConfirmSql,
  getFanslySendGuard,
  getSyncPage,
  readFanslySendAudit,
  syncUrgentWaitingSql,
  type Database,
  type SyncPageMode,
  type SyncPageRow,
} from "@agency_hub_core/db";

import { holdSetOf } from "../engine/admission.ts";
import { SYNC_URGENT_WAIT_MS } from "../engine/alerts.ts";
import {
  acceptanceIncidentKeys,
  acceptanceRouteOf,
  acceptanceWindows,
  ACCEPTANCE_RULES,
  ACCEPTANCE_SLO_RESOURCES,
  authRefusalsCheck,
  isAcceptedVerdict,
  judgedByRouteRule,
  latencyCheck,
  mediaStartCheck,
  mismatchCheck,
  paceCombinedCheck,
  pageHoldCheck,
  pageVerdict,
  route429Check,
  route429Outcomes,
  routeBudgetsCheck,
  type AcceptanceCheck,
  type AcceptanceCheckName,
  type AcceptanceJournalRow,
  type AcceptanceWindow,
  type PageHoldRecord,
  type PageStopEpisode,
  type PageVerdict,
} from "./live-hour-rules.ts";

// `pnpm cli sync check live-hour --page P [--page Q …] --since <iso> [--until
// <iso>]` (step 3b ruling 13, A6): the check of a page's first hour on the
// engine as JSON on stdout (the runbook reads it), read-only — the acceptance
// of the step-3 switch until step 4 (S4-21), of an onboarded page since. The
// rules are `live-hour-rules.ts`; the pace and the route budgets are the send
// audit's (`engine/send-audit.ts`) over both journals — the combined pace
// audit — which the alert evaluator runs on every pass. Pages checked
// together share the window end T* + 1 h (T* = the last page's live instant).
// Exit code of the CLI: 0 every page accepted, 1 a page failed, 2 otherwise
// (inconclusive or for the owner's review).

export interface PageAcceptanceReport {
  page: string;
  pageId: number;
  mode: SyncPageMode;
  /** The instant the page became live (its mode's last change). */
  liveSince: string;
  /** T_i. */
  windowStart: string;
  verdict: PageVerdict;
  /** The failing checks of a `fail`, the open ones of an `inconclusive`. */
  reasons: AcceptanceCheckName[];
  checks: AcceptanceCheck[];
  /** Sends and 429s of the window by canonical route (the calibration's view). */
  routes: Array<{ route: string; sends: number; rate429s: number }>;
  /** The engine's failures of the window (an error class, or no answer) by
   *  route, outcome, class and status. */
  failures: Array<{ route: string; outcome: string | null; errorClass: string | null; httpStatus: number | null; attempts: number }>;
  /** Engine sends of the window by class/resource, for "volume explained". */
  volume: Array<{ class: string; resource: string; sends: number; admissions: number }>;
  /** Owner generations and their resume gaps; socket connections. */
  restarts: {
    generations: Array<{ generation: string; attempts: number; firstAdmit: string | null; lastDone: string | null; resumeGapSeconds: number | null }>;
    connections: Array<{ startedAt: string; verifiedAt: string | null; closedAt: string | null; stopReason: string | null; reconciled: boolean }>;
  };
}

export interface LiveHourReport {
  since: string;
  until: string | null;
  /** The last page's live instant. */
  tStar: string;
  /** T* + 1 h, or `until`. */
  windowEnd: string;
  /** min(windowEnd, now). */
  observedUntil: string;
  windowComplete: boolean;
  pages: PageAcceptanceReport[];
  /** Every page accepted without the owner (`pass` or `accepted_with_route_429`). */
  accepted: boolean;
}

/** The CLI's exit code for a report: 0 accepted, 1 a page failed, 2 open. */
export function acceptanceExitCode(report: Pick<LiveHourReport, "pages" | "accepted">): number {
  if (report.accepted) return 0;
  return report.pages.some((page) => page.verdict === "fail") ? 1 : 2;
}

function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return (value instanceof Date ? value : new Date(String(value))).toISOString();
}

function dateOf(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function ms(value: number): ReturnType<typeof sql> {
  return sql`${value}::double precision * interval '1 millisecond'`;
}

/** Both live journals of a page from `from` on (up to now: a 429's recovery
 *  may be read past the window end). */
async function readJournal(db: Database, pageId: number, from: Date): Promise<AcceptanceJournalRow[]> {
  const result = await db.execute<{
    journal: "engine" | "legacy";
    ref: number | string;
    operation: string;
    resource: string | null;
    at: Date | string | null;
    doneAt: Date | string;
    outcome: string | null;
    httpStatus: number | null;
    retryAfterMs: number | null;
    errorClass: string | null;
  }>(sql`
    select 'engine'::text as journal, a.id as ref, a.operation, a.resource,
           case when a.sent_at is not null or a.outcome in ('admitted', 'sent', 'unknown')
                then coalesce(a.sent_at, a.admitted_at + ${ms(ACCEPTANCE_RULES.sendWindowMs)}) end as at,
           coalesce(a.completed_at, a.sent_at, a.admitted_at) as "doneAt",
           a.outcome, a.http_status::int as "httpStatus", a.retry_after_ms as "retryAfterMs", a.error_class as "errorClass"
      from sync_attempts a
     where a.page_id = ${pageId} and not a.shadow and a.admitted_at >= ${from}::timestamptz
    union all
    select 'legacy'::text, l.id, l.operation, null,
           case when l.sent_at is not null or l.outcome is distinct from 'aborted_before_send'
                then coalesce(l.sent_at, l.completed_at, l.lease_until, l.captured_at + ${ms(ACCEPTANCE_RULES.sendWindowMs)}) end,
           coalesce(l.completed_at, l.sent_at, l.captured_at),
           l.outcome, l.http_status, null::int, null::text
      from fansly_send_log l
     where l.page_id = ${pageId} and l.captured_at >= ${from}::timestamptz
  `);
  return result.rows.map((row) => ({
    journal: row.journal,
    ref: Number(row.ref),
    operation: row.operation,
    resource: row.resource,
    at: row.at === null ? null : dateOf(row.at),
    doneAt: dateOf(row.doneAt),
    outcome: row.outcome,
    httpStatus: num(row.httpStatus),
    retryAfterMs: num(row.retryAfterMs),
    errorClass: row.errorClass,
  }));
}

/** The page's own holds as its hold set records them, the credentials hold
 *  first (`engine/admission.ts`). */
function pageHoldRecords(page: SyncPageRow): PageHoldRecord[] {
  const { credentials, timed } = holdSetOf(page.holds).page;
  return [credentials, timed].flatMap((hold) => (hold === null ? [] : [{ kind: hold.kind, since: hold.since, until: hold.until }]));
}

/** Every episode of the page's alert 1 (`page_stopped`): the latch row's
 *  newest, and the earlier ones the paging sweep recorded. */
async function readPageStops(db: Database, pageId: number): Promise<PageStopEpisode[]> {
  const key = acceptanceIncidentKeys(pageId).pageStopped;
  const result = await db.execute<{ openedAt: Date | string; lastSeenAt: Date | string | null; resolvedAt: Date | string | null; detail: string | null }>(sql`
    select n.opened_at as "openedAt", case when n.resolved_at is null then n.last_seen_at end as "lastSeenAt",
           n.resolved_at as "resolvedAt", n.error_code as detail
      from notification_incidents n
     where n.incident_key = ${key}
    union all
    select c.opened_at, null, c.resolved_at, null
      from notification_incident_cycles c
     where c.incident_key = ${key}
       and not exists (select 1 from notification_incidents n where n.incident_key = c.incident_key and n.opened_at = c.opened_at)
  `);
  return result.rows.map((row) => ({
    openedAt: dateOf(row.openedAt),
    lastSeenAt: row.lastSeenAt === null ? null : dateOf(row.lastSeenAt),
    resolvedAt: row.resolvedAt === null ? null : dateOf(row.resolvedAt),
    detail: row.detail,
  }));
}

/** The takeover boundary (I5): the engine's first send comes ≥ 1.2 × S after
 *  the guard row's last completion — the legacy engine's last request on a
 *  page the step-3 switch took over, the row's seed on a page born live — and
 *  no legacy capture follows the instant the row became the engine's. */
async function boundaryCheck(db: Database, pageId: number): Promise<AcceptanceCheck> {
  const guard = await getFanslySendGuard(db, pageId);
  const boundary = await db.execute<{ legacyAfterFlip: number; engineFirstSent: Date | string | null; settingMs: number | null }>(sql`
    select
      (select count(*)::int from fansly_send_log l
        where l.page_id = ${pageId} and l.captured_at > g.engine_switched_at) as "legacyAfterFlip",
      (select min(a.sent_at) from sync_attempts a
        where a.page_id = ${pageId} and not a.shadow and a.sent_at > g.engine_switched_at) as "engineFirstSent",
      (select max(a.setting_ms) from sync_attempts a
        where a.page_id = ${pageId} and not a.shadow and a.sent_at > g.engine_switched_at) as "settingMs"
      from fansly_page_send_guards g
     where g.page_id = ${pageId}
  `);
  const row = boundary.rows[0];
  const engineFirst = row?.engineFirstSent === null || row?.engineFirstSent === undefined ? null : dateOf(row.engineFirstSent);
  const boundaryGapMs = engineFirst === null || guard === null ? null : engineFirst.getTime() - guard.lastCompletedAt.getTime();
  const requiredMs = row?.settingMs === null || row?.settingMs === undefined ? null : Math.round(Number(row.settingMs) * 1.2);
  const legacyAfterFlip = Number(row?.legacyAfterFlip ?? 0);
  return {
    name: "handover_boundary",
    verdict: guard?.ownerEngine !== "fansly_sync_engine" || legacyAfterFlip > 0
      ? "fail"
      : boundaryGapMs === null || requiredMs === null
        ? "inconclusive"
        : boundaryGapMs >= requiredMs ? "pass" : "fail",
    detail: {
      ownerEngine: guard?.ownerEngine ?? null,
      engineSwitchedAt: iso(guard?.engineSwitchedAt ?? null),
      legacyLastCompleted: iso(guard?.lastCompletedAt ?? null),
      legacyCapturesAfterFlip: legacyAfterFlip,
      engineFirstSent: iso(engineFirst),
      boundaryGapMs: boundaryGapMs === null ? null : Math.round(boundaryGapMs),
      requiredMs,
    },
  };
}

/** Nothing stuck, nothing lost — the page as it stands now. Urgent work
 *  waits by alert 3's rule (`syncUrgentWaitingSql`): from its due time or the
 *  end of its own subject breaker (the vendor's block included), whichever
 *  is later — judged by `breaker_until`, not by a stored waiting reason. */
async function stuckCheck(db: Database, pageId: number, window: AcceptanceWindow): Promise<AcceptanceCheck> {
  const now = sql`${window.now}::timestamptz`;
  const result = await db.execute<Record<string, number>>(sql`
    select
      (select count(*)::int from sync_attempts a where a.page_id = ${pageId} and not a.shadow
         and a.outcome in ('admitted', 'sent') and a.admitted_at < ${now} - interval '2 minutes') as "attemptUnfinished",
      (select count(*)::int from sync_attempts a where a.page_id = ${pageId} and not a.shadow
         and a.apply_state in ('captured', 'deferred') and a.admitted_at < ${now} - interval '5 minutes') as "applyPending",
      (select count(*)::int from sync_attempts a where a.page_id = ${pageId} and not a.shadow
         and a.apply_state = 'quarantined' and a.admitted_at >= ${window.start}::timestamptz) as "attemptQuarantined",
      (select count(*)::int from sync_work w where w.page_id = ${pageId} and not w.shadow
         and w.state = 'quarantined') as "workQuarantined",
      (select count(*)::int from fansly_ws_decode_receipts r where r.page_id = ${pageId}
         and r.live_state = 'pending' and r.received_at < ${now} - interval '1 minute') as "receiptsPending",
      (select count(*)::int from sync_work w where w.page_id = ${pageId} and not w.shadow
         and ${syncUrgentWaitingSql({ now, afterMs: SYNC_URGENT_WAIT_MS })}) as "urgentWaiting",
      (select count(*)::int from page_dm_threads t where t.platform_account_id = ${pageId}
         and t.fan_id is not null and not (t.metadata ? 'messageSyncExcludedReason')
         and t.last_message_sender_role is distinct from 'model'
         and t.last_message_at >= ${window.start}::timestamptz and t.last_message_at < ${now} - interval '5 minutes'
         and case when t.last_message_id ~ '^[0-9]+$'
                  then case when coalesce(t.head_confirmed_id, '') ~ '^[0-9]+$'
                            then t.head_confirmed_id::numeric < t.last_message_id::numeric else true end
                  else false end
         and not exists (select 1 from sync_work w where w.page_id = ${pageId} and not w.shadow
                           and w.subject = t.platform_conversation_id
                           and w.resource in ('dm-messages.head', 'dm-messages.catchup')
                           and w.state in ('open', 'running'))) as "fanThreadsBehind"
  `);
  const counts = Object.fromEntries(Object.entries(result.rows[0] ?? {}).map(([key, value]) => [key, Number(value)]));
  return { name: "nothing_stuck", verdict: Object.values(counts).every((value) => value === 0) ? "pass" : "fail", detail: counts };
}

/** The latency SLOs. A fan message still awaiting its REST confirmation
 *  (alert 3's predicate, `dmLiveAwaitingConfirmSql`: not deleted, not
 *  deferred, not in an excluded or hidden chat) and a work still open count at
 *  their age now. */
async function sloChecks(db: Database, pageId: number, window: AcceptanceWindow): Promise<AcceptanceCheck[]> {
  const now = sql`${window.now}::timestamptz`;
  const messages = await db.execute<{ visibleS: unknown; confirmS: unknown; fast: boolean; confirmed: boolean; mismatch: boolean; over15: boolean }>(sql`
    select extract(epoch from m.first_visible_at - m.created_at) as "visibleS",
           case when m.confirm_outcome in ('match', 'mismatch') then extract(epoch from m.confirmed_at - m.first_visible_at)
                when aw.awaiting then extract(epoch from ${now} - m.first_visible_at) end as "confirmS",
           m.attachments <> '[]'::jsonb as fast,
           coalesce(m.confirm_outcome in ('match', 'mismatch'), false) as confirmed,
           coalesce(m.confirm_outcome = 'mismatch', false) as mismatch,
           (aw.awaiting and m.first_visible_at < ${now} - ${ms(ACCEPTANCE_RULES.unconfirmedAfterMs)}) as over15
      from dm_live_messages m
     cross join lateral (select ${dmLiveAwaitingConfirmSql(sql`m`)} as awaiting) aw
     where m.page_id = ${pageId} and m.first_visible_at >= ${window.start}::timestamptz
       and m.first_visible_at < ${window.observedUntil}::timestamptz
       and m.sender_platform_user_id is not null and m.is_sent_by_page is false
  `);
  const works = await db.execute<{ resource: string; latencyS: unknown }>(sql`
    select w.resource, extract(epoch from coalesce(w.closed_at, ${now}) - w.first_demand_at) as "latencyS"
      from sync_work w
     where w.page_id = ${pageId} and not w.shadow
       and w.first_demand_at >= ${window.start}::timestamptz and w.first_demand_at < ${window.observedUntil}::timestamptz
       and w.resource in (${sql.join(ACCEPTANCE_SLO_RESOURCES.map((resource) => sql`${resource}`), sql`, `)})
  `);
  const visible = messages.rows.flatMap((row) => { const s = num(row.visibleS); return s === null ? [] : [s]; });
  const confirm = messages.rows.flatMap((row) => { const s = num(row.confirmS); return s === null ? [] : [s]; });
  const confirmFast = messages.rows.flatMap((row) => { const s = num(row.confirmS); return s === null || !row.fast ? [] : [s]; });
  const latency = (resource: string) => works.rows.flatMap((row) => {
    const s = num(row.latencyS);
    return row.resource !== resource || s === null ? [] : [s];
  });
  const unconfirmed = messages.rows.filter((row) => row.over15).length;
  return [
    latencyCheck("slo_visible", visible),
    latencyCheck("slo_confirm", confirm),
    latencyCheck("slo_confirm_fast", confirmFast),
    mismatchCheck(messages.rows.filter((row) => row.confirmed).length, messages.rows.filter((row) => row.mismatch).length),
    { name: "unconfirmed_over_15m", verdict: unconfirmed === 0 ? "pass" : "fail", detail: { messages: unconfirmed } },
    latencyCheck("slo_find", latency("dm-conversations.find")),
    latencyCheck("slo_money_head", latency("transactions.head")),
    latencyCheck("slo_deletions", latency("dm-live.deletions")),
    latencyCheck("slo_repair", latency("repair.ws-gap")),
  ];
}

/** Open incidents of the page; a route's own (D5, by its key) is judged by the
 *  route rule and shown here only. */
async function incidentsCheck(db: Database, pageId: number): Promise<AcceptanceCheck> {
  const incidents = await db.execute<{ kind: string; incidentKey: string; openedAt: unknown; errorCode: string | null; summary: string | null }>(sql`
    select n.kind, n.incident_key as "incidentKey", n.opened_at as "openedAt", n.error_code as "errorCode", n.error_summary as summary
      from notification_incidents n
     where n.platform_account_id = ${pageId} and n.resolved_at is null
     order by n.opened_at, n.id
  `);
  const judged = incidents.rows.filter((entry) => !judgedByRouteRule(pageId, entry.incidentKey));
  return {
    name: "open_incidents",
    verdict: judged.length === 0 ? "pass" : "fail",
    detail: {
      incidents: incidents.rows.map((entry) => ({
        kind: entry.kind,
        key: entry.incidentKey,
        openedAt: iso(entry.openedAt),
        errorCode: entry.errorCode,
        summary: entry.summary,
        judgedByRouteRule: judgedByRouteRule(pageId, entry.incidentKey),
      })),
    },
  };
}

async function volumeOf(db: Database, pageId: number, window: AcceptanceWindow): Promise<PageAcceptanceReport["volume"]> {
  const volume = await db.execute<{ class: string; resource: string; sends: number; admissions: number }>(sql`
    select a.class, a.resource, count(*) filter (where a.sent_at is not null)::int as sends, count(*)::int as admissions
      from sync_attempts a
     where a.page_id = ${pageId} and not a.shadow
       and a.admitted_at >= ${window.start}::timestamptz and a.admitted_at < ${window.observedUntil}::timestamptz
     group by 1, 2
     order by 3 desc, 1, 2
  `);
  return volume.rows.map((entry) => ({ class: entry.class, resource: entry.resource, sends: Number(entry.sends), admissions: Number(entry.admissions) }));
}

async function restartsOf(db: Database, pageId: number, window: AcceptanceWindow): Promise<PageAcceptanceReport["restarts"]> {
  const generations = await db.execute<{ generation: string; attempts: number; firstAdmit: unknown; lastDone: unknown; resumeGap: unknown }>(sql`
    with g as (
      select a.owner_generation, min(a.admitted_at) as first_admit, max(a.completed_at) as last_done, count(*)::int as attempts
        from sync_attempts a
       where a.page_id = ${pageId} and not a.shadow and a.admitted_at >= ${window.start}::timestamptz - interval '5 minutes'
         and a.admitted_at < ${window.observedUntil}::timestamptz
       group by 1)
    select owner_generation::text as generation, attempts, first_admit as "firstAdmit", last_done as "lastDone",
           extract(epoch from first_admit - lag(last_done) over (order by owner_generation)) as "resumeGap"
      from g order by owner_generation
  `);
  const connections = await db.execute<{ startedAt: unknown; verifiedAt: unknown; closedAt: unknown; stopReason: string | null; reconciled: boolean }>(sql`
    select c.started_at as "startedAt", c.verified_at as "verifiedAt", c.closed_at as "closedAt", c.stop_reason as "stopReason",
           c.state_reconciled_at is not null as reconciled
      from fansly_ws_connections c
     where c.page_id = ${pageId} and c.started_at >= ${window.start}::timestamptz - interval '10 minutes'
       and c.started_at < ${window.observedUntil}::timestamptz
     order by c.started_at
  `);
  return {
    generations: generations.rows.map((entry) => ({
      generation: entry.generation,
      attempts: Number(entry.attempts),
      firstAdmit: iso(entry.firstAdmit),
      lastDone: iso(entry.lastDone),
      resumeGapSeconds: num(entry.resumeGap),
    })),
    connections: connections.rows.map((entry) => ({
      startedAt: iso(entry.startedAt)!,
      verifiedAt: iso(entry.verifiedAt),
      closedAt: iso(entry.closedAt),
      stopReason: entry.stopReason,
      reconciled: entry.reconciled === true,
    })),
  };
}

function routeTotals(rows: readonly AcceptanceJournalRow[], window: AcceptanceWindow): PageAcceptanceReport["routes"] {
  const inWindow = (at: Date) => at.getTime() >= window.start.getTime() && at.getTime() < window.observedUntil.getTime();
  const totals = new Map<string, { route: string; sends: number; rate429s: number }>();
  for (const row of rows) {
    const route = acceptanceRouteOf(row.journal, row.operation);
    const entry = totals.get(route) ?? { route, sends: 0, rate429s: 0 };
    if (row.at !== null && inWindow(row.at)) entry.sends += 1;
    if (row.httpStatus === 429 && inWindow(row.doneAt)) entry.rate429s += 1;
    if (entry.sends > 0 || entry.rate429s > 0) totals.set(route, entry);
  }
  return [...totals.values()].sort((a, b) => b.sends - a.sends || a.route.localeCompare(b.route));
}

function failureTotals(rows: readonly AcceptanceJournalRow[], window: AcceptanceWindow): PageAcceptanceReport["failures"] {
  const totals = new Map<string, PageAcceptanceReport["failures"][number]>();
  for (const row of rows) {
    if (row.journal !== "engine" || (row.errorClass === null && row.outcome === "response")) continue;
    if (row.doneAt.getTime() < window.start.getTime() || row.doneAt.getTime() >= window.observedUntil.getTime()) continue;
    const route = acceptanceRouteOf(row.journal, row.operation);
    const key = JSON.stringify([route, row.outcome, row.errorClass, row.httpStatus]);
    const entry = totals.get(key) ?? { route, outcome: row.outcome, errorClass: row.errorClass, httpStatus: row.httpStatus, attempts: 0 };
    entry.attempts += 1;
    totals.set(key, entry);
  }
  return [...totals].sort(([keyA, a], [keyB, b]) => b.attempts - a.attempts || keyA.localeCompare(keyB)).map(([, entry]) => entry);
}

async function checkPage(db: Database, page: SyncPageRow, window: AcceptanceWindow): Promise<PageAcceptanceReport> {
  const pageId = page.pageId;
  const rows = await readJournal(db, pageId, new Date(window.start.getTime() - ACCEPTANCE_RULES.lookbackMs));
  // The send audit's rows: both journals of [T_i − its look-back, end).
  const sends = await readFanslySendAudit(db, { pageId, since: window.start, until: window.observedUntil });
  const paused = page.pausedAll || page.pausedResources.includes("media-stats.walk");
  const checks: AcceptanceCheck[] = [
    {
      name: "live",
      verdict: page.mode === "live" ? "pass" : "fail",
      detail: { mode: page.mode, liveSince: page.modeChangedAt.toISOString() },
    },
    {
      name: "window_complete",
      verdict: window.now.getTime() >= window.end.getTime() ? "pass" : "inconclusive",
      detail: { windowStart: window.start.toISOString(), windowEnd: window.end.toISOString(), observedUntil: window.observedUntil.toISOString() },
    },
    paceCombinedCheck(sends, window),
    await boundaryCheck(db, pageId),
    routeBudgetsCheck(sends, window),
    route429Check(route429Outcomes(rows, window)),
    authRefusalsCheck(rows, window),
    pageHoldCheck(rows, window, pageHoldRecords(page), await readPageStops(db, pageId)),
    mediaStartCheck(rows, window, paused),
    await stuckCheck(db, pageId, window),
    ...await sloChecks(db, pageId, window),
    await incidentsCheck(db, pageId),
  ];
  const { verdict, reasons } = pageVerdict(checks);
  return {
    page: page.pageLabel ?? String(pageId),
    pageId,
    mode: page.mode,
    liveSince: page.modeChangedAt.toISOString(),
    windowStart: window.start.toISOString(),
    verdict,
    reasons,
    checks,
    routes: routeTotals(rows, window),
    failures: failureTotals(rows, window),
    volume: await volumeOf(db, pageId, window),
    restarts: await restartsOf(db, pageId, window),
  };
}

/**
 * The acceptance of `pageIds` checked together: each page over [T_i, T* +
 * 1 h), T_i = the later of `since` and its live instant (`until` replaces the
 * end). Read-only.
 */
export async function checkLiveHour(
  db: Database,
  input: { pageIds: readonly number[]; since: Date; until?: Date | null },
): Promise<LiveHourReport> {
  if (input.pageIds.length === 0) throw new Error("The acceptance needs at least one page");
  const pages: SyncPageRow[] = [];
  for (const pageId of new Set(input.pageIds)) {
    const page = await getSyncPage(db, pageId);
    if (page === null) throw new Error(`No Fansly sync page ${pageId}`);
    pages.push(page);
  }
  pages.sort((a, b) => (a.pageLabel ?? "").localeCompare(b.pageLabel ?? "") || a.pageId - b.pageId);
  const clock = await db.execute<{ now: Date | string }>(sql`select clock_timestamp() as now`);
  const now = dateOf(clock.rows[0]!.now);
  const until = input.until ?? null;
  const { tStar, end, windows } = acceptanceWindows(
    pages.map((page) => ({ pageId: page.pageId, live: page.mode === "live", liveSince: page.modeChangedAt })),
    { since: input.since, until, now },
  );
  const reports: PageAcceptanceReport[] = [];
  for (const page of pages) reports.push(await checkPage(db, page, windows.get(page.pageId)!));
  return {
    since: input.since.toISOString(),
    until: until === null ? null : until.toISOString(),
    tStar: tStar!.toISOString(),
    windowEnd: end!.toISOString(),
    observedUntil: new Date(Math.min(end!.getTime(), now.getTime())).toISOString(),
    windowComplete: now.getTime() >= end!.getTime(),
    pages: reports,
    accepted: reports.every((report) => isAcceptedVerdict(report.verdict)),
  };
}
