import { describe, expect, it } from "vitest";

import {
  backfillContinuationAt,
  emptyFanslyStatsCursorState,
  parseFanslyStatsCursorState,
  rollUtcDay,
  utcDayKey,
  windowsAreContiguous,
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
    // of daily buckets is ~37 calls.
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
    // The walk asks for 100-bucket windows with a one-day overlap, so the older
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
