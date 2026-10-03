import { SYNC_SEND_WINDOW_MS } from "@agency_hub_core/db";

import { incidentKey, syncEngineIncidentKey } from "../../services/notification-incidents.ts";
import { SYNC_ALERT_CLEAN_MS } from "../engine/alerts.ts";
import { NETWORK_FAILURES_TO_PAUSE } from "../engine/errors.ts";
import {
  FAMILY_BUDGETS,
  familyOfRoute,
  intervalMsOf,
  isFanslyRoute,
  routeBudget,
  routeOfEngineOperation,
  routeOfLegacyOperation,
  type FanslyRoute,
} from "../fansly/routes.ts";

// The rules of the live-hour acceptance of switched pages (step 3b ruling 13,
// A1 §2b, A6; owner decisions №18, №21–№26), pure. `switch/acceptance.ts`
// (`pnpm cli sync switch check`) reads the journals and judges with these;
// `step3-accept.sql` (psql, read-only, beside this file) implements the same
// rules in SQL — its numbers, route table and legacy operation map are pinned
// to these by tests/sync-switch-acceptance-sql.test.ts, and the shared
// fixtures of tests/sync-switch-acceptance.integration.test.ts run both.
//
// Window: each page is judged over [T_i, T* + 1 h), T_i = the later of the
// owner's `since` and the instant the page became live, T* = max(T_i) over
// the pages checked together — a fault in a page's first minutes counts. Per
// (page, canonical route): at most one 429; a second one on the same pair,
// any 401/403 or a page hold fails the page — a 429 that held more than its
// route is a page hold (alert 1's latch shows it after the hold is gone);
// 429s on different routes of a page are shown together for the owner. A 429
// whose route was not seen to recover, a sample under 10, an open window:
// `inconclusive`, never a pass for lack of data.

/** Every number of the acceptance (the same `\set` values in step3-accept.sql). */
export const ACCEPTANCE_RULES = {
  /** The shared hour after the last page went live (№18, ruling 13). */
  windowMs: 60 * 60_000,
  /** A latency percentile needs this many samples; fewer: count and max,
   *  `inconclusive` (ruling 13). */
  minSamples: 10,
  /** The first media-statistics request after live (ruling 13). */
  mediaStartMs: 60_000,
  /** §2b: per send, the sends of its route (family) within each window W
   *  ending at it are at most ⌈W / T⌉ + 1, T = the budget's interval (A1). */
  budgetWindowsMs: [60_000, 300_000] as readonly number[],
  budgetSlackSends: 1,
  /** A 429 without `Retry-After` holds its route at least the ladder's first
   *  step (owner decision №14); a valid `Retry-After` wins. */
  firstHoldMs: 5_000,
  /** Each 429 halves the page+route rate, never below ⅛ of its ceiling (A2, D3). */
  slowdownFactor: 0.5,
  slowdownFloorShare: 0.125,
  /** Consecutive network failures that hold the page (`engine/errors.ts`). */
  networkFailuresToHold: NETWORK_FAILURES_TO_PAUSE,
  /** Alert 1's latch resolves only after its stop has stayed clear this long
   *  (`engine/alerts.ts`): a resolved episode was last seen this long before
   *  its resolve. */
  alertCleanMs: SYNC_ALERT_CLEAN_MS,
  /** The journal is read from this long before T_i (a network streak that
   *  began before the window). */
  lookbackMs: 60 * 60_000,
  /** An attempt without a recorded send instant counts at admission + this
   *  (an unknown outcome consumes budget at its upper bound, ruling 4). */
  sendWindowMs: SYNC_SEND_WINDOW_MS,
  /** A confirm mismatch share above this fails (plan §13). */
  mismatchShare: 0.001,
  /** A fan message unconfirmed for longer than this fails (alert 3's bound). */
  unconfirmedAfterMs: 15 * 60_000,
} as const;

/** The latency SLOs (plan §13), measured over the whole window — route-hold
 *  periods included — with the unfinished tail counted at its age. */
export const ACCEPTANCE_LATENCY_SLOS = [
  { name: "slo_visible", boundSeconds: 5, measure: "p95" },
  { name: "slo_confirm", boundSeconds: 30, measure: "p95" },
  { name: "slo_confirm_fast", boundSeconds: 10, measure: "p95" },
  { name: "slo_find", boundSeconds: 12, measure: "p95", resource: "dm-conversations.find" },
  { name: "slo_money_head", boundSeconds: 12, measure: "p95", resource: "transactions.head" },
  { name: "slo_deletions", boundSeconds: 5, measure: "max", resource: "dm-live.deletions" },
  { name: "slo_repair", boundSeconds: 60, measure: "max", resource: "repair.ws-gap" },
] as const satisfies ReadonlyArray<{ name: string; boundSeconds: number; measure: "p95" | "max"; resource?: string }>;

export type LatencySloName = (typeof ACCEPTANCE_LATENCY_SLOS)[number]["name"];

/** The work keys whose latency is an SLO. */
export const ACCEPTANCE_SLO_RESOURCES: readonly string[] = ACCEPTANCE_LATENCY_SLOS.flatMap((slo) =>
  "resource" in slo ? [slo.resource] : []);

/** Every check of a page, in report order (the same names and order in SQL). */
export const ACCEPTANCE_CHECKS = [
  "live",
  "window_complete",
  "pace_combined",
  "handover_boundary",
  "route_budgets",
  "route_429",
  "auth_refusals",
  "page_hold",
  "media_start",
  "nothing_stuck",
  "slo_visible",
  "slo_confirm",
  "slo_confirm_fast",
  "confirm_mismatches",
  "unconfirmed_over_15m",
  "slo_find",
  "slo_money_head",
  "slo_deletions",
  "slo_repair",
  "open_incidents",
] as const;

export type AcceptanceCheckName = (typeof ACCEPTANCE_CHECKS)[number];

export type CheckVerdict = "pass" | "fail" | "inconclusive";

/** A page's verdict, most severe first. */
export type PageVerdict = "fail" | "inconclusive" | "owner_review" | "accepted_with_route_429" | "pass";

export interface AcceptanceCheck {
  name: AcceptanceCheckName;
  verdict: CheckVerdict;
  detail: Record<string, unknown>;
}

export interface AcceptanceWindow {
  /** T_i. */
  start: Date;
  /** T* + 1 h (or the owner's `until`). */
  end: Date;
  /** The end of what has happened: min(end, now). */
  observedUntil: Date;
  now: Date;
}

/** The windows of the pages checked together. */
export function acceptanceWindows<P extends { pageId: number; live: boolean; liveSince: Date }>(
  pages: readonly P[],
  input: { since: Date; until: Date | null; now: Date },
): { tStar: Date | null; end: Date | null; windows: Map<number, AcceptanceWindow> } {
  const starts = new Map(pages.map((page) => [
    page.pageId,
    page.live && page.liveSince.getTime() > input.since.getTime() ? page.liveSince : input.since,
  ]));
  if (starts.size === 0) return { tStar: null, end: null, windows: new Map() };
  const tStar = new Date(Math.max(...[...starts.values()].map((start) => start.getTime())));
  const end = input.until ?? new Date(tStar.getTime() + ACCEPTANCE_RULES.windowMs);
  const observedUntil = new Date(Math.min(end.getTime(), input.now.getTime()));
  return {
    tStar,
    end,
    windows: new Map([...starts].map(([pageId, start]) => [pageId, { start, end, observedUntil, now: input.now }])),
  };
}

/** One row of a page's live journals: an engine attempt or a legacy send. */
export interface AcceptanceJournalRow {
  journal: "engine" | "legacy";
  ref: number;
  operation: string;
  resource: string | null;
  /** The send instant; when never recorded, its upper bound (admission + the
   *  send window; a legacy capture's completion or lease end); null: it never
   *  went out. */
  at: Date | null;
  /** When its outcome was known: completion, else send, else admission. */
  doneAt: Date;
  outcome: string | null;
  httpStatus: number | null;
  retryAfterMs: number | null;
  /** The engine's error class (null: an answer, or a legacy row). */
  errorClass: string | null;
}

/** The canonical route of a journal row; an operation this build cannot
 *  place is a pair of its own (`unknown:<journal>:<operation>`). */
export function acceptanceRouteOf(journal: AcceptanceJournalRow["journal"], operation: string): string {
  const route = journal === "engine" ? routeOfEngineOperation(operation) : routeOfLegacyOperation(operation);
  return route ?? `unknown:${journal}:${operation}`;
}

function inWindow(at: Date, window: Pick<AcceptanceWindow, "start" | "observedUntil">): boolean {
  return at.getTime() >= window.start.getTime() && at.getTime() < window.observedUntil.getTime();
}

function compareRows(a: { ms: number; journal: string; ref: number }, b: { ms: number; journal: string; ref: number }): number {
  return a.ms - b.ms || (a.journal < b.journal ? -1 : a.journal > b.journal ? 1 : 0) || a.ref - b.ref;
}

/** First index of `sorted` (ascending) whose value is > `value`. */
function upperBound(sorted: readonly number[], value: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid]! <= value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Sends within (t − W, t] in an ascending list of instants. */
function countWithin(sorted: readonly number[], t: number, windowMs: number): number {
  return upperBound(sorted, t) - upperBound(sorted, t - windowMs);
}

/** The interval budget a send is judged under: ⌈W / T⌉ + slack. */
export function budgetBound(perMin: number, windowMs: number): number {
  return Math.ceil(windowMs / intervalMsOf(perMin)) + ACCEPTANCE_RULES.budgetSlackSends;
}

/** A route's rate after `k` of its 429s (A2: halved each time, ≥ ⅛ ceiling). */
export function slowedRatePerMin(route: FanslyRoute, k: number): number {
  const budget = routeBudget(route);
  return Math.max(budget.currentPerMin * ACCEPTANCE_RULES.slowdownFactor ** k, budget.ceilingPerMin * ACCEPTANCE_RULES.slowdownFloorShare);
}

/** One window 429 of a page+route. */
interface Rate429 {
  route: string;
  row: AcceptanceJournalRow;
  ms: number;
}

function window429s(rows: readonly AcceptanceJournalRow[], window: AcceptanceWindow): Map<string, Rate429[]> {
  const byRoute = new Map<string, Rate429[]>();
  for (const row of rows) {
    if (row.httpStatus !== 429 || !inWindow(row.doneAt, window)) continue;
    const route = acceptanceRouteOf(row.journal, row.operation);
    const list = byRoute.get(route) ?? [];
    list.push({ route, row, ms: row.doneAt.getTime() });
    byRoute.set(route, list);
  }
  for (const list of byRoute.values()) {
    list.sort((a, b) => compareRows({ ms: a.ms, journal: a.row.journal, ref: a.row.ref }, { ms: b.ms, journal: b.row.journal, ref: b.row.ref }));
  }
  return byRoute;
}

export interface BudgetViolation {
  kind: "route" | "family" | "slowdown";
  /** The route, or the family. */
  scope: string;
  windowMs: number;
  sends: number;
  bound: number;
  at: Date;
  journal: AcceptanceJournalRow["journal"];
  ref: number;
}

/**
 * §2b (A1): every send of the window on a budgeted route, judged against its
 * route's and its family's `current` budget, and — after a 429 of its
 * page+route in the window — against the halved rate, counting only the
 * sends since that 429. An unknown outcome counts at its upper bound. Only
 * the budget's own admissions count — the sends from T_i on: what the legacy
 * engine (or an earlier build) sent before T_i was paced by another policy,
 * and the admission spaces its first send of a route one interval after the
 * last of them, never by how many there were (opus r1 §2.H "допуски
 * бюджета").
 */
export function routeBudgetViolations(rows: readonly AcceptanceJournalRow[], window: AcceptanceWindow): BudgetViolation[] {
  const rate429 = window429s(rows, window);
  interface Send { row: AcceptanceJournalRow; route: FanslyRoute; ms: number; k: number }
  const sends: Send[] = [];
  for (const row of rows) {
    if (row.at === null || row.at.getTime() < window.start.getTime()) continue;
    const route = acceptanceRouteOf(row.journal, row.operation);
    if (!isFanslyRoute(route)) continue;
    const ms = row.at.getTime();
    const k = (rate429.get(route) ?? []).filter((entry) => entry.ms < ms).length;
    sends.push({ row, route, ms, k });
  }
  const instants = (keyOf: (send: Send) => string | null): Map<string, number[]> => {
    const groups = new Map<string, number[]>();
    for (const send of sends) {
      const key = keyOf(send);
      if (key === null) continue;
      const list = groups.get(key) ?? [];
      list.push(send.ms);
      groups.set(key, list);
    }
    for (const list of groups.values()) list.sort((a, b) => a - b);
    return groups;
  };
  const byRoute = instants((send) => send.route);
  const byFamily = instants((send) => familyOfRoute(send.route));
  const bySegment = instants((send) => `${send.route}#${send.k}`);

  const violations: BudgetViolation[] = [];
  for (const send of sends) {
    if (!inWindow(send.row.at!, window)) continue;
    const family = familyOfRoute(send.route);
    const judged: Array<{ kind: BudgetViolation["kind"]; scope: string; list: number[]; perMin: number }> = [
      { kind: "route", scope: send.route, list: byRoute.get(send.route)!, perMin: routeBudget(send.route).currentPerMin },
    ];
    if (family !== null) {
      judged.push({ kind: "family", scope: family, list: byFamily.get(family)!, perMin: FAMILY_BUDGETS[family].currentPerMin });
    }
    if (send.k > 0) {
      judged.push({ kind: "slowdown", scope: send.route, list: bySegment.get(`${send.route}#${send.k}`)!, perMin: slowedRatePerMin(send.route, send.k) });
    }
    for (const entry of judged) {
      for (const windowMs of ACCEPTANCE_RULES.budgetWindowsMs) {
        const count = countWithin(entry.list, send.ms, windowMs);
        const bound = budgetBound(entry.perMin, windowMs);
        if (count > bound) {
          violations.push({ kind: entry.kind, scope: entry.scope, windowMs, sends: count, bound, at: send.row.at!, journal: send.row.journal, ref: send.row.ref });
        }
      }
    }
  }
  const kinds = ["family", "route", "slowdown"];
  violations.sort((a, b) => compareRows({ ms: a.at.getTime(), journal: a.journal, ref: a.ref }, { ms: b.at.getTime(), journal: b.journal, ref: b.ref })
    || kinds.indexOf(a.kind) - kinds.indexOf(b.kind) || a.windowMs - b.windowMs);
  return violations;
}

/** What one page+route's 429s of the window came to (A6). */
export type Route429State =
  /** One 429, its hold honoured, a later answer on the route proves it recovered. */
  | "recovered"
  /** One 429, no later answer on the route yet: re-read the tail later. */
  | "unproven"
  /** A second 429 on the same page+route: the page fails. */
  | "repeated"
  /** A send on the route inside the 429's hold: the page fails. */
  | "hold_broken";

export interface Route429Outcome {
  route: string;
  count: number;
  state: Route429State;
  attempts: Array<{ journal: AcceptanceJournalRow["journal"]; ref: number; resource: string | null; at: Date; retryAfterMs: number | null }>;
}

/**
 * Per (page, canonical route) of the window: its 429s, whatever resource sent
 * them. A route's hold is honoured when no send on it falls inside
 * (429, 429 + Retry-After or the ladder's first step); a later answer below 400
 * on the route — read up to now, past the window end — proves the recovery.
 */
export function route429Outcomes(rows: readonly AcceptanceJournalRow[], window: AcceptanceWindow): Route429Outcome[] {
  const sendsByRoute = new Map<string, AcceptanceJournalRow[]>();
  for (const row of rows) {
    if (row.at === null) continue;
    const route = acceptanceRouteOf(row.journal, row.operation);
    const list = sendsByRoute.get(route) ?? [];
    list.push(row);
    sendsByRoute.set(route, list);
  }
  const outcomes: Route429Outcome[] = [];
  for (const [route, list] of window429s(rows, window)) {
    const sends = sendsByRoute.get(route) ?? [];
    const broken = list.some((entry) => {
      const until = entry.ms + (entry.row.retryAfterMs ?? ACCEPTANCE_RULES.firstHoldMs);
      return sends.some((send) => send.at!.getTime() > entry.ms && send.at!.getTime() < until);
    });
    const lastMs = list[list.length - 1]!.ms;
    const recovered = sends.some((send) => send.at!.getTime() > lastMs && send.httpStatus !== null && send.httpStatus >= 100 && send.httpStatus <= 399);
    outcomes.push({
      route,
      count: list.length,
      state: list.length >= 2 ? "repeated" : broken ? "hold_broken" : recovered ? "recovered" : "unproven",
      attempts: list.map((entry) => ({
        journal: entry.row.journal,
        ref: entry.row.ref,
        resource: entry.row.resource,
        at: entry.row.doneAt,
        retryAfterMs: entry.row.retryAfterMs,
      })),
    });
  }
  return outcomes.sort((a, b) => (a.route < b.route ? -1 : a.route > b.route ? 1 : 0));
}

export function route429Check(outcomes: readonly Route429Outcome[]): AcceptanceCheck {
  const verdict: CheckVerdict = outcomes.some((entry) => entry.state === "repeated" || entry.state === "hold_broken")
    ? "fail"
    : outcomes.some((entry) => entry.state === "unproven") ? "inconclusive" : "pass";
  return {
    name: "route_429",
    verdict,
    detail: {
      routesWith429: outcomes.length,
      routes: outcomes.map((entry) => ({
        route: entry.route,
        count: entry.count,
        state: entry.state,
        attempts: entry.attempts.map((attempt) => ({ ...attempt, at: attempt.at.toISOString() })),
      })),
    },
  };
}

/** Any 401/403 of the window, a subject's or a candidate's included (A6). */
export function authRefusalsCheck(rows: readonly AcceptanceJournalRow[], window: AcceptanceWindow): AcceptanceCheck {
  const counts = new Map<string, { httpStatus: number; route: string; resource: string | null; count: number }>();
  for (const row of rows) {
    if ((row.httpStatus !== 401 && row.httpStatus !== 403) || !inWindow(row.doneAt, window)) continue;
    const route = acceptanceRouteOf(row.journal, row.operation);
    const key = `${row.httpStatus}\u0000${route}\u0000${row.resource ?? ""}`;
    const entry = counts.get(key) ?? { httpStatus: row.httpStatus, route, resource: row.resource, count: 0 };
    entry.count += 1;
    counts.set(key, entry);
  }
  const byRoute = [...counts.values()].sort((a, b) => a.httpStatus - b.httpStatus || a.route.localeCompare(b.route));
  const refusals = byRoute.reduce((sum, entry) => sum + entry.count, 0);
  return { name: "auth_refusals", verdict: refusals === 0 ? "pass" : "fail", detail: { refusals, byRoute } };
}

/** The page row's hold columns as they stand. */
export interface PageHoldColumns {
  holdKind: string | null;
  holdSince: Date | null;
  holdUntil: Date | null;
}

/**
 * One episode of the page's alert 1 (`page_stopped`, `engine/alerts.ts`): the
 * latch row's newest one, or an earlier one the paging sweep recorded
 * (`notification_incident_cycles`; the latch keeps only its newest).
 */
export interface PageStopEpisode {
  openedAt: Date;
  /** While the latch is open: the newest instant its stop was seen
   *  (`last_seen_at`). Null once resolved (the resolve overwrites it). */
  lastSeenAt: Date | null;
  resolvedAt: Date | null;
  /** The stop's newest reason (`error_code`): the latch row's episode only. */
  detail: string | null;
}

/** The last instant an episode's stop was seen: an open latch's `last_seen_at`;
 *  a resolved one waited 10 clean minutes before its resolve (an earlier,
 *  never-settled one: its opening) — never before it opened. */
export function pageStopSeenUntil(episode: PageStopEpisode): Date {
  if (episode.resolvedAt === null && episode.lastSeenAt !== null) return episode.lastSeenAt;
  const cleared = episode.resolvedAt === null ? episode.openedAt.getTime() : episode.resolvedAt.getTime() - ACCEPTANCE_RULES.alertCleanMs;
  return new Date(Math.max(episode.openedAt.getTime(), cleared));
}

/**
 * A page hold within the window (A6): an answer that holds the page
 * (`auth`, `identity_mismatch`), a network failure that reached the streak
 * that holds it (`engine/errors.ts` `onOutcome`: every other answer ends the
 * streak; a request never sent leaves it), the page row's hold overlapping
 * the window (a carried or imported hold, one still in force), or an episode
 * of alert 1 — the page stopped — seen within the window, resolved ones
 * included: the only trace of a hold that has ended and been cleared, such as
 * a 429 that held the whole page instead of its route (a `rate_limit` page
 * hold, imported from the legacy engine or set by a regression). A stop that
 * ended before T_i (its latch still in its clean minutes) is not the window's.
 */
export function pageHoldCheck(
  rows: readonly AcceptanceJournalRow[],
  window: AcceptanceWindow,
  page: PageHoldColumns,
  stops: readonly PageStopEpisode[],
): AcceptanceCheck {
  let credentialsAnswers = 0;
  for (const row of rows) {
    if (row.journal === "engine" && (row.errorClass === "auth" || row.errorClass === "identity_mismatch") && inWindow(row.doneAt, window)) {
      credentialsAnswers += 1;
    }
  }
  const answered = rows
    .filter((row) => row.journal === "engine"
      && (row.outcome === "response" || row.outcome === "transport_error" || row.outcome === "timeout")
      && row.errorClass !== "not_sent")
    .sort((a, b) => a.doneAt.getTime() - b.doneAt.getTime() || a.ref - b.ref);
  let streak = 0;
  let networkHolds = 0;
  for (const row of answered) {
    streak = row.errorClass === "network" ? streak + 1 : 0;
    if (row.errorClass === "network" && streak >= ACCEPTANCE_RULES.networkFailuresToHold && inWindow(row.doneAt, window)) networkHolds += 1;
  }
  const current = page.holdKind !== null && page.holdUntil !== null
    && page.holdUntil.getTime() > window.start.getTime()
    && (page.holdSince === null || page.holdSince.getTime() < window.observedUntil.getTime());
  const stopped = stops
    .map((episode) => ({ episode, seenUntil: pageStopSeenUntil(episode) }))
    .filter(({ episode, seenUntil }) => episode.openedAt.getTime() < window.observedUntil.getTime()
      && seenUntil.getTime() >= window.start.getTime())
    .sort((a, b) => a.episode.openedAt.getTime() - b.episode.openedAt.getTime());
  return {
    name: "page_hold",
    verdict: credentialsAnswers > 0 || networkHolds > 0 || current || stopped.length > 0 ? "fail" : "pass",
    detail: {
      credentialsAnswers,
      networkHolds,
      current: current
        ? { kind: page.holdKind, since: page.holdSince?.toISOString() ?? null, until: page.holdUntil!.toISOString() }
        : null,
      stopped: stopped.map(({ episode, seenUntil }) => ({
        openedAt: episode.openedAt.toISOString(),
        seenUntil: seenUntil.toISOString(),
        resolvedAt: episode.resolvedAt?.toISOString() ?? null,
        detail: episode.detail,
      })),
    },
  };
}

/** The first media-statistics request ≤ 60 s after T_i (ruling 13). Later or
 *  none: `inconclusive` (nothing may have been due — the runbook's declared
 *  control refresh decides), `fail` when the owner paused the walk. */
export function mediaStartCheck(rows: readonly AcceptanceJournalRow[], window: AcceptanceWindow, paused: boolean): AcceptanceCheck {
  let first: number | null = null;
  for (const row of rows) {
    if (row.journal !== "engine" || row.at === null || acceptanceRouteOf(row.journal, row.operation) !== "media.offer_stats") continue;
    if (!inWindow(row.at, window)) continue;
    first = first === null ? row.at.getTime() : Math.min(first, row.at.getTime());
  }
  const afterMs = first === null ? null : first - window.start.getTime();
  return {
    name: "media_start",
    verdict: afterMs !== null && afterMs <= ACCEPTANCE_RULES.mediaStartMs ? "pass" : paused ? "fail" : "inconclusive",
    detail: {
      firstRequestAfterSeconds: afterMs === null ? null : Math.round(afterMs / 100) / 10,
      paused,
      boundSeconds: ACCEPTANCE_RULES.mediaStartMs / 1_000,
    },
  };
}

/** `percentile_cont(p)`: linear interpolation between the closest ranks. */
export function percentileCont(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = p * (sorted.length - 1);
  const lo = Math.floor(position);
  const hi = Math.ceil(position);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (position - lo);
}

function round1(value: number | null): number | null {
  return value === null ? null : Math.round(value * 10) / 10;
}

/** A latency SLO over its samples (seconds): p95 ≤ bound from 10 samples on,
 *  fewer → count and max, `inconclusive`; a max bound needs one sample. */
export function latencyCheck(name: LatencySloName, samples: readonly number[]): AcceptanceCheck {
  const slo = ACCEPTANCE_LATENCY_SLOS.find((entry) => entry.name === name)!;
  const max = samples.length === 0 ? null : Math.max(...samples);
  const base = { samples: samples.length, maxSeconds: round1(max), boundSeconds: slo.boundSeconds };
  if (slo.measure === "max") {
    if (max === null) return { name, verdict: "inconclusive", detail: base };
    return { name, verdict: max <= slo.boundSeconds ? "pass" : "fail", detail: base };
  }
  if (samples.length < ACCEPTANCE_RULES.minSamples) return { name, verdict: "inconclusive", detail: base };
  const p95 = percentileCont(samples, 0.95)!;
  return { name, verdict: p95 <= slo.boundSeconds ? "pass" : "fail", detail: { ...base, p95Seconds: round1(p95) } };
}

export function mismatchCheck(confirmed: number, mismatches: number): AcceptanceCheck {
  return {
    name: "confirm_mismatches",
    verdict: confirmed === 0 ? "inconclusive" : mismatches <= confirmed * ACCEPTANCE_RULES.mismatchShare ? "pass" : "fail",
    detail: { confirmed, mismatches },
  };
}

/** D5's per-route incident (step 3b PR 1-2, `SYNC_ENGINE_ROUTE_SUBKEY_PREFIX`):
 *  one latch per page+route, `route_limited:<route>`. */
export const ACCEPTANCE_ROUTE_INCIDENT_SUBKEY_PREFIX = "route_limited:";

/** The latch keys of a page the acceptance reads (`services/notification-incidents.ts`):
 *  alert 1 (the page stopped) and the prefix of its per-route incidents. */
export function acceptanceIncidentKeys(pageId: number): { pageStopped: string; routePrefix: string } {
  return {
    pageStopped: syncEngineIncidentKey({ subKey: "page_stopped", pageId }),
    routePrefix: incidentKey({ kind: "fansly_sync_engine", platformAccountId: pageId, subKey: ACCEPTANCE_ROUTE_INCIDENT_SUBKEY_PREFIX }),
  };
}

/** An open incident of the page that is a route's own (D5): judged by the
 *  route rule, told by its key — its error code follows the route's hold
 *  (`rate_limit`, `route_held`, `unavailable` for a 5xx naming its
 *  Retry-After). Alert 1 (`page_stopped`, a 429's included) is never one. */
export function judgedByRouteRule(pageId: number, key: string): boolean {
  const { routePrefix } = acceptanceIncidentKeys(pageId);
  return key.startsWith(routePrefix) && key.length > routePrefix.length;
}

/** The page's verdict: fail > inconclusive > owner_review (429s on two or
 *  more routes, each recovered) > accepted_with_route_429 > pass. */
export function pageVerdict(checks: readonly AcceptanceCheck[]): { verdict: PageVerdict; reasons: AcceptanceCheckName[] } {
  const ordered = [...checks].sort((a, b) => ACCEPTANCE_CHECKS.indexOf(a.name) - ACCEPTANCE_CHECKS.indexOf(b.name));
  const failing = ordered.filter((check) => check.verdict === "fail").map((check) => check.name);
  if (failing.length > 0) return { verdict: "fail", reasons: failing };
  const open = ordered.filter((check) => check.verdict === "inconclusive").map((check) => check.name);
  if (open.length > 0) return { verdict: "inconclusive", reasons: open };
  const routes = Number(checks.find((check) => check.name === "route_429")?.detail.routesWith429 ?? 0);
  if (routes >= 2) return { verdict: "owner_review", reasons: [] };
  if (routes === 1) return { verdict: "accepted_with_route_429", reasons: [] };
  return { verdict: "pass", reasons: [] };
}

/** Accepted without the owner: a pass, or one recovered route 429. */
export function isAcceptedVerdict(verdict: PageVerdict): boolean {
  return verdict === "pass" || verdict === "accepted_with_route_429";
}
