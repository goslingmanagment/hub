import { describe, expect, it } from "vitest";

import { acceptanceExitCode } from "../apps/runtime/src/sync/switch/acceptance.ts";
import {
  acceptanceRouteOf,
  acceptanceWindows,
  authRefusalsCheck,
  budgetBound,
  judgedByRouteRule,
  latencyCheck,
  mediaStartCheck,
  mismatchCheck,
  pageHoldCheck,
  pageVerdict,
  percentileCont,
  route429Check,
  route429Outcomes,
  routeBudgetViolations,
  slowedRatePerMin,
  type AcceptanceCheck,
  type AcceptanceJournalRow,
  type AcceptanceWindow,
} from "../apps/runtime/src/sync/switch/acceptance-rules.ts";

// The live-hour acceptance's rules (step 3b ruling 13, A1 §2b, A6), pure:
// the window shared by pages switched together, the budgets of each send,
// the 429s per page+route, 401/403, page holds, the first media request, the
// SLO sample rules and the page verdict. step3-accept.sql implements the
// same (tests/sync-switch-acceptance-sql.test.ts pins its numbers; the shared
// fixtures run both).

const T0 = Date.parse("2026-10-03T10:00:00.000Z");
const at = (seconds: number) => new Date(T0 + seconds * 1_000);

function window(endSeconds = 3_600, nowSeconds = 4_000): AcceptanceWindow {
  return { start: at(0), end: at(endSeconds), observedUntil: at(Math.min(endSeconds, nowSeconds)), now: at(nowSeconds) };
}

let ref = 0;
function send(seconds: number, operation: string, overrides: Partial<AcceptanceJournalRow> = {}): AcceptanceJournalRow {
  ref += 1;
  return {
    journal: "engine",
    ref,
    operation,
    resource: "r",
    at: at(seconds),
    doneAt: at(seconds + 0.3),
    outcome: "response",
    httpStatus: 200,
    retryAfterMs: null,
    errorClass: null,
    ...overrides,
  };
}

/** `count` sends of `operation` every `everySeconds` from `fromSeconds`. */
function stream(operation: string, fromSeconds: number, everySeconds: number, count: number): AcceptanceJournalRow[] {
  return Array.from({ length: count }, (_, index) => send(fromSeconds + index * everySeconds, operation));
}

describe("the shared window", () => {
  it("starts each page at the later of since and its live instant and ends all at T* + 1 h", () => {
    const pages = [
      { pageId: 1, live: true, liveSince: at(-600) },
      { pageId: 2, live: true, liveSince: at(30) },
      { pageId: 3, live: true, liveSince: at(95) },
      { pageId: 4, live: false, liveSince: at(500) },
    ];
    const { tStar, end, windows } = acceptanceWindows(pages, { since: at(0), until: null, now: at(1_000) });
    expect(windows.get(1)!.start).toEqual(at(0));
    expect(windows.get(2)!.start).toEqual(at(30));
    expect(windows.get(3)!.start).toEqual(at(95));
    // Not live: its window starts at since (its live check fails).
    expect(windows.get(4)!.start).toEqual(at(0));
    expect(tStar).toEqual(at(95));
    expect(end).toEqual(at(95 + 3_600));
    expect(windows.get(1)!.observedUntil).toEqual(at(1_000));
    const fixed = acceptanceWindows(pages, { since: at(0), until: at(900), now: at(5_000) });
    expect(fixed.end).toEqual(at(900));
    expect(fixed.windows.get(2)!.observedUntil).toEqual(at(900));
  });
});

describe("canonical routes of the journals", () => {
  it("maps an engine wire id to itself, a legacy operation through the pinned map, and keeps an unknown one apart", () => {
    expect(acceptanceRouteOf("engine", "messages.page")).toBe("messages.page");
    expect(acceptanceRouteOf("legacy", "messages")).toBe("messages.page");
    expect(acceptanceRouteOf("legacy", "ws_connect")).toBe("ws.upgrade");
    expect(acceptanceRouteOf("engine", "earnings.overview")).toBe("unknown:engine:earnings.overview");
    expect(acceptanceRouteOf("legacy", "brand_new_lane")).toBe("unknown:legacy:brand_new_lane");
  });
});

describe("route budgets (§2b: ⌈W/T⌉ + 1 per window W ending at each send)", () => {
  it("bounds each budget by its interval", () => {
    expect(budgetBound(15, 60_000)).toBe(16);
    expect(budgetBound(15, 300_000)).toBe(76);
    expect(budgetBound(12, 60_000)).toBe(13);
    expect(budgetBound(5, 60_000)).toBe(6);
    expect(budgetBound(17, 60_000)).toBe(18);
    expect(slowedRatePerMin("messages.page", 1)).toBe(7.5);
    expect(budgetBound(7.5, 60_000)).toBe(9);
    // The media statistics: 5 → 2.5 → 1.5 (⅛ of the 12/min ceiling) and no lower.
    expect(slowedRatePerMin("media.offer_stats", 1)).toBe(2.5);
    expect(slowedRatePerMin("media.offer_stats", 2)).toBe(1.5);
    expect(slowedRatePerMin("media.offer_stats", 4)).toBe(1.5);
  });

  it("passes a route sent at exactly its interval for the hour", () => {
    expect(routeBudgetViolations(stream("messages.page", 0, 4, 900), window())).toEqual([]);
    expect(routeBudgetViolations(stream("media.offer_stats", 0, 12, 300), window())).toEqual([]);
  });

  it("fails a route sent faster than its budget, and a family over its shared one", () => {
    const fast = routeBudgetViolations(stream("media.offer_stats", 0, 5, 30), window());
    expect(fast[0]).toMatchObject({ kind: "route", scope: "media.offer_stats", windowMs: 60_000, sends: 7, bound: 6 });
    // /message and group detail each at 10/min — together 20/min, over the messaging family's 15.
    const family = routeBudgetViolations([...stream("messages.page", 0, 6, 60), ...stream("group.detail", 3, 6, 60)], window());
    expect(family.length).toBeGreaterThan(0);
    expect(family.every((entry) => entry.kind === "family" && entry.scope === "messaging")).toBe(true);
  });

  it("counts an attempt whose send instant was never recorded at its upper bound, and one never sent not at all", () => {
    // Five media reads 12 s apart, then two more within the minute: the
    // seventh is one too many — when the sixth (an unknown outcome at its
    // upper bound) counts, and only then.
    const base = stream("media.offer_stats", 0, 12, 5);
    const unknown = send(50, "media.offer_stats", { outcome: "unknown", httpStatus: null });
    expect(routeBudgetViolations([...base, unknown, send(55, "media.offer_stats")], window()))
      .toEqual([expect.objectContaining({ kind: "route", windowMs: 60_000, sends: 7, bound: 6, at: at(55) })]);
    const neverSent = send(50, "media.offer_stats", { at: null, outcome: "aborted_before_send", httpStatus: null });
    expect(routeBudgetViolations([...base, neverSent, send(55, "media.offer_stats")], window())).toEqual([]);
  });

  it("judges the sends after a route's 429 at its halved rate, counting from the 429 on", () => {
    // /message at 15/min until a 429 at 120 s, then at 10/min: over 7.5/min.
    const rows = [
      ...stream("messages.page", 0, 4, 30),
      send(120, "messages.page", { httpStatus: 429 }),
      ...stream("messages.page", 126, 6, 40),
    ];
    const violations = routeBudgetViolations(rows, window());
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.every((entry) => entry.kind === "slowdown" && entry.scope === "messages.page")).toBe(true);
    // At 7.5/min after the 429 (8 s): within the halved budget, the full-rate sends before it never count against it.
    const halved = [...stream("messages.page", 0, 4, 30), send(120, "messages.page", { httpStatus: 429 }), ...stream("messages.page", 126, 8, 30)];
    expect(routeBudgetViolations(halved, window())).toEqual([]);
  });

  it("counts only the budget's own sends, from T_i on: what was sent before T_i was paced by another policy", () => {
    // The legacy engine read /message every 2.5 s until 145 s before T_i (and
    // an earlier build the media statistics every 5 s until T_i); the engine
    // then keeps each route's interval from the last of them.
    const before = [
      ...Array.from({ length: 62 }, (_, index) => send(-300 + index * 2.5, "messages", { journal: "legacy" })),
      ...stream("media.offer_stats", -300, 5, 60),
    ];
    const after = [...stream("messages.page", 0, 4, 100), ...stream("media.offer_stats", 12, 12, 30)];
    expect(routeBudgetViolations([...before, ...after], window())).toEqual([]);
    // A route over its budget inside the window still fails, judged at its window sends only.
    const dense = [...before, ...stream("media.offer_stats", 0, 5, 20)];
    const violations = routeBudgetViolations(dense, window());
    expect(violations).not.toEqual([]);
    expect(violations.every((entry) => entry.at.getTime() >= T0 && entry.scope === "media.offer_stats")).toBe(true);
  });
});

describe("429s per page and canonical route (A6)", () => {
  it("recovered: one 429, its hold kept, a later answer on the route — read past the window end", () => {
    const rows = [send(100, "messages.page", { httpStatus: 429, resource: "dm-messages.head" }), send(3_700, "messages.page")];
    const outcomes = route429Outcomes(rows, window(3_600, 4_000));
    expect(outcomes).toEqual([expect.objectContaining({ route: "messages.page", count: 1, state: "recovered" })]);
    expect(route429Check(outcomes)).toMatchObject({ verdict: "pass", detail: { routesWith429: 1 } });
  });

  it("unproven: no answer on the route after the 429 yet", () => {
    const rows = [send(3_500, "messages.page", { httpStatus: 429 }), send(3_550, "group.detail")];
    const outcomes = route429Outcomes(rows, window());
    expect(outcomes[0]!.state).toBe("unproven");
    expect(route429Check(outcomes).verdict).toBe("inconclusive");
  });

  it("repeated: a second 429 on the same page+route, sent for another resource, fails", () => {
    const rows = [
      send(100, "messages.page", { httpStatus: 429, resource: "dm-messages.head" }),
      send(200, "messages.page"),
      send(900, "messages.page", { httpStatus: 429, resource: "dm-messages.history" }),
      send(1_000, "messages.page"),
    ];
    const outcomes = route429Outcomes(rows, window());
    expect(outcomes).toEqual([expect.objectContaining({ route: "messages.page", count: 2, state: "repeated" })]);
    expect(route429Check(outcomes).verdict).toBe("fail");
  });

  it("counts a legacy 429 and a legacy answer on the same canonical route", () => {
    const rows = [
      send(100, "messages", { journal: "legacy", httpStatus: 429 }),
      send(800, "messages.page", { httpStatus: 429 }),
    ];
    expect(route429Outcomes(rows, window())[0]).toMatchObject({ route: "messages.page", count: 2, state: "repeated" });
  });

  it("hold_broken: a send on the route inside its Retry-After (or the 5 s first step) fails", () => {
    const retry = [send(100, "messages.page", { httpStatus: 429, retryAfterMs: 30_000 }), send(120, "messages.page")];
    expect(route429Outcomes(retry, window())[0]!.state).toBe("hold_broken");
    const kept = [send(100, "messages.page", { httpStatus: 429, retryAfterMs: 30_000 }), send(131, "messages.page")];
    expect(route429Outcomes(kept, window())[0]!.state).toBe("recovered");
    const ladder = [send(100, "messages.page", { httpStatus: 429 }), send(104, "messages.page")];
    expect(route429Outcomes(ladder, window())[0]!.state).toBe("hold_broken");
    // Another route inside the hold is the isolation the rule wants.
    const isolated = [send(100, "messages.page", { httpStatus: 429 }), send(102, "transactions.page"), send(110, "messages.page")];
    expect(route429Outcomes(isolated, window())).toEqual([expect.objectContaining({ route: "messages.page", state: "recovered" })]);
  });

  it("keeps two routes apart: one 429 each is two pairs, each judged alone", () => {
    const rows = [
      send(100, "messages.page", { httpStatus: 429 }), send(200, "messages.page"),
      send(300, "media.offer_stats", { httpStatus: 429 }), send(400, "media.offer_stats"),
    ];
    const check = route429Check(route429Outcomes(rows, window()));
    expect(check).toMatchObject({ verdict: "pass", detail: { routesWith429: 2 } });
  });

  it("ignores a 429 outside the window", () => {
    expect(route429Outcomes([send(-30, "messages.page", { httpStatus: 429 })], window())).toEqual([]);
  });
});

describe("401/403 and page holds", () => {
  it("fails on any 401/403 of either journal in the window, a subject's included", () => {
    const rows = [
      send(10, "group.detail", { httpStatus: 403, errorClass: "subject_terminal" }),
      send(20, "account_me", { journal: "legacy", httpStatus: 401 }),
      send(-20, "account.me", { httpStatus: 401 }),
    ];
    const check = authRefusalsCheck(rows, window());
    expect(check).toMatchObject({ verdict: "fail", detail: { refusals: 2 } });
    expect(authRefusalsCheck([send(10, "group.detail")], window()).verdict).toBe("pass");
  });

  const noHold = { holdKind: null, holdSince: null, holdUntil: null };

  it("finds a page hold from an auth or identity answer", () => {
    expect(pageHoldCheck([send(10, "account.me", { errorClass: "identity_mismatch" })], window(), noHold).verdict).toBe("fail");
    expect(pageHoldCheck([send(10, "account.me", { errorClass: "auth", httpStatus: 401 })], window(), noHold).verdict).toBe("fail");
    expect(pageHoldCheck([send(10, "account.me", { errorClass: "rate_limit", httpStatus: 429 })], window(), noHold).verdict).toBe("pass");
  });

  it("finds the network streak that holds the page, from the journal alone", () => {
    const network = (seconds: number) => send(seconds, "messages.page", { outcome: "transport_error", httpStatus: null, errorClass: "network" });
    expect(pageHoldCheck([network(10), network(20), network(30)], window(), noHold))
      .toMatchObject({ verdict: "fail", detail: { networkHolds: 1 } });
    // An answer in between ends the streak; a request never sent leaves it.
    expect(pageHoldCheck([network(10), network(20), send(25, "group.detail"), network(30)], window(), noHold).verdict).toBe("pass");
    const notSent = send(25, "group.detail", { outcome: "transport_error", httpStatus: null, errorClass: "not_sent" });
    expect(pageHoldCheck([network(10), network(20), notSent, network(30)], window(), noHold).verdict).toBe("fail");
    // A streak begun before the window holds the page inside it.
    expect(pageHoldCheck([network(-30), network(-20), network(10)], window(), noHold).verdict).toBe("fail");
    expect(pageHoldCheck([network(-30), network(-20), network(-10)], window(), noHold).verdict).toBe("pass");
  });

  it("finds the page row's hold overlapping the window, not one that ended before it", () => {
    expect(pageHoldCheck([], window(), { holdKind: "network", holdSince: at(-60), holdUntil: at(30) }).verdict).toBe("fail");
    expect(pageHoldCheck([], window(), { holdKind: "rate_limit", holdSince: at(-600), holdUntil: at(-10) }).verdict).toBe("pass");
    expect(pageHoldCheck([], window(3_600, 1_000), { holdKind: "auth", holdSince: at(2_000), holdUntil: at(9_999_999) }).verdict).toBe("pass");
  });
});

describe("the first media request", () => {
  it("passes within 60 s of live, is open later or never, fails when the owner paused the walk", () => {
    expect(mediaStartCheck([send(45, "media.offer_stats")], window(), false))
      .toMatchObject({ verdict: "pass", detail: { firstRequestAfterSeconds: 45 } });
    expect(mediaStartCheck([send(75, "media.offer_stats")], window(), false).verdict).toBe("inconclusive");
    expect(mediaStartCheck([send(10, "messages.page")], window(), false).verdict).toBe("inconclusive");
    expect(mediaStartCheck([], window(), true).verdict).toBe("fail");
    // The legacy journal's media reads are not the engine's start.
    expect(mediaStartCheck([send(10, "media_offer_stats", { journal: "legacy" })], window(), false).verdict).toBe("inconclusive");
  });
});

describe("SLO samples", () => {
  it("interpolates the 95th percentile as percentile_cont does", () => {
    expect(percentileCont([], 0.95)).toBeNull();
    expect(percentileCont([7], 0.95)).toBe(7);
    expect(percentileCont([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95)).toBeCloseTo(9.55, 10);
    expect(percentileCont([10, 1, 5], 0.5)).toBe(5);
  });

  it("judges a p95 from ten samples on; fewer show count and max, inconclusive", () => {
    expect(latencyCheck("slo_confirm", Array(10).fill(20))).toMatchObject({ verdict: "pass", detail: { samples: 10, p95Seconds: 20 } });
    expect(latencyCheck("slo_confirm", [...Array(9).fill(5), 400]).verdict).toBe("fail");
    expect(latencyCheck("slo_confirm", [5, 6, 400])).toEqual({
      name: "slo_confirm", verdict: "inconclusive", detail: { samples: 3, maxSeconds: 400, boundSeconds: 30 },
    });
    expect(latencyCheck("slo_find", []).verdict).toBe("inconclusive");
  });

  it("judges a max bound from one sample on", () => {
    expect(latencyCheck("slo_deletions", [1.2]).verdict).toBe("pass");
    expect(latencyCheck("slo_deletions", [1.2, 5.1]).verdict).toBe("fail");
    expect(latencyCheck("slo_repair", []).verdict).toBe("inconclusive");
  });

  it("allows 0.1 % confirm mismatches", () => {
    expect(mismatchCheck(0, 0).verdict).toBe("inconclusive");
    expect(mismatchCheck(1_000, 1).verdict).toBe("pass");
    expect(mismatchCheck(999, 1).verdict).toBe("fail");
  });
});

describe("the page verdict", () => {
  const check = (name: AcceptanceCheck["name"], verdict: AcceptanceCheck["verdict"], detail: Record<string, unknown> = {}): AcceptanceCheck =>
    ({ name, verdict, detail });

  it("fail > inconclusive > owner_review > accepted_with_route_429 > pass", () => {
    const routes = (count: number) => check("route_429", "pass", { routesWith429: count });
    expect(pageVerdict([check("live", "pass"), routes(0)])).toEqual({ verdict: "pass", reasons: [] });
    expect(pageVerdict([check("live", "pass"), routes(1)])).toEqual({ verdict: "accepted_with_route_429", reasons: [] });
    expect(pageVerdict([check("live", "pass"), routes(2)])).toEqual({ verdict: "owner_review", reasons: [] });
    expect(pageVerdict([check("slo_find", "inconclusive"), routes(2), check("window_complete", "inconclusive")]))
      .toEqual({ verdict: "inconclusive", reasons: ["window_complete", "slo_find"] });
    expect(pageVerdict([check("slo_find", "inconclusive"), check("open_incidents", "fail"), check("auth_refusals", "fail")]))
      .toEqual({ verdict: "fail", reasons: ["auth_refusals", "open_incidents"] });
  });

  it("exits 0 when every page is accepted, 1 when one failed, 2 otherwise", () => {
    const page = (verdict: "pass" | "fail" | "inconclusive" | "owner_review") => ({ verdict }) as never;
    expect(acceptanceExitCode({ accepted: true, pages: [page("pass")] })).toBe(0);
    expect(acceptanceExitCode({ accepted: false, pages: [page("inconclusive"), page("fail")] })).toBe(1);
    expect(acceptanceExitCode({ accepted: false, pages: [page("owner_review")] })).toBe(2);
  });

  it("leaves a rate-limit incident to the route rule", () => {
    expect(judgedByRouteRule("rate_limit")).toBe(true);
    expect(judgedByRouteRule("rate_limit_list")).toBe(true);
    expect(judgedByRouteRule("auth")).toBe(false);
    expect(judgedByRouteRule(null)).toBe(false);
  });
});
