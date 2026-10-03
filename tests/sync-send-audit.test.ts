import { describe, expect, it } from "vitest";

import type { FanslySendAuditRow } from "@agency_hub_core/db";

import {
  auditPagePace,
  auditRouteIntervals,
  intervalGapViolates,
  paceGapViolates,
  SEND_AUDIT_CLOCK_TOLERANCE_MS,
  sendAuditJournalOf,
  type SendAuditWindow,
} from "../apps/runtime/src/sync/engine/send-audit.ts";
import { RouteClocks, EMPTY_ROUTE_STATE } from "../apps/runtime/src/sync/engine/route-policy.ts";
import { FAMILY_BUDGETS, intervalMsOf, routeBudget } from "../apps/runtime/src/sync/fansly/routes.ts";

// The send audit (invariants I1 and I19; arena 3b-review G1), pure: the one
// checker of the alert evaluator, `sync switch check` and the shadow report.
// I1 by each send's own recorded pause, I19 by each admission's recorded
// route and family intervals over adjacent pairs — with the arena's two
// counterexamples the earlier checks passed — and the independent ceiling
// bound.

const T0 = Date.parse("2026-10-03T10:00:00.000Z");
const at = (seconds: number) => new Date(T0 + seconds * 1_000);
const WINDOW: SendAuditWindow = { start: at(0), until: at(3_600) };

let ref = 0;
/** A recorded engine send `seconds` after T0. */
function engine(seconds: number, operation: string, overrides: Partial<FanslySendAuditRow> = {}): FanslySendAuditRow {
  ref += 1;
  return {
    journal: "engine",
    source: null,
    ref,
    operation,
    ownerGeneration: 1n,
    sentAt: at(seconds),
    countedAt: at(seconds),
    settingMs: 2_500,
    pauseMs: 2_500,
    gapPrevMs: null,
    routeIntervalMs: 4_000,
    familyIntervalMs: null,
    ...overrides,
  };
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
    expect(auditPagePace(mono, WINDOW).violations).toEqual([expect.objectContaining({ gapMs: 2_600, clock: "monotonic" })]);
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

  it("judges a pair straddling the handover across the journals, and a legacy send by its own recorded pause", () => {
    const rows = [legacy(10, "messages", { pauseMs: 2_400 }), engine(12.2, "messages.page", { pauseMs: 2_500, gapPrevMs: null })];
    const audit = auditPagePace(rows, WINDOW);
    expect(audit.violations).toEqual([expect.objectContaining({ journal: "engine", prevJournal: "legacy:sync_stream", clock: "wall" })]);
    expect(audit.minCrossJournalGapMs).toBe(2_200);
    expect(sendAuditJournalOf(rows[0]!)).toBe("legacy:sync_stream");
    expect(auditPagePace([engine(10, "messages.page"), legacy(12.3, "messages", { pauseMs: 2_400 })], WINDOW).verdict).toBe("fail");
  });

  it("a pair whose later send recorded no pause is inconclusive, never a pass; sends never recorded are not pairs", () => {
    const rows = [engine(10, "notifications.page"), legacy(20, "messages", { pauseMs: null })];
    expect(auditPagePace(rows, WINDOW)).toMatchObject({ verdict: "inconclusive", pairs: 0, inconclusive: [expect.objectContaining({ pauseMs: null })] });
    const unsent = engine(11, "notifications.page", { sentAt: null, countedAt: null });
    expect(auditPagePace([engine(10, "notifications.page"), unsent, engine(13, "notifications.page")], WINDOW)).toMatchObject({ verdict: "pass", pairs: 1 });
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
    const unknown = engine(115, "notifications.page", { sentAt: null });
    expect(auditRouteIntervals([engine(90, "notifications.page"), unknown, engine(117, "notifications.page")], WINDOW).violations)
      .toEqual([expect.objectContaining({ prevRef: unknown.ref, gapMs: 2_000 })]);
    const neverSent = engine(100, "notifications.page", { sentAt: null, countedAt: null });
    expect(auditRouteIntervals([engine(90, "notifications.page"), neverSent, engine(95, "notifications.page")], WINDOW))
      .toMatchObject({ verdict: "pass", pairs: 1 });
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
    expect(auditRouteIntervals(old, WINDOW).inconclusive).toHaveLength(2);
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
        version: 1,
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
