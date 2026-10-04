import { describe, expect, it } from "vitest";

import type { FanslySendAuditRow } from "@agency_hub_core/db";

import {
  auditPagePace,
  auditRouteIntervals,
  intervalGapViolates,
  judgePaceGap,
  paceGapViolates,
  SEND_AUDIT_CLOCK_TOLERANCE_MS,
  sendAuditJournalOf,
  type SendAuditWindow,
} from "../apps/runtime/src/sync/engine/send-audit.ts";
import { RouteClocks, EMPTY_ROUTE_STATE } from "../apps/runtime/src/sync/engine/route-policy.ts";
import { FAMILY_BUDGETS, intervalMsOf, routeBudget } from "../apps/runtime/src/sync/fansly/routes.ts";

// The send audit (invariants I1 and I19; arena 3b-review G1), pure: the one
// checker of the alert evaluator, `sync check live-hour` and the shadow report.
// I1 by each send's own recorded pause — on the recorded instants and, one
// owner's pair, on its pacer's monotonic gap too — I19 by each admission's
// recorded route and family intervals over adjacent pairs — with the arena's
// two counterexamples the earlier checks passed — the independent ceiling
// bound, and a send whose instant was never recorded: at its upper bound as
// the earlier send of a pair, at its admission as the later one.

const T0 = Date.parse("2026-10-03T10:00:00.000Z");
const at = (seconds: number) => new Date(T0 + seconds * 1_000);
const WINDOW: SendAuditWindow = { start: at(0), until: at(3_600) };

let ref = 0;
/** A recorded engine send `seconds` after T0, admitted 50 ms before it. */
function engine(seconds: number, operation: string, overrides: Partial<FanslySendAuditRow> = {}): FanslySendAuditRow {
  ref += 1;
  return {
    journal: "engine",
    shadow: false,
    source: null,
    ref,
    operation,
    ownerGeneration: 1n,
    admittedAt: at(seconds - 0.05),
    sentAt: at(seconds),
    countedAt: at(seconds),
    settingMs: 2_500,
    pauseMs: 2_500,
    gapPrevMs: null,
    routeIntervalMs: 4_000,
    familyIntervalMs: null,
    httpStatus: 200,
    completedAt: at(seconds + 0.3),
    ...overrides,
  };
}

/** An engine attempt admitted `seconds` after T0 whose send instant was never
 *  recorded (in flight, or left by a killed process): it may have gone out
 *  anywhere up to its admission + the 15 s send window. */
function unrecorded(seconds: number, operation: string, overrides: Partial<FanslySendAuditRow> = {}): FanslySendAuditRow {
  return engine(seconds, operation, {
    admittedAt: at(seconds), sentAt: null, countedAt: at(seconds + 15), httpStatus: null, completedAt: null, ...overrides,
  });
}

/** A legacy send log row `seconds` after T0. */
function legacy(seconds: number, operation: string, overrides: Partial<FanslySendAuditRow> = {}): FanslySendAuditRow {
  return engine(seconds, operation, {
    journal: "legacy",
    source: "sync_stream",
    ownerGeneration: null,
    routeIntervalMs: null,
    familyIntervalMs: null,
    ...overrides,
  });
}

/** `count` sends of `operation` every `everySeconds` from `fromSeconds`. */
function stream(operation: string, fromSeconds: number, everySeconds: number, count: number, overrides: Partial<FanslySendAuditRow> = {}): FanslySendAuditRow[] {
  return Array.from({ length: count }, (_, index) => engine(fromSeconds + index * everySeconds, operation, overrides));
}

describe("I1: every pair of adjacent sends ≥ the later send's own pause", () => {
  it("the arena's counterexample: S = 2 500, u = 0.1, pause 2 750, a 2 600 ms gap fails (the setting alone passes it)", () => {
    const pair = [engine(10, "notifications.page"), engine(12.6, "notifications.page", { settingMs: 2_500, pauseMs: 2_750, ownerGeneration: 2n })];
    const audit = auditPagePace(pair, WINDOW);
    expect(audit).toMatchObject({ verdict: "fail", pairs: 1, inconclusive: [] });
    expect(audit.violations).toEqual([expect.objectContaining({
      journal: "engine", ref: pair[1]!.ref, prevRef: pair[0]!.ref, gapMs: 2_600, clock: "wall", pauseMs: 2_750,
    })]);
    expect(audit.minMarginMs).toBe(-150);
    // At its pause it passes.
    expect(auditPagePace([pair[0]!, { ...pair[1]!, sentAt: at(12.75) }], WINDOW).verdict).toBe("pass");
  });

  it("measures one owner's pair on the monotonic clock it recorded, exactly; another owner's on the wall clocks, with the tolerance", () => {
    // The wall clocks say 2.8 s, the pacer's monotonic clock 2 600 ms: the monotonic gap is the send's.
    const mono = [engine(10, "notifications.page"), engine(12.8, "notifications.page", { pauseMs: 2_750, gapPrevMs: 2_600 })];
    expect(auditPagePace(mono, WINDOW).violations).toEqual([expect.objectContaining({ gapMs: 2_600, clock: "monotonic", wallGapMs: 2_800 })]);
    // One millisecond short on the monotonic clock fails; on the wall clocks it is within the tolerance.
    expect(auditPagePace([mono[0]!, { ...mono[1]!, gapPrevMs: 2_749 }], WINDOW).verdict).toBe("fail");
    const otherOwner = { ...mono[1]!, ownerGeneration: 2n, gapPrevMs: null };
    expect(auditPagePace([mono[0]!, { ...otherOwner, sentAt: at(12.749) }], WINDOW).verdict).toBe("pass");
    expect(auditPagePace([mono[0]!, { ...otherOwner, sentAt: at(12.747) }], WINDOW).verdict).toBe("fail");
    // A monotonic gap recorded by another owner's pacer is not to this predecessor: the wall clocks judge.
    expect(auditPagePace([mono[0]!, { ...mono[1]!, ownerGeneration: 2n, gapPrevMs: 2_600 }], WINDOW))
      .toMatchObject({ verdict: "pass", violations: [] });
    expect(paceGapViolates(2_749, "monotonic", 2_750)).toBe(true);
    expect(paceGapViolates(2_750 - SEND_AUDIT_CLOCK_TOLERANCE_MS, "wall", 2_750)).toBe(false);
  });

  it("the arena's counterexample as ONE owner journals it: the pacer's own gap says 2 750, the recorded sends are 2 600 ms apart — never a pass", () => {
    // The pacer refuses a send on the same number it then records, so
    // `gap_prev_ms` is never short of the pause while the pacer remembers the
    // right previous send; the recorded instants are the independent witness.
    const pair = [engine(10, "notifications.page"), engine(12.6, "notifications.page", { pauseMs: 2_750, gapPrevMs: 2_750 })];
    const audit = auditPagePace(pair, WINDOW);
    expect(audit).toMatchObject({ verdict: "inconclusive", pairs: 0, violations: [] });
    expect(audit.inconclusive).toEqual([expect.objectContaining({
      ref: pair[1]!.ref, open: "clocks_disagree", clock: "monotonic", gapMs: 2_750, wallGapMs: 2_600, pauseMs: 2_750,
    })]);
    // Within the clock tolerance the two clocks agree: a pass, on the monotonic gap.
    expect(auditPagePace([pair[0]!, { ...pair[1]!, sentAt: at(12.749) }], WINDOW))
      .toMatchObject({ verdict: "pass", pairs: 1, minGapMs: 2_750, minMarginMs: 0 });
  });

  it("one owner's sends closer than the setting itself on the recorded clocks fail, whatever its pacer recorded (the rule before the pause was known)", () => {
    // A pacer that remembers a stale previous send: 1 000 / 1 750 / 1 000 ms
    // apart on `sent_at`, each recording a monotonic gap of 2 750.
    const stale = { pauseMs: 2_750, gapPrevMs: 2_750 };
    const rows = [
      engine(10, "notifications.page"), engine(11, "transactions.page", stale),
      engine(12.75, "notifications.page", stale), engine(13.75, "transactions.page", stale),
    ];
    const audit = auditPagePace(rows, WINDOW);
    expect(audit).toMatchObject({ verdict: "fail", pairs: 3, inconclusive: [], minGapMs: 1_000 });
    expect(audit.violations.map((pair) => [pair.gapMs, pair.clock])).toEqual([[1_000, "wall"], [1_750, "wall"], [1_000, "wall"]]);
    // The one rule, as the capture applies it to the send it just made.
    expect(judgePaceGap({ monoGapMs: 2_750, wallGapMs: 1_000, pauseMs: 2_750, settingMs: 2_500 })).toEqual({ verdict: "fail", clock: "wall", gapMs: 1_000 });
    expect(judgePaceGap({ monoGapMs: 2_750, wallGapMs: 2_600, pauseMs: 2_750, settingMs: 2_500 })).toMatchObject({ verdict: "clocks_disagree" });
    expect(judgePaceGap({ monoGapMs: 2_600, wallGapMs: 2_800, pauseMs: 2_750, settingMs: 2_500 })).toEqual({ verdict: "fail", clock: "monotonic", gapMs: 2_600 });
    expect(judgePaceGap({ monoGapMs: null, wallGapMs: 2_600, pauseMs: 2_750, settingMs: 2_500 })).toEqual({ verdict: "fail", clock: "wall", gapMs: 2_600 });
    expect(judgePaceGap({ monoGapMs: 2_751, wallGapMs: 2_750, pauseMs: 2_750, settingMs: 2_500 })).toEqual({ verdict: "pass", clock: "monotonic", gapMs: 2_751 });
    expect(judgePaceGap({ monoGapMs: null, wallGapMs: null, pauseMs: 2_750, settingMs: 2_500 })).toBeNull();
  });

  it("judges a pair straddling the handover across the journals, and a legacy send by its own recorded pause", () => {
    const rows = [legacy(10, "messages", { pauseMs: 2_400 }), engine(12.2, "messages.page", { pauseMs: 2_500, gapPrevMs: null })];
    const audit = auditPagePace(rows, WINDOW);
    expect(audit.violations).toEqual([expect.objectContaining({ journal: "engine", prevJournal: "legacy:sync_stream", clock: "wall" })]);
    expect(audit.minCrossJournalGapMs).toBe(2_200);
    expect(sendAuditJournalOf(rows[0]!)).toBe("legacy:sync_stream");
    expect(auditPagePace([engine(10, "messages.page"), legacy(12.3, "messages", { pauseMs: 2_400 })], WINDOW).verdict).toBe("fail");
  });

  it("a pair whose later send recorded no pause is inconclusive, never a pass; a send provably never made is no pair", () => {
    const rows = [engine(10, "notifications.page"), legacy(20, "messages", { pauseMs: null })];
    expect(auditPagePace(rows, WINDOW)).toMatchObject({
      verdict: "inconclusive", pairs: 0, inconclusive: [expect.objectContaining({ pauseMs: null, open: "no_pause" })],
    });
    const unsent = engine(11, "notifications.page", { sentAt: null, countedAt: null });
    expect(auditPagePace([engine(10, "notifications.page"), unsent, engine(13, "notifications.page")], WINDOW)).toMatchObject({ verdict: "pass", pairs: 1 });
  });

  it("a send never recorded is not dropped: judged at its admission as the later send, counted at its upper bound as the earlier one", () => {
    // A kill -9 with a request in flight: admitted 3 s after the previous
    // send (≥ its pause), its send never marked. Whenever it left, it left
    // after its admission: the pair is proven.
    const left = unrecorded(13, "notifications.page", { pauseMs: 2_750 });
    const before = engine(10, "transactions.page");
    const proven = auditPagePace([before, left], WINDOW);
    expect(proven).toMatchObject({ verdict: "pass", pairs: 1, inconclusive: [] });
    // Admitted 1 s after the previous send: only its send instant could tell,
    // and nobody recorded it — inconclusive, where it used to vanish.
    const early = auditPagePace([before, unrecorded(11, "notifications.page", { pauseMs: 2_750 })], WINDOW);
    expect(early).toMatchObject({ verdict: "inconclusive", pairs: 0, violations: [] });
    expect(early.inconclusive).toEqual([expect.objectContaining({ open: "send_not_recorded", judgedAt: "admission", wallGapMs: 1_000, pauseMs: 2_750 })]);
    // The next owner's first send: the takeover floor counts the unknown one
    // at its upper bound (13 + 15 = 28 s), so 29 s is too close and 31 s is not.
    const takeover = (seconds: number) => engine(seconds, "transactions.page", { ownerGeneration: 2n, pauseMs: 2_750 });
    const close = auditPagePace([before, left, takeover(29)], WINDOW);
    expect(close.violations).toEqual([expect.objectContaining({ prevRef: left.ref, gapMs: 1_000, clock: "wall", judgedAt: "send" })]);
    expect(auditPagePace([before, left, takeover(31)], WINDOW)).toMatchObject({ verdict: "pass", pairs: 2 });
    // Without it the pair would silently be (previous recorded send → next send): 19 s, a pass.
    expect(auditPagePace([before, takeover(29)], WINDOW).verdict).toBe("pass");
  });

  it("the shadow journal's sends are simulated: an attempt without an instant simulated none", () => {
    const shadow = { shadow: true };
    const closed = unrecorded(11, "notifications.page", shadow);
    const rows = [engine(10, "notifications.page", shadow), closed, engine(13, "notifications.page", shadow)];
    expect(auditPagePace(rows, WINDOW)).toMatchObject({ verdict: "pass", pairs: 1, inconclusive: [] });
  });

  it("judges the later sends of the window only; an earlier one is the first one's predecessor", () => {
    const rows = [engine(-5, "notifications.page"), engine(-4, "notifications.page"), engine(-2, "notifications.page")];
    expect(auditPagePace(rows, WINDOW)).toMatchObject({ verdict: "pass", pairs: 0 });
    expect(auditPagePace([...rows, engine(0.4, "notifications.page")], WINDOW).verdict).toBe("fail");
    expect(auditPagePace([engine(3_599, "notifications.page"), engine(3_600.5, "notifications.page")], WINDOW).pairs).toBe(0);
  });
});

describe("I19: every pair of adjacent sends of a route and of a family ≥ the interval the later one was admitted under", () => {
  it("the arena's counterexample: 15 sends 2.8 s apart on a 4 s route fail 14 pairs (no window count catches it)", () => {
    const sends = stream("notifications.page", 100, 2.8, 15);
    // ⌈60 000 / 4 000⌉ + 1 = 16 ≥ the 15 sends in any 60 s span: the old bound passed it.
    expect(sends.filter((send) => send.countedAt!.getTime() - sends[0]!.countedAt!.getTime() < 60_000)).toHaveLength(15);
    const audit = auditRouteIntervals(sends, WINDOW);
    expect(audit).toMatchObject({ verdict: "fail", pairs: 14, ceiling: [], inconclusive: [], unplaced: [] });
    expect(audit.violations).toHaveLength(14);
    expect(audit.violations[0]).toMatchObject({ kind: "route", scope: "notifications.page", intervalMs: 4_000 });
    expect(Math.round(audit.violations[0]!.gapMs)).toBe(2_800);
    expect(audit.scopes).toEqual([expect.objectContaining({ kind: "route", scope: "notifications.page", sends: 15, pairs: 14, violations: 14 })]);
    expect(Math.round(audit.scopes[0]!.minMarginMs!)).toBe(-1_200);
    // At its interval the route passes.
    expect(auditRouteIntervals(stream("notifications.page", 100, 4, 15), WINDOW)).toMatchObject({ verdict: "pass", pairs: 14 });
  });

  it("judges the family on its own: two routes each within theirs, together closer than the family's interval", () => {
    const messaging = { routeIntervalMs: 4_000, familyIntervalMs: 4_000 };
    const sends = [
      ...stream("messages.page", 100, 6, 10, messaging),
      ...stream("group.detail", 103, 6, 10, messaging),
    ];
    const audit = auditRouteIntervals(sends, WINDOW);
    expect(audit.verdict).toBe("fail");
    expect(audit.violations.every((pair) => pair.kind === "family" && pair.scope === "messaging")).toBe(true);
    expect(audit.violations).toHaveLength(19);
    expect(audit.scopes.map((scope) => [scope.kind, scope.scope, scope.violations])).toEqual([
      ["route", "group.detail", 0], ["route", "messages.page", 0], ["family", "messaging", 19],
    ]);
  });

  it("compares the interval the admission recorded: a 429's halved rate binds the sends admitted under it", () => {
    const before = stream("notifications.page", 100, 4, 5);
    const after = stream("notifications.page", 126, 6, 5, { routeIntervalMs: 8_000 });
    const audit = auditRouteIntervals([...before, ...after], WINDOW);
    expect(audit.violations.map((pair) => pair.intervalMs)).toEqual([8_000, 8_000, 8_000, 8_000]);
    expect(auditRouteIntervals([...before, ...stream("notifications.page", 126, 8, 5, { routeIntervalMs: 8_000 })], WINDOW).verdict).toBe("pass");
  });

  it("counts an unknown outcome at its upper bound and a send provably never made not at all, as the admission does", () => {
    // Admitted at 100, never marked: it counts at 115 (admission + the send window).
    const unknown = unrecorded(100, "notifications.page");
    expect(auditRouteIntervals([engine(90, "notifications.page"), unknown, engine(117, "notifications.page")], WINDOW).violations)
      .toEqual([expect.objectContaining({ prevRef: unknown.ref, gapMs: 2_000, judgedAt: "send" })]);
    expect(auditRouteIntervals([engine(90, "notifications.page"), unknown, engine(119, "notifications.page")], WINDOW))
      .toMatchObject({ verdict: "pass", pairs: 2 });
    const neverSent = engine(100, "notifications.page", { sentAt: null, countedAt: null });
    expect(auditRouteIntervals([engine(90, "notifications.page"), neverSent, engine(95, "notifications.page")], WINDOW))
      .toMatchObject({ verdict: "pass", pairs: 1 });
  });

  it("judges a later send that was never recorded at its admission, never at its upper bound", () => {
    // The previous send at 100 s; the next attempt admitted 1 s later on a 4 s
    // route, its send never marked. At its upper bound (116 s) no interval up
    // to 15 s could fail it — a judged pass it never earned. Its admission
    // came before the route opened; when it left, nobody recorded.
    const early = unrecorded(101, "notifications.page");
    const audit = auditRouteIntervals([engine(100, "notifications.page"), early], WINDOW);
    expect(audit).toMatchObject({ verdict: "inconclusive", pairs: 0, violations: [] });
    expect(audit.inconclusive).toEqual([expect.objectContaining({
      ref: early.ref, open: "send_not_recorded", judgedAt: "admission", at: at(101), prevAt: at(100), gapMs: 1_000, intervalMs: 4_000,
    })]);
    expect(audit.scopes).toEqual([expect.objectContaining({ scope: "notifications.page", sends: 2, pairs: 0, inconclusive: 1 })]);
    // Admitted once the route was open: proven, whenever it left.
    expect(auditRouteIntervals([engine(100, "notifications.page"), unrecorded(104, "notifications.page")], WINDOW))
      .toMatchObject({ verdict: "pass", pairs: 1, inconclusive: [] });
    // The family's pair the same way.
    const family = { routeIntervalMs: 4_000, familyIntervalMs: 4_000 };
    expect(auditRouteIntervals([engine(100, "messages.page", family), unrecorded(102, "group.detail", family)], WINDOW).inconclusive)
      .toEqual([expect.objectContaining({ kind: "family", scope: "messaging", open: "send_not_recorded", gapMs: 2_000 })]);
  });

  it("holds an admission to the route's clock as it read it: an unknown send before it counts at its upper bound even when the next one was sent inside it", () => {
    // Admitted at 100 and never marked (counted at 115); the next send of the
    // route went out at 113 — inside the unknown one's window, 2 s before the
    // clock it had to wait an interval after. The earlier send (90 s) is not
    // its predecessor, nor is the unknown one judged against a send admitted
    // after it.
    const unknown = unrecorded(100, "notifications.page");
    const inside = engine(113, "notifications.page");
    const audit = auditRouteIntervals([engine(90, "notifications.page"), unknown, inside], WINDOW);
    expect(audit.violations).toEqual([expect.objectContaining({ ref: inside.ref, prevRef: unknown.ref, prevAt: at(115), gapMs: -2_000 })]);
    expect(audit).toMatchObject({ pairs: 2, inconclusive: [] });
    // A legacy send after the unknown one's admission (a hand-back) is no predecessor of it either.
    const handedBack = auditRouteIntervals([engine(90, "notifications.page"), unknown, legacy(105, "notifications_page")], WINDOW);
    expect(handedBack).toMatchObject({ verdict: "pass", pairs: 1, violations: [] });
  });

  it("takes a legacy send as the predecessor the admission counted, and leaves a legacy later send to the legacy policy", () => {
    const rows = [legacy(-1, "messages"), engine(1.5, "messages.page", { familyIntervalMs: 4_000 })];
    expect(auditRouteIntervals(rows, WINDOW).violations.map((pair) => [pair.kind, pair.prevJournal])).toEqual([
      ["route", "legacy:sync_stream"], ["family", "legacy:sync_stream"],
    ]);
    expect(auditRouteIntervals([engine(1, "messages.page"), legacy(2, "messages")], WINDOW)).toMatchObject({ verdict: "pass", pairs: 0 });
  });

  it("bounds every recorded interval by its ceiling's, whatever the gaps", () => {
    const route = intervalMsOf(routeBudget("notifications.page").ceilingPerMin);
    const audit = auditRouteIntervals(stream("notifications.page", 100, 3.5, 3, { routeIntervalMs: route - 500 }), WINDOW);
    expect(audit.violations).toEqual([]);
    expect(audit.ceiling).toHaveLength(3);
    expect(audit.ceiling[0]).toMatchObject({ kind: "route", scope: "notifications.page", intervalMs: route - 500, ceilingIntervalMs: route });
    expect(audit.verdict).toBe("fail");
    const family = intervalMsOf(FAMILY_BUDGETS.earnings.ceilingPerMin);
    expect(auditRouteIntervals([engine(100, "transactions.page", { familyIntervalMs: family - 1 })], WINDOW).ceiling)
      .toEqual([expect.objectContaining({ kind: "family", scope: "earnings", ceilingIntervalMs: family })]);
  });

  it("a pair without its recorded interval (an attempt before 0237) is inconclusive, never a pass", () => {
    const old = stream("notifications.page", 100, 2.8, 3, { routeIntervalMs: null });
    expect(auditRouteIntervals(old, WINDOW)).toMatchObject({ verdict: "inconclusive", pairs: 0, violations: [] });
    expect(auditRouteIntervals(old, WINDOW).inconclusive.map((pair) => pair.open)).toEqual(["no_interval", "no_interval"]);
    // A family route whose admission recorded no family interval: the family pair is unknown.
    const drift = stream("messages.page", 100, 5, 2, { familyIntervalMs: null });
    expect(auditRouteIntervals(drift, WINDOW)).toMatchObject({
      verdict: "inconclusive", pairs: 1, inconclusive: [expect.objectContaining({ kind: "family", scope: "messaging" })],
    });
  });

  it("a send this build places on no route leaves the audit inconclusive", () => {
    const audit = auditRouteIntervals([engine(-30, "retired.route"), engine(100, "notifications.page"), engine(105, "notifications.page")], WINDOW);
    expect(audit).toMatchObject({ verdict: "inconclusive", pairs: 1, unplaced: [{ journal: "engine", operation: "retired.route", sends: 0, before: 1 }] });
  });

  it("applies the clock tolerance to the recorded wall clocks only", () => {
    expect(intervalGapViolates(4_000 - SEND_AUDIT_CLOCK_TOLERANCE_MS, 4_000)).toBe(false);
    expect(intervalGapViolates(4_000 - SEND_AUDIT_CLOCK_TOLERANCE_MS - 0.1, 4_000)).toBe(true);
  });
});

describe("the intervals an admission records are the ones its route check applies", () => {
  it("records the route's effective interval and its family's, at the slot's clocks", () => {
    const clocks = new RouteClocks({ sends: [], state: EMPTY_ROUTE_STATE });
    expect(clocks.intervals("messages.page")).toEqual({ routeIntervalMs: 4_000, familyIntervalMs: 4_000 });
    expect(clocks.intervals("media.offer_stats")).toEqual({ routeIntervalMs: 12_000, familyIntervalMs: null });
    expect(clocks.intervals("transactions.page")).toEqual({ routeIntervalMs: 4_000, familyIntervalMs: intervalMsOf(FAMILY_BUDGETS.earnings.currentPerMin) });
    // A 429's slowdown: the route's halved rate is what it records.
    const slowed = new RouteClocks({
      sends: [],
      state: {
        routes: {
          "messages.page": {
            holdUntil: null, ladderStep: 1, effectivePerMin: 7.5, policyVersion: null, last429AttemptId: 7, last429At: at(0).toISOString(), revision: 1,
          },
        },
      },
    });
    expect(slowed.intervals("messages.page")).toEqual({ routeIntervalMs: 8_000, familyIntervalMs: 4_000 });
    // The route check opens exactly one recorded interval after the last send.
    const last = new RouteClocks({ sends: [{ journal: "engine", operation: "notifications.page", lastAt: at(100) }], state: EMPTY_ROUTE_STATE });
    expect(last.notBefore("notifications.page")).toEqual(new Date(at(100).getTime() + last.intervals("notifications.page").routeIntervalMs));
  });
});
