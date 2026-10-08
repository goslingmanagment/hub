import { describe, expect, it } from "vitest";

import type { LinkStatSeriesHealthRow } from "@agency_hub_core/db";

import {
  incidentKey,
  incidentTitleForKind,
  openMessageForIncident,
  parseIncidentSubKey,
  resolveMessageForIncident,
} from "../apps/runtime/src/services/notification-incidents.ts";
import {
  decideNotificationPaging,
  notificationPagingPolicyFor,
  type NotificationPagingObservation,
} from "../apps/runtime/src/services/notification-paging-policy.ts";
import {
  closedLinkStatWindowsToCheck,
  describeStaleLinkStatPairs,
  findStaleLinkStatPairs,
  firstOfapiLinkStatsWindowAtOrAfter,
  linkStatSeriesAnchor,
  OFAPI_LINK_STATS_SERIES_STALE_AFTER_MS,
} from "../apps/runtime/src/services/ofapi-link-stats-monitor.ts";
import {
  nextOfapiLinkStatsWindowAt,
  OFAPI_LINK_STATS_WINDOW_INTERVAL_MS,
  ofapiLinkStatsWindowAt,
  previousOfapiLinkStatsWindowAt,
} from "../apps/runtime/src/services/ofapi-link-stats-windows.ts";

// Traffic sources plan §2.10: the signals of the OnlyFans link series. The
// decision table is pure and is pinned here without a database.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const T0 = new Date("2026-10-08T10:00:00.000Z");
const at = (offsetMs: number) => new Date(T0.getTime() + offsetMs);
const KIND = "ofapi_link_stats_reconcile_failed" as const;

function observation(overrides: Partial<NotificationPagingObservation> = {}): NotificationPagingObservation {
  return {
    status: "open",
    openedAt: T0,
    resolvedAt: null,
    paging: null,
    episodesInWindow: 1,
    earliestEpisodeInWindowAt: T0,
    manuallyResolvedSincePage: false,
    ...overrides,
  };
}

describe("paging the link series' signals", () => {
  it("a series that is not written pages on the sweep that sees it", () => {
    const policy = notificationPagingPolicyFor(KIND, "series_stale");
    expect(policy.openHoldMs).toBe(0);
    expect(decideNotificationPaging(observation(), policy, at(1_000))).toMatchObject({
      action: "page", mode: "immediate", transitionAt: T0,
    });
  });

  it("a page without a mapping pages after 30 minutes, so the reconciler's 5-minute repair wakes nobody", () => {
    const policy = notificationPagingPolicyFor(KIND, "page_unmapped");
    expect(decideNotificationPaging(observation(), policy, at(5 * MINUTE))).toEqual({ action: "none" });
    expect(decideNotificationPaging(observation(), policy, at(29 * MINUTE))).toEqual({ action: "none" });
    expect(decideNotificationPaging(observation(), policy, at(30 * MINUTE))).toMatchObject({
      action: "page", mode: "sustained",
    });
    // Repaired in time: the episode resolves unpaged and never pages later,
    // however often the reconciler has to repair (no flap rule).
    const repaired = observation({
      status: "resolved", resolvedAt: at(5 * MINUTE), episodesInWindow: 20,
    });
    expect(decideNotificationPaging(repaired, policy, at(2 * HOUR))).toEqual({ action: "none" });
  });

  it("one failed pass is a digest line, and a message only after 30 hours open", () => {
    const policy = notificationPagingPolicyFor(KIND, null);
    expect(decideNotificationPaging(observation(), policy, at(1_000))).toEqual({ action: "none" });
    expect(decideNotificationPaging(observation(), policy, at(29 * HOUR + 59 * MINUTE))).toEqual({ action: "none" });
    expect(decideNotificationPaging(observation(), policy, at(30 * HOUR))).toMatchObject({
      action: "page", mode: "sustained", transitionAt: T0,
    });
    // A pass that fails every window and heals on its retry is what the
    // retries are for: no flapping page either.
    const healedOften = observation({
      status: "resolved", resolvedAt: at(20 * MINUTE), episodesInWindow: 12,
    });
    expect(decideNotificationPaging(healedOften, policy, at(HOUR))).toEqual({ action: "none" });
  });

  it("other kinds keep their rules", () => {
    expect(notificationPagingPolicyFor("ofapi_chargebacks_reconcile_failed", null).openHoldMs).toBe(0);
    expect(notificationPagingPolicyFor("ofapi_auth", null).openHoldMs).toBe(0);
  });
});

describe("the link series' latches", () => {
  it("are page-scoped sub-keys of the failed pass's own kind", () => {
    expect(incidentKey({ kind: KIND, platformAccountId: 9, subKey: "series_stale" }))
      .toBe("ofapi_link_stats_reconcile_failed:9:series_stale");
    expect(parseIncidentSubKey({
      incidentKey: "ofapi_link_stats_reconcile_failed:9:page_unmapped", kind: KIND, stream: null,
    })).toBe("page_unmapped");
    // The pass's own latch keeps its key.
    expect(incidentKey({ kind: KIND, platformAccountId: null })).toBe("ofapi_link_stats_reconcile_failed:global");
  });

  it("say what is wrong, not that a reconcile failed", () => {
    expect(incidentTitleForKind({ kind: KIND, subKey: "series_stale" }))
      .toBe("OnlyFans link series is not being written");
    expect(incidentTitleForKind({ kind: KIND, subKey: "page_unmapped" }))
      .toBe("OnlyFans page has no OFAPI account mapping");
    expect(incidentTitleForKind({ kind: KIND, subKey: null }))
      .toBe("OFAPI link-stats reconcile failed");
    expect(openMessageForIncident({
      kind: KIND, subKey: "series_stale", pageLabel: "lora-vip-of", platform: "onlyfans",
      errorSummary: "trial: no usable result since 2026-10-07T21:45:20.000Z",
    })).toBe([
      "🚨 OnlyFans link series is not being written",
      "Page: lora-vip-of (onlyfans)",
      "Error: trial: no usable result since 2026-10-07T21:45:20.000Z",
    ].join("\n"));
    expect(resolveMessageForIncident({ kind: KIND, subKey: "series_stale", pageLabel: "lora-vip-of", platform: "onlyfans" }))
      .toBe("✅ Resolved\nOnlyFans link series is being written again: lora-vip-of (onlyfans)");
    expect(resolveMessageForIncident({ kind: KIND, subKey: "page_unmapped", pageLabel: "lora-of", platform: "onlyfans" }))
      .toBe("✅ Resolved\nOnlyFans page is mapped to an OFAPI account again: lora-of (onlyfans)");
  });
});

function row(overrides: Partial<LinkStatSeriesHealthRow>): LinkStatSeriesHealthRow {
  return {
    platformAccountId: 9,
    pageLabel: "lora-vip-of",
    pageCreatedAt: new Date("2026-07-01T00:00:00Z"),
    ofapiAccountId: "acct_x",
    ofapiAuthStatus: null,
    linkKind: "trial",
    lastUsableAt: null,
    firstAttemptAt: null,
    lastAttemptAt: null,
    lastAttemptStatus: null,
    lastAttemptReason: null,
    ...overrides,
  };
}

describe("when the series counts as not written", () => {
  it("two intervals between windows plus three hours of retries", () => {
    expect(OFAPI_LINK_STATS_SERIES_STALE_AFTER_MS).toBe(2 * OFAPI_LINK_STATS_WINDOW_INTERVAL_MS + 3 * HOUR);
    // 27 h at two windows a day, 15 h at four.
    expect([27 * HOUR, 15 * HOUR]).toContain(OFAPI_LINK_STATS_SERIES_STALE_AFTER_MS);
  });

  it("is judged per pair, by the latest usable result alone", () => {
    const limit = OFAPI_LINK_STATS_SERIES_STALE_AFTER_MS;
    const now = at(limit + MINUTE);
    const stale = findStaleLinkStatPairs([
      // Tracking reads fine.
      row({ linkKind: "tracking", lastUsableAt: at(HOUR), firstAttemptAt: at(-limit), lastAttemptAt: at(HOUR), lastAttemptStatus: "complete" }),
      // Trial keeps failing: attempts every window, no result since T0.
      row({
        linkKind: "trial", lastUsableAt: T0, firstAttemptAt: at(-limit),
        lastAttemptAt: at(limit), lastAttemptStatus: "failed", lastAttemptReason: "trial endpoint down",
      }),
    ], now, () => null);
    expect(stale).toEqual([{
      linkKind: "trial",
      since: T0,
      neverHadResult: false,
      neverAttempted: false,
      lastAttemptAt: at(limit),
      lastAttemptStatus: "failed",
      lastAttemptReason: "trial endpoint down",
    }]);
    expect(describeStaleLinkStatPairs(stale)).toBe(
      `trial: no usable result since ${T0.toISOString()}; last attempt ${at(limit).toISOString()} failed: trial endpoint down`,
    );
    // Exactly at the limit it is not stale yet.
    expect(findStaleLinkStatPairs([row({ lastUsableAt: T0, firstAttemptAt: T0 })], at(limit), () => null)).toEqual([]);
  });

  it("a pair that never had a result counts from its first attempt", () => {
    const limit = OFAPI_LINK_STATS_SERIES_STALE_AFTER_MS;
    const stale = findStaleLinkStatPairs([
      row({ linkKind: "trial", firstAttemptAt: T0, lastAttemptAt: at(limit), lastAttemptStatus: "skipped", lastAttemptReason: "ofapi_mapping_changed" }),
      // Never attempted, and the series has no anchor: nothing is expected.
      row({ linkKind: "tracking" }),
    ], at(limit + MINUTE), () => null);
    expect(stale).toEqual([expect.objectContaining({ linkKind: "trial", since: T0, neverHadResult: true })]);
    // The incident text cannot quote an `ofapi_…` code: the sanitizer would
    // redact it.
    expect(describeStaleLinkStatPairs(stale)).toBe(
      `trial: no usable result since the first attempt at ${T0.toISOString()}; `
        + `last attempt ${at(limit).toISOString()} skipped: ofapi mapping changed`,
    );
    expect(describeStaleLinkStatPairs([{ ...stale[0]!, lastAttemptAt: T0 }])).toBe(
      `trial: no usable result since the first attempt at ${T0.toISOString()}; no attempt since`,
    );
  });

  it("a pair never attempted counts from the first window it was expected in — a job that never fires is reported", () => {
    const limit = OFAPI_LINK_STATS_SERIES_STALE_AFTER_MS;
    const expected = firstOfapiLinkStatsWindowAtOrAfter(T0);
    const pairs = [row({ linkKind: "tracking" }), row({ linkKind: "trial" })];
    expect(findStaleLinkStatPairs(pairs, new Date(expected.getTime() + limit), () => expected)).toEqual([]);
    const stale = findStaleLinkStatPairs(pairs, new Date(expected.getTime() + limit + MINUTE), () => expected);
    expect(stale).toEqual([
      expect.objectContaining({ linkKind: "tracking", since: expected, neverHadResult: true, neverAttempted: true }),
      expect.objectContaining({ linkKind: "trial", since: expected, neverHadResult: true, neverAttempted: true }),
    ]);
    expect(describeStaleLinkStatPairs(stale.slice(0, 1))).toBe(
      `tracking: no attempt at all since the first window it was expected in, ${expected.toISOString()} — is the job running?`,
    );
  });
});

describe("since when the series is expected", () => {
  const windowAt = ofapiLinkStatsWindowAt(new Date("2026-10-08T12:00:00Z"));

  it("from the earliest stamp on the current schedule, wherever in history it lies", () => {
    const old = previousOfapiLinkStatsWindowAt(previousOfapiLinkStatsWindowAt(windowAt));
    expect(linkStatSeriesAnchor([windowAt, old], new Date("2026-10-08T23:00:00Z"))).toEqual(old);
    // A stamp off today's grid is another schedule's.
    const offGrid = new Date(old.getTime() - 30 * MINUTE);
    expect(linkStatSeriesAnchor([offGrid, windowAt], null)).toEqual(windowAt);
  });

  it("for a series that never stamped a window, from the first window after it was seen enabled", () => {
    const seen = new Date(windowAt.getTime() + 5 * MINUTE);
    expect(linkStatSeriesAnchor([], seen)).toEqual(nextOfapiLinkStatsWindowAt(windowAt));
    expect(linkStatSeriesAnchor([], windowAt)).toEqual(windowAt);
    expect(linkStatSeriesAnchor([], null)).toBeNull();
    expect(firstOfapiLinkStatsWindowAtOrAfter(seen)).toEqual(nextOfapiLinkStatsWindowAt(windowAt));
  });
});

describe("which closed windows the monitor answers for", () => {
  const open = ofapiLinkStatsWindowAt(new Date("2026-10-08T12:00:00Z"));
  const now = new Date(open.getTime() + 10 * MINUTE);
  const back = (steps: number) => {
    let windowAt = open;
    for (let step = 0; step < steps; step += 1) windowAt = previousOfapiLinkStatsWindowAt(windowAt);
    return windowAt;
  };

  it("nothing while the series has no anchor", () => {
    expect(closedLinkStatWindowsToCheck(now, null)).toEqual([]);
  });

  it("the closed windows from the anchor on, never the open one", () => {
    expect(closedLinkStatWindowsToCheck(now, back(3))).toEqual([back(3), back(2), back(1)]);
    // An anchor between windows starts at the next one.
    expect(closedLinkStatWindowsToCheck(now, new Date(back(3).getTime() + MINUTE))).toEqual([back(2), back(1)]);
    // Anchored in the open window: nothing has closed since.
    expect(closedLinkStatWindowsToCheck(now, open)).toEqual([]);
    expect(nextOfapiLinkStatsWindowAt(back(1))).toEqual(open);
  });

  it("checks no further back than twelve windows, however old the anchor", () => {
    const windows = closedLinkStatWindowsToCheck(now, back(30));
    expect(windows).toHaveLength(12);
    expect(windows[0]).toEqual(back(12));
    expect(windows[11]).toEqual(back(1));
  });
});
