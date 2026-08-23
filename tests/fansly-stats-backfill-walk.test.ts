import { describe, expect, it } from "vitest";

import {
  describeStatsMonthAnswer,
  probeStatsMonth,
} from "../apps/runtime/src/services/fansly-endpoint-probe.ts";
import {
  backfillContinuationAt,
  emptyFanslyStatsCursorState,
  isEmptyStatsMonth,
  monthFromIndex,
  monthIndexOf,
  monthLabel,
  monthWasHonoured,
  narrowedSpanDays,
  parseFanslyStatsCursorState,
  rollUtcDay,
  servedEarningsWindow,
  utcDayKey,
  windowsAreContiguous,
  windowWasHonoured,
} from "../apps/runtime/src/services/sync/fansly-stats.ts";

// WP-F1 — the pure halves of the backfill walk, without a database.
//
// The stop rule and the window derivation are where a quiet hole in ten years
// of history would come from, and neither needs Postgres to be checked.

const NOW = new Date("2026-08-19T09:00:00.000Z");

describe("stats backfill cursor state", () => {
  it("starts in backfill mode with all three walks open", () => {
    const state = emptyFanslyStatsCursorState(NOW);
    // FIRST ENABLE is the only cheap chance at the provider's floor — ten years
    // of daily buckets is ~118 windows at the 31-day span the provider honours.
    expect(state.mode).toBe("backfill");
    expect(state.backfill).not.toBeNull();
    expect(state.backfill!.daily.done).toBe(false);
    expect(state.backfill!.hourly.done).toBe(false);
    expect(state.backfill!.earnings.done).toBe(false);
    expect(state.backfill!.daily.probeSpent).toBe(false);
    expect(state.backfill!.daily.probeResumeMonthIndex).toBeNull();
    // The history walk starts at the TRAILING window and names no month until
    // that window lands: the date bounds only work inside it.
    expect(state.backfill!.daily.trailingCaptured).toBe(false);
    expect(state.backfill!.daily.nextMonthIndex).toBeNull();
    expect(state.utcDay).toBe("2026-08-19");
    expect(state.callsToday).toBe(0);
    expect(state.version).toBe(2);
    expect(state.sweepDay).toBeNull();
  });

  it("round-trips through the checkpoint, including the probe bookmark", () => {
    const state = emptyFanslyStatsCursorState(NOW);
    state.backfill!.daily.probeSpent = true;
    state.backfill!.daily.trailingCaptured = true;
    state.backfill!.daily.nextMonthIndex = monthIndexOf(NOW) - 4;
    state.backfill!.daily.lastMonthIndex = monthIndexOf(NOW) - 3;
    state.backfill!.daily.probeResumeMonthIndex = monthIndexOf(NOW) - 3;
    state.backfill!.daily.floorAt = "2019-01-01T00:00:00.000Z";
    state.callsToday = 7;
    state.stepIndex = 4;
    state.sweepDay = "2026-08-19";
    // The cursor is the only durable home for any of this: a walk that lost its
    // bookmark on a lease change would re-read from today, forever.
    const parsed = parseFanslyStatsCursorState(JSON.parse(JSON.stringify(state)), NOW);
    expect(parsed).not.toBeNull();
    expect(parsed!.backfill!.daily.probeResumeMonthIndex).toBe(monthIndexOf(NOW) - 3);
    expect(parsed!.backfill!.daily.nextMonthIndex).toBe(monthIndexOf(NOW) - 4);
    expect(parsed!.backfill!.daily.lastMonthIndex).toBe(monthIndexOf(NOW) - 3);
    expect(parsed!.backfill!.daily.trailingCaptured).toBe(true);
    expect(parsed!.backfill!.daily.floorAt).toBe("2019-01-01T00:00:00.000Z");
    expect(parsed!.callsToday).toBe(7);
    expect(parsed!.stepIndex).toBe(4);
    expect(parsed!.sweepDay).toBe("2026-08-19");
  });

  it("clamps a step index past the last step instead of wedging the lane", () => {
    const state = { ...emptyFanslyStatsCursorState(NOW), stepIndex: 99 };
    // Without the clamp the sweep loop would fall through to its `break` and
    // report "not satisfied, nothing done" on every dispatch — no call, no
    // error, and no way to tell it apart from a quiet day.
    expect(parseFanslyStatsCursorState(JSON.parse(JSON.stringify(state)), NOW)!.stepIndex)
      .toBe(10);
    const negative = { ...emptyFanslyStatsCursorState(NOW), stepIndex: -3 };
    expect(parseFanslyStatsCursorState(JSON.parse(JSON.stringify(negative)), NOW)!.stepIndex)
      .toBe(0);
  });

  it("refuses a cursor it does not recognize rather than half-reading it", () => {
    expect(parseFanslyStatsCursorState(null, NOW)).toBeNull();
    expect(parseFanslyStatsCursorState({ version: 3, mode: "steady", utcDay: "x" }, NOW)).toBeNull();
    expect(parseFanslyStatsCursorState({ version: 1, mode: "nope", utcDay: "x" }, NOW)).toBeNull();
    expect(parseFanslyStatsCursorState({ version: 1, mode: "steady" }, NOW)).toBeNull();
  });

  it("rolls the UTC day and nothing else", () => {
    const state = {
      ...emptyFanslyStatsCursorState(NOW),
      callsToday: 25,
      sweepDay: "2026-08-19",
      stepIndex: 6,
    };
    const same = rollUtcDay(state, new Date("2026-08-19T23:59:59.999Z"));
    expect(same.callsToday).toBe(25);
    const rolled = rollUtcDay(state, new Date("2026-08-20T00:00:00.000Z"));
    expect(rolled.callsToday).toBe(0);
    expect(rolled.utcDay).toBe("2026-08-20");
    expect(rolled.stepIndex).toBe(6);
    expect(rolled.sweepDay).toBe("2026-08-19");
    expect(utcDayKey(new Date("2026-01-01T00:00:00.000Z"))).toBe("2026-01-01");
  });

  it("migrates an ambiguous v1 sweep conservatively so the current head is re-read once", () => {
    const inProgress = {
      ...emptyFanslyStatsCursorState(NOW),
      version: 1,
      mode: "steady",
      backfill: null,
      utcDay: "2026-08-20",
      lastSweepDay: "2026-08-19",
      stepIndex: 6,
    };
    const parsedInProgress = parseFanslyStatsCursorState(inProgress, NOW)!;
    expect(parsedInProgress.version).toBe(2);
    // V1 could have rolled the attempt day without running step 0. Finish its
    // tail as the prior sweep, then the handler must start a fresh current one.
    expect(parsedInProgress.sweepDay).toBe("2026-08-19");

    const completed = { ...inProgress, stepIndex: 0 };
    const parsedCompleted = parseFanslyStatsCursorState(completed, NOW)!;
    expect(parsedCompleted.lastSweepDay).toBeNull();
    expect(parsedCompleted.sweepDay).toBeNull();
  });
});

describe("window contiguity (§7)", () => {
  it("accepts an overlap and rejects a hole", () => {
    // The walk asks for 31-day windows with a one-day overlap, so the older
    // window's END must reach at least the newer window's START. A gap means
    // buckets were skipped — and because each next window is derived from the
    // provider's RETURNED bounds, a gap is evidence the derivation drifted.
    const newer = { afterMs: Date.UTC(2026, 4, 1), beforeMs: Date.UTC(2026, 7, 9) };
    expect(windowsAreContiguous(
      { afterMs: Date.UTC(2026, 1, 1), beforeMs: Date.UTC(2026, 4, 2) },
      newer,
    )).toBe(true);
    // Exactly touching is contiguous: no bucket falls between them.
    expect(windowsAreContiguous(
      { afterMs: Date.UTC(2026, 1, 1), beforeMs: Date.UTC(2026, 4, 1) },
      newer,
    )).toBe(true);
    expect(windowsAreContiguous(
      { afterMs: Date.UTC(2026, 1, 1), beforeMs: Date.UTC(2026, 3, 1) },
      newer,
    )).toBe(false);
  });

  it("treats a window the provider did not describe as no contradiction", () => {
    // Absence of served bounds is absence of EVIDENCE. Reporting a gap here
    // would raise an anomaly about a window nobody described.
    const newer = { afterMs: Date.UTC(2026, 4, 1), beforeMs: Date.UTC(2026, 7, 9) };
    expect(windowsAreContiguous({ afterMs: null, beforeMs: null }, newer)).toBe(true);
    expect(windowsAreContiguous({ afterMs: 1, beforeMs: 2 }, { afterMs: null, beforeMs: null }))
      .toBe(true);
  });
});

describe("backfill continuation spread", () => {
  it("applies the configured delay with ±30% jitter", () => {
    // Burst shape is the ban-risk surface: a chunk spends 5 requests in ~13 s
    // and is re-queued immediately, so an unspaced deep walk runs contiguously
    // at ~23 req/min for as long as it has work.
    const base = new Date("2026-08-19T09:00:00.000Z");
    expect(backfillContinuationAt(base, 20_000, () => 0.5).getTime() - base.getTime())
      .toBe(20_000);
    expect(backfillContinuationAt(base, 20_000, () => 0).getTime() - base.getTime())
      .toBe(14_000);
    expect(backfillContinuationAt(base, 20_000, () => 1).getTime() - base.getTime())
      .toBe(26_000);
    // A zero delay is "no spread", not a negative instant.
    expect(backfillContinuationAt(base, 0, () => 0).getTime()).toBe(base.getTime());
  });
});

describe("the unhonoured-window guard", () => {
  // PROD 2026-08-22 04:16–04:20 UTC, first enable on ari-1 (lilly-1 identical):
  // the walk asked for 100 days, the provider answered with its own default
  // trailing 31, the walk derived its next window from THAT — and re-issued the
  // same request 24 more times, 25 byte-identical bodies, one dedup object id,
  // the whole daily cap. Every predicate below exists to end that sequence.
  const requested = {
    afterMs: Date.UTC(2026, 3, 13),
    beforeMs: Date.UTC(2026, 6, 22),
  };

  it("rejects the provider's default trailing window", () => {
    // The exact bytes from prod: `dateAfter 2026-07-21 / dateBefore 2026-08-22`
    // against a window that ended a month earlier.
    expect(windowWasHonoured(requested, {
      afterMs: Date.UTC(2026, 6, 21),
      beforeMs: Date.UTC(2026, 7, 22),
    })).toBe(false);
    // NOTE this pair INTERSECTS by a day — an intersection test alone would
    // have called the production failure honoured and kept looping.
  });

  it("accepts a window served within a day of what was asked", () => {
    // §7's premise is that served bounds are snapped, not equal: a day of slack
    // is the difference between a guard and a tripwire.
    expect(windowWasHonoured(requested, {
      afterMs: requested.afterMs,
      beforeMs: requested.beforeMs,
    })).toBe(true);
    expect(windowWasHonoured(requested, {
      afterMs: requested.afterMs - 6 * 60 * 60 * 1000,
      beforeMs: requested.beforeMs + 6 * 60 * 60 * 1000,
    })).toBe(true);
    // Served OLDER than asked is not a refusal — the walk only ever wanted to
    // go backwards, and it derives from what came back.
    expect(windowWasHonoured(requested, {
      afterMs: requested.afterMs - 90 * 86_400_000,
      beforeMs: requested.beforeMs,
    })).toBe(true);
    // A narrower window inside ours is the provider trimming to its data.
    expect(windowWasHonoured(requested, {
      afterMs: requested.afterMs + 10 * 86_400_000,
      beforeMs: requested.beforeMs - 10 * 86_400_000,
    })).toBe(true);
  });

  it("rejects a window that misses the request entirely", () => {
    // Disjoint in the older direction: everything served ended before our
    // window began.
    expect(windowWasHonoured(requested, {
      afterMs: Date.UTC(2025, 0, 1),
      beforeMs: Date.UTC(2025, 1, 1),
    })).toBe(false);
  });

  it("treats bounds the provider did not describe as no contradiction", () => {
    // Absence of served bounds is absence of EVIDENCE — the empty-window rule
    // owns that case, and stopping a walk on it would call an idle month a
    // provider refusal.
    expect(windowWasHonoured(requested, { afterMs: null, beforeMs: null })).toBe(true);
  });

  it("halves a span once, never below the floor, never upward", () => {
    expect(narrowedSpanDays(31)).toBe(15);
    expect(narrowedSpanDays(15)).toBe(7);
    // AT the floor the narrowed span equals the current one, which the walk
    // reads as "no retry left" — retrying it would re-issue the same request.
    expect(narrowedSpanDays(7)).toBe(7);
    // The hourly lane's 4-day step is already below the floor: it must not be
    // WIDENED into a span the provider was just seen refusing.
    expect(narrowedSpanDays(4)).toBe(4);
  });

  it("reads the earnings window off the rows, since the route describes none", () => {
    const rows = [
      { type: 1, totalGross: 10, timestamp: Date.UTC(2026, 6, 3) },
      { type: 2, totalGross: 20, timestamp: Date.UTC(2026, 6, 19) },
      { type: 3, totalGross: 30, timestamp: Date.UTC(2026, 5, 30) },
    ];
    expect(servedEarningsWindow(rows)).toEqual({
      afterMs: Date.UTC(2026, 5, 30),
      beforeMs: Date.UTC(2026, 6, 19),
    });
    // Rows inside the asked-for window; rows from today against a historical
    // window are the same refusal the daily lane hit.
    expect(windowWasHonoured(requested, servedEarningsWindow(rows))).toBe(true);
    expect(windowWasHonoured(requested, servedEarningsWindow([
      { type: 1, timestamp: Date.UTC(2026, 7, 22) },
    ]))).toBe(false);
    // No rows is no evidence, not a refusal.
    expect(servedEarningsWindow([])).toEqual({ afterMs: null, beforeMs: null });
    expect(windowWasHonoured(requested, servedEarningsWindow([]))).toBe(true);
  });

  it("carries the guard across the checkpoint round-trip", () => {
    // The loop that spent a day's cap ran across five chunks: a guard that did
    // not survive the cursor would have watched it happen five times.
    const state = emptyFanslyStatsCursorState(NOW);
    expect(state.backfill!.daily.guard.spanDays).toBe(31);
    expect(state.backfill!.earnings.guard.spanDays).toBe(31);
    expect(state.backfill!.hourly.guard.spanDays).toBe(4);
    state.backfill!.daily.guard = {
      spanDays: 15,
      narrowed: true,
      lastAfterMs: Date.UTC(2026, 3, 13),
      lastBeforeMs: Date.UTC(2026, 6, 22),
      lastObservationId: 229_326,
    };
    const parsed = parseFanslyStatsCursorState(JSON.parse(JSON.stringify(state)), NOW);
    expect(parsed!.backfill!.daily.guard).toEqual({
      spanDays: 15,
      narrowed: true,
      lastAfterMs: Date.UTC(2026, 3, 13),
      lastBeforeMs: Date.UTC(2026, 6, 22),
      lastObservationId: 229_326,
    });
  });

  it("gives a pre-guard cursor a full-span guard that has asked for nothing", () => {
    // The cursors already on prod were written before any of this existed, and
    // they are mid-walk: they must resume, not restart.
    const legacy = {
      version: 1,
      mode: "backfill",
      utcDay: "2026-08-22",
      callsToday: 25,
      stepIndex: 0,
      backfill: {
        daily: { nextBeforeMs: Date.UTC(2026, 6, 22), emptyStreak: 0, done: false },
        hourly: { nextBeforeMs: Date.UTC(2026, 7, 22), daysWalked: 0, done: false },
        earnings: { nextBeforeMs: Date.UTC(2026, 7, 22), emptyStreak: 0, done: false },
      },
    };
    const parsed = parseFanslyStatsCursorState(legacy, NOW);
    expect(parsed!.backfill!.daily.nextBeforeMs).toBe(Date.UTC(2026, 6, 22));
    expect(parsed!.backfill!.daily.guard).toEqual({
      spanDays: 31,
      narrowed: false,
      lastAfterMs: null,
      lastBeforeMs: null,
      lastObservationId: null,
    });
    // A DATE-BOUND cursor names no month, which is exactly what it is: a walk
    // that has not started the only form of history this route serves.
    expect(parsed!.backfill!.daily.trailingCaptured).toBe(false);
    expect(parsed!.backfill!.daily.nextMonthIndex).toBeNull();
  });
});

describe("the month form — the only history /it/amoie/stats serves", () => {
  // PROD 2026-08-22, lora-2, with the unhonoured-window guard already live:
  // `afterDate 2026-06-21 / beforeDate 2026-07-22` (31 days, historical) came
  // back `dateAfter 2026-07-21 / dateBefore 2026-08-21` — the trailing window.
  // Halving the span to 15 days changed nothing. A14 said these bounds reached
  // history; they do not, and the walk now names a CALENDAR MONTH instead.

  it("indexes months as one integer, so a step back is arithmetic", () => {
    expect(monthIndexOf(new Date("2026-08-22T09:00:00.000Z")))
      .toBe(2026 * 12 + 7);
    // The year boundary is the case a month-by-month walk gets wrong; here it
    // is subtraction and there is nothing to get wrong.
    const january = monthIndexOf(new Date("2026-01-14T00:00:00.000Z"));
    expect(monthFromIndex(january)).toEqual({ year: 2026, month: 1 });
    expect(monthFromIndex(january - 1)).toEqual({ year: 2025, month: 12 });
    expect(monthFromIndex(january - 13)).toEqual({ year: 2024, month: 12 });
    expect(monthLabel(january - 1)).toBe("2025-12");
  });

  it("accepts a served window that starts inside the month it named", () => {
    const june = monthIndexOf(new Date("2026-06-15T00:00:00.000Z"));
    expect(monthWasHonoured(june, {
      afterMs: Date.UTC(2026, 5, 1),
      beforeMs: Date.UTC(2026, 6, 1),
    })).toBe(true);
    // A day of slack for the provider's own bucket snapping, both ways.
    expect(monthWasHonoured(june, {
      afterMs: Date.UTC(2026, 4, 31, 12),
      beforeMs: Date.UTC(2026, 6, 1),
    })).toBe(true);
    expect(monthWasHonoured(june, {
      afterMs: Date.UTC(2026, 5, 30),
      beforeMs: Date.UTC(2026, 6, 1),
    })).toBe(true);
  });

  it("rejects the trailing window served against a named month", () => {
    // THE PRODUCTION BODY, against the month the walk would have asked for.
    const june = monthIndexOf(new Date("2026-06-15T00:00:00.000Z"));
    expect(monthWasHonoured(june, {
      afterMs: Date.UTC(2026, 6, 21),
      beforeMs: Date.UTC(2026, 7, 21),
    })).toBe(false);
    // Older than the month is just as wrong as newer: it is not our month.
    expect(monthWasHonoured(june, {
      afterMs: Date.UTC(2026, 2, 1),
      beforeMs: Date.UTC(2026, 3, 1),
    })).toBe(false);
    // No served bounds is no evidence, and no evidence is no contradiction —
    // the empty-month rule owns that case, here as everywhere.
    expect(monthWasHonoured(june, { afterMs: null, beforeMs: null })).toBe(true);
  });

  it("counts an ALL-ZERO month as empty, so a floor can exist at all", () => {
    // WP-F4's per-media walk found this the expensive way: `/it/moie/statsnew`
    // answers ANY window back to 2006 with one zero-valued bucket, so "no
    // datapoints" never happened and the walk never stopped. Zero counters are
    // not traffic.
    const zeroMonth = {
      dataset: {
        dateAfter: Date.UTC(2026, 5, 1),
        dateBefore: Date.UTC(2026, 6, 1),
        datapoints: [{ timestamp: Date.UTC(2026, 5, 1), views: 0, uniqueViewers: 0 }],
        profileDatapoints: [{
          timestamp: Date.UTC(2026, 5, 1),
          stats: [{ type: 10001, views: 0, interactionTime: 0, uniqueViewers: 0 }],
        }],
      },
    };
    expect(isEmptyStatsMonth(zeroMonth)).toBe(true);
    // ANY non-zero counter anywhere is traffic — including one inside a
    // profileDatapoints row, which is where an idle month's evidence lives.
    const oneView = JSON.parse(JSON.stringify(zeroMonth)) as typeof zeroMonth;
    oneView.dataset.profileDatapoints[0]!.stats[0]!.views = 1;
    expect(isEmptyStatsMonth(oneView)).toBe(false);
    // `type` is identity, not a counter: a non-zero type must not read as data.
    const typeOnly = JSON.parse(JSON.stringify(zeroMonth)) as typeof zeroMonth;
    expect(isEmptyStatsMonth(typeOnly)).toBe(true);
    // A valid dataset with no rows is empty; a missing envelope is INVALID and
    // must not be mistaken for evidence that the provider has no older data.
    expect(isEmptyStatsMonth({ dataset: { datapoints: [], profileDatapoints: [] } })).toBe(true);
    expect(isEmptyStatsMonth(null)).toBe(false);
  });
});

describe("the [F1] probe route", () => {
  it("asks for the month TWO back, which the trailing window cannot reach", () => {
    // One month back overlaps the trailing window, so a served window that
    // happened to cover it would prove nothing.
    expect(probeStatsMonth(new Date("2026-08-22T09:00:00.000Z")))
      .toEqual({ year: 2026, month: 6 });
    expect(probeStatsMonth(new Date("2026-01-05T00:00:00.000Z")))
      .toEqual({ year: 2025, month: 11 });
  });

  it("prints the served window and the verdict, not the numbers", () => {
    const honoured = describeStatsMonthAnswer({ year: 2026, month: 6 }, {
      dataset: {
        dateAfter: Date.UTC(2026, 5, 1),
        dateBefore: Date.UTC(2026, 6, 1),
        datapoints: [],
        profileDatapoints: new Array(30).fill({ timestamp: 1, stats: [] }),
      },
    });
    expect(honoured).toContain("asked year=2026 month=6");
    // ISO DAYS, not values to redact: the served window IS the answer.
    expect(honoured).toContain("served dateAfter=2026-06-01 dateBefore=2026-07-01");
    expect(honoured).toContain("profileDatapoints=30");
    expect(honoured).toContain("MONTH FORM HONOURED");

    const refused = describeStatsMonthAnswer({ year: 2026, month: 6 }, {
      dataset: {
        dateAfter: Date.UTC(2026, 6, 21),
        dateBefore: Date.UTC(2026, 7, 21),
        datapoints: [],
        profileDatapoints: [],
      },
    });
    expect(refused).toContain("MONTH FORM NOT HONOURED");
    // A response describing no window judges nothing, the way a 401 judges no
    // route: absence of evidence is not evidence.
    expect(describeStatsMonthAnswer({ year: 2026, month: 6 }, { dataset: {} }))
      .toContain("UNJUDGED");
  });
});
