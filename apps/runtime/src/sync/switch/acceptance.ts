import { sql } from "drizzle-orm";

import { getFanslySendGuard, getSyncPage, listCombinedFanslySendsForPaceAudit, type Database } from "@agency_hub_core/db";

// `pnpm cli sync switch check --page P --since <T0> [--until <iso>]` (design
// step 3 §3.5 item 7 `acceptance.ts`, runbook §6.3): the acceptance checks of
// a switched page as JSON, read-only. Each check is `pass`, `fail` or
// `insufficient_sample` (fewer than 10 samples: the max is shown, [A12]);
// volume, durability and the control request are reported for the owner's
// verdict, not judged here.

export type AcceptanceVerdict = "pass" | "fail" | "insufficient_sample";

export interface AcceptanceCheck {
  name: string;
  verdict: AcceptanceVerdict;
  detail: Record<string, unknown>;
}

export interface SwitchAcceptanceReport {
  page: string;
  since: string;
  until: string | null;
  checks: AcceptanceCheck[];
  /** Section 7: engine sends by class/resource in the window, for "volume explained". */
  volume: Array<{ class: string; resource: string; sends: number; admissions: number }>;
  /** Section 8: owner generations and their resume gaps; socket connections. */
  restarts: {
    generations: Array<{ generation: string; attempts: number; firstAdmit: string | null; lastDone: string | null; resumeGapSeconds: number | null }>;
    connections: Array<{ startedAt: string; verifiedAt: string | null; closedAt: string | null; stopReason: string | null; reconciled: boolean }>;
  };
  accepted: boolean;
}

/** Fewer samples than this make a percentile `insufficient_sample` [A12]. */
export const ACCEPTANCE_MIN_SAMPLES = 10;

function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return (value instanceof Date ? value : new Date(String(value))).toISOString();
}

/** A latency SLO: p95 ≤ bound, or `insufficient_sample` with the max. */
function sloCheck(name: string, samples: number, p95: number | null, max: number | null, boundSeconds: number): AcceptanceCheck {
  if (samples === 0) return { name, verdict: "insufficient_sample", detail: { samples, boundSeconds } };
  if (samples < ACCEPTANCE_MIN_SAMPLES) {
    return { name, verdict: "insufficient_sample", detail: { samples, maxSeconds: max, boundSeconds } };
  }
  return { name, verdict: p95 !== null && p95 <= boundSeconds ? "pass" : "fail", detail: { samples, p95Seconds: p95, maxSeconds: max, boundSeconds } };
}

export async function checkSwitchAcceptance(
  db: Database,
  input: { pageId: number; since: Date; until?: Date | null },
): Promise<SwitchAcceptanceReport> {
  const page = await getSyncPage(db, input.pageId);
  if (page === null) throw new Error(`No Fansly sync page ${input.pageId}`);
  const until = input.until ?? null;
  const untilSql = until === null ? sql`'infinity'::timestamptz` : sql`${until}::timestamptz`;
  const since = sql`${input.since}::timestamptz`;
  const checks: AcceptanceCheck[] = [];

  // 2. Pace over both journals.
  const sends = await listCombinedFanslySendsForPaceAudit(db, { pageId: input.pageId, since: input.since, until });
  const violations = sends.filter((send) => send.violation);
  const gaps = sends.flatMap((send) => (send.gapMs === null ? [] : [send.gapMs]));
  const crossGaps = sends.flatMap((send) => (send.gapMs !== null && send.prevJournal !== null && send.prevJournal !== send.journal ? [send.gapMs] : []));
  checks.push({
    name: "pace_combined",
    verdict: violations.length === 0 ? "pass" : "fail",
    detail: {
      pairs: gaps.length,
      violations: violations.length,
      minGapMs: gaps.length === 0 ? null : Math.round(Math.min(...gaps)),
      minCrossJournalGapMs: crossGaps.length === 0 ? null : Math.round(Math.min(...crossGaps)),
      firstViolations: violations.slice(0, 5).map((send) => ({ journal: send.journal, ref: send.ref, prevJournal: send.prevJournal, gapMs: Math.round(send.gapMs ?? 0), settingMs: send.settingMs })),
    },
  });

  // 3. Handover boundary.
  const guard = await getFanslySendGuard(db, input.pageId);
  const boundary = await db.execute<{ legacyAfterFlip: number; engineFirstSent: Date | string | null; settingMs: number | null }>(sql`
    select
      (select count(*)::int from fansly_send_log l
        where l.page_id = ${input.pageId} and l.captured_at > g.engine_switched_at) as "legacyAfterFlip",
      (select min(a.sent_at) from sync_attempts a
        where a.page_id = ${input.pageId} and not a.shadow and a.sent_at > g.engine_switched_at) as "engineFirstSent",
      (select max(a.setting_ms) from sync_attempts a
        where a.page_id = ${input.pageId} and not a.shadow and a.sent_at > g.engine_switched_at) as "settingMs"
      from fansly_page_send_guards g
     where g.page_id = ${input.pageId}
  `);
  const row = boundary.rows[0];
  const engineFirst = row?.engineFirstSent === null || row?.engineFirstSent === undefined ? null : new Date(row.engineFirstSent);
  const boundaryGapMs = engineFirst === null || guard === null ? null : engineFirst.getTime() - guard.lastCompletedAt.getTime();
  const requiredMs = row?.settingMs === null || row?.settingMs === undefined ? null : Math.round(Number(row.settingMs) * 1.2);
  const engineOwned = guard?.ownerEngine === "fansly_sync_engine";
  checks.push({
    name: "handover_boundary",
    verdict: !engineOwned
      ? "fail"
      : Number(row?.legacyAfterFlip ?? 0) > 0
        ? "fail"
        : boundaryGapMs === null || requiredMs === null
          ? "insufficient_sample"
          : boundaryGapMs >= requiredMs ? "pass" : "fail",
    detail: {
      ownerEngine: guard?.ownerEngine ?? null,
      engineSwitchedAt: iso(guard?.engineSwitchedAt ?? null),
      legacyLastCompleted: iso(guard?.lastCompletedAt ?? null),
      legacyCapturesAfterFlip: Number(row?.legacyAfterFlip ?? 0),
      engineFirstSent: iso(engineFirst),
      boundaryGapMs,
      requiredMs,
    },
  });

  // 4. Vendor refusals: 401/403/429 must be 0.
  const vendor = await db.execute<{ httpStatus: number; resource: string; n: number }>(sql`
    select a.http_status as "httpStatus", a.resource, count(*)::int as n
      from sync_attempts a
     where a.page_id = ${input.pageId} and not a.shadow
       and a.admitted_at >= ${since} and a.admitted_at < ${untilSql}
       and a.http_status in (401, 403, 429)
     group by 1, 2
     order by 3 desc
  `);
  checks.push({
    name: "vendor_refusals",
    verdict: vendor.rows.length === 0 ? "pass" : "fail",
    detail: { refusals: vendor.rows.map((entry) => ({ httpStatus: Number(entry.httpStatus), resource: entry.resource, count: Number(entry.n) })) },
  });

  // 5. Nothing stuck, nothing lost.
  const stuck = await db.execute<Record<string, number>>(sql`
    select
      (select count(*)::int from sync_attempts a where a.page_id = ${input.pageId} and not a.shadow
         and a.outcome in ('admitted', 'sent') and a.admitted_at < clock_timestamp() - interval '2 minutes') as "attemptUnfinished",
      (select count(*)::int from sync_attempts a where a.page_id = ${input.pageId} and not a.shadow
         and a.apply_state in ('captured', 'deferred') and a.admitted_at < clock_timestamp() - interval '5 minutes') as "applyPending",
      (select count(*)::int from sync_attempts a where a.page_id = ${input.pageId} and not a.shadow
         and a.apply_state = 'quarantined' and a.admitted_at >= ${since}) as "attemptQuarantined",
      (select count(*)::int from sync_work w where w.page_id = ${input.pageId} and not w.shadow
         and w.state = 'quarantined') as "workQuarantined",
      (select count(*)::int from fansly_ws_decode_receipts r where r.page_id = ${input.pageId}
         and r.live_state = 'pending' and r.received_at < clock_timestamp() - interval '1 minute') as "receiptsPending",
      (select count(*)::int from sync_work w where w.page_id = ${input.pageId} and not w.shadow and w.class = 'urgent'
         and w.state = 'open' and w.first_demand_at < clock_timestamp() - interval '2 minutes'
         and w.waiting_reason is distinct from 'subject_breaker'
         and w.waiting_reason is distinct from 'blocked_by_vendor') as "urgentWaiting"
  `);
  const stuckRow = stuck.rows[0] ?? {};
  const stuckCounts = Object.fromEntries(Object.entries(stuckRow).map(([key, value]) => [key, Number(value)]));
  checks.push({
    name: "nothing_stuck",
    verdict: Object.values(stuckCounts).every((value) => value === 0) ? "pass" : "fail",
    detail: stuckCounts,
  });

  // 6. SLOs (plan §13).
  const live = await db.execute<Record<string, unknown>>(sql`
    select
      count(*) filter (where m.is_sent_by_page is false) as "fanMessages",
      percentile_cont(0.95) within group (order by extract(epoch from m.first_visible_at - m.created_at))
        filter (where m.is_sent_by_page is false) as "visibleP95",
      max(extract(epoch from m.first_visible_at - m.created_at)) filter (where m.is_sent_by_page is false) as "visibleMax",
      count(*) filter (where m.is_sent_by_page is false and m.confirm_outcome in ('match', 'mismatch')) as confirmed,
      percentile_cont(0.95) within group (order by extract(epoch from m.confirmed_at - m.first_visible_at))
        filter (where m.is_sent_by_page is false and m.confirm_outcome in ('match', 'mismatch')) as "confirmP95",
      max(extract(epoch from m.confirmed_at - m.first_visible_at))
        filter (where m.is_sent_by_page is false and m.confirm_outcome in ('match', 'mismatch')) as "confirmMax",
      count(*) filter (where m.is_sent_by_page is false and m.confirm_outcome in ('match', 'mismatch') and m.attachments <> '[]'::jsonb) as "confirmedFast",
      percentile_cont(0.95) within group (order by extract(epoch from m.confirmed_at - m.first_visible_at))
        filter (where m.is_sent_by_page is false and m.confirm_outcome in ('match', 'mismatch') and m.attachments <> '[]'::jsonb) as "confirmFastP95",
      max(extract(epoch from m.confirmed_at - m.first_visible_at))
        filter (where m.is_sent_by_page is false and m.confirm_outcome in ('match', 'mismatch') and m.attachments <> '[]'::jsonb) as "confirmFastMax",
      count(*) filter (where m.confirm_outcome = 'mismatch') as mismatches,
      count(*) filter (where m.is_sent_by_page is false and m.confirmed_at is null and m.deleted_at is null
                         and m.first_visible_at < clock_timestamp() - interval '15 minutes'
                         and not exists (select 1 from page_dm_threads t where t.platform_account_id = m.page_id
                                           and t.platform_conversation_id = m.platform_conversation_id
                                           and t.metadata ? 'messageSyncExcludedReason')) as "unconfirmedOver15m"
      from dm_live_messages m
     where m.page_id = ${input.pageId} and m.first_visible_at >= ${since} and m.first_visible_at < ${untilSql}
       and m.sender_platform_user_id is not null
  `);
  const slo = live.rows[0] ?? {};
  checks.push(sloCheck("slo_visible", num(slo.fanMessages) ?? 0, num(slo.visibleP95), num(slo.visibleMax), 5));
  checks.push(sloCheck("slo_confirm", num(slo.confirmed) ?? 0, num(slo.confirmP95), num(slo.confirmMax), 30));
  checks.push(sloCheck("slo_confirm_fast", num(slo.confirmedFast) ?? 0, num(slo.confirmFastP95), num(slo.confirmFastMax), 10));
  const confirmed = num(slo.confirmed) ?? 0;
  const mismatches = num(slo.mismatches) ?? 0;
  checks.push({
    name: "confirm_mismatches",
    verdict: confirmed === 0 ? "insufficient_sample" : mismatches / confirmed <= 0.001 ? "pass" : "fail",
    detail: { confirmed, mismatches },
  });
  const unconfirmed = num(slo.unconfirmedOver15m) ?? 0;
  checks.push({ name: "unconfirmed_over_15m", verdict: unconfirmed === 0 ? "pass" : "fail", detail: { messages: unconfirmed } });

  const works = await db.execute<{ resource: string; closed: number; p95: unknown; max: unknown }>(sql`
    select w.resource, count(*)::int as closed,
           percentile_cont(0.95) within group (order by extract(epoch from w.closed_at - w.first_demand_at)) as p95,
           max(extract(epoch from w.closed_at - w.first_demand_at)) as max
      from sync_work w
     where w.page_id = ${input.pageId} and not w.shadow and w.first_demand_at >= ${since} and w.first_demand_at < ${untilSql}
       and w.closed_at is not null
       and w.resource in ('dm-conversations.find', 'transactions.head', 'dm-live.deletions', 'repair.ws-gap')
     group by 1
  `);
  const byResource = new Map(works.rows.map((entry) => [entry.resource, entry]));
  const workSlo = (name: string, resource: string, boundSeconds: number, useMax: boolean): AcceptanceCheck => {
    const entry = byResource.get(resource);
    const samples = Number(entry?.closed ?? 0);
    const p95 = num(entry?.p95);
    const max = num(entry?.max);
    if (useMax) {
      if (samples === 0) return { name, verdict: "insufficient_sample", detail: { samples, boundSeconds } };
      return { name, verdict: max !== null && max <= boundSeconds ? "pass" : "fail", detail: { samples, maxSeconds: max, boundSeconds } };
    }
    return sloCheck(name, samples, p95, max, boundSeconds);
  };
  checks.push(workSlo("slo_find", "dm-conversations.find", 12, false));
  checks.push(workSlo("slo_money_head", "transactions.head", 12, false));
  checks.push(workSlo("slo_deletions", "dm-live.deletions", 5, true));
  checks.push(workSlo("slo_repair", "repair.ws-gap", 60, true));

  // 7. Volume, for the owner's "explained" verdict.
  const volume = await db.execute<{ class: string; resource: string; sends: number; admissions: number }>(sql`
    select a.class, a.resource, count(*) filter (where a.sent_at is not null)::int as sends, count(*)::int as admissions
      from sync_attempts a
     where a.page_id = ${input.pageId} and not a.shadow and a.admitted_at >= ${since} and a.admitted_at < ${untilSql}
     group by 1, 2
     order by 3 desc
  `);

  // 8. Restarts.
  const generations = await db.execute<{ generation: string; attempts: number; firstAdmit: unknown; lastDone: unknown; resumeGap: unknown }>(sql`
    with g as (
      select a.owner_generation, min(a.admitted_at) as first_admit, max(a.completed_at) as last_done, count(*)::int as attempts
        from sync_attempts a
       where a.page_id = ${input.pageId} and not a.shadow and a.admitted_at >= ${since} - interval '5 minutes'
         and a.admitted_at < ${untilSql}
       group by 1)
    select owner_generation::text as generation, attempts, first_admit as "firstAdmit", last_done as "lastDone",
           extract(epoch from first_admit - lag(last_done) over (order by owner_generation)) as "resumeGap"
      from g order by owner_generation
  `);
  const connections = await db.execute<{ startedAt: unknown; verifiedAt: unknown; closedAt: unknown; stopReason: string | null; reconciled: boolean }>(sql`
    select c.started_at as "startedAt", c.verified_at as "verifiedAt", c.closed_at as "closedAt", c.stop_reason as "stopReason",
           c.state_reconciled_at is not null as reconciled
      from fansly_ws_connections c
     where c.page_id = ${input.pageId} and c.started_at >= ${since} - interval '10 minutes' and c.started_at < ${untilSql}
     order by c.started_at
  `);

  // 9. Open incidents of the page.
  const incidents = await db.execute<{ kind: string; incidentKey: string; openedAt: unknown; summary: string | null }>(sql`
    select n.kind, n.incident_key as "incidentKey", n.opened_at as "openedAt", n.error_summary as summary
      from notification_incidents n
     where n.platform_account_id = ${input.pageId} and n.resolved_at is null
  `);
  checks.push({
    name: "open_incidents",
    verdict: incidents.rows.length === 0 ? "pass" : "fail",
    detail: { incidents: incidents.rows.map((entry) => ({ kind: entry.kind, key: entry.incidentKey, openedAt: iso(entry.openedAt), summary: entry.summary })) },
  });

  return {
    page: page.pageLabel ?? String(page.pageId),
    since: input.since.toISOString(),
    until: until === null ? null : until.toISOString(),
    checks,
    volume: volume.rows.map((entry) => ({ class: entry.class, resource: entry.resource, sends: Number(entry.sends), admissions: Number(entry.admissions) })),
    restarts: {
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
    },
    accepted: checks.every((entry) => entry.verdict !== "fail"),
  };
}
