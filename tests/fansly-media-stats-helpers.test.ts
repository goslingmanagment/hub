// WP-F4 — the media-stats walk's pure rules (`sync/fansly/lib/media-stats-rules.ts`),
// which the engine's media-stats resource reads: the floor rule, the backfill
// cursor and window helpers. No database.

import { describe, expect, it } from "vitest";

import {
  answeredFloor,
  countMediaStatBuckets,
  mediaBackfillFirstMonthProbe,
  mediaStatsWindowIsEmpty,
  parseMediaBackfillCursor,
  servedMediaOfferRef,
  servedWindowCoversRequest,
  servedWindowSpansRequest,
  steadyRefreshPlan,
  steadyWindows,
  windowAnsweredBy,
} from "../apps/runtime/src/sync/fansly/lib/media-stats-rules.ts";
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

  it("counts a hole window read only when what was served spans it end to end", () => {
    const now = NOW.getTime();
    const at = (days: number) => now - days * DAY_MS;
    // A mid item last refreshed 38 days ago: the hole below its 30 days.
    const requested = { afterMs: at(39), beforeMs: at(30) };
    expect(servedWindowSpansRequest(requested, requested)).toBe(true);
    // Production's shape: each bound snapped to the start of its day, so the
    // last bucket starts under a day below what was asked.
    const midnight = (ms: number) => ms - (ms % DAY_MS);
    expect(servedWindowSpansRequest(requested, {
      afterMs: midnight(requested.afterMs),
      beforeMs: midnight(requested.beforeMs),
    })).toBe(true);
    // The route's DEFAULT trailing window — what the backfill guard exists for.
    expect(servedWindowSpansRequest(requested, { afterMs: at(31), beforeMs: now })).toBe(false);
    // Short at either end: days asked for and not served.
    expect(servedWindowSpansRequest(requested, { afterMs: at(35), beforeMs: at(30) })).toBe(false);
    expect(servedWindowSpansRequest(requested, { afterMs: at(39), beforeMs: at(33) })).toBe(false);
    // No served bounds: no evidence, and no contradiction.
    expect(servedWindowSpansRequest(requested, { afterMs: null, beforeMs: null })).toBe(true);
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

  it("never takes a window two days wide as answered by the slack alone", () => {
    const now = NOW.getTime();
    const span = (afterDays: number, beforeDays: number) => ({
      afterMs: now - afterDays * DAY_MS,
      beforeMs: now - beforeDays * DAY_MS,
    });
    // A mid item last refreshed 31 days ago: its refresh, and the hole below
    // it down to a day before that refresh — two days wide.
    const plan = steadyRefreshPlan("mid", NOW, "split_31", new Date(now - 31 * DAY_MS));
    const [trailing, hole] = plan.windows;
    expect(hole).toEqual({ periodMs: DAY_MS, ...span(32, 30) });
    // The day of slack at the top and the day at the bottom meet inside it:
    // with nothing read at all, the window read as answered, and the visit
    // skipped it for good.
    expect(windowAnsweredBy(hole!, [])).toBe(false);
    // The refresh above it reads none of its days either — as asked, or as
    // production serves it, snapped to the day boundary below `now`.
    const snapped = now - 9 * 60 * 60 * 1000;
    expect(windowAnsweredBy(hole!, [trailing!])).toBe(false);
    expect(windowAnsweredBy(hole!, [{ afterMs: snapped - 30 * DAY_MS, beforeMs: snapped }])).toBe(false);
    // What was read inside it holds it, the slack extending that and no more:
    // its own answer, as asked or served a day early.
    expect(windowAnsweredBy(hole!, [span(32, 30)])).toBe(true);
    expect(windowAnsweredBy(hole!, [span(33, 31)])).toBe(true);
    // Wide windows are unchanged: the plan's own windows answer themselves.
    expect(windowAnsweredBy(trailing!, plan.windows)).toBe(true);
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
