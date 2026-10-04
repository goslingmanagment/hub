import { describe, expect, it } from "vitest";

import { canParseFanslyStatsObservation } from "../apps/runtime/src/services/canonicalize/fansly-stats.ts";
import {
  advanceBroadcastWalk,
  broadcastMessageRows,
  classifyStatsMonth,
  classifyStatsWindow,
  emptyFanslyStatsCursorState,
  hourlyCaptureGap,
  monthFromIndex,
  monthIndexOf,
  monthLabel,
  monthPredatesAccountCreation,
  monthWasHonoured,
  narrowedSpanDays,
  parseFanslyStatsCursorState,
  trustedAccountCreatedAt,
  windowWasHonoured,
} from "../apps/runtime/src/sync/fansly/lib/stats-rules.ts";

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
    // A pre-probe-hit cursor parses as a walk with no gap to fill.
    expect(parsed!.backfill!.daily.probeHitMonthIndex).toBeNull();
    expect(parsed!.backfill!.earnings.probeHitBeforeMs).toBeNull();
    expect(parsed!.stepIndex).toBe(4);
    expect(parsed!.sweepDay).toBe("2026-08-19");
  });

  it("round-trips the probe HIT, which keeps an empty gap from ending the walk", () => {
    const state = emptyFanslyStatsCursorState(NOW);
    state.backfill!.daily.probeHitMonthIndex = monthIndexOf(NOW) - 15;
    state.backfill!.earnings.probeHitAfterMs = Date.UTC(2025, 3, 14);
    state.backfill!.earnings.probeHitBeforeMs = Date.UTC(2025, 4, 15) - 1;
    const parsed = parseFanslyStatsCursorState(JSON.parse(JSON.stringify(state)), NOW);
    expect(parsed!.backfill!.daily.probeHitMonthIndex).toBe(monthIndexOf(NOW) - 15);
    expect(parsed!.backfill!.earnings.probeHitAfterMs).toBe(Date.UTC(2025, 3, 14));
    expect(parsed!.backfill!.earnings.probeHitBeforeMs).toBe(Date.UTC(2025, 4, 15) - 1);
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
    expect(parseFanslyStatsCursorState({ version: 99, mode: "steady", utcDay: "x" }, NOW)).toBeNull();
    expect(parseFanslyStatsCursorState({ version: 1, mode: "nope", utcDay: "x" }, NOW)).toBeNull();
    expect(parseFanslyStatsCursorState({ version: 1, mode: "steady" }, NOW)).toBeNull();
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

describe("the hourly plane's clock", () => {
  // The route serves hourly buckets only inside its trailing 25 h, and where
  // that window ends moves by up to 2 h from call to call: two captures more
  // than 23 h apart can lose an hour for good.
  const HOUR = 3_600_000;
  const CAPTURED = Date.parse("2026-08-19T05:01:00.000Z");

  it("finds no served hole between captures up to 23 h apart, whatever the end lag does", () => {
    // Served the way the route serves an hourly window: snapped to the hour,
    // ending 0–2 h short of the hour asked for, 25 buckets from dateAfter to
    // dateBefore inclusive.
    const servedFor = (capturedMs: number, lagHours: number) => {
      const beforeMs = Math.floor(capturedMs / HOUR) * HOUR - lagHours * HOUR;
      return { afterMs: beforeMs - 24 * HOUR, beforeMs };
    };
    const holesAt = (spacingMs: number) => {
      const missing: number[] = [];
      for (let minute = 0; minute < 60; minute += 1) {
        const olderMs = Date.parse("2026-08-19T05:00:00.000Z") + minute * 60_000;
        const newerMs = olderMs + spacingMs;
        for (const olderLag of [0, 1, 2]) {
          for (const newerLag of [0, 1, 2]) {
            const hole = hourlyCaptureGap(
              { capturedMs: olderMs, servedBeforeMs: servedFor(olderMs, olderLag).beforeMs },
              { capturedMs: newerMs, servedAfterMs: servedFor(newerMs, newerLag).afterMs },
            );
            if (hole !== null) missing.push((hole.toMs - hole.fromMs) / HOUR);
          }
        }
      }
      return missing;
    };
    expect(holesAt(18 * HOUR)).toEqual([]);
    expect(holesAt(23 * HOUR)).toEqual([]);
    // A day apart, the windows meet with no margin: when the lag drops from
    // 2 h to 0 h, one bucket is in neither — whatever minute the captures ran.
    expect(holesAt(24 * HOUR)).toEqual(Array.from({ length: 60 }, () => 1));
  });

  it("names the buckets no SERVED window carries, both ends of a window included", () => {
    const at = (iso: string) => Date.parse(iso);
    expect(hourlyCaptureGap(null, { capturedMs: CAPTURED, servedAfterMs: CAPTURED })).toBeNull();
    // Production, lora-1: captures 2026-09-17 05:02 and 2026-09-18 05:02 were
    // served [16.09 04:00, 17.09 04:00] and [17.09 05:00, 18.09 05:00]. A
    // window carries 25 buckets, its dateBefore's included — the 17.09 04:00
    // bucket is in stats_traffic_buckets — so nothing is missing.
    expect(hourlyCaptureGap(
      { capturedMs: at("2026-09-17T05:02:00Z"), servedBeforeMs: at("2026-09-17T04:00:00Z") },
      { capturedMs: at("2026-09-18T05:02:00Z"), servedAfterMs: at("2026-09-17T05:00:00Z") },
    )).toBeNull();
    // Production, lilly-1: captures 2026-09-21 02:50 and 2026-09-22 03:37, 24.8 h
    // apart — the REQUESTED windows touch — were served up to 21.09 00:00 and
    // from 21.09 02:00. No window carries the 01:00 bucket.
    expect(hourlyCaptureGap(
      { capturedMs: at("2026-09-21T02:50:00Z"), servedBeforeMs: at("2026-09-21T00:00:00Z") },
      { capturedMs: at("2026-09-22T03:37:00Z"), servedAfterMs: at("2026-09-21T02:00:00Z") },
    )).toEqual({
      fromMs: at("2026-09-21T01:00:00Z"),
      toMs: at("2026-09-21T02:00:00Z"),
      basis: "served",
    });
    // 25 h 04 min apart as requested, yet the served windows still meet.
    expect(hourlyCaptureGap(
      { capturedMs: at("2026-08-19T23:01:00Z"), servedBeforeMs: at("2026-08-19T22:00:00Z") },
      { capturedMs: at("2026-08-21T00:05:00Z"), servedAfterMs: at("2026-08-19T23:00:00Z") },
    )).toBeNull();
    // A body without served bounds: the requested windows stand in.
    expect(hourlyCaptureGap(
      { capturedMs: CAPTURED, servedBeforeMs: null },
      { capturedMs: CAPTURED + 25 * HOUR, servedAfterMs: null },
    )).toBeNull();
    expect(hourlyCaptureGap(
      { capturedMs: CAPTURED, servedBeforeMs: at("2026-08-19T04:00:00Z") },
      { capturedMs: CAPTURED + 28 * HOUR + 54 * 60_000, servedAfterMs: null },
    )).toEqual({
      fromMs: CAPTURED,
      toMs: CAPTURED + 3 * HOUR + 54 * 60_000,
      basis: "requested",
    });
  });

  it("round-trips the last capture and drops a value that is not an instant", () => {
    const state = {
      ...emptyFanslyStatsCursorState(NOW),
      lastHourlyCapturedAt: "2026-08-19T05:01:00.000Z",
      lastHourlyServedBefore: "2026-08-19T04:00:00.000Z",
    };
    const parsed = parseFanslyStatsCursorState(JSON.parse(JSON.stringify(state)), NOW)!;
    expect(parsed.lastHourlyCapturedAt).toBe("2026-08-19T05:01:00.000Z");
    expect(parsed.lastHourlyServedBefore).toBe("2026-08-19T04:00:00.000Z");
    const garbled = parseFanslyStatsCursorState(
      { ...state, lastHourlyCapturedAt: "yesterday", lastHourlyServedBefore: 7 },
      NOW,
    )!;
    expect(garbled.lastHourlyCapturedAt).toBeNull();
    expect(garbled.lastHourlyServedBefore).toBeNull();
    // A cursor from before the fields: the handler derives them once.
    const legacy: Record<string, unknown> = { ...state };
    delete legacy.lastHourlyCapturedAt;
    delete legacy.lastHourlyServedBefore;
    expect(parseFanslyStatsCursorState(legacy, NOW)!.lastHourlyCapturedAt).toBeNull();
    expect(parseFanslyStatsCursorState(legacy, NOW)!.lastHourlyServedBefore).toBeNull();
  });
});

describe("the broadcast walks", () => {
  const OPEN = { before: null, floorReached: false, pagesInSweep: 0 };

  it("reads `messages` by NAME, not the first array in the body", () => {
    // Media-less mass DMs: every sidecar empty, `accountMedia` ahead of the
    // page. The first array is empty and the page is not.
    const mediaLess = {
      accountMedia: [],
      accountMediaBundles: [],
      messages: [{ id: "900" }, { id: "800" }],
      tipGoals: [],
      tips: [],
    };
    expect(broadcastMessageRows(mediaLess)).toHaveLength(2);
    expect(advanceBroadcastWalk(OPEN, mediaLess)).toEqual({
      walk: { before: "800", floorReached: false, pagesInSweep: 1 },
      stepDone: false,
      stop: null,
    });
    expect(advanceBroadcastWalk(OPEN, { tips: [], messages: [{ id: "20" }, { id: "19" }] })
      .walk.before).toBe("19");
    expect(advanceBroadcastWalk(OPEN, [{ id: "5" }, { id: "4" }]).walk.before).toBe("4");
  });

  it("reaches the floor on an EMPTY page, whatever the sidecars carry", () => {
    expect(advanceBroadcastWalk(
      { ...OPEN, before: "800" },
      { accountMedia: [{ id: "m1" }], messages: [] },
    )).toEqual({
      walk: { before: null, floorReached: true, pagesInSweep: 0 },
      stepDone: true,
      stop: "empty_page",
    });
  });

  it("ends a walk it cannot move rather than repeat it, and names why", () => {
    // Fansly ignoring `before` serves the same page again.
    const repeated = advanceBroadcastWalk(
      { ...OPEN, before: "800" },
      { messages: [{ id: "900" }, { id: "800" }] },
    );
    expect(repeated.stop).toBe("cursor_not_advancing");
    expect(repeated.walk.floorReached).toBe(true);
    expect(advanceBroadcastWalk(OPEN, { messages: [{}] }).stop).toBe("no_row_ids");
    expect(advanceBroadcastWalk(OPEN, { foo: 1 }).stop).toBe("malformed_shape");
  });

  it("takes three pages a sweep and keeps its place for the next", () => {
    const page = (id: string) => ({ messages: [{ id }] });
    const first = advanceBroadcastWalk(OPEN, page("30"));
    const second = advanceBroadcastWalk(first.walk, page("20"));
    const third = advanceBroadcastWalk(second.walk, page("10"));
    expect([first.stepDone, second.stepDone, third.stepDone]).toEqual([false, false, true]);
    expect(third.walk).toEqual({ before: "10", floorReached: false, pagesInSweep: 0 });
    expect(third.stop).toBeNull();
  });

  it("polls only the head once the floor is reached", () => {
    const floor = { before: null, floorReached: true, pagesInSweep: 0 };
    expect(advanceBroadcastWalk(floor, { messages: [{ id: "1" }] }))
      .toEqual({ walk: floor, stepDone: true, stop: null });
  });

  it("starts the DELETED walk once from a cursor saved before it existed", () => {
    const legacy = JSON.parse(JSON.stringify({
      ...emptyFanslyStatsCursorState(NOW),
      mode: "steady",
      backfill: null,
      broadcastFloorReached: true,
    })) as Record<string, unknown>;
    for (const key of [
      "broadcastWalkStop",
      "deletedBroadcastBefore",
      "deletedBroadcastFloorReached",
      "deletedBroadcastPagesInSweep",
      "deletedBroadcastWalkStop",
    ]) {
      delete legacy[key];
    }
    const parsed = parseFanslyStatsCursorState(legacy, NOW)!;
    expect(parsed.broadcastFloorReached).toBe(true);
    expect(parsed.broadcastWalkStop).toBeNull();
    expect(parsed.deletedBroadcastFloorReached).toBe(false);
    expect(parsed.deletedBroadcastBefore).toBeNull();
    expect(parsed.deletedBroadcastPagesInSweep).toBe(0);
    expect(parsed.deletedBroadcastWalkStop).toBeNull();

    const walking = {
      ...parsed,
      broadcastWalkStop: "empty_page" as const,
      deletedBroadcastBefore: "77",
      deletedBroadcastPagesInSweep: 2,
    };
    expect(parseFanslyStatsCursorState(JSON.parse(JSON.stringify(walking)), NOW))
      .toEqual(walking);
  });
});

describe("account creation floor", () => {
  const accountCreatedAt = new Date("2025-02-06T12:00:00.000Z");

  it("stops only before the creation month", () => {
    expect(monthPredatesAccountCreation(2025 * 12, accountCreatedAt)).toBe(true);
    expect(monthPredatesAccountCreation(2025 * 12 + 1, accountCreatedAt)).toBe(false);
    expect(monthPredatesAccountCreation(2025 * 12 + 2, accountCreatedAt)).toBe(false);
  });

  it("does not invent a floor when account metadata is absent", () => {
    expect(monthPredatesAccountCreation(2020 * 12, null)).toBe(false);
  });

  it("believes only a plausible creation date, since a known one ends no walk early", () => {
    // With a creation date the walks step all the way to it: an epoch or a
    // future value would walk to 1970 or stop at once, so both are unknown.
    expect(trustedAccountCreatedAt(accountCreatedAt, NOW)).toBe(accountCreatedAt);
    expect(trustedAccountCreatedAt(null, NOW)).toBeNull();
    expect(trustedAccountCreatedAt(new Date(0), NOW)).toBeNull();
    // Older than the platform is bad metadata, not a floor: every month in
    // between would be a guaranteed-empty request.
    expect(trustedAccountCreatedAt(new Date("2018-12-31T23:59:59.999Z"), NOW)).toBeNull();
    const oldestBelieved = new Date("2019-01-01T00:00:00.000Z");
    expect(trustedAccountCreatedAt(oldestBelieved, NOW)).toBe(oldestBelieved);
    expect(trustedAccountCreatedAt(new Date(NOW.getTime() + 1), NOW)).toBeNull();
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
    expect(classifyStatsMonth(zeroMonth)).toBe("empty");
    // ANY non-zero counter anywhere is traffic — including one inside a
    // profileDatapoints row, which is where an idle month's evidence lives.
    const oneView = JSON.parse(JSON.stringify(zeroMonth)) as typeof zeroMonth;
    oneView.dataset.profileDatapoints[0]!.stats[0]!.views = 1;
    expect(classifyStatsMonth(oneView)).not.toBe("empty");
    // `type` is identity, not a counter: a non-zero type must not read as data.
    const typeOnly = JSON.parse(JSON.stringify(zeroMonth)) as typeof zeroMonth;
    expect(classifyStatsMonth(typeOnly)).toBe("empty");
    // A valid dataset with no rows is empty; a missing envelope is INVALID and
    // must not be mistaken for evidence that the provider has no older data.
    expect(classifyStatsMonth({ dataset: { datapoints: [], profileDatapoints: [] } })).toBe("empty");
    expect(classifyStatsMonth(null)).not.toBe("empty");
    // A dataset whose datapoints drifted is not an empty month either.
    expect(classifyStatsMonth({ dataset: {} })).not.toBe("empty");
  });

  it("reads the EXACT terminal-null month as empty — the canonicalizer's shape, nothing wider", () => {
    // Production 2026-09-28: ari-1's creation month 2026-03 answered exactly
    // this, 200 and all, and the walk threw on it six times running.
    const terminalNull = { dataset: null, aggregationData: null };
    expect(classifyStatsMonth(terminalNull)).toBe("empty");
    expect(canParseFanslyStatsObservation({
      kind: "account_stats",
      payload: terminalNull,
      accountId: 1,
    })).toBe(true);
    // ONE definition: every near miss the gate leaves unstamped, the walk still
    // calls invalid — no body is an empty month here and unreadable there.
    const nearMisses: unknown[] = [
      { dataset: null },
      { dataset: null, aggregationData: {} },
      { dataset: null, aggregationData: null, futureField: null },
      { dataset: [], aggregationData: null },
      { aggregationData: null },
      null,
      [],
    ];
    for (const payload of nearMisses) {
      expect(classifyStatsMonth(payload)).toBe("invalid");
      expect(canParseFanslyStatsObservation({
        kind: "account_stats",
        payload,
        accountId: 1,
      })).toBe(false);
    }
    // Only the MONTH walk reads it: the trailing/steady windows and the
    // per-media lane classify through `classifyStatsWindow`, where it stays
    // invalid (never served there; per-media nulls are drift for the gate too).
    expect(classifyStatsWindow(terminalNull)).toBe("invalid");
    // The ordinary month readings are unchanged.
    expect(classifyStatsMonth({ dataset: { datapoints: [], profileDatapoints: [] } }))
      .toBe("empty");
    expect(classifyStatsMonth({ dataset: { datapoints: [{ timestamp: 1, views: 2 }] } }))
      .toBe("nonempty");
    expect(classifyStatsMonth({ dataset: { datapoints: [{ timestamp: 1, views: 0 }] } }))
      .toBe("empty");
    expect(classifyStatsMonth({ dataset: {} })).toBe("invalid");
  });

  it("reads a dataset without datapoint ARRAYS as invalid, never as an empty window", () => {
    // Two "empty" windows are a floor claim. A missing or drifted `datapoints`
    // used to read as empty — false completeness from a body nothing can parse.
    expect(classifyStatsWindow({ dataset: {} })).toBe("invalid");
    expect(classifyStatsWindow({ dataset: { datapoints: "x" } })).toBe("invalid");
    expect(classifyStatsWindow({ dataset: { datapoints: [], profileDatapoints: 3 } }))
      .toBe("invalid");
    expect(classifyStatsWindow({ dataset: null })).toBe("invalid");
    // The served shapes: the per-media route carries no profileDatapoints.
    expect(classifyStatsWindow({ dataset: { datapoints: [] } })).toBe("empty");
    expect(classifyStatsWindow({ dataset: { datapoints: [], profileDatapoints: null } }))
      .toBe("empty");
    expect(classifyStatsWindow({ dataset: { datapoints: [], profileDatapoints: [] } }))
      .toBe("empty");
    expect(classifyStatsWindow({ dataset: { datapoints: [{ timestamp: 1 }] } })).toBe("nonempty");
    expect(classifyStatsWindow({ dataset: { datapoints: [], profileDatapoints: [{}] } }))
      .toBe("nonempty");
  });
});
