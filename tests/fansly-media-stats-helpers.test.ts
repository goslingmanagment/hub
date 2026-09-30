// WP-F4 — the media-stats lane's pure helpers: the floor rule, the A16 cycle
// arithmetic, the backfill cursor and window helpers. No database: the queue,
// window and coverage invariants that need one stay in
// fansly-media-stats-lane.integration.test.ts.

import { describe, expect, it } from "vitest";

import {
  answeredFloor,
  countMediaStatBuckets,
  estimateMediaStatsCycle,
  mediaBackfillFirstMonthProbe,
  mediaStatsWindowIsEmpty,
  parseMediaBackfillCursor,
  servedMediaOfferRef,
  servedWindowCoversRequest,
  steadyRefreshPlan,
  steadyWindows,
  windowAnsweredBy,
} from "../apps/runtime/src/services/sync/fansly-media-stats.ts";
import {
  allZeroBody,
  BACKFILL_DONE,
  DAY_MS,
  NOW,
  ref,
  statsBody,
} from "./helpers/fansly-media-stats-fixtures.ts";

describe("media_stats lane — the windows and their guards", () => {
  it("counts an ALL-ZERO window as empty — the floor rule the 2006 walk needed", () => {
    // The exact production shape: one datapoint, one stats row, every counter
    // zero. A rule reading "datapoints.length > 0" calls this traffic.
    const zero = allZeroBody({
      mediaOfferRef: ref(470),
      afterMs: Date.UTC(2006, 2, 1),
      beforeMs: Date.UTC(2006, 3, 1),
      periodMs: 86_400_000,
    });
    expect(mediaStatsWindowIsEmpty(zero)).toBe(true);
    // ANY non-zero counter is traffic — including a preview-only one, which is
    // the case a `views`-only check would drop.
    const preview = JSON.parse(JSON.stringify(zero)) as typeof zero;
    (preview.dataset.datapoints[0]!.stats[0] as Record<string, unknown>).previewViews = 3;
    expect(mediaStatsWindowIsEmpty(preview)).toBe(false);
    // `type` is identity, not a counter.
    const typed = JSON.parse(JSON.stringify(zero)) as typeof zero;
    (typed.dataset.datapoints[0]!.stats[0] as Record<string, unknown>).type = 2;
    expect(mediaStatsWindowIsEmpty(typed)).toBe(true);
    // No datapoints at all is empty, as it always was.
    expect(mediaStatsWindowIsEmpty({ dataset: { datapoints: [] } })).toBe(true);
    // …but a dataset whose datapoints drifted away is not: that body is
    // unreadable, and reading it as empty is how a floor gets claimed.
    expect(mediaStatsWindowIsEmpty({ dataset: { datasetMediaOfferId: ref(470) } })).toBe(false);
    // A window with real numbers is not.
    expect(mediaStatsWindowIsEmpty(statsBody({
      mediaOfferRef: ref(470),
      afterMs: NOW.getTime() - 31 * DAY_MS,
      beforeMs: NOW.getTime(),
      periodMs: 86_400_000,
    }))).toBe(false);
  });
});

describe("media_stats — the cycle arithmetic (A16)", () => {
  // A16's binding table, at the stated publication rate of 5 media a day:
  // fresh (<=30 d) = 150, mid (31-180 d) = 750, and the rest is long tail.
  //
  //   requestsPerDayWanted = H + Mid/7 + L/cycle
  //   estimatedCycleDays   = L / (cap - H - Mid/7)
  //
  // The weekly term is deliberately NOT rounded before it is applied: A16's own
  // numbers only reproduce on the unrounded one, and a lane that reported 98
  // days where the owner's table says 96 would be reporting a different design.
  const rows = [
    { m: 2_000, wanted: 294, cycle: 26 },
    { m: 5_000, wanted: 394, cycle: 96 },
    { m: 10_000, wanted: 560, cycle: 212 },
    { m: 20_000, wanted: 894, cycle: 446 },
  ];

  for (const row of rows) {
    it(`reproduces A16's row for M = ${row.m}`, () => {
      const estimate = estimateMediaStatsCycle({
        fresh: 150,
        mid: 750,
        longTail: row.m - 900,
        dailyCap: 300,
        longTailCycleDays: 30,
      });
      expect(estimate.requestsPerDayWanted).toBe(row.wanted);
      expect(estimate.estimatedCycleDays).toBe(row.cycle);
      // 294 against a cap of 300 is NOT saturating; everything above it is, and
      // this lane is exempt from the 70 %-of-its-own-cap rule by design.
      expect(estimate.saturating).toBe(row.m > 2_000);
      // 96 days is QUARTERLY. The plan must never call it monthly.
      expect(estimate.quarterlyOrWorse).toBe(row.cycle > 90);
    });
  }

  it("never claims a cycle it cannot fund when the daily tiers alone exceed the cap", () => {
    const estimate = estimateMediaStatsCycle({
      fresh: 400,
      mid: 700,
      longTail: 5_000,
      dailyCap: 300,
      longTailCycleDays: 30,
    });
    expect(estimate.saturating).toBe(true);
    // The denominator is clamped to 1, so the number means "at LEAST this many
    // days" — the long tail is not being funded at all, and the due backlog is
    // what says so.
    expect(estimate.estimatedCycleDays).toBe(5_000);
    expect(estimate.quarterlyOrWorse).toBe(true);
  });

  it("counts a SPLIT long tail at three calls a visit", () => {
    // M = 2 000 again, on a page whose route refuses 90 days: each long-tail
    // visit is three 31-day windows, so the long tail wants three times the
    // calls and comes round three times slower on the same leftover.
    const estimate = estimateMediaStatsCycle({
      fresh: 150,
      mid: 750,
      longTail: 1_100,
      dailyCap: 300,
      longTailCycleDays: 30,
      longTailRequestsPerVisit: 3,
    });
    expect(estimate.requestsPerDayWanted).toBe(Math.round(150 + 750 / 7 + (3 * 1_100) / 30));
    expect(estimate.estimatedCycleDays).toBe(Math.round((3 * 1_100) / (300 - 150 - 750 / 7)));
    expect(estimate.saturating).toBe(true);
  });

  it("counts a never-visited item at its FIRST visit's cost while that backlog lasts", () => {
    const census = {
      fresh: 20,
      mid: 350,
      longTail: 1_000,
      dailyCap: 300,
      longTailCycleDays: 30,
      longTailRequestsPerVisit: 3,
    };
    const backlog = estimateMediaStatsCycle({
      ...census,
      neverVisited: { fresh: 5, mid: 70, longTail: 300 },
    });
    // A first visit walks the item's history: two windows for a fresh item —
    // its trailing window and the one below it, where its creation ends the
    // walk — and the visit's whole four for mid and the long tail.
    const fresh = 15 + 5 * 2;
    const weekly = (280 + 70 * 4) / 7;
    const longTail = 700 * 3 + 300 * 4;
    expect(backlog.requestsPerDayWanted).toBe(Math.round(fresh + weekly + longTail / 30));
    // The long tail waits for the first looks ahead of it — what they cost
    // over a steady visit, paid ONCE — then takes what the steady fresh and
    // mid visits leave. Its own first looks are part of its cycle.
    const firstLooksAhead = 5 * (2 - 1) + 70 * (4 - 1);
    expect(backlog.estimatedCycleDays)
      .toBe(Math.round((firstLooksAhead + longTail) / (300 - 20 - 350 / 7)));
    // No backlog, no change: the steady arithmetic above still holds.
    expect(estimateMediaStatsCycle({
      ...census,
      neverVisited: { fresh: 0, mid: 0, longTail: 0 },
    })).toEqual(estimateMediaStatsCycle(census));
  });

  it("prices the first-look backlog ONCE, so the long tail's cycle does not collapse to the clamp", () => {
    // lora-1's census, production 2026-09-30: the steady fresh and mid visits
    // leave 14 calls a day. Charged every week, 399 never-visited mid items at
    // four calls each would take 171 of the cap a day, drive that leftover
    // below zero and report the clamp — the long tail's whole cost in days,
    // 7 874 of them — although the backlog clears once and the long tail is
    // funded again after it.
    const estimate = estimateMediaStatsCycle({
      fresh: 199,
      mid: 608,
      longTail: 1_984,
      dailyCap: 300,
      longTailCycleDays: 30,
      longTailRequestsPerVisit: 3,
      neverVisited: { fresh: 14, mid: 399, longTail: 1_922 },
    });
    const firstLooksAhead = 14 * (2 - 1) + 399 * (4 - 1);
    const longTail = 62 * 3 + 1_922 * 4;
    expect(estimate.estimatedCycleDays)
      .toBe(Math.round((firstLooksAhead + longTail) / (300 - 199 - 608 / 7)));
    expect(estimate.estimatedCycleDays).toBe(642);
    // What the tiers WANT still prices each first look within its tier's
    // cadence: that is the rate that would keep every tier on time.
    expect(estimate.requestsPerDayWanted)
      .toBe(Math.round(199 + 14 + (608 + 399 * 3) / 7 + longTail / 30));
    expect(estimate.saturating).toBe(true);
  });
});

describe("media_stats — the pure helpers", () => {
  it("parses a pre-probe cursor as a walk that has spent no probe", () => {
    expect(parseMediaBackfillCursor({ ...BACKFILL_DONE }, NOW)).toMatchObject({
      done: true,
      probeSpent: false,
      probeResumeBeforeMs: null,
      probeHitBeforeMs: null,
    });
    const armed = parseMediaBackfillCursor({
      ...BACKFILL_DONE,
      probeSpent: true,
      probeResumeBeforeMs: 1_700_000_000_000,
      probeHitBeforeMs: 1_600_000_000_000,
    }, NOW);
    expect(armed).toMatchObject({
      probeSpent: true,
      probeResumeBeforeMs: 1_700_000_000_000,
      probeHitBeforeMs: 1_600_000_000_000,
    });
  });

  it("aims the one probe at the FIRST month, and only where there is a gap to jump", () => {
    const created = new Date(NOW.getTime() - 400 * DAY_MS);
    const guard = { spanDays: 31, narrowed: false, lastAfterMs: null, lastBeforeMs: null, lastObservationId: null };
    // Stopped 151 days back: the bookmark is the window below, and the probe
    // opens a day before creation.
    expect(mediaBackfillFirstMonthProbe(
      { nextBeforeMs: NOW.getTime() - 151 * DAY_MS, guard },
      { createdAtPlatform: created, firstSeenAt: null },
    )).toEqual({
      probeBeforeMs: created.getTime() + 30 * DAY_MS,
      resumeBeforeMs: NOW.getTime() - 182 * DAY_MS,
    });
    // First sight is the basis when the platform served no creation date.
    expect(mediaBackfillFirstMonthProbe(
      { nextBeforeMs: NOW.getTime() - 151 * DAY_MS, guard },
      { createdAtPlatform: null, firstSeenAt: created },
    )?.probeBeforeMs).toBe(created.getTime() + 30 * DAY_MS);
    // No basis, nothing to aim at.
    expect(mediaBackfillFirstMonthProbe(
      { nextBeforeMs: NOW.getTime() - 151 * DAY_MS, guard },
      { createdAtPlatform: null, firstSeenAt: null },
    )).toBeNull();
    // No room: the next ordinary window already reaches the creation basis.
    expect(mediaBackfillFirstMonthProbe(
      { nextBeforeMs: created.getTime() + 62 * DAY_MS, guard },
      { createdAtPlatform: created, firstSeenAt: null },
    )).toBeNull();
  });

  it("reads the subject from the key the route actually serves", () => {
    expect(servedMediaOfferRef({ dataset: { datasetMediaOfferId: "abc" } })).toBe("abc");
    expect(servedMediaOfferRef({ dataset: {} })).toBeNull();
    expect(servedMediaOfferRef(null)).toBeNull();
  });

  it("counts every stats row across every bucket", () => {
    expect(countMediaStatBuckets({
      dataset: {
        datapoints: [
          { timestamp: 1, stats: [{ type: 0 }, { type: 1 }] },
          { timestamp: 2, stats: [{ type: 0 }] },
        ],
      },
    })).toBe(3);
    expect(countMediaStatBuckets({ dataset: { datapoints: [] } })).toBe(0);
    expect(countMediaStatBuckets({})).toBe(0);
  });

  it("sees a same-end, NARROWER answer that the loop guard cannot", () => {
    const beforeMs = NOW.getTime();
    const requested = { afterMs: beforeMs - 90 * DAY_MS, beforeMs };
    // The provider's default trailing 31 days: same end, nearer start. Nothing
    // reaches newer than we asked and nothing is disjoint, so the loop guard
    // correctly reports no contradiction — there is none. What there is, is 59
    // days we asked for and did not get, and only the coverage check sees it.
    expect(servedWindowCoversRequest(requested, {
      afterMs: beforeMs - 31 * DAY_MS,
      beforeMs,
    })).toBe(false);
    expect(servedWindowCoversRequest(requested, {
      afterMs: beforeMs - 90 * DAY_MS,
      beforeMs,
    })).toBe(true);
    // Served bounds we did not get are no evidence, and no evidence is no
    // contradiction — the empty-window rule owns that case.
    expect(servedWindowCoversRequest(requested, { afterMs: null, beforeMs: null })).toBe(true);
  });

  it("covers the whole 90 days when the long tail is split", () => {
    const split = steadyWindows("long_tail", NOW, "split_31");
    expect(split).toHaveLength(3);
    const covered = split[0]!.beforeMs - split[2]!.afterMs;
    // 3 x 31 = 93 >= 90: the split never covers LESS than the single window it
    // replaces.
    expect(covered / DAY_MS).toBe(93);
    for (const window of split) {
      expect((window.beforeMs - window.afterMs) / DAY_MS).toBe(31);
      expect(window.periodMs).toBe(86_400_000);
    }
  });

  it("reaches a refresh back to the day before a last visit its window no longer holds", () => {
    const now = NOW.getTime();
    const daysBack = (windows: ReadonlyArray<{ afterMs: number; beforeMs: number }>) =>
      windows.map((window) => [(now - window.afterMs) / DAY_MS, (now - window.beforeMs) / DAY_MS]);
    const visited = (days: number) => new Date(now - days * DAY_MS);

    // Visited 38 days ago: the 30-day read alone would skip eight days for
    // good. The plan reads them, contiguous with the refresh, to a day below
    // the visit — the walk's own overlap.
    const late = steadyRefreshPlan("mid", NOW, "split_31", visited(38));
    expect(daysBack(late.windows)).toEqual([[30, 0], [39, 30]]);
    expect(windowAnsweredBy({ afterMs: now - 39 * DAY_MS, beforeMs: now }, late.windows)).toBe(true);
    expect(late).toMatchObject({ holeWindows: 1, unreadHole: null });

    // Inside the window, or never visited: the tier's plan, untouched.
    for (const lastVisitedAt of [visited(25), visited(30), null]) {
      expect(steadyRefreshPlan("mid", NOW, "split_31", lastVisitedAt)).toEqual({
        windows: steadyWindows("mid", NOW, "split_31"),
        holeWindows: 0,
        unreadHole: null,
      });
    }

    // 31-day steps, four windows at most — one unit that fits a chunk — and
    // what does not fit is named, not skipped in silence.
    const deep = steadyRefreshPlan("mid", NOW, "split_31", visited(170));
    expect(daysBack(deep.windows)).toEqual([[30, 0], [61, 30], [92, 61], [123, 92]]);
    expect(deep.unreadHole).toEqual({ afterMs: now - 171 * DAY_MS, beforeMs: now - 123 * DAY_MS });

    // The long tail measures from its own span: 93 days split, 90 whole.
    expect(daysBack(steadyRefreshPlan("long_tail", NOW, "split_31", visited(100)).windows))
      .toEqual([[31, 0], [62, 31], [93, 62], [101, 93]]);
    expect(daysBack(steadyRefreshPlan("long_tail", NOW, "ninety", visited(100)).windows))
      .toEqual([[90, 0], [101, 90]]);
    expect(steadyRefreshPlan("long_tail", NOW, "ninety", visited(85)).holeWindows).toBe(0);
  });

  it("takes a refresh from a visit's windows only when they cover it end to end", () => {
    const now = NOW.getTime();
    const [s0, s1, s2] = steadyWindows("long_tail", NOW, "split_31");
    const span = (afterDays: number, beforeDays: number) => ({
      afterMs: now - afterDays * DAY_MS,
      beforeMs: now - beforeDays * DAY_MS,
    });
    // A first visit's four backfill windows as the fixtures serve them —
    // exactly as asked, one day of overlap — reach 121 days back.
    const walked = [span(31, 0), span(61, 30), span(91, 60), span(121, 90)];
    for (const window of [s0!, s1!, s2!]) {
      expect(windowAnsweredBy(window, walked)).toBe(true);
    }
    // Three of them reach 91: the split plan's far end is two days short.
    expect(windowAnsweredBy(s2!, walked.slice(0, 3))).toBe(false);
    // Production's shape: each window served a day earlier than asked, and
    // the first snapped to the day boundary below `now` — touching, not
    // overlapping, and short of `now` by less than a day. Three cover the plan.
    const snapped = now - 9 * 60 * 60 * 1000;
    const served = [0, 1, 2].map((index) => ({
      afterMs: snapped - (index + 1) * 31 * DAY_MS,
      beforeMs: snapped - index * 31 * DAY_MS,
    }));
    for (const window of [s0!, s1!, s2!]) {
      expect(windowAnsweredBy(window, served)).toBe(true);
    }
    // A gap inside the window is buckets nobody read.
    expect(windowAnsweredBy(span(62, 0), [span(31, 0), span(62, 33)])).toBe(false);
    // A walk anchored in the past never answers today's trailing window.
    expect(windowAnsweredBy(s0!, [span(33, 2), span(63, 32)])).toBe(false);
    expect(windowAnsweredBy(s0!, [])).toBe(false);
  });

  it("finds how far down a visit's windows reach, unbroken, from a walk's resume point", () => {
    const now = NOW.getTime();
    const span = (afterDays: number, beforeDays: number) => ({
      afterMs: now - afterDays * DAY_MS,
      beforeMs: now - beforeDays * DAY_MS,
    });
    const refresh = steadyWindows("long_tail", NOW, "split_31");
    // A walk that resumes inside the split refresh — at a window key, or
    // between keys — is covered to the refresh's far end.
    expect(answeredFloor(now - 31 * DAY_MS, refresh)).toBe(now - 93 * DAY_MS);
    expect(answeredFloor(now - 31 * DAY_MS - 7 * 3_600_000, refresh)).toBe(now - 93 * DAY_MS);
    // Below the refresh, or across a gap, nothing is held.
    expect(answeredFloor(now - 120 * DAY_MS, refresh)).toBe(now - 120 * DAY_MS);
    expect(answeredFloor(now - 40 * DAY_MS, [span(31, 0), span(93, 62)])).toBe(now - 40 * DAY_MS);
    expect(answeredFloor(now - 20 * DAY_MS, [span(31, 0), span(93, 62)])).toBe(now - 31 * DAY_MS);
    expect(answeredFloor(now - 20 * DAY_MS, [])).toBe(now - 20 * DAY_MS);
  });
});
