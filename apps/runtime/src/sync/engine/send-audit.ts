import type { FanslySendAuditRow } from "@agency_hub_core/db";

import {
  FAMILY_BUDGETS,
  familyOfRoute,
  intervalMsOf,
  routeBudget,
  routeOfEngineOperation,
  routeOfLegacyOperation,
  type FanslyRoute,
} from "../fansly/routes.ts";

// The send audit of a page (invariants I1 and I19; arena 3b-review G1): the
// one checker of the alert evaluator (alert 1's permanent pace latch), `sync
// switch check` and the shadow report. It judges the sends the journals
// recorded against what each admission recorded it applied — never against a
// copy of the policy that chose it:
//
//   I1   every pair of adjacent actual sends of the page, of either journal:
//        gap ≥ the later send's own pause, S × (1 + u) (`pause_ms`). On the
//        monotonic clock where the engine recorded it (`gap_prev_ms`, to the
//        same owner's previous send), else on the recorded wall clocks.
//   I19  every pair of adjacent sends of one (page, canonical route), and of
//        one (page, family), whose later send is an engine admission: gap ≥
//        the interval that admission recorded (`route_interval_ms`,
//        `family_interval_ms`, 0237). A send whose instant was never recorded
//        counts at its upper bound, as the admission counts it; one that
//        provably never went out does not count. And, independently of the
//        policy that chose it, a recorded interval is never shorter than the
//        interval of the code's ceiling (`ceiling`).
//
// A pair whose later send recorded no pause or interval (an attempt admitted
// before 0237, a legacy row without its pause) is `inconclusive`, never a
// pass; so is a route audit that read a send this build places on no route.
// A pair whose later send is the legacy engine's is its own policy's, not
// judged by I19. Window counts (⌈W/T⌉ + 1) are the shadow report's
// diagnostics only.

/** The slack of a comparison of two recorded wall-clock instants (`sent_at`,
 *  written by the sending process; an unknown send's bound by the database):
 *  clock slew between two reads. On production the route admission keeps
 *  ≥ 29 ms over its interval and a takeover ≥ 65 ms over the pause; a
 *  monotonic gap gets no slack. */
export const SEND_AUDIT_CLOCK_TOLERANCE_MS = 2;

export type SendAuditVerdict = "pass" | "fail" | "inconclusive";

/** The later sends judged: from `start` (inclusive) to `until` (exclusive;
 *  null: open). Earlier rows are predecessors only. */
export interface SendAuditWindow {
  start: Date;
  until: Date | null;
}

/** A row's journal as the reports name it: `engine`, `legacy:<source>`. */
export function sendAuditJournalOf(row: Pick<FanslySendAuditRow, "journal" | "source">): string {
  return row.journal === "engine" ? "engine" : `legacy:${row.source ?? "unknown"}`;
}

export type SendGapClock = "monotonic" | "wall";

/** I1 for one pair: the gap is short of the pause. A monotonic gap is exact;
 *  a wall-clock one gets the clock tolerance. */
export function paceGapViolates(gapMs: number, clock: SendGapClock, pauseMs: number): boolean {
  return gapMs < pauseMs - (clock === "wall" ? SEND_AUDIT_CLOCK_TOLERANCE_MS : 0);
}

/** I19 for one pair: the gap is short of the interval its later send was
 *  admitted under (recorded wall clocks: the tolerance applies). */
export function intervalGapViolates(gapMs: number, intervalMs: number): boolean {
  return gapMs < intervalMs - SEND_AUDIT_CLOCK_TOLERANCE_MS;
}

function inWindow(ms: number, window: SendAuditWindow): boolean {
  return ms >= window.start.getTime() && (window.until === null || ms < window.until.getTime());
}

interface Placed {
  row: FanslySendAuditRow;
  journal: string;
  ms: number;
}

function compareSends(a: Placed, b: Placed): number {
  return a.ms - b.ms || (a.journal < b.journal ? -1 : a.journal > b.journal ? 1 : 0) || a.row.ref - b.row.ref;
}

function minOf(current: number | null, value: number): number {
  return current === null ? value : Math.min(current, value);
}

// ── I1 ──────────────────────────────────────────────────────────────────────

/** One pair of adjacent sends of a page. */
export interface PacePair {
  journal: string;
  ref: number;
  sentAt: Date;
  prevJournal: string;
  prevRef: number;
  prevSentAt: Date;
  gapMs: number;
  clock: SendGapClock;
  /** The later send's recorded pause; null: none recorded. */
  pauseMs: number | null;
}

export interface PaceAudit {
  verdict: SendAuditVerdict;
  /** Pairs judged against a recorded pause. */
  pairs: number;
  violations: PacePair[];
  /** Pairs whose later send recorded no pause. */
  inconclusive: PacePair[];
  /** The shortest judged gap, and the shortest across the two journals. */
  minGapMs: number | null;
  minCrossJournalGapMs: number | null;
  /** The smallest gap − pause of a judged pair. */
  minMarginMs: number | null;
}

/**
 * I1 over the page's recorded sends of both journals, in send order: every
 * pair whose later send lies in `window`. The gap is the engine's monotonic
 * one when both sends are one owner's (`gap_prev_ms`: to its pacer's previous
 * actual send — the recorded one, or a later one never recorded, which only
 * makes it shorter), else the recorded wall clocks'.
 */
export function auditPagePace(rows: readonly FanslySendAuditRow[], window: SendAuditWindow): PaceAudit {
  const sends: Placed[] = rows
    .filter((row) => row.sentAt !== null)
    .map((row) => ({ row, journal: sendAuditJournalOf(row), ms: row.sentAt!.getTime() }))
    .sort(compareSends);
  const audit: PaceAudit = {
    verdict: "pass",
    pairs: 0,
    violations: [],
    inconclusive: [],
    minGapMs: null,
    minCrossJournalGapMs: null,
    minMarginMs: null,
  };
  for (let index = 1; index < sends.length; index += 1) {
    const later = sends[index]!;
    if (!inWindow(later.ms, window)) continue;
    const prev = sends[index - 1]!;
    const sameOwner = later.row.journal === "engine" && prev.row.journal === "engine"
      && later.row.ownerGeneration !== null && later.row.ownerGeneration === prev.row.ownerGeneration;
    const monotonic = sameOwner && later.row.gapPrevMs !== null;
    const pair: PacePair = {
      journal: later.journal,
      ref: later.row.ref,
      sentAt: later.row.sentAt!,
      prevJournal: prev.journal,
      prevRef: prev.row.ref,
      prevSentAt: prev.row.sentAt!,
      gapMs: monotonic ? later.row.gapPrevMs! : later.ms - prev.ms,
      clock: monotonic ? "monotonic" : "wall",
      pauseMs: later.row.pauseMs,
    };
    audit.minGapMs = minOf(audit.minGapMs, pair.gapMs);
    if (pair.journal !== pair.prevJournal) audit.minCrossJournalGapMs = minOf(audit.minCrossJournalGapMs, pair.gapMs);
    if (pair.pauseMs === null) {
      audit.inconclusive.push(pair);
      continue;
    }
    audit.pairs += 1;
    audit.minMarginMs = minOf(audit.minMarginMs, pair.gapMs - pair.pauseMs);
    if (paceGapViolates(pair.gapMs, pair.clock, pair.pauseMs)) audit.violations.push(pair);
  }
  audit.verdict = audit.violations.length > 0 ? "fail" : audit.inconclusive.length > 0 ? "inconclusive" : "pass";
  return audit;
}

// ── I19 ─────────────────────────────────────────────────────────────────────

export type IntervalScopeKind = "route" | "family";

/** One pair of adjacent sends of a route (or a family) whose later send is an
 *  engine admission. */
export interface IntervalPair {
  kind: IntervalScopeKind;
  /** The canonical route, or the family. */
  scope: string;
  journal: string;
  ref: number;
  at: Date;
  prevJournal: string;
  prevRef: number;
  prevAt: Date;
  gapMs: number;
  /** The interval the later send's admission recorded; null: none recorded
   *  (an attempt before 0237; a family interval the admitting build did not
   *  apply to a route this build places in a family). */
  intervalMs: number | null;
}

/** A recorded interval shorter than the code ceiling's interval. */
export interface CeilingBreach {
  kind: IntervalScopeKind;
  scope: string;
  ref: number;
  at: Date;
  intervalMs: number;
  ceilingIntervalMs: number;
}

/** What one route (or family) of the window came to. */
export interface IntervalScopeSummary {
  kind: IntervalScopeKind;
  scope: string;
  /** Its sends in the window. */
  sends: number;
  /** Pairs judged against a recorded interval. */
  pairs: number;
  violations: number;
  inconclusive: number;
  minGapMs: number | null;
  /** The smallest gap − interval of a judged pair. */
  minMarginMs: number | null;
  firstViolationAt: Date | null;
}

export interface IntervalAudit {
  verdict: SendAuditVerdict;
  /** Pairs judged against a recorded interval, routes and families. */
  pairs: number;
  violations: IntervalPair[];
  ceiling: CeilingBreach[];
  inconclusive: IntervalPair[];
  /** Sends this build places on no route (the admission counted them on
   *  every route): `sends` within the window, `before` it. */
  unplaced: Array<{ journal: string; operation: string; sends: number; before: number }>;
  /** Per route and family with a send in the window, routes first. */
  scopes: IntervalScopeSummary[];
}

function routeOfRow(row: FanslySendAuditRow): FanslyRoute | null {
  return row.journal === "engine" ? routeOfEngineOperation(row.operation) : routeOfLegacyOperation(row.operation);
}

/**
 * I19 over the page's sends as the route clocks count them, in order, per
 * (page, canonical route) and per (page, family): every pair whose later send
 * is an engine admission in `window`, against the interval it recorded; and
 * every interval an admission of the window recorded against the ceiling's.
 */
export function auditRouteIntervals(rows: readonly FanslySendAuditRow[], window: SendAuditWindow): IntervalAudit {
  const groups = new Map<string, { kind: IntervalScopeKind; scope: string; sends: Placed[] }>();
  const unplaced = new Map<string, { journal: string; operation: string; sends: number; before: number }>();
  const ceiling: CeilingBreach[] = [];
  const add = (kind: IntervalScopeKind, scope: string, send: Placed) => {
    const key = `${kind}:${scope}`;
    const group = groups.get(key) ?? { kind, scope, sends: [] };
    group.sends.push(send);
    groups.set(key, group);
  };
  for (const row of rows) {
    if (row.countedAt === null) continue;
    const send: Placed = { row, journal: sendAuditJournalOf(row), ms: row.countedAt.getTime() };
    const route = routeOfRow(row);
    if (route === null) {
      const key = `${send.journal}\u0000${row.operation}`;
      const entry = unplaced.get(key) ?? { journal: send.journal, operation: row.operation, sends: 0, before: 0 };
      if (inWindow(send.ms, window)) entry.sends += 1;
      else entry.before += 1;
      unplaced.set(key, entry);
      continue;
    }
    const family = familyOfRoute(route);
    add("route", route, send);
    if (family !== null) add("family", family, send);
    if (row.journal !== "engine" || !inWindow(send.ms, window)) continue;
    // The independent bound: no admission may apply an interval shorter than
    // the ceiling's, whatever slowdown or calibration chose it.
    const routeCeilingMs = intervalMsOf(routeBudget(route).ceilingPerMin);
    if (row.routeIntervalMs !== null && row.routeIntervalMs < routeCeilingMs) {
      ceiling.push({ kind: "route", scope: route, ref: row.ref, at: row.countedAt, intervalMs: row.routeIntervalMs, ceilingIntervalMs: routeCeilingMs });
    }
    if (family !== null && row.familyIntervalMs !== null) {
      const familyCeilingMs = intervalMsOf(FAMILY_BUDGETS[family].ceilingPerMin);
      if (row.familyIntervalMs < familyCeilingMs) {
        ceiling.push({ kind: "family", scope: family, ref: row.ref, at: row.countedAt, intervalMs: row.familyIntervalMs, ceilingIntervalMs: familyCeilingMs });
      }
    }
  }

  const violations: IntervalPair[] = [];
  const inconclusive: IntervalPair[] = [];
  const scopes: IntervalScopeSummary[] = [];
  let pairs = 0;
  for (const group of groups.values()) {
    const sends = group.sends.sort(compareSends);
    const summary: IntervalScopeSummary = {
      kind: group.kind,
      scope: group.scope,
      sends: 0,
      pairs: 0,
      violations: 0,
      inconclusive: 0,
      minGapMs: null,
      minMarginMs: null,
      firstViolationAt: null,
    };
    for (let index = 0; index < sends.length; index += 1) {
      const later = sends[index]!;
      if (!inWindow(later.ms, window)) continue;
      summary.sends += 1;
      if (index === 0 || later.row.journal !== "engine") continue;
      const prev = sends[index - 1]!;
      const recorded = group.kind === "route"
        ? later.row.routeIntervalMs
        // A family interval only from an admission that recorded its route's:
        // with the route's but not the family's, the admitting build applied
        // no family to the route (this build's table moved it), so unknown.
        : later.row.routeIntervalMs === null ? null : later.row.familyIntervalMs;
      const pair: IntervalPair = {
        kind: group.kind,
        scope: group.scope,
        journal: later.journal,
        ref: later.row.ref,
        at: later.row.countedAt!,
        prevJournal: prev.journal,
        prevRef: prev.row.ref,
        prevAt: prev.row.countedAt!,
        gapMs: later.ms - prev.ms,
        intervalMs: recorded,
      };
      summary.minGapMs = minOf(summary.minGapMs, pair.gapMs);
      if (pair.intervalMs === null) {
        summary.inconclusive += 1;
        inconclusive.push(pair);
        continue;
      }
      pairs += 1;
      summary.pairs += 1;
      summary.minMarginMs = minOf(summary.minMarginMs, pair.gapMs - pair.intervalMs);
      if (intervalGapViolates(pair.gapMs, pair.intervalMs)) {
        summary.violations += 1;
        summary.firstViolationAt ??= pair.at;
        violations.push(pair);
      }
    }
    if (summary.sends > 0) scopes.push(summary);
  }
  for (const breach of ceiling) {
    const summary = scopes.find((entry) => entry.kind === breach.kind && entry.scope === breach.scope);
    if (summary === undefined) continue;
    summary.violations += 1;
    if (summary.firstViolationAt === null || breach.at.getTime() < summary.firstViolationAt.getTime()) summary.firstViolationAt = breach.at;
  }
  const byTime = (a: { at: Date; ref: number }, b: { at: Date; ref: number }) => a.at.getTime() - b.at.getTime() || a.ref - b.ref;
  violations.sort((a, b) => byTime(a, b) || (a.kind < b.kind ? 1 : a.kind > b.kind ? -1 : 0));
  inconclusive.sort(byTime);
  ceiling.sort(byTime);
  scopes.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "route" ? -1 : 1) || a.scope.localeCompare(b.scope));
  const unplacedRows = [...unplaced.values()].sort((a, b) => a.journal.localeCompare(b.journal) || a.operation.localeCompare(b.operation));
  return {
    verdict: violations.length > 0 || ceiling.length > 0
      ? "fail"
      : inconclusive.length > 0 || unplacedRows.length > 0 ? "inconclusive" : "pass",
    pairs,
    violations,
    ceiling,
    inconclusive,
    unplaced: unplacedRows,
    scopes,
  };
}
