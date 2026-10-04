import { sql } from "drizzle-orm";

import { readFanslySendAudit, SYNC_ROUTE_JOURNAL_SLACK_MS, SYNC_SEND_WINDOW_MS, type Database, type SyncPageRow } from "@agency_hub_core/db";

import { auditRouteIntervals } from "../engine/send-audit.ts";
import { FANSLY_RESOURCE_SPECS } from "../fansly/registry.ts";
import {
  FAMILY_BUDGETS,
  FANSLY_ROUTE_FAMILIES,
  FANSLY_ROUTE_FAMILY_IDS,
  FANSLY_ROUTES,
  intervalMsOf,
  routeBudget,
} from "../fansly/routes.ts";

// The shadow gate's two checks (step 3b ruling 12), over the shadow
// journal of part A's window, besides the frozen A1–A4 rules:
//
//   route budgets  every route and family of `fansly/routes.ts` kept its
//                  budget in shadow (I19): each pair of adjacent sends of a
//                  route, and of a family, whose later send lies in the
//                  window is at least the interval that send's admission
//                  recorded, and no recorded interval is below its ceiling's
//                  — the send audit (`engine/send-audit.ts`) the alert
//                  evaluator and the live acceptance run. A send counts at its
//                  instant as the route clocks read it (`readRouteJournal`):
//                  the simulated send, else its admission + the send window.
//                  A pair without its recorded interval is inconclusive, which
//                  never passes; a send this build places on no route fails
//                  the check. The span counts (at most ⌈W / T⌉ + 1 sends in
//                  every 60 s and 300 s, T = the budget's `current` interval)
//                  are diagnostics only.
//   endless walks  no run of a walk — one work row of a key that is not a
//                  poll — asks a route from the same position twice in the
//                  window: a walk whose position does not advance goes round
//                  in circles. A request's position is its parameters, or the
//                  place its shadow plan named when they cannot
//                  (`RequestPlan.position`): a window cut at the step's clock
//                  names the subject and the step (the media walk: the pass,
//                  the item's queue position and the window's number in the
//                  visit; the fan earnings roster: the subject), a
//                  subject-queue walk names its pass (the next pass re-reads
//                  the subjects: another pass, not a circle). A request without
//                  parameters (a snapshot read, `/account/me` before and after
//                  a reconcile) has no position and is not one; a poll's runs
//                  re-read by design and are judged by rule A1.poll-schedule.
//                  A request asked again after a restart closed its first
//                  shadow attempt unsent (no simulated send) is the same step
//                  resumed, not a repeat.

/** The spans the budget diagnostics count over (amendment A1). */
export const ROUTE_BUDGET_CHECK_WINDOWS_MS = [60_000, 300_000] as const;

/** The most sends a strict budget of `intervalMs` admits in any span of
 *  `windowMs`: ⌈W / T⌉ + 1 (amendment A1; a diagnostic). */
export function routeBudgetBound(windowMs: number, intervalMs: number): number {
  return Math.ceil(windowMs / intervalMs) + 1;
}

/** One budget of the table: a route, or a family (`family:<name>`), with the
 *  engine operations (wire ids) that spend it. */
export interface CheckedBudget {
  budget: string;
  perMin: number;
  intervalMs: number;
  operations: readonly string[];
}

/** Every budget the engine's sends can spend: each wire route at its
 *  `current` rate, each family at its own. */
export function checkedBudgets(): CheckedBudget[] {
  const budgets: CheckedBudget[] = [];
  for (const spec of FANSLY_ROUTES.values()) {
    if (spec.wire === null) continue;
    const perMin = routeBudget(spec.route).currentPerMin;
    budgets.push({ budget: spec.route, perMin, intervalMs: intervalMsOf(perMin), operations: [spec.wire] });
  }
  for (const family of FANSLY_ROUTE_FAMILY_IDS) {
    const perMin = FAMILY_BUDGETS[family].currentPerMin;
    const operations = FANSLY_ROUTE_FAMILIES[family].filter((route) => FANSLY_ROUTES.get(route)?.wire === route);
    budgets.push({ budget: `family:${family}`, perMin, intervalMs: intervalMsOf(perMin), operations });
  }
  return budgets;
}

export interface RouteBudgetRow {
  page: string;
  /** A route, or `family:<name>`. */
  budget: string;
  perMin: number;
  intervalMs: number;
  /** Sends of the window. */
  sends: number;
  /** The shortest gap between two sends of the budget ending in the window. */
  minGapMs: number | null;
  /** The most sends in a 60 s / 300 s span ending at a send of the window,
   *  and the bound (diagnostics). */
  max60s: number;
  bound60s: number;
  max300s: number;
  bound300s: number;
  /** The send audit: pairs closer than the interval their later send was
   *  admitted under, plus admissions that recorded an interval below the
   *  ceiling's; the first of them. */
  violations: number;
  firstViolationAt: Date | null;
  /** Pairs whose later send recorded no interval. */
  inconclusive: number;
}

export interface ShadowRouteBudgets {
  /** Every budget a page spent in the window. */
  rows: RouteBudgetRow[];
  /** Sends of the window whose operation this build places on no route. */
  unplaced: Array<{ page: string; operation: string; sends: number }>;
  /** The audit's violations plus unplaced sends: 0 (and 0 inconclusive) passes. */
  violations: number;
  /** Pairs the audit could not judge: never a pass. */
  inconclusive: number;
}

export interface EndlessWalkRow {
  page: string;
  route: string;
  resource: string;
  workId: number;
  /** The repeated request's position (its parameters, or the place its
   *  shadow plan named), how often the run asked it, when. */
  position: unknown;
  times: number;
  firstAt: Date;
  lastAt: Date;
}

export interface ShadowWalks {
  /** Walk runs (work rows of the keys judged) with a shadow send in the window. */
  runs: number;
  /** Runs that asked from one position twice, per repeated position (capped). */
  endless: EndlessWalkRow[];
  /** Repeated asks in all (uncapped). */
  repeats: number;
}

export interface ShadowRouteChecks {
  budgets: ShadowRouteBudgets;
  walks: ShadowWalks;
}

/** The keys whose runs the endless-walk check judges: every registry key but
 *  the polls. */
export function walkKeys(): string[] {
  return FANSLY_RESOURCE_SPECS.filter((spec) => spec.kind !== "poll").map((spec) => spec.key).sort();
}

function labelOf(pages: readonly SyncPageRow[]): (pageId: number) => string {
  const labels = new Map(pages.map((page) => [page.pageId, page.pageLabel ?? String(page.pageId)]));
  return (pageId) => labels.get(pageId) ?? String(pageId);
}

const toMs = (value: number) => sql`${value}::double precision * interval '1 millisecond'`;
/** A window frame's offset (a code constant: a frame takes no parameter). */
const frameOffset = (ms: number) => sql.raw(`interval '${Math.trunc(ms)} milliseconds'`);

/** The sends of the shadow journal a span ending in the window can hold. */
function shadowSends(input: { pageIds: readonly number[]; window: { start: Date; end: Date } }) {
  const lookbackMs = Math.max(...ROUTE_BUDGET_CHECK_WINDOWS_MS) + SYNC_ROUTE_JOURNAL_SLACK_MS;
  return sql`
    select a.page_id, a.operation,
           coalesce(a.sent_at, a.admitted_at + ${toMs(SYNC_SEND_WINDOW_MS)}) as at
      from sync_attempts a
     where a.shadow
       and a.page_id = any(${sql.param(input.pageIds.map(String))}::bigint[])
       and a.admitted_at >= ${input.window.start}::timestamptz - ${toMs(lookbackMs)}
       and a.admitted_at < ${input.window.end}
       and (a.sent_at is not null or a.outcome in ('admitted', 'sent', 'unknown', 'shadow'))
  `;
}

async function readRouteBudgets(
  db: Database,
  input: { pages: readonly SyncPageRow[]; window: { start: Date; end: Date } },
): Promise<ShadowRouteBudgets> {
  const pageIds = input.pages.map((page) => page.pageId);
  const label = labelOf(input.pages);
  const budgets = checkedBudgets();
  const [w60, w300] = ROUTE_BUDGET_CHECK_WINDOWS_MS;
  const members = budgets.flatMap((budget) => budget.operations.map((operation) =>
    sql`(${operation}::text, ${budget.budget}::text, ${budget.intervalMs}::int)`));
  const { start, end } = input.window;
  const inWindow = sql`c.at >= ${start} and c.at < ${end}`;
  const rows = await db.execute<{
    pageId: string; budget: string; sends: number; minGapMs: number | null; max60: number | null; max300: number | null;
  }>(sql`
    with budgets(operation, budget, interval_ms) as (values ${sql.join(members, sql`, `)}),
    sends as (${shadowSends({ pageIds, window: input.window })}),
    counted as (
      select s.page_id, b.budget, b.interval_ms, s.at,
             count(*) over (partition by s.page_id, b.budget order by s.at range between ${frameOffset(w60)} preceding and current row) as n60,
             count(*) over (partition by s.page_id, b.budget order by s.at range between ${frameOffset(w300)} preceding and current row) as n300,
             extract(epoch from s.at - lag(s.at) over (partition by s.page_id, b.budget order by s.at)) * 1000 as gap_ms
        from sends s
        join budgets b on b.operation = s.operation
    )
    select c.page_id::text as "pageId", c.budget,
           count(*) filter (where ${inWindow})::int as sends,
           min(c.gap_ms) filter (where ${inWindow}) as "minGapMs",
           max(c.n60) filter (where ${inWindow})::int as max60,
           max(c.n300) filter (where ${inWindow})::int as max300
      from counted c
     group by c.page_id, c.budget
    having count(*) filter (where ${inWindow}) > 0
     order by c.page_id, c.budget
  `);
  const known = budgets.flatMap((budget) => budget.operations);
  const unplaced = await db.execute<{ pageId: string; operation: string; sends: number }>(sql`
    select s.page_id::text as "pageId", s.operation, count(*)::int as sends
      from (${shadowSends({ pageIds, window: input.window })}) s
     where s.at >= ${start} and s.at < ${end}
       and not (s.operation = any(${sql.param(known)}::text[]))
     group by 1, 2
     order by 1, 2
  `);
  // The verdict is the send audit's, per page over the shadow journal.
  const audits = new Map<number, ReturnType<typeof auditRouteIntervals>>();
  for (const pageId of pageIds) {
    const sends = await readFanslySendAudit(db, { pageId, since: start, until: end, shadow: true });
    audits.set(pageId, auditRouteIntervals(sends, { start, until: end }));
  }
  const byBudget = new Map(budgets.map((budget) => [budget.budget, budget]));
  const budgetRows: RouteBudgetRow[] = rows.rows.map((row) => {
    const budget = byBudget.get(row.budget)!;
    const audited = audits.get(Number(row.pageId))?.scopes.find((scope) => (scope.kind === "route" ? scope.scope : `family:${scope.scope}`) === row.budget);
    return {
      page: label(Number(row.pageId)),
      budget: row.budget,
      perMin: budget.perMin,
      intervalMs: budget.intervalMs,
      sends: Number(row.sends),
      minGapMs: row.minGapMs === null ? null : Math.round(Number(row.minGapMs)),
      max60s: Number(row.max60 ?? 0),
      bound60s: routeBudgetBound(w60, budget.intervalMs),
      max300s: Number(row.max300 ?? 0),
      bound300s: routeBudgetBound(w300, budget.intervalMs),
      violations: audited?.violations ?? 0,
      firstViolationAt: audited?.firstViolationAt ?? null,
      inconclusive: audited?.inconclusive ?? 0,
    };
  });
  const unplacedRows = unplaced.rows.map((row) => ({ page: label(Number(row.pageId)), operation: row.operation, sends: Number(row.sends) }));
  return {
    rows: budgetRows,
    unplaced: unplacedRows,
    violations: budgetRows.reduce((total, row) => total + row.violations, 0) + unplacedRows.reduce((total, row) => total + row.sends, 0),
    inconclusive: budgetRows.reduce((total, row) => total + row.inconclusive, 0),
  };
}

async function readWalks(
  db: Database,
  input: { pages: readonly SyncPageRow[]; window: { start: Date; end: Date }; maxListed: number },
): Promise<ShadowWalks> {
  const pageIds = sql.param(input.pages.map((page) => String(page.pageId)));
  const keys = sql.param(walkKeys());
  const label = labelOf(input.pages);
  const runs = sql`
    select a.page_id, a.work_id, a.resource, a.operation, coalesce(a.request -> 'position', a.request -> 'params') as position,
           a.admitted_at
      from sync_attempts a
     where a.shadow
       and a.page_id = any(${pageIds}::bigint[])
       and a.admitted_at >= ${input.window.start} and a.admitted_at < ${input.window.end}
       and a.resource = any(${keys}::text[])
       and a.work_id is not null
       and a.sent_at is not null
  `;
  const counted = await db.execute<{ runs: number }>(sql`
    select count(distinct (r.page_id, r.work_id))::int as runs from (${runs}) r
  `);
  const repeated = await db.execute<{
    pageId: string; workId: string; resource: string; operation: string; position: unknown; times: number;
    firstAt: Date | string; lastAt: Date | string;
  }>(sql`
    select r.page_id::text as "pageId", r.work_id::text as "workId", r.resource, r.operation, r.position,
           count(*)::int as times, min(r.admitted_at) as "firstAt", max(r.admitted_at) as "lastAt"
      from (${runs}) r
     where jsonb_typeof(r.position) = 'object' and r.position <> '{}'::jsonb
     group by r.page_id, r.work_id, r.resource, r.operation, r.position
    having count(*) > 1
     order by r.page_id, r.operation, min(r.admitted_at)
  `);
  const endless = repeated.rows.map((row) => ({
    page: label(Number(row.pageId)),
    route: row.operation,
    resource: row.resource,
    workId: Number(row.workId),
    position: row.position,
    times: Number(row.times),
    firstAt: new Date(row.firstAt),
    lastAt: new Date(row.lastAt),
  }));
  return {
    runs: Number(counted.rows[0]?.runs ?? 0),
    endless: endless.slice(0, input.maxListed),
    repeats: endless.reduce((total, row) => total + row.times - 1, 0),
  };
}

/** Both checks over the shadow journal of the window (read-only). */
export async function readShadowRouteChecks(
  db: Database,
  input: { pages: readonly SyncPageRow[]; window: { start: Date; end: Date }; maxListed: number },
): Promise<ShadowRouteChecks> {
  if (input.pages.length === 0) return { budgets: { rows: [], unplaced: [], violations: 0, inconclusive: 0 }, walks: { runs: 0, endless: [], repeats: 0 } };
  return {
    budgets: await readRouteBudgets(db, input),
    walks: await readWalks(db, input),
  };
}

/** The checks' report lines (owner-readable). */
export function routeCheckLines(checks: ShadowRouteChecks): string[] {
  const { budgets, walks } = checks;
  const over = budgets.rows.filter((row) => row.violations > 0).map((row) => `${row.page} ${row.budget} `
    + `${row.violations} send(s) closer than their recorded interval (shortest gap ${row.minGapMs ?? "—"} ms of ${row.intervalMs}; `
    + `max ${row.max60s}/${row.bound60s} in 60 s, ${row.max300s}/${row.bound300s} in 300 s; first ${row.firstViolationAt?.toISOString() ?? "—"})`);
  const unplaced = budgets.unplaced.map((row) => `${row.page} ${row.operation} ${row.sends}`);
  const open = budgets.rows.filter((row) => row.inconclusive > 0).map((row) => `${row.page} ${row.budget} ${row.inconclusive}`);
  const spent = budgets.rows.filter((row) => !row.budget.startsWith("family:")).length;
  const inconclusive = open.length === 0 ? "" : `; pairs without a recorded interval (inconclusive): ${open.join(", ")}`;
  const lines = [
    `Route budgets in shadow: ${budgets.violations === 0
      ? `0 violations over ${spent} page route(s) with sends (each pair of adjacent sends of a route and of a family `
        + `≥ the interval its later send was admitted under)${inconclusive}`
      : `${budgets.violations} violation(s)${over.length === 0 ? "" : `: ${over.join("; ")}`}`
        + `${unplaced.length === 0 ? "" : `; sends this build places on no route: ${unplaced.join(", ")}`}${inconclusive}`}`,
  ];
  const listed = walks.endless.map((row) => `${row.page} ${row.resource} (work ${row.workId}) asked ${row.route} `
    + `${JSON.stringify(row.position)} ${row.times} times ${row.firstAt.toISOString()} … ${row.lastAt.toISOString()}`);
  lines.push(walks.repeats === 0
    ? `Walks per route: ${walks.runs} walk run(s), none asked a route from the same position twice`
    : `Walks per route: ENDLESS — ${walks.repeats} repeated request(s): ${listed.join("; ")}`);
  return lines;
}
