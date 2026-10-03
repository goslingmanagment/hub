import { describe, expect, it } from "vitest";

import type { FanslySendAuditRow } from "@agency_hub_core/db";

import { acceptanceExitCode } from "../apps/runtime/src/sync/switch/acceptance.ts";
import {
  acceptanceIncidentKeys,
  acceptanceRouteOf,
  acceptanceWindows,
  authRefusalsCheck,
  judgedByRouteRule,
  latencyCheck,
  mediaStartCheck,
  mismatchCheck,
  paceCombinedCheck,
  pageHoldCheck,
  pageStopSeenUntil,
  pageVerdict,
  percentileCont,
  route429Check,
  route429Outcomes,
  routeBudgetsCheck,
  type AcceptanceCheck,
  type AcceptanceJournalRow,
  type AcceptanceWindow,
  type PageStopEpisode,
} from "../apps/runtime/src/sync/switch/acceptance-rules.ts";

// The live-hour acceptance's rules (step 3b ruling 13, A1 §2b, A6), pure:
// the window shared by pages switched together, the pace and the route
// budgets (the send audit's: tests/sync-send-audit.test.ts has its rules),
// the 429s per page+route, 401/403, page holds, the first media request, the
// SLO sample rules and the page verdict.

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

/** One recorded engine send of the send audit, `seconds` after T0. */
function audited(seconds: number, operation: string, overrides: Partial<FanslySendAuditRow> = {}): FanslySendAuditRow {
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
    pauseMs: 2_750,
    gapPrevMs: null,
    routeIntervalMs: 4_000,
    familyIntervalMs: null,
    ...overrides,
  };
}

describe("the pace and the route budgets: the send audit's verdicts", () => {
  it("pace_combined: a pair short of the later send's own pause fails, though not of the setting", () => {
    const check = paceCombinedCheck([audited(10, "notifications.page"), audited(12.6, "notifications.page")], window());
    expect(check).toMatchObject({
      name: "pace_combined",
      verdict: "fail",
      detail: { pairs: 1, violations: 1, inconclusive: 0, firstViolations: [expect.objectContaining({ gapMs: 2_600, pauseMs: 2_750, clock: "wall" })] },
    });
    expect(paceCombinedCheck([audited(10, "notifications.page"), audited(12.75, "notifications.page")], window()).verdict).toBe("pass");
  });

  it("route_budgets: 15 sends 2.8 s apart on a 4 s route fail, though no 60 s span holds more than ⌈60/4⌉ + 1", () => {
    const sends = Array.from({ length: 15 }, (_, index) => audited(100 + index * 2.8, "notifications.page"));
    const check = routeBudgetsCheck(sends, window());
    expect(check).toMatchObject({ name: "route_budgets", verdict: "fail", detail: { pairs: 14, violations: 14, inconclusive: 0 } });
    expect(check.detail.scopes).toEqual([expect.objectContaining({ kind: "route", scope: "notifications.page", sends: 15, violations: 14 })]);
    expect(routeBudgetsCheck(sends.map((send, index) => ({ ...send, countedAt: at(100 + index * 4) })), window()).verdict).toBe("pass");
  });

  it("route_budgets: an attempt admitted before the intervals were recorded is inconclusive, never a pass", () => {
    const sends = [audited(100, "notifications.page"), audited(110, "notifications.page", { routeIntervalMs: null })];
    expect(routeBudgetsCheck(sends, window())).toMatchObject({ verdict: "inconclusive", detail: { pairs: 0, inconclusive: 1 } });
  });

  it("judges only the window's later sends: a pair ending before T_i is context", () => {
    const sends = [audited(-10, "notifications.page"), audited(-8, "notifications.page"), audited(10, "notifications.page")];
    expect(routeBudgetsCheck(sends, window())).toMatchObject({ verdict: "pass", detail: { pairs: 1 } });
    expect(paceCombinedCheck(sends, window())).toMatchObject({ verdict: "pass", detail: { pairs: 1 } });
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
    expect(pageHoldCheck([send(10, "account.me", { errorClass: "identity_mismatch" })], window(), noHold, []).verdict).toBe("fail");
    expect(pageHoldCheck([send(10, "account.me", { errorClass: "auth", httpStatus: 401 })], window(), noHold, []).verdict).toBe("fail");
  });

  const episode = (openedS: number, resolvedS: number | null, lastSeenS: number | null = null, detail: string | null = null): PageStopEpisode => ({
    openedAt: at(openedS),
    resolvedAt: resolvedS === null ? null : at(resolvedS),
    lastSeenAt: lastSeenS === null ? null : at(lastSeenS),
    detail,
  });

  it("leaves a 429 that held only its route to the route rule, and fails one that stopped the page (alert 1, resolved since)", () => {
    const rate429 = [send(10, "messages.page", { errorClass: "rate_limit", httpStatus: 429 }), send(40, "messages.page")];
    expect(pageHoldCheck(rate429, window(), noHold, []).verdict).toBe("pass");
    // The 429 held the page: `page_stopped` (`rate_limit`) opened with it and
    // resolved 10 clean minutes after the hold ended; the row's hold is cleared.
    const stopped = pageHoldCheck(rate429, window(), noHold, [episode(10.3, 625, null, "rate_limit")]);
    expect(stopped).toMatchObject({
      verdict: "fail",
      detail: { stopped: [{ openedAt: at(10.3).toISOString(), seenUntil: at(25).toISOString(), resolvedAt: at(625).toISOString(), detail: "rate_limit" }] },
    });
  });

  it("judges an alert 1 episode by when its stop was last seen, inside the window or not", () => {
    // Open: seen until its last sighting.
    expect(pageStopSeenUntil(episode(100, null, 400))).toEqual(at(400));
    // Resolved: 10 clean minutes before its resolve, never before it opened.
    expect(pageStopSeenUntil(episode(100, 1_000))).toEqual(at(400));
    expect(pageStopSeenUntil(episode(100, 300))).toEqual(at(100));
    // An earlier episode the sweep never saw resolve: at its opening.
    expect(pageStopSeenUntil(episode(100, null))).toEqual(at(100));
    const judged = (stop: PageStopEpisode, w = window()) => pageHoldCheck([], w, noHold, [stop]).verdict;
    // A stop that ended 5 min before T_i, its latch resolved in the window's first minutes: not the window's.
    expect(judged(episode(-1_200, 300))).toBe("pass");
    // Begun before T_i and still seen after it; seen inside; still open now.
    expect(judged(episode(-1_200, 700))).toBe("fail");
    expect(judged(episode(1_200, 1_860))).toBe("fail");
    expect(judged(episode(3_000, null, 3_990))).toBe("fail");
    // Opened after the window's end (or after now, for an open window).
    expect(judged(episode(3_660, 4_000))).toBe("pass");
    expect(judged(episode(1_200, 1_860), window(3_600, 1_000))).toBe("pass");
  });

  it("finds the network streak that holds the page, from the journal alone", () => {
    const network = (seconds: number) => send(seconds, "messages.page", { outcome: "transport_error", httpStatus: null, errorClass: "network" });
    expect(pageHoldCheck([network(10), network(20), network(30)], window(), noHold, []))
      .toMatchObject({ verdict: "fail", detail: { networkHolds: 1 } });
    // An answer in between ends the streak; a request never sent leaves it.
    expect(pageHoldCheck([network(10), network(20), send(25, "group.detail"), network(30)], window(), noHold, []).verdict).toBe("pass");
    const notSent = send(25, "group.detail", { outcome: "transport_error", httpStatus: null, errorClass: "not_sent" });
    expect(pageHoldCheck([network(10), network(20), notSent, network(30)], window(), noHold, []).verdict).toBe("fail");
    // A streak begun before the window holds the page inside it.
    expect(pageHoldCheck([network(-30), network(-20), network(10)], window(), noHold, []).verdict).toBe("fail");
    expect(pageHoldCheck([network(-30), network(-20), network(-10)], window(), noHold, []).verdict).toBe("pass");
  });

  it("finds the page row's hold overlapping the window, not one that ended before it", () => {
    expect(pageHoldCheck([], window(), { holdKind: "network", holdSince: at(-60), holdUntil: at(30) }, []).verdict).toBe("fail");
    expect(pageHoldCheck([], window(), { holdKind: "rate_limit", holdSince: at(-600), holdUntil: at(-10) }, []).verdict).toBe("pass");
    expect(pageHoldCheck([], window(3_600, 1_000), { holdKind: "auth", holdSince: at(2_000), holdUntil: at(9_999_999) }, []).verdict).toBe("pass");
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

  it("leaves the page's route incidents to the route rule by their key, whatever their code; alert 1 never", () => {
    expect(acceptanceIncidentKeys(7)).toEqual({
      pageStopped: "fansly_sync_engine:7:page_stopped",
      routePrefix: "fansly_sync_engine:7:route_limited:",
    });
    // PR 1-2's latch: opened `rate_limit` (`unavailable` for a 503 naming its
    // Retry-After), refreshed `route_held` while the route is held.
    expect(judgedByRouteRule(7, "fansly_sync_engine:7:route_limited:messages.page")).toBe(true);
    // A 429 that stopped the page is alert 1's, code `rate_limit` or not.
    expect(judgedByRouteRule(7, "fansly_sync_engine:7:page_stopped")).toBe(false);
    expect(judgedByRouteRule(7, "fansly_sync_engine:7:page_stopped:pace_violation")).toBe(false);
    expect(judgedByRouteRule(7, "fansly_sync_engine:8:route_limited:messages.page")).toBe(false);
    expect(judgedByRouteRule(7, "fansly_sync_engine:7:route_limited:")).toBe(false);
    expect(judgedByRouteRule(7, "stream_failed_threshold:7:dm_conversations")).toBe(false);
  });
});
