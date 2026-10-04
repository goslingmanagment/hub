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
// one checker of the alert evaluator (alert 1's permanent pace latch) and
// `sync check live-hour`. It judges the sends the journals recorded against
// what each admission recorded it applied — never against a copy of the
// policy that chose it:
//
//   I1   every pair of adjacent actual sends of the page, of either journal:
//        gap ≥ the later send's own pause, S × (1 + u) (`pause_ms`). Two
//        tests, both to pass: the recorded instants (`sent_at`, the journal's
//        own witness, with the clock tolerance), and — where both sends are
//        one owner's — the pacer's monotonic gap (`gap_prev_ms`), exactly.
//        The pacer refuses a send on that same number, so it alone proves
//        nothing about a pacer that remembers the wrong previous send.
//   I19  every engine admission against the newest send its route's clock,
//        and its family's, counted when it was admitted — in a journal that
//        keeps the rule, the adjacent pair of the (page, canonical route) and
//        of the (page, family): gap ≥ the interval that admission recorded
//        (`route_interval_ms`, `family_interval_ms`, 0237). And,
//        independently of the policy that chose it, a recorded interval is
//        never shorter than the interval of the code's ceiling (`ceiling`).
//
// A send whose instant was never recorded (an attempt in flight, or left by a
// killed process) may have gone out anywhere between its admission and its
// upper bound. As the EARLIER send of a pair it counts at the upper bound, as
// the admission and the takeover floor count it. As the LATER one it is
// judged at its admission, the earliest it can have left: a gap kept there is
// kept whenever it went out — a pass; short of it only the send instant could
// tell, and nobody recorded it — `inconclusive` (never judged at its upper
// bound, where no interval up to the send window could fail). One that
// provably never went out does not count.
//
// What cannot be judged is `inconclusive`, never a pass: a pair whose later
// send recorded no pause or interval (an attempt admitted before 0237, a
// legacy row without its pause), one whose later send was never recorded and
// is not proven by its admission, one whose two clocks disagree, a route
// audit that read a send this build places on no route. A pair whose later
// send is the legacy engine's is its own policy's, not judged by I19.

/** The slack of a comparison of two recorded wall-clock instants (`sent_at`,
 *  written by the sending process; an admission or an unknown send's bound by
 *  the database): clock slew between two reads, and the millisecond the
 *  instants are rounded to. On production one owner's recorded gap stays
 *  within 1.9 ms of its monotonic one, the route admission keeps ≥ 29 ms over
 *  its interval and a takeover ≥ 65 ms over the pause; a monotonic gap gets no
 *  slack. */
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

/** The instant a pair's later send is judged at: its recorded send, or — never
 *  recorded — its admission. */
export type SendJudgedAt = "send" | "admission";

/** I1 for one gap on one clock: short of the pause. A monotonic gap is exact;
 *  a wall-clock one gets the clock tolerance. */
export function paceGapViolates(gapMs: number, clock: SendGapClock, pauseMs: number): boolean {
  return gapMs < pauseMs - (clock === "wall" ? SEND_AUDIT_CLOCK_TOLERANCE_MS : 0);
}

/** I19 for one pair: the gap is short of the interval its later send was
 *  admitted under (recorded wall clocks: the tolerance applies). */
export function intervalGapViolates(gapMs: number, intervalMs: number): boolean {
  return gapMs < intervalMs - SEND_AUDIT_CLOCK_TOLERANCE_MS;
}

/** What is known of the gap before one send. */
export interface PaceGapEvidence {
  /** The pacer's monotonic gap to its previous actual send; null: the two
   *  sends are not one pacer's (another owner's, the other journal's), or it
   *  recorded none. */
  monoGapMs: number | null;
  /** The gap between the two recorded instants; null: none recorded. */
  wallGapMs: number | null;
  /** The later send's own pause, S × (1 + u). */
  pauseMs: number;
  /** The setting S it was admitted under. */
  settingMs: number | null;
}

export interface PaceGapJudgement {
  /** `clocks_disagree`: the pacer's gap keeps the pause, the recorded instants
   *  are short of it — neither a pass nor a proven violation. */
  verdict: "pass" | "fail" | "clocks_disagree";
  /** The clock the verdict rests on, and the gap on it. */
  clock: SendGapClock;
  gapMs: number;
}

/**
 * I1 for one pair, by both clocks (the capture's alert and the audit judge by
 * this one rule). The pacer's monotonic gap short of the pause fails, exactly.
 * The recorded instants are the independent test: closer than the setting
 * itself they fail whatever the pacer measured (the rule the audit had before
 * it knew the pause — nothing it caught is lost); short of the pause they fail
 * when no monotonic gap vouches for the pair, and leave it `clocks_disagree`
 * when one does. Null: there is no gap to judge.
 */
export function judgePaceGap(evidence: PaceGapEvidence): PaceGapJudgement | null {
  const { monoGapMs, wallGapMs, pauseMs, settingMs } = evidence;
  if (monoGapMs !== null && paceGapViolates(monoGapMs, "monotonic", pauseMs)) {
    return { verdict: "fail", clock: "monotonic", gapMs: monoGapMs };
  }
  if (wallGapMs === null) return monoGapMs === null ? null : { verdict: "pass", clock: "monotonic", gapMs: monoGapMs };
  if (settingMs !== null && paceGapViolates(wallGapMs, "wall", settingMs)) return { verdict: "fail", clock: "wall", gapMs: wallGapMs };
  if (monoGapMs === null) return { verdict: paceGapViolates(wallGapMs, "wall", pauseMs) ? "fail" : "pass", clock: "wall", gapMs: wallGapMs };
  return { verdict: paceGapViolates(wallGapMs, "wall", pauseMs) ? "clocks_disagree" : "pass", clock: "monotonic", gapMs: monoGapMs };
}

function inWindow(ms: number, window: SendAuditWindow): boolean {
  return ms >= window.start.getTime() && (window.until === null || ms < window.until.getTime());
}

/** One row of a journal, placed for the audit. */
interface Placed {
  row: FanslySendAuditRow;
  journal: string;
  /** Its instant as the earlier send of a pair: the recorded send, else its
   *  upper bound. */
  ms: number;
  /** Its instant as the later send of a pair: the recorded send, else its
   *  admission. */
  laterMs: number;
}

function placed(row: FanslySendAuditRow, at: Date): Placed {
  return { row, journal: sendAuditJournalOf(row), ms: at.getTime(), laterMs: (row.sentAt ?? row.admittedAt).getTime() };
}

function byJournalAndRef(a: Placed, b: Placed): number {
  return (a.journal < b.journal ? -1 : a.journal > b.journal ? 1 : 0) || a.row.ref - b.row.ref;
}

function minOf(current: number | null, value: number): number {
  return current === null ? value : Math.min(current, value);
}

// ── I1 ──────────────────────────────────────────────────────────────────────

/** Why a pair of the page's sends could not be judged. */
export type PaceOpenReason =
  /** The later send recorded no pause. */
  | "no_pause"
  /** The later send's instant was never recorded and its admission does not
   *  prove the pause. */
  | "send_not_recorded"
  /** The pacer's monotonic gap keeps the pause, the recorded instants do not. */
  | "clocks_disagree";

/** One pair of adjacent sends of a page. */
export interface PacePair {
  journal: string;
  ref: number;
  /** The later send's instant: its recorded send, or — never recorded — its
   *  admission (`judgedAt`). */
  sentAt: Date;
  judgedAt: SendJudgedAt;
  prevJournal: string;
  prevRef: number;
  /** The earlier send's instant: its recorded send, or — never recorded — its
   *  upper bound. */
  prevSentAt: Date;
  /** The gap the verdict rests on, on `clock`. */
  gapMs: number;
  clock: SendGapClock;
  /** The gap between the two instants above (`gapMs` itself on the wall clock). */
  wallGapMs: number;
  /** The later send's recorded pause; null: none recorded. */
  pauseMs: number | null;
  /** An inconclusive pair: why. Null: the pair was judged. */
  open: PaceOpenReason | null;
}

export interface PaceAudit {
  verdict: SendAuditVerdict;
  /** Pairs judged against a recorded pause. */
  pairs: number;
  violations: PacePair[];
  /** Pairs that could not be judged (`open` says why). */
  inconclusive: PacePair[];
  /** The shortest gap between two recorded sends, and the shortest across
   *  the two journals. */
  minGapMs: number | null;
  minCrossJournalGapMs: number | null;
  /** The smallest gap − pause of a judged pair. */
  minMarginMs: number | null;
}

/**
 * I1 over the page's sends of both journals, in send order: every pair whose
 * later send lies in `window`, by `judgePaceGap`. The monotonic gap is the
 * engine's when both sends are one owner's (`gap_prev_ms`: to its pacer's
 * previous actual send — the recorded one, or a later one never recorded,
 * which only makes it shorter). A send never recorded that may have gone out
 * stands at its upper bound, as the takeover floor counts it (`paceFloorFromDb`),
 * and is judged at its admission.
 */
export function auditPagePace(rows: readonly FanslySendAuditRow[], window: SendAuditWindow): PaceAudit {
  const sends: Placed[] = rows
    .flatMap((row) => {
      const at = row.sentAt ?? row.countedAt;
      return at === null ? [] : [placed(row, at)];
    })
    .sort((a, b) => a.ms - b.ms || byJournalAndRef(a, b));
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
    if (!inWindow(later.laterMs, window)) continue;
    const prev = sends[index - 1]!;
    const recorded = later.row.sentAt !== null;
    const sameOwner = later.row.journal === "engine" && prev.row.journal === "engine"
      && later.row.ownerGeneration !== null && later.row.ownerGeneration === prev.row.ownerGeneration;
    const wallGapMs = later.laterMs - prev.ms;
    const pair: PacePair = {
      journal: later.journal,
      ref: later.row.ref,
      sentAt: new Date(later.laterMs),
      judgedAt: recorded ? "send" : "admission",
      prevJournal: prev.journal,
      prevRef: prev.row.ref,
      prevSentAt: new Date(prev.ms),
      gapMs: wallGapMs,
      clock: "wall",
      wallGapMs,
      pauseMs: later.row.pauseMs,
      open: null,
    };
    const judged = pair.pauseMs === null ? null : judgePaceGap({
      // (A send never recorded left no monotonic gap either.)
      monoGapMs: recorded && sameOwner ? later.row.gapPrevMs : null,
      wallGapMs,
      pauseMs: pair.pauseMs,
      settingMs: later.row.settingMs,
    });
    if (judged !== null) {
      pair.gapMs = judged.gapMs;
      pair.clock = judged.clock;
    }
    if (recorded) {
      audit.minGapMs = minOf(audit.minGapMs, pair.gapMs);
      if (pair.journal !== pair.prevJournal) audit.minCrossJournalGapMs = minOf(audit.minCrossJournalGapMs, pair.gapMs);
    }
    pair.open = judged === null
      ? "no_pause"
      // Its admission is the earliest it can have left: short of the pause
      // there, only its send instant could tell — and nobody recorded it.
      : !recorded && judged.verdict !== "pass" ? "send_not_recorded"
        : judged.verdict === "clocks_disagree" ? "clocks_disagree" : null;
    if (pair.open !== null) {
      audit.inconclusive.push(pair);
      continue;
    }
    audit.pairs += 1;
    audit.minMarginMs = minOf(audit.minMarginMs, pair.gapMs - pair.pauseMs!);
    if (judged!.verdict === "fail") audit.violations.push(pair);
  }
  audit.verdict = audit.violations.length > 0 ? "fail" : audit.inconclusive.length > 0 ? "inconclusive" : "pass";
  return audit;
}

// ── I19 ─────────────────────────────────────────────────────────────────────

export type IntervalScopeKind = "route" | "family";

/** Why an admission could not be judged against its route (or family). */
export type IntervalOpenReason =
  /** Its admission recorded no interval. */
  | "no_interval"
  /** Its send instant was never recorded and its admission does not prove the
   *  interval. */
  | "send_not_recorded";

/** One engine admission of a route (or a family) and the newest send its
 *  clock counted before it. */
export interface IntervalPair {
  kind: IntervalScopeKind;
  /** The canonical route, or the family. */
  scope: string;
  journal: string;
  ref: number;
  /** The later send's instant: its recorded send, or — never recorded — its
   *  admission (`judgedAt`). */
  at: Date;
  judgedAt: SendJudgedAt;
  prevJournal: string;
  prevRef: number;
  /** The earlier send's instant: its recorded send, or its upper bound. */
  prevAt: Date;
  gapMs: number;
  /** The interval the later send's admission recorded; null: none recorded
   *  (an attempt before 0237; a family interval the admitting build did not
   *  apply to a route this build places in a family). */
  intervalMs: number | null;
  /** An inconclusive pair: why. Null: the pair was judged. */
  open: IntervalOpenReason | null;
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
  /** The shortest gap before a recorded send. */
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
  /** Pairs that could not be judged (`open` says why). */
  inconclusive: IntervalPair[];
  /** Sends this build places on no route (the admission counted them on
   *  every route): `sends` within the window, `before` it. */
  unplaced: Array<{ journal: string; operation: string; sends: number; before: number }>;
  /** Per route and family with a send in the window, routes first. */
  scopes: IntervalScopeSummary[];
}

/** The canonical route of a journal row; null: this build places it on none. */
export function sendAuditRouteOf(row: Pick<FanslySendAuditRow, "journal" | "operation">): FanslyRoute | null {
  return row.journal === "engine" ? routeOfEngineOperation(row.operation) : routeOfLegacyOperation(row.operation);
}

/**
 * I19 over the page's sends as the route clocks count them, per (page,
 * canonical route) and per (page, family): every engine admission whose send
 * lies in `window` — in admission order, as the route check met them —
 * against the newest send counted before it and the interval it recorded; and
 * every interval an admission of the window recorded against the ceiling's.
 * A send admitted after it is not its predecessor, wherever its upper bound
 * puts it.
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
    const send = placed(row, row.countedAt);
    const route = sendAuditRouteOf(row);
    if (route === null) {
      const key = `${send.journal}\u0000${row.operation}`;
      const entry = unplaced.get(key) ?? { journal: send.journal, operation: row.operation, sends: 0, before: 0 };
      if (inWindow(send.laterMs, window)) entry.sends += 1;
      else entry.before += 1;
      unplaced.set(key, entry);
      continue;
    }
    const family = familyOfRoute(route);
    add("route", route, send);
    if (family !== null) add("family", family, send);
    if (row.journal !== "engine" || !inWindow(send.laterMs, window)) continue;
    // The independent bound: no admission may apply an interval shorter than
    // the ceiling's, whatever slowdown or calibration chose it.
    const at = new Date(send.laterMs);
    const routeCeilingMs = intervalMsOf(routeBudget(route).ceilingPerMin);
    if (row.routeIntervalMs !== null && row.routeIntervalMs < routeCeilingMs) {
      ceiling.push({ kind: "route", scope: route, ref: row.ref, at, intervalMs: row.routeIntervalMs, ceilingIntervalMs: routeCeilingMs });
    }
    if (family !== null && row.familyIntervalMs !== null) {
      const familyCeilingMs = intervalMsOf(FAMILY_BUDGETS[family].ceilingPerMin);
      if (row.familyIntervalMs < familyCeilingMs) {
        ceiling.push({ kind: "family", scope: family, ref: row.ref, at, intervalMs: row.familyIntervalMs, ceilingIntervalMs: familyCeilingMs });
      }
    }
  }

  const violations: IntervalPair[] = [];
  const inconclusive: IntervalPair[] = [];
  const scopes: IntervalScopeSummary[] = [];
  let pairs = 0;
  for (const group of groups.values()) {
    const sends = group.sends.sort((a, b) => a.row.admittedAt.getTime() - b.row.admittedAt.getTime() || byJournalAndRef(a, b));
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
    // The scope's clock as each admission read it: the newest send counted
    // among those admitted before it.
    let prev: Placed | null = null;
    for (const later of sends) {
      const clock = prev;
      if (prev === null || later.ms >= prev.ms) prev = later;
      if (!inWindow(later.laterMs, window)) continue;
      summary.sends += 1;
      if (clock === null || later.row.journal !== "engine") continue;
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
        at: new Date(later.laterMs),
        judgedAt: later.row.sentAt === null ? "admission" : "send",
        prevJournal: clock.journal,
        prevRef: clock.row.ref,
        prevAt: new Date(clock.ms),
        gapMs: later.laterMs - clock.ms,
        intervalMs: recorded,
        open: null,
      };
      const short = pair.intervalMs !== null && intervalGapViolates(pair.gapMs, pair.intervalMs);
      // A send never recorded, admitted before its clock opened: it may still
      // have left late enough — only its send instant could tell.
      pair.open = pair.intervalMs === null ? "no_interval" : short && pair.judgedAt === "admission" ? "send_not_recorded" : null;
      if (pair.judgedAt === "send") summary.minGapMs = minOf(summary.minGapMs, pair.gapMs);
      if (pair.open !== null) {
        summary.inconclusive += 1;
        inconclusive.push(pair);
        continue;
      }
      pairs += 1;
      summary.pairs += 1;
      summary.minMarginMs = minOf(summary.minMarginMs, pair.gapMs - pair.intervalMs!);
      if (short) {
        summary.violations += 1;
        if (summary.firstViolationAt === null || pair.at.getTime() < summary.firstViolationAt.getTime()) summary.firstViolationAt = pair.at;
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
