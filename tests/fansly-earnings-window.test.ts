import { describe, expect, it } from "vitest";

import {
  advanceEarningsWindow,
  parseEarningsWindow,
  startEarningsWindow,
} from "../apps/runtime/src/services/sync/fansly-earnings-window.ts";
import {
  emptyFanslyStatsCursorState,
  parseFanslyStatsCursorState,
} from "../apps/runtime/src/services/sync/fansly-stats.ts";

const DAY = 86_400_000;
const START = Date.UTC(2026, 7, 1);

describe("Fansly aggregate earnings time windows", () => {
  it.each([false, true])("captures every day/type when offset is ignored (newestFirst=%s)", (newestFirst) => {
    const rows = Array.from({ length: 31 * 5 }, (_, index) => ({
      timestamp: START + Math.floor(index / 5) * DAY,
      type: 7100 + index % 5,
    }));
    let walk = startEarningsWindow(START, START + 31 * DAY - 1);
    const captured = new Set<string>();
    const requests: string[] = [];
    for (let attempts = 0; attempts < 100 && walk.pending.length; attempts += 1) {
      const window = walk.pending.at(-1)!;
      requests.push(JSON.stringify(window));
      const matching = rows.filter((row) => row.timestamp >= Math.floor(window.afterMs / DAY) * DAY
        && row.timestamp <= Math.floor(window.beforeMs / DAY) * DAY);
      const response = (newestFirst ? matching.reverse() : matching).slice(0, 100);
      const result = advanceEarningsWindow(walk, response);
      // Only complete leaves prove coverage; the truncated parent's 100 rows
      // cannot hide a missing older type at the boundary.
      if (response.length < 100) response.forEach((row) => captured.add(`${row.timestamp}:${row.type}`));
      expect(["continue", "complete"]).toContain(result);
      walk = parseEarningsWindow(JSON.parse(JSON.stringify(walk)))!;
    }
    expect(walk.pending).toEqual([]);
    expect(captured).toEqual(new Set(rows.map((row) => `${row.timestamp}:${row.type}`)));
    expect(new Set(requests).size).toBe(requests.length);
    expect(requests.length).toBeLessThan(10);
  });

  it("splits a rolling 24h window containing two UTC dates before declaring saturation", () => {
    const walk = startEarningsWindow(START + 12 * 3_600_000, START + DAY + 12 * 3_600_000);
    const rows = Array.from({ length: 100 }, (_, index) => ({
      timestamp: START + (index < 50 ? 0 : DAY),
    }));
    expect(advanceEarningsWindow(walk, rows)).toBe("continue");
    expect(walk.pending).toHaveLength(2);
    expect(advanceEarningsWindow(walk, rows.slice(50))).toBe("continue");
    expect(advanceEarningsWindow(walk, rows.slice(0, 50))).toBe("complete");
  });

  it.each([100, 101])("does not claim completion for %i rows on one day", (count) => {
    const walk = startEarningsWindow(START, START + DAY - 1);
    expect(advanceEarningsWindow(walk, Array.from({ length: count }, () => ({ timestamp: START }))))
      .toBe("saturated_day");
    expect(walk.pending).toHaveLength(1);
  });

  it("accepts a short 99-row page", () => {
    const walk = startEarningsWindow(START, START + DAY - 1);
    expect(advanceEarningsWindow(walk, Array.from({ length: 99 }, () => ({ timestamp: START }))))
      .toBe("complete");
    expect(walk.hasRows).toBe(true);
  });

  it("preserves nonempty evidence across an empty child and changing provider responses", () => {
    const walk = startEarningsWindow(START, START + 4 * DAY - 1);
    expect(advanceEarningsWindow(walk, Array.from({ length: 100 }, () => ({ timestamp: START }))))
      .toBe("continue");
    expect(advanceEarningsWindow(walk, [])).toBe("continue");
    expect(advanceEarningsWindow(walk, [])).toBe("complete");
    expect(walk.hasRows).toBe(true);
  });

  it("rejects ignored bounds before advancing", () => {
    const walk = startEarningsWindow(START, START + DAY - 1);
    const before = structuredClone(walk);
    expect(advanceEarningsWindow(walk, [{ timestamp: START + DAY }])).toBe("window_not_honoured");
    expect(walk).toEqual(before);
  });

  it.each([{}, { success: false }, null, [{}], [{ timestamp: "bad" }]])(
    "does not turn malformed responses into empty-window evidence: %j", (body) => {
      const walk = startEarningsWindow(START, START + DAY - 1);
      expect(advanceEarningsWindow(walk, body)).toBe("invalid");
      expect(walk.pending).toHaveLength(1);
      expect(walk.hasRows).toBe(false);
    },
  );

  it("migrates the stuck legacy offset without erasing budget or completed history", () => {
    const now = new Date(START);
    const old = { ...emptyFanslyStatsCursorState(now), version: 2,
      callsToday: 25, earningsOffset: 55000, earningsPreviousOffset: 54900 };
    old.backfill!.daily.done = true;
    old.backfill!.hourly.done = true;
    Object.assign(old.backfill!.earnings, { offset: 55000, lastOffset: 54900 });
    const state = parseFanslyStatsCursorState(old, now)!;
    expect(state.version).toBe(2);
    expect(state.callsToday).toBe(25);
    expect(state.backfill!.daily.done).toBe(true);
    expect(state.backfill!.hourly.done).toBe(true);
    expect(state.backfill!.earnings.done).toBe(false);
    expect(state.backfill!.earnings.walk).toBeNull();
    expect(state.backfill!.earnings.nextBeforeMs).toBe(START);
  });
});
