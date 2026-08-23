import { describe, expect, it } from "vitest";

import {
  backfillContinuationAt,
  emptyFanslyStatsCursorState,
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
    expect(state.backfill!.daily.probeResumeMs).toBeNull();
    expect(state.utcDay).toBe("2026-08-19");
    expect(state.callsToday).toBe(0);
  });

  it("round-trips through the checkpoint, including the probe bookmark", () => {
    const state = emptyFanslyStatsCursorState(NOW);
    state.backfill!.daily.probeSpent = true;
    state.backfill!.daily.probeResumeMs = 1_700_000_000_000;
    state.backfill!.daily.floorAt = "2019-01-01T00:00:00.000Z";
    state.callsToday = 7;
    state.stepIndex = 4;
    // The cursor is the only durable home for any of this: a walk that lost its
    // bookmark on a lease change would re-read from today, forever.
    const parsed = parseFanslyStatsCursorState(JSON.parse(JSON.stringify(state)), NOW);
    expect(parsed).not.toBeNull();
    expect(parsed!.backfill!.daily.probeResumeMs).toBe(1_700_000_000_000);
    expect(parsed!.backfill!.daily.floorAt).toBe("2019-01-01T00:00:00.000Z");
    expect(parsed!.callsToday).toBe(7);
    expect(parsed!.stepIndex).toBe(4);
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
    expect(parseFanslyStatsCursorState({ version: 2, mode: "steady", utcDay: "x" }, NOW)).toBeNull();
    expect(parseFanslyStatsCursorState({ version: 1, mode: "nope", utcDay: "x" }, NOW)).toBeNull();
    expect(parseFanslyStatsCursorState({ version: 1, mode: "steady" }, NOW)).toBeNull();
  });

  it("rolls the UTC day and nothing else", () => {
    const state = { ...emptyFanslyStatsCursorState(NOW), callsToday: 25, stepIndex: 6 };
    const same = rollUtcDay(state, new Date("2026-08-19T23:59:59.999Z"));
    expect(same.callsToday).toBe(25);
    const rolled = rollUtcDay(state, new Date("2026-08-20T00:00:00.000Z"));
    expect(rolled.callsToday).toBe(0);
    expect(rolled.utcDay).toBe("2026-08-20");
    expect(rolled.stepIndex).toBe(6);
    expect(utcDayKey(new Date("2026-01-01T00:00:00.000Z"))).toBe("2026-01-01");
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
  });
});
